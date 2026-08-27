import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assignTask,
  CycleCountError,
  generateDailyCycleCountTasks,
  getBinCountHistory,
  getCurrentBusinessDate,
  getTaskForCounting,
  listTasksForDate,
  reviewTask,
  submitCount,
} from "../repo/cycle-counts.js";
import { WEB_MANUAL_REASON_CODES } from "../repo/manual-overrides.js";

/**
 * Section 9 cycle counting: daily blind count of N bins, dual-entry
 * quantity capture (web has no scanner — Section 10.1's manual-entry
 * rule applies the same way put-away's does), variance auto-escalation.
 */
export default async function cycleCountRoutes(app: FastifyInstance) {
  app.post(
    "/cycle-counts/generate-today",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const body = z.object({ deviceId: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const businessDate = await getCurrentBusinessDate();
      const result = await generateDailyCycleCountTasks(businessDate, req.auth!.sub, body.data.deviceId);
      reply.code(201).send(result);
    }
  );

  app.get("/cycle-counts/today", { preHandler: app.authenticate }, async (_req, reply) => {
    const businessDate = await getCurrentBusinessDate();
    reply.send(await listTasksForDate(businessDate));
  });

  app.patch(
    "/cycle-counts/:id/assign",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ assignedTo: z.string().uuid() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      await assignTask(params.data.id, body.data.assignedTo);
      reply.send({ assigned: true });
    }
  );

  // Blind — deliberately no system quantity anywhere in this response.
  app.get("/cycle-counts/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const result = await getTaskForCounting(params.data.id);
    if (!result) return reply.code(404).send({ error: "not_found" });
    reply.send(result);
  });

  const submitSchema = z.object({
    counts: z.array(z.object({ lineId: z.string().uuid(), countedQuantityBaseUnits: z.number().int().min(0) })),
    extraFinds: z
      .array(
        z.object({
          productId: z.string().uuid(),
          batchNo: z.string().min(1),
          countedQuantityBaseUnits: z.number().int().positive(),
          note: z.string().nullable().optional(),
        })
      )
      .default([]),
    scannedBinCode: z.string().min(1),
    reasonCode: z.enum(WEB_MANUAL_REASON_CODES),
    note: z.string().min(1),
  });
  app.post("/cycle-counts/:id/submit", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = submitSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body", details: body.success ? undefined : body.error.flatten() });
    try {
      const result = await submitCount({
        taskId: params.data.id,
        counts: body.data.counts,
        extraFinds: body.data.extraFinds.map((e) => ({ ...e, note: e.note ?? null })),
        countedBy: req.auth!.sub,
        scannedBinCode: body.data.scannedBinCode,
        reasonCode: body.data.reasonCode,
        note: body.data.note,
      });
      reply.send(result);
    } catch (err) {
      if (err instanceof CycleCountError) return reply.code(409).send({ error: err.code });
      throw err;
    }
  });

  const reviewSchema = z.object({
    outcome: z.enum(["approved", "rejected"]),
    note: z.string().nullable().optional(),
    deviceId: z.string().min(1),
  });
  app.post(
    "/cycle-counts/:id/review",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = reviewSchema.safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await reviewTask({
          taskId: params.data.id,
          outcome: body.data.outcome,
          reviewedBy: req.auth!.sub,
          note: body.data.note ?? null,
          deviceId: body.data.deviceId,
        });
        reply.send({ reviewed: true });
      } catch (err) {
        if (err instanceof CycleCountError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  app.get("/bins/:id/cycle-count-history", { preHandler: app.authenticate }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    reply.send(await getBinCountHistory(params.data.id));
  });
}
