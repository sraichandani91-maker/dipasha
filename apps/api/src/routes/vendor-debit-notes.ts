import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
    createVendorDebitNote,
    getVendorDebitNoteDetail,
    listVendorDebitNotes,
    VendorDebitNoteError,
    VENDOR_DEBIT_NOTE_REASON_CODES,
} from "../repo/vendor-debit-notes.js";

const createSchema = z.object({
    purchaseInvoiceId: z.string().uuid(),
    reasonCode: z.enum(VENDOR_DEBIT_NOTE_REASON_CODES),
    note: z.string().min(1),
    lines: z
      .array(
              z.object({
                        purchaseInvoiceLineId: z.string().uuid(),
                        quantityBaseUnits: z.number().int().positive(),
                        binId: z.string().uuid(),
              })
            )
      .min(1),
    deviceId: z.string().min(1),
});

// Return-to-vendor (Section 6.4's "CR/DR NOTE" bill line, previously
// nowhere to land) — Owner/store_manager only, same bar as recording the
// purchase invoice itself since this reverses real stock and real payable.
export default async function vendorDebitNoteRoutes(app: FastifyInstance) {
    const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.post("/vendor-debit-notes", guard, async (req, reply) => {
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
        const body = parsed.data;
        try {
                const result = await createVendorDebitNote({
                          purchaseInvoiceId: body.purchaseInvoiceId,
                          reasonCode: body.reasonCode,
                          note: body.note,
                          lines: body.lines,
                          deviceId: body.deviceId,
                          createdBy: req.auth!.sub,
                });
                reply.code(201).send(result);
        } catch (err) {
                if (err instanceof VendorDebitNoteError) return reply.code(409).send({ error: err.code, details: err.details });
                throw err;
        }
  });

  app.get("/vendor-debit-notes", guard, async (req, reply) => {
        const q = z.object({ vendorId: z.string().uuid().optional() }).safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: "invalid_query" });
        reply.send(await listVendorDebitNotes(q.data.vendorId));
  });

  app.get("/vendor-debit-notes/:id", guard, async (req, reply) => {
        const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "invalid_id" });
        const detail = await getVendorDebitNoteDetail(params.data.id);
        if (!detail) return reply.code(404).send({ error: "not_found" });
        reply.send(detail);
  });
}
