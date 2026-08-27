import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { Bin } from "../repo/bins.js";

export interface LabelProduct {
  id: string;
  name: string;
  manufacturer: string;
  barcode: string | null;
}

/**
 * Printable A4 bin-label sheet (Section 4: "Every bin gets a printed
 * QR/barcode label. App must generate a printable label sheet (A4,
 * standard sticker layout)"). One label per bin: the code in large text
 * (readable without scanning) plus a QR code encoding the bin's code
 * (scan-to-confirm put-away, Section 6.6).
 *
 * Print output is black and white only (Section 12C.3) — no colour used
 * here at all, deliberately, even though the brand palette exists.
 */

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 28;
const COLS = 3;
const ROWS = 8;
const GAP = 6;

const CELL_WIDTH = (PAGE_WIDTH - 2 * MARGIN - (COLS - 1) * GAP) / COLS;
const CELL_HEIGHT = (PAGE_HEIGHT - 2 * MARGIN - (ROWS - 1) * GAP) / ROWS;
const LABELS_PER_PAGE = COLS * ROWS;

export async function buildBinLabelSheetPdf(bins: Bin[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const smallFont = await pdf.embedFont(StandardFonts.Helvetica);

  for (let pageStart = 0; pageStart < bins.length; pageStart += LABELS_PER_PAGE) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const pageBins = bins.slice(pageStart, pageStart + LABELS_PER_PAGE);

    for (let idx = 0; idx < pageBins.length; idx++) {
      const bin = pageBins[idx]!;
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      const x = MARGIN + col * (CELL_WIDTH + GAP);
      const y = PAGE_HEIGHT - MARGIN - (row + 1) * CELL_HEIGHT - row * GAP;

      // Cutting guide
      page.drawRectangle({
        x, y, width: CELL_WIDTH, height: CELL_HEIGHT,
        borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5,
      });

      const qrSize = CELL_HEIGHT - 10;
      const qrDataUrl = await QRCode.toDataURL(bin.code, { margin: 0, width: 256 });
      const qrPngBytes = Buffer.from(qrDataUrl.split(",")[1]!, "base64");
      const qrImage = await pdf.embedPng(qrPngBytes);
      page.drawImage(qrImage, { x: x + 5, y: y + 5, width: qrSize, height: qrSize });

      const textX = x + qrSize + 12;
      const textWidth = CELL_WIDTH - qrSize - 17;
      const codeFontSize = bin.code.length > 8 ? 14 : 18;
      page.drawText(bin.code, {
        x: textX, y: y + CELL_HEIGHT - 24, size: codeFontSize, font, color: rgb(0, 0, 0),
        maxWidth: textWidth,
      });
      if (bin.zone) {
        page.drawText(`Zone: ${bin.zone}`, { x: textX, y: y + CELL_HEIGHT - 40, size: 8, font: smallFont, color: rgb(0.2, 0.2, 0.2) });
      }
      if (bin.restricted) {
        page.drawText("RESTRICTED", { x: textX, y: y + 8, size: 8, font, color: rgb(0, 0, 0) });
      }
    }
  }

  return pdf.save();
}

// Section 10.2 Product master: "Barcode assignment and printable label
// sheet generation (PDF download for A4 sticker stock)." Same A4
// sticker-sheet layout and the same QR-encodes-the-scanned-value
// convention as bins above — a USB scanner reads either equally well
// (Section 6A.1), and this build never built a real 1D barcode
// renderer, just as bins never got one either. A product with no
// assigned barcode is skipped, not printed with a blank/fake code.
export async function buildProductLabelSheetPdf(products: LabelProduct[]): Promise<Uint8Array> {
  const printable = products.filter((p) => p.barcode);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const smallFont = await pdf.embedFont(StandardFonts.Helvetica);

  for (let pageStart = 0; pageStart < printable.length; pageStart += LABELS_PER_PAGE) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const pageProducts = printable.slice(pageStart, pageStart + LABELS_PER_PAGE);

    for (let idx = 0; idx < pageProducts.length; idx++) {
      const product = pageProducts[idx]!;
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      const x = MARGIN + col * (CELL_WIDTH + GAP);
      const y = PAGE_HEIGHT - MARGIN - (row + 1) * CELL_HEIGHT - row * GAP;

      page.drawRectangle({
        x, y, width: CELL_WIDTH, height: CELL_HEIGHT,
        borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5,
      });

      const qrSize = CELL_HEIGHT - 10;
      const qrDataUrl = await QRCode.toDataURL(product.barcode!, { margin: 0, width: 256 });
      const qrPngBytes = Buffer.from(qrDataUrl.split(",")[1]!, "base64");
      const qrImage = await pdf.embedPng(qrPngBytes);
      page.drawImage(qrImage, { x: x + 5, y: y + 5, width: qrSize, height: qrSize });

      const textX = x + qrSize + 12;
      const textWidth = CELL_WIDTH - qrSize - 17;
      page.drawText(product.name, {
        x: textX, y: y + CELL_HEIGHT - 20, size: product.name.length > 16 ? 10 : 13, font, color: rgb(0, 0, 0), maxWidth: textWidth,
      });
      page.drawText(product.manufacturer, {
        x: textX, y: y + CELL_HEIGHT - 34, size: 8, font: smallFont, color: rgb(0.2, 0.2, 0.2), maxWidth: textWidth,
      });
      page.drawText(product.barcode!, {
        x: textX, y: y + 8, size: 7, font: smallFont, color: rgb(0.2, 0.2, 0.2), maxWidth: textWidth,
      });
    }
  }

  return pdf.save();
}
