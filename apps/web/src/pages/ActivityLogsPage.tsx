import { useEffect, useState } from "react";
import { api } from "../api.js";
import { buildReceiptHtml, buildPurchaseInvoiceHtml } from "../lib/receipt.js";
import ItemHistoryModal from "../components/ItemHistoryModal.js";

const CATEGORY_LABELS: Record<string, string> = {
  sale_generated: "Sale generated",
  sale_cancelled: "Sale cancelled",
  sale_credit_note: "Sale credited / returned",
  purchase_created: "Purchase recorded",
  purchase_corrected: "Purchase corrected",
  vendor_debit_note: "Vendor debit note",
  batch_corrected: "Batch / price corrected",
  product_group_changed: "Substitute group changed",
  stock_transfer: "Stock moved (bin transfer)",
  stock_movement: "Stock quantity changed",
  cycle_count_completed: "Cycle count completed",
};

const STOCK_MOVEMENT_LABELS: Record<string, string> = {
  write_off: "write-off",
  adjustment: "adjustment",
  purchase_return: "return to vendor",
  stock_received: "non-GST receipt",
  stock_issue: "non-GST issue",
};

function readable(s: string | null | undefined): string {
  return s ? s.replace(/_/g, " ") : "";
}

function money(v: unknown): string {
  return `₹${Number(v).toFixed(2)}`;
}

// Turns one structured activity event into the plain-English sentence
// the owner actually reads — "bill generated," "price changed from X to
// Y," "quantity reduced by N" — never a raw table name or an HTTP path.
function describeEvent(category: string, d: Record<string, any>): string {
  switch (category) {
    case "sale_generated":
      return `Generated bill ${d.billNumber} — ${money(d.grandTotal)}${d.customerName ? ` for ${d.customerName}` : ""}`;
    case "sale_cancelled":
      return `Cancelled bill ${d.billNumber} — ${money(d.grandTotal)} (${d.reason ?? "no reason given"})`;
    case "sale_credit_note":
      return `Issued credit note ${d.creditNoteNumber} against bill ${d.billNumber} — ${money(d.refundValue)} refunded (${d.reason})`;
    case "purchase_created":
      return `Recorded purchase invoice ${d.invoiceNumber} from ${d.vendorName} — ${money(d.netPayable)}`;
    case "purchase_corrected":
      return `Corrected ${readable(d.field)} on invoice ${d.invoiceNumber}: "${d.oldValue}" → "${d.newValue}" (${readable(d.reasonCode)})`;
    case "vendor_debit_note":
      return `Recorded debit note ${d.debitNoteNumber} against ${d.vendorName} — ${money(d.totalValue)} (${readable(d.reasonCode)})`;
    case "batch_corrected":
      return `Changed ${readable(d.field)} of ${d.productName} (batch ${d.batchNo}): "${d.oldValue}" → "${d.newValue}" (${readable(d.reasonCode)})`;
    case "product_group_changed":
      return `Changed the substitute group for ${d.productName} (${d.note})`;
    case "stock_transfer":
      return `Moved ${d.quantity} unit(s) of ${d.productName} from ${d.fromBin} to ${d.toBin}`;
    case "stock_movement": {
      const qty = Number(d.quantityDelta);
      const verb = qty > 0 ? "Increased" : "Decreased";
      const label = STOCK_MOVEMENT_LABELS[d.movementType] ?? readable(d.movementType);
      return `${verb} stock of ${d.productName} in ${d.binCode} by ${Math.abs(qty)} unit(s) — ${label}${d.reasonCode ? ` (${readable(d.reasonCode)})` : ""}`;
    }
    case "cycle_count_completed":
      return `Completed cycle count for bin ${d.binCode}${d.totalVarianceValue != null ? ` — variance ${money(d.totalVarianceValue)}` : ""}`;
    default:
      return category;
  }
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 6);
  return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

