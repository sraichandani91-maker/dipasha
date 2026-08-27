import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class BinError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

// A-03-B-2 = aisle A, bay 03, shelf B, position 2 — the same structure
// the seed script already writes explicitly (scripts/seed.ts). Bins
// created through the API with only a code string (the web create form)
// used to leave aisle/bay/shelf_level/position NULL even when the code
// itself encodes them, which would have made those bins invisible to
// Section 10.2's rack map grouping — parsed here once, at creation, so
// every regular-format bin groups correctly regardless of how it was
// created.
const REGULAR_CODE = /^([A-Z]+)-(\d{2})-([A-Z])-(\d+)$/;
export function parseRegularBinCode(code: string): { aisle: string; bay: string; shelfLevel: string; position: number } | null {
  const m = REGULAR_CODE.exec(code);
  if (!m) return null;
  return { aisle: m[1]!, bay: m[2]!, shelfLevel: m[3]!, position: Number(m[4]) };
}

export interface Bin {
  id: string;
  code: string;
  zone: string | null;
  aisle: string | null;
  bay: string | null;
  shelfLevel: string | null;
  position: number | null;
  capacityScore: number | null;
  pickFrequencyRank: number | null;
  restricted: boolean;
  status: "active" | "retired";
}

function mapRow(r: any): Bin {
  return {
    id: r.id,
    code: r.code,
    zone: r.zone,
    aisle: r.aisle,
    bay: r.bay,
    shelfLevel: r.shelf_level,
    position: r.position,
    capacityScore: r.capacity_score === null ? null : Number(r.capacity_score),
    pickFrequencyRank: r.pick_frequency_rank,
    restricted: r.restricted,
    status: r.status,
  };
}

export async function listBins(params: { status?: string; zone?: string } = {}): Promise<Bin[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (params.status) {
    clauses.push(`status = $${i++}`);
    values.push(params.status);
  }
  if (params.zone) {
    clauses.push(`zone = $${i++}`);
    values.push(params.zone);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await requirePool().query(`SELECT * FROM bins ${where} ORDER BY code`, values);
  return rows.map(mapRow);
}

export async function getBinsByIds(ids: string[]): Promise<Bin[]> {
  if (ids.length === 0) return [];
  const { rows } = await requirePool().query(`SELECT * FROM bins WHERE id = ANY($1::uuid[]) ORDER BY code`, [ids]);
  return rows.map(mapRow);
}

export async function createBin(input: {
  code: string;
  zone: string | null;
  aisle: string | null;
  bay: string | null;
  shelfLevel: string | null;
  position: number | null;
  restricted: boolean;
}): Promise<Bin> {
  const parsed = !input.zone ? parseRegularBinCode(input.code) : null;
  const { rows } = await requirePool().query(
    `INSERT INTO bins (code, zone, aisle, bay, shelf_level, position, restricted, capacity_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,100) RETURNING *`,
    [
      input.code, input.zone,
      input.aisle ?? parsed?.aisle ?? null,
      input.bay ?? parsed?.bay ?? null,
      input.shelfLevel ?? parsed?.shelfLevel ?? null,
      input.position ?? parsed?.position ?? null,
      input.restricted,
    ]
  );
  return mapRow(rows[0]);
}

export interface UpdateBinInput {
  code?: string;
  capacityScore?: number;
  pickFrequencyRank?: number;
  restricted?: boolean;
  status?: "active" | "retired";
}

export async function updateBin(id: string, input: UpdateBinInput): Promise<boolean> {
  // Section 10.2: "create, rename, merge, retire bins" — retiring a bin
  // that still holds recorded stock would leave that stock invisible to
  // anyone using the bin master to judge what's usable, while the stock
  // view / FEFO would still happily allocate against it. A hard block,
  // same character as the cold-chain/SH1 zone-forcing rule (Section 6.6)
  // — a physical-consistency issue, not a judgment call. Merge (below)
  // or a plain move-stock task is how you actually empty a bin first.
  if (input.status === "retired") {
    const { rows } = await requirePool().query(
      `SELECT COALESCE(SUM(quantity_base_units), 0)::int AS total FROM stock WHERE bin_id = $1`,
      [id]
    );
    if (Number(rows[0].total) > 0) throw new BinError("bin_has_stock", { quantityBaseUnits: Number(rows[0].total) });
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [col, val] of Object.entries({
    code: input.code,
    capacity_score: input.capacityScore,
    pick_frequency_rank: input.pickFrequencyRank,
    restricted: input.restricted,
    status: input.status,
  })) {
    if (val === undefined) continue;
    sets.push(`${col} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0) return false;
  values.push(id);
  const result = await requirePool().query(`UPDATE bins SET ${sets.join(", ")} WHERE id = $${i}`, values);
  return (result.rowCount ?? 0) > 0;
}

// Section 10.2: "Visual rack map — a grid view of aisles, bays, and
// shelf levels with fill percentage and value heat." fillPercent is
// against each bin's own capacity_score (Owner-editable, default 100 —
// already an existing field, not invented for this) in base units; a
// bin with no capacity_score set (shouldn't happen via createBin, but
// defensive) reports fillPercent null rather than dividing by zero.
export interface RackMapBin {
  id: string;
  code: string;
  zone: string | null;
  aisle: string | null;
  bay: string | null;
  shelfLevel: string | null;
  position: number | null;
  capacityScore: number | null;
  status: "active" | "retired";
  quantityBaseUnits: number;
  value: number;
  fillPercent: number | null;
}

export async function getRackMap(): Promise<RackMapBin[]> {
  const { rows } = await requirePool().query(`
    SELECT b.id, b.code, b.zone, b.aisle, b.bay, b.shelf_level, b.position, b.capacity_score, b.status,
      COALESCE(s.total_qty, 0)::int AS quantity_base_units,
      COALESCE(s.total_value, 0)::numeric(12,2) AS value
    FROM bins b
    LEFT JOIN (
      SELECT st.bin_id, SUM(st.quantity_base_units) AS total_qty, SUM(st.quantity_base_units * ba.mrp / p.pack_size) AS total_value
      FROM stock st JOIN batches ba ON ba.id = st.batch_id JOIN products p ON p.id = st.product_id
      GROUP BY st.bin_id
    ) s ON s.bin_id = b.id
    WHERE b.status = 'active'
    ORDER BY b.aisle NULLS LAST, b.bay, b.shelf_level, b.position, b.code
  `);
  return rows.map((r: any) => ({
    id: r.id, code: r.code, zone: r.zone, aisle: r.aisle, bay: r.bay, shelfLevel: r.shelf_level,
    position: r.position, capacityScore: r.capacity_score === null ? null : Number(r.capacity_score),
    status: r.status, quantityBaseUnits: r.quantity_base_units, value: Number(r.value),
    fillPercent: r.capacity_score ? Math.round((r.quantity_base_units / Number(r.capacity_score)) * 1000) / 10 : null,
  }));
}
