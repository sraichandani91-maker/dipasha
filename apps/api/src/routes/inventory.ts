import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listStock,
  adjustStockQuantity,
  correctBatchField,
  blockBatch,
  unblockBatch,
  createBinTransferTask,
  diffBulkStockAdjustment,
  commitBulkStockAdjustment,
  diffBulkBinReassignment,
  commitBulkBinReassignment,
  diffBulkPriceUpdate,
  commitBulkPriceUpdate,
  InventoryError,
  INVENTORY_CORRECTION_REASON_CODES,
} from "../repo/inventory.js";

const correctionSchema = z.object({
  reasonCode: z.enum(INVENTORY_CORRECTION_REASON_CODES),
  note: z.string().min(1),
  deviceId: z.string().min(1),
});

/**
 * Section 10.2 "Inventory" — full stock view, stock edits, move-between-
 * bins (also the bin-to-bin migration deferred from M11), block/unblock
 * a batch, and bulk CSV import with a mandatory preview-and-confirm diff.
 */
export default async function inventoryRoutes(app: FastifyInstance) {
  app.get("/inventory/stock", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    reply.send(
      await listStock({
        search: q.search,
        binId: q.binId,
        batchNo: q.batchNo,
        expiryFrom: q.expiryFrom,
        expiryTo: q.expiryTo,
        scheduleCategory: q.scheduleCategory,
        zone: q.zone,
        minValue: q.minValue ? Number(q.minValue) : undefined,
        maxValue: q.maxValue ? Number(q.maxValue) : undefined,
      })
    );
  });

  app.post(
    "/inventory/stock/adjust",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const body = z
        .object({ productId: z.string().uuid(), batchId: z.string().uuid(), binId: z.string().uuid(), newQuantityBaseUnits: z.number().int().min(0) })
        .merge(correctionSchema)
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
      try {
        reply.send(
          await adjustStockQuantity({
            productId: body.data.productId,
            batchId: body.data.batchId,
            binId: body.data.binId,
            newQuantityBaseUnits: body.data.newQuantityBaseUnits,
            reasonCode: body.data.reasonCode,
            note: body.data.note,
            actorUserId: req.auth!.sub,
            deviceId: body.data.deviceId,
          })
        );
      } catch (err) {
        if (err instanceof InventoryError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/inventory/batches/:id/correct",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ field: z.enum(["batch_no", "expiry_date", "mrp"]), newValue: z.string().min(1) }).merge(correctionSchema).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await correctBatchField({
          batchId: params.data.id,
          field: body.data.field,
          newValue: body.data.newValue,
          reasonCode: body.data.reasonCode,
          note: body.data.note,
          actorUserId: req.auth!.sub,
          deviceId: body.data.deviceId,
        });
        reply.send({ corrected: true });
      } catch (err) {
        if (err instanceof InventoryError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/inventory/batches/:id/block",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ reasonCode: z.enum(INVENTORY_CORRECTION_REASON_CODES), note: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await blockBatch(params.data.id, body.data.reasonCode, body.data.note);
        reply.send({ blocked: true });
      } catch (err) {
        if (err instanceof InventoryError) return reply.code(404).send({ error: err.code });
        throw err;
      }
    }
  );

  app.post(
    "/inventory/batches/:id/unblock",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      try {
        await unblockBatch(params.data.id);
        reply.send({ unblocked: true });
      } catch (err) {
        if (err instanceof InventoryError) return reply.code(404).send({ error: err.code });
        throw err;
      }
    }
  );

  app.post(
    "/inventory/move-stock",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const body = z
        .object({ productId: z.string().uuid(), batchId: z.string().uuid(), sourceBinId: z.string().uuid(), destinationBinId: z.string().uuid(), quantityBaseUnits: z.number().int().positive() })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const result = await createBinTransferTask({ ...body.data, requestedBy: req.auth!.sub });
        reply.code(201).send(result);
      } catch (err) {
        if (err instanceof InventoryError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  const bulkGuard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };
  const csvBodySchema = z.object({ csv: z.string().min(1) });
  const bulkCommitSchema = csvBodySchema.merge(correctionSchema);

  app.post("/inventory/bulk/stock-adjustment/preview", bulkGuard, async (req, reply) => {
    const body = csvBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    reply.send(await diffBulkStockAdjustment(body.data.csv));
  });
  app.post("/inventory/bulk/stock-adjustment/commit", bulkGuard, async (req, reply) => {
    const body = bulkCommitSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    reply.send(await commitBulkStockAdjustment(body.data.csv, body.data.reasonCode, body.data.note, req.auth!.sub, body.data.deviceId));
  });

  app.post("/inventory/bulk/bin-reassignment/preview", bulkGuard, async (req, reply) => {
    const body = csvBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    reply.send(await diffBulkBinReassignment(body.data.csv));
  });
  app.post("/inventory/bulk/bin-reassignment/commit", bulkGuard, async (req, reply) => {
    const body = csvBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    reply.send(await commitBulkBinReassignment(body.data.csv, req.auth!.sub));
  });

  app.post("/inventory/bulk/price-update/preview", bulkGuard, async (req, reply) => {
    const body = csvBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    reply.send(await diffBulkPriceUpdate(body.data.csv));
  });
  app.post("/inventory/bulk/price-update/commit", bulkGuard, async (req, reply) => {
    const body = bulkCommitSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    reply.send(await commitBulkPriceUpdate(body.data.csv, body.data.reasonCode, body.data.note, req.auth!.sub, body.data.deviceId));
  });
}
