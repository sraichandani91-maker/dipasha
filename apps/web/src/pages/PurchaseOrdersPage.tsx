import { useEffect, useState } from "react";
import { api } from "../api.js";
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
  const [suggestions, setSuggestions] = useState<SuggestedLine[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [selected, setSelected] = useState<Record<string, SelectedLine>>({});
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ poNumber: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [s, v] = await Promise.all([api.get("/purchase-orders/suggestions"), api.get("/vendors")]);
    setSuggestions(s);
    setVendors(v);
    const initial: Record<string, SelectedLine> = {};
    for (const line of s as SuggestedLine[]) {
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
