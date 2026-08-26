import { pool } from "../db.js";
import type { PoolClient } from "pg";
import { getSetting } from "./settings.js";
import type { Queryable } from "../domain/fefo.js";
import { reserveNumber } from "../domain/bill-numbering.js";
import { findOrCreateCustomer } from "./customers.js";
import { createRequest } from "./customer-requests.js";
import { enqueueNotification } from "../domain/notifications.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class OrderError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

export interface CatalogLineInput {
  productId: string;
  quantityRequestedUnits: number;
}

export interface CreateOrderInput {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string | null;
  deliveryPincode: string | null;
  freeTextNote: string | null;
  catalogLines: CatalogLineInput[];
  imagePaths: Array<{ filePath: string; kind: "prescription" | "strip_photo" | "other" }>;
  deliveryCharge: number;
  createdBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function currentMrpByProduct(client: Queryable, productIds: string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT b.product_id, MIN(b.mrp) AS mrp FROM batches b
     JOIN sellable_stock s ON s.batch_id = b.id
     WHERE b.product_id = ANY($1::uuid[])
     GROUP BY b.product_id`,
    [productIds]
  );
  return new Map(rows.map((r: any) => [r.product_id, Number(r.mrp)]));
}

// Section 7 batching: same pincode, rolling window, cap of 3. Cold-chain
// lines never join a batch (single-drop, per Section 7's own carve-out) —
// callers pass isColdChain=false for a catalog-only order with no
// cold-chain lines, or when the pincode is unknown (nothing to batch by).
async function assignDeliveryBatch(client: PoolClient, pincode: string | null, isColdChain: boolean): Promise<string | null> {
  if (!pincode || isColdChain) return null;
  const windowMinutes = await getSetting("delivery_batch_window_minutes", 8);
  const cap = await getSetting("delivery_batch_cap", 3);

  const { rows } = await client.query(
    `SELECT id FROM delivery_batches
     WHERE delivery_pincode = $1 AND status = 'open'
       AND window_started_at > now() - ($2 || ' minutes')::interval
       AND order_count < $3
     ORDER BY window_started_at DESC LIMIT 1 FOR UPDATE`,
    [pincode, windowMinutes, cap]
  );
  if (rows[0]) {
    await client.query(`UPDATE delivery_batches SET order_count = order_count + 1 WHERE id = $1`, [rows[0].id]);
    return rows[0].id;
  }
  const created = await client.query(
    `INSERT INTO delivery_batches (delivery_pincode, order_count) VALUES ($1, 1) RETURNING id`,
    [pincode]
  );
  return created.rows[0].id;
}

// Section 7: "orders arrive from... WhatsApp/phone entered manually by
// the Manager" and Section 7A: "mixed orders are essential — a customer
// must be able to put catalogue items in the cart AND add a photo AND
// type two more lines, all in one order." A pure catalogue order (no
// free text, no images) is already fully specified by real SKUs staff
// picked with the customer on the phone, so it skips straight past
// review/quote into customer_confirmed — Section 7A.2's "cannot skip
// under_review" applies only once there's something unstructured that
// actually needs a human to interpret.
export async function createOrder(input: CreateOrderInput) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const hasUnstructuredContent = !!input.freeTextNote?.trim() || input.imagePaths.length > 0;
    if (!hasUnstructuredContent && input.catalogLines.length === 0) throw new OrderError("empty_order");

    const customer = await findOrCreateCustomer(input.customerName, input.customerPhone);

    const productIds = input.catalogLines.map((l) => l.productId);
    const { rows: productRows } = await client.query(
      `SELECT id, name, requires_prescription, is_cold_chain, schedule_category FROM products WHERE id = ANY($1::uuid[])`,
      [productIds]
    );
    const productById = new Map(productRows.map((p: any) => [p.id, p]));
    for (const line of input.catalogLines) {
      if (!productById.has(line.productId)) throw new OrderError("product_not_found", { productId: line.productId });
    }
    const mrpByProduct = await currentMrpByProduct(client, productIds);

    const rxRequired = input.catalogLines.some((l) => productById.get(l.productId)?.requires_prescription);
    const isColdChain = input.catalogLines.some((l) => productById.get(l.productId)?.is_cold_chain);
    const deliveryBatchId = await assignDeliveryBatch(client, input.deliveryPincode, isColdChain);

    const orderNumberPrefix = await getSetting("order_number_prefix", "ORD");
    const orderNumber = await reserveNumber(client, orderNumberPrefix);

    let quoteTotal: number | null = null;
    let status: string;
    let customerConfirmedAt: string | null = null;
    if (!hasUnstructuredContent) {
      quoteTotal = round2(
        input.catalogLines.reduce((sum, l) => sum + l.quantityRequestedUnits * (mrpByProduct.get(l.productId) ?? 0), 0) + input.deliveryCharge
      );
      status = "customer_confirmed";
      customerConfirmedAt = "now()";
    } else {
      status = "received";
    }

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders
         (order_number, status, has_unstructured_content, customer_id, customer_name, customer_phone,
          delivery_address, delivery_pincode, free_text_note, delivery_charge, quote_total, rx_required,
          delivery_batch_id, created_by, device_id, source
          ${customerConfirmedAt ? ", customer_confirmed_at" : ""})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16 ${customerConfirmedAt ? ", now()" : ""})
       RETURNING id, order_number, status, created_at`,
      [
        orderNumber, status, hasUnstructuredContent, customer.id, customer.name, customer.phone ?? input.customerPhone,
        input.deliveryAddress, input.deliveryPincode, input.freeTextNote, input.deliveryCharge, quoteTotal, rxRequired,
        deliveryBatchId, input.createdBy, input.deviceId, input.source,
      ]
    );
    const order = orderRows[0];

