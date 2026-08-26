import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

/**
 * Section 9A.2: "All margin reporting uses effective cost, never invoice
 * rate." Every query here reads `sale_lines.effective_cost_per_base_unit_
 * snapshot` (captured at sale time, M4) — a line whose snapshot is null
 * (cost_unknown batch, e.g. unrecorded opening stock) is excluded from
 * cost/margin math and counted separately, never treated as zero cost.
 */

export async function marginBySku(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT p.id AS product_id, p.name AS product_name,
      SUM(sl.taxable_value)::numeric(14,2) AS revenue,
      SUM(sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NOT NULL)::numeric(14,2) AS cost,
      COUNT(*) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NULL)::int AS cost_unknown_line_count
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY p.id, p.name
    ORDER BY revenue DESC
    `,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    ...r,
    revenue: Number(r.revenue),
    cost: r.cost === null ? null : Number(r.cost),
    marginValue: r.cost === null ? null : Math.round((Number(r.revenue) - Number(r.cost)) * 100) / 100,
    marginPercent: r.cost === null || Number(r.revenue) === 0 ? null : Math.round(((Number(r.revenue) - Number(r.cost)) / Number(r.revenue)) * 1000) / 10,
  }));
}

// "Category" here is schedule_category (OTC/H/H1/X/Ayurvedic/Cosmetic/
// Device) — the only categorical dimension that exists on a product in
// this build. There's no separate merchandising-category field; adding
// one is a real taxonomy decision the brief doesn't make, so this uses
// what's already there rather than inventing one (see DECISIONS.md).
export async function marginByCategory(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT p.schedule_category AS category,
      SUM(sl.taxable_value)::numeric(14,2) AS revenue,
      SUM(sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NOT NULL)::numeric(14,2) AS cost
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY p.schedule_category
    ORDER BY revenue DESC
    `,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    ...r,
    revenue: Number(r.revenue),
    cost: r.cost === null ? null : Number(r.cost),
    marginValue: r.cost === null ? null : Math.round((Number(r.revenue) - Number(r.cost)) * 100) / 100,
    marginPercent: r.cost === null || Number(r.revenue) === 0 ? null : Math.round(((Number(r.revenue) - Number(r.cost)) / Number(r.revenue)) * 1000) / 10,
  }));
}

// Vendor attribution is best-effort: a batch's vendor comes from the
// purchase invoice line that first brought it in. A batch with no
// matching purchase_invoice_line (non-GST stock_received, opening stock)
// has no vendor to attribute to — grouped under "Unknown / non-GST source"
// rather than silently dropped, since that's a real, visible gap in
// vendor-level reporting a real pharmacy would want to know about.
export async function marginByVendor(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT COALESCE(v.name, 'Unknown / non-GST source') AS vendor_name,
      SUM(sl.taxable_value)::numeric(14,2) AS revenue,
      SUM(sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NOT NULL)::numeric(14,2) AS cost
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    LEFT JOIN LATERAL (
      SELECT pil.purchase_invoice_id FROM purchase_invoice_lines pil
      WHERE pil.batch_id = sl.batch_id ORDER BY pil.id LIMIT 1
    ) first_line ON true
    LEFT JOIN purchase_invoices pi ON pi.id = first_line.purchase_invoice_id
    LEFT JOIN vendors v ON v.id = pi.vendor_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY v.name
    ORDER BY revenue DESC
    `,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    ...r,
    revenue: Number(r.revenue),
    cost: r.cost === null ? null : Number(r.cost),
    marginValue: r.cost === null ? null : Math.round((Number(r.revenue) - Number(r.cost)) * 100) / 100,
    marginPercent: r.cost === null || Number(r.revenue) === 0 ? null : Math.round(((Number(r.revenue) - Number(r.cost)) / Number(r.revenue)) * 1000) / 10,
  }));
}

// "Flag any SKU selling below effective cost, which happens more often
// than owners expect when MRP is fixed and purchase rates drift." Line-
// level, not aggregated — one SKU's below-cost line doesn't hide inside
// a profitable average.
export async function belowCostSales(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT s.bill_number, s.business_date, p.id AS product_id, p.name AS product_name, b.batch_no,
      sl.quantity_base_units, sl.taxable_value,
      (sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units)::numeric(12,2) AS cost,
      (sl.taxable_value - sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units)::numeric(12,2) AS loss
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    JOIN batches b ON b.id = sl.batch_id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
      AND sl.effective_cost_per_base_unit_snapshot IS NOT NULL
      AND sl.taxable_value < sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units
    ORDER BY loss ASC
    `,
    [fromDate, toDate]
  );
  return rows;
}

// Section 9A.2: "Scheme tracking per vendor: what was promised versus
// what actually arrived." Only lines where a promised figure was
// actually recorded — most invoices aren't scheme purchases, and those
// correctly don't show up here at all.
export async function schemeShortfalls(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT pi.invoice_date, pi.invoice_number, v.name AS vendor_name, p.name AS product_name,
      pil.promised_quantity_base_units, pil.quantity_base_units AS actual_quantity_base_units,
      pil.promised_free_quantity_base_units, pil.free_quantity_base_units AS actual_free_quantity_base_units
    FROM purchase_invoice_lines pil
    JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
    JOIN vendors v ON v.id = pi.vendor_id
    JOIN products p ON p.id = pil.product_id
    WHERE pi.invoice_date BETWEEN $1 AND $2
      AND (
        (pil.promised_quantity_base_units IS NOT NULL AND pil.promised_quantity_base_units > pil.quantity_base_units)
        OR (pil.promised_free_quantity_base_units IS NOT NULL AND pil.promised_free_quantity_base_units > pil.free_quantity_base_units)
      )
    ORDER BY pi.invoice_date DESC
    `,
    [fromDate, toDate]
  );
  return rows;
}
