import { randomInt } from "node:crypto";

// For SKUs with no scannable manufacturer barcode (Section 9A.5). Not a
// real EAN — the "290" prefix sits in GS1's restricted-circulation-number
// range, reserved for exactly this kind of internal-only use, so it will
// never collide with a real product's barcode if one gets added later.
export function generateInternalBarcode(): string {
  const digits = Array.from({ length: 10 }, () => randomInt(0, 10)).join("");
  return `290${digits}`;
}
