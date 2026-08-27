import { pool } from "../db.js";
import { getSetting } from "./settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface RecordTemperatureInput {
  temperatureCelsius: number;
  note: string | null;
  recordedBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
}

/**
 * Section 9 cold-chain temperature log. `in_range` is computed once at
 * write time against the settings in effect then — a later change to
 * the configured range shouldn't silently reclassify history.
 */
export async function recordTemperature(input: RecordTemperatureInput): Promise<{ id: string; inRange: boolean }> {
  const min = await getSetting("cold_chain_temp_min_celsius", 2);
  const max = await getSetting("cold_chain_temp_max_celsius", 8);
  const inRange = input.temperatureCelsius >= min && input.temperatureCelsius <= max;

  const { rows } = await requirePool().query(
    `INSERT INTO cold_chain_temperature_logs (temperature_celsius, in_range, note, recorded_by, device_id, source)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.temperatureCelsius, inRange, input.note, input.recordedBy, input.deviceId, input.source]
  );
  return { id: rows[0].id, inRange };
}

export interface TemperatureLogFilter {
  from?: string;
  to?: string;
}

export async function listTemperatureLogs(filter: TemperatureLogFilter) {
  const db = requirePool();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.from) { params.push(filter.from); where.push(`l.recorded_at >= $${params.length}`); }
  if (filter.to) { params.push(`${filter.to} 23:59:59`); where.push(`l.recorded_at <= $${params.length}`); }

  const { rows } = await db.query(
    `SELECT l.*, u.name AS recorded_by_name
     FROM cold_chain_temperature_logs l JOIN users u ON u.id = l.recorded_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY l.recorded_at DESC
     LIMIT 500`,
    params
  );
  return rows;
}

export interface GapCheckResult {
  hasGap: boolean;
  lastReadingAt: string | null;
  hoursSinceLastReading: number | null;
  maxGapHours: number;
  lastReadingOutOfRange: boolean;
  minCelsius: number;
  maxCelsius: number;
}

/**
 * Section 10.2 "gap alerts" — computed live on request, same pattern as
 * M5's daily-request-review check: no background worker, the web client
 * polls this and shows a banner when it says to.
 */
export async function checkTemperatureGap(): Promise<GapCheckResult> {
  const [minCelsius, maxCelsius, maxGapHours] = await Promise.all([
    getSetting("cold_chain_temp_min_celsius", 2),
    getSetting("cold_chain_temp_max_celsius", 8),
    getSetting("cold_chain_max_gap_hours", 8),
  ]);
  const { rows } = await requirePool().query(
    `SELECT recorded_at, in_range FROM cold_chain_temperature_logs ORDER BY recorded_at DESC LIMIT 1`
  );
  const last = rows[0];
  if (!last) {
    return { hasGap: true, lastReadingAt: null, hoursSinceLastReading: null, maxGapHours, lastReadingOutOfRange: false, minCelsius, maxCelsius };
  }
  const hoursSince = (Date.now() - new Date(last.recorded_at).getTime()) / (1000 * 60 * 60);
  return {
    hasGap: hoursSince > maxGapHours,
    lastReadingAt: last.recorded_at,
    hoursSinceLastReading: Math.round(hoursSince * 10) / 10,
    maxGapHours,
    lastReadingOutOfRange: !last.in_range,
    minCelsius,
    maxCelsius,
  };
}
