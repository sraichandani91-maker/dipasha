import { pool } from "../db.js";
import { lowStockSuggestions } from "../domain/reorder.js";
import { reserveNumber } from "../domain/bill-numbering.js";
import { getSetting } from "./settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface SuggestedLine {
  productId: string;
  productName: string;
  suggestedQty: number;
  sourceReasons: string[];
  requesterCount: number;
  requestIds: string[];
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  lastRate: number | null;
}

// Section 6B.3: merges low stock + open customer requests into one
// suggested-lines screen. "Only auto-add a requested item if current
// sellable stock is below the requested quantity" — if stock arrived in
// the meantime, the request drops off the suggestion (the caller should
// flag it for callback instead — that's the M5 callback-loop path, not
// this one).
export async function suggestedPurchaseOrderLines(): Promise<SuggestedLine[]> {
  const db = requirePool();
  const lowStock = await lowStockSuggestions();

  const { rows: openRequests } = await db.query(
    `SELECT cr.id, cr.product_id, cr.quantity_requested_units
     FROM customer_requests cr
     WHERE cr.status = 'open' AND cr.product_id IS NOT NULL`
  );
  const { rows: stockByProduct } = await db.query(`SELECT product_id, SUM(quantity_base_units)::int AS qty FROM sellable_stock GROUP BY product_id`);
  const stockMap = new Map(stockByProduct.map((r) => [r.product_id, r.qty]));

  const requestsByProduct = new Map<string, { totalQty: number; ids: string[] }>();
  for (const r of openRequests) {
    const entry = requestsByProduct.get(r.product_id) ?? { totalQty: 0, ids: [] };
    entry.totalQty += r.quantity_requested_units ?? 1;
    entry.ids.push(r.id);
    requestsByProduct.set(r.product_id, entry);
  }

  const merged = new Map<string, SuggestedLine>();
  for (const s of lowStock) {
    merged.set(s.productId, {
      productId: s.productId, productName: s.productName, suggestedQty: s.suggestedQty,
      sourceReasons: ["low_stock"], requesterCount: 0, requestIds: [],
      suggestedVendorId: null, suggestedVendorName: null, lastRate: null,
    });
  }
  for (const [productId, entry] of requestsByProduct) {
    const currentStock = stockMap.get(productId) ?? 0;
    if (currentStock >= entry.totalQty) continue; // stock arrived in the meantime — drop it, don't auto-add
    const { rows: productRows } = await db.query(`SELECT name FROM products WHERE id = $1`, [productId]);
    const existing = merged.get(productId);
    if (existing) {
      existing.suggestedQty = Math.max(existing.suggestedQty, entry.totalQty - currentStock);
      existing.sourceReasons.push("customer_request");
      existing.requesterCount = entry.ids.length;
      existing.requestIds = entry.ids;
    } else {
      merged.set(productId, {
        productId, productName: productRows[0]?.name ?? "?", suggestedQty: entry.totalQty - currentStock,
        sourceReasons: ["customer_request"], requesterCount: entry.ids.length, requestIds: entry.ids,
        suggestedVendorId: null, suggestedVendorName: null, lastRate: null,
      });
    }
  }

  // Vendor suggestion: last vendor this product was actually purchased from.
  for (const line of merged.values()) {
    const { rows } = await db.query(
      `SELECT v.id, v.name, pil.rate_before_discount
       FROM purchase_invoice_lines pil
       JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
       JOIN vendors v ON v.id = pi.vendor_id
       WHERE pil.product_id = $1
       ORDER BY pi.invoice_date DESC LIMIT 1`,
      [line.productId]
    );
    if (rows[0]) {
      line.suggestedVendorId = rows[0].id;
      line.suggestedVendorName = rows[0].name;
      line.lastRate = Number(rows[0].rate_before_discount);
    }
  }

  return [...merged.values()];
}

export interface CreatePoInput {
  vendorId: string;
  lines: Array<{ productId: string; quantityBaseUnits: number; sourceReasons: string[]; requestIds: string[] }>;
  createdBy: string;
  deviceId: string;
}

export async function createPurchaseOrder(input: CreatePoInput) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const prefix = await getSetting("po_number_prefix", "PO");
    const poNumber = await reserveNumber(client, prefix);

    const { rows: poRows } = await client.query(
      `INSERT INTO purchase_orders (po_number, vendor_id, created_by, device_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [poNumber, input.vendorId, input.createdBy, input.deviceId]
    );
    const poId = poRows[0].id;

    for (const line of input.lines) {
      const { rows: lineRows } = await client.query(
        `INSERT INTO purchase_order_lines (purchase_order_id, product_id, quantity_base_units, source_reasons)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [poId, line.productId, line.quantityBaseUnits, line.sourceReasons]
      );
      const lineId = lineRows[0].id;

      for (const requestId of line.requestIds) {
        await client.query(`INSERT INTO purchase_order_line_requests (purchase_order_line_id, customer_request_id) VALUES ($1,$2)`, [lineId, requestId]);
        // Section 6B.3: "linked requests move to on_po with the PO number attached."
        await client.query(`UPDATE customer_requests SET status = 'on_po', purchase_order_id = $1, updated_at = now() WHERE id = $2`, [poId, requestId]);
      }
    }

    await client.query("COMMIT");
    return { id: poId, poNumber };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getPurchaseOrder(id: string) {
  const db = requirePool();
  const { rows: poRows } = await db.query(
    `SELECT po.*, v.name AS vendor_name FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.id = $1`,
    [id]
  );
  if (!poRows[0]) return null;
  const { rows: lineRows } = await db.query(
    `SELECT pol.*, p.name AS product_name FROM purchase_order_lines pol JOIN products p ON p.id = pol.product_id WHERE pol.purchase_order_id = $1`,
    [id]
  );
  return { ...poRows[0], lines: lineRows };
}
