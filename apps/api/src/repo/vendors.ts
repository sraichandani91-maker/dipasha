import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface Vendor {
  id: string;
  name: string;
  gstin: string | null;
  gstStateCode: string | null;
  paymentTermsDays: number;
  status: "active" | "inactive";
  defaultMinOrderPackUnits: number | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
}

function mapRow(r: any): Vendor {
  return {
    id: r.id,
    name: r.name,
    gstin: r.gstin,
    gstStateCode: r.gst_state_code,
    paymentTermsDays: r.payment_terms_days,
    status: r.status,
    defaultMinOrderPackUnits: r.default_min_order_pack_units,
    phone: r.phone,
    email: r.email,
    bankName: r.bank_name,
    bankAccountNumber: r.bank_account_number,
    bankIfsc: r.bank_ifsc,
  };
}

export async function listVendors(): Promise<Vendor[]> {
  const { rows } = await requirePool().query(`SELECT * FROM vendors WHERE status = 'active' ORDER BY name`);
  return rows.map(mapRow);
}

export async function getVendor(id: string): Promise<Vendor | null> {
  const { rows } = await requirePool().query(`SELECT * FROM vendors WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createVendor(input: {
  name: string;
  gstin: string | null;
  paymentTermsDays: number;
  createdBy: string;
}): Promise<Vendor> {
  // GSTIN's first two characters are the state code — extracted here so
  // downstream CGST/SGST-vs-IGST logic never has to re-parse it (Section
  // 6.4: "Never ask the user which one applies").
  const gstStateCode = input.gstin ? input.gstin.slice(0, 2) : null;
  const { rows } = await requirePool().query(
    `INSERT INTO vendors (name, gstin, gst_state_code, payment_terms_days, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.gstin, gstStateCode, input.paymentTermsDays, input.createdBy]
  );
  return mapRow(rows[0]);
}

// Section 9A.7: "round the suggested order quantity up to the vendor's
// minimum order pack." One default per vendor, not per product-vendor
// pair — see DECISIONS.md for why.
export async function updateVendorMoq(id: string, defaultMinOrderPackUnits: number | null) {
  await requirePool().query(`UPDATE vendors SET default_min_order_pack_units = $1 WHERE id = $2`, [defaultMinOrderPackUnits, id]);
}

// Owner-requested: nowhere to record a vendor's bank account for
// actually paying them, found by checking a real vendor GST invoice
// against the vendor master's fields.
export async function updateVendorBankDetails(id: string, input: { bankName: string | null; bankAccountNumber: string | null; bankIfsc: string | null }) {
  await requirePool().query(
    `UPDATE vendors SET bank_name = $1, bank_account_number = $2, bank_ifsc = $3 WHERE id = $4`,
    [input.bankName, input.bankAccountNumber, input.bankIfsc, id]
  );
}

// Section 10B.2's PO send needs somewhere to actually send to.
export async function updateVendorContact(id: string, input: { phone: string | null; email: string | null }) {
  await requirePool().query(`UPDATE vendors SET phone = $1, email = $2 WHERE id = $3`, [input.phone, input.email, id]);
}

// --- Section 10B.1's vendor ledger — the payable-side mirror of M7's
// customer ledger (repo/customers.ts), same shape and same "written once
// at record time, never recomputed lazily" reasoning for allocations.
// Every GST purchase invoice is a payable from the day it's entered
// (there's no separate "credit" flag the way a sale needs one — the
// invoice itself, minus whatever's been paid against it, IS the debt);
// non-GST stock_received carries no vendor/value at all, so it never
// enters this ledger.

export class VendorLedgerError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function getVendorBalance(vendorId: string) {
  const db = requirePool();
  const { rows: vendorRows } = await db.query(`SELECT id, name FROM vendors WHERE id = $1`, [vendorId]);
  if (!vendorRows[0]) throw new VendorLedgerError("vendor_not_found");

