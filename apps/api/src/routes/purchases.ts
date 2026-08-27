import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  createPurchaseInvoice,
  ValidationConflictError,
  listPurchaseInvoices,
  getPurchaseInvoiceDetail,
  correctPurchaseInvoiceField,
  PURCHASE_INVOICE_CORRECTION_FIELDS,
  PURCHASE_INVOICE_CORRECTION_REASON_CODES,
  addPurchaseInvoiceDocument,
  getPurchaseInvoiceDocument,
} from "../repo/purchases.js";
import { saveScanPage, resolveScanPagePath, ScanUploadError, CONTENT_TYPE_BY_EXT } from "../lib/scan-uploads.js";

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
          entryMethod: "manual",
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

  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  // Section 10.2: full list/detail — create-only until now.
  app.get("/purchase-invoices", guard, async (req, reply) => {
    const filter = z
      .object({ vendorId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional(), search: z.string().optional() })
      .safeParse(req.query);
    if (!filter.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listPurchaseInvoices(filter.data));
  });

  app.get("/purchase-invoices/:id", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const detail = await getPurchaseInvoiceDetail(params.data.id);
    if (!detail) return reply.code(404).send({ error: "not_found" });
    reply.send(detail);
  });

  // Header/identification fields only — see repo/purchases.ts and
  // DECISIONS.md for why quantity/rate/GST aren't correctable here.
  const correctionSchema = z.object({
    field: z.enum(PURCHASE_INVOICE_CORRECTION_FIELDS),
    newValue: z.string().min(1),
    reasonCode: z.enum(PURCHASE_INVOICE_CORRECTION_REASON_CODES),
    note: z.string().min(1),
    deviceId: z.string().min(1),
  });
  app.patch("/purchase-invoices/:id", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = correctionSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await correctPurchaseInvoiceField({
        invoiceId: params.data.id,
        field: body.data.field,
        newValue: body.data.newValue,
        reasonCode: body.data.reasonCode,
        note: body.data.note,
        actorUserId: req.auth!.sub,
        deviceId: body.data.deviceId,
      });
      reply.send({ corrected: true });
    } catch (err) {
      if (err instanceof ValidationConflictError) return reply.code(409).send({ error: err.code, details: err.details });
      throw err;
    }
  });

  // Scanned/photographed invoice document attached after the fact — the
  // ordinary manual-entry path never captured one at entry time the way
  // Section 6.3's AI-scan flow does.
  app.post("/purchase-invoices/:id/documents", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const detail = await getPurchaseInvoiceDetail(params.data.id);
    if (!detail) return reply.code(404).send({ error: "not_found" });

    let saved: { filename: string; mimeType: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "document") {
        try {
          saved = await saveScanPage(part);
        } catch (err) {
          if (err instanceof ScanUploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else if (part.type === "file") {
        part.file.resume();
      }
    }
    if (!saved) return reply.code(400).send({ error: "no_document_uploaded" });

    const result = await addPurchaseInvoiceDocument(params.data.id, saved.filename, saved.mimeType, req.auth!.sub);
    reply.code(201).send(result);
  });

  app.get("/purchase-invoices/:id/documents/:docId", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid(), docId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const doc = await getPurchaseInvoiceDocument(params.data.docId);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    const filePath = resolveScanPagePath(doc.filePath);
    if (!filePath) return reply.code(404).send({ error: "not_found" });
    const ext = doc.filePath.split(".").pop()!;
    const buf = await readFile(filePath);
    reply.type(CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream").send(buf);
  });
}
