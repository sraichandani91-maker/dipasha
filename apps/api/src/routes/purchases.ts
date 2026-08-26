import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createPurchaseInvoice, ValidationConflictError } from "../repo/purchases.js";

const lineSchema = z.object({
  productId: z.string().uuid(),
  batchNo: z.string().min(1),
  expiryDate: z.string(), // ISO date
  packAsPrinted: z.string().nullable().optional(),
  quantityBaseUnits: z.number().int().positive(),
  freeQuantityBaseUnits: z.number().int().min(0).default(0),
  mrp: z.number().positive(),
  rateBeforeDiscount: z.number().positive(),
  discountPercent: z.number().min(0).max(100).default(0),
  discountValue: z.number().min(0).nullable().optional(),
  gstRate: z.number().min(0).max(28),
  cess: z.number().min(0).default(0),
  promisedQuantityBaseUnits: z.number().int().min(0).nullable().optional(),
  promisedFreeQuantityBaseUnits: z.number().int().min(0).nullable().optional(),
});

const createInvoiceSchema = z.object({
  vendorId: z.string().uuid(),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  invoiceValueStated: z.number().positive(),
  paymentTermsDays: z.number().int().min(0).default(0),
  billLevelDiscount: z.number().min(0).default(0),
  freightAndCharges: z.number().min(0).default(0),
  roundOff: z.number().default(0),
  lines: z.array(lineSchema).min(1),
  overrideNearExpiry: z.boolean().default(false),
  acknowledgeReconciliationMismatch: z.boolean().default(false),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  deviceId: z.string().min(1),
});

/**
 * GST purchase entry (Section 6.2, 6.4, 6.5). Owner and Store Manager
 * only — this writes real cost data the margin displays throughout the
 * rest of the build depend on.
 */
export default async function purchaseRoutes(app: FastifyInstance) {
  app.post(
    "/purchase-invoices",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createInvoiceSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const body = parsed.data;

      try {
        const result = await createPurchaseInvoice({
          ...body,
          lines: body.lines.map((l) => ({
            ...l,
            packAsPrinted: l.packAsPrinted ?? null,
            discountValue: l.discountValue ?? null,
            promisedQuantityBaseUnits: l.promisedQuantityBaseUnits ?? null,
            promisedFreeQuantityBaseUnits: l.promisedFreeQuantityBaseUnits ?? null,
          })),
          purchaseOrderId: body.purchaseOrderId ?? null,
          createdBy: req.auth!.sub,
          source: "web", // apps/web is the only client for M3; the app gets its own client-type stamping once it's built
        });
        reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ValidationConflictError) {
          return reply.code(409).send({ error: err.code, details: err.details });
        }
        throw err;
      }
    }
  );
}
