import { pool } from "../db.js";
import { reserveNumber } from "../domain/bill-numbering.js";
import { getSetting } from "./settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class VendorDebitNoteError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

export const VENDOR_DEBIT_NOTE_REASON_CODES = ["damaged", "expired", "wrong_item", "short_supply", "other"] as const;

export interface CreateVendorDebitNoteInput {
  purchaseInvoiceId: string;
  reasonCode: (typeof VENDOR_DEBIT_NOTE_REASON_CODES)[number];
  note: string;
  lines: Array<{ purchaseInvoiceLineId: string; quantityBaseUnits: number; binId: string }>;
  createdBy: string;
  deviceId: string;
}

// Goods physically returned to the vendor — always tied to the exact
// purchase invoice line they came from and to real stock leaving a real
// bin (bin_id is the staff member's explicit call, never auto-selected,
// same discipline as write-offs.ts's assertPhysicallyAvailable). Values
// are proportioned off the original line so a partial return of a
// partially-discounted, GST-and-cess-bearing line comes out consistent
// with what was actually invoiced, not re-priced from scratch.
export async function createVendorDebitNote(input: CreateVendorDebitNoteInput) {
  const db = requirePool();

  const { rows: invoiceRows } = await db.query(`SELECT * FROM purchase_invoices WHERE id = $1`, [input.purchaseInvoiceId]);
  const invoice = invoiceRows[0];
  if (!invoice) throw new VendorDebitNoteError("purchase_invoice_not_found");

  const lineIds = input.lines.map((l) => l.purchaseInvoiceLineId);
  const { rows: lineRows } = await db.query(
    `SELECT * FROM purchase_invoice_lines WHERE id = ANY($1::uuid[]) AND purchase_invoice_id = $2`,
    [lineIds, input.purchaseInvoiceId]
  );
  if (lineRows.length !== lineIds.length) throw new VendorDebitNoteError("line_not_found");
  const lineById = new Map(lineRows.map((r) => [r.id, r]));

  // Cap against what's left to return on that line — a debit note can
  // never send back more than was originally purchased, across however
  // many separate debit notes it takes.
  const { rows: alreadyReturnedRows } = await db.query(
    `SELECT purchase_invoice_line_id, COALESCE(SUM(quantity_base_units), 0) AS returned
     FROM vendor_debit_note_lines WHERE purchase_invoice_line_id = ANY($1::uuid[]) GROUP BY purchase_invoice_line_id`,
    [lineIds]
  );
  const alreadyReturnedByLine = new Map(alreadyReturnedRows.map((r) => [r.purchase_invoice_line_id, Number(r.returned)]));

  for (const l of input.lines) {
    const pil = lineById.get(l.purchaseInvoiceLineId);
    const purchasedQty = pil.quantity_base_units + pil.free_quantity_base_units;
    const alreadyReturned = alreadyReturnedByLine.get(l.purchaseInvoiceLineId) ?? 0;
    if (l.quantityBaseUnits > purchasedQty - alreadyReturned) {
      throw new VendorDebitNoteError("return_quantity_exceeds_purchased", {
        purchaseInvoiceLineId: l.purchaseInvoiceLineId,
        remaining: purchasedQty - alreadyReturned,
      });
    }
    const { rows: stockRows } = await db.query(
      `SELECT quantity_base_units FROM stock WHERE product_id = $1 AND batch_id = $2 AND bin_id = $3`,
      [pil.product_id, pil.batch_id, l.binId]
    );
    const available = stockRows[0]?.quantity_base_units ?? 0;
    if (available < l.quantityBaseUnits) {
      throw new VendorDebitNoteError("insufficient_stock", { purchaseInvoiceLineId: l.purchaseInvoiceLineId, available });
    }
  }

  let totalTaxable = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const prefix = await getSetting("debit_note_prefix", "DN");
    const debitNoteNumber = await reserveNumber(client, prefix);

    const { rows: dnRows } = await client.query(
      `INSERT INTO vendor_debit_notes
         (debit_note_number, vendor_id, purchase_invoice_id, reason_code, note, taxable_value, cgst_amount, sgst_amount, igst_amount, total_value, created_by, device_id)
       VALUES ($1,$2,$3,$4,$5,0,0,0,0,0,$6,$7) RETURNING id`,
      [debitNoteNumber, invoice.vendor_id, input.purchaseInvoiceId, input.reasonCode, input.note, input.createdBy, input.deviceId]
    );
    const debitNoteId = dnRows[0].id;

    for (const l of input.lines) {
      const pil = lineById.get(l.purchaseInvoiceLineId);
      const purchasedQty = pil.quantity_base_units + pil.free_quantity_base_units;
      const fraction = purchasedQty > 0 ? l.quantityBaseUnits / purchasedQty : 0;

      const taxableValue = round2(fraction * Number(pil.taxable_value));
      const cgst = round2(fraction * Number(pil.cgst_amount));
      const sgst = round2(fraction * Number(pil.sgst_amount));
      const igst = round2(fraction * Number(pil.igst_amount));
      const cess = round2(fraction * Number(pil.cess_amount));
      const lineTotal = round2(taxableValue + cgst + sgst + igst + cess);

      totalTaxable += taxableValue;
      totalCgst += cgst;
      totalSgst += sgst;
      totalIgst += igst;
      totalCess += cess;

      await client.query(
        `INSERT INTO vendor_debit_note_lines
           (vendor_debit_note_id, purchase_invoice_line_id, product_id, batch_id, bin_id, quantity_base_units,
            rate_before_discount, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          debitNoteId, l.purchaseInvoiceLineId, pil.product_id, pil.batch_id, l.binId, l.quantityBaseUnits,
          pil.rate_before_discount, taxableValue, pil.gst_rate, cgst, sgst, igst, cess, lineTotal,
        ]
      );

      await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, reference_type, reference_id, source, actor_user_id, device_id)
         VALUES ('purchase_return', $1, $2, $3, $4, $5, $6, 'vendor_debit_note', $7, 'web', $8, $9)`,
        [pil.product_id, pil.batch_id, l.binId, -l.quantityBaseUnits, input.reasonCode, input.note, debitNoteId, input.createdBy, input.deviceId]
      );
    }

    const totalValue = round2(totalTaxable + totalCgst + totalSgst + totalIgst + totalCess);
    await client.query(
      `UPDATE vendor_debit_notes SET taxable_value = $1, cgst_amount = $2, sgst_amount = $3, igst_amount = $4, total_value = $5 WHERE id = $6`,
      [round2(totalTaxable), round2(totalCgst), round2(totalSgst), round2(totalIgst), totalValue, debitNoteId]
    );

    await client.query("COMMIT");
    return { id: debitNoteId, debitNoteNumber, totalValue };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listVendorDebitNotes(vendorId?: string) {
  const { rows } = await requirePool().query(
    `SELECT dn.*, v.name AS vendor_name, pi.invoice_number, u.name AS created_by_name
     FROM vendor_debit_notes dn
     JOIN vendors v ON v.id = dn.vendor_id
     JOIN purchase_invoices pi ON pi.id = dn.purchase_invoice_id
     JOIN users u ON u.id = dn.created_by
     WHERE ($1::uuid IS NULL OR dn.vendor_id = $1)
     ORDER BY dn.created_at DESC`,
    [vendorId ?? null]
  );
  return rows;
}

export async function getVendorDebitNoteDetail(id: string) {
  const db = requirePool();
  const { rows: dnRows } = await db.query(
    `SELECT dn.*, v.name AS vendor_name, pi.invoice_number, u.name AS created_by_name
     FROM vendor_debit_notes dn
     JOIN vendors v ON v.id = dn.vendor_id
     JOIN purchase_invoices pi ON pi.id = dn.purchase_invoice_id
     JOIN users u ON u.id = dn.created_by
     WHERE dn.id = $1`,
    [id]
  );
  if (!dnRows[0]) return null;
  const { rows: lineRows } = await db.query(
    `SELECT dnl.*, p.name AS product_name, ba.batch_no, bi.code AS bin_code
     FROM vendor_debit_note_lines dnl
     JOIN products p ON p.id = dnl.product_id
     JOIN batches ba ON ba.id = dnl.batch_id
     JOIN bins bi ON bi.id = dnl.bin_id
     WHERE dnl.vendor_debit_note_id = $1`,
    [id]
  );
  return { debitNote: dnRows[0], lines: lineRows };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
