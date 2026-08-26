/**
 * Section 7 pick list generation: "Sort pick sequence by bin walk path,
 * not by order line sequence. Implement a simple serpentine path: aisle
 * A left-to-right, aisle B right-to-left, and so on."
 *
 * Aisled bins (regular shelving, `aisle` set) sort first, by aisle code,
 * alternating `position` ascending/descending per aisle index. Special-
 * zone bins (`aisle IS NULL` — CC/SH/RX/QC/PK/FM, per Section 4) have no
 * walk-path meaning, so they sort after every aisled bin, grouped by
 * zone then bin code — a defined, stable order, not a real walk path,
 * since the brief only describes serpentine aisles.
 */
export interface WalkPathBin {
  binId: string;
  aisle: string | null;
  bay: string | null;
  position: number | null;
  zone: string | null;
  code: string;
}

export function sortByWalkPath<T extends WalkPathBin>(bins: T[]): T[] {
  const aisleCodes = [...new Set(bins.filter((b) => b.aisle !== null).map((b) => b.aisle!))].sort();
  const aisleIndex = new Map(aisleCodes.map((a, i) => [a, i]));

  return [...bins].sort((a, b) => {
    const aAisled = a.aisle !== null;
    const bAisled = b.aisle !== null;
    if (aAisled !== bAisled) return aAisled ? -1 : 1; // aisled bins first
    if (!aAisled && !bAisled) {
      // Special zones: grouped by zone, then bin code — stable, not a walk path.
      const zoneCmp = (a.zone ?? "").localeCompare(b.zone ?? "");
      return zoneCmp !== 0 ? zoneCmp : a.code.localeCompare(b.code);
    }
    const ai = aisleIndex.get(a.aisle!)!;
    const bi = aisleIndex.get(b.aisle!)!;
    if (ai !== bi) return ai - bi;
    // Same aisle: even aisle index walks left-to-right (position ascending),
    // odd aisle index walks right-to-left (position descending) — the
    // serpentine turn at the end of each aisle.
    const forward = ai % 2 === 0;
    const posA = a.position ?? 0;
    const posB = b.position ?? 0;
    const posCmp = forward ? posA - posB : posB - posA;
    if (posCmp !== 0) return posCmp;
    return (a.bay ?? "").localeCompare(b.bay ?? "");
  });
}
