import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 12A.5: "full send log: recipient, template, timestamp, status,
// cost, error — queryable from the SQL console." This is that log's web
// query, not a separately-maintained copy — `notification_log` is also
// the queue itself (see domain/notifications.ts).
export async function listNotifications(filter: { id?: string; status?: string; referenceType?: string; referenceId?: string }, limit = 100) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.id) {
    params.push(filter.id);
    conditions.push(`nl.id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`nl.status = $${params.length}`);
  }
  if (filter.referenceType) {
    params.push(filter.referenceType);
    conditions.push(`nl.reference_type = $${params.length}`);
  }
  if (filter.referenceId) {
    params.push(filter.referenceId);
    conditions.push(`nl.reference_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const { rows } = await requirePool().query(
    `SELECT nl.*, c.name AS recipient_name
     FROM notification_log nl LEFT JOIN customers c ON c.id = nl.recipient_customer_id
     ${where}
     ORDER BY nl.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

// Section 12A.1: "expose a monthly spend report." Honestly ₹0 until a
// real provider reports a per-message cost — grouped so the shape is
// already right the moment `notification_log.cost_inr` starts getting
// populated.
export async function getSpendSummary(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(cost_inr), 0)::numeric(10,2) AS total_cost
     FROM notification_log
     WHERE created_at >= $1 AND created_at < ($2::date + 1)
     GROUP BY status ORDER BY status`,
    [fromDate, toDate]
  );
  const totalCost = rows.reduce((a, r) => a + Number(r.total_cost), 0);
  return { byStatus: rows, totalCost, hasCostData: rows.some((r) => Number(r.total_cost) > 0) };
}

export class NotificationError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Manually re-queues a permanently-failed row — resets attempts so it
// gets the same backoff treatment as a fresh send, not an infinite loop
// of instant re-failures if the underlying problem hasn't changed.
export async function requeueFailedNotification(id: string): Promise<void> {
  const { rows } = await requirePool().query(
    `UPDATE notification_log SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
     WHERE id = $1 AND status = 'failed' RETURNING id`,
    [id]
  );
  if (!rows[0]) throw new NotificationError("not_failed_or_not_found");
}
