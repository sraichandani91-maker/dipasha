import { pool } from "../db.js";
import { getSetting } from "./settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class WriteOffError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface CreateWriteOffInput {
  productId: string;
  batchId: string;
  binId: string;
  quantityBaseUnits: number;
  reasonCode: string;
  note: string;
  photoPath: string | null;
  estimatedValue: number;
  requestedBy: string;
  deviceId: string;
}

// Section 9, 9A.8: damage/write-off with photo evidence, Owner approval
// above a value threshold. Below the threshold, nothing needs to wait on
// anyone — the ledger row is written immediately and the record is
// stamped 'approved' with no human review, same self-approval pattern a
// low-value stock_issue already gets. Above it, the row sits 'pending'
// and stock is untouched until an Owner acts on it.
// Physical presence, not sellability — deliberately checked against raw
// `stock`, not `sellable_stock`. A blocked/quarantined batch (already
// flagged near-expiry, say) still has to be write-off-able; excluding it
// here would make the expiry-audit -> write-off path impossible.
async function assertPhysicallyAvailable(productId: string, batchId: string, binId: string, quantityBaseUnits: number) {
  const { rows } = await requirePool().query(
    `SELECT quantity_base_units FROM stock WHERE product_id = $1 AND batch_id = $2 AND bin_id = $3`,
    [productId, batchId, binId]
  );
  const available = rows[0]?.quantity_base_units ?? 0;
  if (available < quantityBaseUnits) throw new WriteOffError("insufficient_stock");
}

export async function createWriteOff(input: CreateWriteOffInput) {
  const db = requirePool();
  const threshold = await getSetting("writeoff_approval_threshold_inr", 1000);
  const requiresApproval = input.estimatedValue > threshold;
  await assertPhysicallyAvailable(input.productId, input.batchId, input.binId, input.quantityBaseUnits);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO write_offs
         (product_id, batch_id, bin_id, quantity_base_units, reason_code, note, photo_path, estimated_value, status, requires_approval, requested_by, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        input.productId, input.batchId, input.binId, input.quantityBaseUnits, input.reasonCode, input.note,
        input.photoPath, input.estimatedValue, requiresApproval ? "pending" : "approved", requiresApproval,
        input.requestedBy, input.deviceId,
      ]
    );
    const id = rows[0].id;

    if (!requiresApproval) {
      await client.query(
        `UPDATE write_offs SET approved_by = $1, approved_at = now() WHERE id = $2`,
        [input.requestedBy, id]
      );
      await client.query(
        `INSERT INTO movement_ledger (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, reference_type, reference_id, source, actor_user_id, device_id)
         VALUES ('write_off', $1, $2, $3, $4, $5, $6, 'write_off', $7, 'web', $8, $9)`,
        [
          input.productId, input.batchId, input.binId, -input.quantityBaseUnits, input.reasonCode, input.note,
          id, input.requestedBy, input.deviceId,
        ]
      );
    }

    await client.query("COMMIT");
    return { id, requiresApproval };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listWriteOffs(status?: string) {
  const { rows } = await requirePool().query(
    `SELECT wo.*, p.name AS product_name, ba.batch_no, b.code AS bin_code, u1.name AS requested_by_name, u2.name AS approved_by_name
     FROM write_offs wo
     JOIN products p ON p.id = wo.product_id
     JOIN batches ba ON ba.id = wo.batch_id
     JOIN bins b ON b.id = wo.bin_id
     JOIN users u1 ON u1.id = wo.requested_by
     LEFT JOIN users u2 ON u2.id = wo.approved_by
     WHERE ($1::text IS NULL OR wo.status = $1)
     ORDER BY wo.created_at DESC`,
    [status ?? null]
  );
  return rows;
}

export async function approveWriteOff(id: string, approvedBy: string) {
  const db = requirePool();
  const { rows } = await db.query(`SELECT * FROM write_offs WHERE id = $1`, [id]);
  const wo = rows[0];
  if (!wo) throw new WriteOffError("not_found");
  if (wo.status !== "pending") throw new WriteOffError("not_pending");
  // Re-check now, not just at request time — stock may have moved (a
  // sale, another write-off) in whatever time this sat in the queue.
  await assertPhysicallyAvailable(wo.product_id, wo.batch_id, wo.bin_id, wo.quantity_base_units);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE write_offs SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`, [approvedBy, id]);
    await client.query(
      `INSERT INTO movement_ledger (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, reference_type, reference_id, source, actor_user_id, device_id)
       VALUES ('write_off', $1, $2, $3, $4, $5, $6, 'write_off', $7, 'web', $8, $9)`,
      [wo.product_id, wo.batch_id, wo.bin_id, -wo.quantity_base_units, wo.reason_code, wo.note, id, approvedBy, wo.device_id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectWriteOff(id: string, approvedBy: string, rejectionReason: string) {
  const { rows } = await requirePool().query(`SELECT status FROM write_offs WHERE id = $1`, [id]);
  if (!rows[0]) throw new WriteOffError("not_found");
  if (rows[0].status !== "pending") throw new WriteOffError("not_pending");
  await requirePool().query(
    `UPDATE write_offs SET status = 'rejected', approved_by = $1, approved_at = now(), rejection_reason = $2 WHERE id = $3`,
    [approvedBy, rejectionReason, id]
  );
}
