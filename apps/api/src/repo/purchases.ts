import { pool } from "../db.js";
import { getSetting } from "./settings.js";
import { getVendor } from "./vendors.js";
import { findOrCreateBatch, findStagingBin } from "./batches.js";
import { apportionByTaxableValue, computeEffectiveCostPerBaseUnit } from "../domain/landed-cost.js";
import { splitGst } from "../domain/gst-split.js";
import { suggestPutawayBin } from "../domain/putaway-suggestion.js";

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
  createdBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
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
          net_payable_computed, reconciliation_diff, reconciliation_acknowledged, source, created_by, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        input.vendorId, input.invoiceNumber, input.invoiceDate, input.invoiceValueStated, input.paymentTermsDays,
        input.billLevelDiscount, input.freightAndCharges, input.roundOff, round2(taxableValueTotal), round2(taxTotal),
        round2(netPayableComputed), round2(reconciliationDiff), Math.abs(reconciliationDiff) > tolerance,
        input.source, input.createdBy, input.deviceId,
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
            apportioned_bill_discount, apportioned_charges)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          invoiceId, l.productId, batch.id, l.packAsPrinted, l.quantityBaseUnits, l.freeQuantityBaseUnits,
          l.rateBeforeDiscount, l.discountPercent, round2(l.discountValue), round2(l.taxableValue), l.gstRate,
          round2(l.cgstAmount), round2(l.sgstAmount), round2(l.igstAmount), round2(l.cessAmount), round2(l.lineTotal),
          l.apportionedBillDiscount, l.apportionedCharges,
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

    await client.query("COMMIT");
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
