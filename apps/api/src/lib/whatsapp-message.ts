/**
 * WhatsApp message text, per trigger type (Section 12A.2). Plain-text
 * summaries, not full documents — WhatsApp business-initiated messages
 * need a Meta-approved template, and a short message is both easier to
 * get approved and more likely to actually be read; anything more
 * detailed (the itemised receipt) is the print path's job. Same shop
 * identity placeholders as `apps/web/src/lib/receipt.ts`'s printed
 * bill, for the same reason: the owner's real GSTIN/licence numbers
 * aren't known yet.
 *
 * `notification_log.payload` stores exactly the fields each builder
 * below needs — set once at enqueue time (`domain/notifications.ts`),
 * read here at send time. Keeping the payload shape trigger-specific
 * (rather than one generic bag) makes a missing field a type error
 * here, not a silent blank in the message a customer receives.
 */
export interface BillGeneratedPayload {
  billNumber: string;
  date: string; // ISO
  grandTotal: number;
  customerName: string | null;
}

export interface CallbackStockAvailablePayload {
  productName: string;
  scheduleCategory: string;
  reservedUntilHours: number;
  customerName: string;
}

export interface OrderConfirmedPayload {
  orderNumber: string;
  customerName: string;
}

export interface OrderQuotePayload {
  orderNumber: string;
  customerName: string;
  resolvedItemCount: number;
  restrictedItemCount: number;
  unavailableCount: number;
  quoteTotal: number;
  deliveryCharge: number;
}

export interface OrderPartiallyAvailablePayload {
  orderNumber: string;
  customerName: string;
  unavailableCount: number;
}

export function buildWhatsAppText(triggerType: string, payload: Record<string, unknown>): string {
  switch (triggerType) {
    case "bill_generated":
      return buildBillGeneratedText(payload as unknown as BillGeneratedPayload);
    case "callback_stock_available":
      return buildCallbackStockAvailableText(payload as unknown as CallbackStockAvailablePayload);
    case "order_confirmed":
      return buildOrderConfirmedText(payload as unknown as OrderConfirmedPayload);
    case "order_quote":
      return buildOrderQuoteText(payload as unknown as OrderQuotePayload);
    case "order_partially_available":
      return buildOrderPartiallyAvailableText(payload as unknown as OrderPartiallyAvailablePayload);
    default:
      throw new Error(`No WhatsApp message builder for trigger type "${triggerType}"`);
  }
}

function buildBillGeneratedText(p: BillGeneratedPayload): string {
  const total = Number(p.grandTotal).toFixed(2);
  const date = new Date(p.date).toLocaleDateString("en-IN");
  const greeting = p.customerName ? `Hi ${p.customerName},` : "Hi,";
  return [
    `${greeting} thank you for shopping at Dipasha Medical Store.`,
    ``,
    `Bill: ${p.billNumber}`,
    `Date: ${date}`,
    `Amount: ₹${total}`,
    ``,
    `Please keep this for your records. For any query, reply to this message or call the store.`,
  ].join("\n");
}

// Section 6B.4: "the reservation window stated in the message." Section
// 12A.5: "do not put medicine names for Schedule H, H1 or X items in the
// message body" — a phone is often shared, so a restricted-drug name
// never appears here even though the customer is the one who asked for
// it by name in person; the message names the item only for OTC/other
// categories where that privacy concern doesn't apply.
function buildCallbackStockAvailableText(p: CallbackStockAvailablePayload): string {
  const isRestricted = ["H", "H1", "X"].includes(p.scheduleCategory);
  const itemLine = isRestricted ? "the item you asked about" : `"${p.productName}"`;
  return [
    `Hi ${p.customerName}, good news — ${itemLine} at Dipasha Medical Store is now in stock.`,
    ``,
    `We've held it for you for the next ${p.reservedUntilHours} hours. Please visit or call to collect it.`,
  ].join("\n");
}

// Section 12A.2: "Delivery order: confirmed..." — the counterpart to
// bill_generated for the delivery channel, same short-summary treatment
// (itemised detail is the in-app review screen's job, not a WhatsApp
// message body — same call already made for bill_generated).
function buildOrderConfirmedText(p: OrderConfirmedPayload): string {
  return [
    `Hi ${p.customerName}, your order ${p.orderNumber} with Dipasha Medical Store is confirmed and is being prepared for delivery.`,
    ``,
    `We'll message you again once it's out for delivery.`,
  ].join("\n");
}

// Section 7A.3: "quoting back... item, pack, quantity, MRP, availability,
// total, delivery charge, and anything unavailable stated plainly."
// Kept to counts rather than full line-by-line detail for the same
// reason bill_generated stays a summary (Section 12A: short messages,
// full detail lives in-app/on the printed or PDF document) — and
// Section 12A.5's redaction rule means a restricted item could never be
// named here anyway, so "N items" for those is both the safe and the
// consistent choice.
function buildOrderQuoteText(p: OrderQuotePayload): string {
  const lines = [`Hi ${p.customerName}, here's your quote for order ${p.orderNumber} from Dipasha Medical Store:`, ``];
  if (p.resolvedItemCount > 0) lines.push(`${p.resolvedItemCount} item(s) available`);
  if (p.restrictedItemCount > 0) lines.push(`${p.restrictedItemCount} prescription item(s) available`);
  if (p.unavailableCount > 0) lines.push(`${p.unavailableCount} item(s) unavailable`);
  lines.push(``, `Delivery charge: ₹${p.deliveryCharge.toFixed(2)}`, `Total: ₹${p.quoteTotal.toFixed(2)}`, ``, `Reply to confirm or decline this order.`);
  return lines.join("\n");
}

// Section 7: "order goes partial with customer notification triggered."
function buildOrderPartiallyAvailableText(p: OrderPartiallyAvailablePayload): string {
  return [
    `Hi ${p.customerName}, order ${p.orderNumber} from Dipasha Medical Store has been packed, but ${p.unavailableCount} item(s) could not be included.`,
    ``,
    `We'll follow up separately on those. The rest of your order is on its way.`,
  ].join("\n");
}
