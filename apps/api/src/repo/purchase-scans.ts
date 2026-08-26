import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { getSetting } from "./settings.js";
import { extractInvoice, ExtractionError, type ExtractedInvoice } from "../lib/invoice-extractor.js";
import { createPurchaseInvoice, type CreatePurchaseInvoiceInput, type PurchaseLineInput } from "./purchases.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface ScanPageFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export function computeImageHash(pages: ScanPageFile[]): string {
  const hash = createHash("sha256");
  for (const p of pages) hash.update(p.buffer);
  return hash.digest("hex");
}

/**
 * Section 6.3, Stage 1+2 — capture then extract, in one call. "Do not
 * call the model on the review screen — only on capture" means
 * extraction happens exactly once, here, synchronously with the upload;
 * the review screen (GET /purchase-scans/:id) only ever reads back what
 * this wrote. Cached by image hash first — "an accidental re-upload
 * does not re-bill" — so a genuine duplicate upload costs one DB lookup,
 * not a second LLM call.
 */
export async function createAndExtractScan(input: {
  pages: ScanPageFile[];
  vendorId: string;
  createdBy: string;
  deviceId: string;
}): Promise<{ id: string; status: string; cached: boolean }> {
  const db = requirePool();
  const imageHash = computeImageHash(input.pages);

  const { rows: cacheRows } = await db.query(
    // status IN ('extracted', 'committed') is not enough on its own — a
    // scan can reach 'committed' via the extraction_failed fallback path
    // with raw_extraction still null, and that must never count as a
    // cache hit (it would resurrect a null extraction as a fake
    // "extracted" result on the next identical upload). Caught live:
    // re-uploading the same PDF that had previously failed extraction
    // and been manually committed produced a scan marked 'extracted'
    // with no actual data behind it.
    `SELECT raw_extraction, extraction_model FROM purchase_invoice_scans
     WHERE image_hash = $1 AND status IN ('extracted', 'committed') AND raw_extraction IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [imageHash]
  );
  const cached = cacheRows[0] ?? null;

  const client = await db.connect();
  let scanId: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO purchase_invoice_scans (image_hash, status, vendor_id, created_by, device_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [imageHash, cached ? "extracted" : "captured", input.vendorId, input.createdBy, input.deviceId]
    );
    scanId = rows[0].id;
    let pageNumber = 1;
    for (const page of input.pages) {
      await client.query(
        `INSERT INTO purchase_invoice_scan_pages (scan_id, page_number, file_path, mime_type) VALUES ($1,$2,$3,$4)`,
        [scanId, pageNumber, page.filename, page.mimeType]
      );
      pageNumber++;
    }
    if (cached) {
      await client.query(
        `UPDATE purchase_invoice_scans SET raw_extraction = $1, extraction_model = $2, extracted_at = now() WHERE id = $3`,
        [cached.raw_extraction, cached.extraction_model, scanId]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (cached) return { id: scanId, status: "extracted", cached: true };

  const model = await getSetting("ai_invoice_extraction_model", "claude-opus-5");
  try {
    const extracted = await extractInvoice(
      input.pages.map((p) => ({ data: p.buffer, mimeType: p.mimeType })),
      model
    );
    await db.query(
      `UPDATE purchase_invoice_scans SET status = 'extracted', raw_extraction = $1, extraction_model = $2, extracted_at = now() WHERE id = $3`,
      [JSON.stringify(extracted), model, scanId]
    );
    return { id: scanId, status: "extracted", cached: false };
  } catch (err) {
    // Section 6.3 fallback: "if extraction fails... drop the user into
    // the blank manual entry form with the image displayed — never a
    // dead end." So this is a recorded outcome, not a thrown HTTP error.
    const message = err instanceof ExtractionError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    await db.query(`UPDATE purchase_invoice_scans SET status = 'extraction_failed', extraction_error = $1 WHERE id = $2`, [message, scanId]);
    return { id: scanId, status: "extraction_failed", cached: false };
  }
}

export async function getScan(id: string) {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT s.*, v.name AS vendor_name FROM purchase_invoice_scans s LEFT JOIN vendors v ON v.id = s.vendor_id WHERE s.id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const { rows: pages } = await db.query(
    `SELECT page_number, mime_type, file_path FROM purchase_invoice_scan_pages WHERE scan_id = $1 ORDER BY page_number`,
    [id]
  );
  return { ...rows[0], pages };
}

export async function listScans(limit = 50) {
  const { rows } = await requirePool().query(
    `SELECT s.id, s.status, s.created_at, s.vendor_id, v.name AS vendor_name, s.purchase_invoice_id
     FROM purchase_invoice_scans s LEFT JOIN vendors v ON v.id = s.vendor_id
     ORDER BY s.created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export interface ProductMatchCandidate {
  productId: string;
  productName: string;
  score: number;
}

// Section 6.3, Stage 3: "fuzzy-match each extracted product name against
// the product master. Show top 3 candidates with match confidence" and
// "remember every accepted match as a vendor_product_alias... the
// system should need materially less correction by the twentieth
// invoice than the first." An exact alias hit short-circuits with
// confidence 1 — no reason to re-run trigram matching on a name this
// vendor's invoices have already trained the system on.
export async function suggestProductMatches(vendorId: string, printedName: string): Promise<{ candidates: ProductMatchCandidate[]; aliasMatch: boolean }> {
  const db = requirePool();
  const { rows: aliasRows } = await db.query(
    `SELECT p.id, p.name FROM vendor_product_aliases a JOIN products p ON p.id = a.product_id
     WHERE a.vendor_id = $1 AND a.alias_text = $2`,
    [vendorId, printedName]
  );
  if (aliasRows[0]) {
    return { candidates: [{ productId: aliasRows[0].id, productName: aliasRows[0].name, score: 1 }], aliasMatch: true };
  }

  const { rows } = await db.query(
    `SELECT id, name, similarity(name, $1) AS score FROM products
     WHERE status = 'active' AND name % $1
     ORDER BY score DESC LIMIT 3`,
    [printedName]
  );
  return { candidates: rows.map((r) => ({ productId: r.id, productName: r.name, score: Number(r.score) })), aliasMatch: false };
}

// Section 6.3, Stage 3: records the accepted match so the next invoice
// from this vendor auto-resolves it. Bumping use_count/last_used_at on
// conflict rather than always inserting keeps the alias table one row
// per (vendor, printed name), not a growing history of the same choice.
export async function recordVendorProductAlias(vendorId: string, aliasText: string, productId: string): Promise<void> {
  await requirePool().query(
    `INSERT INTO vendor_product_aliases (vendor_id, alias_text, product_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (vendor_id, alias_text) DO UPDATE SET product_id = $3, use_count = vendor_product_aliases.use_count + 1, last_used_at = now()`,
    [vendorId, aliasText, productId]
  );
}

export async function setScanVendor(id: string, vendorId: string): Promise<void> {
  await requirePool().query(`UPDATE purchase_invoice_scans SET vendor_id = $1 WHERE id = $2`, [vendorId, id]);
}

export class ScanCommitError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface ScanCommitLineInput extends PurchaseLineInput {
  // The extracted text this line was matched from, if any — null for a
  // manually added line. Lets commit record the accepted match as a
  // vendor_product_alias without the client needing a second call.
  printedNameForAlias: string | null;
}

export interface CommitScanInput extends Omit<CreatePurchaseInvoiceInput, "lines" | "entryMethod" | "source"> {
  lines: ScanCommitLineInput[];
}

const MONEY_TOLERANCE = 0.5;
const LINE_DIFF_FIELDS: Array<{ key: keyof PurchaseLineInput; extractedKey: keyof ExtractedInvoice["lines"][number]; numeric: boolean }> = [
  { key: "batchNo", extractedKey: "batchNumber", numeric: false },
  { key: "expiryDate", extractedKey: "expiryNormalized", numeric: false },
  { key: "quantityBaseUnits", extractedKey: "quantityBaseUnits", numeric: true },
  { key: "freeQuantityBaseUnits", extractedKey: "freeQuantityBaseUnits", numeric: true },
  { key: "rateBeforeDiscount", extractedKey: "rateBeforeDiscount", numeric: true },
  { key: "discountPercent", extractedKey: "discountPercent", numeric: true },
  { key: "gstRate", extractedKey: "gstRate", numeric: true },
  { key: "mrp", extractedKey: "mrp", numeric: true },
];

// Section 6.3, Stage 4: "store the raw extraction JSON alongside the
// final committed values, and record which fields the human corrected."
// Index-aligned against the extracted lines the client started from —
// good enough for "how much correction did this vendor's invoices
// need," not attempting to diff a fully reordered/added/removed set of
// lines field-by-field.
function diffCorrectedFields(raw: ExtractedInvoice, input: CommitScanInput) {
  const headerDiff: string[] = [];
  const headerChecks: Array<[string, unknown, unknown, boolean]> = [
    ["invoiceNumber", raw.invoiceNumberExtracted, input.invoiceNumber, false],
    ["invoiceDate", raw.invoiceDateExtracted, input.invoiceDate, false],
    ["invoiceTotal", raw.invoiceTotalExtracted, input.invoiceValueStated, true],
  ];
  for (const [field, rawVal, finalVal, numeric] of headerChecks) {
    if (fieldsDiffer(rawVal, finalVal, numeric)) headerDiff.push(field);
  }

  const lineDiffs: Array<{ lineIndex: number; fields: string[] }> = [];
  const alignedCount = Math.min(raw.lines.length, input.lines.length);
  for (let i = 0; i < alignedCount; i++) {
    const rawLine = raw.lines[i]!;
    const finalLine = input.lines[i]!;
    const fields: string[] = [];
    for (const f of LINE_DIFF_FIELDS) {
      if (fieldsDiffer(rawLine[f.extractedKey], finalLine[f.key], f.numeric)) fields.push(f.key);
    }
    if (fields.length > 0) lineDiffs.push({ lineIndex: i, fields });
  }

  return {
    headerFieldsCorrected: headerDiff,
    lineDiffs,
    linesAdded: Math.max(0, input.lines.length - raw.lines.length),
    linesRemoved: Math.max(0, raw.lines.length - input.lines.length),
    totalFieldsExtracted: headerChecks.length + raw.lines.length * LINE_DIFF_FIELDS.length,
    totalFieldsCorrected: headerDiff.length + lineDiffs.reduce((a, d) => a + d.fields.length, 0),
  };
}

function fieldsDiffer(rawVal: unknown, finalVal: unknown, numeric: boolean): boolean {
  if (rawVal === null || rawVal === undefined) return false; // nothing to have corrected against
  if (numeric) return Math.abs(Number(rawVal) - Number(finalVal)) > MONEY_TOLERANCE;
  return String(rawVal).trim() !== String(finalVal ?? "").trim();
}

// Section 6.3, Stage 4: "one confirm action creates the GRN and the
// ledger rows." Reuses createPurchaseInvoice wholesale — same
// duplicate-invoice hard block, near-expiry warning, and reconciliation
// check as manual entry — so an AI-scanned invoice is held to exactly
// the same Section 6.2 validation, not a lighter parallel path.
//
// Also the fallback commit path: "if extraction fails... drop the user
// into the blank manual entry form with the image displayed — never a
// dead end." A scan stuck at extraction_failed can still be committed —
// there's just nothing to diff against (raw_extraction is null) and the
// entry is honestly logged as manual, not ai_scan, since no AI output
// actually fed the committed values.
export async function commitScan(scanId: string, input: CommitScanInput) {
  const scan = await getScan(scanId);
  if (!scan) throw new ScanCommitError("scan_not_found");
  if (scan.status === "committed") throw new ScanCommitError("already_committed");
  if (scan.status !== "extracted" && scan.status !== "extraction_failed") throw new ScanCommitError("not_ready");

  const correctedFields = scan.status === "extracted" && scan.raw_extraction ? diffCorrectedFields(scan.raw_extraction, input) : null;

  const result = await createPurchaseInvoice({
    ...input,
    lines: input.lines.map(({ printedNameForAlias, ...line }) => line),
    entryMethod: scan.status === "extracted" ? "ai_scan" : "manual",
    source: "web",
  });

  for (const line of input.lines) {
    if (line.printedNameForAlias) {
      await recordVendorProductAlias(input.vendorId, line.printedNameForAlias, line.productId);
    }
  }

  // Pass a real SQL NULL, not the JSON string "null" — JSON.stringify(null)
  // would store a jsonb `null` value, which is NOT NULL to `IS NOT NULL`
  // and would crash getVendorAccuracyReport() reading .totalFieldsExtracted
  // off it.
  await requirePool().query(
    `UPDATE purchase_invoice_scans SET status = 'committed', purchase_invoice_id = $1, corrected_fields = $2, committed_at = now() WHERE id = $3`,
    [result.id, correctedFields === null ? null : JSON.stringify(correctedFields), scanId]
  );

  return result;
}

// Section 6.3, Stage 4: "track extraction accuracy per vendor over
// time — that report tells you which vendors' invoices you can
// eventually trust on a lighter review and which always need a careful
// read." Correction rate is 1 - (corrected fields / total extracted
// fields) across every committed AI-scanned invoice from that vendor.
export async function getVendorAccuracyReport() {
  const { rows } = await requirePool().query(
    `SELECT v.id AS vendor_id, v.name AS vendor_name, s.corrected_fields
     FROM purchase_invoice_scans s
     JOIN vendors v ON v.id = s.vendor_id
     WHERE s.status = 'committed' AND s.corrected_fields IS NOT NULL`
  );
  // Aggregated in JS, not SQL — corrected_fields is one jsonb blob per
  // scan (totalFieldsExtracted/totalFieldsCorrected already computed at
  // commit time), simpler to sum here than to unnest jsonb per vendor.
  const byVendor = new Map<string, { vendorId: string; vendorName: string; scansCommitted: number; totalExtracted: number; totalCorrected: number }>();
  for (const r of rows) {
    const entry = byVendor.get(r.vendor_id) ?? { vendorId: r.vendor_id, vendorName: r.vendor_name, scansCommitted: 0, totalExtracted: 0, totalCorrected: 0 };
    entry.scansCommitted += 1;
    entry.totalExtracted += r.corrected_fields.totalFieldsExtracted ?? 0;
    entry.totalCorrected += r.corrected_fields.totalFieldsCorrected ?? 0;
    byVendor.set(r.vendor_id, entry);
  }
  return [...byVendor.values()]
    .map((v) => ({ ...v, correctionRatePercent: v.totalExtracted > 0 ? Math.round((v.totalCorrected / v.totalExtracted) * 1000) / 10 : 0 }))
    .sort((a, b) => a.correctionRatePercent - b.correctionRatePercent);
}

export type { ExtractedInvoice };
