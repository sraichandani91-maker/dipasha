import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBin, getBinsByIds, listBins, updateBin } from "../repo/bins.js";
import { buildBinLabelSheetPdf } from "../domain/label-sheet.js";

const ZONES = ["CC", "SH", "RX", "IN", "QC", "PK", "FM"] as const;

// Regular: A-03-B-2 (aisle-bay-shelf-position). Special zone: CC-01 etc.
const REGULAR_CODE = /^[A-Z]+-\d{2}-[A-Z]-\d+$/;
const ZONE_CODE = /^(CC|SH|RX|IN|QC|PK|FM)-\d{2,}$/;

const createBinSchema = z.object({
  code: z.string().refine((c) => REGULAR_CODE.test(c) || ZONE_CODE.test(c), {
    message: "code must match A-03-B-2 (regular) or CC-01 (zone) format",
  }),
  zone: z.enum(ZONES).nullable().optional(),
  aisle: z.string().nullable().optional(),
  bay: z.string().nullable().optional(),
  shelfLevel: z.string().nullable().optional(),
  position: z.number().int().nullable().optional(),
  restricted: z.boolean().optional(),
});

const updateBinSchema = z.object({
  code: z.string().optional(),
  capacityScore: z.number().optional(),
  pickFrequencyRank: z.number().int().optional(),
  restricted: z.boolean().optional(),
  status: z.enum(["active", "retired"]).optional(),
});

export default async function binRoutes(app: FastifyInstance) {
  app.get("/bins", { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as { status?: string; zone?: string };
    reply.send(await listBins({ status: q.status, zone: q.zone }));
  });

  app.post(
    "/bins",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const parsed = createBinSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      const b = parsed.data;
      // Cold-chain and Schedule H1 zone rules are enforced at put-away
      // time (Section 6.6, M3) — bin creation itself just needs a valid
      // code and, for SH-*, restricted defaults on.
      const restricted = b.restricted ?? b.zone === "SH";
      const created = await createBin({
        code: b.code,
        zone: b.zone ?? null,
        aisle: b.aisle ?? null,
        bay: b.bay ?? null,
        shelfLevel: b.shelfLevel ?? null,
        position: b.position ?? null,
        restricted,
      });
      reply.code(201).send(created);
    }
  );

  app.patch(
    "/bins/:id",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const paramsResult = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!paramsResult.success) return reply.code(400).send({ error: "invalid_id" });
      const parsed = updateBinSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

      const updated = await updateBin(paramsResult.data.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: "not_found_or_no_changes" });
      reply.send({ id: paramsResult.data.id, updated: true });
    }
  );

  // Printable A4 label sheet (Section 4). ?ids=uuid,uuid or ?zone=CC or
  // omit both for every active bin.
  app.get("/bins/label-sheet", { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as { ids?: string; zone?: string };
    const bins = q.ids ? await getBinsByIds(q.ids.split(",").filter(Boolean)) : await listBins({ status: "active", zone: q.zone });

    if (bins.length === 0) return reply.code(404).send({ error: "no_bins_matched" });

    const pdfBytes = await buildBinLabelSheetPdf(bins);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="bin-labels.pdf"`)
      .send(Buffer.from(pdfBytes));
  });
}
