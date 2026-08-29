import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export const ACTIVITY_CATEGORIES = [
  "sale_generated",
  "sale_cancelled",
  "sale_credit_note",
  "purchase_created",
  "purchase_corrected",
  "vendor_debit_note",
  "batch_corrected",
  "product_group_changed",
  "stock_transfer",
  "stock_movement",
  "cycle_count_completed",
] as const;

export interface ActivityEvent {
  occurredAt: string;
  actorUserId: string;
  actorName: string;
  actorRole: string;
  category: (typeof ACTIVITY_CATEGORIES)[number];
  referenceType: string | null;
  referenceId: string | null;
  details: Record<string, unknown>;
}

export interface ActivityFeedFilter {
  fromDate: string;
  toDate: string;
  category?: string;
  actorUserId?: string;
  limit: number;
  offset: number;
}

/**
 * Owner-requested "what happened, who did it" feed (not the bare
 * HTTP-call `activity_log` table M13.1 built, which has no entity detail
 * — this reads the real domain tables that already carry an actor and a
 * before/after value, and turns each into one readable event). Every
 * branch already exists for its own reason (a purchase-invoice
 * correction's audit trail, a batch's price-correction log, the
 * append-only movement ledger) — this UNIONs them into one timeline
 * rather than inventing a second logging mechanism that could drift from
 * what actually happened. `details` stays structured (never a
 * pre-formatted string) so the web layer decides how to phrase it and
 * can still link back to the real underlying document.
 *
 * Date range is pushed into every branch (not just the outer WHERE) so a
 * narrow range stays index-friendly as these tables grow; category/actor
 * stay outer-only since they're commonly "all" and cheap to filter after
 * the (already date-bounded) union.
 */
