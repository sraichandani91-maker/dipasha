import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class SqlConsoleError extends Error {
  constructor(public code: string, public detail?: string) {
    super(code);
  }
}

const ROW_CAP = 500;
const STATEMENT_TIMEOUT_MS = 5000;

/**
 * Section 10.2's SQL console. Owner-only (see routes) and read-only in
 * two independent layers, deliberately redundant rather than trusting
 * either alone:
 *   1. A text check rejects anything that isn't a single SELECT/WITH
 *      statement before it ever reaches Postgres — catches the obvious
 *      case with a clear error instead of a cryptic one from below.
 *   2. The query actually runs inside `SET TRANSACTION READ ONLY`, which
 *      Postgres itself enforces at the engine level — blocks INSERT/
 *      UPDATE/DELETE/DDL/TRUNCATE regardless of how they're spelled or
 *      wrapped (a CTE, a function call with a side effect), which a text
 *      check alone could never fully rule out.
 * Always rolled back, never committed, so it can never leave so much as
 * a sequence advanced. A statement timeout keeps a runaway scan from
 * tying up a connection indefinitely; the row cap keeps a huge result
 * from being shipped to the browser.
 */
export async function runReadOnlyQuery(query: string): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }> {
  const trimmed = query.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new SqlConsoleError("empty_query");
  if (trimmed.includes(";")) throw new SqlConsoleError("multiple_statements", "one statement at a time");
  if (!/^(select|with)\b/i.test(trimmed)) throw new SqlConsoleError("not_a_select", "only SELECT (or a WITH ... SELECT) is allowed");

  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(trimmed);
    await client.query("ROLLBACK");

    const columns = result.fields.map((f) => f.name);
    const truncated = result.rows.length > ROW_CAP;
    const rows = (truncated ? result.rows.slice(0, ROW_CAP) : result.rows).map((r) => columns.map((c) => r[c]));
    return { columns, rows, rowCount: result.rows.length, truncated };
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof SqlConsoleError) throw err;
    throw new SqlConsoleError("query_failed", err?.message ?? "unknown error");
  } finally {
    client.release();
  }
}
