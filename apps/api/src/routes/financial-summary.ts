import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeFinancialSummary, getStockValuationAsOf } from "../repo/financial-summary.js";

/**
 * Section 10B.1's management P&L / payables-receivables dashboard and
 * Section 10B.4's owner daily summary both read from
 * `computeFinancialSummary` — one endpoint, one number, for any date
 * range. Section 10B.4 states the visibility rule "non-negotiable":
 * Owner role only, enforced here server-side, same bar M7's margin
 * reports already use for the same class of data (gross profit is
 * margin data).
 */
export default async function financialSummaryRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner")] };

  app.get("/financial-summary", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await computeFinancialSummary(q.data.from, q.data.to));
  });

  app.get("/stock-valuation", guard, async (req, reply) => {
    const q = z.object({ asOf: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await getStockValuationAsOf(q.data.asOf));
  });
}
