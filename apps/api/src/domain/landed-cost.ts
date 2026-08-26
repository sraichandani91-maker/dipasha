/**
 * Section 6.5 — "the single computation everything downstream depends
 * on." Compute once, on the batch, never recompute ad hoc elsewhere.
 *
 * Per base unit, for each batch: quantity times rate, less the line
 * discount, plus the apportioned share of any bill-level discount (as a
 * reduction), plus the apportioned share of freight/other bill-level
 * charges — divided by total base units ACTUALLY RECEIVED, including
 * free quantity. Getting the free-quantity divisor wrong is the
 * documented single most common and consequential mistake here (a 10+1
 * scheme spreads cost across 11 units, not 10 — a ~9% difference that's
 * often bigger than the margin being measured).
 */

export interface LineCostInput {
  quantityBaseUnits: number;
  freeQuantityBaseUnits: number;
  rateBeforeDiscount: number;
  discountValue: number;
  apportionedBillDiscount: number;
  apportionedCharges: number;
}

export function computeEffectiveCostPerBaseUnit(input: LineCostInput): number {
  const totalBaseUnitsReceived = input.quantityBaseUnits + input.freeQuantityBaseUnits;
  if (totalBaseUnitsReceived <= 0) {
    throw new Error("total base units received must be positive");
  }
  const lineCost =
    input.quantityBaseUnits * input.rateBeforeDiscount -
    input.discountValue -
    input.apportionedBillDiscount +
    input.apportionedCharges;
  return lineCost / totalBaseUnitsReceived;
}

/**
 * Apportion a bill-level amount (discount or freight/charges) across
 * invoice lines proportionally by taxable value (Section 6.4: "It must
 * apportion across lines proportionally by taxable value so that
 * per-line landed cost stays correct").
 */
export function apportionByTaxableValue(billLevelAmount: number, lineTaxableValues: number[]): number[] {
  const total = lineTaxableValues.reduce((a, b) => a + b, 0);
  if (total <= 0) return lineTaxableValues.map(() => 0);
  return lineTaxableValues.map((v) => (billLevelAmount * v) / total);
}
