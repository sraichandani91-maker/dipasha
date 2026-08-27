import { pool } from "../db.js";
import { enqueueNotification } from "../domain/notifications.js";
import { recordManualOverride, type WebManualReasonCode } from "./manual-overrides.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class DeliveryError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

const FAILURE_REASON_CODES = ["customer_unavailable", "wrong_address", "refused", "payment_failed", "rx_invalid"] as const;
export type DeliveryFailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

// Section 3: Store Manager does "order assignment, rider management."
// Section 8: "Rider logs in, sees assigned trips only" — a "trip" here
// is every packed order sharing the same delivery_batch_id (Section 7's
// batching), so assigning a rider to one order in a batch assigns the
// whole trip at once; a solo/cold-chain order (no batch) is its own trip.
export async function assignRider(orderId: string, riderId: string, actorUserId: string) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: riderRows } = await client.query(`SELECT id, role, status FROM users WHERE id = $1 FOR UPDATE`, [riderId]);
    const rider = riderRows[0];
    if (!rider || rider.role !== "rider") throw new DeliveryError("not_a_rider");
    if (rider.status !== "active") throw new DeliveryError("rider_inactive");

    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRows[0];
    if (!order) throw new DeliveryError("order_not_found");
    if (!["packed", "partially_available"].includes(order.status)) throw new DeliveryError("not_packed");

    const orderIds = [orderId];
    if (order.delivery_batch_id) {
      const { rows: siblings } = await client.query(
        `SELECT id FROM orders WHERE delivery_batch_id = $1 AND id <> $2 AND status IN ('packed','partially_available') AND rider_id IS NULL FOR UPDATE`,
        [order.delivery_batch_id, orderId]
      );
      orderIds.push(...siblings.map((r: any) => r.id));
    }

    await client.query(
      `UPDATE orders SET status = 'assigned', rider_id = $1, assigned_at = now(), assigned_by = $2, updated_at = now() WHERE id = ANY($3::uuid[])`,
      [riderId, actorUserId, orderIds]
    );
    await client.query("COMMIT");
    return { assignedOrderIds: orderIds };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Section 10.2: "Force-reassign an order to a different rider." Only the
