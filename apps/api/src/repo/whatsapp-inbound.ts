import { pool } from "../db.js";
import { findCustomerByPhone, updateWhatsAppConsent } from "./customers.js";
import { addOrderMessage } from "./orders.js";
import { enqueueAndSendNow } from "../domain/notifications.js";
import type { MinimalLogger } from "../lib/whatsapp-sender.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 12A.5: "STOP" and its common variants opt a customer out
// immediately, on an exact match (after trim + lowercase) — not a
// substring match, so a customer who happens to write "please stop by
// tomorrow" doesn't get silently unsubscribed.
const STOP_KEYWORDS = new Set(["stop", "unsubscribe", "opt out", "optout", "cancel"]);

export interface InboundMessage {
  fromPhone: string;
  body: string;
}

/**
 * Section 12A.4's inbound webhook target. Matches the sender to an
 * existing customer by phone (never creates one — an unmatched number
 * still lands in the inbox for a human to triage, per the shared-inbox
 * being the point of this milestone) and, if that customer has a
 * delivery order still in flight, mirrors the message into that order's
 * existing `order_messages` thread (Section 7A.5) — bridging into the
 * conversation UI that's already there rather than building a second,
 * parallel one.
 */
export async function recordInboundMessage(input: InboundMessage, log: MinimalLogger): Promise<{ id: string }> {
  const db = requirePool();
  const customer = await findCustomerByPhone(input.fromPhone);

  const normalized = input.body.trim().toLowerCase();
  const isStopKeyword = STOP_KEYWORDS.has(normalized);

  let matchedOrderId: string | null = null;
  if (customer) {
    const { rows } = await db.query(
      `SELECT id FROM orders WHERE customer_id = $1 AND status NOT IN ('delivered', 'cancelled', 'rejected') ORDER BY created_at DESC LIMIT 1`,
      [customer.id]
    );
    matchedOrderId = rows[0]?.id ?? null;
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO whatsapp_inbound_messages (from_phone, body, matched_customer_id, matched_order_id, is_stop_keyword)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.fromPhone, input.body, customer?.id ?? null, matchedOrderId, isStopKeyword]
  );

  if (matchedOrderId) {
    await addOrderMessage(matchedOrderId, { sender: "customer", body: input.body, createdBy: null });
  }

  if (isStopKeyword && customer) {
    await updateWhatsAppConsent(customer.id, { transactionalOptIn: false, marketingOptIn: false });
    log.warn({ customerId: customer.id, phone: input.fromPhone }, "WhatsApp STOP keyword received — customer opted out of both categories");
  }

  return { id: inserted[0].id };
}

export interface InboxFilter {
  handled?: boolean;
}

export async function listInboxMessages(filter: InboxFilter) {
  const db = requirePool();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.handled !== undefined) { params.push(filter.handled); where.push(`m.handled = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT m.*, c.name AS customer_name, o.order_number, hu.name AS handled_by_name
     FROM whatsapp_inbound_messages m
     LEFT JOIN customers c ON c.id = m.matched_customer_id
     LEFT JOIN orders o ON o.id = m.matched_order_id
     LEFT JOIN users hu ON hu.id = m.handled_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY m.received_at DESC
     LIMIT 500`,
    params
  );
  return rows;
}

export class InboxError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function markInboxMessageHandled(id: string, actorUserId: string): Promise<void> {
  const { rowCount } = await requirePool().query(
    `UPDATE whatsapp_inbound_messages SET handled = true, handled_by = $1, handled_at = now() WHERE id = $2`,
    [actorUserId, id]
  );
  if (rowCount === 0) throw new InboxError("not_found");
}

/**
 * A free-text reply to an inbound message. Sent over the same one
 * dispatcher every other WhatsApp message in this build goes through
 * (Section 12A: "every message goes through one dispatcher... never
 * calls scattered through the code") — but unlike every other trigger,
 * there's no Meta-approved template to fill in: WhatsApp's own rule is
 * that a free-form reply is allowed within the 24-hour window after a
 * customer messages a business, which replying to an inbound message
 * always is by definition.
 */
export async function replyToInboxMessage(id: string, body: string, actorUserId: string, log: MinimalLogger): Promise<void> {
  const db = requirePool();
  const { rows } = await db.query(`SELECT from_phone, matched_customer_id, matched_order_id FROM whatsapp_inbound_messages WHERE id = $1`, [id]);
  const message = rows[0];
  if (!message) throw new InboxError("not_found");

  await enqueueAndSendNow(
    {
      triggerType: "inbox_reply",
      category: "transactional",
      // No Meta template — WhatsApp allows a free-form reply within the
      // 24-hour window after a customer messages a business, which this
      // always is by definition. Recorded for clarity in the send log,
      // not read by anything at send time.
      templateKey: "none_free_text_reply",
      triggerEnabledSettingKey: "whatsapp_trigger_inbox_reply_enabled",
      recipientCustomerId: message.matched_customer_id,
      recipientPhone: message.from_phone,
      referenceType: "whatsapp_inbound_message",
      referenceId: id,
      payload: { body },
    },
    log
  );

  if (message.matched_order_id) {
    await addOrderMessage(message.matched_order_id, { sender: "staff", body, createdBy: actorUserId });
  }

  await markInboxMessageHandled(id, actorUserId);
}
