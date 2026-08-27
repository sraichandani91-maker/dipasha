import { api, ApiError } from "../api.js";
import { STORES, idbGetAll, idbGet, idbPut, idbPutAll, idbDelete, idbClear } from "./db.js";

export interface SnapshotBatch {
  batchId: string;
  binId: string;
  binCode: string;
  batchNo: string;
  expiryDate: string;
  mrp: number;
  quantityBaseUnits: number;
}
export interface SnapshotProduct {
  id: string;
  name: string;
  manufacturer: string;
  packSize: number;
  baseUnit: string;
  gstRate: number;
  scheduleCategory: string;
  requiresPrescription: boolean;
  barcode: string | null;
  batches: SnapshotBatch[];
}

const META_KEY = "__meta__";

// Section 6A.9: "POS must bill fully offline against the local cache."
// Called opportunistically while online (e.g. on POS mount) — a full
// refresh, not incremental, which is fine at this catalogue's scale
// (Section 4: "1,500-3,000 SKUs" for a single store) and keeps the sync
// model simple, per Section 12's "optimise for one person maintaining
// it."
export async function refreshPosSnapshot(): Promise<void> {
  const products: SnapshotProduct[] = await api.get("/pos/offline-snapshot");
  await idbClear(STORES.snapshot);
  await idbPutAll(STORES.snapshot, [...products, { id: META_KEY, refreshedAt: new Date().toISOString() }]);
}

export async function getSnapshotMeta(): Promise<{ refreshedAt: string } | null> {
  const meta = await idbGet<{ id: string; refreshedAt: string }>(STORES.snapshot, META_KEY);
  return meta ? { refreshedAt: meta.refreshedAt } : null;
}

export async function getAllSnapshotProducts(): Promise<SnapshotProduct[]> {
  const rows = await idbGetAll<SnapshotProduct & { id: string }>(STORES.snapshot);
  return rows.filter((r) => r.id !== META_KEY);
}

export async function searchSnapshotProducts(query: string): Promise<SnapshotProduct[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = await getAllSnapshotProducts();
  return all
    .filter((p) => p.name.toLowerCase().includes(q) || p.barcode === query.trim())
    .slice(0, 20);
}

export class OfflineInsufficientStockError extends Error {
  constructor(public available: number, public requested: number) {
    super("insufficient_stock_offline");
  }
}

// Mirrors domain/fefo.ts's allocateFefo, against the cached snapshot
// instead of a live query — same FEFO-by-expiry-ascending logic, same
// "the app picks the batch" rule (Section 6A.2). What it deliberately
// doesn't replicate is the near-expiry pick-block-days exclusion: an
// offline pick is always recorded as a manual batch override at sync
// time (see queueOfflineSale below), and Section 6A.2 already lets a
// manual override bypass that same exclusion online — so this isn't a
// new gap, just the existing override rule applying here too.
export function allocateFefoOffline(product: SnapshotProduct, quantityNeeded: number): SnapshotBatch[] {
  const sorted = [...product.batches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const totalAvailable = sorted.reduce((sum, b) => sum + b.quantityBaseUnits, 0);
  if (totalAvailable < quantityNeeded) throw new OfflineInsufficientStockError(totalAvailable, quantityNeeded);

  const allocations: SnapshotBatch[] = [];
  let remaining = quantityNeeded;
  for (const b of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.quantityBaseUnits);
    allocations.push({ ...b, quantityBaseUnits: take });
    remaining -= take;
  }
  return allocations;
}

// Draws the FEFO allocation down against the LOCAL snapshot copy too —
// two offline sales in the same session for the same product must not
// both think the same units are available, even though nothing has
// reached the server yet.
async function deductSnapshotStock(productId: string, allocations: SnapshotBatch[]): Promise<void> {
  const product = await idbGet<SnapshotProduct & { id: string }>(STORES.snapshot, productId);
  if (!product) return;
  for (const alloc of allocations) {
    const batch = product.batches.find((b) => b.batchId === alloc.batchId);
    if (batch) batch.quantityBaseUnits -= alloc.quantityBaseUnits;
  }
  product.batches = product.batches.filter((b) => b.quantityBaseUnits > 0);
  await idbPut(STORES.snapshot, product);
}

// Section 6A.9: "Bill numbers reserved in blocks per device to prevent
// collisions on sync." Pulled from the pool while online, drawn down
// one at a time as offline sales actually happen.
export async function refillBillNumberPool(deviceId: string): Promise<void> {
  const res = await api.post("/bill-numbers/reserve-block", { deviceId });
  const rows = res.numbers.map((number: string) => ({ number, prefix: res.prefix }));
  await idbPutAll(STORES.billNumbers, rows);
}

export async function poolSize(): Promise<number> {
  return (await idbGetAll(STORES.billNumbers)).length;
}

