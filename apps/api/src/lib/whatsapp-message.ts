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

export function buildWhatsAppText(triggerType: string, payload: Record<string, unknown>): string {
  switch (triggerType) {
    case "bill_generated":
      return buildBillGeneratedText(payload as unknown as BillGeneratedPayload);
    case "callback_stock_available":
      return buildCallbackStockAvailableText(payload as unknown as CallbackStockAvailablePayload);
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
