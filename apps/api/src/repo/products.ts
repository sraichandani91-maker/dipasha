import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface ProductListItem {
  id: string;
  name: string;
  manufacturer: string;
  form: string;
  scheduleCategory: string;
  requiresPrescription: boolean;
  hsnCode: string;
  gstRate: number;
  baseUnit: string;
  packSize: number;
  allowLooseSale: boolean;
  isColdChain: boolean;
  barcode: string | null;
  substituteGroupId: string | null;
  stockBaseUnits: number;
  batches: Array<{
    batchNo: string;
    expiryDate: string;
    mrp: number;
    quantityBaseUnits: number;
    costUnknown: boolean;
    // effectiveCostPerBaseUnit deliberately omitted from this type —
    // it's spliced in only for the owner role at the route layer, per
    // the "absent, not blanked" rule (Section 6A.9 / 10B.4).
  }>;
}

export async function listProducts(limit: number, offset: number): Promise<ProductListItem[]> {
  const db = requirePool();

  const { rows: productRows } = await db.query(
    `
    SELECT
      p.id, p.name, p.manufacturer, p.form, p.schedule_category, p.requires_prescription,
      p.hsn_code, p.gst_rate, p.base_unit, p.pack_size, p.allow_loose_sale, p.is_cold_chain,
      p.barcode, p.substitute_group_id,
      COALESCE(SUM(s.quantity_base_units), 0)::int AS stock_base_units
    FROM products p
    LEFT JOIN stock s ON s.product_id = p.id
    GROUP BY p.id
    ORDER BY p.name
    LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  if (productRows.length === 0) return [];
  const productIds = productRows.map((r) => r.id);

  const { rows: batchRows } = await db.query(
    `
    SELECT
      b.product_id, b.batch_no, b.expiry_date, b.mrp, b.cost_unknown,
      b.effective_cost_per_base_unit,
      COALESCE(SUM(s.quantity_base_units), 0)::int AS quantity_base_units
    FROM batches b
    LEFT JOIN stock s ON s.batch_id = b.id
    WHERE b.product_id = ANY($1::uuid[])
    GROUP BY b.id
    HAVING COALESCE(SUM(s.quantity_base_units), 0) <> 0
    ORDER BY b.expiry_date ASC
    `,
    [productIds]
  );

  const batchesByProduct = new Map<string, typeof batchRows>();
  for (const row of batchRows) {
    const list = batchesByProduct.get(row.product_id) ?? [];
    list.push(row);
    batchesByProduct.set(row.product_id, list);
  }

  return productRows.map((p) => ({
    id: p.id,
    name: p.name,
    manufacturer: p.manufacturer,
    form: p.form,
    scheduleCategory: p.schedule_category,
    requiresPrescription: p.requires_prescription,
    hsnCode: p.hsn_code,
    gstRate: Number(p.gst_rate),
    baseUnit: p.base_unit,
    packSize: p.pack_size,
    allowLooseSale: p.allow_loose_sale,
    isColdChain: p.is_cold_chain,
    barcode: p.barcode,
    substituteGroupId: p.substitute_group_id,
    stockBaseUnits: p.stock_base_units,
    batches: (batchesByProduct.get(p.id) ?? []).map((b) => ({
      batchNo: b.batch_no,
      expiryDate: b.expiry_date,
      mrp: Number(b.mrp),
      quantityBaseUnits: b.quantity_base_units,
      costUnknown: b.cost_unknown,
      // stashed here under a private-ish key; the route decides whether
      // to surface it, based on role, before the response is ever
      // serialized.
      __effectiveCostPerBaseUnit: b.effective_cost_per_base_unit === null ? null : Number(b.effective_cost_per_base_unit),
    })) as any,
  }));
}
