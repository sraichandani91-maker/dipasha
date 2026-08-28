import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

/**
 * Owner-requested "item ledger" lookup (F4 from search, Section 5B) — every
 * sale and every GST purchase a product has ever appeared on, one row per
 * transaction (not per FEFO sub-line or per batch), newest first, so a
 * click can jump straight to that transaction's own detail screen. Same
 * cost/rate visibility bar as `GET /sales` and `GET /purchase-invoices`
 * (Owner/store_manager only) since a purchase line always carries the
 * landed rate.
 */
export async function getProductHistory(productId: string) {
  const db = requirePool();

  const { rows: sales } = await db.query(
    `SELECT s.id, s.bill_number, s.business_date, s.channel, s.status, s.customer_name,
            SUM(sl.quantity_base_units)::int AS quantity_base_units, SUM(sl.line_total) AS line_total
     FROM sale_lines sl
     JOIN sales s ON s.id = sl.sale_id
     WHERE sl.product_id = $1
     GROUP BY s.id
     ORDER BY s.business_date DESC, s.created_at DESC
     LIMIT 200`,
    [productId]
  );

  const { rows: purchases } = await db.query(
    `SELECT pi.id, pi.invoice_number, pi.invoice_date, v.name AS vendor_name,
            SUM(pil.quantity_base_units)::int AS quantity_base_units, SUM(pil.line_total) AS line_total
     FROM purchase_invoice_lines pil
     JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
     JOIN vendors v ON v.id = pi.vendor_id
     WHERE pil.product_id = $1
     GROUP BY pi.id, v.name
     ORDER BY pi.invoice_date DESC, pi.created_at DESC
     LIMIT 200`,
    [productId]
  );

  return { sales, purchases };
}
