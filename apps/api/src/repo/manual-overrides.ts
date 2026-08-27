import { pool } from "../db.js";

export const WEB_MANUAL_REASON_CODES = ["scanner_unavailable", "remote_correction", "device_failure", "training"] as const;
export type WebManualReasonCode = (typeof WEB_MANUAL_REASON_CODES)[number];
export type WebManualAction = "pick" | "pack" | "cycle_count" | "rider_handover";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export async function recordManualOverride(
  input: { action: WebManualAction; referenceType: string; referenceId: string; reasonCode: WebManualReasonCode; note: string; actorUserId: string; deviceId: string },
  client: { query: (text: string, params?: any[]) => Promise<any> } = requirePool()
): Promise<void> {
  await client.query(
    `INSERT INTO web_manual_overrides (action, reference_type, reference_id, reason_code, note, actor_user_id, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.action, input.referenceType, input.referenceId, input.reasonCode, input.note, input.actorUserId, input.deviceId]
  );
}

// Section 10.1: "Surface every web_manual row on a dedicated Manual
// Override report." Two sources feed it — movement_ledger rows already
// tagged source='web_manual' (put-away, packing's pack-time sale, cycle
// count adjustments) carry the actual stock effect; web_manual_overrides
// carries the human-readable reason for the two actions (pick,
// rider handover) that never touch the ledger at all. Combined here into
// one shape rather than making the report screen merge two API calls.
export interface ManualOverrideRow {
  id: string;
  occurredAt: string;
  action: string;
  referenceType: string;
  referenceId: string;
  reasonCode: string | null;
  note: string | null;
  actorName: string;
  deviceId: string;
}

export async function listManualOverrides(): Promise<ManualOverrideRow[]> {
  const { rows } = await requirePool().query(`
    SELECT id, created_at AS occurred_at, action, reference_type, reference_id, reason_code, note, actor_name, device_id FROM (
      SELECT o.id, o.created_at, o.action, o.reference_type, o.reference_id::text, o.reason_code, o.note, u.name AS actor_name, o.device_id
      FROM web_manual_overrides o JOIN users u ON u.id = o.actor_user_id
      UNION ALL
      SELECT m.id, m.created_at, m.movement_type::text, m.reference_type, m.reference_id::text, m.reason_code, m.note, u.name AS actor_name, m.device_id
      FROM movement_ledger m JOIN users u ON u.id = m.actor_user_id
      WHERE m.source = 'web_manual'
    ) combined
    ORDER BY occurred_at DESC
    LIMIT 500
  `);
  return rows.map((r: any) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    action: r.action,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    reasonCode: r.reason_code,
    note: r.note,
    actorName: r.actor_name,
    deviceId: r.device_id,
  }));
}

export async function countManualOverridesSince(since: Date): Promise<number> {
  const { rows } = await requirePool().query(
    `SELECT
       (SELECT count(*) FROM web_manual_overrides WHERE created_at >= $1) +
       (SELECT count(*) FROM movement_ledger WHERE source = 'web_manual' AND created_at >= $1) AS total`,
    [since]
  );
  return Number(rows[0].total);
}
