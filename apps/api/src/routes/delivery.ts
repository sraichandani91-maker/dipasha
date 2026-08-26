import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assignRider, listRiderOrders, handoverScan, markReached, recordGpsPing, markDelivered, markDeliveryFailed,
  listPendingReturnTasks, confirmDeliveryReturn, ReturnTaskError, previewRiderCash, closeRiderShift,
  listRiderCashReconciliations, DeliveryError,
} from "../repo/delivery.js";
import { listActiveRiders } from "../repo/users.js";

const gpsSchema = z.object({ lat: z.coerce.number(), lng: z.coerce.number() }).nullable().optional();
const FAILURE_REASON_CODES = ["customer_unavailable", "wrong_address", "refused", "payment_failed", "rx_invalid"] as const;

/**
 * Section 8: rider/dispatch module — trip assignment, handover scan,
 * in-transit marking, COD collection, end-of-shift cash reconciliation,
 * and the failed-delivery return-to-store queue.
 */
export default async function deliveryRoutes(app: FastifyInstance) {
  app.get("/riders", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (_req, reply) => {
    reply.send(await listActiveRiders());
  });

  app.post(
    "/orders/:id/assign-rider",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ riderId: z.string().uuid() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        reply.send(await assignRider(params.data.id, body.data.riderId, req.auth!.sub));
      } catch (err) {
        if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.get("/rider/orders", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    reply.send(await listRiderOrders(req.auth!.sub));
  });

  app.post("/rider/handover", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const body = z.object({ orderNumber: z.string().min(1), gps: gpsSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      reply.send(await handoverScan(body.data.orderNumber, req.auth!.sub, body.data.gps ?? null));
    } catch (err) {
      if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code, details: err.details });
      throw err;
    }
  });

  app.post("/rider/orders/:id/reached", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      await markReached(params.data.id, req.auth!.sub);
      reply.send({ reached: true });
    } catch (err) {
      if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.post("/rider/orders/:id/gps-ping", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ lat: z.coerce.number(), lng: z.coerce.number(), kind: z.enum(["handover", "in_transit", "delivered"]) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await recordGpsPing(params.data.id, req.auth!.sub, body.data.lat, body.data.lng, body.data.kind);
      reply.send({ recorded: true });
    } catch (err) {
      if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  const deliveredSchema = z.object({
    tenderType: z.enum(["cash", "upi"]),
    amountCollected: z.coerce.number().min(0),
    referenceNumber: z.string().nullable().optional(),
    deliveryProofNote: z.string().min(1),
    gps: gpsSchema,
  });
  app.post("/rider/orders/:id/delivered", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = deliveredSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await markDelivered(params.data.id, req.auth!.sub, {
        tenderType: body.data.tenderType,
        amountCollected: body.data.amountCollected,
        referenceNumber: body.data.referenceNumber ?? null,
        deliveryProofNote: body.data.deliveryProofNote,
        gps: body.data.gps ?? null,
      });
      reply.send({ delivered: true });
    } catch (err) {
      if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.post("/rider/orders/:id/failed", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ reasonCode: z.enum(FAILURE_REASON_CODES), note: z.string().min(1) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      reply.send(await markDeliveryFailed(params.data.id, req.auth!.sub, body.data.reasonCode, body.data.note));
    } catch (err) {
      if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.get(
    "/delivery-returns",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (_req, reply) => {
      reply.send(await listPendingReturnTasks());
    }
  );

  app.post(
    "/delivery-returns/:id/confirm",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ scannedBinCode: z.string().min(1), deviceId: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await confirmDeliveryReturn(params.data.id, body.data.scannedBinCode, req.auth!.sub, body.data.deviceId, "web");
        reply.send({ confirmed: true });
      } catch (err) {
        if (err instanceof ReturnTaskError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  app.get("/rider/cash/preview", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const q = z.object({ businessDate: z.string().min(1) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await previewRiderCash(req.auth!.sub, q.data.businessDate));
  });

  app.post("/rider/cash/close", { preHandler: [app.authenticate, app.requireRole("rider")] }, async (req, reply) => {
    const body = z.object({
      businessDate: z.string().min(1),
      declaredCash: z.coerce.number().min(0),
      note: z.string().nullable().optional(),
      deviceId: z.string().min(1),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      reply.send(await closeRiderShift(req.auth!.sub, body.data.businessDate, body.data.declaredCash, body.data.note ?? null, req.auth!.sub, body.data.deviceId));
    } catch (err) {
      if (err instanceof DeliveryError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.get(
    "/rider-cash-reconciliations",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await listRiderCashReconciliations());
    }
  );
}
