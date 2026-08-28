/**
 * Printable bill (Section 6A.6). A clean browser-printable HTML view —
 * not real ESC/POS thermal-printer output (no hardware here to test
 * against) and not yet the full A4 GST tax invoice PDF; both are
 * reasonable near-term follow-ups noted in DECISIONS.md. This covers
 * the actual requirement (something a biller can print for the
 * customer) with what's buildable and verifiable in this environment.
 *
 * Statutory fields shown per Section 6A.6: shop name/address/GSTIN
 * (placeholders — the owner's actual registration details aren't known
 * yet), invoice number and date, per-line batch and expiry, HSN, GST
 * breakdown, pharmacist name. Drug licence numbers (20B/21B) are also
 * placeholders pending the real values.
 */
export function buildReceiptHtml(sale: {
  sale: any;
  lines: any[];
  tenders: any[];
  prescriberDetails: any;
}): string {
  const s = sale.sale;
  const isDuplicate = s.print_count > 1;
  const rows = sale.lines
    .map((l) => {
      const lineDiscount = Number(l.discount_value ?? 0);
      return `
      <tr>
        <td>${escapeHtml(l.product_name)}${l.schedule_category !== "OTC" ? ` <b>[${l.schedule_category}]</b>` : ""}<br>
          <span class="meta">Batch ${escapeHtml(l.batch_no)} · Exp ${formatMonthYear(l.expiry_date)} · HSN ${escapeHtml(l.hsn_code ?? "")}${l.bin_code ? ` · Rack ${escapeHtml(l.bin_code)}` : ""}</span>${lineDiscount > 0 ? `<br><span class="meta">Disc -₹${lineDiscount.toFixed(2)}</span>` : ""}</td>
        <td class="num">${l.quantity_base_units}</td>
        <td class="num">₹${Number(l.mrp / l.pack_size).toFixed(2)}</td>
        <td class="num">₹${Number(l.taxable_value).toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  // Discount can come from either a per-line discount (POS's %/₹/target-price
  // modes on an item) or the bill-level discount field — a bill printed with
  // only the latter checked would silently omit a real per-item discount, so
  // the summary line always reflects whichever combination was actually given.
  const lineDiscountTotal = sale.lines.reduce((a: number, l: any) => a + Number(l.discount_value ?? 0), 0);
  const totalDiscount = lineDiscountTotal + Number(s.bill_discount_value ?? 0);

  const tenderRows = sale.tenders.map((t: any) => `<div class="row"><span>${t.tender_type.toUpperCase()}</span><span>₹${Number(t.amount).toFixed(2)}</span></div>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(s.bill_number)}</title>
<style>
  body { font-family: 'Courier New', monospace; width: 300px; margin: 0 auto; padding: 12px; color: #000; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 2px; }
  .center { text-align: center; }
  .meta { font-size: 10px; color: #333; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  td { padding: 3px 2px; border-bottom: 1px dashed #999; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; font-size: 12px; margin: 2px 0; }
  .total { font-size: 15px; font-weight: bold; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px; }
  .dup { text-align: center; font-weight: bold; border: 2px solid #000; padding: 4px; margin-bottom: 8px; }
  @media print { body { width: 80mm; } }
</style></head>
<body>
  ${isDuplicate ? `<div class="dup">DUPLICATE COPY</div>` : ""}
  <h1>Dipasha Medical Store</h1>
  <p class="center meta">Prayagraj, Uttar Pradesh<br>
    GSTIN: [pending] · Drug Lic. 20B: [pending] · 21B: [pending]</p>
  <p class="meta">Bill: <b>${escapeHtml(s.bill_number)}</b> &nbsp; Date: ${new Date(s.created_at).toLocaleString("en-IN")}</p>
  ${s.customer_name ? `<p class="meta">Customer: ${escapeHtml(s.customer_name)}</p>` : ""}
  ${s.customer_phone ? `<p class="meta">Mobile: ${escapeHtml(s.customer_phone)}</p>` : ""}

  <table>
    <thead><tr><td>Item</td><td class="num">Qty</td><td class="num">Rate</td><td class="num">Amt</td></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="row"><span>Taxable</span><span>₹${Number(s.taxable_value).toFixed(2)}</span></div>
  <div class="row"><span>Tax (CGST+SGST)</span><span>₹${Number(s.tax_total).toFixed(2)}</span></div>
  ${totalDiscount > 0 ? `<div class="row"><span>Discount</span><span>-₹${totalDiscount.toFixed(2)}</span></div>` : ""}
  <div class="row total"><span>TOTAL</span><span>₹${Number(s.grand_total).toFixed(2)}</span></div>

  <div style="margin-top:8px">${tenderRows}</div>
  ${Number(s.change_due) > 0 ? `<div class="row"><b>Change</b><b>₹${Number(s.change_due).toFixed(2)}</b></div>` : ""}

  ${sale.prescriberDetails ? `<p class="meta" style="margin-top:8px">Rx: ${escapeHtml(sale.prescriberDetails.prescriber_name ?? "")} (${escapeHtml(sale.prescriberDetails.prescriber_registration_number ?? "")})<br>Patient: ${escapeHtml(sale.prescriberDetails.patient_name ?? "")}</p>` : ""}

  <p class="center meta" style="margin-top:12px">Thank you for shopping with us.</p>
</body></html>`;
}

function formatMonthYear(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`;
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * The purchase-invoice counterpart to `buildReceiptHtml`, opened the same
 * way (a fresh browser window, view-only) — from the item-history modal's
 * "click a purchase entry" action (Section 5B's F4 item ledger). A4-ish
 * layout since this is a supplier-facing/audit document, not a thermal
 * receipt.
 */
export function buildPurchaseInvoiceHtml(detail: { invoice: any; lines: any[] }): string {
  const inv = detail.invoice;
  const rows = detail.lines
    .map(
      (l: any) => `
      <tr>
        <td>${escapeHtml(l.product_name)}<br><span class="meta">Batch ${escapeHtml(l.batch_no)} · Exp ${formatMonthYear(l.expiry_date)}</span></td>
        <td class="num">${l.quantity_base_units}${Number(l.free_quantity_base_units) > 0 ? ` (+${l.free_quantity_base_units} free)` : ""}</td>
        <td class="num">₹${Number(l.rate_before_discount).toFixed(2)}</td>
        <td class="num">${l.gst_rate}%</td>
        <td class="num">₹${Number(l.line_total).toFixed(2)}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(inv.invoice_number)}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 24px; color: #000; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 11px; color: #333; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
  td, th { padding: 5px 4px; border-bottom: 1px solid #ccc; vertical-align: top; text-align: left; }
  .num { text-align: right; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; font-size: 13px; margin: 3px 0; }
  .total { font-size: 16px; font-weight: bold; border-top: 1px solid #000; padding-top: 6px; margin-top: 6px; }
</style></head>
<body>
  <h1>Purchase invoice ${escapeHtml(inv.invoice_number)}</h1>
  <p class="meta">Vendor: <b>${escapeHtml(inv.vendor_name)}</b>${inv.vendor_gstin ? ` (GSTIN ${escapeHtml(inv.vendor_gstin)})` : ""}<br>
    Invoice date: ${new Date(inv.invoice_date).toLocaleDateString("en-IN")} · entered ${escapeHtml(inv.entry_method)}</p>

  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amt</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div style="margin-top:12px">
    <div class="row"><span>Taxable value</span><span>₹${Number(inv.taxable_value_total).toFixed(2)}</span></div>
    <div class="row"><span>Tax</span><span>₹${Number(inv.tax_total).toFixed(2)}</span></div>
    ${Number(inv.bill_level_discount) > 0 ? `<div class="row"><span>Bill discount</span><span>-₹${Number(inv.bill_level_discount).toFixed(2)}</span></div>` : ""}
    ${Number(inv.freight_and_charges) > 0 ? `<div class="row"><span>Freight/charges</span><span>₹${Number(inv.freight_and_charges).toFixed(2)}</span></div>` : ""}
    <div class="row total"><span>Net payable</span><span>₹${Number(inv.net_payable_computed).toFixed(2)}</span></div>
  </div>
</body></html>`;
}
