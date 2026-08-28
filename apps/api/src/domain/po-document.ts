import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Section 10B.2: "export a PO as PDF and Excel, formatted to the
 * vendor's expectation." A plain, single-page document — this build's
 * consistent print-output rule (Section 12C.3: black and white only)
 * applies here too, same as the bin-label sheet and the printed bill.
 */
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;

export interface PoDocumentLine {
  product_name: string;
  quantity_base_units: number;
}

export interface PoDocumentData {
  po_number: string;
  vendor_name: string;
  created_at: string | Date;
  lines: PoDocumentLine[];
}

export async function buildPurchaseOrderPdf(po: PoDocumentData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  let y = PAGE_HEIGHT - MARGIN;
  page.drawText("Dipasha Medical Store", { x: MARGIN, y, size: 16, font: bold });
  y -= 18;
  page.drawText("Prayagraj, Uttar Pradesh", { x: MARGIN, y, size: 10, font: regular, color: rgb(0.3, 0.3, 0.3) });
  y -= 30;

  page.drawText(`Purchase Order ${po.po_number}`, { x: MARGIN, y, size: 14, font: bold });
  y -= 18;
  page.drawText(`To: ${po.vendor_name}`, { x: MARGIN, y, size: 11, font: regular });
  y -= 14;
  page.drawText(`Date: ${new Date(po.created_at).toLocaleDateString("en-IN")}`, { x: MARGIN, y, size: 11, font: regular });
  y -= 28;

  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: rgb(0, 0, 0) });
  y -= 16;
  page.drawText("Item", { x: MARGIN, y, size: 10, font: bold });
  page.drawText("Quantity (base units)", { x: PAGE_WIDTH - MARGIN - 140, y, size: 10, font: bold });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 16;

  for (const line of po.lines) {
    if (y < MARGIN + 20) break; // single page for now — a very long PO is a real, accepted limitation
    page.drawText(line.product_name, { x: MARGIN, y, size: 10, font: regular });
    page.drawText(String(line.quantity_base_units), { x: PAGE_WIDTH - MARGIN - 140, y, size: 10, font: regular });
    y -= 16;
  }

  return pdf.save();
}

// Excel-openable, not a real .xlsx — same "CSV is Excel-openable, a real
// multi-sheet .xlsx is a reasonable follow-up" choice this build already
// made for statutory reports (lib/csv.ts), applied consistently here.
export function buildPurchaseOrderCsv(po: PoDocumentData): string {
  const lines = [
    `Purchase Order,${po.po_number}`,
    `Vendor,${po.vendor_name}`,
    `Date,${new Date(po.created_at).toLocaleDateString("en-IN")}`,
    ``,
    `Item,Quantity (base units)`,
    ...po.lines.map((l) => `"${l.product_name.replace(/"/g, '""')}",${l.quantity_base_units}`),
  ];
  return lines.join("\n") + "\n";
}
