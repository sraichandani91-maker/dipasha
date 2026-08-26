import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createVendor, listVendors, updateVendorMoq } from "../repo/vendors.js";

const createVendorSchema = z.object({
  name: z.string().min(1),
  gstin: z.string().length(15).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).optional(),
});

export default async function vendorRoutes(app: FastifyInstance) {
  app.get("/vendors", { preHandler: app.authenticate }, async (_req, reply) => {
    reply.send(await listVendors());
  });

  app.post(
    "/vendors",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createVendorSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const v = parsed.data;
      const created = await createVendor({
        name: v.name,
        gstin: v.gstin ?? null,
        paymentTermsDays: v.paymentTermsDays ?? 0,
        createdBy: req.auth!.sub,
      });
      reply.code(201).send(created);
    }
  );

  app.patch(
    "/vendors/:id/moq",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ defaultMinOrderPackUnits: z.number().int().positive().nullable() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      await updateVendorMoq(params.data.id, body.data.defaultMinOrderPackUnits);
      reply.send({ updated: true });
    }
  );
}
