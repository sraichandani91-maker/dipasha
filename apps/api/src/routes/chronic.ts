import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createChronicMedication,
  updateChronicMedication,
  markChronicNotified,
  listRefillDue,
  getPatientProfile,
  sendReminderNow,
  ChronicError,
} from "../repo/chronic.js";

const createSchema = z.object({
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
  prescriberId: z.string().uuid().nullable().optional(),
  dailyDoseBaseUnits: z.number().positive(),
  standingOrderEnabled: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

const updateSchema = z.object({
  prescriberId: z.string().uuid().nullable().optional(),
  dailyDoseBaseUnits: z.number().positive().optional(),
  standingOrderEnabled: z.boolean().optional(),
  status: z.enum(["active", "paused", "stopped"]).optional(),
  note: z.string().nullable().optional(),
});

/**
 * Section 9A.3 — chronic patients and refill management. Privacy: this
 * links a customer to specific medications, the same patient-identifying
 * character Section 9A.1 flags for prescriber data — every route here is
 * Owner/store_manager only, matching that existing bar.
 */
export default async function chronicRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.post("/chronic-medications", guard, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    try {
      const result = await createChronicMedication({
        customerId: b.customerId,
        productId: b.productId,
        prescriberId: b.prescriberId ?? null,
        dailyDoseBaseUnits: b.dailyDoseBaseUnits,
        standingOrderEnabled: b.standingOrderEnabled ?? false,
        note: b.note ?? null,
        createdBy: req.auth!.sub,
      });
      reply.code(201).send(result);
    } catch (err) {
      if (err instanceof ChronicError && err.code === "already_flagged") {
        return reply.code(409).send({ error: "already_flagged", message: "This customer already has a chronic flag for this item." });
      }
      throw err;
    }
  });

  app.patch("/chronic-medications/:id", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    try {
      await updateChronicMedication(params.data.id, parsed.data);
      reply.send({ id: params.data.id, updated: true });
    } catch (err) {
      if (err instanceof ChronicError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  app.post("/chronic-medications/:id/mark-notified", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      await markChronicNotified(params.data.id);
      reply.send({ notified: true });
    } catch (err) {
      if (err instanceof ChronicError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  // Section 9A.3: "who is due in the next 7 days, who is overdue and by
  // how many days... the highest-return report in the whole system."
  app.get("/chronic-medications/refill-due", guard, async (_req, reply) => {
    reply.send(await listRefillDue());
  });

  app.post("/chronic-medications/:id/send-reminder-now", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      await sendReminderNow(params.data.id, req.log);
      reply.send({ sent: true });
    } catch (err) {
      if (err instanceof ChronicError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });

  // Section 9A.3's patient profile: current chronic medications,
  // prescriber, last purchase dates, and the real purchase history each
  // pairing was computed from.
  app.get("/customers/:id/chronic-medications", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send(await getPatientProfile(params.data.id));
  });
}
