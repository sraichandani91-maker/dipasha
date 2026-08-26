import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

/**
 * Section 6.6, step 2: "existing bin for that SKU -> nearest empty bin
 * in the correct zone -> any empty bin." Cold-chain and Schedule H1
 * products are constrained to their forced zone throughout (checked
 * again, and enforced as a hard rule, at actual put-away confirm time —
 * this function only produces the hint shown on the picker's screen).
 */
export async function suggestPutawayBin(
  productId: string,
  requiredZone: "CC" | "SH" | null
): Promise<{ id: string; code: string } | null> {
  const db = requirePool();

  const existing = await db.query(
    `
    SELECT b.id, b.code FROM stock s
    JOIN bins b ON b.id = s.bin_id
    WHERE s.product_id = $1 AND s.quantity_base_units > 0
      AND b.zone IS DISTINCT FROM 'IN' AND b.status = 'active'
      ${requiredZone ? "AND b.zone = $2" : ""}
    ORDER BY s.quantity_base_units DESC
    LIMIT 1
    `,
    requiredZone ? [productId, requiredZone] : [productId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const emptyInZone = await db.query(
    `
    SELECT b.id, b.code FROM bins b
    LEFT JOIN stock s ON s.bin_id = b.id AND s.quantity_base_units > 0
    WHERE b.status = 'active' AND s.bin_id IS NULL
      ${requiredZone ? "AND b.zone = $1" : "AND (b.zone IS NULL OR b.zone NOT IN ('IN','QC','PK'))"}
    ORDER BY b.code
    LIMIT 1
    `,
    requiredZone ? [requiredZone] : []
  );
  if (emptyInZone.rows.length > 0) return emptyInZone.rows[0];

  if (requiredZone) return null; // never fall back out of a forced zone

  const anyEmpty = await db.query(
    `
    SELECT b.id, b.code FROM bins b
    LEFT JOIN stock s ON s.bin_id = b.id AND s.quantity_base_units > 0
    WHERE b.status = 'active' AND s.bin_id IS NULL AND (b.zone IS NULL OR b.zone NOT IN ('IN','QC','PK'))
    ORDER BY b.code
    LIMIT 1
    `
  );
  return anyEmpty.rows[0] ?? null;
}
