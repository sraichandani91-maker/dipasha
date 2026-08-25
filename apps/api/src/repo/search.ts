import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface SearchResultProduct {
  id: string;
  name: string;
  manufacturer: string;
  form: string;
  scheduleCategory: string;
  isColdChain: boolean;
  packSize: number;
  baseUnit: string;
  substituteGroupId: string;
  mrp: number | null;
  perBaseUnitRate: number | null;
  stockBaseUnits: number;
  nearestExpiry: string | null;
  topBinCode: string | null;
  score: number;
}

export interface SearchGroup {
  substituteGroupId: string;
  compositionLabel: string; // e.g. "Paracetamol 650mg — tablet"
  products: SearchResultProduct[];
  isExactMatchGroup: boolean;
  groupScore: number;
}

export interface SearchResponse {
  mode: "barcode" | "brand" | "salt" | "ambiguous";
  exactProductId: string | null;
  groups: SearchGroup[];
}

// Once we know a query landed an exact brand match, pull in every other
// brand sharing that same substitute group — they wouldn't otherwise
// match the query text at all (searching "dolo" doesn't trigram-match
// "Paracetamol"), but Section 5B.2 requires the whole group show up
// under the exact match, not just whatever else happened to match.
async function fetchSubstituteGroupSiblings(substituteGroupId: string, excludeId: string): Promise<string[]> {
  const { rows } = await requirePool().query(
    `SELECT id FROM products WHERE substitute_group_id = $1 AND id <> $2 AND status = 'active'`,
    [substituteGroupId, excludeId]
  );
  return rows.map((r) => r.id);
}

async function fetchCandidateProducts(query: string): Promise<{ ids: string[]; scoreById: Map<string, number>; saltHitById: Map<string, number> }> {
  const db = requirePool();

  const { rows: byNameOrManufacturer } = await db.query(
    `
    SELECT id, GREATEST(similarity(name, $1), similarity(manufacturer, $1)) AS score
    FROM products
    WHERE status = 'active' AND (name % $1 OR manufacturer % $1)
    `,
    [query]
  );

  const { rows: bySalt } = await db.query(
    `
    SELECT DISTINCT pc.product_id AS id, GREATEST(sim.name_score, COALESCE(sim.syn_score, 0)) AS score
    FROM product_compositions pc
    JOIN (
      SELECT id, similarity(name, $1) AS name_score, NULL::real AS syn_score FROM salts WHERE name % $1
      UNION ALL
      SELECT s.id, 0, similarity(ss.synonym, $1) FROM salts s JOIN salt_synonyms ss ON ss.salt_id = s.id WHERE ss.synonym % $1
    ) sim ON sim.id = pc.salt_id
    JOIN products p ON p.id = pc.product_id AND p.status = 'active'
    `,
    [query]
  );

  const scoreById = new Map<string, number>();
  const saltHitById = new Map<string, number>();
  for (const r of byNameOrManufacturer) {
    scoreById.set(r.id, Math.max(scoreById.get(r.id) ?? 0, Number(r.score)));
  }
  for (const r of bySalt) {
    scoreById.set(r.id, Math.max(scoreById.get(r.id) ?? 0, Number(r.score)));
    saltHitById.set(r.id, Math.max(saltHitById.get(r.id) ?? 0, Number(r.score)));
  }
  return { ids: [...scoreById.keys()], scoreById, saltHitById };
}

export async function search(query: string, limit = 40): Promise<SearchResponse> {
  const db = requirePool();
  const trimmed = query.trim();

  // Barcode: scanned input resolves directly to one product (Section
  // 5B.1) rather than going through fuzzy matching at all.
  if (/^\d{6,14}$/.test(trimmed)) {
    const { rows } = await db.query(`SELECT id FROM products WHERE barcode = $1 AND status = 'active'`, [trimmed]);
    if (rows.length > 0) {
      const groups = await buildGroups([rows[0].id], new Map([[rows[0].id, 1]]), new Map());
      return { mode: "barcode", exactProductId: rows[0].id, groups };
    }
  }

  const { ids, scoreById, saltHitById } = await fetchCandidateProducts(trimmed);
  if (ids.length === 0) return { mode: "ambiguous", exactProductId: null, groups: [] };

  const topByBrand = [...scoreById.entries()]
    .filter(([id]) => !saltHitById.has(id) || (scoreById.get(id) ?? 0) > (saltHitById.get(id) ?? 0) + 0.05)
    .sort((a, b) => b[1] - a[1])[0];
  const hasStrongSaltHit = [...saltHitById.values()].some((s) => s >= 0.35);
  const hasStrongBrandHit = topByBrand !== undefined && topByBrand[1] >= 0.35;

  let mode: SearchResponse["mode"] = "ambiguous";
  let exactProductId: string | null = null;
  if (hasStrongBrandHit && (!hasStrongSaltHit || (topByBrand?.[1] ?? 0) > 0.5)) {
    mode = "brand";
    exactProductId = topByBrand![0];
  } else if (hasStrongSaltHit) {
    mode = "salt";
  }

  const limitedIds = [...scoreById.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);

  if (mode === "brand" && exactProductId) {
    const { rows } = await db.query(`SELECT substitute_group_id FROM products WHERE id = $1`, [exactProductId]);
    const groupId = rows[0]?.substitute_group_id;
    if (groupId) {
      const siblings = await fetchSubstituteGroupSiblings(groupId, exactProductId);
      for (const sibId of siblings) {
        if (!limitedIds.includes(sibId)) {
          limitedIds.push(sibId);
          scoreById.set(sibId, 0);
        }
      }
    }
  }

  const groups = await buildGroups(limitedIds, scoreById, saltHitById, exactProductId);

  return { mode, exactProductId, groups };
}

