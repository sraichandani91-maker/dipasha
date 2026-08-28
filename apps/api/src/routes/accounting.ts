import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { saveUploadedPhoto, UploadError } from "../lib/uploads.js";
import { sendCsvAttachment } from "../lib/csv.js";
import { createExpense, EXPENSE_CATEGORIES, getCashOrBankBook, getDayBook, listExpenses, PAYMENT_METHODS } from "../repo/accounting.js";
import { buildTallyVouchers } from "../repo/tally-export.js";

const formatSchema = z.enum(["json", "csv"]).default("json");

const createExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.coerce.number().positive(),
  expenseDate: z.string(),
  note: z.string().nullable().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  deviceId: z.string().min(1),
});

/**
 * Section 10B.1 — expenses, the day-book, and the cash/bank book. Same
 * financial-data bar as the vendor/customer ledgers: Owner/store_manager
 * only.
 */
export default async function accountingRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  // multipart because of the optional bill photo — same pattern as
  // write-offs (routes/write-offs.ts); reuses that route's existing
  // `GET /uploads/:filename` for read-back, not a second endpoint.
  app.post("/expenses", guard, async (req, reply) => {
    const fields: Record<string, string> = {};
    let billPhotoPath: string | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "photo") {
          part.file.resume();
          continue;
        }
        try {
          billPhotoPath = await saveUploadedPhoto(part);
        } catch (err) {
          if (err instanceof UploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const parsed = createExpenseSchema.safeParse(fields);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    const result = await createExpense({
      category: b.category,
      amount: b.amount,
      expenseDate: b.expenseDate,
      note: b.note ?? null,
      billPhotoPath,
      paymentMethod: b.paymentMethod,
      paidBy: req.auth!.sub,
      deviceId: b.deviceId,
    });
    reply.code(201).send(result);
  });

  app.get("/expenses", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string(), category: z.enum(EXPENSE_CATEGORIES).optional(), format: formatSchema }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const rows = await listExpenses(q.data);
    if (q.data.format === "csv") return sendCsvAttachment(reply, "expenses", rows);
    reply.send(rows);
  });

  app.get("/accounting/day-book", guard, async (req, reply) => {
    const q = z.object({ date: z.string(), format: formatSchema }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const rows = await getDayBook(q.data.date);
    if (q.data.format === "csv") return sendCsvAttachment(reply, `day-book-${q.data.date}`, rows);
    reply.send(rows);
  });

  app.get("/accounting/cash-book", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string(), format: formatSchema }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const result = await getCashOrBankBook("cash", q.data.from, q.data.to);
    if (q.data.format === "csv") return sendCsvAttachment(reply, "cash-book", result.days as any);
    reply.send(result);
  });

  app.get("/accounting/bank-book", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string(), format: formatSchema }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const result = await getCashOrBankBook("bank", q.data.from, q.data.to);
    if (q.data.format === "csv") return sendCsvAttachment(reply, "bank-book", result.days as any);
    reply.send(result);
  });

  // Section 10B.1's Tally-compatible export — always a CSV download,
  // never a JSON option, since nothing in the console would ever want to
  // render "Tally voucher rows" as a screen.
  app.get("/accounting/tally-export", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const rows = await buildTallyVouchers(q.data.from, q.data.to);
    sendCsvAttachment(reply, `tally-export-${q.data.from}-to-${q.data.to}`, rows as any);
  });
}
