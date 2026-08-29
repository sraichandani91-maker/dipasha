import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { getSetting } from "../repo/settings.js";
import { config } from "../config.js";
import { createWhatsAppSender, type MinimalLogger } from "../lib/whatsapp-sender.js";
import { buildWhatsAppText } from "../lib/whatsapp-message.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 12A: "every message goes through one dispatcher... not calls
// scattered through the code." This module is that dispatcher.
// `enqueueNotification` is the only place anything writes a
// `notification_log` row — the bill-generation trigger, the callback
// loop, and the manual "Send via WhatsApp" resend button all call it,
// never `WhatsAppSender` directly.

export interface EnqueueInput {
  triggerType:
    | "bill_generated" | "callback_stock_available" | "order_confirmed" | "order_quote" | "order_partially_available"
    | "order_out_for_delivery" | "order_delivered" | "daily_report" | "inbox_reply" | "refill_reminder" | "po_sent" | "financial_daily_digest"
    | "payment_due_reminder";
  category: "transactional" | "marketing";
  templateKey: string;
  triggerEnabledSettingKey: string;
  recipientCustomerId: string | null;
  recipientPhone: string;
  referenceType: string | null;
  referenceId: string | null;
  payload: Record<string, unknown>;
}

export type EnqueueStatus = "pending" | "skipped_trigger_disabled" | "skipped_opted_out";

// Runs inside the caller's own transaction (bill save, stock reservation)
// so enqueueing is atomic with the event that caused it — but it is only
// ever a DB insert, never a network call, so it can never delay the bill
// (Section 12A.2: "must not delay the bill... queue it asynchronously").
export async function enqueueNotification(client: PoolClient, input: EnqueueInput): Promise<{ id: string; status: EnqueueStatus }> {
  const enabled = await getSetting(input.triggerEnabledSettingKey, true);
  if (!enabled) return insertLog(client, input, "skipped_trigger_disabled");

  if (input.recipientCustomerId) {
    const { rows } = await client.query(
      `SELECT whatsapp_transactional_opt_in, whatsapp_marketing_opt_in FROM customers WHERE id = $1`,
      [input.recipientCustomerId]
    );
    const consent = rows[0];
    // No consent row (shouldn't happen — recipientCustomerId always comes
    // from findOrCreateCustomer) defaults to allowed rather than silently
    // dropping a message over a lookup miss.
    const optedIn = consent
      ? input.category === "marketing"
        ? consent.whatsapp_marketing_opt_in
        : consent.whatsapp_transactional_opt_in
      : true;
    if (!optedIn) return insertLog(client, input, "skipped_opted_out");
  }

  return insertLog(client, input, "pending");
}

async function insertLog(client: PoolClient, input: EnqueueInput, status: EnqueueStatus): Promise<{ id: string; status: EnqueueStatus }> {
  const { rows } = await client.query(
    `INSERT INTO notification_log
       (trigger_type, category, template_key, recipient_customer_id, recipient_phone, reference_type, reference_id, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.triggerType, input.category, input.templateKey, input.recipientCustomerId, input.recipientPhone,
      input.referenceType, input.referenceId, JSON.stringify(input.payload), status,
    ]
  );
  return { id: rows[0].id, status };
}

// Section 12A.1: "retried with backoff." No specific schedule is given in
// the brief — a short, then longer, then longer-still gap is a
// reasonable default (owner-editable later, like every other unstated
// threshold in this build); index by (attempts so far - 1), clamped to
// the last entry once max attempts is raised past this list's length.
const BACKOFF_MINUTES = [2, 10, 30];

// Picks up due rows and attempts delivery one at a time, each in its own
// short transaction — deliberately not one long transaction across the
// whole batch, so a slow or hanging send on one row never holds a lock
// on the others. `FOR UPDATE SKIP LOCKED` makes this safe to run
// concurrently (a second overlapping tick, or eventually a second API
// instance) without double-sending the same row.
export async function processPendingNotifications(log: MinimalLogger, limit = 20): Promise<{ processed: number }> {
  const db = requirePool();
  const { rows: candidates } = await db.query(
    `SELECT id FROM notification_log WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`,
    [limit]
  );
  let processed = 0;
  for (const { id } of candidates) {
    processed += await processOne(id, log);
  }
  return { processed };
}

// Exported for the manual "Retry" action on the Failed Notifications
// list (routes/notifications.ts) — same immediate-processing reasoning
// as `enqueueAndSendNow`: a human clicked retry and is waiting to see
// what happened, not for the next background tick.
export async function processOne(id: string, log: MinimalLogger): Promise<0 | 1> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM notification_log WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`, [id]);
    if (rows.length === 0) {
      // Already claimed by a concurrent run, or no longer pending — not an error.
      await client.query("ROLLBACK");
      return 0;
    }
    const row = rows[0];
    const maxAttempts = await getSetting("whatsapp_max_send_attempts", 3);
    const sender = createWhatsAppSender(config.whatsappProvider, log);

    try {
      const text = buildWhatsAppText(row.trigger_type, row.payload);
      const result = await sender.send({ phone: row.recipient_phone, text });
      await client.query(
        `UPDATE notification_log SET status = $1, attempts = attempts + 1, provider_message_id = $2, sent_at = now(), last_error = NULL WHERE id = $3`,
        [result.status, result.providerMessageId, id]
      );
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= maxAttempts) {
        // Section 12A.2: "a permanent failure surfaces on a Failed
        // Notifications list, never silently disappears."
        await client.query(`UPDATE notification_log SET status = 'failed', attempts = $1, last_error = $2 WHERE id = $3`, [attempts, message, id]);
      } else {
        const delayMinutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
        await client.query(
          `UPDATE notification_log SET attempts = $1, last_error = $2, next_attempt_at = now() + ($3 || ' minutes')::interval WHERE id = $4`,
          [attempts, message, delayMinutes, id]
        );
      }
    }
    await client.query("COMMIT");
    return 1;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Manual resend (POS's "Send via WhatsApp" button, or a retry on a
// failed row) — a human is actively waiting on this one, so it enqueues
// and processes inline instead of waiting for the background tick.
// Automatic triggers (bill save, callback) never call this — they only
// enqueue (inside their own transaction), which is what actually
// satisfies "must not delay the bill."
//
// Deliberately owns its own connection end to end rather than accepting
// an external transaction client: `processOne` below opens a *second*
// connection to claim and process the row, and a second connection can
// never see a row an unrelated transaction hasn't committed yet
// (Postgres READ COMMITTED). So the enqueue here is committed on its own
// first, then processOne's separate transaction can actually find it.
export async function enqueueAndSendNow(input: EnqueueInput, log: MinimalLogger): Promise<{ id: string; status: string }> {
  const db = requirePool();
  const client = await db.connect();
  let result: { id: string; status: EnqueueStatus };
  try {
    await client.query("BEGIN");
    result = await enqueueNotification(client, input);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (result.status !== "pending") return result;
  await processOne(result.id, log);
  const { rows } = await db.query(`SELECT status FROM notification_log WHERE id = $1`, [result.id]);
  return { id: result.id, status: rows[0].status };
}
