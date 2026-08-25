import { pool } from "../db.js";

export type UserRole = "owner" | "store_manager" | "picker_packer" | "rider";

export interface User {
  id: string;
  phone: string;
  name: string;
  role: UserRole;
  pinHash: string | null;
  status: "active" | "suspended";
}

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

function mapRow(row: any): User {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    role: row.role,
    pinHash: row.pin_hash,
    status: row.status,
  };
}

export async function findUserByPhone(phone: string): Promise<User | null> {
  const { rows } = await requirePool().query(
    `SELECT id, phone, name, role, pin_hash, status FROM users WHERE phone = $1`,
    [phone]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await requirePool().query(
    `SELECT id, phone, name, role, pin_hash, status FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createUser(input: {
  phone: string;
  name: string;
  role: UserRole;
  pinHash: string | null;
  createdBy?: string | null;
}): Promise<User> {
  const { rows } = await requirePool().query(
    `INSERT INTO users (phone, name, role, pin_hash, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, phone, name, role, pin_hash, status`,
    [input.phone, input.name, input.role, input.pinHash, input.createdBy ?? null]
  );
  return mapRow(rows[0]);
}
