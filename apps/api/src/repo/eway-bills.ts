import { pool } from "../db.js";
import { getSetting } from "./settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class EwayBillError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Section 10B.3: "flag any invoice crossing the configurable threshold
// (default fifty thousand rupees) and prompt that an e-way bill may be
// required." Reuses `eway_bill_threshold_inr`, seeded back at M1
// specifically for this — see DECISIONS.md.
export async function checkEwayBillRequired(referenceType: "sale" | "purchase_invoice", referenceId: string) {
  const threshold = await getSetting("eway_bill_threshold_inr", 50000);
  const table = referenceType === "sale" ? "sales" : "purchase_invoices";
  const valueColumn = referenceType === "sale" ? "grand_total" : "net_payable_computed";
  const { rows } = await requirePool().query(`SELECT ${valueColumn} AS value FROM ${table} WHERE id = $1`, [referenceId]);
  if (!rows[0]) throw new EwayBillError("not_found");
  const value = Number(rows[0].value);
  return { value, threshold, required: value >= threshold };
}

export interface CreateEwayBillInput {
  referenceType: "sale" | "purchase_invoice";
  referenceId: string;
  transporterName: string | null;
  transporterGstin: string | null;
  vehicleNumber: string | null;
  distanceKm: number | null;
  createdBy: string;
}

// Section 10B.3: "generate the JSON in the portal's accepted format for
// manual upload — this is the pragmatic path and avoids a GSP
// integration you almost certainly do not need." The JSON shape mirrors
// the NIC e-way bill portal's documented bulk-upload EWB request format
// (docTypes/docNo/transporterId/vehicleNo/distance are its real field
// names) closely enough to orient someone filling the portal's own form
// by hand — not a byte-for-byte schema this build can validate without
// a live GSP sandbox, the same honesty limitation as the Tally export.
export async function createEwayBill(input: CreateEwayBillInput): Promise<{ id: string; generatedJson: Record<string, unknown> }> {
  const db = requirePool();
  const check = await checkEwayBillRequired(input.referenceType, input.referenceId);

  const table = input.referenceType === "sale" ? "sales" : "purchase_invoices";
  const numberColumn = input.referenceType === "sale" ? "bill_number" : "invoice_number";
  const { rows: refRows } = await db.query(`SELECT ${numberColumn} AS doc_no FROM ${table} WHERE id = $1`, [input.referenceId]);

  const generatedJson = {
    docType: input.referenceType === "sale" ? "INV" : "PUR",
    docNo: refRows[0]?.doc_no ?? null,
    docValue: check.value,
    transporterName: input.transporterName,
    transporterGstin: input.transporterGstin,
    vehicleNo: input.vehicleNumber,
    distanceKm: input.distanceKm,
    generatedAt: new Date().toISOString(),
  };

  const { rows } = await db.query(
    `INSERT INTO eway_bills (reference_type, reference_id, transporter_name, transporter_gstin, vehicle_number, distance_km, generated_json, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [input.referenceType, input.referenceId, input.transporterName, input.transporterGstin, input.vehicleNumber, input.distanceKm, JSON.stringify(generatedJson), input.createdBy]
  );
  return { id: rows[0].id, generatedJson };
}

// Once generated on the government portal (outside this system, by
// design — see the stub reasoning above), the resulting number/validity
// is recorded back here for reference against the invoice.
export async function recordEwayBillNumber(id: string, ewayBillNumber: string, validUntil: string): Promise<void> {
  const { rowCount } = await requirePool().query(
    `UPDATE eway_bills SET eway_bill_number = $1, valid_until = $2 WHERE id = $3`,
    [ewayBillNumber, validUntil, id]
  );
  if (rowCount === 0) throw new EwayBillError("not_found");
}

export async function listEwayBillsForReference(referenceType: "sale" | "purchase_invoice", referenceId: string) {
  const { rows } = await requirePool().query(
    `SELECT * FROM eway_bills WHERE reference_type = $1 AND reference_id = $2 ORDER BY created_at DESC`,
    [referenceType, referenceId]
  );
  return rows;
}

// Section 10B.3's e-invoicing stub — storage only, no IRN/QR generation
// logic exists (no e-invoicing GSP integration either, same reasoning).
export async function recordSaleIrn(saleId: string, irn: string, irnQrCodeData: string | null): Promise<void> {
  const { rowCount } = await requirePool().query(`UPDATE sales SET irn = $1, irn_qr_code_data = $2 WHERE id = $3`, [irn, irnQrCodeData, saleId]);
  if (rowCount === 0) throw new EwayBillError("not_found");
}
