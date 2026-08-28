import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export type RequestStatus = "open" | "on_po" | "received" | "customer_notified" | "fulfilled" | "cancelled" | "lapsed";
export type RequestUrgency = "urgent" | "normal" | "can_wait";

export interface CreateRequestInput {
  customerName: string;
  customerPhone: string;
  productId: string | null; // known SKU
  freeTextItem: string | null; // unknown item
  quantityRequestedUnits: number | null;
  quantityRequestedNote: string | null;
  urgency: RequestUrgency;
  hasPrescriptionInHand: boolean;
  expectedDate: string | null;
  note: string | null;
  loggedBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual" | "automated";
}

// Section 6B.1: three cases. Known-SKU-in-stock is flagged back to the
// caller as a warning (usually a slotting/findability problem) rather
// than silently logged the same as a genuine out-of-stock case.
export async function createRequest(input: CreateRequestInput): Promise<{ id: string; warning: string | null }> {
  const db = requirePool();
  let warning: string | null = null;

  if (input.productId) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(s.quantity_base_units), 0)::int AS total_qty FROM sellable_stock s WHERE s.product_id = $1`,
      [input.productId]
    );
    const qty = rows[0]?.total_qty ?? 0;
    if (qty > 0) {
      const topBin = await db.query(
        `SELECT b.code FROM sellable_stock s JOIN bins b ON b.id = s.bin_id
         WHERE s.product_id = $1 ORDER BY s.quantity_base_units DESC LIMIT 1`,
        [input.productId]
      );
      warning = `This item is in stock at bin ${topBin.rows[0]?.code ?? "(unknown)"} — the customer may not have found it.`;
    }
  }

  const { rows } = await db.query(
    `INSERT INTO customer_requests
       (customer_name, customer_phone, product_id, free_text_item, quantity_requested_units, quantity_requested_note,
        urgency, has_prescription_in_hand, expected_date, note, logged_by, device_id, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.customerName, input.customerPhone, input.productId, input.freeTextItem, input.quantityRequestedUnits,
      input.quantityRequestedNote, input.urgency, input.hasPrescriptionInHand, input.expectedDate, input.note,
      input.loggedBy, input.deviceId, input.source,
    ]
  );
  return { id: rows[0].id, warning };
}

export async function listRequests(status?: RequestStatus) {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT cr.*, p.name AS product_name, pp.name AS pending_product_name,
       (CURRENT_DATE - cr.created_at::date) AS days_waiting
     FROM customer_requests cr
     LEFT JOIN products p ON p.id = cr.product_id
     LEFT JOIN products pp ON pp.id = cr.pending_product_id
     WHERE ($1::request_status IS NULL OR cr.status = $1)
     ORDER BY
       CASE cr.urgency WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       cr.created_at`,
    [status ?? null]
  );
  return rows;
}

export async function linkPendingProduct(requestId: string, productId: string) {
  await requirePool().query(`UPDATE customer_requests SET pending_product_id = $1, updated_at = now() WHERE id = $2`, [productId, requestId]);
}

export async function updateRequestStatus(
  requestId: string,
  status: RequestStatus,
  extra: { couldNotSourceReason?: string; fulfilledSaleId?: string } = {}
) {
  await requirePool().query(
    `UPDATE customer_requests SET status = $1, could_not_source_reason = COALESCE($2, could_not_source_reason),
       fulfilled_sale_id = COALESCE($3, fulfilled_sale_id), updated_at = now() WHERE id = $4`,
    [status, extra.couldNotSourceReason ?? null, extra.fulfilledSaleId ?? null, requestId]
  );
}

export async function incrementUnreachableAttempts(requestId: string): Promise<number> {
  const { rows } = await requirePool().query(
    `UPDATE customer_requests SET unreachable_attempts = unreachable_attempts + 1, updated_at = now() WHERE id = $1 RETURNING unreachable_attempts`,
    [requestId]
  );
  return rows[0]?.unreachable_attempts ?? 0;
}

// Section 6B.5: the daily alarm fires only if there's something to
// review — never trains staff to dismiss it out of habit.
export async function hasOpenQueueToday(): Promise<{ count: number }> {
  const { rows } = await requirePool().query(
    `SELECT count(*)::int AS count FROM customer_requests WHERE status IN ('open', 'on_po', 'received')`
  );
  return rows[0];
}
