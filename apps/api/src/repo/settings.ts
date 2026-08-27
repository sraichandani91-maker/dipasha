import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

const cache = new Map<string, unknown>();

// Settings change rarely and are read on nearly every purchase/billing
// request — a short in-process cache avoids a round trip per validation
// without needing a whole settings-invalidation system yet (M13 adds the
// settings screen; revisit caching then if it needs to be instant).
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    cache.clear();
    cacheLoadedAt = Date.now();
  }
  if (cache.has(key)) return cache.get(key) as T;
  const { rows } = await requirePool().query(`SELECT value FROM settings WHERE key = $1`, [key]);
  const value = rows[0] ? rows[0].value : fallback;
  cache.set(key, value);
  return value as T;
}

// --- M13.9: the settings screen. Every threshold seeded across every
// migration since M1 lives in this one table already — this is read/
// write parity for it, not a new mechanism. ---

export interface SettingRow {
  key: string;
  value: unknown;
  description: string;
  updatedAt: string;
  updatedByName: string | null;
}

export async function listSettings(): Promise<SettingRow[]> {
  const { rows } = await requirePool().query(
    `SELECT s.key, s.value, s.description, s.updated_at, u.name AS updated_by_name
     FROM settings s LEFT JOIN users u ON u.id = s.updated_by
     ORDER BY s.key`
  );
  return rows.map((r) => ({ key: r.key, value: r.value, description: r.description, updatedAt: r.updated_at, updatedByName: r.updated_by_name }));
}

export class SettingError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/**
 * The new value must be the same JSON type as what's there now (string
 * stays a string, number stays a number, etc.) — this table backs real
 * threshold checks all over the app (`getSetting<number>`, `<string>`,
 * `<boolean>`), so a type-changing edit here would surface as a subtle
 * runtime bug somewhere else entirely rather than a clear error at the
 * point of the actual mistake.
 */
export async function updateSetting(key: string, value: unknown, actorUserId: string): Promise<void> {
  const db = requirePool();
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (!rows[0]) throw new SettingError("not_found");
  const currentType = rows[0].value === null ? "null" : Array.isArray(rows[0].value) ? "array" : typeof rows[0].value;
  const newType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (currentType !== "null" && newType !== "null" && currentType !== newType) {
    throw new SettingError("type_mismatch");
  }
  await db.query(`UPDATE settings SET value = $1, updated_at = now(), updated_by = $2 WHERE key = $3`, [JSON.stringify(value), actorUserId, key]);
  cache.delete(key);
}
