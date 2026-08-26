import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { closeDay, DayCloseError, previewCash } from "../repo/day-close.js";

export default async function dayCloseRoutes(app: FastifyInstance) {
  app.get(
    "/day-close/preview",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const q = z.object({ businessDate: z.string() }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      reply.send(await previewCash(q.data.businessDate));
    }
  );

  app.post(
    "/day-close",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = z.object({ businessDate: z.string(), declaredCash: z.number().min(0), note: z.string().nullable().optional(), deviceId: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const result = await closeDay(parsed.data.businessDate, parsed.data.declaredCash, parsed.data.note ?? null, req.auth!.sub, parsed.data.deviceId);
        reply.code(201).send(result);
      } catch (err) {
        if (err instanceof DayCloseError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );
}