  const { rows } = await db.query(
    `
    WITH allocations AS (
      SELECT purchase_invoice_id, SUM(amount_allocated) AS allocated FROM vendor_payment_allocations GROUP BY purchase_invoice_id
    ),
    debits AS (
      SELECT purchase_invoice_id, SUM(total_value) AS debited FROM vendor_debit_notes GROUP BY purchase_invoice_id
    )
    SELECT COALESCE(SUM(pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0)), 0)::numeric(14,2) AS balance
    FROM purchase_invoices pi
    LEFT JOIN allocations a ON a.purchase_invoice_id = pi.id
    LEFT JOIN debits d ON d.purchase_invoice_id = pi.id
    WHERE pi.vendor_id = $1 AND (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0)) > 0.005
    `,
    [vendorId]
  );
  return { vendorId, vendorName: vendorRows[0].name, balance: Number(rows[0].balance) };
}

// Bucketed the same way as the customer side (repo/customers.ts's
// getAgeingReport) — by the invoice's own age, not its due date, so the
// two ledgers stay directly comparable on one payables/receivables
// dashboard (M15.3) rather than measuring two different clocks.
export async function getVendorAgeingReport() {
  const { rows } = await requirePool().query(`
    WITH allocations AS (
      SELECT purchase_invoice_id, SUM(amount_allocated) AS allocated FROM vendor_payment_allocations GROUP BY purchase_invoice_id
    ),
    debits AS (
      SELECT purchase_invoice_id, SUM(total_value) AS debited FROM vendor_debit_notes GROUP BY purchase_invoice_id
    ),
    outstanding AS (
      SELECT pi.vendor_id, pi.invoice_date,
        (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0))::numeric(14,2) AS outstanding
      FROM purchase_invoices pi
      LEFT JOIN allocations a ON a.purchase_invoice_id = pi.id
      LEFT JOIN debits d ON d.purchase_invoice_id = pi.id
      WHERE (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0)) > 0.005
    )
    SELECT v.id AS vendor_id, v.name,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.invoice_date <= 30), 0)::numeric(14,2) AS current_bucket,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.invoice_date > 30 AND CURRENT_DATE - o.invoice_date <= 60), 0)::numeric(14,2) AS bucket_30,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.invoice_date > 60 AND CURRENT_DATE - o.invoice_date <= 90), 0)::numeric(14,2) AS bucket_60,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.invoice_date > 90), 0)::numeric(14,2) AS bucket_90_plus,
      COALESCE(SUM(o.outstanding), 0)::numeric(14,2) AS total_outstanding
    FROM vendors v
    JOIN outstanding o ON o.vendor_id = v.id
    GROUP BY v.id, v.name
    HAVING COALESCE(SUM(o.outstanding), 0) > 0.005
    ORDER BY total_outstanding DESC
  `);
  return rows;
}

