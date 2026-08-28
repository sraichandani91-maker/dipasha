import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createProduct, findProductsBySubstituteGroup, getStockLocations, listProducts, listProductsForLabelSheet, updateProduct } from "../repo/products.js";
import { getProductHistory } from "../repo/product-history.js";
import { findOrCreateSalt } from "../repo/salts.js";
import { substituteGroupKey } from "../domain/substitute-group.js";
import { generateInternalBarcode } from "../domain/barcode.js";
import { buildProductLabelSheetPdf } from "../domain/label-sheet.js";
import {
  listSubstituteGroups,
  moveProductToGroup,
  diffBulkProductImport,
  commitBulkProductImport,
  ProductMasterError,
} from "../repo/product-master.js";

const compositionSchema = z.object({
  saltId: z.string().uuid().optional(),
  saltName: z.string().min(1).optional(),
  strength: z.string().min(1),
}).refine((c) => c.saltId || c.saltName, { message: "each composition needs saltId or saltName" });

const createProductSchema = z.object({
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  form: z.string().min(1),
  scheduleCategory: z.enum(["OTC", "H", "H1", "X", "Ayurvedic", "Cosmetic", "Device"]),
  requiresPrescription: z.boolean().optional(),
  hsnCode: z.string().min(1),
  gstRate: z.number().min(0).max(28),
  baseUnit: z.string().min(1),
  packSize: z.number().int().positive(),
  outerPackSize: z.number().int().positive().nullable().optional(),
  allowLooseSale: z.boolean().optional(),
  looseSaleMarkupPercent: z.number().min(0).optional(),
  isColdChain: z.boolean().optional(),
  barcode: z.string().min(1).nullable().optional(),
  compositions: z.array(compositionSchema).min(1),
  status: z.enum(["active", "pending"]).optional(),
  confirmDuplicate: z.boolean().optional(),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  manufacturer: z.string().min(1).optional(),
  barcode: z.string().min(1).nullable().optional(),
  allowLooseSale: z.boolean().optional(),
  looseSaleMarkupPercent: z.number().min(0).optional(),
  status: z.enum(["active", "pending", "inactive"]).optional(),
});

/**
 * Establishes the pattern the rest of the build repeats for cost/margin
 * data (Section 6A.9, 10B.4): the field is ABSENT from the response for
 * everyone but Owner, not present-and-null or present-and-zero. A hidden
 * field in a response body is not hidden — so the server strips the key
 * entirely rather than trusting the client not to render it.
 */
