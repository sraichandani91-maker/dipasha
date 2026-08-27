import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashSecret } from "../auth/hash.js";
import { saveUploadedPhoto, UploadError } from "../lib/uploads.js";
import {
  addRiderDocument,
  createUser,
  getRiderDetails,
  getUserOverrideKeys,
  grantPermissionOverride,
  listPermissionOverrides,
  listRiderDocuments,
  listRidersFull,
  listUsers,
  revokePermissionOverride,
  setUserPin,
  setUserRole,
  setUserStatus,
  updateUser,
  upsertRiderDetails,
  UserError,
  type UserRole,
} from "../repo/users.js";
import { listActivity, listRoster } from "../repo/activity-log.js";

const ROLES = ["owner", "store_manager", "picker_packer", "rider"] as const;

const createUserSchema = z.object({
  phone: z.string().min(6).max(20),
  name: z.string().min(1),
  role: z.enum(ROLES),
  pin: z.string().min(4).max(8).optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(6).max(20).optional(),
});

/**
 * Section 10.2 "Staff and roles" — full account management on web.
 * Owner-only across the board: this module can create accounts with any
 * role, up to and including other owners, so it's the one place in the
 * build where "store_manager" access would be a privilege-escalation
 * path rather than a convenience.
 */
export default async function userRoutes(app: FastifyInstance) {
  app.get("/users", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (_req, reply) => {
    reply.send(await listUsers());
  });

  app.post("/users", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    const pinHash = b.pin ? await hashSecret(b.pin) : null;
    try {
      const created = await createUser({ phone: b.phone, name: b.name, role: b.role, pinHash, createdBy: req.auth!.sub });
      reply.code(201).send(created);
    } catch (err: any) {
      if (err?.code === "23505") return reply.code(409).send({ error: "phone_already_in_use" });
      throw err;
    }
  });

  app.patch("/users/:id", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = updateUserSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      reply.send(await updateUser(params.data.id, body.data));
    } catch (err) {
      if (err instanceof UserError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  // "Delete" a user account is implemented as suspend, not a hard
  // DELETE — see repo/users.ts's setUserStatus comment for why.
  app.post("/users/:id/status", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    if (params.data.id === req.auth!.sub && body.data.status === "suspended") {
      return reply.code(409).send({ error: "cannot_suspend_self" });
    }
    try {
      reply.send(await setUserStatus(params.data.id, body.data.status));
    } catch (err) {
      if (err instanceof UserError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.post("/users/:id/role", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ role: z.enum(ROLES) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    if (params.data.id === req.auth!.sub) return reply.code(409).send({ error: "cannot_change_own_role" });
    try {
      reply.send(await setUserRole(params.data.id, body.data.role as UserRole));
    } catch (err) {
      if (err instanceof UserError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.post("/users/:id/reset-pin", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ pin: z.string().min(4).max(8) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await setUserPin(params.data.id, await hashSecret(body.data.pin));
      reply.send({ reset: true });
    } catch (err) {
      if (err instanceof UserError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.get("/users/:id/permission-overrides", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send(await listPermissionOverrides(params.data.id));
  });

  app.post("/users/:id/permission-overrides", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ permissionKey: z.enum(ROLES), note: z.string().optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    await grantPermissionOverride(params.data.id, body.data.permissionKey as UserRole, req.auth!.sub, body.data.note ?? null);
    reply.code(201).send({ granted: true });
  });

  app.delete("/users/:id/permission-overrides/:key", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid(), key: z.enum(ROLES) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    await revokePermissionOverride(params.data.id, params.data.key as UserRole);
    reply.send({ revoked: true });
  });

  // Section 10.2 "Rider onboarding: details, vehicle, documents upload."
  app.get("/riders/full", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (_req, reply) => {
    reply.send(await listRidersFull());
  });

  app.put("/riders/:id/details", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z
      .object({ vehicleType: z.string().nullable().optional(), vehicleNumber: z.string().nullable().optional(), licenseNumber: z.string().nullable().optional(), notes: z.string().nullable().optional() })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    await upsertRiderDetails(params.data.id, body.data);
    reply.send(await getRiderDetails(params.data.id));
  });

  app.post("/riders/:id/documents", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });

    let docType: string | null = null;
    let filePath: string | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        try {
          filePath = await saveUploadedPhoto(part);
        } catch (err) {
          if (err instanceof UploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else if (part.fieldname === "docType") {
        docType = String(part.value);
      }
    }
    if (!filePath || !docType || !["driving_license", "vehicle_rc", "id_proof", "other"].includes(docType)) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    await addRiderDocument(params.data.id, docType, filePath, req.auth!.sub);
    reply.code(201).send(await listRiderDocuments(params.data.id));
  });

  app.get("/riders/:id/documents", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send(await listRiderDocuments(params.data.id));
  });

  // Section 10.2 "Per-user activity log" and "Shift and roster view."
  app.get("/activity-log", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const q = req.query as { userId?: string; from?: string; to?: string; method?: string };
    reply.send(await listActivity(q));
  });

  app.get("/roster", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (_req, reply) => {
    reply.send(await listRoster());
  });

  app.get("/users/:id/permissions-effective", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send({ overrides: await getUserOverrideKeys(params.data.id) });
  });
}