// single order given, unlike assignRider's whole-trip fan-out — a force
// reassignment is a dispatch exception (a rider called in sick, a
// delivery is stuck), not the normal batch-assignment path, so it
// shouldn't silently drag sibling orders along with it. Once an order
// has already reached out_for_delivery this only corrects the system
// record — it doesn't move a physical package the original rider is
// still holding, and the note is required precisely so that real-world
// coordination is visible, not implied by the UI.
export async function reassignRider(orderId: string, newRiderId: string, note: string, actorUserId: string): Promise<void> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: riderRows } = await client.query(`SELECT id, role, status FROM users WHERE id = $1 FOR UPDATE`, [newRiderId]);
    const rider = riderRows[0];
    if (!rider || rider.role !== "rider") throw new DeliveryError("not_a_rider");
    if (rider.status !== "active") throw new DeliveryError("rider_inactive");

    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRows[0];
    if (!order) throw new DeliveryError("order_not_found");
    if (!["assigned", "out_for_delivery"].includes(order.status)) throw new DeliveryError("not_assigned_status", { status: order.status });
    if (order.rider_id === newRiderId) throw new DeliveryError("same_rider");

    await client.query(`UPDATE orders SET rider_id = $1, updated_at = now() WHERE id = $2`, [newRiderId, orderId]);
    await client.query(
      `INSERT INTO order_reassignments (order_id, old_rider_id, new_rider_id, note, actor_user_id) VALUES ($1,$2,$3,$4,$5)`,
      [orderId, order.rider_id, newRiderId, note, actorUserId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listRiderOrders(riderId: string) {
  const { rows } = await requirePool().query(
    `SELECT id, order_number, status, customer_name, customer_phone, delivery_address, delivery_pincode,
       delivery_batch_id, sale_id, assigned_at, handover_scanned_at, reached_at
     FROM orders WHERE rider_id = $1 AND status IN ('assigned', 'out_for_delivery')
     ORDER BY assigned_at`,
    [riderId]
  );
  return rows;
}

// Section 8: "rider scans the order label barcode at the store — this
// is the single source of truth for handover time." No separate label
// infrastructure exists — `order_number` is already unique and printed
// on the packed order label the same way `bill_number` prints on a POS
// receipt, so it doubles as the scan target here.
export async function handoverScan(
  scannedOrderNumber: string,
  riderId: string,
  gps: { lat: number; lng: number } | null,
  override: { reasonCode: WebManualReasonCode; note: string; deviceId: string }
) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE order_number = $1 FOR UPDATE`, [scannedOrderNumber]);
    const order = orderRows[0];
    if (!order) throw new DeliveryError("order_not_found");
    if (order.rider_id !== riderId) throw new DeliveryError("not_assigned_to_you");
    if (order.status !== "assigned") throw new DeliveryError("not_assigned_status", { status: order.status });

    await client.query(`UPDATE orders SET status = 'out_for_delivery', handover_scanned_at = now(), updated_at = now() WHERE id = $1`, [order.id]);
    // Section 10.1: "Rider handover" is one of the five listed
    // scan-backed actions — same no-separate-scanning-client reasoning
    // as put-away/pick/pack, so every handover here carries a mandatory
    // reason code and note.
    await recordManualOverride(
      { action: "rider_handover", referenceType: "order", referenceId: order.id, reasonCode: override.reasonCode, note: override.note, actorUserId: riderId, deviceId: override.deviceId },
      client
    );
    if (gps) {
      await client.query(
        `INSERT INTO order_gps_pings (order_id, rider_id, lat, lng, kind) VALUES ($1,$2,$3,$4,'handover')`,
        [order.id, riderId, gps.lat, gps.lng]
      );
    }

    if (order.customer_phone) {
      const { rows: riderRows } = await client.query(`SELECT name, phone FROM users WHERE id = $1`, [riderId]);
      const rider = riderRows[0];
      await enqueueNotification(client, {
        triggerType: "order_out_for_delivery",
        category: "transactional",
        templateKey: "whatsapp_template_out_for_delivery",
        triggerEnabledSettingKey: "whatsapp_trigger_out_for_delivery_enabled",
        recipientCustomerId: order.customer_id,
        recipientPhone: order.customer_phone,
        referenceType: "order",
        referenceId: order.id,
        payload: { orderNumber: order.order_number, customerName: order.customer_name, riderName: rider?.name ?? "Rider", riderPhone: rider?.phone ?? "" },
      });
    }

    await client.query("COMMIT");
    return { orderId: order.id, orderNumber: order.order_number };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markReached(orderId: string, riderId: string) {
  const db = requirePool();
  const { rows } = await db.query(`SELECT status, rider_id FROM orders WHERE id = $1`, [orderId]);
  const order = rows[0];
  if (!order) throw new DeliveryError("order_not_found");
  if (order.rider_id !== riderId) throw new DeliveryError("not_assigned_to_you");
  if (order.status !== "out_for_delivery") throw new DeliveryError("not_out_for_delivery");
  await db.query(`UPDATE orders SET reached_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
}

// Section 8: "Capture GPS ping at handover, at delivery, and every 60s
// in-transit." The 60s cadence is a client responsibility (the rider's
// browser tab calling this while an order is out for delivery) — same
// "works while the tab is open" honesty as M5's daily review alarm;
// there's no always-on background tracking without a native app.
export async function recordGpsPing(orderId: string, riderId: string, lat: number, lng: number, kind: "handover" | "in_transit" | "delivered") {
  const db = requirePool();
  const { rows } = await db.query(`SELECT rider_id, status FROM orders WHERE id = $1`, [orderId]);
  const order = rows[0];
  if (!order) throw new DeliveryError("order_not_found");
  if (order.rider_id !== riderId) throw new DeliveryError("not_assigned_to_you");
  await db.query(`INSERT INTO order_gps_pings (order_id, rider_id, lat, lng, kind) VALUES ($1,$2,$3,$4,$5)`, [orderId, riderId, lat, lng, kind]);
}

export interface MarkDeliveredInput {
  tenderType: "cash" | "upi";
  amountCollected: number;
  referenceNumber: string | null;
  deliveryProofNote: string;
  gps: { lat: number; lng: number } | null;
}

// Section 8: "mark delivered (with OTP or signature)." Settles the
// cod_pending tender M10 recorded at pack time into what was actually
// collected — the invoice's tender finally reflects reality instead of
// "not yet collected."
export async function markDelivered(orderId: string, riderId: string, input: MarkDeliveredInput) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRows[0];
    if (!order) throw new DeliveryError("order_not_found");
    if (order.rider_id !== riderId) throw new DeliveryError("not_assigned_to_you");
    if (order.status !== "out_for_delivery") throw new DeliveryError("not_out_for_delivery");
    if (!order.sale_id) throw new DeliveryError("no_sale_on_order");

    const { rows: tenderRows } = await client.query(
      `UPDATE sale_tenders SET tender_type = $1, amount = $2, reference_number = $3
       WHERE sale_id = $4 AND tender_type = 'cod_pending' RETURNING id`,
      [input.tenderType, input.amountCollected, input.referenceNumber, order.sale_id]
    );
    if (tenderRows.length === 0) throw new DeliveryError("no_cod_pending_tender");

    await client.query(
      `UPDATE orders SET status = 'delivered', delivered_at = now(), delivery_proof_note = $1, updated_at = now() WHERE id = $2`,
      [input.deliveryProofNote, orderId]
    );
    if (input.gps) {
      await client.query(`INSERT INTO order_gps_pings (order_id, rider_id, lat, lng, kind) VALUES ($1,$2,$3,$4,'delivered')`, [orderId, riderId, input.gps.lat, input.gps.lng]);
    }
    if (order.customer_phone) {
      await enqueueNotification(client, {
        triggerType: "order_delivered",
        category: "transactional",
        templateKey: "whatsapp_template_delivered",
        triggerEnabledSettingKey: "whatsapp_trigger_delivered_enabled",
        recipientCustomerId: order.customer_id,
        recipientPhone: order.customer_phone,
        referenceType: "order",
        referenceId: orderId,
        payload: { orderNumber: order.order_number, customerName: order.customer_name },
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Section 8: "Failed deliveries generate a return-to-store task -> items
// must be scanned back into their bins, not silently restocked." The
// sale is cancelled immediately (nothing was actually delivered or
// paid for), but the stock movement itself waits for a human to scan
// each item back into a real bin (confirmDeliveryReturn below) — never
// assumed to have silently reappeared on the shelf.
export async function markDeliveryFailed(orderId: string, riderId: string, reasonCode: DeliveryFailureReasonCode, note: string) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRows[0];
    if (!order) throw new DeliveryError("order_not_found");
    if (order.rider_id !== riderId) throw new DeliveryError("not_assigned_to_you");
    if (order.status !== "out_for_delivery") throw new DeliveryError("not_out_for_delivery");
    if (!order.sale_id) throw new DeliveryError("no_sale_on_order");

    const { rows: saleRows } = await client.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [order.sale_id]);
    const sale = saleRows[0];
    if (sale.status !== "cancelled") {
      await client.query(
        `UPDATE sales SET status = 'cancelled', cancelled_reason = $1, cancelled_by = $2, cancelled_at = now() WHERE id = $3`,
        [`Delivery failed: ${reasonCode}`, riderId, order.sale_id]
      );
    }

    const { rows: saleLines } = await client.query(`SELECT * FROM sale_lines WHERE sale_id = $1`, [order.sale_id]);
    for (const sl of saleLines) {
      await client.query(
        `INSERT INTO delivery_return_tasks (order_id, sale_line_id, product_id, batch_id, quantity_base_units, suggested_bin_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, sl.id, sl.product_id, sl.batch_id, sl.quantity_base_units, sl.bin_id]
      );
    }

    await client.query(
      `UPDATE orders SET status = 'delivery_failed', failed_at = now(), delivery_failed_reason_code = $1, delivery_failed_note = $2, updated_at = now() WHERE id = $3`,
      [reasonCode, note, orderId]
    );

    await client.query("COMMIT");
    return { returnTasksCreated: saleLines.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listPendingReturnTasks() {
  const { rows } = await requirePool().query(
    `SELECT rt.*, p.name AS product_name, b.batch_no, b.expiry_date, sb.code AS suggested_bin_code, o.order_number
     FROM delivery_return_tasks rt
     JOIN products p ON p.id = rt.product_id
     JOIN batches b ON b.id = rt.batch_id
     JOIN orders o ON o.id = rt.order_id
     LEFT JOIN bins sb ON sb.id = rt.suggested_bin_id
     WHERE rt.status = 'pending'
     ORDER BY rt.created_at`
  );
  return rows;
}

export class ReturnTaskError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Same scan-to-confirm shape as put-away's confirmPutaway — require the
// real bin code typed/scanned, never accept the suggestion blindly.
export async function confirmDeliveryReturn(taskId: string, scannedBinCode: string, actorUserId: string, deviceId: string, source: "app" | "web" | "web_manual") {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: taskRows } = await client.query(`SELECT * FROM delivery_return_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    const task = taskRows[0];
    if (!task) throw new ReturnTaskError("task_not_found");
    if (task.status !== "pending") throw new ReturnTaskError("already_completed");

    const { rows: binRows } = await client.query(`SELECT id FROM bins WHERE code = $1 AND status = 'active'`, [scannedBinCode]);
    const bin = binRows[0];
    if (!bin) throw new ReturnTaskError("bin_not_found");

    await client.query(
      `INSERT INTO movement_ledger (movement_type, product_id, batch_id, bin_id, quantity_delta, reference_type, reference_id, note, source, actor_user_id, device_id)
       VALUES ('sale_return', $1, $2, $3, $4, 'delivery_return_task', $5, 'Returned to store after failed delivery', $6, $7, $8)`,
      [task.product_id, task.batch_id, bin.id, task.quantity_base_units, taskId, source, actorUserId, deviceId]
    );

    await client.query(
      `UPDATE delivery_return_tasks SET status = 'completed', completed_bin_id = $1, completed_by = $2, completed_device_id = $3, completed_source = $4, completed_at = now() WHERE id = $5`,
      [bin.id, actorUserId, deviceId, source, taskId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Section 8: "end-of-shift cash reconciliation screen showing expected
// vs declared" — same "server-computed, never trusted from the client"
// pattern as the counter's day-close (Section 6A.5).
export async function previewRiderCash(riderId: string, businessDate: string) {
  const { rows } = await requirePool().query(
    `SELECT COALESCE(SUM(st.amount), 0)::numeric AS expected_cash
     FROM orders o JOIN sale_tenders st ON st.sale_id = o.sale_id
     WHERE o.rider_id = $1 AND o.status = 'delivered' AND st.tender_type = 'cash' AND o.delivered_at::date = $2`,
    [riderId, businessDate]
  );
  return { expectedCash: Number(rows[0].expected_cash) };
}

export async function closeRiderShift(riderId: string, businessDate: string, declaredCash: number, note: string | null, actorUserId: string, deviceId: string) {
  const db = requirePool();
  const existing = await db.query(`SELECT id FROM rider_cash_reconciliations WHERE rider_id = $1 AND business_date = $2`, [riderId, businessDate]);
  if (existing.rows.length > 0) throw new DeliveryError("already_closed");

  const { expectedCash } = await previewRiderCash(riderId, businessDate);
  const variance = Math.round((declaredCash - expectedCash) * 100) / 100;

  const { rows } = await db.query(
    `INSERT INTO rider_cash_reconciliations (rider_id, business_date, expected_cash, declared_cash, variance, note, closed_by, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [riderId, businessDate, expectedCash, declaredCash, variance, note, actorUserId, deviceId]
  );
  return { id: rows[0].id, expectedCash, declaredCash, variance };
}

export async function listRiderCashReconciliations(riderId?: string) {
  const { rows } = await requirePool().query(
    riderId
      ? `SELECT rc.*, u.name AS rider_name FROM rider_cash_reconciliations rc JOIN users u ON u.id = rc.rider_id WHERE rc.rider_id = $1 ORDER BY rc.business_date DESC`
      : `SELECT rc.*, u.name AS rider_name FROM rider_cash_reconciliations rc JOIN users u ON u.id = rc.rider_id ORDER BY rc.business_date DESC`,
    riderId ? [riderId] : []
  );
  return rows;
}
