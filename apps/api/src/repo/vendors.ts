import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface Vendor {
  id: string;
  name: string;
  gstin: string | null;
  gstStateCode: string | null;
  paymentTermsDays: number;
  status: "active" | "inactive";
}

function mapRow(r: any): Vendor {
  return {
    id: r.id,
    name: r.name,
    gstin: r.gstin,
    gstStateCode: r.gst_state_code,
    paymentTermsDays: r.payment_terms_days,
    status: r.status,
  };
}

export async function listVendors(): Promise<Vendor[]> {
  const { rows } = await requirePool().query(`SELECT * FROM vendors WHERE status = 'active' ORDER BY name`);
  return rows.map(mapRow);
}

export async function getVendor(id: string): Promise<Vendor | null> {
  const { rows } = await requirePool().query(`SELECT * FROM vendors WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createVendor(input: {
  name: string;
  gstin: string | null;
  paymentTermsDays: number;
  createdBy: string;
}): Promise<Vendor> {
  // GSTIN's first two characters are the state code — extracted here so
  // downstream CGST/SGST-vs-IGST logic never has to re-parse it (Section
  // 6.4: "Never ask the user which one applies").
  const gstStateCode = input.gstin ? input.gstin.slice(0, 2) : null;
  const { rows } = await requirePool().query(
    `INSERT INTO vendors (name, gstin, gst_state_code, payment_terms_days, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.gstin, gstStateCode, input.paymentTermsDays, input.createdBy]
  );
  return mapRow(rows[0]);
}
