import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { reserveBlock, billSeriesPrefix, formatBillNumber } from "../domain/bill-numbering.js";
import { getSetting } from "../repo/settings.js";
import { createSale, ValidationError } from "../repo/sales.js";
import { recordSyncConflict, listSyncConflicts, resolveSyncConflict, SyncConflictError } from "../repo/sync-conflicts.js";
import { getPosOfflineSnapshot } from "../repo/pos-offline.js";

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

const syncSaleSchema = z.object({
  idempotencyKey: z.string().min(1),
  occurredAt: z.string().min(1),
  preAssignedBillNumber: z.string().min(1),
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
 * Section 11 / Section 6A.9: offline mode and sync ledger. POS is the
 * offline-first flow this milestone delivers — a device pre-reserves a
 * block of bill numbers here while online, bills fully offline against
 * a locally cached snapshot (Section 6A.9), then replays each queued
 * sale through /sync/sales on reconnect. A replay that can't be honoured
 * (most commonly stock moved while the device was offline) is never
 * silently dropped or retried differently — it's logged as a durable,
 * Owner-visible conflict instead (Section 6A.9: "any conflict escalated
 * to the Owner rather than silently resolved").
 */
export default async function syncRoutes(app: FastifyInstance) {
  app.get(
    "/pos/offline-snapshot",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await getPosOfflineSnapshot());
    }
  );

  app.post(
    "/bill-numbers/reserve-block",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const body = z.object({ deviceId: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const blockSize = await getSetting("offline_bill_number_block_size", 5);
      const prefix = await billSeriesPrefix("counter"); // offline billing is counter-only this milestone
      const db = requirePool();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const { start, end } = await reserveBlock(client, prefix, blockSize);
        await client.query(
          `INSERT INTO bill_number_blocks (device_id, prefix, range_start, range_end, issued_by) VALUES ($1,$2,$3,$4,$5)`,
          [body.data.deviceId, prefix, start, end, req.auth!.sub]
        );
        await client.query("COMMIT");
        const numbers = [];
        for (let n = start; n <= end; n++) numbers.push(formatBillNumber(prefix, n));
        reply.send({ prefix, numbers });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/sync/sales",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = syncSaleSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const body = parsed.data;

      try {
        const result = await createSale({
          channel: "counter",
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
          source: "app", // an offline-captured sale, replayed — not a live web click
          preAssignedBillNumber: body.preAssignedBillNumber,
          occurredAt: body.occurredAt,
          idempotencyKey: body.idempotencyKey,
        });
        reply.code(201).send({ synced: true, ...result });
      } catch (err) {
        if (err instanceof ValidationError) {
          const conflict = await recordSyncConflict({
            deviceId: body.deviceId,
            idempotencyKey: body.idempotencyKey,
            conflictType: err.code,
            errorDetails: err.details,
            originalPayload: body,
            raisedBy: req.auth!.sub,
          });
          return reply.code(409).send({ error: err.code, details: err.details, conflictId: conflict.id });
        }
        throw err;
      }
    }
  );

  app.get(
    "/sync-conflicts",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const q = z.object({ status: z.enum(["open", "resolved"]).optional() }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      reply.send(await listSyncConflicts(q.data.status));
    }
  );

  app.post(
    "/sync-conflicts/:id/resolve",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ resolutionNote: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await resolveSyncConflict(params.data.id, body.data.resolutionNote, req.auth!.sub);
        reply.send({ resolved: true });
      } catch (err) {
        if (err instanceof SyncConflictError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );
}
