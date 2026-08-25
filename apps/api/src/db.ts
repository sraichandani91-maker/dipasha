import pg from "pg";
import { config } from "./config.js";

export const pool = config.databaseUrl
  ? new pg.Pool({ connectionString: config.databaseUrl, max: 10 })
  : null;

export async function pingDatabase(): Promise<boolean> {
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}
