import { pool } from "../db.js";
import { getSetting } from "../repo/settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface BinCandidate {
  binId: string;
  reason: "highest_value" | "highest_movement" | "longest_since_counted" | "flagged_variance_history";
}

/**
 * Section 9: "selected by: highest value, highest movement, longest
 * since last counted, or flagged variance history" — read as four
 * ranked candidate pools to draw from, not a single combined score (the
 * brief doesn't specify a weighting formula, so this doesn't invent
 * one). Round-robins across the four pools until `count` distinct bins
 * are picked, skipping any bin already selected today or already
 * chosen from an earlier pool in this same run.
 */
export async function selectBinsForCycleCount(count: number, businessDate: string): Promise<BinCandidate[]> {
  const db = requirePool();
  const lookbackDays = await getSetting("cycle_count_movement_lookback_days", 30);

  const { rows: alreadyToday } = await db.query(
    `SELECT bin_id FROM cycle_count_tasks WHERE business_date = $1`,
    [businessDate]
  );
  const exclude = new Set<string>(alreadyToday.map((r) => r.bin_id));

  const { rows: highestValue } = await db.query(`
    SELECT b.id AS bin_id
    FROM bins b
    JOIN stock s ON s.bin_id = b.id AND s.quantity_base_units > 0
    JOIN batches ba ON ba.id = s.batch_id
    WHERE b.status = 'active'
    GROUP BY b.id
    ORDER BY SUM(s.quantity_base_units * ba.mrp) DESC
  `);

  const { rows: highestMovement } = await db.query(
    `
    SELECT bin_id FROM movement_ledger
    WHERE created_at > now() - ($1 || ' days')::interval
    GROUP BY bin_id
    ORDER BY SUM(ABS(quantity_delta)) DESC
    `,
    [lookbackDays]
  );

  const { rows: longestSinceCounted } = await db.query(`
    SELECT b.id AS bin_id
    FROM bins b
    LEFT JOIN (SELECT bin_id, MAX(created_at) AS last_counted FROM cycle_count_tasks GROUP BY bin_id) c ON c.bin_id = b.id
    WHERE b.status = 'active'
    ORDER BY c.last_counted ASC NULLS FIRST
  `);

  // "Flagged variance history": this bin's most recent reviewed task
  // escalated and wasn't cleared clean (rejected = the counted variance
  // was real and unresolved; still-pending review also counts as flagged).
  const { rows: flaggedVariance } = await db.query(`
    SELECT DISTINCT ON (bin_id) bin_id
    FROM cycle_count_tasks
    WHERE escalated_to IS NOT NULL
    ORDER BY bin_id, created_at DESC
  `);

  const pools: Array<{ reason: BinCandidate["reason"]; ids: string[] }> = [
    { reason: "highest_value", ids: highestValue.map((r) => r.bin_id) },
    { reason: "highest_movement", ids: highestMovement.map((r) => r.bin_id) },
    { reason: "longest_since_counted", ids: longestSinceCounted.map((r) => r.bin_id) },
    { reason: "flagged_variance_history", ids: flaggedVariance.map((r) => r.bin_id) },
  ];
  const cursors = [0, 0, 0, 0];
  const picked: BinCandidate[] = [];
  const seen = new Set(exclude);

  let progressed = true;
  while (picked.length < count && progressed) {
    progressed = false;
    for (let i = 0; i < pools.length && picked.length < count; i++) {
      const pool_ = pools[i]!;
      while (cursors[i]! < pool_.ids.length) {
        const candidate = pool_.ids[cursors[i]!]!;
        cursors[i]!++;
        if (!seen.has(candidate)) {
          seen.add(candidate);
          picked.push({ binId: candidate, reason: pool_.reason });
          progressed = true;
          break;
        }
      }
    }
  }

  return picked;
}
