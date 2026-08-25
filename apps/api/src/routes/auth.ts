import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { generateNumericCode, hashSecret, verifySecret } from "../auth/hash.js";
import { ConsoleOtpSender } from "../auth/otp-sender.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../auth/jwt.js";
import { findUserByPhone, findUserById, type UserRole } from "../repo/users.js";
import { consumeOtp, findActiveOtp, incrementOtpAttempts, insertOtp } from "../repo/otp.js";

const phoneSchema = z.object({ phone: z.string().min(6).max(20) });
const verifySchema = z.object({ phone: z.string().min(6).max(20), code: z.string().length(6) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const pinSchema = z.object({ refreshToken: z.string().min(1), pin: z.string().min(4).max(8) });
const impersonateSchema = z.object({ role: z.enum(["owner", "store_manager", "picker_packer", "rider"]) });

export default async function authRoutes(app: FastifyInstance) {
  const otpSender = new ConsoleOtpSender(app.log);

  app.post("/auth/otp/request", async (req, reply) => {
    const parsed = phoneSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    const user = await findUserByPhone(parsed.data.phone);
    if (!user) {
      // Staff accounts are created by Owner/Manager (Section 10.2), never
      // self-signup — a phone with no account simply can't request an
      // OTP. Generic response either way; these are known shop numbers,
      // not public users, so existence-leak isn't a real concern here.
      return reply.code(404).send({ error: "no_account_for_phone" });
    }
    if (user.status !== "active") {
      return reply.code(403).send({ error: "account_suspended" });
    }

    const code = generateNumericCode();
    const codeHash = await hashSecret(code);
    await insertOtp(user.phone, codeHash, config.otpTtlSeconds);
    await otpSender.send(user.phone, code);

    reply.send({
      status: "sent",
      expiresInSeconds: config.otpTtlSeconds,
      // NEVER include the code outside development — this is the entire
      // reason a real SMS/WhatsApp provider (M8) has to replace the dev
      // sender before this goes anywhere near real staff.
      devCode: config.nodeEnv === "development" ? code : undefined,
    });
  });

  app.post("/auth/otp/verify", async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { phone, code } = parsed.data;

    const user = await findUserByPhone(phone);
    if (!user || user.status !== "active") {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const otp = await findActiveOtp(phone);
    if (!otp || otp.attempts >= config.otpMaxAttempts) {
      return reply.code(401).send({ error: "no_active_otp_or_too_many_attempts" });
    }

    const ok = await verifySecret(code, otp.codeHash);
    if (!ok) {
      await incrementOtpAttempts(otp.id);
      return reply.code(401).send({ error: "incorrect_code" });
    }
    await consumeOtp(otp.id);

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
    reply.send({
      id: user.id,
      name: user.name,
      role: req.auth!.role,
      actualRole: req.auth!.actualRole,
      impersonating: req.auth!.impersonating,
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
