import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class DayCloseError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface CashPreview {
  businessDate: string;
  expectedCash: number;
  tenderBreakdown: Record<string, number>;
}

// Expected cash is always server-computed from actual tenders on
// completed sales — never trusted from the client (Section 6A.5 /
// Section 8's "expected vs declared, variance flagged" pattern).
export async function previewCash(businessDate: string): Promise<CashPreview> {
  const { rows } = await requirePool().query(
    `SELECT st.tender_type, SUM(st.amount)::numeric AS total
     FROM sale_tenders st JOIN sales s ON s.id = st.sale_id
     WHERE s.business_date = $1 AND s.status = 'completed'
     GROUP BY st.tender_type`,
    [businessDate]
  );
  const breakdown: Record<string, number> = {};
  for (const r of rows) breakdown[r.tender_type] = Number(r.total);
  return { businessDate, expectedCash: breakdown.cash ?? 0, tenderBreakdown: breakdown };
}

export async function closeDay(businessDate: string, declaredCash: number, note: string | null, closedBy: string, deviceId: string) {
  const db = requirePool();
  const existing = await db.query(`SELECT id FROM day_close WHERE business_date = $1`, [businessDate]);
  if (existing.rows.length > 0) throw new DayCloseError("already_closed");

  const preview = await previewCash(businessDate);
  const variance = Math.round((declaredCash - preview.expectedCash) * 100) / 100;

  const { rows } = await db.query(
    `INSERT INTO day_close (business_date, expected_cash, declared_cash, variance, note, closed_by, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [businessDate, preview.expectedCash, declaredCash, variance, note, closedBy, deviceId]
  );
  return { id: rows[0].id, expectedCash: preview.expectedCash, declaredCash, variance };
}
