/**
 * Section 6.4: CGST/SGST vs IGST is split automatically from the
 * vendor's GSTIN state code against the shop's own — "never ask the
 * user which one applies."
 *
 * GST treatment note (flagged in DECISIONS.md): this is computed on the
 * line's own taxable value (quantity x rate, less line discount) only.
 * The bill-level discount and freight/charges from Section 6.4/6.5 are
 * treated purely as landed-cost adjustments here, not as reductions to
 * the GST taxable value — confirm this matches how the shop's
 * distributors actually structure their invoices before relying on this
 * for real GST filing.
 */

export interface GstSplit {
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
}

export function splitGst(taxableValue: number, gstRate: number, vendorStateCode: string, shopStateCode: string): GstSplit {
  const totalTax = (taxableValue * gstRate) / 100;
  const inState = vendorStateCode === shopStateCode;
  if (inState) {
    return { cgstAmount: totalTax / 2, sgstAmount: totalTax / 2, igstAmount: 0 };
  }
  return { cgstAmount: 0, sgstAmount: 0, igstAmount: totalTax };
}
