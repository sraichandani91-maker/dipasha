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
  referenceType: string;
}

// Section 6.6 / M13.7: only a fresh receipt (an invoice or a non-GST
// stock-received entry) has an "invoiced/entered vs. physically found"
// variance to speak of — an internal bin_transfer or expiry_audit move
// is relocating stock that was already counted once, so it never offers
// the variance-count UI.
export const VARIANCE_ELIGIBLE_REFERENCE_TYPES = ["purchase_invoice", "stock_received"];

export async function listPendingPutawayTasks(): Promise<PutawayTaskListItem[]> {
  const { rows } = await requirePool().query(`
    SELECT
      t.id, t.product_id, p.name AS product_name, b.batch_no, b.expiry_date, t.quantity_base_units,
      sb.code AS staging_bin_code, gb.code AS suggested_bin_code, p.is_cold_chain, p.schedule_category, t.created_at,
      t.reference_type
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
    referenceType: r.reference_type,
  }));
}

export class ZoneViolationError extends Error {
  constructor(public requiredZone: string) {
    super(`this product must be put away into a ${requiredZone}-* bin`);
  }
}
export class TaskNotPendingError extends Error {}
export class BinNotFoundError extends Error {}

export class VarianceReasonRequiredError extends Error {}

export interface ConfirmPutawayInput {
  taskId: string;
  scannedBinCode: string;
  reasonCode: string;
  note: string;
  actorUserId: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
  // Section 6.6 / M13.7: the physical count found while moving stock out
  // of staging, if different from what was recorded on the invoice or
  // stock-received entry. Omitted (or equal to the task's own quantity)
  // means "matches, nothing to log."
  actualQuantityFound?: number;
  varianceReasonCode?: string;
  varianceNote?: string;
}

export async function confirmPutaway(input: ConfirmPutawayInput): Promise<{ varianceId: string | null }> {
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

    const expectedQuantity = task.quantity_base_units;
    const eligibleForVariance = VARIANCE_ELIGIBLE_REFERENCE_TYPES.includes(task.reference_type);
    const actualQuantity = eligibleForVariance && input.actualQuantityFound != null ? input.actualQuantityFound : expectedQuantity;
    const variance = actualQuantity - expectedQuantity;
    if (variance !== 0 && (!input.varianceReasonCode || !input.varianceNote)) {
      throw new VarianceReasonRequiredError("a variance reason and note are required when the physical count differs");
    }

    let varianceId: string | null = null;
    if (variance !== 0) {
      // True up the staging bin's book quantity to what was actually
      // there before moving anything out of it — see DECISIONS.md for
      // the worked example (shortfall vs. excess).
      await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, reference_type, reference_id, source, actor_user_id, device_id)
         VALUES ('adjustment', $1, $2, $3, $4, $5, $6, 'putaway_variance', $7, $8, $9, $10)`,
        [task.product_id, task.batch_id, task.staging_bin_id, variance, input.varianceReasonCode, input.varianceNote,
          task.id, input.source, input.actorUserId, input.deviceId]
      );
      const { rows: varianceRows } = await client.query(
        `INSERT INTO putaway_variances
           (putaway_task_id, product_id, batch_id, reference_type, reference_id, expected_quantity_base_units,
            actual_quantity_base_units, variance_base_units, reason_code, note, reported_by, device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [task.id, task.product_id, task.batch_id, task.reference_type, task.reference_id, expectedQuantity,
          actualQuantity, variance, input.varianceReasonCode, input.varianceNote, input.actorUserId, input.deviceId]
      );
      varianceId = varianceRows[0].id;
    }

    const transferGroupId = crypto.randomUUID();
    await client.query(
      `INSERT INTO movement_ledger
         (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, transfer_group_id, source, actor_user_id, device_id)
       VALUES
         ('transfer', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10),
         ('transfer', $1, $2, $11, $12, $5, $6, $7, $8, $9, $10)`,
      [
        task.product_id, task.batch_id, task.staging_bin_id, -actualQuantity,
        input.reasonCode, input.note, transferGroupId, input.source, input.actorUserId, input.deviceId,
        bin.id, actualQuantity,
      ]
    );

    await client.query(
      `UPDATE putaway_tasks SET status = 'completed', completed_bin_id = $1, completed_by = $2,
         completed_device_id = $3, completed_source = $4, completed_at = now() WHERE id = $5`,
      [bin.id, input.actorUserId, input.deviceId, input.source, input.taskId]
    );

    await client.query("COMMIT");
    return { varianceId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Variance resolution: every open variance needs a human decision
// (accept as-is, vendor credit note requested, write off) recorded
// before it's considered closed — no auto-escalation thresholds, unlike
// cycle counts (Section 6.6 doesn't specify any). ---

export async function listPutawayVariances(status?: "open" | "resolved") {
  const db = requirePool();
  const where = status ? `WHERE v.status = $1` : "";
  const { rows } = await db.query(
    `SELECT v.*, p.name AS product_name, b.batch_no, ru.name AS reported_by_name, su.name AS resolved_by_name
     FROM putaway_variances v
     JOIN products p ON p.id = v.product_id
     JOIN batches b ON b.id = v.batch_id
     JOIN users ru ON ru.id = v.reported_by
     LEFT JOIN users su ON su.id = v.resolved_by
     ${where}
     ORDER BY v.created_at DESC
     LIMIT 1000`,
    status ? [status] : []
  );
  return rows;
}

export class VarianceNotFoundError extends Error {}
export class VarianceAlreadyResolvedError extends Error {}

export async function resolvePutawayVariance(id: string, resolutionNote: string, actorUserId: string): Promise<void> {
  const db = requirePool();
  const { rows } = await db.query(`SELECT status FROM putaway_variances WHERE id = $1`, [id]);
  if (!rows[0]) throw new VarianceNotFoundError();
  if (rows[0].status === "resolved") throw new VarianceAlreadyResolvedError();
  await db.query(
    `UPDATE putaway_variances SET status = 'resolved', resolved_by = $1, resolution_note = $2, resolved_at = now() WHERE id = $3`,
    [actorUserId, resolutionNote, id]
  );
}
