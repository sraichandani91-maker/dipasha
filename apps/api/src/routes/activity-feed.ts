import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActivityFeed, ACTIVITY_CATEGORIES } from "../repo/activity-feed.js";

const querySchema = z.object({
  from: z.string(),
  to: z.string(),
  category: z.enum(ACTIVITY_CATEGORIES).optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Owner-requested "who did what" feed across sales, purchases, stock,
 * and audits — a human-readable timeline built from the real domain
 * audit trails (purchase-invoice corrections, batch corrections, the
 * movement ledger, cycle counts), not the bare HTTP-call `activity_log`
 * table M13.1 already exposes under Staff. Owner-only, same bar as that
 * existing log and every other cross-staff oversight screen.
 */
export default async function activityFeedRoutes(app: FastifyInstance) {
  app.get("/activity-feed", { preHandler: [app.authenticate, app.requireRole("owner")] }, async (req, reply) => {
    const q = querySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", details: q.error.flatten() });
    reply.send(
      await getActivityFeed({
        fromDate: q.data.from,
        toDate: q.data.to,
        category: q.data.category,
        actorUserId: q.data.userId,
        limit: q.data.limit,
        offset: q.data.offset,
      })
    );
  });
}
