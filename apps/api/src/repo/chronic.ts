import type { PoolClient, Pool } from "pg";
import { pool } from "../db.js";
import { getSetting } from "./settings.js";
import { enqueueAndSendNow } from "../domain/notifications.js";
import { createRequest } from "./customer-requests.js";
import type { MinimalLogger } from "../lib/whatsapp-sender.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class ChronicError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface CreateChronicMedicationInput {
  customerId: string;
  productId: string;
  prescriberId: string | null;
  dailyDoseBaseUnits: number;
  standingOrderEnabled: boolean;
  note: string | null;
  createdBy: string;
}

// Section 9A.3: "flag a SKU or a customer-SKU pairing as chronic." Picking
// the product here IS the SKU flag — the tracked row is always keyed on
// (customer, product), since every downstream capability (exhaustion date,
// refill-due, churn signal) needs a specific customer's dosing/purchase
// history, not just a bare product marker. See DECISIONS.md.
export async function createChronicMedication(input: CreateChronicMedicationInput): Promise<{ id: string }> {
  const db = requirePool();
  let id: string;
  try {
    const { rows } = await db.query(
      `INSERT INTO chronic_medications (customer_id, product_id, prescriber_id, daily_dose_base_units, standing_order_enabled, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.customerId, input.productId, input.prescriberId, input.dailyDoseBaseUnits, input.standingOrderEnabled, input.note, input.createdBy]
    );
    id = rows[0].id;
  } catch (err: any) {
    if (err.code === "23505") throw new ChronicError("already_flagged");
    throw err;
  }
  // Seed from real purchase history immediately — a patient who's been
  // buying this every month for a year shouldn't show a blank exhaustion
  // date just because the flag was only created today.
  await recomputeChronicFromHistory(db, input.customerId, input.productId);
  return { id };
}

/**
 * "From pack size and last purchase quantity, compute the expected
 * exhaustion date — 30 tablets at one daily is 30 days." Recomputed from
 * the real `sale_lines`/`sales` ledger (the most recent completed sale of
 * this product to this customer), never incrementally patched — the same
 * "derive from source of truth" choice this build makes everywhere else.
 * Accepts a transaction client so it can run inside `createSale`'s own
 * transaction (repo/sales.ts) as well as standalone.
 */
export async function recomputeChronicFromHistory(client: PoolClient | Pool, customerId: string, productId: string): Promise<void> {
  const { rows: chronicRows } = await client.query(
    `SELECT id, daily_dose_base_units FROM chronic_medications WHERE customer_id = $1 AND product_id = $2 AND status = 'active'`,
    [customerId, productId]
  );
  const chronic = chronicRows[0];
  if (!chronic) return;

  const { rows: saleRows } = await client.query(
    `SELECT s.business_date, SUM(sl.quantity_base_units)::int AS qty
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.customer_id = $1 AND sl.product_id = $2 AND s.status = 'completed'
     GROUP BY s.id, s.business_date
     ORDER BY s.business_date DESC, s.created_at DESC
     LIMIT 1`,
    [customerId, productId]
  );
  const last = saleRows[0];
  if (!last) return;

  const cycleDays = Math.max(1, Math.ceil(last.qty / Number(chronic.daily_dose_base_units)));
  await client.query(
    `UPDATE chronic_medications
     SET last_purchase_date = $1, last_purchase_quantity_base_units = $2,
         expected_exhaustion_date = ($1::date + ($3 || ' days')::interval)::date
     WHERE id = $4`,
    [last.business_date, last.qty, cycleDays, chronic.id]
  );
}

export interface UpdateChronicMedicationInput {
  prescriberId?: string | null;
  dailyDoseBaseUnits?: number;
  standingOrderEnabled?: boolean;
  status?: "active" | "paused" | "stopped";
  note?: string | null;
}

export async function updateChronicMedication(id: string, input: UpdateChronicMedicationInput): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [col, val] of Object.entries({
    prescriber_id: input.prescriberId,
    daily_dose_base_units: input.dailyDoseBaseUnits,
    standing_order_enabled: input.standingOrderEnabled,
    status: input.status,
    note: input.note,
  })) {
    if (val === undefined) continue;
    sets.push(`${col} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0) return;
  values.push(id);
  const result = await requirePool().query(`UPDATE chronic_medications SET ${sets.join(", ")} WHERE id = $${i}`, values);
  if ((result.rowCount ?? 0) === 0) throw new ChronicError("not_found");
}

export async function markChronicNotified(id: string): Promise<void> {
  const result = await requirePool().query(`UPDATE chronic_medications SET manually_notified_at = now() WHERE id = $1`, [id]);
  if ((result.rowCount ?? 0) === 0) throw new ChronicError("not_found");
}

// Section 9A.3: "refill due list: who is due in the next 7 days, who is
// overdue and by how many days" plus the churn flag — one list, since a
// staff member working the queue needs both together, sorted soonest
// (most overdue) first regardless of which bucket a row falls in.
export async function listRefillDue() {
  const dueSoonDays = await getSetting("refill_due_within_days", 7);
  const churnDays = await getSetting("chronic_overdue_churn_days", 7);

  const { rows } = await requirePool().query(
    `SELECT cm.*, c.name AS customer_name, c.phone AS customer_phone,
            p.name AS product_name, p.pack_size, p.base_unit,
            pr.name AS prescriber_name,
            (cm.expected_exhaustion_date - CURRENT_DATE) AS days_until_exhaustion
     FROM chronic_medications cm
     JOIN customers c ON c.id = cm.customer_id
     JOIN products p ON p.id = cm.product_id
     LEFT JOIN prescribers pr ON pr.id = cm.prescriber_id
     WHERE cm.status = 'active' AND cm.expected_exhaustion_date IS NOT NULL
       AND cm.expected_exhaustion_date <= (CURRENT_DATE + ($1 || ' days')::interval)::date
     ORDER BY cm.expected_exhaustion_date ASC`,
    [dueSoonDays]
  );
  return rows.map((r) => ({
    ...r,
    is_overdue: r.days_until_exhaustion < 0,
    is_churn_risk: r.days_until_exhaustion < 0 && Math.abs(r.days_until_exhaustion) >= churnDays,
  }));
}

// Section 9A.3/12A.2: "WhatsApp refill reminder, timed a configurable
// few days before exhaustion" plus the optional standing order. No
// background job runner exists in this build — same plain `setInterval`
// poller pattern as M8's notification dispatcher and M13.10's daily
// report, polled from index.ts. Idempotent per exhaustion-date cycle via
// `reminder_sent_for_exhaustion_date`: a fresh purchase changes
// `expected_exhaustion_date`, which naturally re-arms the next cycle
// without any separate reset step.
const REMINDER_ROW_QUERY = `
  SELECT cm.id, cm.customer_id, cm.product_id, cm.standing_order_enabled, cm.last_purchase_quantity_base_units,
         cm.expected_exhaustion_date, c.name AS customer_name, c.phone AS customer_phone, p.name AS product_name
  FROM chronic_medications cm
  JOIN customers c ON c.id = cm.customer_id
  JOIN products p ON p.id = cm.product_id
  WHERE cm.id = $1
`;

// Shared by the poller (`sendDueRefillReminders`) and the manual "Remind
// now" button (`sendReminderNow`) — one place that sends the WhatsApp
// message, auto-creates the standing order, and stamps the cycle as
// handled, so a manual send can never drift from what the automated tick
// would have done for the same row.
async function processReminderRow(row: any, log: MinimalLogger): Promise<void> {
  const db = requirePool();

  if (!row.customer_phone) {
    // Nothing actionable without a phone — a WhatsApp reminder has
    // nowhere to go and a standing order has no callback number
    // (Section 6B.1: "phone is the key"). Still stamped below so this
    // doesn't reprocess every tick for a situation that can't change on
    // its own.
    log.warn({ chronicId: row.id }, "Chronic refill due but customer has no phone on file — skipping reminder and standing order");
  } else {
    await enqueueAndSendNow(
      {
        triggerType: "refill_reminder",
        category: "transactional",
        templateKey: "whatsapp_template_refill_reminder",
        triggerEnabledSettingKey: "whatsapp_trigger_refill_reminder_enabled",
        recipientCustomerId: row.customer_id,
        recipientPhone: row.customer_phone,
        referenceType: "chronic_medication",
        referenceId: row.id,
        payload: { customerName: row.customer_name, productName: row.product_name, exhaustionDate: row.expected_exhaustion_date },
      },
      log
    );

    if (row.standing_order_enabled) {
      const actorId = await getSystemActorUserId();
      if (actorId) {
        await createRequest({
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          productId: row.product_id,
          freeTextItem: null,
          quantityRequestedUnits: row.last_purchase_quantity_base_units,
          quantityRequestedNote: null,
          urgency: "normal",
          hasPrescriptionInHand: false,
          expectedDate: null,
          note: "Standing order — chronic refill, auto-created (Section 9A.3)",
          loggedBy: actorId,
          deviceId: "system-poller",
          source: "automated",
        });
      } else {
        log.warn({ chronicId: row.id }, "Could not auto-create standing order — no active Owner account to attribute it to");
      }
    }
  }

  await db.query(`UPDATE chronic_medications SET reminder_sent_for_exhaustion_date = $1 WHERE id = $2`, [row.expected_exhaustion_date, row.id]);
}

export async function sendDueRefillReminders(log: MinimalLogger): Promise<{ processed: number }> {
  const db = requirePool();
  const reminderDaysBefore = await getSetting("refill_reminder_days_before", 3);

  const { rows } = await db.query(
    `SELECT cm.id FROM chronic_medications cm
     WHERE cm.status = 'active'
       AND cm.expected_exhaustion_date IS NOT NULL
       AND cm.expected_exhaustion_date <= (CURRENT_DATE + ($1 || ' days')::interval)::date
       AND cm.reminder_sent_for_exhaustion_date IS DISTINCT FROM cm.expected_exhaustion_date`,
    [reminderDaysBefore]
  );

  for (const { id } of rows) {
    const { rows: rowData } = await db.query(REMINDER_ROW_QUERY, [id]);
    if (rowData[0]) await processReminderRow(rowData[0], log);
  }
  return { processed: rows.length };
}

// The refill-due screen's "Remind now" button — a human is waiting on
// this one, so it sends immediately rather than for the next poller
// tick, same "a human clicked, do it inline" reasoning as POS's manual
// WhatsApp resend and the shared-inbox reply.
export async function sendReminderNow(chronicId: string, log: MinimalLogger): Promise<void> {
  const { rows } = await requirePool().query(REMINDER_ROW_QUERY, [chronicId]);
  if (!rows[0]) throw new ChronicError("not_found");
  await processReminderRow(rows[0], log);
}

async function getSystemActorUserId(): Promise<string | null> {
  const { rows } = await requirePool().query(`SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1`);
  return rows[0]?.id ?? null;
}

// Section 9A.3's patient profile: current chronic medications plus real
// purchase history for each (dates/quantities, not a synthesized
// "adherence score") — the gaps between real purchase dates against the
// expected cycle length are visible enough on their own for a human to
// read as an adherence pattern, without this build inventing a scoring
// algorithm nothing in the spec asked for.
export async function getPatientProfile(customerId: string) {
  const { rows: medications } = await requirePool().query(
    `SELECT cm.*, p.name AS product_name, p.pack_size, p.base_unit, pr.name AS prescriber_name
     FROM chronic_medications cm
     JOIN products p ON p.id = cm.product_id
     LEFT JOIN prescribers pr ON pr.id = cm.prescriber_id
     WHERE cm.customer_id = $1
     ORDER BY cm.status = 'active' DESC, cm.expected_exhaustion_date ASC`,
    [customerId]
  );

  for (const m of medications) {
    const { rows: history } = await requirePool().query(
      `SELECT s.business_date, SUM(sl.quantity_base_units)::int AS quantity_base_units
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.customer_id = $1 AND sl.product_id = $2 AND s.status = 'completed'
       GROUP BY s.id, s.business_date
       ORDER BY s.business_date DESC
       LIMIT 12`,
      [customerId, m.product_id]
    );
    (m as any).purchase_history = history;
  }

  return medications;
}
