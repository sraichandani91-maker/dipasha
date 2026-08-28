import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export const EXPENSE_CATEGORIES = ["rent", "salaries", "electricity", "transport", "packaging", "delivery_fuel", "software", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const PAYMENT_METHODS = ["cash", "upi", "card", "cheque", "bank_transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// "Bank" is every non-cash instrument — Section 10B.1 asks for "cash book
// and bank book," two books, not five; UPI/card/cheque/bank transfer all
// land in a real bank account, so they share the one non-cash book.
const BANK_METHODS: PaymentMethod[] = ["upi", "card", "cheque", "bank_transfer"];

export interface CreateExpenseInput {
  category: ExpenseCategory;
  amount: number;
  expenseDate: string;
  note: string | null;
  billPhotoPath: string | null;
  paymentMethod: PaymentMethod;
  paidBy: string;
  deviceId: string;
}

// Section 10B.1: "simple head-and-amount entry, dated, with optional
// bill photo." Nothing about expenses needs a movement-ledger row or
// stock effect — this is purely a cash-book/P&L input.
export async function createExpense(input: CreateExpenseInput): Promise<{ id: string }> {
  const { rows } = await requirePool().query(
    `INSERT INTO expense_entries (category, amount, expense_date, note, bill_photo_path, payment_method, paid_by, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [input.category, input.amount, input.expenseDate, input.note, input.billPhotoPath, input.paymentMethod, input.paidBy, input.deviceId]
  );
  return { id: rows[0].id };
}

export async function listExpenses(filter: { from: string; to: string; category?: ExpenseCategory }) {
  const db = requirePool();
  const params: unknown[] = [filter.from, filter.to];
  let categoryClause = "";
  if (filter.category) {
    params.push(filter.category);
    categoryClause = `AND e.category = $3`;
  }
  const { rows } = await db.query(
    `SELECT e.*, u.name AS paid_by_name FROM expense_entries e
     JOIN users u ON u.id = e.paid_by
     WHERE e.expense_date BETWEEN $1 AND $2 ${categoryClause}
     ORDER BY e.expense_date DESC, e.created_at DESC`,
    params
  );
  return rows;
}

// Section 10B.1: "every financial transaction of the day on one screen."
// A flat transaction log for one calendar date — not a balanced total
// (that's the cash/bank book's job below); a purchase invoice entered
// that day appears here too since incurring a payable is a financial
// event, even though no cash moved for it yet.
export async function getDayBook(date: string) {
  const { rows } = await requirePool().query(
    `
    SELECT s.created_at AS occurred_at, 'sale' AS kind, s.bill_number AS description, s.grand_total AS amount, 'in' AS direction, NULL::text AS payment_method
      FROM sales s WHERE s.business_date = $1 AND s.status = 'completed'
    UNION ALL
    SELECT pi.created_at, 'purchase_invoice', pi.invoice_number, pi.net_payable_computed, 'liability', NULL
      FROM purchase_invoices pi WHERE pi.invoice_date = $1
    UNION ALL
    SELECT cp.created_at, 'customer_payment', c.name, cp.amount, 'in', cp.payment_method
      FROM customer_payments cp JOIN customers c ON c.id = cp.customer_id WHERE cp.created_at::date = $1
    UNION ALL
    SELECT vp.created_at, 'vendor_payment', v.name, vp.amount, 'out', vp.payment_method
      FROM vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id WHERE vp.created_at::date = $1
    UNION ALL
    SELECT ee.created_at, 'expense', ee.category, ee.amount, 'out', ee.payment_method
      FROM expense_entries ee WHERE ee.expense_date = $1
    UNION ALL
    SELECT cn.created_at, 'refund', cn.credit_note_number, cn.total_refund_value, 'out', cn.refund_payment_method
      FROM credit_notes cn WHERE cn.created_at::date = $1
    ORDER BY occurred_at
    `,
    [date]
  );
  return rows;
}

interface DailyMovement {
  date: string;
  receipts: number;
  payments: number;
}

async function getMovementsByDay(fromDate: string, toDate: string, methods: PaymentMethod[]): Promise<DailyMovement[]> {
  const { rows } = await requirePool().query(
    `
    WITH movements AS (
      -- A cash tender's own amount is what the customer physically handed
      -- over, not net revenue — sales.change_due (always cash, per
      -- repo/sales.ts's createSale) is real money back out of the
      -- drawer and has to come off here, or every cash sale with change
      -- would overstate what's actually in the till.
      SELECT s.business_date AS txn_date,
             st.amount - CASE WHEN st.tender_type = 'cash' THEN COALESCE(s.change_due, 0) ELSE 0 END AS amount,
             'receipt' AS kind
        FROM sale_tenders st JOIN sales s ON s.id = st.sale_id
        WHERE s.status = 'completed' AND st.tender_type::text = ANY($3::text[]) AND s.business_date BETWEEN $1 AND $2
      UNION ALL
      SELECT cp.created_at::date, cp.amount, 'receipt'
        FROM customer_payments cp WHERE cp.payment_method = ANY($3::text[]) AND cp.created_at::date BETWEEN $1 AND $2
      UNION ALL
      SELECT vp.created_at::date, vp.amount, 'payment'
        FROM vendor_payments vp WHERE vp.payment_method = ANY($3::text[]) AND vp.created_at::date BETWEEN $1 AND $2
      UNION ALL
      SELECT ee.expense_date, ee.amount, 'payment'
        FROM expense_entries ee WHERE ee.payment_method = ANY($3::text[]) AND ee.expense_date BETWEEN $1 AND $2
      UNION ALL
      SELECT cn.created_at::date, cn.total_refund_value, 'payment'
        FROM credit_notes cn WHERE cn.refund_payment_method = ANY($3::text[]) AND cn.created_at::date BETWEEN $1 AND $2
    )
    SELECT txn_date::text AS date,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'receipt'), 0)::numeric(14,2) AS receipts,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0)::numeric(14,2) AS payments
    FROM movements GROUP BY txn_date ORDER BY txn_date
    `,
    [fromDate, toDate, methods]
  );
  return rows.map((r: any) => ({ date: r.date, receipts: Number(r.receipts), payments: Number(r.payments) }));
}

async function getMovementsBefore(date: string, methods: PaymentMethod[]): Promise<number> {
  const { rows } = await requirePool().query(
    `
    WITH movements AS (
      -- Same change_due netting as getMovementsByDay above.
      SELECT st.amount - CASE WHEN st.tender_type = 'cash' THEN COALESCE(s.change_due, 0) ELSE 0 END AS amount,
             'receipt' AS kind
        FROM sale_tenders st JOIN sales s ON s.id = st.sale_id
        WHERE s.status = 'completed' AND st.tender_type::text = ANY($2::text[]) AND s.business_date < $1
      UNION ALL
      SELECT cp.amount, 'receipt' FROM customer_payments cp WHERE cp.payment_method = ANY($2::text[]) AND cp.created_at::date < $1
      UNION ALL
      SELECT vp.amount, 'payment' FROM vendor_payments vp WHERE vp.payment_method = ANY($2::text[]) AND vp.created_at::date < $1
      UNION ALL
      SELECT ee.amount, 'payment' FROM expense_entries ee WHERE ee.payment_method = ANY($2::text[]) AND ee.expense_date < $1
      UNION ALL
      SELECT cn.total_refund_value, 'payment' FROM credit_notes cn WHERE cn.refund_payment_method = ANY($2::text[]) AND cn.created_at::date < $1
    )
    SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'receipt'), 0) - COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS net
    FROM movements
    `,
    [date, methods]
  );
  return Number(rows[0].net);
}

export interface CashBankBookDay {
  date: string;
  opening: number;
  receipts: number;
  payments: number;
  closing: number;
}

/**
 * Section 10B.1: "cash book and bank book: opening, receipts, payments,
 * closing, per day, per account." No opening-balance entry mechanism
 * exists anywhere in this build (this isn't double-entry accounting with
 * a capital account) — so "opening" for any given day is the cumulative
 * net movement of every transaction strictly before it, all the way back
 * to go-live, the same "let it accumulate, never a stated starting
 * figure" choice the customer/vendor running balances already make.
 */
export async function getCashOrBankBook(account: "cash" | "bank", fromDate: string, toDate: string): Promise<{ days: CashBankBookDay[]; openingBalance: number; closingBalance: number }> {
  const methods: PaymentMethod[] = account === "cash" ? ["cash"] : BANK_METHODS;
  const openingBalance = await getMovementsBefore(fromDate, methods);
  const byDay = await getMovementsByDay(fromDate, toDate, methods);

  const days: CashBankBookDay[] = [];
  let running = openingBalance;
  const byDayMap = new Map(byDay.map((d) => [d.date, d]));

  for (let d = new Date(fromDate + "T00:00:00Z"); d <= new Date(toDate + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const m = byDayMap.get(dateStr) ?? { date: dateStr, receipts: 0, payments: 0 };
    const opening = running;
    const closing = round2(opening + m.receipts - m.payments);
    days.push({ date: dateStr, opening: round2(opening), receipts: m.receipts, payments: m.payments, closing });
    running = closing;
  }

  return { days, openingBalance: round2(openingBalance), closingBalance: round2(running) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
