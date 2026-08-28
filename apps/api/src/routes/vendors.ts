import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendCsvAttachment } from "../lib/csv.js";
import {
  createVendor,
  getVendorAgeingReport,
  getVendorBalance,
  getVendorStatement,
  listVendors,
  recordVendorPayment,
  updateVendorContact,
  updateVendorMoq,
  VendorLedgerError,
} from "../repo/vendors.js";

const createVendorSchema = z.object({
  name: z.string().min(1),
  gstin: z.string().length(15).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).optional(),
});

export default async function vendorRoutes(app: FastifyInstance) {
  app.get("/vendors", { preHandler: app.authenticate }, async (_req, reply) => {
    reply.send(await listVendors());
  });

  app.post(
    "/vendors",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createVendorSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const v = parsed.data;
      const created = await createVendor({
        name: v.name,
        gstin: v.gstin ?? null,
        paymentTermsDays: v.paymentTermsDays ?? 0,
        createdBy: req.auth!.sub,
      });
      reply.code(201).send(created);
    }
  );

  app.patch(
    "/vendors/:id/moq",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ defaultMinOrderPackUnits: z.number().int().positive().nullable() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      await updateVendorMoq(params.data.id, body.data.defaultMinOrderPackUnits);
      reply.send({ updated: true });
    }
  );

  // Section 10B.2's PO send needs a phone/email to actually send to.
  app.patch(
    "/vendors/:id/contact",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ phone: z.string().nullable(), email: z.string().email().nullable() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      await updateVendorContact(params.data.id, body.data);
      reply.send({ updated: true });
    }
  );

  // Section 10B.1's vendor ledger — same financial-data bar as the
  // customer ledger: Owner/store_manager only.
  const ledgerGuard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/vendors/:id/balance", ledgerGuard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      reply.send(await getVendorBalance(params.data.id));
    } catch (err) {
      if (err instanceof VendorLedgerError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.get("/vendors/ageing", ledgerGuard, async (req, reply) => {
    const q = z.object({ format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const rows = await getVendorAgeingReport();
    if (q.data.format === "csv") return sendCsvAttachment(reply, "vendor-ageing", rows);
    reply.send(rows);
  });

  const vendorPaymentSchema = z.object({
    amount: z.number().positive(),
    paymentMethod: z.enum(["cash", "upi", "card", "cheque", "bank_transfer"]),
    referenceNumber: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    allocateToInvoiceId: z.string().uuid().nullable().optional(),
    deviceId: z.string().min(1),
  });
  app.post("/vendors/:id/payments", ledgerGuard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = vendorPaymentSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body", details: body.success ? undefined : body.error.flatten() });
    const result = await recordVendorPayment({
      vendorId: params.data.id,
      amount: body.data.amount,
      paymentMethod: body.data.paymentMethod,
      referenceNumber: body.data.referenceNumber ?? null,
      note: body.data.note ?? null,
      allocateToInvoiceId: body.data.allocateToInvoiceId ?? null,
      paidBy: req.auth!.sub,
      deviceId: body.data.deviceId,
    });
    reply.code(201).send(result);
  });

  app.get("/vendors/:id/statement", ledgerGuard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const q = z.object({ from: z.string(), to: z.string(), format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!params.success || !q.success) return reply.code(400).send({ error: "invalid_query" });
    try {
      const statement = await getVendorStatement(params.data.id, q.data.from, q.data.to);
      if (q.data.format === "csv") return sendCsvAttachment(reply, `vendor-statement-${statement.vendor.name}`, statement.invoices);
      reply.send(statement);
    } catch (err) {
      if (err instanceof VendorLedgerError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });
}
