import { pool } from "../db.js";
import { shortbookItems, type ShortbookItem, type ClearanceCandidate } from "../domain/reorder.js";
import { createPurchaseOrder } from "./purchase-orders.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

interface VendorHint {
  vendorId: string;
  vendorName: string;
  rate: number;
  marginPercent: number;
  moq: number | null;
}

// Owner buys the same medicine from more than one wholesaler and wants
// the reorder suggestion to point at whichever one currently gives the
// best margin, not just whoever was ordered from most recently. Priced
// off each vendor's most recent `batches.effective_cost_per_base_unit`
// for that product — the same landed-cost figure (discounts, schemes,
// apportioned charges all folded in, not just the quoted rate) every
// other margin computation in this build already reads
// (`domain/landed-cost.ts`, `repo/margin-reports.ts`) — against that same
// batch's MRP, so the ranking reflects real margin, not list price.
// "Distributor sells by the box" MOQ rounding is unchanged from before.
async function priorityMarginVendorsForProducts(productIds: string[]): Promise<Map<string, VendorHint>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await requirePool().query(
    `SELECT DISTINCT ON (pil.product_id, pi.vendor_id)
       pil.product_id, v.id AS vendor_id, v.name AS vendor_name, v.default_min_order_pack_units,
       b.effective_cost_per_base_unit, b.mrp, pi.invoice_date
     FROM purchase_invoice_lines pil
     JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
     JOIN vendors v ON v.id = pi.vendor_id
     JOIN batches b ON b.id = pil.batch_id
     WHERE pil.product_id = ANY($1) AND b.effective_cost_per_base_unit IS NOT NULL AND b.mrp > 0
     ORDER BY pil.product_id, pi.vendor_id, pi.invoice_date DESC`,
    [productIds]
  );

  const byProduct = new Map<string, VendorHint[]>();
  for (const r of rows) {
    const cost = Number(r.effective_cost_per_base_unit);
    const mrp = Number(r.mrp);
    const hint: VendorHint = {
      vendorId: r.vendor_id, vendorName: r.vendor_name,
      rate: cost, marginPercent: ((mrp - cost) / mrp) * 100,
      moq: r.default_min_order_pack_units,
    };
    const list = byProduct.get(r.product_id) ?? [];
    list.push(hint);
    byProduct.set(r.product_id, list);
  }

  const map = new Map<string, VendorHint>();
  for (const [productId, hints] of byProduct) {
    const best = hints.reduce((a, b) => (b.marginPercent > a.marginPercent ? b : a));
    map.set(productId, best);
  }
  return map;
}

export interface ShortbookItemWithVendor extends ShortbookItem {
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  lastRate: number | null;
  marginPercent: number | null;
}

export async function getShortbookItems(): Promise<{ items: ShortbookItemWithVendor[]; clearanceCandidates: ClearanceCandidate[] }> {
  const { items, clearanceCandidates } = await shortbookItems();
  const vendorMap = await priorityMarginVendorsForProducts(items.map((i) => i.productId));
  return {
    items: items.map((i) => {
      const v = vendorMap.get(i.productId);
      return {
        ...i,
        suggestedVendorId: v?.vendorId ?? null,
        suggestedVendorName: v?.vendorName ?? null,
        lastRate: v?.rate ?? null,
        marginPercent: v?.marginPercent ?? null,
      };
    }),
    clearanceCandidates,
  };
}

export interface ShortbookDashboard {
  shortbookItems: number;
  distributors: number;
  itemsInCart: number;
  orderedItems: number;
  orderAnalysisShort: number;
}

/**
 * The five stat tiles from the "Orderbook Dashboard" the owner pointed
 * to: shortage count, how many distributors those shortages need to be
 * ordered from, what's staged in the cart, what's still out on active
 * POs, and how many of those active-PO lines are running short of what
 * was ordered ("Order Analysis").
 */
