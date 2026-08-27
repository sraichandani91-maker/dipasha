import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export async function recordActivity(input: { userId: string | null; method: string; path: string; route: string | null; statusCode: number }): Promise<void> {
  await requirePool().query(
    `INSERT INTO activity_log (user_id, method, path, route, status_code) VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.method, input.path, input.route, input.statusCode]
  );
}

export async function touchLastSeen(userId: string): Promise<void> {
  await requirePool().query(
    `INSERT INTO user_last_seen (user_id, last_seen_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()`,
    [userId]
  );
}

export interface ActivityLogRow {
  id: string;
  userId: string | null;
  userName: string | null;
  method: string;
  path: string;
  route: string | null;
  statusCode: number;
  occurredAt: string;
}

export async function listActivity(filter: { userId?: string; from?: string; to?: string; method?: string }): Promise<ActivityLogRow[]> {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filter.userId) {
    params.push(filter.userId);
    clauses.push(`a.user_id = $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from);
    clauses.push(`a.occurred_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(filter.to);
    clauses.push(`a.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  if (filter.method) {
    params.push(filter.method.toUpperCase());
    clauses.push(`a.method = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await requirePool().query(
    `SELECT a.id, a.user_id, u.name AS user_name, a.method, a.path, a.route, a.status_code, a.occurred_at
     FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
     ${where}
     ORDER BY a.occurred_at DESC
     LIMIT 1000`,
    params
  );
  return rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    method: r.method,
    path: r.path,
    route: r.route,
    statusCode: r.status_code,
    occurredAt: r.occurred_at,
  }));
}

// Shift/roster view (Section 10.2): "who is logged in now, hours logged
// this week." No real session table exists (stateless JWT) so this is an
// honest approximation — "logged in now" = active within the last 15
// minutes (the web session idle timeout, Section 10.4), and "hours" is
// each day's span from first to last recorded activity, summed over the
// last 7 days. It undercounts idle-but-still-logged-in time and can't
// see anyone who only ever made a single request in a day — a real
// clock-in/out system this is not, and DECISIONS.md says so.
export interface RosterRow {
  userId: string;
  userName: string;
  role: string;
  onlineNow: boolean;
  lastSeenAt: string | null;
  hoursThisWeek: number;
}

export async function listRoster(): Promise<RosterRow[]> {
  const { rows } = await requirePool().query(`
    SELECT u.id, u.name, u.role, ls.last_seen_at,
      (ls.last_seen_at IS NOT NULL AND ls.last_seen_at > now() - interval '15 minutes') AS online_now
    FROM users u
    LEFT JOIN user_last_seen ls ON ls.user_id = u.id
    WHERE u.status = 'active'
    ORDER BY online_now DESC, u.name
  `);
  const hoursRes = await requirePool().query(`
    SELECT user_id, occurred_at::date AS d, EXTRACT(epoch FROM (max(occurred_at) - min(occurred_at))) / 3600.0 AS span_hours
    FROM activity_log
    WHERE occurred_at > now() - interval '7 days' AND user_id IS NOT NULL
    GROUP BY user_id, occurred_at::date
  `);
  const hoursByUser = new Map<string, number>();
  for (const r of hoursRes.rows) {
    hoursByUser.set(r.user_id, (hoursByUser.get(r.user_id) ?? 0) + Number(r.span_hours));
  }
  return rows.map((r: any) => ({
    userId: r.id,
    userName: r.name,
    role: r.role,
    onlineNow: r.online_now,
    lastSeenAt: r.last_seen_at,
    hoursThisWeek: Math.round((hoursByUser.get(r.id) ?? 0) * 10) / 10,
  }));
}
