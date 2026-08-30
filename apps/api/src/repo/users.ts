import { pool } from "../db.js";

export type UserRole = "owner" | "store_manager" | "picker_packer" | "rider";

export interface User {
  id: string;
  username: string | null;
  phone: string | null;
  name: string;
  role: UserRole;
  pinHash: string | null;
  passwordHash: string | null;
  status: "active" | "suspended";
}

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

const USER_COLUMNS = "id, username, phone, name, role, pin_hash, password_hash, status";

function mapRow(row: any): User {
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    name: row.name,
    role: row.role,
    pinHash: row.pin_hash,
    passwordHash: row.password_hash,
    status: row.status,
  };
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const { rows } = await requirePool().query(
    `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`,
    [username]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await requirePool().query(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// Minimal listing to populate the rider-assignment dropdown (Section 8)
// — full staff/user management (create, suspend, edit) is Section 10.2's
// "Staff and roles" module, scoped to M13, not built here.
export async function listActiveRiders(): Promise<Array<{ id: string; name: string; phone: string }>> {
  const { rows } = await requirePool().query(`SELECT id, name, phone FROM users WHERE role = 'rider' AND status = 'active' ORDER BY name`);
  return rows;
}

export async function createUser(input: {
  username: string;
  passwordHash: string;
  phone: string | null;
  name: string;
  role: UserRole;
  pinHash: string | null;
  createdBy?: string | null;
}): Promise<User> {
  const { rows } = await requirePool().query(
    `INSERT INTO users (username, password_hash, phone, name, role, pin_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${USER_COLUMNS}`,
    [input.username, input.passwordHash, input.phone, input.name, input.role, input.pinHash, input.createdBy ?? null]
  );
  return mapRow(rows[0]);
}

export class UserError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Section 10.2 "Staff and roles". Listing is deliberately not paginated —
// a single pharmacy's staff roster is a handful of accounts, same
// reasoning as every other small-cardinality master list in this build
// (vendors, prescribers, bins).
export async function listUsers(): Promise<User[]> {
  const { rows } = await requirePool().query(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY (status = 'active') DESC, name`
  );
  return rows.map(mapRow);
}

export async function updateUser(id: string, input: { name?: string; phone?: string; username?: string }): Promise<User> {
  const existing = await findUserById(id);
  if (!existing) throw new UserError("not_found");
  const { rows } = await requirePool().query(
    `UPDATE users SET name = COALESCE($2, name), phone = COALESCE($3, phone), username = COALESCE($4, username) WHERE id = $1
     RETURNING ${USER_COLUMNS}`,
    [id, input.name ?? null, input.phone ?? null, input.username ?? null]
  );
  return mapRow(rows[0]);
}

// Section 10.2 "Create, edit, suspend, and delete user accounts." A real
// hard DELETE would orphan every FK this user shows up on as an actor —
// order created_by, sale served_by, write-off approved_by, the audit
// trail this entire build is built around. "Delete" is implemented as
// suspend (status='suspended'), same as the app's own account-suspension
// path — the account simply can no longer log in. Documented as a
// judgment call in DECISIONS.md, not a silent scope-narrowing.
export async function setUserStatus(id: string, status: "active" | "suspended"): Promise<User> {
  const { rows } = await requirePool().query(
    `UPDATE users SET status = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id, status]
  );
  if (!rows[0]) throw new UserError("not_found");
  return mapRow(rows[0]);
}

export async function setUserRole(id: string, role: UserRole): Promise<User> {
  const { rows } = await requirePool().query(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id, role]
  );
  if (!rows[0]) throw new UserError("not_found");
  return mapRow(rows[0]);
}

export async function setUserPassword(id: string, passwordHash: string): Promise<void> {
  const { rowCount } = await requirePool().query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
  if (!rowCount) throw new UserError("not_found");
}

export async function setUserPin(id: string, pinHash: string): Promise<void> {
  const { rowCount } = await requirePool().query(`UPDATE users SET pin_hash = $2 WHERE id = $1`, [id, pinHash]);
  if (!rowCount) throw new UserError("not_found");
}

