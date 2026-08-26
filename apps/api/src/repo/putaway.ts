import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface PutawayTaskListItem {
  id: string;
  productId: string;
  productName: string;
  batchNo: string;
  expiryDate: string;
  quantityBaseUnits: number;
  stagingBinCode: string;
  suggestedBinCode: string | null;
  isColdChain: boolean;
  scheduleCategory: string;
  createdAt: string;
}

export async function listPendingPutawayTasks(): Promise<PutawayTaskListItem[]> {
  const { rows } = await requirePool().query(`
    SELECT
      t.id, t.product_id, p.name AS product_name, b.batch_no, b.expiry_date, t.quantity_base_units,
      sb.code AS staging_bin_code, gb.code AS suggested_bin_code, p.is_cold_chain, p.schedule_category, t.created_at
    FROM putaway_tasks t
    JOIN products p ON p.id = t.product_id
    JOIN batches b ON b.id = t.batch_id
    JOIN bins sb ON sb.id = t.staging_bin_id
    LEFT JOIN bins gb ON gb.id = t.suggested_bin_id
    WHERE t.status = 'pending'
    ORDER BY t.created_at
  `);
  return rows.map((r) => ({
    id: r.id, productId: r.product_id, productName: r.product_name, batchNo: r.batch_no, expiryDate: r.expiry_date,
    quantityBaseUnits: r.quantity_base_units, stagingBinCode: r.staging_bin_code, suggestedBinCode: r.suggested_bin_code,
    isColdChain: r.is_cold_chain, scheduleCategory: r.schedule_category, createdAt: r.created_at,
  }));
}

export class ZoneViolationError extends Error {
  constructor(public requiredZone: string) {
    super(`this product must be put away into a ${requiredZone}-* bin`);
  }
}
export class TaskNotPendingError extends Error {}
export class BinNotFoundError extends Error {}

export interface ConfirmPutawayInput {
  taskId: string;
  scannedBinCode: string;
  reasonCode: string;
  note: string;
  actorUserId: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
}

export async function confirmPutaway(input: ConfirmPutawayInput): Promise<void> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: taskRows } = await client.query(
      `SELECT t.*, p.is_cold_chain, p.schedule_category FROM putaway_tasks t
       JOIN products p ON p.id = t.product_id
       WHERE t.id = $1 FOR UPDATE`,
      [input.taskId]
    );
    const task = taskRows[0];
    if (!task) throw new TaskNotPendingError("task not found");
    if (task.status !== "pending") throw new TaskNotPendingError("task already completed");

    const requiredZone = task.is_cold_chain ? "CC" : task.schedule_category === "H1" ? "SH" : null;

    const { rows: binRows } = await client.query(`SELECT id, zone FROM bins WHERE code = $1 AND status = 'active'`, [input.scannedBinCode]);
    const bin = binRows[0];
    if (!bin) throw new BinNotFoundError(`no active bin with code ${input.scannedBinCode}`);

    // Hard rule, not a warning (Section 6.6, point 4) — distinct in
    // character from the rest of this build's "no hard blocks" defaults,
    // because this one is a physical/regulatory placement constraint,
    // not a pricing or workflow judgement call.
    if (requiredZone && bin.zone !== requiredZone) {
      throw new ZoneViolationError(requiredZone);
    }

    const transferGroupId = crypto.randomUUID();
    await client.query(
      `INSERT INTO movement_ledger
         (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, transfer_group_id, source, actor_user_id, device_id)
       VALUES
         ('transfer', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10),
         ('transfer', $1, $2, $11, $12, $5, $6, $7, $8, $9, $10)`,
      [
        task.product_id, task.batch_id, task.staging_bin_id, -task.quantity_base_units,
        input.reasonCode, input.note, transferGroupId, input.source, input.actorUserId, input.deviceId,
        bin.id, task.quantity_base_units,
      ]
    );

    await client.query(
      `UPDATE putaway_tasks SET status = 'completed', completed_bin_id = $1, completed_by = $2,
         completed_device_id = $3, completed_source = $4, completed_at = now() WHERE id = $5`,
      [bin.id, input.actorUserId, input.deviceId, input.source, input.taskId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
