import { pool } from "../db.js";
import { getSetting } from "./settings.js";
import { getVendor } from "./vendors.js";
import { findOrCreateBatch, findStagingBin } from "./batches.js";
import { apportionByTaxableValue, computeEffectiveCostPerBaseUnit } from "../domain/landed-cost.js";
import { splitGst } from "../domain/gst-split.js";
import { suggestPutawayBin } from "../domain/putaway-suggestion.js";
import { checkCallbackMatches } from "./callback.js";
import { applyInvoiceLinesToPurchaseOrder } from "./purchase-orders.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface PurchaseLineInput {
  productId: string;
  batchNo: string;
  expiryDate: string;
  packAsPrinted: string | null;
  quantityBaseUnits: number;
  freeQuantityBaseUnits: number;
  mrp: number;
  rateBeforeDiscount: number;
  discountPercent: number;
  discountValue: number | null; // editable independently of percent — either can drive the other (Section 6.4)
  gstRate: number;
  cess: number;
  // Section 9A.2 scheme tracking — only set when the biller actually
  // knows what was promised (a scheme agreement, the vendor's PO
  // confirmation). Most lines leave these null, correctly.
  promisedQuantityBaseUnits: number | null;
  promisedFreeQuantityBaseUnits: number | null;
}

export interface CreatePurchaseInvoiceInput {
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValueStated: number;
  paymentTermsDays: number;
  billLevelDiscount: number;
  freightAndCharges: number;
  roundOff: number;
  lines: PurchaseLineInput[];
  overrideNearExpiry: boolean;
  acknowledgeReconciliationMismatch: boolean;
  // Section 9A.6 vendor scorecard — linking a GRN back to the PO it
  // fulfils is what makes lead-time/fill-rate computable at all.
  // Optional: not every purchase traces back to a PO this system raised.
  purchaseOrderId: string | null;
  createdBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
  entryMethod: "manual" | "ai_scan";
}

export class ValidationConflictError extends Error {
  constructor(public code: string, public details: unknown) {
    super(code);
  }
}

interface ComputedLine extends Omit<PurchaseLineInput, "discountValue"> {
  discountValue: number; // resolved from percent-or-explicit-value by this point, never null
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  lineTotal: number;
  apportionedBillDiscount: number;
  apportionedCharges: number;
  effectiveCostPerBaseUnit: number;
}

