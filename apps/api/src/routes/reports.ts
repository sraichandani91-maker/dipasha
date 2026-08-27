import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scheduleHRegister } from "../repo/reports.js";
import { listManualOverrides } from "../repo/manual-overrides.js";

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

  // Section 10.1: "Surface every web_manual row on a dedicated Manual
  // Override report." Owner/Store Manager — same bar as every other
  // report in this build, not the Owner-only default 10.1 describes for
  // *performing* the underlying actions, which stays open to whichever
  // role actually does that work today (see DECISIONS.md — no separate
  // scanning client exists yet, so gating put-away/pick/pack/handover/
  // cycle-count-entry to Owner-only would break real operations).
  app.get(
    "/reports/manual-overrides",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await listManualOverrides());
    }
  );
}
