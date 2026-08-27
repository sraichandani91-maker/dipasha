import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BinNotFoundError,
  confirmPutaway,
  listPendingPutawayTasks,
  TaskNotPendingError,
  ZoneViolationError,
  VarianceReasonRequiredError,
  listPutawayVariances,
  resolvePutawayVariance,
  VarianceNotFoundError,
  VarianceAlreadyResolvedError,
} from "../repo/putaway.js";

// Section 10.1: web has no scanner, so every put-away confirmation here
// is manual entry with a mandatory reason code — until the Android app
// (still not built, per DECISIONS.md) does a real camera scan and can
// use source: "app" without one.
const WEB_MANUAL_REASON_CODES = ["scanner_unavailable", "remote_correction", "device_failure", "training"] as const;

// Section 6.6 / M13.7: distinct from the web-manual reason above — this
// one explains why the physical count differs from what was invoiced or
// entered, not why the confirmation happened without a scanner.
const VARIANCE_REASON_CODES = ["short_received", "excess_received", "damaged_in_transit", "miscount_at_entry", "other"] as const;

const confirmSchema = z.object({
  scannedBinCode: z.string().min(1),
  reasonCode: z.enum(WEB_MANUAL_REASON_CODES),
  note: z.string().min(1),
  deviceId: z.string().min(1),
  actualQuantityFound: z.number().int().min(0).optional(),
  varianceReasonCode: z.enum(VARIANCE_REASON_CODES).optional(),
  varianceNote: z.string().min(1).optional(),
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
        const result = await confirmPutaway({
          taskId: paramsResult.data.id,
          scannedBinCode: parsed.data.scannedBinCode,
          reasonCode: parsed.data.reasonCode,
          note: parsed.data.note,
          actorUserId: req.auth!.sub,
          deviceId: parsed.data.deviceId,
          source: "web_manual",
          actualQuantityFound: parsed.data.actualQuantityFound,
          varianceReasonCode: parsed.data.varianceReasonCode,
          varianceNote: parsed.data.varianceNote,
        });
        reply.send({ confirmed: true, varianceId: result.varianceId });
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
        if (err instanceof VarianceReasonRequiredError) {
          return reply.code(400).send({ error: "variance_reason_required" });
        }
        throw err;
      }
    }
  );

  const varianceGuard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/putaway-variances", varianceGuard, async (req, reply) => {
    const query = z.object({ status: z.enum(["open", "resolved"]).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listPutawayVariances(query.data.status));
  });

  app.post("/putaway-variances/:id/resolve", varianceGuard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ resolutionNote: z.string().min(1) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await resolvePutawayVariance(params.data.id, body.data.resolutionNote, req.auth!.sub);
      reply.send({ resolved: true });
    } catch (err) {
      if (err instanceof VarianceNotFoundError) return reply.code(404).send({ error: "not_found" });
      if (err instanceof VarianceAlreadyResolvedError) return reply.code(409).send({ error: "already_resolved" });
      throw err;
    }
  });
}
