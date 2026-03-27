import { Router, Request, Response, NextFunction } from "express";
import { generateToken } from "../auth/jwt";
import { updateAdminNotesHandler } from "../controllers/transactionController";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { getQueueStats } from "../queue/transactionQueue";
import { redisClient } from "../config/redis";
import { checkReplicaHealth } from "../config/database";

const router = Router();
const IMPERSONATION_TOKEN_EXPIRES_IN = "15m";
const IMPERSONATION_TOKEN_TTL_MS = 15 * 60 * 1000;
const READ_ONLY_IMPERSONATION_MESSAGE =
  "This token is read-only and cannot be used for mutations.";

interface User {
  id: string;
  role: string;
  locked?: boolean;
  [key: string]: unknown;
}

interface Transaction {
  id: string;
  [key: string]: unknown;
}

interface AuthRequest extends Request {
  user?: User;
}

/**
 * Mock services (replace with real DB/services)
 */
const users: User[] = [];
const transactions: Transaction[] = [];

const isAdminRole = (role?: string) =>
  role === "admin" || role === "super-admin";

const isSuperAdminRole = (role?: string) => role === "super-admin";

const buildAuditContext = (req: Request) => {
  const authReq = req as AuthRequest;

  return {
    actorUserId: authReq.user?.id,
    actorRole: authReq.user?.role,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    timestamp: new Date().toISOString(),
  };
};

const logImpersonationAuditEvent = (
  event:
    | "IMPERSONATION_TOKEN_ISSUED"
    | "IMPERSONATION_TOKEN_DENIED"
    | "IMPERSONATION_TOKEN_REJECTED",
  req: Request,
  details: Record<string, unknown>,
) => {
  console.log("[ADMIN IMPERSONATION]", {
    event,
    ...buildAuditContext(req),
    ...details,
  });
};

/**
 * Middleware: Require Admin Role
 */
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  // Assume req.user is set by auth middleware
  const user = (req as AuthRequest).user;

  if (!user || !isAdminRole(user.role)) {
    return res.status(403).json({ message: "Admin access required" });
  }

  next();
};

const requireSuperAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as AuthRequest).user;

  if (!user || !isSuperAdminRole(user.role)) {
    logImpersonationAuditEvent("IMPERSONATION_TOKEN_DENIED", req, {
      reason: "super_admin_required",
    });
    return res.status(403).json({
      message: "Super-admin access required",
    });
  }

  next();
};

/**
 * Middleware: Admin Logger
 */
const logAdminAction = (action: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    console.log(`[ADMIN ACTION] ${action}`, {
      adminId: (req as AuthRequest).user?.id,
      method: req.method,
      path: req.originalUrl,
      body: req.body,
      timestamp: new Date().toISOString(),
    });
    next();
  };
};

/**
 * Helper: Pagination
 */
const paginate = <T>(data: T[], page: number, limit: number) => {
  const start = (page - 1) * limit;
  const end = start + limit;

  return {
    data: data.slice(start, end),
    pagination: {
      total: data.length,
      page,
      limit,
      totalPages: Math.ceil(data.length / limit),
    },
  };
};

/**
 * =========================
 * USERS
 * =========================
 */

// GET /api/admin/users
router.get(
  "/users",
  requireAdmin,
  logAdminAction("LIST_USERS"),
  (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    const result = paginate(users, page, limit);

    res.json(result);
  },
);

// GET /api/admin/users/:id
router.get(
  "/users/:id",
  requireAdmin,
  logAdminAction("GET_USER"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  },
);

