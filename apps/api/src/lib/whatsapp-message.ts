/**
 * Bill text for the WhatsApp send (Section 6A.6). A plain-text summary,
 * not the full itemised receipt — WhatsApp business-initiated messages
 * are far more likely to be approved (and read) as a short templated
 * message than a wall of text. Same shop identity placeholders as
 * `apps/web/src/lib/receipt.ts`'s printed bill, for the same reason:
 * the owner's real GSTIN/licence numbers aren't known yet.
 */
export function buildBillWhatsAppText(sale: {
  bill_number: string;
  created_at: string;
  grand_total: number | string;
  customer_name: string | null;
}): string {
  const total = Number(sale.grand_total).toFixed(2);
  const date = new Date(sale.created_at).toLocaleDateString("en-IN");
  const greeting = sale.customer_name ? `Hi ${sale.customer_name},` : "Hi,";
  return [
    `${greeting} thank you for shopping at Dipasha Medical Store.`,
    ``,
    `Bill: ${sale.bill_number}`,
    `Date: ${date}`,
    `Amount: ₹${total}`,
    ``,
    `Please keep this for your records. For any query, reply to this message or call the store.`,
  ].join("\n");
}
