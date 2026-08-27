import { useEffect, useState } from "react";
import { api } from "../api.js";
import SearchBar from "../components/SearchBar.js";
import QuantityInput from "../components/QuantityInput.js";

const REASON_CODES = ["free_sample", "scheme_goods", "opening_stock", "replacement_no_invoice", "transfer_in", "found_in_count", "other"];

/**
 * Non-GST inbound (Section 6.4's simpler copy) — same movement ledger,
 * fewer required fields than a GST purchase. No invoice number, no
 * purchase rate; an optional notional value keeps valuation meaningful.
 */
export default function StockReceivedPage() {
  const [tab, setTab] = useState<"new" | "received">("new");
  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "new" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("new")}>+ Received</button>
        <button className={tab === "received" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("received")}>Received log</button>
      </div>
      {tab === "new" && <NewStockReceivedForm />}
      {tab === "received" && <ReceivedLogTab />}
    </div>
  );
}

function ReceivedLogTab() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  function query() {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }
  async function load() {
    setRows(await api.get(`/stock-movements/stock-received?${query()}`));
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12, flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field"><label>Search item / batch</label><input value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 180 }} /></div>
        <button className="btn-primary" onClick={load}>Filter</button>
      </div>
      <table className="data-table">
        <thead><tr><th>Item</th><th>Batch</th><th>Qty</th><th>Reason</th><th>Received</th><th>By</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{r.product_name}</td>
              <td>{r.batch_no}</td>
              <td>{r.quantity_delta}</td>
              <td>{r.reason_code.replace(/_/g, " ")}</td>
              <td>{new Date(r.created_at).toLocaleString("en-IN")}</td>
              <td>{r.created_by_name}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={6} className="hint-text">No entries match these filters.</td></tr>}
        </tbody>
      </table>
      <p className="hint-text" style={{ marginTop: 8 }}>
        A wrong quantity or MRP is correctable from the Inventory screen's batch-correction tools — the same path used
        regardless of how a batch first arrived.
      </p>
    </div>
  );
}

function NewStockReceivedForm() {
  const [product, setProduct] = useState<any>(null);
  const [batchNo, setBatchNo] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [mrp, setMrp] = useState<number | "">("");
  const [quantityBaseUnits, setQuantityBaseUnits] = useState(0);
  const [reasonCode, setReasonCode] = useState(REASON_CODES[0]);
  const [note, setNote] = useState("");
  const [sourceOrVendorName, setSourceOrVendorName] = useState("");
  const [estimatedValue, setEstimatedValue] = useState<number | "">("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post("/stock-movements/stock-received", {
        productId: product.id, batchNo, expiryDate, mrp: Number(mrp), quantityBaseUnits,
        reasonCode, note, sourceOrVendorName: sourceOrVendorName || null,
        estimatedValue: estimatedValue === "" ? null : Number(estimatedValue),
        deviceId: "web-console",
      });
      setResult("Received — a put-away task has been created.");
      setProduct(null); setBatchNo(""); setExpiryDate(""); setMrp(""); setQuantityBaseUnits(0);
      setNote(""); setSourceOrVendorName(""); setEstimatedValue("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Stock received (non-GST)</h2>
      <p className="hint-text">Sample, scheme goods, opening stock, transfer in — anything arriving without a vendor tax invoice.</p>

      {result && <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)", marginBottom: 16 }}>{result}</div>}

      <div className="card">
        {!product ? (
          <SearchBar context="app_lookup" onSelect={setProduct} autoFocus />
        ) : (
          <div style={{ marginBottom: 12 }}>
            <strong>{product.name}</strong> ({product.manufacturer}) <button className="btn-secondary" onClick={() => setProduct(null)} style={{ marginLeft: 8 }}>Change</button>
          </div>
        )}

        {product && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="field"><label>Batch no.</label><input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} /></div>
            <div className="field"><label>Expiry date</label><input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></div>
            <div className="field"><label>MRP (per pack)</label><input type="number" style={{ width: 90 }} value={mrp} onChange={(e) => setMrp(e.target.value === "" ? "" : Number(e.target.value))} /></div>
            <div>
              <label>Quantity</label>
              <QuantityInput packSize={product.packSize} baseUnitLabel={product.baseUnit} packLabel="Strips" onChange={setQuantityBaseUnits} />
            </div>
            <div className="field">
              <label>Reason code</label>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                {REASON_CODES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 200 }}><label>Note (required)</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
            <div className="field"><label>Source / vendor (optional)</label><input value={sourceOrVendorName} onChange={(e) => setSourceOrVendorName(e.target.value)} /></div>
            <div className="field"><label>Estimated value ₹ (optional)</label><input type="number" style={{ width: 100 }} value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value === "" ? "" : Number(e.target.value))} /></div>
          </div>
        )}

        {product && (
          <button
            className="btn-primary"
            style={{ marginTop: 16 }}
            disabled={busy || !batchNo || !expiryDate || !mrp || quantityBaseUnits <= 0 || !note}
            onClick={submit}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        )}
        {!estimatedValue && product && (
          <p className="hint-text" style={{ marginTop: 8 }}>No estimated value entered — this batch's cost will show as unknown (dash, never zero) until it's genuinely known.</p>
        )}
      </div>
    </div>
  );
}
