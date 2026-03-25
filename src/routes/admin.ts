import { Router, Request, Response, NextFunction } from "express";
import { updateAdminNotesHandler } from "../controllers/transactionController";

const router = Router();

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

/**
 * Middleware: Require Admin Role
 */
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  // Assume req.user is set by auth middleware
  const user = (req as AuthRequest).user;

  if (!user || user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
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

export const adminRoutes = router;
