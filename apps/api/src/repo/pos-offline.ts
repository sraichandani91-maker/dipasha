import { pool } from "../db.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface OfflineSnapshotBatch {
  batchId: string;
  binId: string;
  binCode: string;
  batchNo: string;
  expiryDate: string;
  mrp: number;
  quantityBaseUnits: number;
}

export interface OfflineSnapshotProduct {
  id: string;
  name: string;
  manufacturer: string;
  packSize: number;
  baseUnit: string;
  gstRate: number;
  scheduleCategory: string;
  requiresPrescription: boolean;
  barcode: string | null;
  batches: OfflineSnapshotBatch[];
}

// Section 6A.9: "POS must bill fully offline against the local cache."
// This is that cache's server side — every currently sellable batch,
// straight from the same `sellable_stock` view allocateFefo() itself
// reads (blocked/near-expiry-blocked batches already excluded there),
// so an offline sale's own FEFO pick is built from the same data shape
// a live one would see, just captured at refresh time rather than live.
export async function getPosOfflineSnapshot(): Promise<OfflineSnapshotProduct[]> {
  const { rows } = await requirePool().query(`
    SELECT
      p.id AS product_id, p.name, p.manufacturer, p.pack_size, p.base_unit, p.gst_rate,
      p.schedule_category, p.requires_prescription, p.barcode,
      s.batch_id, s.bin_id, bn.code AS bin_code, b.batch_no, b.expiry_date, b.mrp, s.quantity_base_units
    FROM products p
    JOIN sellable_stock s ON s.product_id = p.id
    JOIN batches b ON b.id = s.batch_id
    JOIN bins bn ON bn.id = s.bin_id
    WHERE p.status = 'active' AND s.quantity_base_units > 0
    ORDER BY p.name, b.expiry_date ASC
  `);

  const byProduct = new Map<string, OfflineSnapshotProduct>();
  for (const r of rows) {
    let product = byProduct.get(r.product_id);
    if (!product) {
      product = {
        id: r.product_id, name: r.name, manufacturer: r.manufacturer, packSize: r.pack_size, baseUnit: r.base_unit,
        gstRate: Number(r.gst_rate), scheduleCategory: r.schedule_category, requiresPrescription: r.requires_prescription,
        barcode: r.barcode, batches: [],
      };
      byProduct.set(r.product_id, product);
    }
    product.batches.push({
      batchId: r.batch_id, binId: r.bin_id, binCode: r.bin_code, batchNo: r.batch_no,
      expiryDate: r.expiry_date, mrp: Number(r.mrp), quantityBaseUnits: r.quantity_base_units,
    });
  }
  return [...byProduct.values()];
}
