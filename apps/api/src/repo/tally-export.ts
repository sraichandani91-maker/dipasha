import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

/**
 * Section 10B.1: "a Tally-compatible export (XML or the standard CSV
 * import format) for sales, purchases, payments, receipts and expenses."
 * CSV, not XML — Tally's own Voucher-import-via-CSV wizard accepts
 * exactly these columns (date/voucher type/voucher number/party
 * ledger/amount/narration) and lets the accountant map them on import;
 * hand-rolling Tally's XML voucher schema with no real Tally instance to
 * validate against risks shipping a file that *looks* right and quietly
 * fails to import, which is worse than the honest, verifiable CSV path
 * (see DECISIONS.md).
 */
export interface TallyVoucherRow {
  date: string;
  voucherType: "Sales" | "Purchase" | "Receipt" | "Payment";
  voucherNumber: string;
  partyLedger: string;
  amount: number;
  narration: string;
}

export async function buildTallyVouchers(fromDate: string, toDate: string): Promise<TallyVoucherRow[]> {
  const db = requirePool();

  const [sales, purchases, customerPayments, vendorPayments, expenses] = await Promise.all([
    db.query(
      `SELECT s.business_date AS date, s.bill_number, COALESCE(c.name, s.customer_name, 'Cash sale') AS party, s.grand_total AS amount
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2 ORDER BY s.business_date, s.bill_number`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT pi.invoice_date AS date, pi.invoice_number, v.name AS party, pi.net_payable_computed AS amount
       FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
       WHERE pi.invoice_date BETWEEN $1 AND $2 ORDER BY pi.invoice_date, pi.invoice_number`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT cp.created_at::date AS date, cp.id, c.name AS party, cp.amount
       FROM customer_payments cp JOIN customers c ON c.id = cp.customer_id
       WHERE cp.created_at::date BETWEEN $1 AND $2 ORDER BY cp.created_at`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT vp.created_at::date AS date, vp.id, v.name AS party, vp.amount
       FROM vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id
       WHERE vp.created_at::date BETWEEN $1 AND $2 ORDER BY vp.created_at`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT expense_date AS date, id, category, amount FROM expense_entries
       WHERE expense_date BETWEEN $1 AND $2 ORDER BY expense_date`,
      [fromDate, toDate]
    ),
  ]);

  const rows: TallyVoucherRow[] = [];
  for (const r of sales.rows) {
    rows.push({ date: r.date, voucherType: "Sales", voucherNumber: r.bill_number, partyLedger: r.party, amount: Number(r.amount), narration: `Sale ${r.bill_number}` });
  }
  for (const r of purchases.rows) {
    rows.push({ date: r.date, voucherType: "Purchase", voucherNumber: r.invoice_number, partyLedger: r.party, amount: Number(r.amount), narration: `Purchase invoice ${r.invoice_number}` });
  }
  for (const r of customerPayments.rows) {
    rows.push({ date: r.date, voucherType: "Receipt", voucherNumber: r.id, partyLedger: r.party, amount: Number(r.amount), narration: `Payment received from ${r.party}` });
  }
  for (const r of vendorPayments.rows) {
    rows.push({ date: r.date, voucherType: "Payment", voucherNumber: r.id, partyLedger: r.party, amount: Number(r.amount), narration: `Payment made to ${r.party}` });
  }
  for (const r of expenses.rows) {
    rows.push({ date: r.date, voucherType: "Payment", voucherNumber: r.id, partyLedger: `Expense: ${r.category}`, amount: Number(r.amount), narration: `Expense — ${r.category}` });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}
