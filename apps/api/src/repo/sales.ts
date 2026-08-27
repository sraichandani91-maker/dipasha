import { pool } from "../db.js";
import { allocateFefo, getSpecificBatchStock, InsufficientStockError } from "../domain/fefo.js";
import { billSeriesPrefix, reserveNumber } from "../domain/bill-numbering.js";
import { findOrCreateCustomer } from "./customers.js";
import { enqueueNotification } from "../domain/notifications.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class ValidationError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

export interface SaleLineInput {
  productId: string;
  quantityBaseUnits: number;
  discountPercent: number;
  discountValue: number | null; // either can drive the line; explicit value wins if given
  manualBatchId: string | null;
  manualBatchOverrideReason: string | null;
}

export interface CreateSaleInput {
  channel: "counter" | "delivery";
  customerName: string | null;
  customerPhone: string | null;
  lines: SaleLineInput[];
  billDiscountValue: number;
  roundOff: number;
  tenders: Array<{ tenderType: "cash" | "upi" | "card" | "credit"; amount: number; referenceNumber: string | null }>;
  // Section 6A.8 / Section 8: a delivery order's invoice is generated at
  // pack time, but a COD delivery is paid on handover, not at pack time —
  // there is genuinely nothing tendered yet. When true, `tenders` is
  // ignored and one `cod_pending` tender is recorded for the full grand
  // total instead, so this never has to pretend cash was already
  // collected. Never set by POS (counter sales always tender for real).
  codPending?: boolean;
  prescriberDetails: {
    prescriberId: string | null;
    prescriberName: string | null;
    prescriberRegistrationNumber: string | null;
    patientName: string | null;
    patientContact: string | null;
  } | null;
  fulfillsRequestId: string | null; // Section 6B.4: links the bill back to the request for a true conversion rate
  createdBy: string;
  deviceId: string;
  // Section 6A.9 offline sync (M12): a bill created while offline was
  // already numbered from the device's own pre-reserved block and shown
  // to the customer on the printed receipt at the time — replaying it
  // through reserveNumber() at sync time would both waste a second
  // number and print a different one than the customer already has.
  // Only ever set by the sync-replay path, never by POS's live call.
  preAssignedBillNumber?: string;
  // Same reasoning for the timestamp: an offline sale happened when the
  // biller completed it, not whenever the device eventually reconnects
  // — business_date (and day-close, and every report keyed on it) needs
  // to reflect that real moment.
  occurredAt?: string;
  // Lets a retried sync of the same queued sale be a safe no-op instead
  // of a duplicate sale — checked before any work happens.
  idempotencyKey?: string;
  source: "app" | "web" | "web_manual";
}

