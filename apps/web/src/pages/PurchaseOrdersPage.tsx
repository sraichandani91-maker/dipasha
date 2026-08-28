import { useEffect, useState } from "react";
import { api, ApiError, downloadFile } from "../api.js";
import SearchBar from "../components/SearchBar.js";

interface SuggestedLine {
  productId: string;
  productName: string;
  suggestedQty: number;
  sourceReasons: string[];
  requesterCount: number;
  requestIds: string[];
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  lastRate: number | null;
  moqRoundedUp: boolean;
}
interface ClearanceCandidate {
  productId: string;
  productName: string;
  nearExpiryStock: number;
  totalSellableStock: number;
}
interface Vendor {
  id: string;
  name: string;
}
interface SelectedLine {
  productId: string;
  productName: string;
  quantityBaseUnits: number;
  sourceReasons: string[];
  requestIds: string[];
}

function ReasonBadges({ line }: { line: SuggestedLine }) {
  return (
    <>
      {line.sourceReasons.includes("low_stock") && <span className="badge badge-info">Low stock</span>}
      {line.sourceReasons.includes("customer_request") && (
        <span className="badge badge-warn">{line.requesterCount} customer{line.requesterCount === 1 ? "" : "s"} waiting</span>
      )}
    </>
  );
}

/**
 * Section 6B.3 — one suggested-lines screen merging low-stock velocity
 * suggestions with open customer requests, plus manual add. A PO ships to
 * exactly one vendor (createPurchaseOrder's own constraint), so the vendor
 * picker at the top scopes what a single "Create PO" click submits.
 */
export default function PurchaseOrdersPage() {
  const [tab, setTab] = useState<"create" | "track">("create");
  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "create" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("create")}>Create PO</button>
        <button className={tab === "track" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("track")}>Track POs</button>
      </div>
      {tab === "create" && <CreatePoTab />}
      {tab === "track" && <TrackPoTab />}
    </div>
  );
}