/**
 * Owner-requested, in "the best designer mode" as put to us directly:
 * a single, plain-English feed of every meaningful change across sales,
 * purchases, and stock — who did it, when, and (for corrections) what
 * changed from what to what — so the owner can actually catch and act on
 * a specific staff member's actions. Reads `GET /activity-feed`, which
 * assembles this from the real domain audit trails (movement ledger,
 * batch/purchase-invoice corrections, credit notes, cycle counts), not
 * the bare HTTP-call log Staff's own "Activity log" tab shows — that one
 * still exists for "who hit which endpoint," this one is "what actually
 * happened." Owner-only, same bar as that screen.
 */
export default function ActivityLogsPage() {
  const [range, setRange] = useState(defaultRange());
  const [category, setCategory] = useState("");
  const [userId, setUserId] = useState("");
  const [users, setUsers] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);
  const LIMIT = 100;

  useEffect(() => { api.get("/users").then(setUsers); }, []);

  async function load(nextOffset = 0) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, limit: String(LIMIT), offset: String(nextOffset) });
      if (category) params.set("category", category);
      if (userId) params.set("userId", userId);
      const res = await api.get(`/activity-feed?${params.toString()}`);
      if (nextOffset === 0) setEvents(res.events);
      else setEvents((prev) => [...prev, ...res.events]);
      setTotal(res.total);
      setOffset(nextOffset);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function openSale(id: string) {
    setOpeningId(id);
    try {
      const detail = await api.get(`/sales/${id}`);
      const w = window.open("", "_blank", "width=380,height=600");
      if (!w) return;
      w.document.write(buildReceiptHtml(detail));
      w.document.close();
    } finally {
      setOpeningId(null);
    }
  }

  async function openPurchase(id: string) {
    setOpeningId(id);
    try {
      const detail = await api.get(`/purchase-invoices/${id}`);
      const w = window.open("", "_blank", "width=760,height=800");
      if (!w) return;
      w.document.write(buildPurchaseInvoiceHtml(detail));
      w.document.close();
    } finally {
      setOpeningId(null);
    }
  }

  function openRow(e: any) {
    if (e.referenceType === "sale" && e.referenceId) return openSale(e.referenceId);
    if (e.referenceType === "purchase_invoice" && e.referenceId) return openPurchase(e.referenceId);
    if (e.referenceType === "product" && e.referenceId) return setHistoryTarget({ id: e.referenceId, name: e.details.productName ?? "Item" });
  }

  const isOpenable = (e: any) => (e.referenceType === "sale" || e.referenceType === "purchase_invoice" || e.referenceType === "product") && e.referenceId;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Activity logs</h2>
      <p className="hint-text">
        Every bill generated, credited, or cancelled; every purchase recorded or corrected; every stock quantity or
        price change; every cycle count completed — with who did it and when. Click a row to open the real bill,
        purchase invoice, or item history behind it.
      </p>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">All</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Staff member</label>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">All</option>
            {users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <button className="btn-primary" onClick={() => load(0)}>Run</button>
      </div>

      {loading && events.length === 0 && <p className="hint-text">Loading…</p>}
      {!loading && events.length === 0 && <p className="hint-text">No activity in this range.</p>}

      {events.length > 0 && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>When</th><th>Staff</th><th>Role</th><th>What happened</th></tr></thead>
            <tbody>
              {events.map((e: any, i: number) => (
                <tr
                  key={i}
                  style={{ cursor: isOpenable(e) ? "pointer" : "default", opacity: openingId === e.referenceId ? 0.5 : 1 }}
                  onClick={() => isOpenable(e) && openRow(e)}
                >
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(e.occurredAt).toLocaleString("en-IN")}</td>
                  <td>{e.actorName}</td>
                  <td style={{ textTransform: "capitalize" }}>{readable(e.actorRole)}</td>
                  <td>{describeEvent(e.category, e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
            <p className="hint-text" style={{ margin: 0 }}>{events.length} of {total} events shown.</p>
            {events.length < total && (
              <button className="btn-secondary" disabled={loading} onClick={() => load(offset + LIMIT)}>
                {loading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </div>
      )}

      {historyTarget && <ItemHistoryModal productId={historyTarget.id} productName={historyTarget.name} onClose={() => setHistoryTarget(null)} />}
    </div>
  );
}
