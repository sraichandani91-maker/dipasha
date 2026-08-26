import { pool } from "../db.js";
import { getSetting } from "./settings.js";
import { allocateFefo, InsufficientStockError } from "../domain/fefo.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 6B.4: "When a GRN is committed (any inbound type), the system
// checks every on_po and open request for those SKUs." Called from both
// the GST purchase and stock_received commit paths — same check either
// way, since the callback loop doesn't care how the stock arrived.
export async function checkCallbackMatches(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  await requirePool().query(
    `UPDATE customer_requests
     SET status = 'received', updated_at = now()
     WHERE product_id = ANY($1::uuid[]) AND status IN ('open', 'on_po')`,
    [productIds]
  );
}

// Lazy expiry sweep — there's no background job runner in this build
// yet, so reservation expiry is applied whenever the queue is read
// rather than on a timer. The stock itself is already excluded from
// sellable_stock the moment reserved_until passes (the view's own WHERE
// clause), so a walk-in can never buy reserved stock even before this
// sweep runs; this only catches up the customer_requests.status side
// (Section 6B.4: "auto-releases the stock and marks the request lapsed").
export async function sweepExpiredReservations(): Promise<void> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: expired } = await client.query(
      `SELECT id, customer_request_id FROM stock_reservations
       WHERE released_at IS NULL AND reserved_until <= now() FOR UPDATE`
    );
    for (const r of expired) {
      await client.query(`UPDATE stock_reservations SET released_at = now(), released_reason = 'expired' WHERE id = $1`, [r.id]);
      await client.query(
        `UPDATE customer_requests SET status = 'lapsed', updated_at = now() WHERE id = $1 AND status = 'customer_notified'`,
        [r.customer_request_id]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export class ReservationError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Section 6B.4: "the system offers to reserve the stock against that
// customer for a configurable window (default 48 hours)." Reserves via
// the same FEFO allocation everything else uses, so the batch actually
// held is the one that would actually be sold.
export async function reserveForRequest(requestId: string, actorUserId: string, deviceId: string) {
  const db = requirePool();
  const { rows: reqRows } = await db.query(`SELECT * FROM customer_requests WHERE id = $1`, [requestId]);
  const request = reqRows[0];
  if (!request) throw new ReservationError("request_not_found");
  if (!request.product_id) throw new ReservationError("no_linked_product");
  const qty = request.quantity_requested_units ?? 1;

  let allocations;
  try {
    allocations = await allocateFefo(request.product_id, qty);
  } catch (err) {
    if (err instanceof InsufficientStockError) throw new ReservationError("insufficient_stock");
    throw err;
  }

  const windowHours = await getSetting("stock_reservation_hours", 48);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const a of allocations) {
      await client.query(
        `INSERT INTO stock_reservations (product_id, batch_id, bin_id, quantity_base_units, customer_request_id, reserved_until, created_by, device_id)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval, $7, $8)`,
        [request.product_id, a.batchId, a.binId, a.quantity, requestId, windowHours, actorUserId, deviceId]
      );
    }
    await client.query(`UPDATE customer_requests SET status = 'customer_notified', updated_at = now() WHERE id = $1`, [requestId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { reservedUntilHours: windowHours };
}