export async function getShortbookDashboard(): Promise<ShortbookDashboard> {
  const db = requirePool();
  const { items } = await shortbookItems();
  const vendorMap = await priorityMarginVendorsForProducts(items.map((i) => i.productId));
  const distributorIds = new Set([...vendorMap.values()].map((v) => v.vendorId));

  const [cartCount, orderedCount, shortCount] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM shortbook_cart_items`),
    db.query(
      `SELECT COUNT(DISTINCT pol.product_id)::int AS n
       FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
       WHERE po.status NOT IN ('received', 'cancelled')`
    ),
    db.query(
      `SELECT COUNT(*)::int AS n
       FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
       WHERE po.status IN ('sent', 'acknowledged', 'partially_received')
         AND pol.quantity_received_base_units < pol.quantity_base_units`
    ),
  ]);

  return {
    shortbookItems: items.length,
    distributors: distributorIds.size,
    itemsInCart: cartCount.rows[0].n,
    orderedItems: orderedCount.rows[0].n,
    orderAnalysisShort: shortCount.rows[0].n,
  };
}

export interface CartRow {
  productId: string;
  productName: string;
  quantityBaseUnits: number;
  vendorId: string | null;
  vendorName: string | null;
  addedAt: string;
}

export async function listCart(): Promise<CartRow[]> {
  const { rows } = await requirePool().query(
    `SELECT c.product_id, p.name AS product_name, c.quantity_base_units, c.vendor_id, v.name AS vendor_name, c.added_at
     FROM shortbook_cart_items c
     JOIN products p ON p.id = c.product_id
     LEFT JOIN vendors v ON v.id = c.vendor_id
     ORDER BY c.added_at`
  );
  return rows.map((r) => ({
    productId: r.product_id, productName: r.product_name, quantityBaseUnits: r.quantity_base_units,
    vendorId: r.vendor_id, vendorName: r.vendor_name, addedAt: r.added_at,
  }));
}

export async function upsertCartItem(input: { productId: string; quantityBaseUnits: number; vendorId: string | null; actorUserId: string }): Promise<void> {
  await requirePool().query(
    `INSERT INTO shortbook_cart_items (product_id, quantity_base_units, vendor_id, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id) DO UPDATE SET quantity_base_units = EXCLUDED.quantity_base_units, vendor_id = EXCLUDED.vendor_id, updated_at = now()`,
    [input.productId, input.quantityBaseUnits, input.vendorId, input.actorUserId]
  );
}

export async function removeCartItem(productId: string): Promise<void> {
  await requirePool().query(`DELETE FROM shortbook_cart_items WHERE product_id = $1`, [productId]);
}

export interface CheckoutResult {
  created: Array<{ vendorId: string; vendorName: string; poNumber: string }>;
  unassignedProductIds: string[];
}

// "Create the order book" — turn whatever's staged in the cart into
// actual purchase orders. A PO ships to one vendor (createPurchaseOrder's
// own constraint, unchanged from the old Create-PO flow), so cart lines
// are grouped by their assigned vendor and one PO is raised per group;
// anything left without a vendor is reported back rather than silently
// dropped, so the owner can assign one and check out again.
export async function checkoutCart(actorUserId: string, deviceId: string): Promise<CheckoutResult> {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT c.product_id, c.quantity_base_units, c.vendor_id, v.name AS vendor_name
     FROM shortbook_cart_items c LEFT JOIN vendors v ON v.id = c.vendor_id`
  );

  type VendorGroup = { vendorName: string; lines: Array<{ productId: string; quantityBaseUnits: number }> };
  const byVendor = new Map<string, VendorGroup>();
  const unassignedProductIds: string[] = [];
  for (const r of rows) {
    if (!r.vendor_id) {
      unassignedProductIds.push(r.product_id);
      continue;
    }
    const entry: VendorGroup = byVendor.get(r.vendor_id) ?? { vendorName: r.vendor_name, lines: [] };
    entry.lines.push({ productId: r.product_id, quantityBaseUnits: r.quantity_base_units });
    byVendor.set(r.vendor_id, entry);
  }

  const created: CheckoutResult["created"] = [];
  for (const [vendorId, entry] of byVendor) {
    const result = await createPurchaseOrder({
      vendorId,
      lines: entry.lines.map((l) => ({ ...l, sourceReasons: ["shortbook"], requestIds: [] })),
      createdBy: actorUserId,
      deviceId,
    });
    created.push({ vendorId, vendorName: entry.vendorName, poNumber: result.poNumber });
    await db.query(
      `DELETE FROM shortbook_cart_items WHERE product_id = ANY($1)`,
      [entry.lines.map((l) => l.productId)]
    );
  }

  return { created, unassignedProductIds };
}
