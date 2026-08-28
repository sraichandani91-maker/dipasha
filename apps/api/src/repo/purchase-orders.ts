import type { PoolClient, Pool } from "pg";
import { pool } from "../db.js";
import { lowStockSuggestions } from "../domain/reorder.js";
import { reserveNumber } from "../domain/bill-numbering.js";
import { getSetting } from "./settings.js";
import { enqueueAndSendNow } from "../domain/notifications.js";
import type { MinimalLogger } from "../lib/whatsapp-sender.js";

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
  moqRoundedUp: boolean;
}

// Section 6B.3: merges low stock + open customer requests into one
// suggested-lines screen. "Only auto-add a requested item if current
// sellable stock is below the requested quantity" — if stock arrived in
// the meantime, the request drops off the suggestion (the caller should
// flag it for callback instead — that's the M5 callback-loop path, not
// this one). Also returns Section 9A.7's clearance candidates — SKUs
// low-stock math would otherwise suggest reordering, but whose entire
// remaining stock is near expiry (see domain/reorder.ts).
export async function suggestedPurchaseOrderLines() {
  const db = requirePool();
  const { suggestions: lowStock, clearanceCandidates } = await lowStockSuggestions();

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
      suggestedVendorId: null, suggestedVendorName: null, lastRate: null, moqRoundedUp: false,
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
        suggestedVendorId: null, suggestedVendorName: null, lastRate: null, moqRoundedUp: false,
      });
    }
  }

  // Vendor suggestion: last vendor this product was actually purchased
  // from, with the suggested quantity rounded up to that vendor's
  // minimum order pack (Section 9A.7: "distributors sell by the box, not
  // the strip").
  for (const line of merged.values()) {
    const { rows } = await db.query(
      `SELECT v.id, v.name, v.default_min_order_pack_units, pil.rate_before_discount
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
      const moq = rows[0].default_min_order_pack_units;
      if (moq && line.suggestedQty % moq !== 0) {
        line.suggestedQty = Math.ceil(line.suggestedQty / moq) * moq;
        line.moqRoundedUp = true;
      }
    }
  }

  return { lines: [...merged.values()], clearanceCandidates };
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
  // "Ordered versus received versus billed, line by line" (10B.2) —
  // ordered is quantity_base_units, received is the cumulative column a
  // matched invoice increments (below); billed is the same event in this
  // build, since a GST purchase invoice's own creation IS the goods-in
  // step (Section 6.2) — there's no separate pre-invoice receiving stage
  // to distinguish it from. Flagged here, not modelled as three separate
  // numbers that would just always be equal.
  const { rows: lineRows } = await db.query(
    `SELECT pol.*, p.name AS product_name,
       (pol.quantity_base_units - pol.quantity_received_base_units) AS quantity_short
     FROM purchase_order_lines pol JOIN products p ON p.id = pol.product_id WHERE pol.purchase_order_id = $1`,
    [id]
  );
  return { ...poRows[0], lines: lineRows };
}

export async function listPurchaseOrders(filter: { status?: string } = {}) {
  const db = requirePool();
  const where = filter.status ? `WHERE po.status = $1` : "";
  const params = filter.status ? [filter.status] : [];
  const { rows } = await db.query(
    `SELECT po.*, v.name AS vendor_name,
       (SELECT COUNT(*) FROM purchase_order_lines pol WHERE pol.purchase_order_id = po.id) AS line_count
     FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
     ${where} ORDER BY po.created_at DESC`,
    params
  );
  return rows;
}

export class PurchaseOrderError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Section 10B.2: "one-tap send of the PO to the distributor over
// WhatsApp or email, straight from the PO screen." WhatsApp reuses M8's
// one dispatcher, same as every other outbound message in this build.
// Email has no real provider anywhere in this codebase yet — logged the
// same "no real provider configured" way the WhatsApp dev sender already
// is, not a second half-built integration.
export async function markPurchaseOrderSent(id: string, sentVia: "whatsapp" | "email", log: MinimalLogger): Promise<void> {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT po.po_number, v.name AS vendor_name, v.phone, v.email,
       (SELECT COUNT(*) FROM purchase_order_lines pol WHERE pol.purchase_order_id = po.id) AS line_count
     FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.id = $1`,
    [id]
  );
  const po = rows[0];
  if (!po) throw new PurchaseOrderError("not_found");

  if (sentVia === "whatsapp") {
    if (!po.phone) throw new PurchaseOrderError("vendor_has_no_phone");
    await enqueueAndSendNow(
      {
        triggerType: "po_sent",
        category: "transactional",
        templateKey: "whatsapp_template_po_sent",
        triggerEnabledSettingKey: "whatsapp_trigger_po_sent_enabled",
        recipientCustomerId: null,
        recipientPhone: po.phone,
        referenceType: "purchase_order",
        referenceId: id,
        payload: { poNumber: po.po_number, vendorName: po.vendor_name, lineCount: Number(po.line_count) },
      },
      log
    );
  } else {
    if (!po.email) throw new PurchaseOrderError("vendor_has_no_email");
    log.warn({ vendorEmail: po.email, poNumber: po.po_number }, "DEV EMAIL SENDER: no real provider configured — logging instead of sending");
  }

  await db.query(`UPDATE purchase_orders SET status = 'sent', sent_at = now(), sent_via = $1 WHERE id = $2`, [sentVia, id]);
}

