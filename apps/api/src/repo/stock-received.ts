import { pool } from "../db.js";
import { findOrCreateBatch, findStagingBin } from "./batches.js";
import { suggestPutawayBin } from "../domain/putaway-suggestion.js";
import { checkCallbackMatches } from "./callback.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export type StockReceivedReasonCode =
  | "free_sample" | "scheme_goods" | "opening_stock" | "replacement_no_invoice" | "transfer_in" | "found_in_count" | "other";

export interface CreateStockReceivedInput {
  productId: string;
  batchNo: string;
  expiryDate: string;
  mrp: number;
  quantityBaseUnits: number;
  reasonCode: StockReceivedReasonCode;
  note: string;
  sourceOrVendorName: string | null;
  estimatedValue: number | null; // Section 6.4: optional notional value so stock valuation stays meaningful
  createdBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
}

// Mirror of GST purchase entry but deliberately simpler — no invoice
// fields, no GST split, no landed-cost apportionment (Section 6.4).
export async function createStockReceived(input: CreateStockReceivedInput) {
  const db = requirePool();
  const stagingBin = await findStagingBin();
  if (!stagingBin) throw new Error("no active IN-* bin exists");

  const costUnknown = input.estimatedValue === null;
  const effectiveCostPerBaseUnit = input.estimatedValue !== null ? input.estimatedValue / input.quantityBaseUnits : null;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const batch = await findOrCreateBatch(client, input.productId, input.batchNo, input.expiryDate, input.mrp, {
      rateBeforeDiscount: null,
      discountValue: null,
      apportionedCharges: null,
      freeQuantityBaseUnits: 0,
      effectiveCostPerBaseUnit,
      costUnknown,
    });

    const { rows: movementRows } = await client.query(
      `INSERT INTO movement_ledger
         (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, source, actor_user_id, device_id)
       VALUES ('stock_received', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.productId, batch.id, stagingBin.id, input.quantityBaseUnits, input.reasonCode,
        [input.note, input.sourceOrVendorName ? `Source: ${input.sourceOrVendorName}` : null].filter(Boolean).join(" — "),
        input.source, input.createdBy, input.deviceId]
    );

    const productRow = await client.query(`SELECT is_cold_chain, schedule_category FROM products WHERE id = $1`, [input.productId]);
    const requiredZone = productRow.rows[0]?.is_cold_chain ? "CC" : productRow.rows[0]?.schedule_category === "H1" ? "SH" : null;
    const suggested = await suggestPutawayBin(input.productId, requiredZone);

    const { rows: taskRows } = await client.query(
      `INSERT INTO putaway_tasks (product_id, batch_id, staging_bin_id, quantity_base_units, suggested_bin_id, reference_type, reference_id)
       VALUES ($1,$2,$3,$4,$5,'stock_received',$6) RETURNING id`,
      [input.productId, batch.id, stagingBin.id, input.quantityBaseUnits, suggested?.id ?? null, movementRows[0].id]
    );

    await client.query("COMMIT");
    await checkCallbackMatches([input.productId]); // Section 6B.4
    return { movementId: movementRows[0].id, batchId: batch.id, putawayTaskId: taskRows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