// Section 10.2 "Per-user permission overrides above the base role."
// permission_key reuses the same role-name strings requireRole(...)
// already checks everywhere — see plugins/auth.ts for how this is
// enforced, and the M13.1 migration comment for why.
export async function listPermissionOverrides(userId: string): Promise<Array<{ permissionKey: UserRole; grantedBy: string; grantedAt: string; note: string | null }>> {
  const { rows } = await requirePool().query(
    `SELECT permission_key, granted_by, granted_at, note FROM permission_overrides WHERE user_id = $1 ORDER BY granted_at`,
    [userId]
  );
  return rows.map((r: any) => ({ permissionKey: r.permission_key, grantedBy: r.granted_by, grantedAt: r.granted_at, note: r.note }));
}

export async function grantPermissionOverride(userId: string, permissionKey: UserRole, grantedBy: string, note: string | null): Promise<void> {
  await requirePool().query(
    `INSERT INTO permission_overrides (user_id, permission_key, granted_by, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, permission_key) DO UPDATE SET granted_by = $3, granted_at = now(), note = $4`,
    [userId, permissionKey, grantedBy, note]
  );
}

export async function revokePermissionOverride(userId: string, permissionKey: UserRole): Promise<void> {
  await requirePool().query(`DELETE FROM permission_overrides WHERE user_id = $1 AND permission_key = $2`, [userId, permissionKey]);
}

// Every permission_key any user has an active override for — read once
// per request by requireRole(...) (plugins/auth.ts) rather than a query
// per role name checked.
export async function getUserOverrideKeys(userId: string): Promise<UserRole[]> {
  const { rows } = await requirePool().query(`SELECT permission_key FROM permission_overrides WHERE user_id = $1`, [userId]);
  return rows.map((r: any) => r.permission_key);
}

export async function upsertRiderDetails(userId: string, input: { vehicleType?: string | null; vehicleNumber?: string | null; licenseNumber?: string | null; notes?: string | null }): Promise<void> {
  await requirePool().query(
    `INSERT INTO rider_details (user_id, vehicle_type, vehicle_number, license_number, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       vehicle_type = COALESCE($2, rider_details.vehicle_type),
       vehicle_number = COALESCE($3, rider_details.vehicle_number),
       license_number = COALESCE($4, rider_details.license_number),
       notes = COALESCE($5, rider_details.notes),
       updated_at = now()`,
    [userId, input.vehicleType ?? null, input.vehicleNumber ?? null, input.licenseNumber ?? null, input.notes ?? null]
  );
}

export async function getRiderDetails(userId: string): Promise<{ vehicleType: string | null; vehicleNumber: string | null; licenseNumber: string | null; notes: string | null } | null> {
  const { rows } = await requirePool().query(
    `SELECT vehicle_type, vehicle_number, license_number, notes FROM rider_details WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  return { vehicleType: rows[0].vehicle_type, vehicleNumber: rows[0].vehicle_number, licenseNumber: rows[0].license_number, notes: rows[0].notes };
}

export async function addRiderDocument(userId: string, docType: string, filePath: string, uploadedBy: string): Promise<void> {
  await requirePool().query(
    `INSERT INTO rider_documents (user_id, doc_type, file_path, uploaded_by) VALUES ($1, $2, $3, $4)`,
    [userId, docType, filePath, uploadedBy]
  );
}

export async function listRidersFull(): Promise<Array<User & { vehicleType: string | null; vehicleNumber: string | null; licenseNumber: string | null; documentCount: number }>> {
  const { rows } = await requirePool().query(`
    SELECT u.id, u.username, u.phone, u.name, u.role, u.pin_hash, u.password_hash, u.status,
      rd.vehicle_type, rd.vehicle_number, rd.license_number,
      (SELECT count(*) FROM rider_documents d WHERE d.user_id = u.id) AS document_count
    FROM users u
    LEFT JOIN rider_details rd ON rd.user_id = u.id
    WHERE u.role = 'rider'
    ORDER BY (u.status = 'active') DESC, u.name
  `);
  return rows.map((r: any) => ({
    ...mapRow(r),
    vehicleType: r.vehicle_type,
    vehicleNumber: r.vehicle_number,
    licenseNumber: r.license_number,
    documentCount: Number(r.document_count),
  }));
}

export async function listRiderDocuments(userId: string): Promise<Array<{ id: string; docType: string; filePath: string; createdAt: string }>> {
  const { rows } = await requirePool().query(
    `SELECT id, doc_type, file_path, created_at FROM rider_documents WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r: any) => ({ id: r.id, docType: r.doc_type, filePath: r.file_path, createdAt: r.created_at }));
}
