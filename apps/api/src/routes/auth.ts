import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifySecret } from "../auth/hash.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../auth/jwt.js";
import { findUserByUsername, findUserById, getUserOverrideKeys, type UserRole } from "../repo/users.js";

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const pinSchema = z.object({ refreshToken: z.string().min(1), pin: z.string().min(4).max(8) });
const impersonateSchema = z.object({ role: z.enum(["owner", "store_manager", "picker_packer", "rider"]) });

export default async function authRoutes(app: FastifyInstance) {
  // Username + password (owner-requested — replaces the earlier phone +
  // OTP flow, which would have needed a paid SMS/WhatsApp provider to go
  // anywhere near real use). Staff accounts are still created by the
  // Owner only (Section 10.2), never self-signup, so there's no
  // registration endpoint here to match — just login.
  app.post("/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    const user = await findUserByUsername(parsed.data.username);
    // Same generic error whether the username doesn't exist or the
    // password is wrong — never leak which one was incorrect.
    if (!user || user.status !== "active" || !user.passwordHash) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const ok = await verifySecret(parsed.data.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });

    const claims = { sub: user.id, role: user.role, actualRole: user.role, impersonating: false };
    reply.send({
      accessToken: signAccessToken(claims),
      refreshToken: signRefreshToken(claims),
      user: { id: user.id, name: user.name, role: user.role },
    });
  });

  app.post("/auth/refresh", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    let claims;
    try {
      claims = verifyToken(parsed.data.refreshToken);
    } catch {
      return reply.code(401).send({ error: "invalid_or_expired_refresh_token" });
    }
    if (claims.type !== "refresh") return reply.code(401).send({ error: "wrong_token_type" });

    const user = await findUserById(claims.sub);
    if (!user || user.status !== "active") return reply.code(401).send({ error: "account_unavailable" });

    reply.send({
      accessToken: signAccessToken({ sub: user.id, role: user.role, actualRole: user.role, impersonating: false }),
    });
  });

  // Idle-lock re-entry (Section 3): "PIN re-entry, not full re-login."
  // Requires a still-valid refresh token plus the correct PIN — never
  // just the PIN alone, so a stolen device can't be unlocked by a
  // shoulder-surfed 4-digit code without also holding the session.
  app.post("/auth/pin/verify", async (req, reply) => {
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    let claims;
    try {
      claims = verifyToken(parsed.data.refreshToken);
    } catch {
      return reply.code(401).send({ error: "invalid_or_expired_refresh_token" });
    }
    if (claims.type !== "refresh") return reply.code(401).send({ error: "wrong_token_type" });

    const user = await findUserById(claims.sub);
    if (!user || user.status !== "active" || !user.pinHash) {
      return reply.code(401).send({ error: "pin_not_set_or_account_unavailable" });
    }
    const ok = await verifySecret(parsed.data.pin, user.pinHash);
    if (!ok) return reply.code(401).send({ error: "incorrect_pin" });

    reply.send({
      accessToken: signAccessToken({ sub: user.id, role: user.role, actualRole: user.role, impersonating: false }),
    });
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req, reply) => {
    const user = await findUserById(req.auth!.sub);
    if (!user) return reply.code(404).send({ error: "not_found" });
    // Same exclusion as requireRole (plugins/auth.ts): an impersonated
    // session never picks up the real (owner) account's own overrides —
    // otherwise "impersonate picker_packer" would silently show whatever
    // extra tabs the owner happens to have granted themselves, which
    // isn't what impersonation is for (testing a role as that role sees
    // it, nothing more).
    const permissionOverrides = req.auth!.impersonating ? [] : await getUserOverrideKeys(user.id);
    reply.send({
      id: user.id,
      name: user.name,
      role: req.auth!.role,
      actualRole: req.auth!.actualRole,
      impersonating: req.auth!.impersonating,
      permissionOverrides,
    });
  });

  // Owner-only: issue a token that authorizes as a different role, for
  // testing (Section 3). actorUserId in every audit stamp downstream
  // still traces back to the real owner — impersonation changes what a
  // request is ALLOWED to do, never who it's recorded as having done.
  app.post(
    "/auth/impersonate",
    { preHandler: [app.authenticate, app.requireRole("owner" as UserRole)] },
    async (req, reply) => {
      const parsed = impersonateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const owner = await findUserById(req.auth!.sub);
      if (!owner) return reply.code(404).send({ error: "not_found" });

      reply.send({
        accessToken: signAccessToken({
          sub: owner.id,
          role: parsed.data.role,
          actualRole: "owner",
          impersonating: true,
        }),
      });
    }
  );
}