export async function getActivityFeed(filter: ActivityFeedFilter): Promise<{ events: ActivityEvent[]; total: number }> {
  const db = requirePool();
  const { fromDate, toDate } = filter;

  const unionSql = `
    WITH all_events AS (
      SELECT s.created_at AS occurred_at, s.created_by AS actor_user_id, 'sale_generated' AS category,
        'sale' AS reference_type, s.id::text AS reference_id,
        jsonb_build_object('billNumber', s.bill_number, 'grandTotal', s.grand_total, 'channel', s.channel, 'customerName', s.customer_name) AS details
      FROM sales s WHERE s.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT s.cancelled_at, s.cancelled_by, 'sale_cancelled', 'sale', s.id::text,
        jsonb_build_object('billNumber', s.bill_number, 'grandTotal', s.grand_total, 'reason', s.cancelled_reason)
      FROM sales s WHERE s.status = 'cancelled' AND s.cancelled_at IS NOT NULL AND s.cancelled_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT cn.created_at, cn.created_by, 'sale_credit_note', 'sale', cn.original_sale_id::text,
        jsonb_build_object('creditNoteNumber', cn.credit_note_number, 'billNumber', s.bill_number, 'refundValue', cn.total_refund_value, 'reason', cn.reason)
      FROM credit_notes cn JOIN sales s ON s.id = cn.original_sale_id
      WHERE cn.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT pi.created_at, pi.created_by, 'purchase_created', 'purchase_invoice', pi.id::text,
        jsonb_build_object('invoiceNumber', pi.invoice_number, 'vendorName', v.name, 'netPayable', pi.net_payable_computed)
      FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
      WHERE pi.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT pic.created_at, pic.actor_user_id, 'purchase_corrected', 'purchase_invoice', pic.purchase_invoice_id::text,
        jsonb_build_object('invoiceNumber', pi.invoice_number, 'field', pic.field, 'oldValue', pic.old_value, 'newValue', pic.new_value, 'reasonCode', pic.reason_code, 'note', pic.note)
      FROM purchase_invoice_corrections pic JOIN purchase_invoices pi ON pi.id = pic.purchase_invoice_id
      WHERE pic.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT vdn.created_at, vdn.created_by, 'vendor_debit_note', 'purchase_invoice', vdn.purchase_invoice_id::text,
        jsonb_build_object('debitNoteNumber', vdn.debit_note_number, 'vendorName', v.name, 'totalValue', vdn.total_value, 'reasonCode', vdn.reason_code)
      FROM vendor_debit_notes vdn JOIN vendors v ON v.id = vdn.vendor_id
      WHERE vdn.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT bc.created_at, bc.actor_user_id, 'batch_corrected', 'product', ba.product_id::text,
        jsonb_build_object('productName', p.name, 'batchNo', ba.batch_no, 'field', bc.field, 'oldValue', bc.old_value, 'newValue', bc.new_value, 'reasonCode', bc.reason_code, 'note', bc.note)
      FROM batch_corrections bc JOIN batches ba ON ba.id = bc.batch_id JOIN products p ON p.id = ba.product_id
      WHERE bc.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT pgc.created_at, pgc.actor_user_id, 'product_group_changed', 'product', pgc.product_id::text,
        jsonb_build_object('productName', p.name, 'note', pgc.note)
      FROM product_group_changes pgc JOIN products p ON p.id = pgc.product_id
      WHERE pgc.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT MIN(ml.created_at), ml.actor_user_id, 'stock_transfer', 'product', ml.product_id::text,
        jsonb_build_object(
          'productName', MIN(p.name), 'quantity', MAX(ABS(ml.quantity_delta)),
          'fromBin', (array_agg(b.code ORDER BY ml.quantity_delta ASC))[1],
          'toBin', (array_agg(b.code ORDER BY ml.quantity_delta DESC))[1],
          'reasonCode', MIN(ml.reason_code), 'note', MIN(ml.note)
        )
      FROM movement_ledger ml JOIN products p ON p.id = ml.product_id JOIN bins b ON b.id = ml.bin_id
      WHERE ml.movement_type = 'transfer' AND ml.transfer_group_id IS NOT NULL AND ml.created_at::date BETWEEN $1 AND $2
      GROUP BY ml.transfer_group_id, ml.actor_user_id, ml.product_id

      UNION ALL
      SELECT ml.created_at, ml.actor_user_id, 'stock_movement', 'product', ml.product_id::text,
        jsonb_build_object('productName', p.name, 'binCode', b.code, 'movementType', ml.movement_type, 'quantityDelta', ml.quantity_delta, 'reasonCode', ml.reason_code, 'note', ml.note)
      FROM movement_ledger ml JOIN products p ON p.id = ml.product_id JOIN bins b ON b.id = ml.bin_id
      WHERE ml.movement_type IN ('write_off', 'adjustment', 'purchase_return', 'stock_received', 'stock_issue')
        AND ml.created_at::date BETWEEN $1 AND $2

      UNION ALL
      SELECT cct.counted_at, cct.counted_by, 'cycle_count_completed', 'bin', cct.bin_id::text,
        jsonb_build_object('binCode', bi.code, 'totalVarianceValue', cct.total_variance_value, 'reviewOutcome', cct.review_outcome)
      FROM cycle_count_tasks cct JOIN bins bi ON bi.id = cct.bin_id
      WHERE cct.counted_by IS NOT NULL AND cct.counted_at IS NOT NULL AND cct.counted_at::date BETWEEN $1 AND $2
    )
    SELECT e.occurred_at, e.actor_user_id, u.name AS actor_name, u.role AS actor_role, e.category, e.reference_type, e.reference_id, e.details
    FROM all_events e
    JOIN users u ON u.id = e.actor_user_id
    WHERE ($3::text IS NULL OR e.category = $3) AND ($4::uuid IS NULL OR e.actor_user_id = $4)
  `;

  const params = [fromDate, toDate, filter.category ?? null, filter.actorUserId ?? null];
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query(`${unionSql} ORDER BY e.occurred_at DESC LIMIT $5 OFFSET $6`, [...params, filter.limit, filter.offset]),
    db.query(`SELECT COUNT(*)::int AS total FROM (${unionSql}) counted`, params),
  ]);

  return {
    events: rows.map((r: any) => ({
      occurredAt: r.occurred_at,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      category: r.category,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      details: r.details,
    })),
    total: Number(countRows[0].total),
  };
}
