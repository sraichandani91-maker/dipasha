import { pool } from "../db.js";
import { getSetting } from "../repo/settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface FefoAllocation {
  batchId: string;
  binId: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
}

export class InsufficientStockError extends Error {
  constructor(public available: number, public requested: number) {
    super(`only ${available} available, ${requested} requested`);
  }
}

/**
 * First-Expiry-First-Out batch selection (Section 6A.2, Section 7): the
 * system picks the batch, never the biller. Blocked batches (quarantine)
 * and batches inside the near-expiry pick-block window (Section 9) are
 * excluded entirely — sellable stock only. If satisfying the requested
 * quantity needs more than one batch, this returns one allocation per
 * batch — the caller prints one sub-line per batch (Section 6A.2).
 */
export async function allocateFefo(productId: string, quantityNeeded: number): Promise<FefoAllocation[]> {
  const db = requirePool();
  const blockDays = await getSetting("near_expiry_pick_block_days", 30);

  const { rows } = await db.query(
    `
    SELECT b.id AS batch_id, b.batch_no, b.expiry_date, s.bin_id, s.quantity_base_units
    FROM stock s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.product_id = $1
      AND s.quantity_base_units > 0
      AND b.blocked = false
      AND b.expiry_date > (CURRENT_DATE + ($2 || ' days')::interval)
    ORDER BY b.expiry_date ASC
    `,
    [productId, blockDays]
  );

  const allocations: FefoAllocation[] = [];
  let remaining = quantityNeeded;
  let totalAvailable = 0;
  for (const row of rows) {
    totalAvailable += row.quantity_base_units;
  }
  if (totalAvailable < quantityNeeded) {
    throw new InsufficientStockError(totalAvailable, quantityNeeded);
  }

  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, row.quantity_base_units);
    allocations.push({ batchId: row.batch_id, binId: row.bin_id, batchNo: row.batch_no, expiryDate: row.expiry_date, quantity: take });
    remaining -= take;
  }
  return allocations;
}

// Manual batch override (Section 6A.2: "permitted but requires a reason
// and is logged"). Still excludes blocked batches — an override changes
// WHICH sellable batch is picked, never makes an unsellable one sellable.
export async function getSpecificBatchStock(productId: string, batchId: string): Promise<{ binId: string; available: number } | null> {
  const db = requirePool();
  const { rows } = await db.query(
    `
    SELECT s.bin_id, s.quantity_base_units FROM stock s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.product_id = $1 AND s.batch_id = $2 AND b.blocked = false AND s.quantity_base_units > 0
    `,
    [productId, batchId]
  );
  if (rows.length === 0) return null;
  return { binId: rows[0].bin_id, available: rows[0].quantity_base_units };
}
