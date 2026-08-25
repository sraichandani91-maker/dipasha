import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
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
  const { rows } = await requirePool().query(
    `INSERT INTO bins (code, zone, aisle, bay, shelf_level, position, restricted, capacity_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,100) RETURNING *`,
    [input.code, input.zone, input.aisle, input.bay, input.shelfLevel, input.position, input.restricted]
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
