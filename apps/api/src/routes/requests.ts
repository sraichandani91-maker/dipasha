import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createRequest, hasOpenQueueToday, incrementUnreachableAttempts, linkPendingProduct, listRequests, updateRequestStatus } from "../repo/customer-requests.js";
import { reserveForRequest, ReservationError, sweepExpiredReservations } from "../repo/callback.js";
import { getSetting } from "../repo/settings.js";

const createRequestSchema = z
  .object({
    customerName: z.string().min(1),
    customerPhone: z.string().min(6),
    productId: z.string().uuid().nullable().optional(),
    freeTextItem: z.string().nullable().optional(),
    quantityRequestedUnits: z.number().int().positive().nullable().optional(),
    quantityRequestedNote: z.string().nullable().optional(),
    urgency: z.enum(["urgent", "normal", "can_wait"]).default("normal"),
    hasPrescriptionInHand: z.boolean().default(false),
    expectedDate: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    deviceId: z.string().min(1),
  })
  .refine((b) => b.productId || b.freeTextItem, { message: "either productId or freeTextItem is required" });

/**
 * Customer request book (Section 6B) — "the single most valuable data a
 * pharmacy throws away." Loggable in one tap from anywhere (POS,
 * search, standalone) without losing what the user was already doing.
 */
export default async function requestRoutes(app: FastifyInstance) {
  app.post("/requests", { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = createRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;

    const result = await createRequest({
      customerName: b.customerName,
      customerPhone: b.customerPhone,
      productId: b.productId ?? null,
      freeTextItem: b.freeTextItem ?? null,
      quantityRequestedUnits: b.quantityRequestedUnits ?? null,
      quantityRequestedNote: b.quantityRequestedNote ?? null,
      urgency: b.urgency,
      hasPrescriptionInHand: b.hasPrescriptionInHand,
      expectedDate: b.expectedDate ?? null,
      note: b.note ?? null,
      loggedBy: req.auth!.sub,
      deviceId: b.deviceId,
      source: "web",
    });
    reply.code(201).send(result);
  });

  app.get("/requests", { preHandler: app.authenticate }, async (req, reply) => {
    await sweepExpiredReservations(); // lazy — see repo/callback.ts for why
    const q = req.query as { status?: string };
    reply.send(await listRequests(q.status as any));
  });

  // Section 6B.4: "the system offers to reserve the stock against that
  // customer for a configurable window."
  app.post("/requests/:id/reserve", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ deviceId: z.string().min(1) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const result = await reserveForRequest(params.data.id, req.auth!.sub, body.data.deviceId);
      reply.send(result);
    } catch (err) {
      if (err instanceof ReservationError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  // Section 6B.4: staff tried the callback and got no answer — logged so
  // the queue shows it was attempted, not silently stuck. No auto-escalation
  // yet (that's the WhatsApp piece in M8); this just records the attempt.
  app.patch("/requests/:id/unreachable", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const attempts = await incrementUnreachableAttempts(params.data.id);
    reply.send({ unreachableAttempts: attempts });
  });

  app.patch("/requests/:id/link-pending-product", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ productId: z.string().uuid() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    await linkPendingProduct(params.data.id, body.data.productId);
    reply.send({ linked: true });
  });

  const outcomeSchema = z.object({
    status: z.enum(["open", "on_po", "received", "customer_notified", "fulfilled", "cancelled", "lapsed"]),
    couldNotSourceReason: z.string().nullable().optional(),
  });
  app.patch("/requests/:id/status", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = outcomeSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    await updateRequestStatus(params.data.id, body.data.status, { couldNotSourceReason: body.data.couldNotSourceReason ?? undefined });
    reply.send({ updated: true });
  });

  // Section 6B.5: whether today's alarm should fire at all — "no open
  // requests means no alarm, never train people to dismiss it."
  app.get("/requests/daily-review-check", { preHandler: app.authenticate }, async (_req, reply) => {
    reply.send(await hasOpenQueueToday());
  });

  // Section 6B.5's own configured numbers (seeded in M1, unused until now)
  // — not a general settings endpoint (that's M13), just enough for the
  // web alarm to fire on the actual schedule instead of a hardcoded guess.
  app.get("/requests/daily-review-alarm-config", { preHandler: app.authenticate }, async (_req, reply) => {
    reply.send({
      timeLocal: await getSetting("daily_request_review_time_local", "18:00"),
      repeatMinutes: await getSetting("daily_request_review_repeat_minutes", 15),
      maxSnoozes: await getSetting("daily_request_review_max_snoozes", 3),
      escalationMinutes: await getSetting("daily_request_review_escalation_minutes", 90),
    });
  });
}
