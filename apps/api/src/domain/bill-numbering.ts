import { getSetting } from "../repo/settings.js";

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * Strict sequential, gapless bill/credit-note numbering (Section 6A.6:
 * "a gap in bill numbering is an audit problem"). Must be called inside
 * the same transaction that inserts the row using the number — if that
 * transaction rolls back, this increment rolls back with it, unlike a
 * Postgres SEQUENCE (which never rolls back and would leave a gap).
 */
export async function reserveNumber(client: QueryClient, seriesPrefix: string): Promise<string> {
  await client.query(
    `INSERT INTO bill_number_counters (prefix, next_number) VALUES ($1, 1)
     ON CONFLICT (prefix) DO NOTHING`,
    [seriesPrefix]
  );
  const { rows } = await client.query(
    `UPDATE bill_number_counters SET next_number = next_number + 1 WHERE prefix = $1 RETURNING next_number - 1 AS number`,
    [seriesPrefix]
  );
  const number = rows[0].number as number;
  return `${seriesPrefix}-${String(number).padStart(6, "0")}`;
}

export async function billSeriesPrefix(channel: "counter" | "delivery"): Promise<string> {
  const base = await getSetting("bill_number_prefix", "DPS");
  const separate = await getSetting("separate_bill_series_by_channel", false);
  if (!separate) return base;
  return `${base}-${channel === "counter" ? "C" : "D"}`;
}
