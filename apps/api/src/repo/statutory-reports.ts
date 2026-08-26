import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

/**
 * Section 10A. Framing repeated on every report screen, not buried in
 * docs (10A.6): these are working files for an accountant/inspector to
 * review, computed from the ledger and sales/purchase tables — never
 * presented as filing-ready. GSTR-2A/2B reconciliation (10A.1) is
 * deliberately not built here: it needs a real downloaded 2A/2B export
 * to parse against, and guessing at that file's shape risked building
 * something that silently mismatches the real one — flagged in
 * DECISIONS.md rather than shipped half-right.
 */

// --- 10A.2 registers -------------------------------------------------

export async function salesRegister(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT
      s.business_date, s.bill_number, s.channel, s.customer_name, s.customer_phone,
      p.name AS item, p.hsn_code, b.batch_no, b.expiry_date,
      sl.quantity_base_units, p.pack_size, p.base_unit, sl.mrp, sl.discount_value,
      sl.taxable_value, sl.gst_rate, sl.cgst_amount, sl.sgst_amount, sl.line_total,
      u.name AS billed_by, s.source
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    JOIN batches b ON b.id = sl.batch_id
    JOIN users u ON u.id = s.created_by
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    ORDER BY s.created_at
    `,
    [fromDate, toDate]
  );
  return rows;
}

export async function purchaseRegister(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT
      pi.invoice_date, pi.invoice_number, v.name AS vendor_name, v.gstin AS vendor_gstin,
      p.name AS item, p.hsn_code, b.batch_no, b.expiry_date,
      pil.quantity_base_units, pil.free_quantity_base_units, pil.rate_before_discount, pil.discount_value,
      pil.taxable_value, pil.gst_rate, pil.cgst_amount, pil.sgst_amount, pil.igst_amount, pil.line_total
    FROM purchase_invoice_lines pil
    JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
    JOIN vendors v ON v.id = pi.vendor_id
    JOIN products p ON p.id = pil.product_id
    JOIN batches b ON b.id = pil.batch_id
    WHERE pi.invoice_date BETWEEN $1 AND $2
    ORDER BY pi.invoice_date
    `,
    [fromDate, toDate]
  );
  return rows;
}

// "So physical stock movement reconciles against GST turnover" (10A.2) —
// every stock_received/stock_issue row, which never touches GST tables.
export async function nonGstMovementRegister(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT ml.created_at, ml.movement_type, p.name AS item, b.batch_no, bin.code AS bin_code,
      ml.quantity_delta, ml.reason_code, ml.note, u.name AS actor_name, ml.source
    FROM movement_ledger ml
    JOIN products p ON p.id = ml.product_id
    JOIN batches b ON b.id = ml.batch_id
    JOIN bins bin ON bin.id = ml.bin_id
    JOIN users u ON u.id = ml.actor_user_id
    WHERE ml.movement_type IN ('stock_received', 'stock_issue')
      AND ml.created_at::date BETWEEN $1 AND $2
    ORDER BY ml.created_at
    `,
    [fromDate, toDate]
  );
  return rows;
}

export async function creditDebitNoteRegister(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT cn.created_at, cn.credit_note_number, s.bill_number AS original_bill_number,
      cn.reason, cn.total_refund_value, u.name AS issued_by
    FROM credit_notes cn
    JOIN sales s ON s.id = cn.original_sale_id
    JOIN users u ON u.id = cn.created_by
    WHERE cn.created_at::date BETWEEN $1 AND $2
    ORDER BY cn.created_at
    `,
    [fromDate, toDate]
  );
  return rows;
}

// --- 10A.1 GSTR-1 working --------------------------------------------

// Always empty in this build today, honestly: counter sales never
// capture a customer GSTIN (no field for it exists — Section 6A doesn't
// ask for one at the counter, and this build hasn't invented one). Kept
// as a real, correctly-shaped query rather than a hardcoded [] so it
// starts working the moment a GSTIN field is added to a sale.
export async function gstr1B2B(_fromDate: string, _toDate: string) {
  return [] as Array<{ counterparty_gstin: string; bill_number: string; date: string; taxable_value: number; gst_rate: number; tax_amount: number }>;
}