// Owner Home dashboard's "Due Payments > Distributor" tab — per-vendor
// total outstanding plus the single oldest unpaid invoice (number +
// computed due date), the payable-side mirror of getCustomerDuesList().
// Same allocations/debits CTEs as getVendorBalance, grouped down to one
// row per vendor with the oldest invoice surfaced for display.
export async function getVendorDuesList() {
  const { rows } = await requirePool().query(`
    WITH allocations AS (
      SELECT purchase_invoice_id, SUM(amount_allocated) AS allocated FROM vendor_payment_allocations GROUP BY purchase_invoice_id
    ),
    debits AS (
      SELECT purchase_invoice_id, SUM(total_value) AS debited FROM vendor_debit_notes GROUP BY purchase_invoice_id
    ),
    outstanding AS (
      SELECT pi.vendor_id, pi.invoice_number, pi.invoice_date, pi.payment_terms_days,
        (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0))::numeric(14,2) AS outstanding
      FROM purchase_invoices pi
      LEFT JOIN allocations a ON a.purchase_invoice_id = pi.id
      LEFT JOIN debits d ON d.purchase_invoice_id = pi.id
      WHERE (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0)) > 0.005
    )
    SELECT v.id AS vendor_id, v.name,
      SUM(o.outstanding)::numeric(14,2) AS total_due,
      (array_agg(o.invoice_number ORDER BY o.invoice_date))[1] AS oldest_invoice_number,
      (array_agg(o.invoice_date ORDER BY o.invoice_date))[1] AS oldest_invoice_date,
      (array_agg(o.payment_terms_days ORDER BY o.invoice_date))[1] AS oldest_payment_terms_days
    FROM vendors v
    JOIN outstanding o ON o.vendor_id = v.id
    GROUP BY v.id, v.name
    HAVING SUM(o.outstanding) > 0.005
    ORDER BY total_due DESC
  `);
  return rows.map((r: any) => ({
    vendorId: r.vendor_id,
    name: r.name,
    totalDue: Number(r.total_due),
    oldestInvoiceNumber: r.oldest_invoice_number,
    dueDate: addDays(r.oldest_invoice_date, r.oldest_payment_terms_days),
  }));
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

export interface RecordVendorPaymentInput {
  vendorId: string;
  amount: number;
  paymentMethod: "cash" | "upi" | "card" | "cheque" | "bank_transfer";
  referenceNumber: string | null;
  note: string | null;
  allocateToInvoiceId: string | null; // null = oldest-first
  paidBy: string;
  deviceId: string;
}

export async function recordVendorPayment(input: RecordVendorPaymentInput) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: paymentRows } = await client.query(
      `INSERT INTO vendor_payments (vendor_id, amount, payment_method, reference_number, note, paid_by, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.vendorId, input.amount, input.paymentMethod, input.referenceNumber, input.note, input.paidBy, input.deviceId]
    );
    const paymentId = paymentRows[0].id;

    // Same "chosen invoice first, then oldest-first for the remainder"
    // reasoning as the customer side.
    const { rows: outstandingInvoices } = await client.query(
      `
      WITH allocations AS (SELECT purchase_invoice_id, SUM(amount_allocated) AS allocated FROM vendor_payment_allocations GROUP BY purchase_invoice_id),
      debits AS (SELECT purchase_invoice_id, SUM(total_value) AS debited FROM vendor_debit_notes GROUP BY purchase_invoice_id)
      SELECT pi.id, pi.invoice_date, (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0))::numeric(14,2) AS outstanding
      FROM purchase_invoices pi
      LEFT JOIN allocations a ON a.purchase_invoice_id = pi.id
      LEFT JOIN debits d ON d.purchase_invoice_id = pi.id
      WHERE pi.vendor_id = $1 AND (pi.net_payable_computed - COALESCE(a.allocated, 0) - COALESCE(d.debited, 0)) > 0.005
      ORDER BY (pi.id = $2) DESC NULLS LAST, pi.invoice_date ASC
      `,
      [input.vendorId, input.allocateToInvoiceId]
    );

    let remaining = input.amount;
    for (const inv of outstandingInvoices) {
      if (remaining <= 0.005) break;
      const applied = Math.min(remaining, Number(inv.outstanding));
      await client.query(
        `INSERT INTO vendor_payment_allocations (vendor_payment_id, purchase_invoice_id, amount_allocated) VALUES ($1,$2,$3)`,
        [paymentId, inv.id, round2(applied)]
      );
      remaining -= applied;
    }

    await client.query("COMMIT");
    return { id: paymentId, unallocatedAmount: round2(remaining) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getVendorStatement(vendorId: string, fromDate: string, toDate: string) {
  const db = requirePool();
  const { rows: vendorRows } = await db.query(`SELECT id, name, gstin FROM vendors WHERE id = $1`, [vendorId]);
  if (!vendorRows[0]) throw new VendorLedgerError("vendor_not_found");

  const { rows: invoices } = await db.query(
    `SELECT id, invoice_number, invoice_date, due_date, net_payable_computed
     FROM purchase_invoices WHERE vendor_id = $1 AND invoice_date BETWEEN $2 AND $3 ORDER BY invoice_date`,
    [vendorId, fromDate, toDate]
  );
  const { rows: payments } = await db.query(
    `SELECT id, amount, payment_method, reference_number, created_at FROM vendor_payments
     WHERE vendor_id = $1 AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at`,
    [vendorId, fromDate, toDate]
  );
  const { rows: debitNotes } = await db.query(
    `SELECT id, debit_note_number, purchase_invoice_id, reason_code, total_value, created_at FROM vendor_debit_notes
     WHERE vendor_id = $1 AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at`,
    [vendorId, fromDate, toDate]
  );
  const balance = await getVendorBalance(vendorId);

  return { vendor: vendorRows[0], invoices, payments, debitNotes, currentBalance: balance.balance };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
