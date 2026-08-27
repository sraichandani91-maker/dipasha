import { pool } from "../db.js";
import { selectBinsForCycleCount } from "../domain/cycle-count-selection.js";
import { getSetting } from "./settings.js";
import type { WebManualReasonCode } from "./manual-overrides.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class CycleCountError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// DB's own CURRENT_DATE, not the app server's clock — consistent with
// how business_date already works elsewhere (sales, day_close).
export async function getCurrentBusinessDate(): Promise<string> {
  const { rows } = await requirePool().query(`SELECT CURRENT_DATE::text AS d`);
  return rows[0].d;
}

/**
 * Section 9: "daily blind count of N bins." Idempotent per business
 * date — calling this again the same day tops up to N rather than
 * duplicating a bin already selected today.
 */
export async function generateDailyCycleCountTasks(businessDate: string, createdBy: string, deviceId: string) {
  const db = requirePool();
  const targetCount = await getSetting("cycle_count_bins_per_day", 10);

  const { rows: existing } = await db.query(`SELECT id FROM cycle_count_tasks WHERE business_date = $1`, [businessDate]);
  const remaining = Math.max(0, targetCount - existing.length);
  if (remaining === 0) return { created: 0 };

  const candidates = await selectBinsForCycleCount(remaining, businessDate);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const c of candidates) {
      const { rows: taskRows } = await client.query(
        `INSERT INTO cycle_count_tasks (bin_id, business_date, selection_reason, device_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [c.binId, businessDate, c.reason, deviceId]
      );
      const taskId = taskRows[0].id;

      const { rows: stockRows } = await client.query(
        `SELECT product_id, batch_id, quantity_base_units FROM stock WHERE bin_id = $1 AND quantity_base_units > 0`,
        [c.binId]
      );
      for (const s of stockRows) {
        await client.query(
          `INSERT INTO cycle_count_lines (cycle_count_task_id, product_id, batch_id, system_quantity_base_units) VALUES ($1,$2,$3,$4)`,
          [taskId, s.product_id, s.batch_id, s.quantity_base_units]
        );
      }
    }
    await client.query("COMMIT");
    void createdBy; // kept for signature symmetry with other creators; no created_by column on the task itself, just device_id
    return { created: candidates.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listTasksForDate(businessDate: string) {
  const { rows } = await requirePool().query(
    `SELECT t.*, b.code AS bin_code, u1.name AS assigned_to_name, u2.name AS counted_by_name
     FROM cycle_count_tasks t
     JOIN bins b ON b.id = t.bin_id
     LEFT JOIN users u1 ON u1.id = t.assigned_to
     LEFT JOIN users u2 ON u2.id = t.counted_by
     WHERE t.business_date = $1
     ORDER BY t.status, b.code`,
    [businessDate]
  );
  return rows;
}

export async function assignTask(taskId: string, assignedTo: string) {
  await requirePool().query(`UPDATE cycle_count_tasks SET assigned_to = $1 WHERE id = $2`, [assignedTo, taskId]);
}

// Blind: no system_quantity_base_units in the response (Section 9 —
// "blind means blind, the counter never sees system qty").
export async function getTaskForCounting(taskId: string) {
  const db = requirePool();
  const { rows: taskRows } = await db.query(
    `SELECT t.id, t.bin_id, t.status, b.code AS bin_code FROM cycle_count_tasks t JOIN bins b ON b.id = t.bin_id WHERE t.id = $1`,
    [taskId]
  );
  if (!taskRows[0]) return null;
  const { rows: lineRows } = await db.query(
    `SELECT cl.id, cl.product_id, p.name AS product_name, p.pack_size, p.base_unit, cl.batch_id, ba.batch_no, ba.expiry_date
     FROM cycle_count_lines cl
     JOIN products p ON p.id = cl.product_id
     JOIN batches ba ON ba.id = cl.batch_id
     WHERE cl.cycle_count_task_id = $1
     ORDER BY p.name`,
    [taskId]
  );
  return { task: taskRows[0], lines: lineRows };
}

export interface SubmitCountInput {
  taskId: string;
  counts: Array<{ lineId: string; countedQuantityBaseUnits: number }>;
  extraFinds: Array<{ productId: string; batchNo: string; countedQuantityBaseUnits: number; note: string | null }>;
  countedBy: string;
  // Section 10.1: "Cycle count entry" is a listed scan-backed action —
  // web has no scanner, so opening a count requires typing the bin code
  // in full (never a pre-filled value) plus the mandatory reason code.
  // Verified against the task's own bin, same as put-away's bin check.
  scannedBinCode: string;
  reasonCode: WebManualReasonCode;
  note: string;
}

export async function submitCount(input: SubmitCountInput) {
  const db = requirePool();
  const { rows: taskRows } = await db.query(`SELECT t.*, b.code AS bin_code FROM cycle_count_tasks t JOIN bins b ON b.id = t.bin_id WHERE t.id = $1`, [input.taskId]);
  const task = taskRows[0];
  if (!task) throw new CycleCountError("task_not_found");
  if (task.status !== "pending") throw new CycleCountError("already_counted");
  if (task.bin_code !== input.scannedBinCode.trim()) throw new CycleCountError("bin_mismatch");

  const managerThreshold = await getSetting("cycle_count_variance_manager_threshold_inr", 500);
  const ownerThreshold = await getSetting("cycle_count_variance_owner_threshold_inr", 2000);

  // An "unexpected find" is only resolvable against a batch that already
  // exists in the catalogue (Section 9 doesn't ask this to create new
  // batches on the fly) — the counter types the batch number they can
  // read off the pack, this looks it up rather than trusting a client-
  // supplied id.
  const resolvedExtras: Array<{ productId: string; batchId: string; countedQuantityBaseUnits: number; note: string | null }> = [];
  for (const extra of input.extraFinds) {
    const { rows } = await db.query(`SELECT id FROM batches WHERE product_id = $1 AND batch_no = $2`, [extra.productId, extra.batchNo]);
    if (!rows[0]) throw new CycleCountError("unknown_batch");
    resolvedExtras.push({ productId: extra.productId, batchId: rows[0].id, countedQuantityBaseUnits: extra.countedQuantityBaseUnits, note: extra.note });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    for (const extra of resolvedExtras) {
      await client.query(
        `INSERT INTO cycle_count_lines (cycle_count_task_id, product_id, batch_id, system_quantity_base_units, is_unexpected_find, note)
         VALUES ($1,$2,$3,0,true,$4)`,
        [input.taskId, extra.productId, extra.batchId, extra.note]
      );
    }

    let totalVarianceValue = 0;
    for (const c of input.counts) {
      const { rows: lineRows } = await client.query(
        `SELECT cl.system_quantity_base_units, ba.mrp, p.pack_size
         FROM cycle_count_lines cl JOIN batches ba ON ba.id = cl.batch_id JOIN products p ON p.id = cl.product_id
         WHERE cl.id = $1 AND cl.cycle_count_task_id = $2`,
        [c.lineId, input.taskId]
      );
      const line = lineRows[0];
      if (!line) continue;
      const variance = c.countedQuantityBaseUnits - line.system_quantity_base_units;
      const mrpPerBaseUnit = Number(line.mrp) / line.pack_size;
      const varianceValue = Math.abs(variance) * mrpPerBaseUnit;
      totalVarianceValue += varianceValue;
      await client.query(
        `UPDATE cycle_count_lines SET counted_quantity_base_units = $1, variance_base_units = $2, variance_value = $3 WHERE id = $4`,
        [c.countedQuantityBaseUnits, variance, varianceValue, c.lineId]
      );
    }
    for (const extra of resolvedExtras) {
      const { rows: batchRows } = await client.query(`SELECT mrp, product_id FROM batches WHERE id = $1`, [extra.batchId]);
      const { rows: productRows } = await client.query(`SELECT pack_size FROM products WHERE id = $1`, [batchRows[0].product_id]);
      const mrpPerBaseUnit = Number(batchRows[0].mrp) / productRows[0].pack_size;
      const varianceValue = extra.countedQuantityBaseUnits * mrpPerBaseUnit;
      totalVarianceValue += varianceValue;
      await client.query(
        `UPDATE cycle_count_lines SET counted_quantity_base_units = $1, variance_base_units = $1, variance_value = $2
         WHERE cycle_count_task_id = $3 AND product_id = $4 AND batch_id = $5 AND is_unexpected_find = true AND counted_quantity_base_units IS NULL`,
        [extra.countedQuantityBaseUnits, varianceValue, input.taskId, extra.productId, extra.batchId]
      );
    }

    let escalatedTo: string | null = null;
    if (totalVarianceValue > ownerThreshold) escalatedTo = "owner";
    else if (totalVarianceValue > managerThreshold) escalatedTo = "manager";

    await client.query(
      `UPDATE cycle_count_tasks
       SET status = 'counted', counted_by = $1, counted_at = now(), total_variance_value = $2, escalated_to = $3,
           count_reason_code = $4, count_note = $5
       WHERE id = $6`,
      [input.countedBy, totalVarianceValue.toFixed(2), escalatedTo, input.reasonCode, input.note, input.taskId]
    );

    await client.query("COMMIT");
    return { totalVarianceValue: Math.round(totalVarianceValue * 100) / 100, escalatedTo };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ReviewInput {
  taskId: string;
  outcome: "approved" | "rejected";
  reviewedBy: string;
  note: string | null;
  deviceId: string;
}

// Section 10: "review and approve or reject count variances." Approval
// writes one `adjustment` ledger row per line with a real variance —
// this is the ONLY place a cycle count actually changes stock; rejection
// leaves the system quantity standing (the count was disputed).
export async function reviewTask(input: ReviewInput) {
  const db = requirePool();
  const { rows: taskRows } = await db.query(`SELECT * FROM cycle_count_tasks WHERE id = $1`, [input.taskId]);
  const task = taskRows[0];
  if (!task) throw new CycleCountError("task_not_found");
  if (task.status !== "counted") throw new CycleCountError("not_ready_for_review");

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (input.outcome === "approved") {
      const { rows: lines } = await client.query(
        `SELECT * FROM cycle_count_lines WHERE cycle_count_task_id = $1 AND variance_base_units IS NOT NULL AND variance_base_units <> 0`,
        [input.taskId]
      );
      // Section 10.1: this ledger row is the actual stock effect of a
      // count that was itself entered manually (no scanner) — tagged
      // web_manual whenever submitCount captured a reason, carrying that
      // same reason/note forward onto the row that actually moves stock.
      const ledgerSource = task.count_reason_code ? "web_manual" : "web";
      for (const line of lines) {
        await client.query(
          `INSERT INTO movement_ledger (movement_type, product_id, batch_id, bin_id, quantity_delta, reference_type, reference_id, reason_code, note, source, actor_user_id, device_id)
           VALUES ('adjustment', $1, $2, $3, $4, 'cycle_count_task', $5, 'cycle_count_variance', $6, $7, $8, $9)`,
          [
            line.product_id, line.batch_id, task.bin_id, line.variance_base_units, input.taskId,
            line.is_unexpected_find
              ? `Unexpected item found during cycle count${task.count_note ? ` — ${task.count_note}` : ""}`
              : `Cycle count variance approved${task.count_note ? ` — ${task.count_note}` : ""}`,
            ledgerSource, input.reviewedBy, input.deviceId,
          ]
        );
      }
    }

    await client.query(
      `UPDATE cycle_count_tasks SET status = 'reviewed', reviewed_by = $1, reviewed_at = now(), review_outcome = $2, review_note = $3 WHERE id = $4`,
      [input.reviewedBy, input.outcome, input.note, input.taskId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getBinCountHistory(binId: string) {
  const { rows } = await requirePool().query(
    `SELECT t.*, u.name AS counted_by_name FROM cycle_count_tasks t LEFT JOIN users u ON u.id = t.counted_by
     WHERE t.bin_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
    [binId]
  );
  return rows;
}
