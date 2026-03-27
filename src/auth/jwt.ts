import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_EXPIRES_IN = "1h";

export interface JWTImpersonationClaim {
  active: true;
  readOnly: true;
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  reason: string;
  issuedAt: string;
}

interface GenerateTokenOptions {
  expiresIn?: string | number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables");
  }
  return secret;
}

export interface JWTPayload {
  userId: string;
  email: string;
  impersonation?: JWTImpersonationClaim;
  iat?: number;
  exp?: number;
}

/**
 * Generates a JWT token for the given user payload
 * @param payload - User data to include in the token
 * @returns Signed JWT token
 */
export function generateToken(
  payload: Omit<JWTPayload, "iat" | "exp">,
  options?: GenerateTokenOptions,
): string {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: options?.expiresIn ?? JWT_EXPIRES_IN,
  });
}

/**
 * Verifies a JWT token and returns the decoded payload
 * @param token - JWT token to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JWTPayload {
  const secret = getJwtSecret();

  try {
    const decoded = jwt.verify(token, secret) as JWTPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Token has expired");
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token");
    } else {
      throw new Error("Token verification failed");
    }
  }
}

/**
 * Checks if a token is expired without throwing an error
 * @param token - JWT token to check
 * @returns True if token is expired, false otherwise
 */
export function isTokenExpired(token: string): boolean {
  try {
    verifyToken(token);
    return false;
  } catch (error) {
    return error instanceof Error && error.message === "Token has expired";
  }
}
