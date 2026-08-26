import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BinNotFoundError,
  confirmPutaway,
  listPendingPutawayTasks,
  TaskNotPendingError,
  ZoneViolationError,
} from "../repo/putaway.js";

// Section 10.1: web has no scanner, so every put-away confirmation here
// is manual entry with a mandatory reason code — until the Android app
// (still not built, per DECISIONS.md) does a real camera scan and can
// use source: "app" without one.
const WEB_MANUAL_REASON_CODES = ["scanner_unavailable", "remote_correction", "device_failure", "training"] as const;

const confirmSchema = z.object({
  scannedBinCode: z.string().min(1),
  reasonCode: z.enum(WEB_MANUAL_REASON_CODES),
  note: z.string().min(1),
  deviceId: z.string().min(1),
});

export default async function putawayRoutes(app: FastifyInstance) {
  app.get(
    "/putaway-tasks",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (_req, reply) => {
      reply.send(await listPendingPutawayTasks());
    }
  );

  app.post(
    "/putaway-tasks/:id/confirm",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const paramsResult = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!paramsResult.success) return reply.code(400).send({ error: "invalid_id" });
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

      try {
        await confirmPutaway({
          taskId: paramsResult.data.id,
          scannedBinCode: parsed.data.scannedBinCode,
          reasonCode: parsed.data.reasonCode,
          note: parsed.data.note,
          actorUserId: req.auth!.sub,
          deviceId: parsed.data.deviceId,
          source: "web_manual",
        });
        reply.send({ confirmed: true });
      } catch (err) {
        if (err instanceof ZoneViolationError) {
          return reply.code(400).send({ error: "zone_violation", requiredZone: err.requiredZone });
        }
        if (err instanceof BinNotFoundError) {
          return reply.code(404).send({ error: "bin_not_found" });
        }
        if (err instanceof TaskNotPendingError) {
          return reply.code(409).send({ error: "task_not_pending" });
        }
        throw err;
      }
    }
  );
}