function CreatePoTab() {
  const [suggestions, setSuggestions] = useState<SuggestedLine[]>([]);
  const [clearanceCandidates, setClearanceCandidates] = useState<ClearanceCandidate[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [selected, setSelected] = useState<Record<string, SelectedLine>>({});
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ poNumber: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [suggestionsRes, v] = await Promise.all([api.get("/purchase-orders/suggestions"), api.get("/vendors")]);
    const s: SuggestedLine[] = suggestionsRes.lines;
    setSuggestions(s);
    setClearanceCandidates(suggestionsRes.clearanceCandidates ?? []);
    setVendors(v);
    const initial: Record<string, SelectedLine> = {};
    for (const line of s) {
      initial[line.productId] = {
        productId: line.productId, productName: line.productName, quantityBaseUnits: line.suggestedQty,
        sourceReasons: line.sourceReasons, requestIds: line.requestIds,
      };
    }
    setSelected(initial);
  }
  useEffect(() => { load(); }, []);

  function toggle(line: SuggestedLine, checked: boolean) {
    setSelected((sel) => {
      const next = { ...sel };
      if (checked) {
        next[line.productId] = { productId: line.productId, productName: line.productName, quantityBaseUnits: line.suggestedQty, sourceReasons: line.sourceReasons, requestIds: line.requestIds };
      } else {
        delete next[line.productId];
      }
      return next;
    });
  }

  function setQty(productId: string, qty: number) {
    setSelected((sel) => (sel[productId] ? { ...sel, [productId]: { ...sel[productId], quantityBaseUnits: qty } } : sel));
  }

  function addManual(p: any) {
    setSelected((sel) => ({ ...sel, [p.id]: { productId: p.id, productName: p.name, quantityBaseUnits: 1, sourceReasons: ["manual"], requestIds: [] } }));
    setShowAddSearch(false);
  }

  const lines = Object.values(selected);

  async function createPo() {
    if (!vendorId || lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/purchase-orders", {
        vendorId,
        lines: lines.map((l) => ({ productId: l.productId, quantityBaseUnits: l.quantityBaseUnits, sourceReasons: l.sourceReasons, requestIds: l.requestIds })),
        deviceId: "web-console",
      });
      setResult(res);
      await load();
    } catch {
      setError("Could not create the purchase order.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Purchase orders</h2>
      <p className="hint-text">
        Section 6B.3 — suggestions merge low sales-velocity stock with open customer requests (only when current
        stock can't already cover what's been asked for). Add anything else manually below.
      </p>

      {result && (
        <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)", marginBottom: 12 }}>
          <p style={{ margin: 0, fontWeight: 700 }}>Purchase order {result.poNumber} created.</p>
        </div>
      )}

      {clearanceCandidates.length > 0 && (
        <div className="card" style={{ marginBottom: 12, background: "color-mix(in srgb, var(--status-warn) 8%, white)" }}>
          <strong>Not reordered — remaining stock is near-expiry</strong>
          <p className="hint-text" style={{ marginTop: 4 }}>
            These would otherwise show as low-stock, but every unit left is close to expiry. Reordering would only add
            more stock behind stock that needs to move first — clear it instead (Expiry audit / discounting), then let
            it resurface here once healthy stock is actually low.
          </p>
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Item</th><th>Near-expiry units</th><th>Total sellable</th></tr></thead>
            <tbody>
              {clearanceCandidates.map((c) => (
                <tr key={c.productId}><td>{c.productName}</td><td>{c.nearExpiryStock}</td><td>{c.totalSellableStock}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="field">
          <label>Vendor for this PO</label>
          <select style={{ width: 320 }} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Select vendor…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <button className="btn-secondary" onClick={() => setShowAddSearch((s) => !s)}>{showAddSearch ? "Hide" : "+ Add item"} search</button>
        {showAddSearch && <div style={{ marginTop: 10 }}><SearchBar context="purchase_entry" onSelect={addManual} /></div>}
      </div>

      <div className="card">
        <table className="data-table">
          <thead><tr><th></th><th>Item</th><th>Why</th><th>Vendor / last rate</th><th>Qty to order</th></tr></thead>
          <tbody>
            {suggestions.map((line) => (
              <tr key={line.productId}>
                <td><input type="checkbox" checked={!!selected[line.productId]} onChange={(e) => toggle(line, e.target.checked)} /></td>
                <td>{line.productName}</td>
                <td><ReasonBadges line={line} /></td>
                <td className="hint-text">{line.suggestedVendorName ?? "—"}{line.lastRate !== null && ` · ₹${line.lastRate}`}</td>
                <td>
                  <input
                    type="number"
                    style={{ width: 80 }}
                    disabled={!selected[line.productId]}
                    value={selected[line.productId]?.quantityBaseUnits ?? line.suggestedQty}
                    onChange={(e) => setQty(line.productId, Number(e.target.value))}
                  />
                  {line.moqRoundedUp && <div className="hint-text" title="Rounded up to the vendor's minimum order pack">Rounded to MOQ</div>}
                </td>
              </tr>
            ))}
            {Object.values(selected).filter((l) => !suggestions.some((s) => s.productId === l.productId)).map((l) => (
              <tr key={l.productId}>
                <td><input type="checkbox" checked readOnly /></td>
                <td>{l.productName}</td>
                <td><span className="badge">Manual</span></td>
                <td className="hint-text">—</td>
                <td><input type="number" style={{ width: 80 }} value={l.quantityBaseUnits} onChange={(e) => setQty(l.productId, Number(e.target.value))} /></td>
              </tr>
            ))}
            {suggestions.length === 0 && Object.keys(selected).length === 0 && (
              <tr><td colSpan={5} className="hint-text">No low-stock or requested items right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <p className="error-text">{error}</p>}
      <button className="btn-primary" style={{ marginTop: 12 }} disabled={busy || !vendorId || lines.length === 0} onClick={createPo}>
        {busy ? "Creating…" : `Create PO — ${lines.length} line${lines.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}

const PO_STATUSES = ["open", "sent", "acknowledged", "partially_received", "received", "cancelled"] as const;

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "received" ? "badge-info" :
    status === "cancelled" ? "" :
    status === "sent" || status === "partially_received" ? "badge-warn" : "badge";
  return <span className={`badge ${cls}`} style={{ textTransform: "capitalize" }}>{status.replace("_", " ")}</span>;
}

/**
 * Section 10B.2 — "order confirmation tracking... send... chase list for
 * POs unacknowledged beyond a configurable window... ordered versus
 * received versus billed, line by line." One list + detail view, same
 * pattern as every other list/detail screen in this build.
 */
function TrackPoTab() {
  const [statusFilter, setStatusFilter] = useState("");
  const [pos, setPos] = useState<any[]>([]);
  const [chaseList, setChaseList] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [list, chase] = await Promise.all([
      api.get(`/purchase-orders${statusFilter ? `?status=${statusFilter}` : ""}`),
      api.get("/purchase-orders/chase-list"),
    ]);
    setPos(list);
    setChaseList(chase);
  }
  useEffect(() => { load(); }, [statusFilter]);

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(await api.get(`/purchase-orders/${id}`));
  }

  async function send(via: "whatsapp" | "email") {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/purchase-orders/${selectedId}/send`, { via });
      await Promise.all([openDetail(selectedId), load()]);
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : null;
      setError(
        code === "vendor_has_no_phone" ? "This vendor has no phone number on file — add one under Accounting → Vendor ledger." :
        code === "vendor_has_no_email" ? "This vendor has no email on file — add one under Accounting → Vendor ledger." :
        "Could not send the PO."
      );
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/purchase-orders/${selectedId}/acknowledge`, {});
      await Promise.all([openDetail(selectedId), load()]);
    } catch {
      setError("Could not mark this PO acknowledged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {chaseList.length > 0 && (
        <div className="card" style={{ marginBottom: 12, background: "color-mix(in srgb, var(--status-warn) 8%, white)" }}>
          <strong>Chase list — sent but not acknowledged past the configured window</strong>
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead><tr><th>PO #</th><th>Vendor</th><th>Sent</th><th>Phone</th></tr></thead>
            <tbody>
              {chaseList.map((p: any) => (
                <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => openDetail(p.id)}>
                  <td>{p.po_number}</td><td>{p.vendor_name}</td>
                  <td>{new Date(p.sent_at).toLocaleDateString("en-IN")}</td>
                  <td>{p.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            {PO_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div className="card" style={{ flex: 1 }}>
          <table className="data-table">
            <thead><tr><th>PO #</th><th>Vendor</th><th>Lines</th><th>Status</th></tr></thead>
            <tbody>
              {pos.map((p: any) => (
                <tr key={p.id} style={{ cursor: "pointer", background: selectedId === p.id ? "color-mix(in srgb, var(--status-good) 10%, white)" : undefined }} onClick={() => openDetail(p.id)}>
                  <td>{p.po_number}</td><td>{p.vendor_name}</td><td>{p.line_count}</td>
                  <td><StatusBadge status={p.status} /></td>
                </tr>
              ))}
              {pos.length === 0 && <tr><td colSpan={4} className="hint-text">No purchase orders.</td></tr>}
            </tbody>
          </table>
        </div>

        {detail && (
          <div className="card" style={{ flex: 1, minWidth: 320 }}>
            <h3 style={{ marginTop: 0 }}>{detail.po_number} — {detail.vendor_name}</h3>
            <p><StatusBadge status={detail.status} /></p>
            {error && <p className="error-text">{error}</p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <button className="btn-secondary" disabled={busy} onClick={() => send("whatsapp")}>Send via WhatsApp</button>
              <button className="btn-secondary" disabled={busy} onClick={() => send("email")}>Send via email</button>
              <button className="btn-secondary" disabled={busy || detail.status === "acknowledged"} onClick={acknowledge}>Mark acknowledged</button>
              <button className="btn-secondary" onClick={() => downloadFile(`/purchase-orders/${detail.id}/export?format=pdf`, `${detail.po_number}.pdf`)}>Export PDF</button>
              <button className="btn-secondary" onClick={() => downloadFile(`/purchase-orders/${detail.id}/export?format=csv`, `${detail.po_number}.csv`)}>Export CSV</button>
            </div>
            <table className="data-table">
              <thead><tr><th>Item</th><th>Ordered</th><th>Received/billed</th><th>Short</th></tr></thead>
              <tbody>
                {detail.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td>{l.product_name}</td>
                    <td>{l.quantity_base_units}</td>
                    <td>{l.quantity_received_base_units}</td>
                    <td className={l.quantity_short > 0 ? "stock-out" : undefined}>{l.quantity_short}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
