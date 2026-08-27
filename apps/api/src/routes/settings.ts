import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listSettings, updateSetting, SettingError } from "../repo/settings.js";

/**
 * Section 10.2 "Settings screen — centralize every configurable
 * threshold." Every value here already exists in the settings table,
 * seeded across every prior milestone's migration (Section 15: "every
 * configurable number goes in settings, not hardcoded") — this is
 * read/write parity for that table, not a new mechanism. Owner-only:
 * these thresholds carry real business/compliance weight (GST state
 * code, approval thresholds, escalation values).
 */
export default async function settingsRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner")] };

  app.get("/settings", guard, async (_req, reply) => {
    reply.send(await listSettings());
  });

  app.patch("/settings/:key", guard, async (req, reply) => {
    const params = z.object({ key: z.string().min(1) }).safeParse(req.params);
    const body = z.object({ value: z.any() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await updateSetting(params.data.key, body.data.value, req.auth!.sub);
      reply.send({ updated: true });
    } catch (err) {
      if (err instanceof SettingError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });
}
