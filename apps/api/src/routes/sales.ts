import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { createSale, ValidationError } from "../repo/sales.js";
import { createHeldBill, deleteHeldBill, listHeldBills } from "../repo/held-bills.js";
import { allocateFefo, InsufficientStockError } from "../domain/fefo.js";
import { config } from "../config.js";
import { createWhatsAppSender } from "../lib/whatsapp-sender.js";
import { buildBillWhatsAppText } from "../lib/whatsapp-message.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

const lineSchema = z.object({
  productId: z.string().uuid(),
  quantityBaseUnits: z.number().int().positive(),
  discountPercent: z.number().min(0).max(100).default(0),
  discountValue: z.number().min(0).nullable().optional(),
  manualBatchId: z.string().uuid().nullable().optional(),
  manualBatchOverrideReason: z.string().nullable().optional(),
});

const createSaleSchema = z.object({
  channel: z.enum(["counter", "delivery"]).default("counter"),
  customerName: z.string().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  lines: z.array(lineSchema).min(1),
  billDiscountValue: z.number().min(0).default(0),
  roundOff: z.number().default(0),
  tenders: z.array(z.object({
    tenderType: z.enum(["cash", "upi", "card", "credit"]),
    amount: z.number().positive(),
    referenceNumber: z.string().nullable().optional(),
  })).min(1),
  prescriberDetails: z.object({
    prescriberId: z.string().uuid().nullable().optional(),
    prescriberName: z.string().nullable().optional(),
    prescriberRegistrationNumber: z.string().nullable().optional(),
    patientName: z.string().nullable().optional(),
    patientContact: z.string().nullable().optional(),
  }).nullable().optional(),
  fulfillsRequestId: z.string().uuid().nullable().optional(),
  deviceId: z.string().min(1),
});

/**
 * Counter POS / GST billing (Section 6A) — "the highest-volume screen
 * in the whole system." The doc's own Section 3 role table has no
 * distinct "biller" role; billing is gated to Owner and Store Manager
 * here (Picker/Packer is explicitly read-only-stock-lookup, Rider is
 * delivery-only) — flagged in DECISIONS.md as worth confirming, since
 * a real pharmacy counter is usually staffed by someone other than the
 * manager personally.
 */
