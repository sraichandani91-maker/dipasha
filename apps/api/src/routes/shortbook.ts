import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getShortbookDashboard, getShortbookItems, listCart, upsertCartItem, removeCartItem, checkoutCart } from "../repo/shortbook.js";

/**
 * Order Book — the owner's "Orderbook Dashboard" + Shortbook Settings +
 * cart + checkout. Shortbook settings themselves live in the generic
 * `settings` table and are read/written through the existing owner-only
 * GET /settings and PATCH /settings/:key routes (routes/settings.ts) —
 * they're just five more rows in the same table every other threshold in
 * this app already lives in, not a second settings mechanism.
 */
export default async function shortbookRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/shortbook/dashboard", guard, async (_req, reply) => {
    reply.send(await getShortbookDashboard());
  });

  app.get("/shortbook/items", guard, async (_req, reply) => {
    reply.send(await getShortbookItems());
  });

  app.get("/shortbook/cart", guard, async (_req, reply) => {
    reply.send(await listCart());
  });

  const cartItemSchema = z.object({
    productId: z.string().uuid(),
    quantityBaseUnits: z.number().int().positive(),
    vendorId: z.string().uuid().nullable().default(null),
  });

  app.post("/shortbook/cart", guard, async (req, reply) => {
    const parsed = cartItemSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    await upsertCartItem({ ...parsed.data, actorUserId: req.auth!.sub });
    reply.send({ updated: true });
  });

  app.delete("/shortbook/cart/:productId", guard, async (req, reply) => {
    const params = z.object({ productId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    await removeCartItem(params.data.productId);
    reply.send({ removed: true });
  });

  app.post("/shortbook/cart/checkout", guard, async (req, reply) => {
    const body = z.object({ deviceId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const result = await checkoutCart(req.auth!.sub, body.data.deviceId);
    reply.send(result);
  });
}
