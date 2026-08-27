import { pool } from "../db.js";
import { parseCsv } from "../lib/csv.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class InventoryError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

export const INVENTORY_CORRECTION_REASON_CODES = [
  "physical_recount",
  "data_entry_correction",
  "damage_pending_writeoff",
  "system_error",
  "other",
] as const;
export type InventoryCorrectionReasonCode = (typeof INVENTORY_CORRECTION_REASON_CODES)[number];

// --- Full stock view (Section 10.2: "filter and search by SKU, bin,
// batch, expiry window, schedule category, zone, value") ---------------

export interface StockFilter {
  search?: string;
  binId?: string;
  batchNo?: string;
  expiryFrom?: string;
  expiryTo?: string;
  scheduleCategory?: string;
  zone?: string;
  minValue?: number;
  maxValue?: number;
}

export async function listStock(filter: StockFilter) {
  const clauses: string[] = ["s.quantity_base_units > 0"];
  const params: any[] = [];

  if (filter.search) {
    params.push(`%${filter.search}%`);
    clauses.push(`p.name ILIKE $${params.length}`);
  }
  if (filter.binId) {
    params.push(filter.binId);
    clauses.push(`s.bin_id = $${params.length}`);
  }
  if (filter.batchNo) {
    params.push(`%${filter.batchNo}%`);
    clauses.push(`ba.batch_no ILIKE $${params.length}`);
  }
  if (filter.expiryFrom) {
    params.push(filter.expiryFrom);
    clauses.push(`ba.expiry_date >= $${params.length}`);
  }
  if (filter.expiryTo) {
    params.push(filter.expiryTo);
    clauses.push(`ba.expiry_date <= $${params.length}`);
  }
  if (filter.scheduleCategory) {
    params.push(filter.scheduleCategory);
    clauses.push(`p.schedule_category = $${params.length}`);
  }
  if (filter.zone) {
    params.push(filter.zone);
    clauses.push(`b.zone = $${params.length}`);
  }

  const having: string[] = [];
  if (filter.minValue != null) {
    params.push(filter.minValue);
    having.push(`(s.quantity_base_units * ba.mrp / p.pack_size) >= $${params.length}`);
  }
  if (filter.maxValue != null) {
    params.push(filter.maxValue);
    having.push(`(s.quantity_base_units * ba.mrp / p.pack_size) <= $${params.length}`);
  }

  const { rows } = await requirePool().query(
    `
    SELECT
      p.id AS product_id, p.name AS product_name, p.schedule_category, p.pack_size, p.base_unit,
      ba.id AS batch_id, ba.batch_no, ba.expiry_date, ba.mrp, ba.blocked, ba.blocked_reason,
      b.id AS bin_id, b.code AS bin_code, b.zone,
      s.quantity_base_units,
      (s.quantity_base_units * ba.mrp / p.pack_size)::numeric(12,2) AS value
    FROM stock s
    JOIN products p ON p.id = s.product_id
    JOIN batches ba ON ba.id = s.batch_id
    JOIN bins b ON b.id = s.bin_id
    WHERE ${clauses.join(" AND ")}
    ${having.length ? `AND ${having.join(" AND ")}` : ""}
    ORDER BY p.name, ba.expiry_date, b.code
    LIMIT 1000
    `,
    params
  );
  return rows;
}

// --- Edit stock: quantity / batch / expiry / MRP correction ------------
// Section 10.2: "every edit requires a reason code and writes a[n audit]
// row, never an in-place overwrite." Quantity goes through the same
// movement_ledger 'adjustment' path cycle-count variance already uses;
// batch_no/expiry/MRP aren't stock movements (no quantity_delta to log),
// so they go through the dedicated batch_corrections audit table instead
// — see the M13.3 migration comment for why.

export interface AdjustQuantityInput {
  productId: string;
  batchId: string;
  binId: string;
  newQuantityBaseUnits: number;
  reasonCode: InventoryCorrectionReasonCode;
  note: string;
  actorUserId: string;
  deviceId: string;
}