export async function markPurchaseOrderAcknowledged(id: string): Promise<void> {
  const { rowCount } = await requirePool().query(
    `UPDATE purchase_orders SET acknowledged_at = now(), status = 'acknowledged' WHERE id = $1 AND status = 'sent'`,
    [id]
  );
  if (rowCount === 0) throw new PurchaseOrderError("not_sent_or_not_found");
}

// Section 10B.2: "chase list for POs unacknowledged beyond a
// configurable window."
export async function getPoChaseList() {
  const chaseWindowDays = await getSetting("po_chase_window_days", 3);
  const { rows } = await requirePool().query(
    `SELECT po.*, v.name AS vendor_name, v.phone
     FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
     WHERE po.status = 'sent' AND po.sent_at < now() - ($1 || ' days')::interval
     ORDER BY po.sent_at ASC`,
    [chaseWindowDays]
  );
  return rows;
}

// Called from repo/purchases.ts's createPurchaseInvoice when the invoice
// is linked to an open PO — "auto-match it to the open PO and show
// ordered versus received versus billed... short supply is flagged, not
// silently absorbed." Runs inside the invoice's own transaction so a
// rolled-back invoice never leaves a PO half-updated.
export async function applyInvoiceLinesToPurchaseOrder(
  client: PoolClient | Pool,
  purchaseOrderId: string,
  lines: Array<{ productId: string; quantityBaseUnits: number }>
): Promise<void> {
  for (const line of lines) {
    await client.query(
      `UPDATE purchase_order_lines SET quantity_received_base_units = quantity_received_base_units + $1
       WHERE purchase_order_id = $2 AND product_id = $3`,
      [line.quantityBaseUnits, purchaseOrderId, line.productId]
    );
  }

  const { rows } = await client.query(
    `SELECT quantity_base_units, quantity_received_base_units FROM purchase_order_lines WHERE purchase_order_id = $1`,
    [purchaseOrderId]
  );
  const fullyReceived = rows.every((r: any) => r.quantity_received_base_units >= r.quantity_base_units);
  const anyReceived = rows.some((r: any) => r.quantity_received_base_units > 0);
  const newStatus = fullyReceived ? "received" : anyReceived ? "partially_received" : null;
  if (newStatus) {
    await client.query(`UPDATE purchase_orders SET status = $1 WHERE id = $2`, [newStatus, purchaseOrderId]);
  }
}
