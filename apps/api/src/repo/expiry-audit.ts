import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface ExpiryAuditRow {
  batchId: string;
  productId: string;
  productName: string;
  batchNo: string;
  expiryDate: string;
  daysToExpiry: number;
  bucket: "expired" | "30" | "60" | "90";
  totalQuantityBaseUnits: number;
  valueAtRiskMrp: number;
  blocked: boolean;
}

/**
 * Section 9: "rolling report: everything expiring in 90 / 60 / 30
 * days." Buckets by whichever window a batch's days-to-expiry falls
 * inside — a batch with 25 days left is "30", not counted again in
 * "60"/"90", so the three bucket totals don't overlap.
 */
export async function getExpiryAudit(): Promise<ExpiryAuditRow[]> {
  const { rows } = await requirePool().query(`
    SELECT
      b.id AS batch_id, b.product_id, p.name AS product_name, b.batch_no, b.expiry_date, b.blocked,
      (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
      p.pack_size, b.mrp,
      SUM(s.quantity_base_units)::int AS total_quantity_base_units
    FROM batches b
    JOIN products p ON p.id = b.product_id
    JOIN stock s ON s.batch_id = b.id
    WHERE b.expiry_date <= CURRENT_DATE + interval '90 days'
    GROUP BY b.id, p.id, b.mrp, p.pack_size
    HAVING SUM(s.quantity_base_units) > 0
    ORDER BY b.expiry_date ASC
  `);

  return rows.map((r) => {
    const days = Number(r.days_to_expiry);
    const bucket: ExpiryAuditRow["bucket"] = days < 0 ? "expired" : days <= 30 ? "30" : days <= 60 ? "60" : "90";
    const mrpPerBaseUnit = Number(r.mrp) / r.pack_size;
    return {
      batchId: r.batch_id,
      productId: r.product_id,
      productName: r.product_name,
      batchNo: r.batch_no,
      expiryDate: r.expiry_date,
      daysToExpiry: days,
      bucket,
      totalQuantityBaseUnits: r.total_quantity_base_units,
      valueAtRiskMrp: Math.round(r.total_quantity_base_units * mrpPerBaseUnit * 100) / 100,
      blocked: r.blocked,
    };
  });
}

export class ExpiryAuditError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// One-tap action (Section 9): block the batch immediately (stops FEFO
// picking that same second — no separate step needed, allocateFefo
// already excludes blocked batches) and create one put-away task per
// bin currently holding it, so a human physically moves it to QC-01 and
// confirms — reusing the same task/confirm machinery M3 already built,
// rather than silently teleporting stock in the ledger (Section 10.2's
// own rule for any bin-to-bin move).
export async function moveBatchToQuarantine(batchId: string, actorUserId: string, deviceId: string) {
  const db = requirePool();
  const { rows: batchRows } = await db.query(`SELECT id, product_id, blocked FROM batches WHERE id = $1`, [batchId]);
  const batch = batchRows[0];
  if (!batch) throw new ExpiryAuditError("batch_not_found");

  const { rows: qcBinRows } = await db.query(
    `SELECT b.id FROM bins b LEFT JOIN stock s ON s.bin_id = b.id
     WHERE b.zone = 'QC' AND b.status = 'active'
     GROUP BY b.id ORDER BY COALESCE(SUM(s.quantity_base_units), 0) ASC LIMIT 1`
  );
  const qcBin = qcBinRows[0];
  if (!qcBin) throw new ExpiryAuditError("no_qc_bin_configured");

  const { rows: stockRows } = await db.query(
    `SELECT bin_id, quantity_base_units FROM stock WHERE batch_id = $1 AND quantity_base_units > 0`,
    [batchId]
  );
  if (stockRows.length === 0) throw new ExpiryAuditError("no_stock_to_move");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!batch.blocked) {
      await client.query(`UPDATE batches SET blocked = true, blocked_reason = 'near_expiry_return_to_vendor' WHERE id = $1`, [batchId]);
    }
    let tasksCreated = 0;
    for (const s of stockRows) {
      if (s.bin_id === qcBin.id) continue; // already sitting in the QC bin
      await client.query(
        `INSERT INTO putaway_tasks (product_id, batch_id, staging_bin_id, quantity_base_units, suggested_bin_id, reference_type, reference_id)
         VALUES ($1,$2,$3,$4,$5,'expiry_audit',$2)`,
        [batch.product_id, batchId, s.bin_id, s.quantity_base_units, qcBin.id]
      );
      tasksCreated++;
    }
    await client.query("COMMIT");
    void actorUserId; // no actor column on putaway_tasks itself — captured when a human confirms it, same as every other put-away task
    void deviceId;
    return { tasksCreated };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