// Retail counter sales are always intra-state — the customer is
// physically in the shop, so CGST+SGST split is correct by construction;
// there's no vendor-style out-of-state IGST case at a physical counter.
function splitCounterGst(taxableValue: number, gstRate: number) {
  const total = (taxableValue * gstRate) / 100;
  return { cgstAmount: total / 2, sgstAmount: total / 2 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Everything here runs on ONE transactional connection from the very
// first query, including FEFO allocation and (when this bill fulfils a
// request) releasing that request's reservation — Section 6B.4's
// fulfilment path needs the release visible to FEFO before it allocates,
// and ANY later failure (insufficient tender, a bad line, whatever) must
// undo the release along with everything else. A reservation release
// that survived a failed sale would silently strand the customer's held
// stock with no bill to show for it — caught exactly that bug in
// testing before this was restructured.
export async function createSale(input: CreateSaleInput) {
  if (input.lines.length === 0) throw new ValidationError("no_lines");

  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (input.idempotencyKey) {
      const { rows: existing } = await client.query(`SELECT id, bill_number, created_at, customer_name, customer_phone, taxable_value, tax_total, grand_total, change_due FROM sales WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (existing[0]) {
        await client.query("COMMIT");
        const s = existing[0];
        return { id: s.id, billNumber: s.bill_number, createdAt: s.created_at, customerPhone: s.customer_phone, taxableValueTotal: Number(s.taxable_value), taxTotal: Number(s.tax_total), grandTotal: Number(s.grand_total), changeDue: Number(s.change_due) };
      }
    }

    if (input.fulfillsRequestId) {
      await client.query(
        `UPDATE stock_reservations SET released_at = now(), released_reason = 'fulfilled'
         WHERE customer_request_id = $1 AND released_at IS NULL`,
        [input.fulfillsRequestId]
      );
    }

    const productIds = input.lines.map((l) => l.productId);
    const { rows: productRows } = await client.query(
      `SELECT id, gst_rate, schedule_category, requires_prescription, pack_size FROM products WHERE id = ANY($1::uuid[])`,
      [productIds]
    );
    const productById = new Map(productRows.map((p) => [p.id, p]));

    interface ComputedSubLine {
      requestedLineNo: number;
      productId: string;
      batchId: string;
      binId: string;
      quantity: number;
      mrp: number;
      discountPercent: number;
      discountValue: number;
      taxableValue: number;
      gstRate: number;
      cgstAmount: number;
      sgstAmount: number;
      lineTotal: number;
      effectiveCostPerBaseUnitSnapshot: number | null;
      manualBatchOverride: boolean;
      manualBatchOverrideReason: string | null;
    }

    const subLines: ComputedSubLine[] = [];
    let hasScheduleHOrH1 = false;

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!;
      const product = productById.get(line.productId);
      if (!product) throw new ValidationError("product_not_found", { productId: line.productId });
      if (product.schedule_category === "H" || product.schedule_category === "H1") hasScheduleHOrH1 = true;

      let allocations: Array<{ batchId: string; binId: string; quantity: number }>;
      if (line.manualBatchId) {
        const specific = await getSpecificBatchStock(line.productId, line.manualBatchId, client);
        if (!specific || specific.available < line.quantityBaseUnits) {
          throw new ValidationError("insufficient_stock", { productId: line.productId, available: specific?.available ?? 0, requested: line.quantityBaseUnits });
        }
        allocations = [{ batchId: line.manualBatchId, binId: specific.binId, quantity: line.quantityBaseUnits }];
      } else {
        try {
          allocations = await allocateFefo(line.productId, line.quantityBaseUnits, client);
        } catch (err) {
          if (err instanceof InsufficientStockError) {
            throw new ValidationError("insufficient_stock", { productId: line.productId, available: err.available, requested: err.requested });
          }
          throw err;
        }
      }

      const { rows: batchRows } = await client.query(
        `SELECT id, mrp, effective_cost_per_base_unit, cost_unknown FROM batches WHERE id = ANY($1::uuid[])`,
        [allocations.map((a) => a.batchId)]
      );
      const batchById = new Map(batchRows.map((b) => [b.id, b]));

      for (const alloc of allocations) {
        const batch = batchById.get(alloc.batchId);
        // batches.mrp is per-PACK (Section 5A.3); taxable value etc. need
        // per-base-unit pricing, resolved in the pass below.
        subLines.push({
          requestedLineNo: i,
          productId: line.productId,
          batchId: alloc.batchId,
          binId: alloc.binId,
          quantity: alloc.quantity,
          mrp: Number(batch.mrp),
          discountPercent: line.discountPercent,
          discountValue: 0,
          taxableValue: 0,
          gstRate: Number(product.gst_rate),
          cgstAmount: 0,
          sgstAmount: 0,
          lineTotal: 0,
          effectiveCostPerBaseUnitSnapshot: batch.cost_unknown ? null : batch.effective_cost_per_base_unit === null ? null : Number(batch.effective_cost_per_base_unit),
          manualBatchOverride: !!line.manualBatchId,
          manualBatchOverrideReason: line.manualBatchOverrideReason,
        });
      }
    }

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!;
      const lineSubLines = subLines.filter((s) => s.requestedLineNo === i);
      const product = productById.get(line.productId);
      const packSize = product?.pack_size ?? 1;
      const totalQty = line.quantityBaseUnits;
      const mrpPerBaseUnit = lineSubLines[0]!.mrp / packSize;
      const grossValue = totalQty * mrpPerBaseUnit;
      const lineDiscountValue = line.discountValue ?? (grossValue * line.discountPercent) / 100;

      for (const sub of lineSubLines) {
        const shareOfQty = sub.quantity / totalQty;
        const subGross = sub.quantity * mrpPerBaseUnit;
        const subDiscount = lineDiscountValue * shareOfQty;
        const taxableValue = subGross - subDiscount;
        const gst = splitCounterGst(taxableValue, sub.gstRate);
        sub.discountValue = round2(subDiscount);
        sub.taxableValue = round2(taxableValue);
        sub.cgstAmount = round2(gst.cgstAmount);
        sub.sgstAmount = round2(gst.sgstAmount);
        sub.lineTotal = round2(taxableValue + gst.cgstAmount + gst.sgstAmount);
      }
    }

    const taxableValueTotal = subLines.reduce((a, s) => a + s.taxableValue, 0);
    const taxTotal = subLines.reduce((a, s) => a + s.cgstAmount + s.sgstAmount, 0);
    const grandTotal = round2(taxableValueTotal + taxTotal - input.billDiscountValue + input.roundOff);

    const effectiveTenders = input.codPending
      ? [{ tenderType: "cod_pending" as const, amount: grandTotal, referenceNumber: null }]
      : input.tenders;

    const tenderTotal = effectiveTenders.reduce((a, t) => a + t.amount, 0);
    if (!input.codPending && tenderTotal < grandTotal - 0.5) {
      throw new ValidationError("insufficient_tender", { grandTotal, tendered: tenderTotal });
    }

    // Section 9A.4: a credit sale has to trace back to someone's ledger —
    // "billed to account" with no account identified is a contradiction,
    // not a valid state, so this is a real correctness check rather than
    // an invented business rule.
    const creditTenderTotal = effectiveTenders.filter((t) => t.tenderType === "credit").reduce((a, t) => a + t.amount, 0);
    if (creditTenderTotal > 0 && !input.customerPhone) {
      throw new ValidationError("credit_requires_customer");
    }
    // Cash overage becomes change; credit has no such concept — a credit
    // tender that overshoots the bill would silently inflate the
    // customer's running balance beyond what they were actually billed
    // (caught live: a mistyped credit amount of ₹1100 against a ₹291
    // bill recorded a ₹1100 debt instead of ₹291). So any overage beyond
    // rounding tolerance is rejected outright when credit is involved,
    // rather than quietly becoming free "change" on an account balance.
    if (creditTenderTotal > 0 && tenderTotal > grandTotal + 0.5) {
      throw new ValidationError("credit_tender_exceeds_total", { grandTotal, tendered: tenderTotal });
    }

    const cashTender = effectiveTenders.find((t) => t.tenderType === "cash");
    const changeDue = cashTender ? round2(tenderTotal - grandTotal) : 0;

    let customer = null;
    if (input.customerPhone || input.customerName) {
      customer = await findOrCreateCustomer(input.customerName ?? "Walk-in", input.customerPhone);
    }

    let billNumber = input.preAssignedBillNumber;
    if (!billNumber) {
      const seriesPrefix = await billSeriesPrefix(input.channel);
      billNumber = await reserveNumber(client, seriesPrefix);
    }

    const { rows: saleRows } = await client.query(
      `INSERT INTO sales
         (bill_number, channel, customer_id, customer_name, customer_phone, taxable_value, bill_discount_value,
          tax_total, round_off, grand_total, amount_tendered, change_due, source, created_by, device_id,
          idempotency_key, created_at, business_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
         COALESCE($17::timestamptz, now()), COALESCE($17::timestamptz, now())::date)
       RETURNING id, bill_number, created_at, customer_name, customer_phone`,
      [
        billNumber, input.channel, customer?.id ?? null, customer?.name ?? null, customer?.phone ?? input.customerPhone ?? null,
        round2(taxableValueTotal), input.billDiscountValue, round2(taxTotal), input.roundOff, grandTotal, tenderTotal, changeDue,
        input.source, input.createdBy, input.deviceId, input.idempotencyKey ?? null, input.occurredAt ?? null,
      ]
    );
    const sale = saleRows[0];

    for (const sub of subLines) {
      await client.query(
        `INSERT INTO sale_lines
           (sale_id, requested_line_no, product_id, batch_id, bin_id, quantity_base_units, mrp, discount_percent,
            discount_value, taxable_value, gst_rate, cgst_amount, sgst_amount, line_total,
            effective_cost_per_base_unit_snapshot, manual_batch_override, manual_batch_override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          sale.id, sub.requestedLineNo, sub.productId, sub.batchId, sub.binId, sub.quantity, sub.mrp, sub.discountPercent,
          sub.discountValue, sub.taxableValue, sub.gstRate, sub.cgstAmount, sub.sgstAmount, sub.lineTotal,
          sub.effectiveCostPerBaseUnitSnapshot, sub.manualBatchOverride, sub.manualBatchOverrideReason,
        ]
      );

      // Hard rule (Section 6A.2): negative stock never permitted. FEFO
      // allocation already guaranteed enough total stock exists; this
      // insert is the actual deduction.
      await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reference_type, reference_id, source, actor_user_id, device_id)
         VALUES ('gst_sale', $1, $2, $3, $4, 'sale', $5, $6, $7, $8)`,
        [sub.productId, sub.batchId, sub.binId, -sub.quantity, sale.id, input.source, input.createdBy, input.deviceId]
      );
    }

    for (const t of effectiveTenders) {
      await client.query(
        `INSERT INTO sale_tenders (sale_id, tender_type, amount, reference_number) VALUES ($1,$2,$3,$4)`,
        [sale.id, t.tenderType, t.amount, t.referenceNumber]
      );
    }

    // Section 6A.3: writes automatically to the statutory register — no
    // separate manual entry. Captured even with fields blank for an H/H1
    // sale, per "any field left blank is recorded as blank on the
    // register rather than blocking the bill." For a non-H/H1 sale this
    // only writes a row if the biller actually attached a prescriber —
    // Section 9A.1's "optional but encouraged elsewhere," not mandatory.
    if (hasScheduleHOrH1 || input.prescriberDetails) {
      const pd = input.prescriberDetails;
      await client.query(
        `INSERT INTO sale_prescriber_details (sale_id, prescriber_id, prescriber_name, prescriber_registration_number, patient_name, patient_contact)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sale.id, pd?.prescriberId ?? null, pd?.prescriberName ?? null, pd?.prescriberRegistrationNumber ?? null, pd?.patientName ?? null, pd?.patientContact ?? null]
      );
    }

    // Section 6B.4: "When the customer buys, link the bill to the
    // request and mark it fulfilled — that gives you a true
    // request-to-sale conversion rate."
    if (input.fulfillsRequestId) {
      await client.query(
        `UPDATE customer_requests SET status = 'fulfilled', fulfilled_sale_id = $1, updated_at = now() WHERE id = $2`,
        [sale.id, input.fulfillsRequestId]
      );
    }

    // Section 12A.2: "sends immediately on bill save, if the phone number
    // is present." Enqueues only — this is a plain DB insert inside the
    // same transaction as the sale, so it's atomic with it and never
    // makes the bill wait on a network call. The background dispatcher
    // (domain/notifications.ts, polled from index.ts) does the actual
    // send after this transaction commits.
    if (sale.customer_phone) {
      await enqueueNotification(client, {
        triggerType: "bill_generated",
        category: "transactional",
        templateKey: "whatsapp_template_bill_generated",
        triggerEnabledSettingKey: "whatsapp_trigger_bill_generated_enabled",
        recipientCustomerId: customer?.id ?? null,
        recipientPhone: sale.customer_phone,
        referenceType: "sale",
        referenceId: sale.id,
        payload: { billNumber: sale.bill_number, date: sale.created_at, grandTotal, customerName: sale.customer_name },
      });
    }

    await client.query("COMMIT");
    return { id: sale.id, billNumber: sale.bill_number, createdAt: sale.created_at, customerPhone: sale.customer_phone, taxableValueTotal: round2(taxableValueTotal), taxTotal: round2(taxTotal), grandTotal, changeDue };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
