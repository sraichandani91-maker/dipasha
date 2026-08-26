import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scheduleHRegister } from "../repo/reports.js";

// Section 9A.1 privacy note: prescriber/patient reporting restricted to
// Owner and Store Manager — this links patients to prescriptions.
export default async function reportRoutes(app: FastifyInstance) {
  app.get(
    "/reports/schedule-h-register",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query", details: "from and to (YYYY-MM-DD) required" });
      reply.send(await scheduleHRegister(q.data.from, q.data.to));
    }
  );
}
