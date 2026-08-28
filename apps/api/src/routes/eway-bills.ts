import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  checkEwayBillRequired,
  createEwayBill,
  EwayBillError,
  listEwayBillsForReference,
  recordEwayBillNumber,
  recordSaleIrn,
} from "../repo/eway-bills.js";

const referenceSchema = z.object({ referenceType: z.enum(["sale", "purchase_invoice"]), referenceId: z.string().uuid() });

/**
 * Section 10B.3 — the e-way bill and e-invoicing stub. Same
 * Owner/store_manager bar as the purchase invoices and sales this reads
 * from; not Owner-only, since generating the upload JSON is an
 * operational/compliance task, not cost/margin data.
 */
export default async function ewayBillRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/eway-bills/check", guard, async (req, reply) => {
    const q = referenceSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    try {
      reply.send(await checkEwayBillRequired(q.data.referenceType, q.data.referenceId));
    } catch (err) {
      if (err instanceof EwayBillError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  const createSchema = referenceSchema.extend({
    transporterName: z.string().nullable().optional(),
    transporterGstin: z.string().nullable().optional(),
    vehicleNumber: z.string().nullable().optional(),
    distanceKm: z.number().positive().nullable().optional(),
  });
  app.post("/eway-bills", guard, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    try {
      const result = await createEwayBill({
        referenceType: b.referenceType,
        referenceId: b.referenceId,
        transporterName: b.transporterName ?? null,
        transporterGstin: b.transporterGstin ?? null,
        vehicleNumber: b.vehicleNumber ?? null,
        distanceKm: b.distanceKm ?? null,
        createdBy: req.auth!.sub,
      });
      reply.code(201).send(result);
    } catch (err) {
      if (err instanceof EwayBillError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.get("/eway-bills", guard, async (req, reply) => {
    const q = referenceSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listEwayBillsForReference(q.data.referenceType, q.data.referenceId));
  });

  // Once generated on the actual government portal — outside this
  // system by design (Section 10B.3) — the resulting number/validity is
  // recorded back here.
  app.patch("/eway-bills/:id", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ ewayBillNumber: z.string().min(1), validUntil: z.string() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await recordEwayBillNumber(params.data.id, body.data.ewayBillNumber, body.data.validUntil);
      reply.send({ updated: true });
    } catch (err) {
      if (err instanceof EwayBillError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  // E-invoicing stub — manual recording only, no IRN/QR generation
  // exists (no e-invoicing GSP integration either).
  app.patch("/sales/:id/irn", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ irn: z.string().min(1), irnQrCodeData: z.string().nullable().optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await recordSaleIrn(params.data.id, body.data.irn, body.data.irnQrCodeData ?? null);
      reply.send({ updated: true });
    } catch (err) {
      if (err instanceof EwayBillError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });
}
