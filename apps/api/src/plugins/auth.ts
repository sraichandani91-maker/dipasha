import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyToken, type TokenClaims } from "../auth/jwt.js";
import { getUserOverrideKeys, type UserRole } from "../repo/users.js";

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
      if (roles.includes(req.auth.role)) return;
      // Section 10.2 "Per-user permission overrides above the base
      // role" — checked only on the way to a 403, so the common case
      // (role already matches) never pays for the extra query. An
      // impersonated session (Section 3) is deliberately excluded: an
      // override belongs to the real account, and impersonation already
      // has its own, separate role-swap mechanism — stacking the two
      // would make "what can this session actually do" unauditable.
      if (!req.auth.impersonating) {
        const overrides = await getUserOverrideKeys(req.auth.sub);
        if (roles.some((r) => overrides.includes(r))) return;
      }
      return reply.code(403).send({ error: "forbidden", requiredRole: roles });
    };
  });
});