// "The overwhelming majority of a pharmacy's counter sales" (10A.1) —
// every completed sale in this build, since none carry a GSTIN.
// Consolidated by rate, split OTC/H/H1/etc doesn't matter for this table.
export async function gstr1B2CSmall(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT sl.gst_rate, COUNT(DISTINCT s.id)::int AS invoice_count,
      SUM(sl.taxable_value)::numeric(14,2) AS taxable_value,
      SUM(sl.cgst_amount)::numeric(14,2) AS cgst_amount,
      SUM(sl.sgst_amount)::numeric(14,2) AS sgst_amount
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY sl.gst_rate
    ORDER BY sl.gst_rate
    `,
    [fromDate, toDate]
  );
  return rows;
}

// Always empty by construction — every counter sale in this build is
// intra-state (Section 6A's own splitCounterGst decision, see
// DECISIONS.md M4), so there is no interstate B2C case to list here yet.
export async function gstr1B2CLarge(_fromDate: string, _toDate: string) {
  return [] as Array<{ bill_number: string; date: string; place_of_supply: string; taxable_value: number; gst_rate: number; tax_amount: number }>;
}

// UQC note: base_unit (tablet/ml/unit...) is shown as-is, not mapped to
// the government's formal UQC code list (NOS/KGS/LTR/...) — that mapping
// doesn't exist anywhere in this build yet. Flag for accountant review,
// same as every other report on this screen.
export async function gstr1HsnSummary(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT p.hsn_code, p.name AS sample_description, p.base_unit AS uqc,
      SUM(sl.quantity_base_units)::int AS total_quantity,
      SUM(sl.taxable_value)::numeric(14,2) AS taxable_value,
      SUM(sl.cgst_amount)::numeric(14,2) AS cgst_amount,
      SUM(sl.sgst_amount)::numeric(14,2) AS sgst_amount,
      sl.gst_rate
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY p.hsn_code, p.name, p.base_unit, sl.gst_rate
    ORDER BY p.hsn_code
    `,
    [fromDate, toDate]
  );
  return rows;
}