export default async function productRoutes(app: FastifyInstance) {
  app.get("/products", { preHandler: app.authenticate }, async (req, reply) => {
    const limit = Math.min(Number((req.query as any)?.limit ?? 50), 200);
    const offset = Number((req.query as any)?.offset ?? 0);

    const products = await listProducts(limit, offset);
    const isOwner = req.auth!.role === "owner";

    reply.send(
      products.map((p) => ({
        ...p,
        batches: p.batches.map((b: any) => {
          const { __effectiveCostPerBaseUnit, ...rest } = b;
          return isOwner
            ? { ...rest, effectiveCostPerBaseUnit: __effectiveCostPerBaseUnit }
            : rest;
        }),
      }))
    );
  });

  // Section 9's write-off form (and anything else that needs "which
  // batch, in which bin, right now") needs more than the aggregated
  // batches array above — this is the same underlying `stock` view,
  // just per-bin instead of summed across the product.
  app.get("/products/:id/stock-locations", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send(await getStockLocations(params.data.id));
  });

  // F4-from-search item ledger (owner-requested): every sale and every
  // GST purchase this product has ever appeared on, one row per
  // transaction. Same Owner/store_manager bar as `GET /sales` and
  // `GET /purchase-invoices` — a purchase row always carries the landed
  // rate, which is cost data.
  app.get(
    "/products/:id/history",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      reply.send(await getProductHistory(params.data.id));
    }
  );

  // Product master create/edit (Section 10.2). Owner and Store Manager
  // only — pickers/riders/other reads stay open via GET above, but the
  // catalogue itself is a manager-level responsibility (nothing in the
  // doc restricts this further; product-creation fields carry no
  // cost/margin data, so it doesn't intersect the Owner-only rules).
  app.post(
    "/products",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createProductSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const body = parsed.data;

      // Resolve each composition to a real salt row, creating it in the
      // growing salt master if it's genuinely new (Section 6B.2).
      const resolvedCompositions = [];
      for (const c of body.compositions) {
        const salt = c.saltId ? { id: c.saltId, name: "" } : await findOrCreateSalt(c.saltName!);
        resolvedCompositions.push({ saltId: salt.id, strength: c.strength });
      }

      const substituteGroupId = substituteGroupKey(resolvedCompositions, body.form);

      if (!body.confirmDuplicate) {
        const matches = await findProductsBySubstituteGroup(substituteGroupId);
        if (matches.length > 0) {
          // Not a hard block (Section 6A.9's "no hard blocks" philosophy
          // applies here too) — surfaced so the user can link a
          // substitute instead of creating a near-duplicate, or resubmit
          // with confirmDuplicate: true to proceed anyway.
          return reply.code(409).send({
            error: "possible_duplicate",
            message: "An existing SKU shares this exact composition, strength and form.",
            existingProducts: matches,
          });
        }
      }

      const requiresPrescription = body.requiresPrescription ?? (body.scheduleCategory === "H" || body.scheduleCategory === "H1");

      const created = await createProduct({
        name: body.name,
        manufacturer: body.manufacturer,
        form: body.form,
        scheduleCategory: body.scheduleCategory,
        requiresPrescription,
        hsnCode: body.hsnCode,
        gstRate: body.gstRate,
        baseUnit: body.baseUnit,
        packSize: body.packSize,
        outerPackSize: body.outerPackSize ?? null,
        allowLooseSale: body.allowLooseSale ?? (body.form === "tablet" || body.form === "capsule"),
        looseSaleMarkupPercent: body.looseSaleMarkupPercent ?? 0,
        isColdChain: body.isColdChain ?? false,
        barcode: body.barcode ?? generateInternalBarcode(),
        compositions: resolvedCompositions,
        substituteGroupId,
        status: body.status ?? "active",
        createdBy: req.auth!.sub,
      });

      reply.code(201).send({ id: created.id, substituteGroupId });
    }
  );

  app.patch(
    "/products/:id",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const paramsResult = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!paramsResult.success) return reply.code(400).send({ error: "invalid_id" });
      const parsed = updateProductSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

      const updated = await updateProduct(paramsResult.data.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: "not_found_or_no_changes" });
      reply.send({ id: paramsResult.data.id, updated: true });
    }
  );

  // Section 10.2: "Manage substitute_group_id mappings — much easier on
  // a big screen." The M2 value is auto-computed and has no override
  // path — this is that override.
  app.get(
    "/products/substitute-groups",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await listSubstituteGroups());
    }
  );

  app.post(
    "/products/:id/substitute-group",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ targetProductId: z.string().uuid().nullable(), note: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        reply.send(await moveProductToGroup(params.data.id, body.data.targetProductId, body.data.note, req.auth!.sub));
      } catch (err) {
        if (err instanceof ProductMasterError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  // Section 10.2: "Bulk CSV import of the product master with preview
  // diff." See repo/product-master.ts for exactly what an update row can
  // and can't touch.
  app.post(
    "/products/bulk-import/preview",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const body = z.object({ csv: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      reply.send(await diffBulkProductImport(body.data.csv));
    }
  );

  app.post(
    "/products/bulk-import/commit",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const body = z.object({ csv: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      reply.send(await commitBulkProductImport(body.data.csv, req.auth!.sub));
    }
  );

  // Section 10.2: "Barcode assignment and printable label sheet
  // generation (PDF download for A4 sticker stock)." ?ids=uuid,uuid or
  // omit for every active product with a barcode assigned.
  app.get("/products/label-sheet", { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as { ids?: string };
    const products = await listProductsForLabelSheet(q.ids ? q.ids.split(",").filter(Boolean) : undefined);
    const printable = products.filter((p) => p.barcode);
    if (printable.length === 0) return reply.code(404).send({ error: "no_barcoded_products_matched" });

    const pdfBytes = await buildProductLabelSheetPdf(products);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="product-labels.pdf"`)
      .send(Buffer.from(pdfBytes));
  });
}
