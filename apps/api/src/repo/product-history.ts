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

  // Owner-requested: "who increased/decreased the quantity, who changed
  // the price" for this specific medicine — batch-level corrections
  // (price/expiry/batch-no, from Inventory's edit-stock tool), non-sale/
  // non-purchase stock movements (write-offs, adjustments, transfers,
  // put-away variances, non-GST receipts/issues — the sale and GST
  // purchase movements are already the `sales`/`purchases` arrays above,
  // so they're excluded here to avoid listing the same event twice), and
  // substitute-group reassignments. Same tables the global Activity Logs
  // feed (`repo/activity-feed.ts`) reads, just pre-filtered to one product.
  const { rows: batchChanges } = await db.query(
    `SELECT bc.id, bc.created_at, bc.field, bc.old_value, bc.new_value, bc.reason_code, bc.note, ba.batch_no, u.name AS actor_name
     FROM batch_corrections bc
     JOIN batches ba ON ba.id = bc.batch_id
     JOIN users u ON u.id = bc.actor_user_id
     WHERE ba.product_id = $1
     ORDER BY bc.created_at DESC
     LIMIT 100`,
    [productId]
  );

  const { rows: stockChanges } = await db.query(
    `SELECT ml.id, ml.created_at, ml.movement_type, ml.quantity_delta, ml.reason_code, ml.note, b.code AS bin_code, u.name AS actor_name
     FROM movement_ledger ml
     JOIN bins b ON b.id = ml.bin_id
     JOIN users u ON u.id = ml.actor_user_id
     WHERE ml.product_id = $1
       AND ml.movement_type IN ('write_off', 'adjustment', 'transfer', 'purchase_return', 'stock_received', 'stock_issue')
     ORDER BY ml.created_at DESC
     LIMIT 100`,
    [productId]
  );

  const { rows: groupChanges } = await db.query(
    `SELECT pgc.id, pgc.created_at, pgc.note, u.name AS actor_name
     FROM product_group_changes pgc
     JOIN users u ON u.id = pgc.actor_user_id
     WHERE pgc.product_id = $1
     ORDER BY pgc.created_at DESC
     LIMIT 100`,
    [productId]
  );

  return { sales, purchases, batchChanges, stockChanges, groupChanges };
}
