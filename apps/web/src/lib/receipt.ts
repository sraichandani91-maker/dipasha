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
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(l.product_name)}${l.schedule_category !== "OTC" ? ` <b>[${l.schedule_category}]</b>` : ""}<br>
          <span class="meta">Batch ${escapeHtml(l.batch_no)} · Exp ${formatMonthYear(l.expiry_date)} · HSN ${escapeHtml(l.hsn_code ?? "")}${l.bin_code ? ` · Rack ${escapeHtml(l.bin_code)}` : ""}</span></td>
        <td class="num">${l.quantity_base_units}</td>
        <td class="num">₹${Number(l.mrp / l.pack_size).toFixed(2)}</td>
        <td class="num">₹${Number(l.taxable_value).toFixed(2)}</td>
      </tr>`
    )
    .join("");

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
  ${Number(s.bill_discount_value) > 0 ? `<div class="row"><span>Discount</span><span>-₹${Number(s.bill_discount_value).toFixed(2)}</span></div>` : ""}
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