export async function adjustStockQuantity(input: AdjustQuantityInput): Promise<{ delta: number }> {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT quantity_base_units FROM stock WHERE product_id = $1 AND batch_id = $2 AND bin_id = $3`,
    [input.productId, input.batchId, input.binId]
  );
  const current = rows[0]?.quantity_base_units ?? 0;
  const delta = input.newQuantityBaseUnits - current;
  if (delta === 0) throw new InventoryError("no_change");

  await db.query(
    `INSERT INTO movement_ledger
       (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, reference_type, source, actor_user_id, device_id)
     VALUES ('adjustment', $1, $2, $3, $4, $5, $6, 'inventory_correction', 'web_manual', $7, $8)`,
    [input.productId, input.batchId, input.binId, delta, input.reasonCode, input.note, input.actorUserId, input.deviceId]
  );
  return { delta };
}

export interface CorrectBatchFieldInput {
  batchId: string;
  field: "batch_no" | "expiry_date" | "mrp";
  newValue: string;
  reasonCode: InventoryCorrectionReasonCode;
  note: string;
  actorUserId: string;
  deviceId: string;
}

export async function correctBatchField(input: CorrectBatchFieldInput): Promise<void> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT ${input.field} AS current_value FROM batches WHERE id = $1 FOR UPDATE`, [input.batchId]);
    if (!rows[0]) throw new InventoryError("batch_not_found");
    const oldValue = String(rows[0].current_value);

    await client.query(`UPDATE batches SET ${input.field} = $1 WHERE id = $2`, [input.newValue, input.batchId]);
    await client.query(
      `INSERT INTO batch_corrections (batch_id, field, old_value, new_value, reason_code, note, actor_user_id, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.batchId, input.field, oldValue, input.newValue, input.reasonCode, input.note, input.actorUserId, input.deviceId]
    );
    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") throw new InventoryError("batch_no_already_in_use");
    throw err;
  } finally {
    client.release();
  }
}

// --- Block / unblock a batch from picking -------------------------------
// Reuses batches.blocked/blocked_reason, already respected by FEFO
// allocation (domain/fefo.ts) since M0/M1 and already set one way by the
// M6 expiry audit's move-to-QC action — this is the generic Inventory-
// screen toggle Section 10.2 also asks for, open to blocking for any
// reason, not just near-expiry.

export async function blockBatch(batchId: string, reasonCode: string, note: string): Promise<void> {
  const { rowCount } = await requirePool().query(
    `UPDATE batches SET blocked = true, blocked_reason = $2 WHERE id = $1`,
    [batchId, note ? `${reasonCode}: ${note}` : reasonCode]
  );
  if (!rowCount) throw new InventoryError("batch_not_found");
}

export async function unblockBatch(batchId: string): Promise<void> {
  const { rowCount } = await requirePool().query(
    `UPDATE batches SET blocked = false, blocked_reason = NULL WHERE id = $1`,
    [batchId]
  );
  if (!rowCount) throw new InventoryError("batch_not_found");
}

// --- Move stock between bins --------------------------------------------
// Section 10.2: "creates a put-away task for floor staff to physically
// execute and confirm, rather than silently moving it in the system."
// Reuses putaway_tasks and its existing scan-to-confirm flow (M3,
// zone-forcing hard blocks, M13.2's mandatory web-manual reason code)
// wholesale — the only new piece is creating the task from an existing
// stock location instead of from an inbound purchase/stock-received
// event. This is also the bin-to-bin migration explicitly deferred from
// M11 (owner asked; answered "wait for M13" — see DECISIONS.md).

export async function createBinTransferTask(input: {
  productId: string;
  batchId: string;
  sourceBinId: string;
  destinationBinId: string;
  quantityBaseUnits: number;
  requestedBy: string;
}): Promise<{ taskId: string }> {
  if (input.sourceBinId === input.destinationBinId) throw new InventoryError("same_bin");
  const db = requirePool();

  const { rows: stockRows } = await db.query(
    `SELECT quantity_base_units FROM stock WHERE product_id = $1 AND batch_id = $2 AND bin_id = $3`,
    [input.productId, input.batchId, input.sourceBinId]
  );
  const available = stockRows[0]?.quantity_base_units ?? 0;
  if (input.quantityBaseUnits > available) throw new InventoryError("insufficient_stock", { available, requested: input.quantityBaseUnits });

  const { rows: binRows } = await db.query(`SELECT id FROM bins WHERE id = $1 AND status = 'active'`, [input.destinationBinId]);
  if (!binRows[0]) throw new InventoryError("destination_bin_not_found");

  const { rows } = await db.query(
    `INSERT INTO putaway_tasks (product_id, batch_id, staging_bin_id, quantity_base_units, suggested_bin_id, reference_type, reference_id)
     VALUES ($1,$2,$3,$4,$5,'bin_transfer', gen_random_uuid())
     RETURNING id`,
    [input.productId, input.batchId, input.sourceBinId, input.quantityBaseUnits, input.destinationBinId]
  );
  return { taskId: rows[0].id };
}

// Section 10.2 Bin master: "merge... bins." Queues a bin_transfer task
// for every (product, batch) currently sitting in the source bin, same
// as a single move-stock action — merge doesn't silently combine the
// two bins' records; it's "move everything out of this bin" as a batch,
// still requiring a floor staffer to scan-confirm each item into the
// target bin before the source bin's stock is actually gone (and, per
// updateBin's own retire-block above, before the source bin can be
// retired at all).
export async function mergeBinStock(sourceBinId: string, targetBinId: string, requestedBy: string): Promise<{ taskIds: string[] }> {
  if (sourceBinId === targetBinId) throw new InventoryError("same_bin");
  const { rows: targetRows } = await requirePool().query(`SELECT id FROM bins WHERE id = $1 AND status = 'active'`, [targetBinId]);
  if (!targetRows[0]) throw new InventoryError("destination_bin_not_found");

  const { rows: contents } = await requirePool().query(
    `SELECT product_id, batch_id, quantity_base_units FROM stock WHERE bin_id = $1 AND quantity_base_units > 0`,
    [sourceBinId]
  );
  const taskIds: string[] = [];
  for (const row of contents) {
    const { taskId } = await createBinTransferTask({
      productId: row.product_id,
      batchId: row.batch_id,
      sourceBinId,
      destinationBinId: targetBinId,
      quantityBaseUnits: row.quantity_base_units,
      requestedBy,
    });
    taskIds.push(taskId);
  }
  return { taskIds };
}

// --- Bulk CSV operations with mandatory preview-and-confirm diff --------
// Section 10.2: "with a mandatory preview-and-confirm diff screen before
// commit, showing every row that will change." Preview and commit both
// recompute the diff fresh from current DB state (nothing is cached
// server-side between the two calls) — the client just re-sends the same
// CSV text it already showed the user, so preview can never drift from
// what commit actually applies, and there's no server-side session/token
// to expire or clean up.

interface DiffRow {
  rowNumber: number;
  ok: boolean;
  error: string | null;
  productName: string;
  batchNo: string;
  binCode?: string;
  from?: string | number;
  to?: string | number;
  resolved?: { productId: string; batchId: string; binId?: string };
}

async function resolveProductBatch(productName: string, batchNo: string): Promise<{ productId: string; batchId: string } | null> {
  const { rows } = await requirePool().query(
    `SELECT p.id AS product_id, b.id AS batch_id FROM products p JOIN batches b ON b.product_id = p.id
     WHERE lower(p.name) = lower($1) AND b.batch_no = $2`,
    [productName, batchNo]
  );
  return rows[0] ? { productId: rows[0].product_id, batchId: rows[0].batch_id } : null;
}

async function resolveBin(binCode: string): Promise<string | null> {
  const { rows } = await requirePool().query(`SELECT id FROM bins WHERE code = $1 AND status = 'active'`, [binCode]);
  return rows[0]?.id ?? null;
}

export async function diffBulkStockAdjustment(csvText: string): Promise<DiffRow[]> {
  const rows = parseCsv(csvText);
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const productName = r.product ?? "";
    const batchNo = r.batch_no ?? "";
    const binCode = r.bin_code ?? "";
    const newQty = Number(r.new_quantity);
    const base: DiffRow = { rowNumber: i + 2, ok: false, error: null, productName, batchNo, binCode };
    if (!productName || !batchNo || !binCode || !Number.isFinite(newQty) || newQty < 0) {
      out.push({ ...base, error: "invalid_row" });
      continue;
    }
    const resolved = await resolveProductBatch(productName, batchNo);
    const binId = await resolveBin(binCode);
    if (!resolved || !binId) {
      out.push({ ...base, error: "not_found" });
      continue;
    }
    const { rows: stockRows } = await requirePool().query(
      `SELECT quantity_base_units FROM stock WHERE product_id = $1 AND batch_id = $2 AND bin_id = $3`,
      [resolved.productId, resolved.batchId, binId]
    );
    const current = stockRows[0]?.quantity_base_units ?? 0;
    out.push({ ...base, ok: true, from: current, to: newQty, resolved: { productId: resolved.productId, batchId: resolved.batchId, binId } });
  }
  return out;
}

export async function commitBulkStockAdjustment(csvText: string, reasonCode: InventoryCorrectionReasonCode, note: string, actorUserId: string, deviceId: string): Promise<{ applied: number; skipped: number }> {
  const diff = await diffBulkStockAdjustment(csvText);
  let applied = 0;
  let skipped = 0;
  for (const row of diff) {
    if (!row.ok || !row.resolved || row.from === row.to) { skipped++; continue; }
    await adjustStockQuantity({
      productId: row.resolved.productId,
      batchId: row.resolved.batchId,
      binId: row.resolved.binId!,
      newQuantityBaseUnits: row.to as number,
      reasonCode,
      note,
      actorUserId,
      deviceId,
    });
    applied++;
  }
  return { applied, skipped };
}

export async function diffBulkBinReassignment(csvText: string): Promise<DiffRow[]> {
  const rows = parseCsv(csvText);
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const productName = r.product ?? "";
    const batchNo = r.batch_no ?? "";
    const fromBinCode = r.from_bin_code ?? "";
    const toBinCode = r.to_bin_code ?? "";
    const qty = Number(r.quantity);
    const base: DiffRow = { rowNumber: i + 2, ok: false, error: null, productName, batchNo, binCode: fromBinCode };
    if (!productName || !batchNo || !fromBinCode || !toBinCode || fromBinCode === toBinCode || !Number.isFinite(qty) || qty <= 0) {
      out.push({ ...base, error: "invalid_row" });
      continue;
    }
    const resolved = await resolveProductBatch(productName, batchNo);
    const fromBinId = await resolveBin(fromBinCode);
    const toBinId = await resolveBin(toBinCode);
    if (!resolved || !fromBinId || !toBinId) {
      out.push({ ...base, error: "not_found" });
      continue;
    }
    const { rows: stockRows } = await requirePool().query(
      `SELECT quantity_base_units FROM stock WHERE product_id = $1 AND batch_id = $2 AND bin_id = $3`,
      [resolved.productId, resolved.batchId, fromBinId]
    );
    const available = stockRows[0]?.quantity_base_units ?? 0;
    if (qty > available) {
      out.push({ ...base, error: "insufficient_stock", from: fromBinCode, to: toBinCode });
      continue;
    }
    out.push({ ...base, ok: true, from: `${fromBinCode} (${available} available)`, to: `${toBinCode} — move ${qty}`, resolved: { productId: resolved.productId, batchId: resolved.batchId, binId: fromBinId } });
  }
  return out;
}

export async function commitBulkBinReassignment(csvText: string, actorUserId: string): Promise<{ applied: number; skipped: number; taskIds: string[] }> {
  const rows = parseCsv(csvText);
  const diff = await diffBulkBinReassignment(csvText);
  let applied = 0;
  let skipped = 0;
  const taskIds: string[] = [];
  for (let i = 0; i < diff.length; i++) {
    const row = diff[i]!;
    if (!row.ok || !row.resolved) { skipped++; continue; }
    const raw = rows[i]!;
    const toBinId = await resolveBin(raw.to_bin_code ?? "");
    if (!toBinId) { skipped++; continue; }
    const { taskId } = await createBinTransferTask({
      productId: row.resolved.productId,
      batchId: row.resolved.batchId,
      sourceBinId: row.resolved.binId!,
      destinationBinId: toBinId,
      quantityBaseUnits: Number(raw.quantity),
      requestedBy: actorUserId,
    });
    taskIds.push(taskId);
    applied++;
  }
  return { applied, skipped, taskIds };
}

export async function diffBulkPriceUpdate(csvText: string): Promise<DiffRow[]> {
  const rows = parseCsv(csvText);
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const productName = r.product ?? "";
    const batchNo = r.batch_no ?? "";
    const newMrp = Number(r.new_mrp);
    const base: DiffRow = { rowNumber: i + 2, ok: false, error: null, productName, batchNo };
    if (!productName || !batchNo || !Number.isFinite(newMrp) || newMrp <= 0) {
      out.push({ ...base, error: "invalid_row" });
      continue;
    }
    const resolved = await resolveProductBatch(productName, batchNo);
    if (!resolved) {
      out.push({ ...base, error: "not_found" });
      continue;
    }
    const { rows: batchRows } = await requirePool().query(`SELECT mrp FROM batches WHERE id = $1`, [resolved.batchId]);
    out.push({ ...base, ok: true, from: Number(batchRows[0].mrp), to: newMrp, resolved: { productId: resolved.productId, batchId: resolved.batchId } });
  }
  return out;
}

export async function commitBulkPriceUpdate(csvText: string, reasonCode: InventoryCorrectionReasonCode, note: string, actorUserId: string, deviceId: string): Promise<{ applied: number; skipped: number }> {
  const diff = await diffBulkPriceUpdate(csvText);
  let applied = 0;
  let skipped = 0;
  for (const row of diff) {
    if (!row.ok || !row.resolved || row.from === row.to) { skipped++; continue; }
    await correctBatchField({
      batchId: row.resolved.batchId,
      field: "mrp",
      newValue: String(row.to),
      reasonCode,
      note,
      actorUserId,
      deviceId,
    });
    applied++;
  }
  return { applied, skipped };
}
