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

export interface CreateProductInput {
  name: string;
  manufacturer: string;
  form: string;
  scheduleCategory: string;
  requiresPrescription: boolean;
  hsnCode: string;
  gstRate: number;
  baseUnit: string;
  packSize: number;
  outerPackSize: number | null;
  allowLooseSale: boolean;
  looseSaleMarkupPercent: number;
  isColdChain: boolean;
  barcode: string | null;
  compositions: Array<{ saltId: string; strength: string }>;
  substituteGroupId: string;
  status: "active" | "pending";
  createdBy: string;
}

// Section 9's write-off form (and anything else needing "which batch, in
// which bin, right now") — same underlying `stock` view as everywhere
// else, just per-bin instead of summed across the whole product.
export async function getStockLocations(productId: string) {
  const { rows } = await requirePool().query(
    `SELECT ba.id AS batch_id, ba.batch_no, ba.expiry_date, ba.blocked, ba.mrp, p.pack_size, p.base_unit,
       b.id AS bin_id, b.code AS bin_code, s.quantity_base_units
     FROM stock s JOIN batches ba ON ba.id = s.batch_id JOIN bins b ON b.id = s.bin_id JOIN products p ON p.id = s.product_id
     WHERE s.product_id = $1 AND s.quantity_base_units > 0
     ORDER BY ba.expiry_date`,
    [productId]
  );
  return rows;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  manufacturer: string;
  status: string;
}

// Section 6B.2: "warn if an existing SKU shares the same composition and
// strength" — matched by the same substitute_group_id key (composition +
// strength + form, exact match only, per Section 5B.4).
export async function findProductsBySubstituteGroup(substituteGroupId: string): Promise<DuplicateMatch[]> {
  const { rows } = await requirePool().query(
    `SELECT id, name, manufacturer, status FROM products WHERE substitute_group_id = $1`,
    [substituteGroupId]
  );
  return rows;
}

export async function createProduct(input: CreateProductInput): Promise<{ id: string }> {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO products
         (name, manufacturer, form, schedule_category, requires_prescription, hsn_code, gst_rate,
          base_unit, pack_size, outer_pack_size, allow_loose_sale, loose_sale_markup_percent,
          is_cold_chain, barcode, substitute_group_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        input.name, input.manufacturer, input.form, input.scheduleCategory, input.requiresPrescription,
        input.hsnCode, input.gstRate, input.baseUnit, input.packSize, input.outerPackSize,
        input.allowLooseSale, input.looseSaleMarkupPercent, input.isColdChain, input.barcode,
        input.substituteGroupId, input.status, input.createdBy,
      ]
    );
    const productId = rows[0].id;
    let position = 0;
    for (const c of input.compositions) {
      await client.query(
        `INSERT INTO product_compositions (product_id, salt_id, strength, position) VALUES ($1, $2, $3, $4)`,
        [productId, c.saltId, c.strength, position++]
      );
    }
    await client.query("COMMIT");
    return { id: productId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateProductInput {
  name?: string;
  manufacturer?: string;
  barcode?: string | null;
  allowLooseSale?: boolean;
  loosesSaleMarkupPercent?: number;
  status?: "active" | "pending" | "inactive";
}

export async function updateProduct(id: string, input: UpdateProductInput): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [col, val] of Object.entries({
    name: input.name,
    manufacturer: input.manufacturer,
    barcode: input.barcode,
    allow_loose_sale: input.allowLooseSale,
    loose_sale_markup_percent: input.loosesSaleMarkupPercent,
    status: input.status,
  })) {
    if (val === undefined) continue;
    sets.push(`${col} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0) return false;
  values.push(id);
  const result = await requirePool().query(`UPDATE products SET ${sets.join(", ")} WHERE id = $${i}`, values);
  return (result.rowCount ?? 0) > 0;
}
