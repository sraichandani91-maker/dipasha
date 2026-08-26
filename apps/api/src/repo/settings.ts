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
