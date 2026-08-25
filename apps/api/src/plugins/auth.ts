import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyToken, type TokenClaims } from "../auth/jwt.js";
import type { UserRole } from "../repo/users.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: TokenClaims;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Server-side role enforcement (Section 3: "Role-based access enforced
 * server-side, never trusted from the client", Section 6A.9 / 10B.4).
 * Every protected route composes `authenticate` with `requireRole(...)`
 * — the same pattern the margin-visibility rules later in the build
 * depend on, so it's established here in M1 rather than reinvented.
 */
export default fp(async (app) => {
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing_token" });
    }
    try {
      const claims = verifyToken(header.slice("Bearer ".length));
      if (claims.type !== "access") {
        return reply.code(401).send({ error: "wrong_token_type" });
      }
      req.auth = claims;
    } catch {
      return reply.code(401).send({ error: "invalid_or_expired_token" });
    }
  });

  app.decorate("requireRole", (...roles: UserRole[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "missing_token" });
      }
      if (!roles.includes(req.auth.role)) {
        return reply.code(403).send({ error: "forbidden", requiredRole: roles });
      }
    };
  });
});
