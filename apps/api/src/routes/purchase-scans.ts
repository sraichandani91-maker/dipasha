import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { saveScanPage, resolveScanPagePath, ScanUploadError, CONTENT_TYPE_BY_EXT } from "../lib/scan-uploads.js";
import {
  createAndExtractScan,
  getScan,
  listScans,
  suggestProductMatches,
  setScanVendor,
  commitScan,
  ScanCommitError,
  getVendorAccuracyReport,
  type ScanPageFile,
} from "../repo/purchase-scans.js";
import { ValidationConflictError } from "../repo/purchases.js";

/**
 * Section 6.3 — AI invoice scanning, all four stages (capture, extract,
 * match/review, commit). Owner/Store Manager only, same bar as purchase
 * entry — this is cost data and it writes real GRNs on commit.
 */
export default async function purchaseScanRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.post("/purchase-scans", guard, async (req, reply) => {
    const fields: Record<string, string> = {};
    const pages: ScanPageFile[] = [];

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "pages") {
          part.file.resume();
          continue;
        }
        try {
          pages.push(await saveScanPage(part));
        } catch (err) {
          if (err instanceof ScanUploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const parsed = z.object({ vendorId: z.string().uuid(), deviceId: z.string().min(1) }).safeParse(fields);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    if (pages.length === 0) return reply.code(400).send({ error: "no_pages_uploaded" });

    const result = await createAndExtractScan({
      pages,
      vendorId: parsed.data.vendorId,
      createdBy: req.auth!.sub,
      deviceId: parsed.data.deviceId,
    });

    const scan = await withSuggestedMatches(await getScan(result.id));
    reply.code(201).send({ ...scan, cached: result.cached });
  });

  app.get("/purchase-scans", guard, async (_req, reply) => {
    reply.send(await listScans());
  });

  app.get("/purchase-scans/:id", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const scan = await getScan(params.data.id);
    if (!scan) return reply.code(404).send({ error: "not_found" });
    reply.send(await withSuggestedMatches(scan));
  });

  // Section 6.3 review screen: "invoice image on the left." Auth-gated
  // read-back, same reasoning as write-off photos — never a public
  // static path, and the filename on disk is never the response either
  // way (it's addressed by scan id + page number here).
  app.get("/purchase-scans/:id/pages/:pageNumber", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid(), pageNumber: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const scan = await getScan(params.data.id);
    if (!scan) return reply.code(404).send({ error: "not_found" });
    const page = scan.pages.find((p: any) => p.page_number === params.data.pageNumber);
    if (!page) return reply.code(404).send({ error: "not_found" });
    const filePath = resolveScanPagePath(page.file_path);
    if (!filePath) return reply.code(404).send({ error: "not_found" });
    const ext = page.file_path.split(".").pop()!;
    const buf = await readFile(filePath);
    reply.type(CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream").send(buf);
  });

  // The reviewer can correct a wrong vendor guess before committing —
  // re-fetching suggested matches immediately, since alias resolution
  // is vendor-scoped.
  app.patch("/purchase-scans/:id/vendor", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ vendorId: z.string().uuid() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    await setScanVendor(params.data.id, body.data.vendorId);
    const scan = await getScan(params.data.id);
    reply.send(await withSuggestedMatches(scan));
  });

  // Section 6.3, Stage 4 — "one confirm action creates the GRN and the
  // ledger rows." Same line/header shape as manual purchase entry
  // (routes/purchases.ts), plus printedNameForAlias per line so an
  // accepted match is remembered for next time.
  app.post("/purchase-scans/:id/commit", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const body = parsed.data;

    try {
      const result = await commitScan(params.data.id, {
        ...body,
        lines: body.lines.map((l) => ({
          ...l,
          packAsPrinted: l.packAsPrinted ?? null,
          discountValue: l.discountValue ?? null,
          promisedQuantityBaseUnits: l.promisedQuantityBaseUnits ?? null,
          promisedFreeQuantityBaseUnits: l.promisedFreeQuantityBaseUnits ?? null,
          printedNameForAlias: l.printedNameForAlias ?? null,
        })),
        purchaseOrderId: body.purchaseOrderId ?? null,
        createdBy: req.auth!.sub,
      });
      reply.code(201).send(result);
    } catch (err) {
      if (err instanceof ScanCommitError) return reply.code(409).send({ error: err.code });
      if (err instanceof ValidationConflictError) return reply.code(409).send({ error: err.code, details: err.details });
      throw err;
    }
  });

  app.get("/purchase-scans/reports/vendor-accuracy", guard, async (_req, reply) => {
    reply.send(await getVendorAccuracyReport());
  });
}

const commitLineSchema = z.object({
  productId: z.string().uuid(),
  printedNameForAlias: z.string().nullable().optional(),
  batchNo: z.string().min(1),
  expiryDate: z.string(),
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

const commitSchema = z.object({
  vendorId: z.string().uuid(),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  invoiceValueStated: z.number().positive(),
  paymentTermsDays: z.number().int().min(0).default(0),
  billLevelDiscount: z.number().min(0).default(0),
  freightAndCharges: z.number().min(0).default(0),
  roundOff: z.number().default(0),
  lines: z.array(commitLineSchema).min(1),
  overrideNearExpiry: z.boolean().default(false),
  acknowledgeReconciliationMismatch: z.boolean().default(false),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  deviceId: z.string().min(1),
});

async function withSuggestedMatches(scan: any) {
  if (!scan || scan.status !== "extracted" || !scan.raw_extraction) return scan;
  const lines = scan.raw_extraction.lines ?? [];
  const matches: Record<string, unknown> = {};
  for (const line of lines) {
    matches[line.productNameAsPrinted] = await suggestProductMatches(scan.vendor_id, line.productNameAsPrinted);
  }
  return { ...scan, suggestedMatches: matches };
}
