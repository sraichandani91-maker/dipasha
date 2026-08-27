import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 6A.9 / Section 11: "any conflict escalated to the Owner rather
// than silently resolved." Written once, at the moment a queued offline
// sale fails to replay — durable on the server so it's visible to the
// Owner regardless of which device raised it or whether that device's
// own local storage survives.
export async function recordSyncConflict(input: {
  deviceId: string;
  idempotencyKey: string;
  conflictType: string;
  errorDetails: unknown;
  originalPayload: unknown;
  raisedBy: string;
}) {
  const { rows } = await requirePool().query(
    `INSERT INTO sync_conflicts (device_id, idempotency_key, conflict_type, error_details, original_payload, raised_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO UPDATE SET error_details = EXCLUDED.error_details, created_at = sync_conflicts.created_at
     RETURNING id`,
    [input.deviceId, input.idempotencyKey, input.conflictType, JSON.stringify(input.errorDetails), JSON.stringify(input.originalPayload), input.raisedBy]
  );
  return { id: rows[0].id };
}

export async function listSyncConflicts(status?: "open" | "resolved") {
  const { rows } = await requirePool().query(
    status
      ? `SELECT sc.*, u.name AS raised_by_name FROM sync_conflicts sc JOIN users u ON u.id = sc.raised_by WHERE sc.status = $1 ORDER BY sc.created_at DESC`
      : `SELECT sc.*, u.name AS raised_by_name FROM sync_conflicts sc JOIN users u ON u.id = sc.raised_by ORDER BY sc.created_at DESC`,
    status ? [status] : []
  );
  return rows;
}

export class SyncConflictError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function resolveSyncConflict(id: string, resolutionNote: string, resolvedBy: string) {
  const { rows } = await requirePool().query(
    `UPDATE sync_conflicts SET status = 'resolved', resolution_note = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND status = 'open' RETURNING id`,
    [resolutionNote, resolvedBy, id]
  );
  if (rows.length === 0) throw new SyncConflictError("not_found_or_already_resolved");
}