async function drawBillNumber(): Promise<string> {
  const rows = await idbGetAll<{ number: string }>(STORES.billNumbers);
  if (rows.length === 0) throw new Error("no_offline_bill_numbers_reserved");
  const sorted = rows.map((r) => r.number).sort();
  const number = sorted[0]!;
  await idbDelete(STORES.billNumbers, number);
  return number;
}

export interface OfflineSaleLine {
  productId: string;
  productName: string;
  quantityBaseUnits: number;
  mrp: number;
  packSize: number;
  gstRate: number;
  lineDiscountValue: number;
  // Section 6A.6: batch/expiry must print on the bill even offline —
  // one entry per batch this line's quantity was actually split across
  // (Section 6A.2's auto-split), not just the product-level total.
  batches: Array<{ batchNo: string; expiryDate: string; binCode: string; quantityBaseUnits: number }>;
}

export interface QueuedOfflineSale {
  idempotencyKey: string;
  occurredAt: string;
  preAssignedBillNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  lines: Array<{ productId: string; quantityBaseUnits: number; discountPercent: number; discountValue: number | null; manualBatchId: string; manualBatchOverrideReason: string }>;
  billDiscountValue: number;
  roundOff: number;
  tenders: Array<{ tenderType: "cash" | "upi" | "card" | "credit"; amount: number; referenceNumber: string | null }>;
  deviceId: string;
  status: "pending";
  // Display-only fields so the receipt/held view can show something
  // sensible before this has ever reached the server.
  displayLines: OfflineSaleLine[];
  grandTotalEstimate: number;
}

// Section 6A.9: the actual "bill fully offline" step. Allocates FEFO
// against the cached snapshot, deducts it locally so a second offline
// sale in the same session sees the reduced quantity, assigns the next
// pre-reserved bill number, and queues the exact payload /sync/sales
// will later replay — pinning each line to the batch this offline pick
// actually chose (Section 6A.2's manual-override path), so the eventual
// server-side sale can never silently pick a different batch than the
// one already printed on the customer's receipt.
export async function queueOfflineSale(input: {
  customerName: string | null;
  customerPhone: string | null;
  lines: Array<{ productId: string; quantityBaseUnits: number; discountValue: number }>;
  billDiscountValue: number;
  roundOff: number;
  tenders: Array<{ tenderType: "cash" | "upi" | "card" | "credit"; amount: number; referenceNumber: string | null }>;
  deviceId: string;
}): Promise<QueuedOfflineSale> {
  const saleLines: QueuedOfflineSale["lines"] = [];
  const displayLines: OfflineSaleLine[] = [];

  for (const line of input.lines) {
    const product = await idbGet<SnapshotProduct & { id: string }>(STORES.snapshot, line.productId);
    if (!product) throw new Error(`product ${line.productId} not in offline cache`);
    const allocations = allocateFefoOffline(product, line.quantityBaseUnits);
    await deductSnapshotStock(line.productId, allocations);
    // Proportional split across sub-lines when FEFO spans more than one
    // batch — same reasoning as createSale's own shareOfQty split, so a
    // discount never silently disappears on the part of a line that
    // happened to come from a second batch.
    for (const alloc of allocations) {
      const shareOfQty = alloc.quantityBaseUnits / line.quantityBaseUnits;
      saleLines.push({
        productId: line.productId,
        quantityBaseUnits: alloc.quantityBaseUnits,
        discountPercent: 0,
        discountValue: Math.round(line.discountValue * shareOfQty * 100) / 100,
        manualBatchId: alloc.batchId,
        manualBatchOverrideReason: "Offline sale — batch selected against cached stock snapshot (Section 6A.9).",
      });
    }
    displayLines.push({
      productId: line.productId, productName: product.name, quantityBaseUnits: line.quantityBaseUnits,
      mrp: allocations[0]!.mrp, packSize: product.packSize, gstRate: product.gstRate,
      lineDiscountValue: line.discountValue,
      batches: allocations.map((a) => ({ batchNo: a.batchNo, expiryDate: a.expiryDate, binCode: a.binCode, quantityBaseUnits: a.quantityBaseUnits })),
    });
  }

  const billNumber = await drawBillNumber();
  // Mirrors createSale's own convention (repo/sales.ts: gross = mrp/packSize
  // * qty, taxable = gross - discount, GST added on top) — using each
  // line's real cached gstRate, which is actually more accurate than the
  // online screen's own flat 12% *display* estimate (server is always
  // authoritative either way; this is just what prints on the offline
  // receipt in the meantime).
  const taxableTotal = displayLines.reduce((sum, l) => sum + (l.mrp / l.packSize) * l.quantityBaseUnits - l.lineDiscountValue, 0);
  const taxTotal = displayLines.reduce((sum, l) => sum + ((l.mrp / l.packSize) * l.quantityBaseUnits - l.lineDiscountValue) * (l.gstRate / 100), 0);
  const grandTotalEstimate = taxableTotal + taxTotal - input.billDiscountValue + input.roundOff;

  const sale: QueuedOfflineSale = {
    idempotencyKey: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    preAssignedBillNumber: billNumber,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    lines: saleLines,
    billDiscountValue: input.billDiscountValue,
    roundOff: input.roundOff,
    tenders: input.tenders,
    deviceId: input.deviceId,
    status: "pending",
    displayLines,
    grandTotalEstimate: Math.round(grandTotalEstimate * 100) / 100,
  };
  await idbPut(STORES.outbox, sale);
  return sale;
}

