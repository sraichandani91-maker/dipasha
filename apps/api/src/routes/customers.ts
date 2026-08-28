import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendCsvAttachment } from "../lib/csv.js";
import {
  CustomerError,
  getAgeingReport,
  getCustomerBalance,
  getCustomerStatement,
  recordPayment,
  searchCustomers,
  updateCreditSettings,
  updateWhatsAppConsent,
} from "../repo/customers.js";

/**
 * Section 9A.4 — credit customers with ageing. Balance/statement data is
 * financially sensitive, same bar as margin data: Owner and Store
 * Manager only (the roles already trusted with billing and purchasing).
 */
export default async function customerRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/customers/search", guard, async (req, reply) => {
    const q = z.object({ q: z.string().min(1) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await searchCustomers(q.data.q));
  });

  const creditSettingsSchema = z.object({
    creditEnabled: z.boolean(),
    creditLimit: z.number().min(0).nullable(),
    paymentTermsDays: z.number().int().min(0),
    accountCustomerId: z.string().uuid().nullable(),
  });
  app.patch("/customers/:id/credit-settings", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = creditSettingsSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await updateCreditSettings(params.data.id, body.data);
      reply.send({ updated: true });
    } catch (err) {
      if (err instanceof CustomerError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  // Section 12A.5: opt-out handling. Marketing defaults to opted-out
  // (explicit consent required); transactional defaults to opted-in but
  // can be turned off if a customer explicitly asks not to be messaged.
  const whatsappConsentSchema = z.object({ transactionalOptIn: z.boolean(), marketingOptIn: z.boolean() });
  app.patch("/customers/:id/whatsapp-consent", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = whatsappConsentSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await updateWhatsAppConsent(params.data.id, body.data);
      reply.send({ updated: true });
    } catch (err) {
      if (err instanceof CustomerError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  // Section 9A.4: "running balance shown to the biller before the sale
  // completes" — POS calls this the moment a credit customer is picked.
  app.get("/customers/:id/balance", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      reply.send(await getCustomerBalance(params.data.id));
    } catch (err) {
      if (err instanceof CustomerError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.get("/customers/ageing", guard, async (req, reply) => {
    const q = z.object({ format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const rows = await getAgeingReport();
    if (q.data.format === "csv") return sendCsvAttachment(reply, "customer-ageing", rows);
    reply.send(rows);
  });

  const paymentSchema = z.object({
    amount: z.number().positive(),
    paymentMethod: z.enum(["cash", "upi", "card", "cheque", "bank_transfer"]),
    referenceNumber: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    allocateToSaleId: z.string().uuid().nullable().optional(),
    deviceId: z.string().min(1),
  });
  app.post("/customers/:id/payments", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = paymentSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body", details: body.success ? undefined : body.error.flatten() });
    const result = await recordPayment({
      customerId: params.data.id,
      amount: body.data.amount,
      paymentMethod: body.data.paymentMethod,
      referenceNumber: body.data.referenceNumber ?? null,
      note: body.data.note ?? null,
      allocateToSaleId: body.data.allocateToSaleId ?? null,
      receivedBy: req.auth!.sub,
      deviceId: body.data.deviceId,
    });
    reply.code(201).send(result);
  });

  // Section 9A.4: "monthly statement per customer... with itemised
  // bills." JSON here — PDF rendering and the WhatsApp send are a
  // reasonable follow-up (M8 for WhatsApp itself), not built this pass.
  app.get("/customers/:id/statement", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const q = z.object({ from: z.string(), to: z.string(), format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!params.success || !q.success) return reply.code(400).send({ error: "invalid_query" });
    try {
      const statement = await getCustomerStatement(params.data.id, q.data.from, q.data.to);
      if (q.data.format === "csv") return sendCsvAttachment(reply, `customer-statement-${statement.customer.name}`, statement.bills);
      reply.send(statement);
    } catch (err) {
      if (err instanceof CustomerError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });
}
