import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface BatchCostFields {
  rateBeforeDiscount: number | null;
  discountValue: number | null;
  apportionedCharges: number | null;
  freeQuantityBaseUnits: number;
  effectiveCostPerBaseUnit: number | null;
  costUnknown: boolean;
}

// Find the existing batch for (product, batch_no) or create it. If it
// already exists, its cost fields are left untouched — the doc's model
// stores one effective cost per batch, established at its first receipt;
// this build doesn't attempt cost-blending across repeat receipts of the
// same declared batch number, which the brief doesn't specify a rule for
// (see DECISIONS.md).
export async function findOrCreateBatch(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  productId: string,
  batchNo: string,
  expiryDate: string,
  mrp: number,
  cost: BatchCostFields
): Promise<{ id: string; isNew: boolean }> {
  const existing = await client.query(`SELECT id FROM batches WHERE product_id = $1 AND batch_no = $2`, [productId, batchNo]);
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, isNew: false };
  }
  const { rows } = await client.query(
    `INSERT INTO batches
       (product_id, batch_no, expiry_date, mrp, cost_unknown, rate_before_discount, discount_value,
        apportioned_charges, free_quantity_base_units, effective_cost_per_base_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      productId, batchNo, expiryDate, mrp, cost.costUnknown, cost.rateBeforeDiscount, cost.discountValue,
      cost.apportionedCharges, cost.freeQuantityBaseUnits, cost.effectiveCostPerBaseUnit,
    ]
  );
  return { id: rows[0].id, isNew: true };
}

export async function findStagingBin(zonePrefix: "IN" = "IN"): Promise<{ id: string; code: string } | null> {
  const { rows } = await requirePool().query(`SELECT id, code FROM bins WHERE zone = $1 AND status = 'active' ORDER BY code LIMIT 1`, [zonePrefix]);
  return rows[0] ?? null;
}