export async function listOutbox(): Promise<QueuedOfflineSale[]> {
  return idbGetAll<QueuedOfflineSale>(STORES.outbox);
}

export interface SyncResult {
  syncedCount: number;
  conflictCount: number;
  stillPending: number;
}

// Section 6A.9: "Sync on reconnect, with any conflict escalated to the
// Owner rather than silently resolved." A conflict response means the
// server already wrote a durable sync_conflicts row (routes/sync.ts) —
// this local queue entry is cleared either way, since retrying it
// automatically would just recreate the same conflict, not resolve it.
// Only a genuine network failure leaves an entry queued for next time.
export async function syncOutbox(): Promise<SyncResult> {
  const queued = await listOutbox();
  let syncedCount = 0;
  let conflictCount = 0;
  for (const sale of queued) {
    const { status, displayLines, grandTotalEstimate, ...payload } = sale;
    try {
      await api.post("/sync/sales", payload);
      await idbDelete(STORES.outbox, sale.idempotencyKey);
      syncedCount++;
    } catch (err) {
      if (err instanceof ApiError) {
        // A real server response — either synced-but-conflicted, or some
        // other rejection. Either way the server has seen it; don't keep
        // retrying blindly.
        await idbDelete(STORES.outbox, sale.idempotencyKey);
        conflictCount++;
      } else {
        break; // network failure — stop, leave the rest queued
      }
    }
  }
  const stillPending = (await listOutbox()).length;
  return { syncedCount, conflictCount, stillPending };
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A separate, deliberately simpler print path from lib/receipt.ts's
// buildReceiptHtml — that one renders a real server-confirmed sale
// (hsn_code, print_count, prescriber details, the works); this renders
// a sale that hasn't reached the server yet, from only what's known
// locally. Forcing the two into one shape would either fake fields this
// sale doesn't have yet or silently drop real ones from the online
// receipt — kept apart on purpose.
export function buildOfflineReceiptHtml(sale: QueuedOfflineSale): string {
  const rows = sale.displayLines
    .map((l) => {
      const batchLines = l.batches.map((b) => `Batch ${escapeHtml(b.batchNo)} · Exp ${b.expiryDate.slice(0, 7)} · Rack ${escapeHtml(b.binCode)} · Qty ${b.quantityBaseUnits}`).join("<br>");
      return `
      <tr>
        <td>${escapeHtml(l.productName)}<br><span class="meta">${batchLines}</span></td>
        <td class="num">${l.quantityBaseUnits}</td>
        <td class="num">₹${(l.mrp / l.packSize).toFixed(2)}</td>
      </tr>`;
    })
    .join("");
  const tenderRows = sale.tenders.map((t) => `<div class="row"><span>${t.tenderType.toUpperCase()}</span><span>₹${t.amount.toFixed(2)}</span></div>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(sale.preAssignedBillNumber)}</title>
<style>
  body { font-family: 'Courier New', monospace; width: 300px; margin: 0 auto; padding: 12px; color: #000; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 2px; }
  .center { text-align: center; }
  .meta { font-size: 10px; color: #333; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  td { padding: 3px 2px; border-bottom: 1px dashed #999; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .row { display: flex; justify-content: space-between; font-size: 12px; margin-top: 2px; }
  .total { font-weight: bold; font-size: 14px; border-top: 1px solid #000; margin-top: 6px; padding-top: 4px; }
  .banner { text-align: center; font-weight: bold; border: 1px dashed #000; padding: 4px; margin-bottom: 8px; }
</style></head>
<body onload="window.print()">
  <div class="banner">OFFLINE — QUEUED FOR SYNC</div>
  <h1 class="center">Dipasha Medical Store</h1>
  <p class="center meta">Bill ${escapeHtml(sale.preAssignedBillNumber)} · ${new Date(sale.occurredAt).toLocaleString("en-IN")}</p>
  ${sale.customerName ? `<p class="meta">${escapeHtml(sale.customerName)}${sale.customerPhone ? ` · ${escapeHtml(sale.customerPhone)}` : ""}</p>` : ""}
  <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="row total"><span>Estimated total</span><span>₹${sale.grandTotalEstimate.toFixed(2)}</span></div>
  ${tenderRows}
  <p class="meta center" style="margin-top:8px;">Final GST breakdown will be confirmed once this bill syncs. Keep this receipt.</p>
</body></html>`;
}
