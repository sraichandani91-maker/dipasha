import type { FastifyInstance } from "fastify";
import { listProducts } from "../repo/products.js";

/**
 * Establishes the pattern the rest of the build repeats for cost/margin
 * data (Section 6A.9, 10B.4): the field is ABSENT from the response for
 * everyone but Owner, not present-and-null or present-and-zero. A hidden
 * field in a response body is not hidden — so the server strips the key
 * entirely rather than trusting the client not to render it.
 */
export default async function productRoutes(app: FastifyInstance) {
  app.get("/products", { preHandler: app.authenticate }, async (req, reply) => {
    const limit = Math.min(Number((req.query as any)?.limit ?? 50), 200);
    const offset = Number((req.query as any)?.offset ?? 0);

    const products = await listProducts(limit, offset);
    const isOwner = req.auth!.role === "owner";

    reply.send(
      products.map((p) => ({
        ...p,
        batches: p.batches.map((b: any) => {
          const { __effectiveCostPerBaseUnit, ...rest } = b;
          return isOwner
            ? { ...rest, effectiveCostPerBaseUnit: __effectiveCostPerBaseUnit }
            : rest;
        }),
      }))
    );
  });
}
