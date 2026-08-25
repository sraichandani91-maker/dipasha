import { createHash } from "node:crypto";

export interface CompositionInput {
  saltId: string;
  strength: string;
}

/**
 * Deterministic substitute_group_id from composition + strength + form
 * (Section 6B.2: "auto-assign substitute_group_id by matching composition
 * plus strength plus form... it should populate itself rather than
 * relying on manual upkeep"). Composition, strength and form must match
 * EXACTLY (Section 5B.4) — never group across differing strengths, never
 * treat a modified-release form as interchangeable with an
 * immediate-release one. Same salts in a different order still hash the
 * same, since they're sorted first.
 *
 * Shared by the seed script and, later, the M2/M6B product-creation
 * endpoint — the rule only needs implementing once.
 */
export function substituteGroupKey(compositions: CompositionInput[], form: string): string {
  const normalized = [...compositions]
    .map((c) => `${c.saltId}:${c.strength.trim().toLowerCase()}`)
    .sort()
    .join("|");
  const hex = createHash("sha256")
    .update(`${normalized}::${form.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
