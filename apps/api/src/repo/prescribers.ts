import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface CreatePrescriberInput {
  name: string;
  registrationNumber: string | null;
  speciality: string | null;
  clinicOrHospital: string | null;
  phone: string | null;
  address: string | null;
}

export async function createPrescriber(input: CreatePrescriberInput) {
  const { rows } = await requirePool().query(
    `INSERT INTO prescribers (name, registration_number, speciality, clinic_or_hospital, phone, address)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.name, input.registrationNumber, input.speciality, input.clinicOrHospital, input.phone, input.address]
  );
  return { id: rows[0].id };
}

// Section 9A.1: "autocomplete from history so it costs the biller one or
// two keystrokes" — trigram search, same pattern as product/salt search.
export async function searchPrescribers(query: string, limit = 10) {
  const { rows } = await requirePool().query(
    `SELECT id, name, registration_number, speciality, clinic_or_hospital, phone
     FROM prescribers
     WHERE name % $1 OR name ILIKE $2
     ORDER BY similarity(name, $1) DESC
     LIMIT $3`,
    [query, `%${query}%`, limit]
  );
  return rows;
}

export async function listPrescribers() {
  const { rows } = await requirePool().query(`SELECT * FROM prescribers ORDER BY name`);
  return rows;
}

// Section 9A.1 reports — "commercial intelligence, not just compliance."
// Privacy: caller (route layer) restricts to Owner/Store Manager; no
// patient-identifying column is ever selected here.
export async function salesByPrescriber(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT pr.id AS prescriber_id, pr.name AS prescriber_name, pr.clinic_or_hospital,
      COUNT(DISTINCT s.id)::int AS bill_count,
      SUM(sl.taxable_value)::numeric(14,2) AS total_taxable_value
    FROM sale_prescriber_details spd
    JOIN prescribers pr ON pr.id = spd.prescriber_id
    JOIN sales s ON s.id = spd.sale_id
    JOIN sale_lines sl ON sl.sale_id = s.id
    WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
    GROUP BY pr.id, pr.name, pr.clinic_or_hospital
    ORDER BY total_taxable_value DESC
    `,
    [fromDate, toDate]
  );
  return rows;
}

export async function moleculesByPrescriber(prescriberId: string, fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT sa.name AS salt_name, SUM(sl.quantity_base_units)::int AS total_quantity, COUNT(DISTINCT s.id)::int AS bill_count
    FROM sale_prescriber_details spd
    JOIN sales s ON s.id = spd.sale_id
    JOIN sale_lines sl ON sl.sale_id = s.id
    JOIN product_compositions pc ON pc.product_id = sl.product_id
    JOIN salts sa ON sa.id = pc.salt_id
    WHERE spd.prescriber_id = $1 AND s.status = 'completed' AND s.business_date BETWEEN $2 AND $3
    GROUP BY sa.name
    ORDER BY total_quantity DESC
    `,
    [prescriberId, fromDate, toDate]
  );
  return rows;
}

// "New prescribers appearing this month" — first sale ever attributed to
// them falls inside the given window.
export async function newPrescribersInRange(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    WITH first_sale AS (
      SELECT spd.prescriber_id, MIN(s.business_date) AS first_date
      FROM sale_prescriber_details spd JOIN sales s ON s.id = spd.sale_id
      WHERE spd.prescriber_id IS NOT NULL AND s.status = 'completed'
      GROUP BY spd.prescriber_id
    )
    SELECT pr.id AS prescriber_id, pr.name, pr.clinic_or_hospital, fs.first_date
    FROM first_sale fs JOIN prescribers pr ON pr.id = fs.prescriber_id
    WHERE fs.first_date BETWEEN $1 AND $2
    ORDER BY fs.first_date
    `,
    [fromDate, toDate]
  );
  return rows;
}

// "Prescribers whose volume has dropped" — trailing window vs the equal
// window immediately before it. Window length is the caller's date
// range span, applied twice back-to-back, so "last 30 days" and "the 30
// before that" both come from one `to` date the caller picks (usually
// today).
export async function prescribersWithDroppedVolume(windowDays: number) {
  const { rows } = await requirePool().query(
    `
    WITH recent AS (
      SELECT spd.prescriber_id, COUNT(DISTINCT s.id)::int AS bill_count
      FROM sale_prescriber_details spd JOIN sales s ON s.id = spd.sale_id
      WHERE spd.prescriber_id IS NOT NULL AND s.status = 'completed'
        AND s.business_date > CURRENT_DATE - ($1 || ' days')::interval
      GROUP BY spd.prescriber_id
    ),
    prior AS (
      SELECT spd.prescriber_id, COUNT(DISTINCT s.id)::int AS bill_count
      FROM sale_prescriber_details spd JOIN sales s ON s.id = spd.sale_id
      WHERE spd.prescriber_id IS NOT NULL AND s.status = 'completed'
        AND s.business_date <= CURRENT_DATE - ($1 || ' days')::interval
        AND s.business_date > CURRENT_DATE - ($1 * 2 || ' days')::interval
      GROUP BY spd.prescriber_id
    )
    SELECT pr.id AS prescriber_id, pr.name, pr.clinic_or_hospital,
      COALESCE(p.bill_count, 0) AS prior_bill_count, COALESCE(r.bill_count, 0) AS recent_bill_count
    FROM prior p
    JOIN prescribers pr ON pr.id = p.prescriber_id
    LEFT JOIN recent r ON r.prescriber_id = p.prescriber_id
    WHERE COALESCE(r.bill_count, 0) < p.bill_count
    ORDER BY (p.bill_count - COALESCE(r.bill_count, 0)) DESC
    `,
    [windowDays]
  );
  return rows;
}