    let lineNo = 0;
    for (const line of input.catalogLines) {
      const product = productById.get(line.productId)!;
      lineNo++;
      await client.query(
        `INSERT INTO order_lines
           (order_id, line_no, source_type, product_id, quantity_requested_units, quantity_confirmed_units,
            unit_price, line_status, requires_prescription)
         VALUES ($1,$2,'catalog',$3,$4,$4,$5,'matched',$6)`,
        [order.id, lineNo, line.productId, line.quantityRequestedUnits, mrpByProduct.get(line.productId) ?? null, product.requires_prescription]
      );
    }

    for (const img of input.imagePaths) {
      await client.query(
        `INSERT INTO order_images (order_id, file_path, kind, uploaded_by) VALUES ($1,$2,$3,$4)`,
        [order.id, img.filePath, img.kind, input.createdBy]
      );
    }

    // Section 12A.2: "Delivery order: confirmed" fires the moment the
    // order is genuinely committed — immediately here for a catalogue
    // order (nothing left to interpret), or later at recordCustomerConfirmed
    // for an unstructured one once the customer accepts the quote.
    if (!hasUnstructuredContent && customer.phone) {
      await enqueueOrderConfirmedNotification(client, order.id, customer.id, customer.phone, customer.name, order.order_number);
    }

