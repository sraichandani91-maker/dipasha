import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// Section 6A.3 / 10A.3: "writes automatically to the statutory register
// — no separate manual entry, ever. The register is a view over sales
// data." This query IS that view — there is no separate register table
// to keep in sync.
export async function scheduleHRegister(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT
      s.bill_number, s.created_at, s.customer_name,
      p.name AS drug_name, p.schedule_category, b.batch_no, sl.quantity_base_units,
      spd.prescriber_name, spd.prescriber_registration_number, spd.patient_name, spd.patient_contact,
      u.name AS pharmacist_name
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    JOIN batches b ON b.id = sl.batch_id
    JOIN users u ON u.id = s.created_by
    LEFT JOIN sale_prescriber_details spd ON spd.sale_id = s.id
    WHERE s.status = 'completed'
      AND p.schedule_category IN ('H', 'H1')
      AND s.business_date BETWEEN $1 AND $2
    ORDER BY s.created_at
    `,
    [fromDate, toDate]
  );
  return rows;
}
