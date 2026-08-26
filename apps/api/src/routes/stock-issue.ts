import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createStockIssue, InsufficientStockForIssueError } from "../repo/stock-issue.js";

const REASON_CODES = ["sample_given", "doctor_sample", "staff_use", "promotional", "transfer_out", "replacement_given", "other"] as const;

const stockIssueSchema = z.object({
  productId: z.string().uuid(),
  quantityBaseUnits: z.number().int().positive(),
  reasonCode: z.enum(REASON_CODES),
  note: z.string().min(1),
  recipientName: z.string().nullable().optional(),
  manualBatchId: z.string().uuid().nullable().optional(),
  manualBatchOverrideReason: z.string().nullable().optional(),
  deviceId: z.string().min(1),
});

export default async function stockIssueRoutes(app: FastifyInstance) {
  app.post(
    "/stock-movements/stock-issue",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = stockIssueSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const body = parsed.data;

      try {
        const result = await createStockIssue({
          ...body,
          recipientName: body.recipientName ?? null,
          manualBatchId: body.manualBatchId ?? null,
          manualBatchOverrideReason: body.manualBatchOverrideReason ?? null,
          createdBy: req.auth!.sub,
          source: "web",
        });
        reply.code(201).send(result);
      } catch (err) {
        if (err instanceof InsufficientStockForIssueError) {
          return reply.code(409).send({ error: "insufficient_stock", available: err.available, requested: err.requested });
        }
        throw err;
      }
    }
  );
}
