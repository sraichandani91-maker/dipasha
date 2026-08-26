import { pool } from "../db.js";
import { reserveNumber } from "../domain/bill-numbering.js";
import { getSetting } from "./settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class ReturnValidationError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

export interface CreateCreditNoteInput {
  originalSaleId: string;
  reason: string;
  lines: Array<{ saleLineId: string; quantityReturned: number; condition: "good" | "damaged" }>;
  createdBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
}

// Section 6A.7: recall the bill, select lines/quantities to return.
// Stock goes back to the original batch — into its bin if good, QC-* if
// damaged, the biller's explicit call every time, never silent. Hard
// block on expired stock; window is a setting, not invented here.
export async function createCreditNote(input: CreateCreditNoteInput) {
  const db = requirePool();

  const { rows: saleRows } = await db.query(`SELECT * FROM sales WHERE id = $1`, [input.originalSaleId]);
  const sale = saleRows[0];
  if (!sale) throw new ReturnValidationError("sale_not_found");

  const windowDays = await getSetting("sale_return_window_days", 7);
  const { rows: windowCheck } = await db.query(
    `SELECT (CURRENT_DATE - $1::date) AS days_since FROM sales WHERE id = $2`,
    [sale.business_date, input.originalSaleId]
  );
  if (windowCheck[0].days_since > windowDays) {
    throw new ReturnValidationError("outside_return_window", { windowDays, daysSince: windowCheck[0].days_since });
  }

  const lineIds = input.lines.map((l) => l.saleLineId);
  const { rows: saleLineRows } = await db.query(
    `SELECT sl.*, b.expiry_date, b.batch_no FROM sale_lines sl JOIN batches b ON b.id = sl.batch_id WHERE sl.id = ANY($1::uuid[]) AND sl.sale_id = $2`,
    [lineIds, input.originalSaleId]
  );
  if (saleLineRows.length !== lineIds.length) throw new ReturnValidationError("line_not_found");

  const saleLineById = new Map(saleLineRows.map((r) => [r.id, r]));
  for (const l of input.lines) {
    const sl = saleLineById.get(l.saleLineId);
    if (l.quantityReturned > sl.quantity_base_units) {
      throw new ReturnValidationError("return_quantity_exceeds_sold", { saleLineId: l.saleLineId });
    }
    // Hard block, per Section 6A.7's own explicit wording — unlike most
    // validations in this build.
    if (new Date(sl.expiry_date) < new Date()) {
      throw new ReturnValidationError("expired_stock_cannot_be_returned", { saleLineId: l.saleLineId, expiryDate: sl.expiry_date });
    }
  }

  const qcBinRows = await db.query(`SELECT id FROM bins WHERE zone = 'QC' AND status = 'active' ORDER BY code LIMIT 1`);
  const qcBinId = qcBinRows.rows[0]?.id ?? null;

  let totalRefund = 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const prefix = await getSetting("credit_note_prefix", "CN");
    const creditNoteNumber = await reserveNumber(client, prefix);

    const { rows: cnRows } = await client.query(
      `INSERT INTO credit_notes (credit_note_number, original_sale_id, reason, total_refund_value, created_by, device_id, source)
       VALUES ($1,$2,$3,0,$4,$5,$6) RETURNING id`,
      [creditNoteNumber, input.originalSaleId, input.reason, input.createdBy, input.deviceId, input.source]
    );
    const creditNoteId = cnRows[0].id;

    for (const l of input.lines) {
      const sl = saleLineById.get(l.saleLineId);
      const refundValue = Math.round(((l.quantityReturned / sl.quantity_base_units) * Number(sl.line_total)) * 100) / 100;
      totalRefund += refundValue;

      const destinationBinId = l.condition === "good" ? sl.bin_id : qcBinId;
      if (!destinationBinId) throw new ReturnValidationError("no_quarantine_bin_available");

      await client.query(
        `INSERT INTO credit_note_lines (credit_note_id, sale_line_id, quantity_returned, refund_value, condition, destination_bin_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [creditNoteId, l.saleLineId, l.quantityReturned, refundValue, l.condition, destinationBinId]
      );

      await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reference_type, reference_id, note, source, actor_user_id, device_id)
         VALUES ('sale_return', $1, $2, $3, $4, 'credit_note', $5, $6, $7, $8, $9)`,
        [sl.product_id, sl.batch_id, destinationBinId, l.quantityReturned, creditNoteId, `Condition: ${l.condition}`, input.source, input.createdBy, input.deviceId]
      );
    }

    await client.query(`UPDATE credit_notes SET total_refund_value = $1 WHERE id = $2`, [Math.round(totalRefund * 100) / 100, creditNoteId]);
    await client.query("COMMIT");
    return { id: creditNoteId, creditNoteNumber, totalRefund: Math.round(totalRefund * 100) / 100 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export class CancelSaleError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Section 6A.7: full cancellation reverses all stock, only permitted
// before day-close; after that, only a credit note. Never delete a bill
// — cancellation is a status, the record stays.
export async function cancelSale(saleId: string, reason: string, actorUserId: string, deviceId: string, source: "app" | "web" | "web_manual") {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: saleRows } = await client.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [saleId]);
    const sale = saleRows[0];
    if (!sale) throw new CancelSaleError("sale_not_found");
    if (sale.status === "cancelled") throw new CancelSaleError("already_cancelled");

    const { rows: dayCloseRows } = await client.query(`SELECT id FROM day_close WHERE business_date = $1`, [sale.business_date]);
    if (dayCloseRows.length > 0) throw new CancelSaleError("day_already_closed");

    const { rows: lineRows } = await client.query(`SELECT * FROM sale_lines WHERE sale_id = $1`, [saleId]);
    for (const l of lineRows) {
      await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reference_type, reference_id, note, source, actor_user_id, device_id)
         VALUES ('sale_return', $1, $2, $3, $4, 'sale_cancellation', $5, $6, $7, $8, $9)`,
        [l.product_id, l.batch_id, l.bin_id, l.quantity_base_units, saleId, "Full bill cancellation", source, actorUserId, deviceId]
      );
    }

    await client.query(
      `UPDATE sales SET status = 'cancelled', cancelled_reason = $1, cancelled_by = $2, cancelled_at = now() WHERE id = $3`,
      [reason, actorUserId, saleId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
