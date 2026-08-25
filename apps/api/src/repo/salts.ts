import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface SaltMatch {
  id: string;
  name: string;
  matchedOn: "name" | "synonym";
  synonym: string | null;
}

// Backs the salt-master autocomplete (Section 6B.2: "typed against a salt
// master that grows as you add"). Trigram similarity over both the salt
// name and its synonyms, so "PCM" finds Paracetamol.
export async function searchSalts(q: string, limit = 10): Promise<SaltMatch[]> {
  const { rows } = await requirePool().query(
    `
    (
      SELECT id, name, 'name' AS matched_on, NULL::text AS synonym, similarity(name, $1) AS score
      FROM salts WHERE name % $1
    )
    UNION ALL
    (
      SELECT s.id, s.name, 'synonym' AS matched_on, ss.synonym, similarity(ss.synonym, $1) AS score
      FROM salt_synonyms ss JOIN salts s ON s.id = ss.salt_id
      WHERE ss.synonym % $1
    )
    ORDER BY score DESC
    LIMIT $2
    `,
    [q, limit]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, matchedOn: r.matched_on, synonym: r.synonym }));
}

export async function findSaltByExactName(name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await requirePool().query(`SELECT id, name FROM salts WHERE lower(name) = lower($1)`, [name]);
  return rows[0] ?? null;
}

export async function createSalt(name: string): Promise<{ id: string; name: string }> {
  const { rows } = await requirePool().query(`INSERT INTO salts (name) VALUES ($1) RETURNING id, name`, [name]);
  return rows[0];
}

// Idempotent: returns the existing salt if the name already exists
// (case-insensitive) rather than erroring, since "type it and it just
// works" is the whole point of a growing master list.
export async function findOrCreateSalt(name: string): Promise<{ id: string; name: string }> {
  const existing = await findSaltByExactName(name);
  if (existing) return existing;
  return createSalt(name);
}

export async function addSynonym(saltId: string, synonym: string): Promise<void> {
  await requirePool().query(
    `INSERT INTO salt_synonyms (salt_id, synonym) VALUES ($1, $2) ON CONFLICT (salt_id, synonym) DO NOTHING`,
    [saltId, synonym]
  );
}