async function buildGroups(
  productIds: string[],
  scoreById: Map<string, number>,
  saltHitById: Map<string, number>,
  exactProductId: string | null = null
): Promise<SearchGroup[]> {
  const db = requirePool();
  if (productIds.length === 0) return [];

  const { rows } = await db.query(
    `
    SELECT
      p.id, p.name, p.manufacturer, p.form, p.schedule_category, p.is_cold_chain,
      p.pack_size, p.base_unit, p.substitute_group_id,
      MIN(b.mrp) AS mrp,
      COALESCE(SUM(s.quantity_base_units), 0)::int AS stock_base_units,
      MIN(b.expiry_date) FILTER (WHERE COALESCE(s.quantity_base_units, 0) > 0 AND NOT b.blocked) AS nearest_expiry,
      (
        SELECT bins.code FROM stock s2
        JOIN bins ON bins.id = s2.bin_id
        WHERE s2.product_id = p.id AND s2.quantity_base_units > 0
        ORDER BY s2.quantity_base_units DESC LIMIT 1
      ) AS top_bin_code
    FROM products p
    LEFT JOIN batches b ON b.product_id = p.id
    LEFT JOIN stock s ON s.batch_id = b.id
    WHERE p.id = ANY($1::uuid[])
    GROUP BY p.id
    `,
    [productIds]
  );

  const { rows: compositionRows } = await db.query(
    `
    SELECT pc.product_id, sa.name AS salt_name, pc.strength
    FROM product_compositions pc JOIN salts sa ON sa.id = pc.salt_id
    WHERE pc.product_id = ANY($1::uuid[])
    ORDER BY pc.product_id, pc.position
    `,
    [productIds]
  );
  const compositionByProduct = new Map<string, string[]>();
  for (const c of compositionRows) {
    const list = compositionByProduct.get(c.product_id) ?? [];
    list.push(`${c.salt_name} ${c.strength}`);
    compositionByProduct.set(c.product_id, list);
  }

  const groupMap = new Map<string, SearchGroup>();
  for (const r of rows) {
    const product: SearchResultProduct = {
      id: r.id,
      name: r.name,
      manufacturer: r.manufacturer,
      form: r.form,
      scheduleCategory: r.schedule_category,
      isColdChain: r.is_cold_chain,
      packSize: r.pack_size,
      baseUnit: r.base_unit,
      substituteGroupId: r.substitute_group_id,
      mrp: r.mrp === null ? null : Number(r.mrp),
      perBaseUnitRate: r.mrp === null ? null : Number(r.mrp) / r.pack_size,
      stockBaseUnits: r.stock_base_units,
      nearestExpiry: r.nearest_expiry,
      topBinCode: r.top_bin_code,
      score: scoreById.get(r.id) ?? 0,
    };

    const key = r.substitute_group_id;
    if (!groupMap.has(key)) {
      const compLabel = (compositionByProduct.get(r.id) ?? []).join(" + ");
      groupMap.set(key, {
        substituteGroupId: key,
        compositionLabel: `${compLabel} — ${r.form}`,
        products: [],
        isExactMatchGroup: false,
        groupScore: 0,
      });
    }
    const group = groupMap.get(key)!;
    group.products.push(product);
    group.groupScore = Math.max(group.groupScore, product.score);
    if (product.id === exactProductId) group.isExactMatchGroup = true;
  }

  // Within-group sort: in-stock first, then MRP ascending (Section
  // 5B.2's stated default — the search_sort_within_group setting exists
  // for the Owner to change this later, once the settings screen (M13)
  // can write to it).
  for (const group of groupMap.values()) {
    group.products.sort((a, b) => {
      const aInStock = a.stockBaseUnits > 0 ? 0 : 1;
      const bInStock = b.stockBaseUnits > 0 ? 0 : 1;
      if (aInStock !== bInStock) return aInStock - bInStock;
      return (a.mrp ?? Infinity) - (b.mrp ?? Infinity);
    });
  }

  return [...groupMap.values()].sort((a, b) => {
    if (a.isExactMatchGroup !== b.isExactMatchGroup) return a.isExactMatchGroup ? -1 : 1;
    return b.groupScore - a.groupScore;
  });
}

export async function logSearch(query: string, context: string | null, resultCount: number, userId: string | null): Promise<void> {
  await requirePool().query(
    `INSERT INTO search_log (query, context, result_count, user_id) VALUES ($1, $2, $3, $4)`,
    [query, context, resultCount, userId]
  );
}
