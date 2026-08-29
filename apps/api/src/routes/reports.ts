import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scheduleHRegister, computeDailySummary, getTodayBusinessDate, listDailyReports, getItemLedgerReport } from "../repo/reports.js";
import { listManualOverrides } from "../repo/manual-overrides.js";
import { runReadOnlyQuery, SqlConsoleError } from "../repo/sql-console.js";
import { sendCsvAttachment } from "../lib/csv.js";

// Section 9A.1 privacy note: prescriber/patient reporting restricted to
// Owner and Store Manager — this links patients to prescriptions.
export default async function reportRoutes(app: FastifyInstance) {
  app.get(
    "/reports/schedule-h-register",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query", details: "from and to (YYYY-MM-DD) required" });
      reply.send(await scheduleHRegister(q.data.from, q.data.to));
    }
  );

  // Section 10.1: "Surface every web_manual row on a dedicated Manual
  // Override report." Owner/Store Manager — same bar as every other
  // report in this build, not the Owner-only default 10.1 describes for
  // *performing* the underlying actions, which stays open to whichever
  // role actually does that work today (see DECISIONS.md — no separate
  // scanning client exists yet, so gating put-away/pick/pack/handover/
  // cycle-count-entry to Owner-only would break real operations).
  app.get(
    "/reports/manual-overrides",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await listManualOverrides());
    }
  );

  // Section 10.2: prebuilt dashboard — "today," computed live.
  app.get(
    "/reports/dashboard",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await computeDailySummary(await getTodayBusinessDate()));
    }
  );

  // Owner-requested, post-M16: "sales, purchase, and closing stock at
  // item level for a date range" — the report first asked about back in
  // M7 as a "reorder book" and deferred here, now built.
  app.get(
    "/reports/item-ledger",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const q = z.object({ from: z.string(), to: z.string(), format: z.enum(["json", "csv"]).optional() }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query", details: "from and to (YYYY-MM-DD) required" });
      const rows = await getItemLedgerReport(q.data.from, q.data.to);
      if (q.data.format === "csv") {
        return sendCsvAttachment(reply, `item-ledger-${q.data.from}-to-${q.data.to}`, rows as unknown as Array<Record<string, unknown>>);
      }
      reply.send(rows);
    }
  );

  app.get(
    "/reports/daily-reports",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (_req, reply) => {
      reply.send(await listDailyReports());
    }
  );

  // Section 10.2's SQL console — Owner only, distinct (higher) bar than
  // every other report in this file: this is raw database access, even
  // though it's read-only.
  app.post(
    "/reports/sql-console",
    { preHandler: [app.authenticate, app.requireRole("owner")] },
    async (req, reply) => {
      const body = z.object({ query: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        reply.send(await runReadOnlyQuery(body.data.query));
      } catch (err) {
        if (err instanceof SqlConsoleError) return reply.code(400).send({ error: err.code, detail: err.detail });
        throw err;
      }
    }
  );
}
