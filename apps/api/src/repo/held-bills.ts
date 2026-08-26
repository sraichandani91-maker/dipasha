import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Hold and recall (Section 6A.4): "park a bill mid-way... start
// another. Multiple bills held at once, recallable by number or
// customer name." Just a JSONB parking slot for the client's
// in-progress bill state — never touches stock or a bill number.
export async function listHeldBills() {
  const { rows } = await requirePool().query(
    `SELECT id, label, payload, created_at FROM held_bills ORDER BY created_at DESC`
  );
  return rows;
}

export async function createHeldBill(label: string, payload: unknown, createdBy: string, deviceId: string) {
  const { rows } = await requirePool().query(
    `INSERT INTO held_bills (label, payload, created_by, device_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [label, JSON.stringify(payload), createdBy, deviceId]
  );
  return rows[0].id as string;
}

export async function deleteHeldBill(id: string): Promise<boolean> {
  const result = await requirePool().query(`DELETE FROM held_bills WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
