import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildPurchaseOrderCsv, buildPurchaseOrderPdf } from "../domain/po-document.js";
import {
  createPurchaseOrder,
  getPoChaseList,
  getPurchaseOrder,
  listPurchaseOrders,
  markPurchaseOrderAcknowledged,
  markPurchaseOrderSent,
  PurchaseOrderError,
  suggestedPurchaseOrderLines,
} from "../repo/purchase-orders.js";

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
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/purchase-orders/suggestions", guard, async (_req, reply) => {
    reply.send(await suggestedPurchaseOrderLines());
  });

  app.post("/purchase-orders", guard, async (req, reply) => {
    const parsed = createPoSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const result = await createPurchaseOrder({ ...parsed.data, createdBy: req.auth!.sub });
    reply.code(201).send(result);
  });

  // Section 10B.2: "order confirmation tracking... chase list for POs
  // unacknowledged beyond a configurable window." Registered before
  // `/purchase-orders/:id` so it isn't shadowed — Fastify matches by
  // exact path structure, but keeping the specific routes first here
  // avoids any doubt for anyone reading top to bottom later.
  app.get("/purchase-orders/chase-list", guard, async (_req, reply) => {
    reply.send(await getPoChaseList());
  });

  app.get("/purchase-orders", guard, async (req, reply) => {
    const q = z.object({ status: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listPurchaseOrders(q.data));
  });

  app.get("/purchase-orders/:id", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const po = await getPurchaseOrder(params.data.id);
    if (!po) return reply.code(404).send({ error: "not_found" });
    reply.send(po);
  });

  app.post("/purchase-orders/:id/send", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ via: z.enum(["whatsapp", "email"]) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await markPurchaseOrderSent(params.data.id, body.data.via, req.log);
      reply.send({ sent: true });
    } catch (err) {
      if (err instanceof PurchaseOrderError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.post("/purchase-orders/:id/acknowledge", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      await markPurchaseOrderAcknowledged(params.data.id);
      reply.send({ acknowledged: true });
    } catch (err) {
      if (err instanceof PurchaseOrderError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  app.get("/purchase-orders/:id/export", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const q = z.object({ format: z.enum(["pdf", "csv"]).default("pdf") }).safeParse(req.query);
    if (!params.success || !q.success) return reply.code(400).send({ error: "invalid_query" });
    const po = await getPurchaseOrder(params.data.id);
    if (!po) return reply.code(404).send({ error: "not_found" });

    if (q.data.format === "csv") {
      return reply.header("Content-Disposition", `attachment; filename="${po.po_number}.csv"`).type("text/csv").send(buildPurchaseOrderCsv(po as any));
    }
    const pdfBytes = await buildPurchaseOrderPdf(po as any);
    reply.header("Content-Disposition", `attachment; filename="${po.po_number}.pdf"`).type("application/pdf").send(Buffer.from(pdfBytes));
  });
}
