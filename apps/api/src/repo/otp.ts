import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export async function insertOtp(phone: string, codeHash: string, ttlSeconds: number): Promise<void> {
  await requirePool().query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [phone, codeHash, ttlSeconds]
  );
}

export interface OtpRow {
  id: string;
  codeHash: string;
  attempts: number;
}

export async function findActiveOtp(phone: string): Promise<OtpRow | null> {
  const { rows } = await requirePool().query(
    `SELECT id, code_hash, attempts FROM otp_codes
     WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return rows[0] ? { id: rows[0].id, codeHash: rows[0].code_hash, attempts: rows[0].attempts } : null;
}

export async function incrementOtpAttempts(id: string): Promise<void> {
  await requirePool().query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [id]);
}

export async function consumeOtp(id: string): Promise<void> {
  await requirePool().query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [id]);
}
