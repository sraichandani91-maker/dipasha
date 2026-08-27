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

// Section 6A.9: "Bill numbers reserved in blocks per device to prevent
// collisions on sync." One atomic advance of the same counter
// reserveNumber() uses, so a block reservation and a live online sale
// can never race for the same number — whichever commits first wins the
// range, exactly like reserveNumber()'s own single-number case.
export async function reserveBlock(client: QueryClient, seriesPrefix: string, blockSize: number): Promise<{ start: number; end: number }> {
  await client.query(
    `INSERT INTO bill_number_counters (prefix, next_number) VALUES ($1, 1)
     ON CONFLICT (prefix) DO NOTHING`,
    [seriesPrefix]
  );
  const { rows } = await client.query(
    `UPDATE bill_number_counters SET next_number = next_number + $2 WHERE prefix = $1 RETURNING next_number - $2 AS start`,
    [seriesPrefix, blockSize]
  );
  const start = rows[0].start as number;
  return { start, end: start + blockSize - 1 };
}

export function formatBillNumber(seriesPrefix: string, number: number): string {
  return `${seriesPrefix}-${String(number).padStart(6, "0")}`;
}