export async function createPurchaseInvoice(input: CreatePurchaseInvoiceInput) {
  const db = requirePool();

  const vendor = await getVendor(input.vendorId);
  if (!vendor) throw new ValidationConflictError("vendor_not_found", null);

  // Hard block — Section 6.2 states this flatly, no override language,
  // unlike the other validations here.
  const dup = await db.query(`SELECT id FROM purchase_invoices WHERE vendor_id = $1 AND invoice_number = $2`, [
    input.vendorId, input.invoiceNumber,
  ]);
  if (dup.rows.length > 0) {
    throw new ValidationConflictError("duplicate_invoice", { existingInvoiceId: dup.rows[0].id });
  }

  const expiryThresholdMonths = await getSetting("expiry_reject_threshold_months", 6);
  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() + expiryThresholdMonths);
  const nearExpiryLines = input.lines.filter((l) => new Date(l.expiryDate) < thresholdDate);
  if (nearExpiryLines.length > 0 && !input.overrideNearExpiry) {
    throw new ValidationConflictError("near_expiry_lines", {
      thresholdMonths: expiryThresholdMonths,
      lines: nearExpiryLines.map((l) => ({ productId: l.productId, batchNo: l.batchNo, expiryDate: l.expiryDate })),
    });
  }

  const shopStateCode = await getSetting("shop_gst_state_code", "09");
  const vendorStateCode = vendor.gstStateCode ?? shopStateCode; // no GSTIN on file: default in-state rather than guess wrong

  const lineTaxableValues = input.lines.map((l) => {
    const discountValue = l.discountValue ?? (l.quantityBaseUnits * l.rateBeforeDiscount * l.discountPercent) / 100;
    return l.quantityBaseUnits * l.rateBeforeDiscount - discountValue;
  });
  const apportionedDiscounts = apportionByTaxableValue(input.billLevelDiscount, lineTaxableValues);
  const apportionedCharges = apportionByTaxableValue(input.freightAndCharges, lineTaxableValues);

  const computedLines: ComputedLine[] = input.lines.map((l, i) => {
    const discountValue = l.discountValue ?? (l.quantityBaseUnits * l.rateBeforeDiscount * l.discountPercent) / 100;
    const taxableValue = lineTaxableValues[i]!;
    const gst = splitGst(taxableValue, l.gstRate, vendorStateCode, shopStateCode);
    const effectiveCostPerBaseUnit = computeEffectiveCostPerBaseUnit({
      quantityBaseUnits: l.quantityBaseUnits,
      freeQuantityBaseUnits: l.freeQuantityBaseUnits,
      rateBeforeDiscount: l.rateBeforeDiscount,
      discountValue,
      apportionedBillDiscount: apportionedDiscounts[i]!,
      apportionedCharges: apportionedCharges[i]!,
    });
    const lineTotal = taxableValue + gst.cgstAmount + gst.sgstAmount + gst.igstAmount + l.cess;
    return {
      ...l,
      discountValue,
      taxableValue,
      cgstAmount: gst.cgstAmount,
      sgstAmount: gst.sgstAmount,
      igstAmount: gst.igstAmount,
      cessAmount: l.cess,
      lineTotal,
      apportionedBillDiscount: apportionedDiscounts[i]!,
      apportionedCharges: apportionedCharges[i]!,
      effectiveCostPerBaseUnit,
    };
  });

  const taxableValueTotal = computedLines.reduce((a, l) => a + l.taxableValue, 0);
  const taxTotal = computedLines.reduce((a, l) => a + l.cgstAmount + l.sgstAmount + l.igstAmount + l.cessAmount, 0);
  const netPayableComputed =
    taxableValueTotal + taxTotal - input.billLevelDiscount + input.freightAndCharges + input.roundOff;
  const reconciliationDiff = netPayableComputed - input.invoiceValueStated;

  const tolerance = await getSetting("invoice_reconciliation_tolerance_inr", 1);
  if (Math.abs(reconciliationDiff) > tolerance && !input.acknowledgeReconciliationMismatch) {
    throw new ValidationConflictError("reconciliation_mismatch", {
      netPayableComputed: round2(netPayableComputed),
      invoiceValueStated: input.invoiceValueStated,
      diff: round2(reconciliationDiff),
      toleranceInr: tolerance,
    });
  }

  // Informational only, per line — Section 6.2: "Flag if MRP differs...
  // Flag if purchase rate differs materially" — never blocks.
  const warnings: Array<{ productId: string; type: string; message: string }> = [];
  for (const l of input.lines) {
    const { rows } = await db.query(
      `SELECT b.mrp AS mrp, pil.rate_before_discount AS rate_before_discount FROM purchase_invoice_lines pil
       JOIN batches b ON b.id = pil.batch_id
       WHERE b.product_id = $1
       ORDER BY pil.id DESC LIMIT 1`,
      [l.productId]
    );
    const last = rows[0];
    if (last) {
      if (Number(last.mrp) !== l.mrp) {
        warnings.push({ productId: l.productId, type: "mrp_changed", message: `MRP differs from last received (₹${last.mrp} -> ₹${l.mrp})` });
      }
      const lastRate = Number(last.rate_before_discount);
      if (lastRate > 0 && Math.abs(l.rateBeforeDiscount - lastRate) / lastRate > 0.05) {
        warnings.push({ productId: l.productId, type: "rate_changed", message: `Purchase rate differs materially from last (₹${lastRate} -> ₹${l.rateBeforeDiscount})` });
      }
    }
  }

  const stagingBin = await findStagingBin();
  if (!stagingBin) throw new ValidationConflictError("no_staging_bin", "no active IN-* bin exists");

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: invoiceRows } = await client.query(
      `INSERT INTO purchase_invoices
         (vendor_id, invoice_number, invoice_date, invoice_value_stated, payment_terms_days,
          bill_level_discount, freight_and_charges, round_off, taxable_value_total, tax_total,
          net_payable_computed, reconciliation_diff, reconciliation_acknowledged, entry_method, source, created_by, device_id, purchase_order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        input.vendorId, input.invoiceNumber, input.invoiceDate, input.invoiceValueStated, input.paymentTermsDays,
        input.billLevelDiscount, input.freightAndCharges, input.roundOff, round2(taxableValueTotal), round2(taxTotal),
        round2(netPayableComputed), round2(reconciliationDiff), Math.abs(reconciliationDiff) > tolerance,
        input.entryMethod, input.source, input.createdBy, input.deviceId, input.purchaseOrderId,
      ]
    );
    const invoiceId = invoiceRows[0].id;

    for (const l of computedLines) {
      const batch = await findOrCreateBatch(client, l.productId, l.batchNo, l.expiryDate, l.mrp, {
        rateBeforeDiscount: l.rateBeforeDiscount,
        discountValue: l.discountValue,
        apportionedCharges: l.apportionedCharges,
        freeQuantityBaseUnits: l.freeQuantityBaseUnits,
        effectiveCostPerBaseUnit: l.effectiveCostPerBaseUnit,
        costUnknown: false,
      });

      await client.query(
        `INSERT INTO purchase_invoice_lines
           (purchase_invoice_id, product_id, batch_id, pack_as_printed, quantity_base_units,
            free_quantity_base_units, rate_before_discount, discount_percent, discount_value,
            taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount, line_total,
            apportioned_bill_discount, apportioned_charges, promised_quantity_base_units, promised_free_quantity_base_units)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          invoiceId, l.productId, batch.id, l.packAsPrinted, l.quantityBaseUnits, l.freeQuantityBaseUnits,
          l.rateBeforeDiscount, l.discountPercent, round2(l.discountValue), round2(l.taxableValue), l.gstRate,
          round2(l.cgstAmount), round2(l.sgstAmount), round2(l.igstAmount), round2(l.cessAmount), round2(l.lineTotal),
          l.apportionedBillDiscount, l.apportionedCharges, l.promisedQuantityBaseUnits, l.promisedFreeQuantityBaseUnits,
        ]
      );

      const totalReceived = l.quantityBaseUnits + l.freeQuantityBaseUnits;
      await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reference_type, reference_id,
            source, actor_user_id, device_id)
         VALUES ('gst_purchase', $1, $2, $3, $4, 'purchase_invoice', $5, $6, $7, $8)`,
        [l.productId, batch.id, stagingBin.id, totalReceived, invoiceId, input.source, input.createdBy, input.deviceId]
      );

      const productRow = await client.query(`SELECT is_cold_chain, schedule_category FROM products WHERE id = $1`, [l.productId]);
      const requiredZone = productRow.rows[0]?.is_cold_chain ? "CC" : productRow.rows[0]?.schedule_category === "H1" ? "SH" : null;
      const suggested = await suggestPutawayBin(l.productId, requiredZone);

      await client.query(
        `INSERT INTO putaway_tasks (product_id, batch_id, staging_bin_id, quantity_base_units, suggested_bin_id, reference_type, reference_id)
         VALUES ($1,$2,$3,$4,$5,'purchase_invoice',$6)`,
        [l.productId, batch.id, stagingBin.id, totalReceived, suggested?.id ?? null, invoiceId]
      );
    }

    // Section 10B.2: "auto-match it to the open PO... ordered versus
    // received versus billed, line by line." Uses billed quantity, not
    // totalReceived (which includes free goods) — a PO orders billable
    // units, so matching against those is what "ordered vs received"
    // actually means here.
    if (input.purchaseOrderId) {
      await applyInvoiceLinesToPurchaseOrder(
        client,
        input.purchaseOrderId,
        computedLines.map((l) => ({ productId: l.productId, quantityBaseUnits: l.quantityBaseUnits }))
      );
    }

    await client.query("COMMIT");

    // Section 6B.4: the callback loop check runs on every inbound
    // commit, outside the transaction — it only ever moves
    // customer_requests forward and the GRN itself has already
    // committed successfully by this point regardless.
    await checkCallbackMatches(computedLines.map((l) => l.productId));

    return {
      id: invoiceId,
      taxableValueTotal: round2(taxableValueTotal),
      taxTotal: round2(taxTotal),
      netPayableComputed: round2(netPayableComputed),
      reconciliationDiff: round2(reconciliationDiff),
      warnings,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- List / detail (Section 10.2: create-only until now — there was no
// way to look a submitted invoice back up except querying the DB directly) ---

export interface PurchaseInvoiceListFilter {
  vendorId?: string;
  from?: string;
  to?: string;
  search?: string; // invoice number
}

export async function listPurchaseInvoices(filter: PurchaseInvoiceListFilter) {
  const db = requirePool();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.vendorId) { params.push(filter.vendorId); where.push(`pi.vendor_id = $${params.length}`); }
  if (filter.from) { params.push(filter.from); where.push(`pi.invoice_date >= $${params.length}`); }
  if (filter.to) { params.push(filter.to); where.push(`pi.invoice_date <= $${params.length}`); }
  if (filter.search) { params.push(`%${filter.search}%`); where.push(`pi.invoice_number ILIKE $${params.length}`); }

  const { rows } = await db.query(
    `SELECT pi.id, pi.invoice_number, pi.invoice_date, pi.invoice_value_stated, pi.net_payable_computed,
            pi.reconciliation_diff, pi.reconciliation_acknowledged, pi.entry_method, pi.created_at,
            v.name AS vendor_name,
            (SELECT COUNT(*) FROM purchase_invoice_lines pil WHERE pil.purchase_invoice_id = pi.id) AS line_count,
            (SELECT COUNT(*) FROM purchase_invoice_documents d WHERE d.purchase_invoice_id = pi.id) AS document_count
     FROM purchase_invoices pi
     JOIN vendors v ON v.id = pi.vendor_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY pi.invoice_date DESC, pi.created_at DESC
     LIMIT 1000`,
    params
  );
  return rows;
}

export async function getPurchaseInvoiceDetail(id: string) {
  const db = requirePool();
  const { rows: invRows } = await db.query(
    `SELECT pi.*, v.name AS vendor_name, v.gstin AS vendor_gstin
     FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
     WHERE pi.id = $1`,
    [id]
  );
  if (!invRows[0]) return null;

  const { rows: lines } = await db.query(
    `SELECT pil.*, p.name AS product_name, b.batch_no, b.expiry_date
     FROM purchase_invoice_lines pil
     JOIN products p ON p.id = pil.product_id
     JOIN batches b ON b.id = pil.batch_id
     WHERE pil.purchase_invoice_id = $1
     ORDER BY p.name`,
    [id]
  );

  const { rows: documents } = await db.query(
    `SELECT d.id, d.mime_type, d.created_at, u.name AS uploaded_by_name
     FROM purchase_invoice_documents d JOIN users u ON u.id = d.uploaded_by
     WHERE d.purchase_invoice_id = $1 ORDER BY d.created_at`,
    [id]
  );

  const { rows: corrections } = await db.query(
    `SELECT c.field, c.old_value, c.new_value, c.reason_code, c.note, c.created_at, u.name AS actor_name
     FROM purchase_invoice_corrections c JOIN users u ON u.id = c.actor_user_id
     WHERE c.purchase_invoice_id = $1 ORDER BY c.created_at DESC`,
    [id]
  );

  return { invoice: invRows[0], lines, documents, corrections };
}

// --- Edit inbound records: header/identification fields only. Never
// quantity, rate, or GST — those already feed posted movement_ledger
// rows and batch cost data (see DECISIONS.md for why that line is
// drawn here, same reasoning as M13.3's batch_corrections split). ---

export const PURCHASE_INVOICE_CORRECTION_FIELDS = ["invoice_number", "invoice_date", "vendor_id", "payment_terms_days"] as const;
export type PurchaseInvoiceCorrectionField = (typeof PURCHASE_INVOICE_CORRECTION_FIELDS)[number];
export const PURCHASE_INVOICE_CORRECTION_REASON_CODES = ["data_entry_correction", "wrong_vendor_selected", "wrong_invoice_number", "other"] as const;
export type PurchaseInvoiceCorrectionReasonCode = (typeof PURCHASE_INVOICE_CORRECTION_REASON_CODES)[number];

export interface CorrectPurchaseInvoiceFieldInput {
  invoiceId: string;
  field: PurchaseInvoiceCorrectionField;
  newValue: string;
  reasonCode: PurchaseInvoiceCorrectionReasonCode;
  note: string;
  actorUserId: string;
  deviceId: string;
}

export async function correctPurchaseInvoiceField(input: CorrectPurchaseInvoiceFieldInput): Promise<void> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT ${input.field} AS current_value FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [input.invoiceId]);
    if (!rows[0]) throw new ValidationConflictError("invoice_not_found", null);
    const oldValue = String(rows[0].current_value);

    if (input.field === "vendor_id") {
      const vendor = await getVendor(input.newValue);
      if (!vendor) throw new ValidationConflictError("vendor_not_found", null);
    }

    await client.query(`UPDATE purchase_invoices SET ${input.field} = $1 WHERE id = $2`, [input.newValue, input.invoiceId]);
    await client.query(
      `INSERT INTO purchase_invoice_corrections (purchase_invoice_id, field, old_value, new_value, reason_code, note, actor_user_id, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.invoiceId, input.field, oldValue, input.newValue, input.reasonCode, input.note, input.actorUserId, input.deviceId]
    );
    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") throw new ValidationConflictError("duplicate_invoice", null);
    throw err;
  } finally {
    client.release();
  }
}

// --- Invoice document upload: scanned/photographed evidence attached to
// an already-created record, for the ordinary manual-entry path where
// nothing was ever photographed at capture time (Section 6.3's AI-scan
// path already keeps its own page images). ---

export async function addPurchaseInvoiceDocument(invoiceId: string, filePath: string, mimeType: string, uploadedBy: string): Promise<{ id: string }> {
  const { rows } = await requirePool().query(
    `INSERT INTO purchase_invoice_documents (purchase_invoice_id, file_path, mime_type, uploaded_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [invoiceId, filePath, mimeType, uploadedBy]
  );
  return { id: rows[0].id };
}

export async function getPurchaseInvoiceDocument(id: string): Promise<{ filePath: string; mimeType: string } | null> {
  const { rows } = await requirePool().query(`SELECT file_path, mime_type FROM purchase_invoice_documents WHERE id = $1`, [id]);
  return rows[0] ? { filePath: rows[0].file_path, mimeType: rows[0].mime_type } : null;
}
