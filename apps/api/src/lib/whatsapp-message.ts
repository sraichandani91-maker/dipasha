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

export interface OrderOutForDeliveryPayload {
  orderNumber: string;
  customerName: string;
  riderName: string;
  riderPhone: string;
}

export interface OrderDeliveredPayload {
  orderNumber: string;
  customerName: string;
}

// Section 10.2's daily auto-report. Owner-facing, not customer-facing —
// short numbers here too, same "summary in the message, detail in-app"
// rule as every other trigger; the full breakdown lives on the Reports
// screen.
export interface DailyReportPayload {
  businessDate: string; // ISO date
  salesTotal: number;
  billCount: number;
  pendingDeliveryOrders: number;
  pendingPutawayTasks: number;
  openCycleCountTasks: number;
  pendingWriteOffApprovals: number;
  coldChainHasGap: boolean;
  coldChainOutOfRange: boolean;
}

// Section 12A.4's shared inbox reply — free text a staff member typed,
// sent verbatim (no template, see repo/whatsapp-inbound.ts for why).
export interface InboxReplyPayload {
  body: string;
}

// Section 9A.3/12A.2's refill reminder — deliberately NOT phrased as
// medical advice ("your regular item is due", not a dosage instruction),
// per the spec's own explicit rule.
export interface RefillReminderPayload {
  customerName: string;
  productName: string;
  exhaustionDate: string; // ISO date
}

// Section 10B.2's one-tap PO send.
export interface POSentPayload {
  poNumber: string;
  vendorName: string;
  lineCount: number;
}

// Section 10B.4's optional daily WhatsApp digest — "the four headline
// figures," nothing more (full detail lives on the Financials screen).
export interface FinancialDailyDigestPayload {
  businessDate: string;
  salesTotal: number;
  purchasesTotal: number;
  grossProfit: number | null;
  grossMarginPercent: number | null;
}

// Owner Home dashboard's "remind now" on a customer due-payment row —
// same neutral, non-threatening tone as every other outbound WhatsApp
// text in this build; never a dunning/collections message.
export interface PaymentDueReminderPayload {
  customerName: string;
  amountDue: number;
  dueDate: string; // ISO date
}

function buildPaymentDueReminderText(p: PaymentDueReminderPayload): string {
  const date = new Date(p.dueDate).toLocaleDateString("en-IN");
  return [
    `Hi ${p.customerName}, this is a reminder from Dipasha Medical Store — ₹${p.amountDue.toFixed(2)} is outstanding on your account, due ${date}.`,
    ``,
    `Reply to this message or visit the store to settle it. Thank you.`,
  ].join("\n");
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
    case "order_out_for_delivery":
      return buildOrderOutForDeliveryText(payload as unknown as OrderOutForDeliveryPayload);
    case "order_delivered":
      return buildOrderDeliveredText(payload as unknown as OrderDeliveredPayload);
    case "daily_report":
      return buildDailyReportText(payload as unknown as DailyReportPayload);
    case "inbox_reply":
      return (payload as unknown as InboxReplyPayload).body;
    case "refill_reminder":
      return buildRefillReminderText(payload as unknown as RefillReminderPayload);
    case "po_sent":
      return buildPOSentText(payload as unknown as POSentPayload);
    case "financial_daily_digest":
      return buildFinancialDailyDigestText(payload as unknown as FinancialDailyDigestPayload);
    case "payment_due_reminder":
      return buildPaymentDueReminderText(payload as unknown as PaymentDueReminderPayload);
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

// Section 12A.2: "...out for delivery with rider name and number..."
function buildOrderOutForDeliveryText(p: OrderOutForDeliveryPayload): string {
  return [
    `Hi ${p.customerName}, your order ${p.orderNumber} from Dipasha Medical Store is out for delivery.`,
    ``,
    `Rider: ${p.riderName} (${p.riderPhone})`,
  ].join("\n");
}

function buildOrderDeliveredText(p: OrderDeliveredPayload): string {
  return [
    `Hi ${p.customerName}, your order ${p.orderNumber} from Dipasha Medical Store has been delivered. Thank you for shopping with us!`,
  ].join("\n");
}

function buildDailyReportText(p: DailyReportPayload): string {
  const date = new Date(p.businessDate).toLocaleDateString("en-IN");
  const flags: string[] = [];
  if (p.pendingWriteOffApprovals > 0) flags.push(`${p.pendingWriteOffApprovals} write-off(s) awaiting approval`);
  if (p.coldChainOutOfRange) flags.push("last cold-chain reading was out of range");
  if (p.coldChainHasGap) flags.push("cold-chain reading is overdue");
  return [
    `Dipasha Medical Store — daily summary for ${date}`,
    ``,
    `Sales: ₹${p.salesTotal.toFixed(2)} across ${p.billCount} bill(s)`,
    `Delivery orders still in progress: ${p.pendingDeliveryOrders}`,
    `Put-away pending: ${p.pendingPutawayTasks}`,
    `Cycle counts pending/awaiting review: ${p.openCycleCountTasks}`,
    ...(flags.length > 0 ? ["", "Needs attention:", ...flags.map((f) => `- ${f}`)] : []),
    ``,
    `Full detail in the console under Reports.`,
  ].join("\n");
}

// Section 9A.3: "Do not phrase reminders as medical advice. A neutral
// 'your regular item is due' is right; anything resembling dosage
// guidance is not." — deliberately doesn't name a dose or frequency.
function buildRefillReminderText(p: RefillReminderPayload): string {
  const date = new Date(p.exhaustionDate).toLocaleDateString("en-IN");
  return [
    `Hi ${p.customerName}, your regular item "${p.productName}" from Dipasha Medical Store is due for a refill around ${date}.`,
    ``,
    `Reply to this message or call the store to order, or visit anytime.`,
  ].join("\n");
}

// Section 10B.2: "one-tap send of the PO to the distributor over
// WhatsApp." A summary, not a line-by-line dump — the PO's PDF/Excel
// export is the actual document; this message is the notification that
// it's on its way, matching every other trigger's "short summary, full
// detail lives elsewhere" rule.
function buildPOSentText(p: POSentPayload): string {
  return [
    `Purchase order ${p.poNumber} from Dipasha Medical Store — ${p.lineCount} item(s).`,
    ``,
    `Please confirm receipt and expected delivery.`,
  ].join("\n");
}

// Section 10B.4: "the four headline figures" — sales, purchases, gross
// profit, gross margin — nothing else. Owner opt-in only, so no
// per-customer redaction concerns apply here (unlike callback/refund
// messages); gross profit/margin can be null when every sold line's cost
// is unknown for the day (see grossProfit.costUnknownWarning upstream).
function buildFinancialDailyDigestText(p: FinancialDailyDigestPayload): string {
  const date = new Date(p.businessDate).toLocaleDateString("en-IN");
  const profitLine =
    p.grossProfit === null || p.grossMarginPercent === null
      ? `Gross profit: unavailable (cost missing on some sales)`
      : `Gross profit: ₹${p.grossProfit.toFixed(2)} (${p.grossMarginPercent.toFixed(1)}%)`;
  return [
    `Dipasha Medical Store — financial summary for ${date}`,
    ``,
    `Sales: ₹${p.salesTotal.toFixed(2)}`,
    `Purchases: ₹${p.purchasesTotal.toFixed(2)}`,
    profitLine,
    ``,
    `Full detail in the console under Financials.`,
  ].join("\n");
}
