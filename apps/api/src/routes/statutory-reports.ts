import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { toCsv } from "../lib/csv.js";
import {
  batchTraceability,
  binCountSheet,
  creditDebitNoteRegister,
  gstr1B2B,
  gstr1B2CLarge,
  gstr1B2CSmall,
  gstr1DocumentSeriesSummary,
  gstr1HsnSummary,
  gstr3bWorking,
  locationWiseInventory,
  negativeStockException,
  nonGstMovementRegister,
  purchaseRegister,
  salesRegister,
} from "../repo/statutory-reports.js";

const dateRangeSchema = z.object({ from: z.string(), to: z.string(), format: z.enum(["json", "csv"]).default("json") });

function send(reply: FastifyReply, filenameStem: string, format: "json" | "csv", rows: Array<Record<string, unknown>>) {
  if (format === "csv") {
    reply.header("Content-Disposition", `attachment; filename="${filenameStem}.csv"`).type("text/csv").send(toCsv(rows));
  } else {
    reply.send(rows);
  }
}

/**
 * Section 10A — every report here is a working file for the owner's
 * accountant, computed on demand from the ledger/sales/purchase tables,
 * never a separately-maintained copy. Restricted to Owner/Store Manager
 * throughout: several of these (sales register, batch traceability)
 * carry customer names and phone numbers, same privacy bar as 9A.1's
 * prescriber/patient rule.
 */
export default async function statutoryReportRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.get("/statutory-reports/sales-register", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "sales-register", q.data.format, await salesRegister(q.data.from, q.data.to));
  });

  app.get("/statutory-reports/purchase-register", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "purchase-register", q.data.format, await purchaseRegister(q.data.from, q.data.to));
  });

  app.get("/statutory-reports/non-gst-movement-register", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "non-gst-movement-register", q.data.format, await nonGstMovementRegister(q.data.from, q.data.to));
  });

  app.get("/statutory-reports/credit-debit-note-register", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "credit-debit-note-register", q.data.format, await creditDebitNoteRegister(q.data.from, q.data.to));
  });

  // GSTR-1 working, all sub-tables in one call — see repo for why B2B and
  // B2C-large are always empty in this build today, honestly, not a bug.
  app.get("/statutory-reports/gstr1", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const [b2b, b2cSmall, b2cLarge, hsnSummary, documentSeriesSummary] = await Promise.all([
      gstr1B2B(q.data.from, q.data.to),
      gstr1B2CSmall(q.data.from, q.data.to),
      gstr1B2CLarge(q.data.from, q.data.to),
      gstr1HsnSummary(q.data.from, q.data.to),
      gstr1DocumentSeriesSummary(q.data.from, q.data.to),
    ]);
    reply.send({
      b2b, b2cSmall, b2cLarge, hsnSummary, documentSeriesSummary,
      disclaimer: "Working for accountant review — not a filing. B2B is empty because no counter sale in this build captures a customer GSTIN; B2C-large is empty because every counter sale here is intra-state.",
    });
  });

  app.get("/statutory-reports/gstr1/hsn-summary", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "gstr1-hsn-summary", q.data.format, await gstr1HsnSummary(q.data.from, q.data.to));
  });

  app.get("/statutory-reports/gstr3b", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await gstr3bWorking(q.data.from, q.data.to));
  });

  app.get("/statutory-reports/batch-traceability", guard, async (req, reply) => {
    const q = z.object({ batchNo: z.string().min(1), productId: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await batchTraceability(q.data.batchNo, q.data.productId));
  });

  app.get("/statutory-reports/location-wise-inventory", guard, async (req, reply) => {
    const q = z.object({ format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "location-wise-inventory", q.data.format, await locationWiseInventory());
  });

  app.get("/statutory-reports/bin-count-sheet", guard, async (req, reply) => {
    const q = z.object({ binIds: z.string().optional(), format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const binIds = q.data.binIds ? q.data.binIds.split(",").filter(Boolean) : undefined;
    send(reply, "bin-count-sheet", q.data.format, await binCountSheet(binIds));
  });

  app.get("/statutory-reports/negative-stock-exception", guard, async (req, reply) => {
    const q = z.object({ format: z.enum(["json", "csv"]).default("json") }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    send(reply, "negative-stock-exception", q.data.format, await negativeStockException());
  });
}
