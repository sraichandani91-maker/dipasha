import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cancelSale, CancelSaleError, createCreditNote, ReturnValidationError } from "../repo/returns.js";

const creditNoteSchema = z.object({
    originalSaleId: z.string().uuid(),
    reason: z.string().min(1),
    lines: z.array(z.object({
          saleLineId: z.string().uuid(),
          quantityReturned: z.number().int().positive(),
          condition: z.enum(["good", "damaged"]),
    })).min(1),
    refundPaymentMethod: z.enum(["cash", "upi", "card", "cheque", "bank_transfer"]).nullable().optional(),
    deviceId: z.string().min(1),
});

const cancelSchema = z.object({ reason: z.string().min(1), deviceId: z.string().min(1) });

export default async function returnsRoutes(app: FastifyInstance) {
    app.post(
          "/credit-notes",
      { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
          async (req, reply) => {
                  const parsed = creditNoteSchema.safeParse(req.body);
                  if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
                  try {
                            const result = await createCreditNote({
                                        originalSaleId: parsed.data.originalSaleId,
                                        reason: parsed.data.reason,
                                        lines: parsed.data.lines,
                                        refundPaymentMethod: parsed.data.refundPaymentMethod ?? null,
                                        deviceId: parsed.data.deviceId,
                                        createdBy: req.auth!.sub,
                                        source: "web",
                            });
                            reply.code(201).send(result);
                  } catch (err) {
                            if (err instanceof ReturnValidationError) return reply.code(409).send({ error: err.code, details: err.details });
                            throw err;
                  }
          }
        );

  app.post(
        "/sales/:id/cancel",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
        async (req, reply) => {
                const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
                if (!params.success) return reply.code(400).send({ error: "invalid_id" });
                const parsed = cancelSchema.safeParse(req.body);
                if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

          try {
                    await cancelSale(params.data.id, parsed.data.reason, req.auth!.sub, parsed.data.deviceId, "web");
                    reply.send({ cancelled: true });
          } catch (err) {
                    if (err instanceof CancelSaleError) return reply.code(409).send({ error: err.code });
                    throw err;
          }
        }
      );
}
