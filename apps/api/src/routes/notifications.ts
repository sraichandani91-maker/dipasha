import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSpendSummary, listNotifications, NotificationError, requeueFailedNotification } from "../repo/notification-log.js";
import { processOne } from "../domain/notifications.js";

/**
 * Section 12A.5 — the WhatsApp send log and Failed Notifications list.
 * Owner/Store Manager only: this surfaces customer phone numbers and
 * message content alongside billing/request data, same bar as the
 * screens that generate the notifications in the first place.
 */
export default async function notificationRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/notifications", guard, async (req, reply) => {
    const q = z
      .object({ status: z.string().optional(), referenceType: z.string().optional(), referenceId: z.string().uuid().optional() })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listNotifications(q.data));
  });

  app.get("/notifications/spend-summary", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await getSpendSummary(q.data.from, q.data.to));
  });

  // Section 12A.2: "a permanent failure surfaces on a Failed
  // Notifications list, never silently disappears" — this is how staff
  // act on one: requeue it, then process immediately so they see the
  // outcome without waiting for the next background tick.
  app.post("/notifications/:id/retry", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      await requeueFailedNotification(params.data.id);
    } catch (err) {
      if (err instanceof NotificationError) return reply.code(409).send({ error: err.code });
      throw err;
    }
    await processOne(params.data.id, req.log);
    const [row] = await listNotifications({ id: params.data.id }, 1);
    reply.send({ retried: true, status: row?.status ?? null });
  });
}
