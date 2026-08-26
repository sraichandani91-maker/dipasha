import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logSearch, search } from "../repo/search.js";

const querySchema = z.object({
  q: z.string().min(1),
  // Same endpoint everywhere (POS, app lookup, request book, purchase
  // entry) — context tags what the caller intends to do with a result,
  // per Section 5B.3. The side effects for each context (add to bill, log
  // a request, add a PO line) belong to their own milestones (M4/M6B/M3);
  // for now this just records intent in the search log.
  context: z.enum(["pos", "app_lookup", "request_book", "purchase_entry", "delivery_order"]).optional(),
});

/**
 * THE unified search (Section 5B) — one bar, one endpoint, reused by
 * every screen that needs to find a product. Do not build a second
 * "substitute finder" anywhere; every caller hits this.
 */
export default async function searchRoutes(app: FastifyInstance) {
  app.get("/search", { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "missing_query", param: "q" });

    const result = await search(parsed.data.q);
    const resultCount = result.groups.reduce((n, g) => n + g.products.length, 0);

    // Fire-and-forget: never let logging slow down or fail the search
    // itself, but zero-result searches especially are worth capturing
    // (Section 5B.3 — feeds the request book and new-SKU decisions).
    logSearch(parsed.data.q, parsed.data.context ?? null, resultCount, req.auth!.sub).catch((err) =>
      req.log.warn({ err }, "failed to log search")
    );

    reply.send(result);
  });
}
