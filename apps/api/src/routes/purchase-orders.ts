import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createPurchaseOrder, getPurchaseOrder, suggestedPurchaseOrderLines } from "../repo/purchase-orders.js";

const createPoSchema = z.object({
  vendorId: z.string().uuid(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantityBaseUnits: z.number().int().positive(),
    sourceReasons: z.array(z.string()).default(["manual"]),
    requestIds: z.array(z.string().uuid()).default([]),
  })).min(1),
  deviceId: z.string().min(1),
});

export default async function purchaseOrderRoutes(app: FastifyInstance) {
  app.get(
    "/purchase-orders/suggestions",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await suggestedPurchaseOrderLines());
    }
  );

  app.post(
    "/purchase-orders",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createPoSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const result = await createPurchaseOrder({ ...parsed.data, createdBy: req.auth!.sub });
      reply.code(201).send(result);
    }
  );

  app.get(
    "/purchase-orders/:id",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      const po = await getPurchaseOrder(params.data.id);
      if (!po) return reply.code(404).send({ error: "not_found" });
      reply.send(po);
    }
  );
}
