import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 9A.6: "track the last purchase rate per SKU per vendor, with
// dates" — and "on PO creation, show the best available rate and which
// vendor gave it."
export async function lastRatesForProduct(productId: string) {
  const { rows } = await requirePool().query(
    `
    SELECT DISTINCT ON (v.id) v.id AS vendor_id, v.name AS vendor_name,
      pil.rate_before_discount, pi.invoice_date
    FROM purchase_invoice_lines pil
    JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
    JOIN vendors v ON v.id = pi.vendor_id
    WHERE pil.product_id = $1
    ORDER BY v.id, pi.invoice_date DESC
    `,
    [productId]
  );
  return rows
    .map((r) => ({ ...r, rate_before_discount: Number(r.rate_before_discount) }))
    .sort((a, b) => a.rate_before_discount - b.rate_before_discount);
}

// "Flag when a vendor's rate has risen above their own recent average,
// which is easy to miss line by line." Compares each vendor+product's
// single most recent rate against that same vendor+product's average
// over their prior purchases (excluding the latest one) — a vendor with
// only one purchase on record has no prior average to compare against
// and is correctly skipped, not flagged on no evidence.
export async function vendorRateRiseFlags() {
  const { rows } = await requirePool().query(`
    WITH ranked AS (
      SELECT pi.vendor_id, pil.product_id, pil.rate_before_discount, pi.invoice_date,
        ROW_NUMBER() OVER (PARTITION BY pi.vendor_id, pil.product_id ORDER BY pi.invoice_date DESC) AS rn
      FROM purchase_invoice_lines pil JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
    ),
    latest AS (SELECT * FROM ranked WHERE rn = 1),
    prior_avg AS (
      SELECT vendor_id, product_id, AVG(rate_before_discount) AS avg_rate, COUNT(*)::int AS prior_count
      FROM ranked WHERE rn > 1 GROUP BY vendor_id, product_id
    )
    SELECT v.name AS vendor_name, p.name AS product_name, l.rate_before_discount AS latest_rate,
      pa.avg_rate::numeric(12,4) AS prior_avg_rate, l.invoice_date AS latest_invoice_date
    FROM latest l
    JOIN prior_avg pa ON pa.vendor_id = l.vendor_id AND pa.product_id = l.product_id
    JOIN vendors v ON v.id = l.vendor_id
    JOIN products p ON p.id = l.product_id
    WHERE pa.avg_rate > 0 AND (l.rate_before_discount - pa.avg_rate) / pa.avg_rate > 0.05
    ORDER BY (l.rate_before_discount - pa.avg_rate) / pa.avg_rate DESC
  `);
  return rows.map((r) => ({
    ...r,
    latest_rate: Number(r.latest_rate),
    prior_avg_rate: Number(r.prior_avg_rate),
    rise_percent: Math.round(((Number(r.latest_rate) - Number(r.prior_avg_rate)) / Number(r.prior_avg_rate)) * 1000) / 10,
  }));
}

// "Vendor scorecard: average lead time, order fill rate, rate
// competitiveness." Lead time and fill rate both need a real PO->invoice
// link (added this milestone — purchase_invoices.purchase_order_id), so
// this only reflects POs actually raised in this system and fulfilled
// against; a vendor never ordered from via a PO here won't appear.
// "Invoice accuracy" (from AI-scan correction data, Section 9A.6) has no
// data source yet — no AI scan exists until M9 — so it isn't attempted.
export async function vendorScorecard() {
  const { rows } = await requirePool().query(`
    SELECT v.id AS vendor_id, v.name AS vendor_name,
      COUNT(DISTINCT po.id)::int AS pos_fulfilled,
      AVG(pi.invoice_date - po.created_at::date)::numeric(6,1) AS avg_lead_time_days,
      COUNT(DISTINCT pi.id)::int AS invoice_count,
      SUM(pi.net_payable_computed)::numeric(14,2) AS total_spend
    FROM purchase_invoices pi
    JOIN purchase_orders po ON po.id = pi.purchase_order_id
    JOIN vendors v ON v.id = pi.vendor_id
    GROUP BY v.id, v.name
    ORDER BY total_spend DESC
  `);

  const fillRates = await requirePool().query(`
    SELECT po.vendor_id,
      SUM(pol.quantity_base_units)::int AS ordered_qty,
      SUM(LEAST(pol.quantity_base_units, COALESCE(received.qty, 0)))::int AS received_qty
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    LEFT JOIN LATERAL (
      SELECT SUM(pil.quantity_base_units) AS qty
      FROM purchase_invoice_lines pil
      JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
      WHERE pi.purchase_order_id = po.id AND pil.product_id = pol.product_id
    ) received ON true
    WHERE po.status = 'received'
    GROUP BY po.vendor_id
  `);
  const fillRateByVendor = new Map(
    fillRates.rows.map((r) => [r.vendor_id, r.ordered_qty > 0 ? Math.round((r.received_qty / r.ordered_qty) * 1000) / 10 : null])
  );

  return rows.map((r) => ({
    ...r,
    avg_lead_time_days: r.avg_lead_time_days === null ? null : Number(r.avg_lead_time_days),
    total_spend: Number(r.total_spend),
    fill_rate_percent: fillRateByVendor.get(r.vendor_id) ?? null,
  }));
}
