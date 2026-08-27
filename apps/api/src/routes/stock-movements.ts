import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createStockReceived, listStockReceived } from "../repo/stock-received.js";

const REASON_CODES = ["free_sample", "scheme_goods", "opening_stock", "replacement_no_invoice", "transfer_in", "found_in_count", "other"] as const;

const stockReceivedSchema = z.object({
  productId: z.string().uuid(),
  batchNo: z.string().min(1),
  expiryDate: z.string(),
  mrp: z.number().positive(),
  quantityBaseUnits: z.number().int().positive(),
  reasonCode: z.enum(REASON_CODES),
  note: z.string().min(1), // Section 6.1: every non-GST movement requires a mandatory reason code AND free-text note
  sourceOrVendorName: z.string().nullable().optional(),
  estimatedValue: z.number().positive().nullable().optional(),
  deviceId: z.string().min(1),
});

/**
 * Non-GST inbound (Section 6.4's first, simpler copy). Same ledger as
 * every other movement type, deliberately fewer required fields than a
 * GST purchase. stock_issue (the OUT-side mirror) is M4 — not here.
 */
export default async function stockMovementRoutes(app: FastifyInstance) {
  app.post(
    "/stock-movements/stock-received",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = stockReceivedSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const body = parsed.data;

      const result = await createStockReceived({
        ...body,
        sourceOrVendorName: body.sourceOrVendorName ?? null,
        estimatedValue: body.estimatedValue ?? null,
        createdBy: req.auth!.sub,
        source: "web",
      });
      reply.code(201).send(result);
    }
  );

  // Section 10.2: list — create-only until now, same gap as purchase invoices.
  app.get(
    "/stock-movements/stock-received",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const filter = z.object({ from: z.string().optional(), to: z.string().optional(), search: z.string().optional() }).safeParse(req.query);
      if (!filter.success) return reply.code(400).send({ error: "invalid_query" });
      reply.send(await listStockReceived(filter.data));
    }
  );
}
