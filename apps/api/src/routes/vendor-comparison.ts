import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { lastRatesForProduct, vendorRateRiseFlags, vendorScorecard } from "../repo/vendor-comparison.js";

/**
 * Section 9A.6 — multi-vendor rate comparison and the vendor scorecard.
 * Owner/Store Manager only, same bar as purchase entry (this is cost
 * data).
 */
export default async function vendorComparisonRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/vendor-comparison/rates/:productId", guard, async (req, reply) => {
    const params = z.object({ productId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send(await lastRatesForProduct(params.data.productId));
  });

  app.get("/vendor-comparison/rate-rises", guard, async (_req, reply) => {
    reply.send(await vendorRateRiseFlags());
  });

  app.get("/vendor-comparison/scorecard", guard, async (_req, reply) => {
    reply.send(await vendorScorecard());
  });
}
