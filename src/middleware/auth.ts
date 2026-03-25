import { Request, Response, NextFunction } from "express";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

/**
 * Middleware to require a valid administrative API key or token.
 * For this implementation, we check for an X-API-Key header.
 */
export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const apiKey = req.header("X-API-Key");
  const adminKey = process.env.ADMIN_API_KEY || "dev-admin-key";

  if (!apiKey || apiKey !== adminKey) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Valid administrative API key required in X-API-Key header",
    });
  }

  // Mock user for admin actions
  (req as AuthRequest).user = {
    id: "admin-system",
    role: "admin",
  };

  next();
};
