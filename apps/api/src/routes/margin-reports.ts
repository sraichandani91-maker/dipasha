import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { belowCostSales, marginByCategory, marginBySku, marginByVendor, schemeShortfalls } from "../repo/margin-reports.js";

const dateRangeSchema = z.object({ from: z.string(), to: z.string() });

/**
 * Section 9A.2 — margin reporting on effective cost, never invoice rate,
 * plus scheme (promised-vs-arrived) tracking. Owner-only: this is cost
 * and margin data, same "absent, not blanked" access bar as the rest of
 * the build's cost-visibility rules.
 */
export default async function marginReportRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner")] };

  app.get("/margin-reports/by-sku", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await marginBySku(q.data.from, q.data.to));
  });

  app.get("/margin-reports/by-category", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await marginByCategory(q.data.from, q.data.to));
  });

  app.get("/margin-reports/by-vendor", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await marginByVendor(q.data.from, q.data.to));
  });

  app.get("/margin-reports/below-cost-sales", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await belowCostSales(q.data.from, q.data.to));
  });

  app.get("/margin-reports/scheme-shortfalls", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await schemeShortfalls(q.data.from, q.data.to));
  });
}
