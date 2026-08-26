import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

// Minimal for now — quick-attach by phone with a lookup of past
// purchases (Section 6A.4). Credit limits, ageing, statements are
// Section 9A.4 / 10B.1, not in scope until M9A/M15.
export async function findCustomerByPhone(phone: string): Promise<Customer | null> {
  const { rows } = await requirePool().query(`SELECT id, name, phone FROM customers WHERE phone = $1 LIMIT 1`, [phone]);
  return rows[0] ?? null;
}

export async function findOrCreateCustomer(name: string, phone: string | null): Promise<Customer> {
  if (phone) {
    const existing = await findCustomerByPhone(phone);
    if (existing) return existing;
  }
  const { rows } = await requirePool().query(`INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id, name, phone`, [name, phone]);
  return rows[0];
}

export async function getRecentPurchases(customerId: string, limit = 10) {
  const { rows } = await requirePool().query(
    `SELECT s.id, s.bill_number, s.grand_total, s.created_at
     FROM sales s WHERE s.customer_id = $1 AND s.status = 'completed'
     ORDER BY s.created_at DESC LIMIT $2`,
    [customerId, limit]
  );
  return rows;
}
