import { pool } from "../db.js";
import type { PoolClient } from "pg";
import { allocateFefo, InsufficientStockError } from "../domain/fefo.js";
import { sortByWalkPath, type WalkPathBin } from "../domain/walk-path.js";
import { createSale, ValidationError as SaleValidationError, type SaleLineInput } from "./sales.js";
import { enqueueNotification } from "../domain/notifications.js";
import { findSubstitutesForProduct } from "./orders.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class PickingError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

// Section 7: "The app selects the batch, the picker does not... Sort
// pick sequence by bin walk path." Runs FEFO once per resolved order
// line and pins the result into `order_pick_lines` so the eventual
// invoice (Section 6A.8: "generated at pack time") reuses exactly the
// batch a picker actually scanned, never a fresh FEFO re-run that could
// silently disagree with what physically left the shelf.
export async function startPicking(orderId: string, actorUserId: string) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRows[0];
    if (!order) throw new PickingError("order_not_found");
    if (order.status !== "customer_confirmed") throw new PickingError("not_confirmed");

    // Section 7A.4: "the order sits in awaiting_prescription until a
    // pharmacist marks the prescription verified" — checked here, at the
    // moment picking would actually start, not earlier.
    if (order.rx_required && !order.rx_verified) {
      await client.query(`UPDATE orders SET status = 'awaiting_prescription', updated_at = now() WHERE id = $1`, [orderId]);
      await client.query("COMMIT");
      return { status: "awaiting_prescription" as const };
    }

    const { rows: lines } = await client.query(
      `SELECT id, product_id, quantity_confirmed_units FROM order_lines
       WHERE order_id = $1 AND line_status IN ('matched', 'substituted') AND quantity_confirmed_units > 0`,
      [orderId]
    );
    if (lines.length === 0) throw new PickingError("no_lines_to_pick");

    const pickLineIds: string[] = [];
    for (const line of lines) {
      let allocations;
      try {
        allocations = await allocateFefo(line.product_id, line.quantity_confirmed_units, client);
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          throw new PickingError("insufficient_stock", { orderLineId: line.id, available: err.available, requested: err.requested });
        }
        throw err;
      }
      for (const alloc of allocations) {
        const { rows } = await client.query(
          `INSERT INTO order_pick_lines (order_id, order_line_id, product_id, batch_id, bin_id, batch_no, expiry_date, quantity_base_units, walk_sequence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0) RETURNING id`,
          [orderId, line.id, line.product_id, alloc.batchId, alloc.binId, alloc.batchNo, alloc.expiryDate, alloc.quantity]
        );
        pickLineIds.push(rows[0].id);
      }
    }

    await assignWalkSequence(client, orderId);

    await client.query(`UPDATE orders SET status = 'picking', pick_started_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
    await client.query("COMMIT");
    return { status: "picking" as const, pickLineCount: pickLineIds.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assignWalkSequence(client: PoolClient, orderId: string) {
  const { rows } = await client.query(
    `SELECT pl.id AS pick_line_id, b.id AS bin_id, b.aisle, b.bay, b.position, b.zone, b.code
     FROM order_pick_lines pl JOIN bins b ON b.id = pl.bin_id
     WHERE pl.order_id = $1`,
    [orderId]
  );
  const withBin: (WalkPathBin & { pickLineId: string })[] = rows.map((r: any) => ({
    pickLineId: r.pick_line_id, binId: r.bin_id, aisle: r.aisle, bay: r.bay, position: r.position, zone: r.zone, code: r.code,
  }));
  const sorted = sortByWalkPath(withBin);
  for (let i = 0; i < sorted.length; i++) {
    await client.query(`UPDATE order_pick_lines SET walk_sequence = $1 WHERE id = $2`, [i + 1, sorted[i]!.pickLineId]);
  }
}

// Section 7: "make them scan or confirm it" — the picker's scan input
// (a USB scanner behaves as a keyboard, same as Section 6A.1) is checked
// against the batch this pick line actually expects.
export async function confirmPickLine(pickLineId: string, scannedBatchNo: string) {
  const db = requirePool();
  const { rows } = await db.query(`SELECT batch_no FROM order_pick_lines WHERE id = $1`, [pickLineId]);
  if (!rows[0]) throw new PickingError("pick_line_not_found");
  if (rows[0].batch_no !== scannedBatchNo.trim()) throw new PickingError("batch_mismatch", { expected: rows[0].batch_no });
  await db.query(`UPDATE order_pick_lines SET scanned_confirmed = true, scanned_at = now() WHERE id = $1`, [pickLineId]);
}

// Section 7: "Short-pick handling: picker marks short -> app immediately
// checks substitute_group_id for an in-stock generic." Returns
// candidates; the actual substitution call is a separate, explicit step
// (Section 7: "prompts Manager for a substitution call") — this build
// doesn't gate that on role beyond ordinary staff auth, since there's no
// distinct Manager-approval workflow elsewhere in this build either.
export async function markPickLineShort(pickLineId: string, input: { actualFound: number; shortReason: string }) {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT pl.*, ol.id AS order_line_id FROM order_pick_lines pl JOIN order_lines ol ON ol.id = pl.order_line_id WHERE pl.id = $1`,
    [pickLineId]
  );
  const pickLine = rows[0];
  if (!pickLine) throw new PickingError("pick_line_not_found");
  if (input.actualFound < 0 || input.actualFound > pickLine.quantity_base_units) throw new PickingError("invalid_quantity");

  await db.query(
    `UPDATE order_pick_lines SET short_picked = true, short_reason = $1, actual_quantity_found = $2, scanned_confirmed = true, scanned_at = now() WHERE id = $3`,
    [input.shortReason, input.actualFound, pickLineId]
  );

  const shortfall = pickLine.quantity_base_units - input.actualFound;
  const substitutes = shortfall > 0 ? await findSubstitutesForProduct(pickLine.product_id) : [];
  return { shortfall, substitutes };
}

