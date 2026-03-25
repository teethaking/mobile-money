import { v4 as uuidv4 } from "uuid";
import { Request, Response, NextFunction } from "express";

export const requestId = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const request = req as Request & { id: string };
  request.id = (req.headers["x-request-id"] as string) || uuidv4();
  res.setHeader("X-Request-ID", request.id);
  next();
};