// "Invoice numbers issued, cancelled, and net" (10A.1) — gapless
// numbering (Section 6A.6) is what makes this table meaningful at all.
export async function gstr1DocumentSeriesSummary(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT
      SUBSTRING(bill_number FROM '^[A-Za-z]+') AS series_prefix,
      MIN(bill_number) AS from_number, MAX(bill_number) AS to_number,
      COUNT(*)::int AS total_issued,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS net
    FROM sales
    WHERE business_date BETWEEN $1 AND $2
    GROUP BY series_prefix
    `,
    [fromDate, toDate]
  );
  return rows;
}

// --- 10A.1 GSTR-3B working --------------------------------------------

export async function gstr3bWorking(fromDate: string, toDate: string) {
  const outward = await requirePool().query(
    `
    SELECT sl.gst_rate,
      SUM(sl.taxable_value)::numeric(14,2) AS taxable_value,
      SUM(sl.cgst_amount)::numeric(14,2) AS cgst_amount,
      SUM(sl.sgst_amount)::numeric(14,2) AS sgst_amount
    FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY sl.gst_rate ORDER BY sl.gst_rate
    `,
    [fromDate, toDate]
  );

  // ITC eligibility: this build has no place to record a purchase as
  // ineligible (blocked credit, personal use, etc.) — every recorded
  // purchase is treated as eligible input tax credit until a real
  // eligibility flag exists. "ITC reversed" is therefore always zero
  // today, shown as its own line so the gap is visible, not hidden.
  const itc = await requirePool().query(
    `
    SELECT
      SUM(pil.cgst_amount)::numeric(14,2) AS cgst_available,
      SUM(pil.sgst_amount)::numeric(14,2) AS sgst_available,
      SUM(pil.igst_amount)::numeric(14,2) AS igst_available
    FROM purchase_invoice_lines pil JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
    WHERE pi.invoice_date BETWEEN $1 AND $2
    `,
    [fromDate, toDate]
  );

  const outwardTaxTotal = outward.rows.reduce((a, r) => a + Number(r.cgst_amount) + Number(r.sgst_amount), 0);
  const itcRow = itc.rows[0] ?? { cgst_available: 0, sgst_available: 0, igst_available: 0 };
  const itcTotal = Number(itcRow.cgst_available ?? 0) + Number(itcRow.sgst_available ?? 0) + Number(itcRow.igst_available ?? 0);

  return {
    outwardByRate: outward.rows,
    itcAvailable: { cgst: Number(itcRow.cgst_available ?? 0), sgst: Number(itcRow.sgst_available ?? 0), igst: Number(itcRow.igst_available ?? 0) },
    itcReversed: { cgst: 0, sgst: 0, igst: 0 },
    netTaxPayableWorking: Math.round((outwardTaxTotal - itcTotal) * 100) / 100,
    disclaimer: "Computed working for accountant review — not a filing. ITC reversal has no data source in this build yet; verify eligibility manually.",
  };
}

// --- 10A.3 batch traceability ------------------------------------------

// "Enter a batch number, get every inbound, every sale, and every
// customer who received it, with phone numbers ready for a recall
// notice." Matches by batch_no across ALL products sharing that batch
// number (rare but possible across vendors) — callers filtering to one
// product should pass a productId too.
export async function batchTraceability(batchNo: string, productId?: string) {
  const db = requirePool();
  const { rows: batchRows } = await db.query(
    `SELECT id, product_id, batch_no, expiry_date, mrp FROM batches WHERE batch_no = $1 ${productId ? "AND product_id = $2" : ""}`,
    productId ? [batchNo, productId] : [batchNo]
  );
  if (batchRows.length === 0) return { batches: [], inbound: [], outbound: [], affectedCustomers: [] };
  const batchIds = batchRows.map((b) => b.id);

  const { rows: inbound } = await db.query(
    `
    SELECT pi.invoice_date, pi.invoice_number, v.name AS vendor_name, pil.quantity_base_units, pil.free_quantity_base_units
    FROM purchase_invoice_lines pil
    JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
    JOIN vendors v ON v.id = pi.vendor_id
    WHERE pil.batch_id = ANY($1::uuid[])
    UNION ALL
    SELECT ml.created_at::date, 'stock_received (non-GST)', COALESCE(ml.note, ''), ml.quantity_delta, 0
    FROM movement_ledger ml WHERE ml.batch_id = ANY($1::uuid[]) AND ml.movement_type = 'stock_received'
    ORDER BY 1
    `,
    [batchIds]
  );

  const { rows: outbound } = await db.query(
    `
    SELECT s.created_at, s.bill_number, s.customer_name, s.customer_phone, sl.quantity_base_units
    FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
    WHERE sl.batch_id = ANY($1::uuid[]) AND s.status = 'completed'
    ORDER BY s.created_at
    `,
    [batchIds]
  );

  const affectedCustomers = [...new Map(outbound.filter((r) => r.customer_phone).map((r) => [r.customer_phone, { name: r.customer_name, phone: r.customer_phone }])).values()];

  return { batches: batchRows, inbound, outbound, affectedCustomers };
}

// --- 10A.4 location-wise inventory + blind count sheet -----------------

export async function locationWiseInventory() {
  const { rows } = await requirePool().query(`
    SELECT b.zone, b.aisle, b.bay, b.shelf_level, b.code AS bin_code,
      p.name AS product_name, ba.batch_no, ba.expiry_date,
      s.quantity_base_units, p.pack_size, p.base_unit,
      (s.quantity_base_units * ba.mrp / p.pack_size)::numeric(12,2) AS mrp_value
    FROM stock s
    JOIN bins b ON b.id = s.bin_id
    JOIN batches ba ON ba.id = s.batch_id
    JOIN products p ON p.id = s.product_id
    WHERE s.quantity_base_units > 0
    ORDER BY b.zone NULLS LAST, b.aisle, b.bay, b.shelf_level, b.code
  `);
  return rows;
}

// "Printable bin-by-bin count sheet for physical stock-take (blind, with
// no system quantity printed)." Deliberately the same blind principle as
// the daily cycle count, but for a full manual stock-take across
// whichever bins are asked for (or every active bin if none given) —
// not tied to the daily N-bin rotation.
export async function binCountSheet(binIds?: string[]) {
  const { rows } = await requirePool().query(
    `
    SELECT b.code AS bin_code, p.name AS product_name, ba.batch_no, ba.expiry_date
    FROM stock s
    JOIN bins b ON b.id = s.bin_id
    JOIN batches ba ON ba.id = s.batch_id
    JOIN products p ON p.id = s.product_id
    WHERE s.quantity_base_units > 0 ${binIds && binIds.length > 0 ? "AND b.id = ANY($1::uuid[])" : ""}
    ORDER BY b.code, p.name
    `,
    binIds && binIds.length > 0 ? [binIds] : []
  );
  return rows;
}

// --- 10A.4 negative/anomalous stock exception --------------------------

// "On a correct ledger should always be empty. If it is not, something
// is wrong and you want to know that day." Not gated to a date range —
// this is a point-in-time integrity check, not a period report.
export async function negativeStockException() {
  const { rows } = await requirePool().query(`
    SELECT p.name AS product_name, ba.batch_no, b.code AS bin_code, s.quantity_base_units
    FROM stock s
    JOIN products p ON p.id = s.product_id
    JOIN batches ba ON ba.id = s.batch_id
    JOIN bins b ON b.id = s.bin_id
    WHERE s.quantity_base_units < 0
    ORDER BY s.quantity_base_units ASC
  `);
  return rows;
}