// Section 7: substitution call accepted — allocates the shortfall
// against the substitute product and appends fresh pick lines (walk
// sequence recomputed since these are picked out of the original order).
export async function applySubstituteForShortfall(orderId: string, originalPickLineId: string, newProductId: string, shortfallQuantity: number) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: origRows } = await client.query(`SELECT order_line_id, product_id FROM order_pick_lines WHERE id = $1`, [originalPickLineId]);
    const orig = origRows[0];
    if (!orig) throw new PickingError("pick_line_not_found");

    let allocations;
    try {
      allocations = await allocateFefo(newProductId, shortfallQuantity, client);
    } catch (err) {
      if (err instanceof InsufficientStockError) throw new PickingError("insufficient_stock", { available: err.available, requested: err.requested });
      throw err;
    }
    for (const alloc of allocations) {
      await client.query(
        `INSERT INTO order_pick_lines (order_id, order_line_id, product_id, batch_id, bin_id, batch_no, expiry_date, quantity_base_units, walk_sequence, scanned_confirmed, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,true,now())`,
        [orderId, orig.order_line_id, newProductId, alloc.batchId, alloc.binId, alloc.batchNo, alloc.expiryDate, alloc.quantity]
      );
    }
    await client.query(
      `UPDATE order_lines SET product_id = $1, line_status = 'substituted', substituted_from_product_id = $2 WHERE id = $3`,
      [newProductId, orig.product_id, orig.order_line_id]
    );
    await assignWalkSequence(client, orderId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function completePicking(orderId: string) {
  const db = requirePool();
  const { rows: unconfirmed } = await db.query(
    `SELECT id FROM order_pick_lines WHERE order_id = $1 AND scanned_confirmed = false`,
    [orderId]
  );
  if (unconfirmed.length > 0) throw new PickingError("lines_not_confirmed", { count: unconfirmed.length });
  await db.query(`UPDATE orders SET status = 'picked', pick_completed_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
}

// Section 7: "Scan each picked item at the packing bench against the
// pick list (blind verify — do not show expected qty until scanned)."
// Hiding the expected quantity is a client-side UI concern; the backend
// just confirms the scanned product genuinely matches this pick line.
export async function packScan(pickLineId: string, scannedProductId: string) {
  const db = requirePool();
  const { rows } = await db.query(`SELECT product_id FROM order_pick_lines WHERE id = $1`, [pickLineId]);
  if (!rows[0]) throw new PickingError("pick_line_not_found");
  if (rows[0].product_id !== scannedProductId) throw new PickingError("product_mismatch");
  await db.query(`UPDATE order_pick_lines SET packed_confirmed = true, packed_at = now() WHERE id = $1`, [pickLineId]);
}

// Section 6A.8: "the invoice generated at pack time." Reuses createSale
// (channel='delivery') with each pick line's batch pinned via the same
// manual-batch-override path Section 6A.2 already defines for POS, so
// the sale's batch/expiry data matches exactly what was scanned off the
// shelf and at the packing bench, not a fresh FEFO guess.
export async function completePacking(orderId: string, actorUserId: string, deviceId: string) {
  const db = requirePool();
  const { rows: orderRows } = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderRows[0];
  if (!order) throw new PickingError("order_not_found");
  if (order.status !== "picked") throw new PickingError("not_picked");

  const { rows: pickLines } = await db.query(`SELECT * FROM order_pick_lines WHERE order_id = $1`, [orderId]);
  const unpacked = pickLines.filter((pl: any) => !pl.packed_confirmed);
  if (unpacked.length > 0) throw new PickingError("lines_not_packed", { count: unpacked.length });

  const saleLines: SaleLineInput[] = [];
  let shortfallLineIds = new Set<string>();
  for (const pl of pickLines) {
    const effectiveQty = pl.actual_quantity_found ?? pl.quantity_base_units;
    if (pl.short_picked && effectiveQty < pl.quantity_base_units) shortfallLineIds.add(pl.order_line_id);
    if (effectiveQty <= 0) continue;
    saleLines.push({
      productId: pl.product_id,
      quantityBaseUnits: effectiveQty,
      discountPercent: 0,
      discountValue: null,
      manualBatchId: pl.batch_id,
      manualBatchOverrideReason: "Delivery order pick list (Section 7) — batch pinned at picking, not re-allocated at pack time.",
    });
  }
  if (saleLines.length === 0) throw new PickingError("nothing_to_invoice");

  const isPartial = shortfallLineIds.size > 0;

  let sale;
  try {
    sale = await createSale({
      channel: "delivery",
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      lines: saleLines,
      billDiscountValue: 0,
      roundOff: 0,
      tenders: [],
      codPending: true, // Section 8: COD — the rider collects the real tender on delivery, not at pack time. M11 will settle this.
      prescriberDetails: null,
      fulfillsRequestId: null,
      createdBy: actorUserId,
      deviceId,
      source: "web",
    });
  } catch (err) {
    if (err instanceof SaleValidationError) throw new PickingError(`sale_${err.code}`, err.details);
    throw err;
  }

  const newStatus = isPartial ? "partially_available" : "packed";
  await db.query(
    `UPDATE orders SET status = $1, sale_id = $2, is_partial = $3, pack_completed_at = now(), updated_at = now() WHERE id = $4`,
    [newStatus, sale.id, isPartial, orderId]
  );

  if (isPartial && order.customer_phone) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await enqueueNotification(client, {
        triggerType: "order_partially_available",
        category: "transactional",
        templateKey: "whatsapp_template_order_partial",
        triggerEnabledSettingKey: "whatsapp_trigger_order_partial_enabled",
        recipientCustomerId: order.customer_id,
        recipientPhone: order.customer_phone,
        referenceType: "order",
        referenceId: orderId,
        payload: { orderNumber: order.order_number, customerName: order.customer_name, unavailableCount: shortfallLineIds.size },
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { saleId: sale.id, billNumber: sale.billNumber, isPartial };
}
