import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting } from "../repo/settings.js";
import { recordInboundMessage, listInboxMessages, markInboxMessageHandled, replyToInboxMessage, InboxError } from "../repo/whatsapp-inbound.js";

/**
 * Section 12A.4: the WhatsApp inbound webhook and shared inbox. The
 * webhook itself (GET for Meta's subscription handshake, POST for the
 * actual message payload) is necessarily unauthenticated — Meta calls
 * it directly, not a logged-in staff member — so it's protected instead
 * by a shared verify token (Meta's own standard mechanism for this
 * exact problem), not `app.authenticate`.
 */
export default async function whatsappInboundRoutes(app: FastifyInstance) {
  // Meta's webhook subscription handshake: it calls this once when the
  // webhook URL is configured, expecting the exact challenge value
  // echoed back if (and only if) the verify token matches.
  app.get("/whatsapp/inbound", async (req, reply) => {
    const query = z
      .object({ "hub.mode": z.string().optional(), "hub.verify_token": z.string().optional(), "hub.challenge": z.string().optional() })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const expected = await getSetting("whatsapp_webhook_verify_token", "change-me-verify-token");
    if (query.data["hub.mode"] === "subscribe" && query.data["hub.verify_token"] === expected && query.data["hub.challenge"]) {
      return reply.send(query.data["hub.challenge"]);
    }
    return reply.code(403).send({ error: "verify_token_mismatch" });
  });

  // The actual message payload. Shaped to match Meta's real WhatsApp
  // Cloud API webhook body (entry[].changes[].value.messages[].{from,
  // text.body}) so this is genuinely wire-compatible the day real
  // credentials exist — not a placeholder shape that would need
  // rewriting later, same "write the real contract, stub the send side"
  // choice M8 made for outbound.
  app.post("/whatsapp/inbound", async (req, reply) => {
    const messages: Array<{ fromPhone: string; body: string }> = [];
    try {
      const entries = (req.body as any)?.entry ?? [];
      for (const entry of entries) {
        for (const change of entry?.changes ?? []) {
          for (const msg of change?.value?.messages ?? []) {
            if (msg?.type === "text" && msg?.from && msg?.text?.body) {
              messages.push({ fromPhone: `+${msg.from}`, body: msg.text.body });
            }
          }
        }
      }
    } catch {
      return reply.code(400).send({ error: "invalid_payload" });
    }

    for (const m of messages) {
      await recordInboundMessage(m, req.log);
    }
    // Meta requires a 200 within a few seconds regardless of content, or
    // it retries and eventually disables the webhook.
    reply.code(200).send({ received: messages.length });
  });

  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/whatsapp/inbox", guard, async (req, reply) => {
    const query = z.object({ handled: z.enum(["true", "false"]).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listInboxMessages({ handled: query.data.handled === undefined ? undefined : query.data.handled === "true" }));
  });

  app.post("/whatsapp/inbox/:id/mark-handled", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      await markInboxMessageHandled(params.data.id, req.auth!.sub);
      reply.send({ handled: true });
    } catch (err) {
      if (err instanceof InboxError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.post("/whatsapp/inbox/:id/reply", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ body: z.string().min(1) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await replyToInboxMessage(params.data.id, body.data.body, req.auth!.sub, req.log);
      reply.send({ replied: true });
    } catch (err) {
      if (err instanceof InboxError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });
}