    await client.query("COMMIT");
    return { id: order.id, orderNumber: order.order_number, status: order.status };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function enqueueOrderConfirmedNotification(
  client: PoolClient,
  orderId: string,
  customerId: string,
  phone: string,
  customerName: string,
  orderNumber: string
) {
  await enqueueNotification(client, {
    triggerType: "order_confirmed",
    category: "transactional",
    templateKey: "whatsapp_template_order_confirmed",
    triggerEnabledSettingKey: "whatsapp_trigger_order_confirmed_enabled",
    recipientCustomerId: customerId,
    recipientPhone: phone,
    referenceType: "order",
    referenceId: orderId,
    payload: { orderNumber, customerName },
  });
}

export async function getOrder(orderId: string) {
  const db = requirePool();
  const { rows: orderRows } = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  const order = orderRows[0];
  if (!order) return null;

  // First open of a freshly-received order is the "review starts now"
  // moment (Section 7A.2/7A.3) — no separate button needed for it.
  if (order.status === "received") {
    await db.query(`UPDATE orders SET status = 'under_review', updated_at = now() WHERE id = $1`, [orderId]);
    order.status = "under_review";
  }

  const { rows: lines } = await db.query(
    `SELECT ol.*, p.name AS product_name, p.schedule_category, p.pack_size, p.base_unit
     FROM order_lines ol LEFT JOIN products p ON p.id = ol.product_id
     WHERE ol.order_id = $1 ORDER BY ol.line_no`,
    [orderId]
  );
  const { rows: images } = await db.query(
    `SELECT id, file_path, kind, uploaded_by, created_at FROM order_images WHERE order_id = $1 ORDER BY created_at`,
    [orderId]
  );
  const { rows: messages } = await db.query(
    `SELECT om.*, u.name AS staff_name FROM order_messages om LEFT JOIN users u ON u.id = om.created_by
     WHERE order_id = $1 ORDER BY created_at`,
    [orderId]
  );
  const { rows: pickLines } = await db.query(
    `SELECT pl.*, p.name AS product_name, b.code AS bin_code, b.zone AS bin_zone
     FROM order_pick_lines pl JOIN bins b ON b.id = pl.bin_id JOIN products p ON p.id = pl.product_id
     WHERE pl.order_id = $1 ORDER BY pl.walk_sequence`,
    [orderId]
  );

  return { order, lines, images, messages, pickLines };
}

export async function listPendingOrders() {
  const responseTargetMinutes = await getSetting("order_response_target_minutes", 15);
  const { rows } = await requirePool().query(
    `SELECT id, order_number, status, customer_name, customer_phone, has_unstructured_content, rx_required, created_at,
       EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS age_minutes
     FROM orders
     WHERE status IN ('received', 'under_review', 'quoted', 'awaiting_prescription')
     ORDER BY created_at ASC`
  );
  return rows.map((r: any) => ({
    ...r,
    ageMinutes: Math.round(Number(r.age_minutes)),
    ageLevel: Number(r.age_minutes) >= responseTargetMinutes * 2 ? "red" : Number(r.age_minutes) >= responseTargetMinutes ? "amber" : "normal",
  }));
}

export async function listActiveOrders() {
  const { rows } = await requirePool().query(
    `SELECT id, order_number, status, customer_name, customer_phone, delivery_pincode, is_partial, created_at
     FROM orders WHERE status IN ('customer_confirmed', 'picking', 'picked', 'packed', 'partially_available')
     ORDER BY created_at ASC`
  );
  return rows;
}

export async function addOrderLine(orderId: string, input: { sourceType: "free_text" | "image"; descriptionAsEntered: string; createdBy: string }) {
  const db = requirePool();
  const { rows: orderRows } = await db.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
  if (!orderRows[0]) throw new OrderError("order_not_found");
  if (!["under_review", "received"].includes(orderRows[0].status)) throw new OrderError("not_under_review");

  const { rows: countRows } = await db.query(`SELECT COALESCE(MAX(line_no), 0) AS max_no FROM order_lines WHERE order_id = $1`, [orderId]);
  const lineNo = countRows[0].max_no + 1;
  const { rows } = await db.query(
    `INSERT INTO order_lines (order_id, line_no, source_type, description_as_entered) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orderId, lineNo, input.sourceType, input.descriptionAsEntered]
  );
  return { id: rows[0].id };
}

export interface ResolveLineInput {
  action: "match" | "substitute" | "unavailable" | "push_to_request_book";
  productId?: string;
  quantityConfirmedUnits?: number;
  unavailableReason?: string;
  loggedBy: string;
  deviceId: string;
}

// Section 7A.3: "Per line, staff can: match to a SKU, substitute by
// salt, mark unavailable, or push it to the request book so it enters
// the next purchase order automatically."
export async function resolveOrderLine(orderId: string, lineId: string, input: ResolveLineInput) {
  const db = requirePool();
  const { rows: lineRows } = await db.query(`SELECT * FROM order_lines WHERE id = $1 AND order_id = $2`, [lineId, orderId]);
  const line = lineRows[0];
  if (!line) throw new OrderError("line_not_found");

  if (input.action === "match" || input.action === "substitute") {
    if (!input.productId || !input.quantityConfirmedUnits) throw new OrderError("missing_fields");
    const { rows: productRows } = await db.query(`SELECT requires_prescription FROM products WHERE id = $1`, [input.productId]);
    if (!productRows[0]) throw new OrderError("product_not_found");
    const mrpByProduct = await currentMrpByProduct(db, [input.productId]);
    await db.query(
      `UPDATE order_lines SET product_id = $1, quantity_confirmed_units = $2, unit_price = $3, line_status = $4,
         requires_prescription = $5, substituted_from_product_id = $6
       WHERE id = $7`,
      [
        input.productId, input.quantityConfirmedUnits, mrpByProduct.get(input.productId) ?? null,
        input.action === "substitute" ? "substituted" : "matched", productRows[0].requires_prescription,
        input.action === "substitute" ? line.product_id : null, lineId,
      ]
    );
    if (productRows[0].requires_prescription) {
      await db.query(`UPDATE orders SET rx_required = true, updated_at = now() WHERE id = $1`, [orderId]);
    }
  } else if (input.action === "unavailable") {
    await db.query(`UPDATE order_lines SET line_status = 'unavailable', unavailable_reason = $1 WHERE id = $2`, [input.unavailableReason ?? null, lineId]);
  } else if (input.action === "push_to_request_book") {
    const { rows: orderRows } = await db.query(`SELECT customer_name, customer_phone FROM orders WHERE id = $1`, [orderId]);
    const ord = orderRows[0];
    const { id: requestId } = await createRequest({
      customerName: ord.customer_name,
      customerPhone: ord.customer_phone,
      productId: line.product_id,
      freeTextItem: line.product_id ? null : line.description_as_entered,
      quantityRequestedUnits: line.quantity_requested_units,
      quantityRequestedNote: line.quantity_note,
      urgency: "normal",
      hasPrescriptionInHand: false,
      expectedDate: null,
      note: `Pushed from delivery order — line could not be sourced at time of order.`,
      loggedBy: input.loggedBy,
      deviceId: input.deviceId,
      source: "web",
    });
    await db.query(
      `UPDATE order_lines SET line_status = 'pushed_to_request_book', pushed_customer_request_id = $1 WHERE id = $2`,
      [requestId, lineId]
    );
  }
}

export async function addOrderImage(orderId: string, input: { filePath: string; kind: "prescription" | "strip_photo" | "other"; uploadedBy: string }) {
  const { rows } = await requirePool().query(
    `INSERT INTO order_images (order_id, file_path, kind, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orderId, input.filePath, input.kind, input.uploadedBy]
  );
  return { id: rows[0].id };
}

export async function getOrderImageFilePath(imageId: string): Promise<string | null> {
  const { rows } = await requirePool().query(`SELECT file_path FROM order_images WHERE id = $1`, [imageId]);
  return rows[0]?.file_path ?? null;
}

export async function logOrderImageView(orderImageId: string, viewedBy: string) {
  await requirePool().query(`INSERT INTO order_image_views (order_image_id, viewed_by) VALUES ($1,$2)`, [orderImageId, viewedBy]);
}

export async function addOrderMessage(orderId: string, input: { sender: "customer" | "staff"; body: string; createdBy: string | null }) {
  const { rows } = await requirePool().query(
    `INSERT INTO order_messages (order_id, sender, body, created_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [orderId, input.sender, input.body, input.createdBy]
  );
  return rows[0];
}

// Substitute suggestions for a line's product — same substitute_group_id,
// in stock (Section 6A.4's pattern, Section 7A.3's "substitute by salt").
export async function findSubstitutesForProduct(productId: string) {
  const { rows } = await requirePool().query(
    `SELECT p2.id, p2.name, p2.manufacturer, COALESCE(SUM(s.quantity_base_units), 0)::int AS stock_base_units
     FROM products p1
     JOIN products p2 ON p2.substitute_group_id = p1.substitute_group_id AND p2.id <> p1.id AND p2.status = 'active'
     LEFT JOIN sellable_stock s ON s.product_id = p2.id
     WHERE p1.id = $1
     GROUP BY p2.id, p2.name, p2.manufacturer
     HAVING COALESCE(SUM(s.quantity_base_units), 0) > 0
     ORDER BY stock_base_units DESC`,
    [productId]
  );
  return rows;
}

// Section 7A.3: "Quoting back: once resolved, send the customer an
// itemised quote — item, pack, quantity, MRP, availability, total,
// delivery charge, and anything unavailable stated plainly."
export async function sendQuote(orderId: string, input: { deliveryCharge: number; staffUserId: string }) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = orderRows[0];
    if (!order) throw new OrderError("order_not_found");
    if (!["under_review", "received"].includes(order.status)) throw new OrderError("not_under_review");

    const { rows: lines } = await client.query(
      `SELECT ol.*, p.schedule_category FROM order_lines ol LEFT JOIN products p ON p.id = ol.product_id WHERE order_id = $1`,
      [orderId]
    );
    if (lines.some((l: any) => l.line_status === "pending")) throw new OrderError("unresolved_lines");

    const resolvedLines = lines.filter((l: any) => l.line_status === "matched" || l.line_status === "substituted");
    const restrictedLines = resolvedLines.filter((l: any) => ["H", "H1", "X"].includes(l.schedule_category));
    const quoteTotal = round2(resolvedLines.reduce((sum: number, l: any) => sum + (l.quantity_confirmed_units ?? 0) * Number(l.unit_price ?? 0), 0) + input.deliveryCharge);

    await client.query(
      `UPDATE orders SET status = 'quoted', quoted_at = now(), quoted_by = $1, delivery_charge = $2, quote_total = $3, updated_at = now() WHERE id = $4`,
      [input.staffUserId, input.deliveryCharge, quoteTotal, orderId]
    );

    if (order.customer_phone) {
      await enqueueNotification(client, {
        triggerType: "order_quote",
        category: "transactional",
        templateKey: "whatsapp_template_order_quote",
        triggerEnabledSettingKey: "whatsapp_trigger_order_quote_enabled",
        recipientCustomerId: order.customer_id,
        recipientPhone: order.customer_phone,
        referenceType: "order",
        referenceId: orderId,
        payload: {
          orderNumber: order.order_number,
          customerName: order.customer_name,
          resolvedItemCount: resolvedLines.length - restrictedLines.length,
          restrictedItemCount: restrictedLines.length,
          unavailableCount: lines.filter((l: any) => l.line_status === "unavailable" || l.line_status === "pushed_to_request_book").length,
          quoteTotal,
          deliveryCharge: input.deliveryCharge,
        },
      });
    }
    await client.query("COMMIT");
    return { quoteTotal };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function recordCustomerConfirmed(orderId: string) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = rows[0];
    if (!order) throw new OrderError("order_not_found");
    if (order.status !== "quoted") throw new OrderError("not_quoted");
    await client.query(`UPDATE orders SET status = 'customer_confirmed', customer_confirmed_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
    if (order.customer_phone) {
      await enqueueOrderConfirmedNotification(client, orderId, order.customer_id, order.customer_phone, order.customer_name, order.order_number);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function recordCustomerDeclined(orderId: string, reason: string) {
  const db = requirePool();
  const { rows } = await db.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
  if (!rows[0]) throw new OrderError("order_not_found");
  if (rows[0].status !== "quoted") throw new OrderError("not_quoted");
  await db.query(`UPDATE orders SET status = 'rejected', rejection_reason = $1, updated_at = now() WHERE id = $2`, [reason, orderId]);
}

// Section 7A.4: "the order sits in awaiting_prescription until a
// pharmacist marks the prescription verified." Verifying alone isn't
// enough to resume — without also reversing the status change
// startPicking made, the order would be stuck in awaiting_prescription
// forever with no route back to customer_confirmed for start-picking to
// accept (caught live: start-picking then correctly rejected with
// "not_confirmed" and there was no way to clear it).
export async function verifyPrescription(orderId: string, verifiedBy: string) {
  const db = requirePool();
  await db.query(
    `UPDATE orders SET rx_verified = true, rx_verified_by = $1, rx_verified_at = now(), updated_at = now() WHERE id = $2`,
    [verifiedBy, orderId]
  );
  await db.query(
    `UPDATE orders SET status = 'customer_confirmed', updated_at = now() WHERE id = $1 AND status = 'awaiting_prescription'`,
    [orderId]
  );
}
