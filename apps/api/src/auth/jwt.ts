import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { UserRole } from "../repo/users.js";

export type TokenType = "access" | "refresh";

export interface TokenClaims {
  sub: string; // user id — always the REAL authenticated user, never fake under impersonation
  role: UserRole; // effective role this token authorizes as
  actualRole: UserRole; // the account's real role
  impersonating: boolean;
  type: TokenType;
}

function requireSecret(): string {
  if (!config.jwtSecret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return config.jwtSecret;
}

export function signAccessToken(claims: Omit<TokenClaims, "type">): string {
  return jwt.sign({ ...claims, type: "access" } satisfies TokenClaims, requireSecret(), {
    expiresIn: config.jwtAccessTtlSeconds,
  });
}

export function signRefreshToken(claims: Omit<TokenClaims, "type" | "role" | "impersonating">): string {
  // Refresh tokens are never issued for an impersonated session — an
  // impersonated login re-derives its access token from a fresh
  // /auth/impersonate call each time, so a stolen refresh token can never
  // carry elevated/altered role authority.
  const full: TokenClaims = {
    ...claims,
    role: claims.actualRole,
    impersonating: false,
    type: "refresh",
  };
  return jwt.sign(full, requireSecret(), { expiresIn: config.jwtRefreshTtlSeconds });
}

export function verifyToken(token: string): TokenClaims {
  return jwt.verify(token, requireSecret()) as TokenClaims;
}