export default async function salesRoutes(app: FastifyInstance) {
  app.post(
    "/sales",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createSaleSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const body = parsed.data;

      try {
        const result = await createSale({
          channel: body.channel,
          customerName: body.customerName ?? null,
          customerPhone: body.customerPhone ?? null,
          lines: body.lines.map((l) => ({ ...l, discountValue: l.discountValue ?? null, manualBatchId: l.manualBatchId ?? null, manualBatchOverrideReason: l.manualBatchOverrideReason ?? null })),
          billDiscountValue: body.billDiscountValue,
          roundOff: body.roundOff,
          tenders: body.tenders.map((t) => ({ ...t, referenceNumber: t.referenceNumber ?? null })),
          prescriberDetails: body.prescriberDetails
            ? {
                prescriberId: body.prescriberDetails.prescriberId ?? null,
                prescriberName: body.prescriberDetails.prescriberName ?? null,
                prescriberRegistrationNumber: body.prescriberDetails.prescriberRegistrationNumber ?? null,
                patientName: body.prescriberDetails.patientName ?? null,
                patientContact: body.prescriberDetails.patientContact ?? null,
              }
            : null,
          fulfillsRequestId: body.fulfillsRequestId ?? null,
          createdBy: req.auth!.sub,
          deviceId: body.deviceId,
          source: "web",
        });
        reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(409).send({ error: err.code, details: err.details });
        }
        throw err;
      }
    }
  );

  // Live pricing/margin preview while a bill is being built (Section
  // 6A.9) — a read-only FEFO dry run, no ledger writes. Owner sees cost
  // and margin fields; anyone else billing gets the same shape with
  // those keys genuinely absent, same "absent, not blanked" rule as
  // everywhere else cost data appears.
  app.get("/sales/pricing-preview", { preHandler: app.authenticate }, async (req, reply) => {
    const q = z.object({ productId: z.string().uuid(), quantityBaseUnits: z.coerce.number().int().positive() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });

    let allocations;
    try {
      allocations = await allocateFefo(q.data.productId, q.data.quantityBaseUnits);
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        return reply.code(409).send({ error: "insufficient_stock", available: err.available, requested: err.requested });
      }
      throw err;
    }

    const db = requirePool();
    const { rows: productRows } = await db.query(`SELECT pack_size FROM products WHERE id = $1`, [q.data.productId]);
    const packSize = productRows[0]?.pack_size ?? 1;

    const { rows: batchRows } = await db.query(
      `SELECT id, batch_no, expiry_date, mrp, effective_cost_per_base_unit, cost_unknown FROM batches WHERE id = ANY($1::uuid[])`,
      [allocations.map((a) => a.batchId)]
    );
    const batchById = new Map(batchRows.map((b) => [b.id, b]));
    const isOwner = req.auth!.role === "owner";

    const batches = allocations.map((a) => {
      const b = batchById.get(a.batchId);
      const mrpPerBaseUnit = Number(b.mrp) / packSize;
      const base = { batchId: a.batchId, batchNo: b.batch_no, expiryDate: b.expiry_date, quantity: a.quantity, mrp: Number(b.mrp), mrpPerBaseUnit };
      if (!isOwner) return base;
      return {
        ...base,
        effectiveCostPerBaseUnit: b.cost_unknown ? null : (b.effective_cost_per_base_unit === null ? null : Number(b.effective_cost_per_base_unit)),
      };
    });

    reply.send({ batches });
  });

  app.get("/sales", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const q = req.query as { businessDate?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const { rows } = await requirePool().query(
      `SELECT id, bill_number, channel, status, customer_name, grand_total, created_at
       FROM sales
       WHERE status = 'completed' ${q.businessDate ? "AND business_date = $2" : ""}
       ORDER BY created_at DESC LIMIT $1`,
      q.businessDate ? [limit, q.businessDate] : [limit]
    );
    reply.send(rows);
  });

  // Full bill detail for printing (Section 6A.6) — role-gated cost isn't
  // relevant here (a bill is what the customer sees), but the owner-only
  // margin view reuses this same data on the POS screen before the sale
  // completes, not here.
  app.get("/sales/:id", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });

    const db = requirePool();
    const { rows: saleRows } = await db.query(`SELECT * FROM sales WHERE id = $1`, [params.data.id]);
    if (saleRows.length === 0) return reply.code(404).send({ error: "not_found" });
    const { rows: lineRows } = await db.query(
      `SELECT sl.*, p.name AS product_name, p.schedule_category, p.base_unit, p.pack_size, p.hsn_code, b.batch_no, b.expiry_date, bin.code AS bin_code
       FROM sale_lines sl
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN batches b ON b.id = sl.batch_id
       LEFT JOIN bins bin ON bin.id = sl.bin_id
       WHERE sl.sale_id = $1 ORDER BY sl.requested_line_no`,
      [params.data.id]
    );
    const { rows: tenderRows } = await db.query(`SELECT tender_type, amount, reference_number FROM sale_tenders WHERE sale_id = $1`, [params.data.id]);
    const { rows: prescriberRows } = await db.query(`SELECT * FROM sale_prescriber_details WHERE sale_id = $1`, [params.data.id]);

    reply.send({ sale: saleRows[0], lines: lineRows, tenders: tenderRows, prescriberDetails: prescriberRows[0] ?? null });
  });

  // Reprint is permitted but logged and marked a duplicate (Section
  // 6A.6) — this just bumps the counter; the client renders "DUPLICATE"
  // on any print past the first.
  app.post("/sales/:id/mark-printed", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const { rows } = await requirePool().query(`UPDATE sales SET print_count = print_count + 1 WHERE id = $1 RETURNING print_count`, [params.data.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    reply.send({ printCount: rows[0].print_count, isDuplicate: rows[0].print_count > 1 });
  });

  // Send bill via WhatsApp (Section 6A.6 / Section 14). Sending again is
  // always allowed (same posture as reprint) but counted, not silently
  // repeated without a trace — `whatsapp_send_count`/`whatsapp_last_sent_at`
  // mirror `print_count`.
  app.post(
    "/sales/:id/send-whatsapp",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });

      const db = requirePool();
      const { rows } = await db.query(
        `SELECT bill_number, created_at, grand_total, customer_name, customer_phone FROM sales WHERE id = $1`,
        [params.data.id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
      const sale = rows[0];
      if (!sale.customer_phone) return reply.code(409).send({ error: "no_customer_phone" });

      const sender = createWhatsAppSender(config.whatsappProvider, req.log);
      const result = await sender.send({ phone: sale.customer_phone, text: buildBillWhatsAppText(sale) });

      const { rows: updated } = await db.query(
        `UPDATE sales SET whatsapp_send_count = whatsapp_send_count + 1, whatsapp_last_sent_at = now() WHERE id = $1 RETURNING whatsapp_send_count`,
        [params.data.id]
      );
      reply.send({ status: result.status, sendCount: updated[0].whatsapp_send_count, isResend: updated[0].whatsapp_send_count > 1 });
    }
  );

  // Hold / recall (Section 6A.4)
  app.get("/held-bills", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (_req, reply) => {
    reply.send(await listHeldBills());
  });
  app.post("/held-bills", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const parsed = z.object({ label: z.string().min(1), payload: z.unknown(), deviceId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const id = await createHeldBill(parsed.data.label, parsed.data.payload, req.auth!.sub, parsed.data.deviceId);
    reply.code(201).send({ id });
  });
  app.delete("/held-bills/:id", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const deleted = await deleteHeldBill(params.data.id);
    if (!deleted) return reply.code(404).send({ error: "not_found" });
    reply.send({ deleted: true });
  });
}