// POST /api/admin/users/:id/impersonation-token
router.post(
  "/users/:id/impersonation-token",
  requireAdmin,
  requireSuperAdmin,
  (req: Request, res: Response) => {
    const actor = (req as AuthRequest).user;
    const targetUser = users.find((u) => u.id === req.params.id);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!targetUser) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: req.params.id,
        reason: "target_user_not_found",
      });
      return res.status(404).json({ message: "User not found" });
    }

    if (!actor) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: targetUser.id,
        reason: "missing_actor_context",
      });
      return res.status(401).json({ message: "Authentication required" });
    }

    if (actor.id === targetUser.id) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: targetUser.id,
        reason: "self_impersonation_blocked",
      });
      return res.status(400).json({
        message: "Cannot generate an impersonation token for yourself",
      });
    }

    if (!reason) {
      logImpersonationAuditEvent("IMPERSONATION_TOKEN_REJECTED", req, {
        targetUserId: targetUser.id,
        reason: "missing_support_reason",
      });
      return res.status(400).json({
        message: "A support reason is required for impersonation",
      });
    }

    const email =
      typeof targetUser.email === "string" && targetUser.email.trim()
        ? targetUser.email
        : `${targetUser.id}@impersonated.local`;
    const expiresAt = new Date(
      Date.now() + IMPERSONATION_TOKEN_TTL_MS,
    ).toISOString();
    const token = generateToken(
      {
        userId: targetUser.id,
        email,
        impersonation: {
          active: true,
          readOnly: true,
          actorUserId: actor.id,
          actorRole: actor.role,
          targetUserId: targetUser.id,
          reason,
          issuedAt: new Date().toISOString(),
        },
      },
      { expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN },
    );

    logImpersonationAuditEvent("IMPERSONATION_TOKEN_ISSUED", req, {
      targetUserId: targetUser.id,
      supportReason: reason,
      expiresAt,
    });

    return res.status(201).json({
      message: "Read-only impersonation token generated",
      token,
      expiresAt,
      impersonation: {
        actorUserId: actor.id,
        actorRole: actor.role,
        targetUserId: targetUser.id,
        readOnly: true,
        reason,
      },
      guidance: READ_ONLY_IMPERSONATION_MESSAGE,
    });
  },
);

// PUT /api/admin/users/:id
router.put(
  "/users/:id",
  requireAdmin,
  logAdminAction("UPDATE_USER"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    Object.assign(user, req.body);

    res.json({ message: "User updated", user });
  },
);

// POST /api/admin/users/:id/unlock
router.post(
  "/users/:id/unlock",
  requireAdmin,
  logAdminAction("UNLOCK_USER"),
  (req: Request, res: Response) => {
    const user = users.find((u) => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.locked = false;

    res.json({ message: "User account unlocked" });
  },
);

/**
 * =========================
 * TRANSACTIONS
 * =========================
 */

// GET /api/admin/transactions
router.get(
  "/transactions",
  requireAdmin,
  logAdminAction("LIST_TRANSACTIONS"),
  (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    const result = paginate(transactions, page, limit);

    res.json(result);
  },
);

// PUT /api/admin/transactions/:id
router.put(
  "/transactions/:id",
  requireAdmin,
  logAdminAction("UPDATE_TRANSACTION"),
  (req: Request, res: Response) => {
    const tx = transactions.find((t) => t.id === req.params.id);

    if (!tx) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    Object.assign(tx, req.body);

    res.json({ message: "Transaction updated", transaction: tx });
  },
);

// PATCH /api/admin/transactions/:id/notes
router.patch(
  "/transactions/:id/notes",
  requireAdmin,
  logAdminAction("UPDATE_TRANSACTION_ADMIN_NOTES"),
  updateAdminNotesHandler,
);

/**
 * =========================
 * HEALTH & MONITORING
 * =========================
 */

// GET /api/admin/providers/health
router.get(
  "/providers/health",
  requireAdmin,
  logAdminAction("GET_PROVIDER_HEALTH"),
  async (req: Request, res: Response) => {
    try {
      const timestamp = new Date().toISOString();
      const mobileMoneyService = new MobileMoneyService();

      // Get failover stats
      let providers = {};
      try {
        providers = mobileMoneyService.getFailoverStats();
      } catch (err) {
        console.error("Error fetching failover stats:", err);
      }

      // Get queue stats
      let queue = { status: "unknown", stats: {} };
      try {
        const queueStats = await getQueueStats();
        queue = {
          status: queueStats.failed > 100 ? "degraded" : "healthy",
          stats: queueStats,
        };
      } catch (err) {
        console.error("Error fetching queue stats:", err);
      }

      // Get Redis status
      const redis = { status: "unknown" };
      try {
        if (redisClient.isOpen) {
          await redisClient.ping();
          redis.status = "ok";
        } else {
          redis.status = "closed";
        }
      } catch (err) {
        console.error("Error checking Redis status:", err);
        redis.status = "down";
      }

      // Get database replica health
      let database: {
        primary: string;
        replicas: { url: string; healthy: boolean }[];
      } = {
        primary: "unknown",
        replicas: [],
      };
      try {
        const replicaHealth = await checkReplicaHealth();
        database = {
          primary: "ok", // Primary is assumed ok if we can query replicas
          replicas: replicaHealth,
        };
      } catch (err) {
        console.error("Error checking database health:", err);
      }

      res.json({
        status: "healthy",
        timestamp,
        providers,
        queue,
        redis,
        database,
      });
    } catch (err) {
      console.error("Health check error:", err);
      res.status(500).json({
        status: "error",
        message: "Failed to retrieve health data",
        timestamp: new Date().toISOString(),
      });
    }
  },
);

export const adminRoutes = router;
