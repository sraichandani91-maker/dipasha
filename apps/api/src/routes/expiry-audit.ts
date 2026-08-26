import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ExpiryAuditError, getExpiryAudit, moveBatchToQuarantine } from "../repo/expiry-audit.js";

export default async function expiryAuditRoutes(app: FastifyInstance) {
  app.get(
    "/expiry-audit",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await getExpiryAudit());
    }
  );

  app.post(
    "/expiry-audit/:batchId/move-to-quarantine",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ batchId: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ deviceId: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const result = await moveBatchToQuarantine(params.data.batchId, req.auth!.sub, body.data.deviceId);
        reply.send(result);
      } catch (err) {
        if (err instanceof ExpiryAuditError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );
}
