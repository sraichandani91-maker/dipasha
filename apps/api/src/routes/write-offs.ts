import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { saveUploadedPhoto, resolveUploadPath, UploadError } from "../lib/uploads.js";
import { approveWriteOff, createWriteOff, listWriteOffs, rejectWriteOff, WriteOffError } from "../repo/write-offs.js";

const CONTENT_TYPE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

const REASON_CODES = ["damaged_in_store", "damaged_in_transit", "expired", "spillage_breakage", "recalled", "other"] as const;

const createWriteOffSchema = z.object({
  productId: z.string().uuid(),
  batchId: z.string().uuid(),
  binId: z.string().uuid(),
  quantityBaseUnits: z.coerce.number().int().positive(),
  reasonCode: z.enum(REASON_CODES),
  note: z.string().min(1),
  estimatedValue: z.coerce.number().positive(),
  deviceId: z.string().min(1),
});

/**
 * Section 9, 9A.8: damage/write-off log with photo evidence and Owner
 * approval above a value threshold. multipart because of the optional
 * photo — every other field arrives as a plain form field alongside it.
 */
export default async function writeOffRoutes(app: FastifyInstance) {
  app.post("/write-offs", { preHandler: app.authenticate }, async (req, reply) => {
    const fields: Record<string, string> = {};
    let photoPath: string | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "photo") {
          part.file.resume(); // drain unexpected file parts, never leave the stream hanging
          continue;
        }
        try {
          photoPath = await saveUploadedPhoto(part);
        } catch (err) {
          if (err instanceof UploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const parsed = createWriteOffSchema.safeParse(fields);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;

    try {
      const result = await createWriteOff({
        productId: b.productId,
        batchId: b.batchId,
        binId: b.binId,
        quantityBaseUnits: b.quantityBaseUnits,
        reasonCode: b.reasonCode,
        note: b.note,
        photoPath,
        estimatedValue: b.estimatedValue,
        requestedBy: req.auth!.sub,
        deviceId: b.deviceId,
      });
      reply.code(201).send(result);
    } catch (err) {
      if (err instanceof WriteOffError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.get("/write-offs", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const q = req.query as { status?: string };
    reply.send(await listWriteOffs(q.status));
  });

  app.post(
    "/write-offs/:id/approve",
    { preHandler: [app.authenticate, app.requireRole("owner")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      try {
        await approveWriteOff(params.data.id, req.auth!.sub);
        reply.send({ approved: true });
      } catch (err) {
        if (err instanceof WriteOffError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  app.post(
    "/write-offs/:id/reject",
    { preHandler: [app.authenticate, app.requireRole("owner")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ rejectionReason: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await rejectWriteOff(params.data.id, req.auth!.sub, body.data.rejectionReason);
        reply.send({ rejected: true });
      } catch (err) {
        if (err instanceof WriteOffError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  // Authenticated read-back for the photo — not a public static directory,
  // consistent with everything else in this build requiring a valid
  // session. Filenames are always our own server-generated uuid.ext.
  app.get("/uploads/:filename", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ filename: z.string() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_filename" });
    const filePath = resolveUploadPath(params.data.filename);
    if (!filePath) return reply.code(400).send({ error: "invalid_filename" });
    try {
      const buf = await readFile(filePath);
      const ext = params.data.filename.split(".").pop()!.toLowerCase();
      reply.type(CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream").send(buf);
    } catch {
      reply.code(404).send({ error: "not_found" });
    }
  });
}
