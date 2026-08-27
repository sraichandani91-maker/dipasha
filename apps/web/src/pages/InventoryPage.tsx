import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import SearchBar from "../components/SearchBar.js";

const CORRECTION_REASONS = [
  { value: "physical_recount", label: "Physical recount" },
  { value: "data_entry_correction", label: "Data entry correction" },
  { value: "damage_pending_writeoff", label: "Damage pending write-off" },
  { value: "system_error", label: "System error" },
  { value: "other", label: "Other" },
] as const;

function ReasonNoteFields({ reasonCode, setReasonCode, note, setNote }: { reasonCode: string; setReasonCode: (v: string) => void; note: string; setNote: (v: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} style={{ width: 190 }}>
        <option value="">Reason…</option>
        {CORRECTION_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <input placeholder="Note (required)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 220 }} />
    </div>
  );
}

type Tab = "stock" | "move" | "bulk";

/**
 * Section 10.2 "Inventory" — full stock view with filters, quantity/
 * batch/expiry/MRP correction (always a reason + an audit row, never a
 * silent overwrite), block/unblock a batch, move stock between bins
 * (creates a put-away task, same as this milestone's bin-to-bin
 * migration deferred from M11), and bulk CSV import with a mandatory
 * preview-and-confirm diff.
 */
export default function InventoryPage() {
  const [tab, setTab] = useState<Tab>("stock");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Inventory</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {([["stock", "Stock view"], ["move", "Move stock"], ["bulk", "Bulk import"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "stock" && <StockTab />}
      {tab === "move" && <MoveStockTab />}
      {tab === "bulk" && <BulkImportTab />}
    </div>
  );
}

function StockTab() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [filters, setFilters] = useState({ search: "", batchNo: "", scheduleCategory: "", zone: "", expiryFrom: "", expiryTo: "" });
  const [editing, setEditing] = useState<any | null>(null);

  async function load() {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    setRows(await api.get(`/inventory/stock?${params.toString()}`));
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field"><label>Product</label><input value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} /></div>
        <div className="field"><label>Batch</label><input value={filters.batchNo} onChange={(e) => setFilters((f) => ({ ...f, batchNo: e.target.value }))} /></div>
        <div className="field">
          <label>Schedule</label>
          <select value={filters.scheduleCategory} onChange={(e) => setFilters((f) => ({ ...f, scheduleCategory: e.target.value }))}>
            <option value="">Any</option>
            {["OTC", "H", "H1", "X", "Ayurvedic", "Cosmetic", "Device"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field"><label>Zone</label><input value={filters.zone} onChange={(e) => setFilters((f) => ({ ...f, zone: e.target.value }))} style={{ width: 70 }} /></div>
        <div className="field"><label>Expiry from</label><input type="date" value={filters.expiryFrom} onChange={(e) => setFilters((f) => ({ ...f, expiryFrom: e.target.value }))} /></div>
        <div className="field"><label>Expiry to</label><input type="date" value={filters.expiryTo} onChange={(e) => setFilters((f) => ({ ...f, expiryTo: e.target.value }))} /></div>
        <button className="btn-primary" onClick={load}>Filter</button>
      </div>
      <table className="data-table">
        <thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th>Bin</th><th>Qty</th><th>MRP</th><th>Value</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows?.map((r, i) => (
            <tr key={i}>
              <td>{r.product_name}</td>
              <td>{r.batch_no}</td>
              <td>{new Date(r.expiry_date).toLocaleDateString("en-IN")}</td>
              <td>{r.bin_code}</td>
              <td>{r.quantity_base_units}</td>
              <td>₹{r.mrp}</td>
              <td>₹{r.value}</td>
              <td>{r.blocked ? <span className="badge badge-warn">Blocked</span> : "—"}</td>
              <td><button className="btn-secondary" onClick={() => setEditing(r)}>Edit</button></td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={9} className="hint-text">No stock matches these filters.</td></tr>}
        </tbody>
      </table>
      {editing && <EditStockModal row={editing} onClose={() => setEditing(null)} onChanged={load} />}
    </div>
  );
}

function EditStockModal({ row, onClose, onChanged }: { row: any; onClose: () => void; onChanged: () => void }) {
  const [action, setAction] = useState<"qty" | "batch_no" | "expiry_date" | "mrp" | "block" | "unblock">("qty");
  const [value, setValue] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (action === "unblock") {
        await api.post(`/inventory/batches/${row.batch_id}/unblock`, {});
      } else if (action === "block") {
        if (!reasonCode || !note) throw new Error("missing");
        await api.post(`/inventory/batches/${row.batch_id}/block`, { reasonCode, note });
      } else if (action === "qty") {
        if (!reasonCode || !note || value === "") throw new Error("missing");
        await api.post("/inventory/stock/adjust", {
          productId: row.product_id, batchId: row.batch_id, binId: row.bin_id,
          newQuantityBaseUnits: Number(value), reasonCode, note, deviceId: "web-console",
        });
      } else {
        if (!reasonCode || !note || !value) throw new Error("missing");
        await api.post(`/inventory/batches/${row.batch_id}/correct`, { field: action, newValue: value, reasonCode, note, deviceId: "web-console" });
      }
      onChanged();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setError(err.body?.error ?? "Could not apply the change.");
      else setError("Fill in a reason, note, and value first.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 460, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>{row.product_name} — {row.batch_no} @ {row.bin_code}</h3>
        {error && <p className="error-text">{error}</p>}
        <div className="field">
          <label>Action</label>
          <select value={action} onChange={(e) => { setAction(e.target.value as any); setValue(""); }}>
            <option value="qty">Correct quantity (currently {row.quantity_base_units})</option>
            <option value="batch_no">Correct batch number (currently {row.batch_no})</option>
            <option value="expiry_date">Correct expiry date (currently {new Date(row.expiry_date).toISOString().slice(0, 10)})</option>
            <option value="mrp">Correct MRP (currently ₹{row.mrp})</option>
            {!row.blocked && <option value="block">Block from picking</option>}
            {row.blocked && <option value="unblock">Unblock</option>}
          </select>
        </div>
        {action === "qty" && <div className="field"><label>New quantity (base units)</label><input type="number" value={value} onChange={(e) => setValue(e.target.value)} /></div>}
        {action === "batch_no" && <div className="field"><label>New batch number</label><input value={value} onChange={(e) => setValue(e.target.value)} /></div>}
        {action === "expiry_date" && <div className="field"><label>New expiry date</label><input type="date" value={value} onChange={(e) => setValue(e.target.value)} /></div>}
        {action === "mrp" && <div className="field"><label>New MRP</label><input type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} /></div>}
        {action !== "unblock" && <ReasonNoteFields reasonCode={reasonCode} setReasonCode={setReasonCode} note={note} setNote={setNote} />}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn-primary" disabled={busy} onClick={submit}>Apply</button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function MoveStockTab() {
  const [product, setProduct] = useState<any | null>(null);
  const [locations, setLocations] = useState<any[]>([]);
  const [location, setLocation] = useState<any | null>(null);
  const [bins, setBins] = useState<any[]>([]);
  const [destinationBinId, setDestinationBinId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get("/bins?status=active").then(setBins); }, []);

  async function pickProduct(p: any) {
    setProduct(p);
    setLocation(null);
    setLocations(await api.get(`/products/${p.id}/stock-locations`));
  }

  async function submit() {
    if (!product || !location || !destinationBinId || Number(quantity) <= 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.post("/inventory/move-stock", {
        productId: product.id,
        batchId: location.batch_id,
        sourceBinId: location.bin_id,
        destinationBinId,
        quantityBaseUnits: Number(quantity),
      });
      setMessage("Move task created — a floor staffer confirms it on the Put-away screen (never silently moved).");
      setQuantity("");
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not create the move task.") : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <p className="hint-text">
        Section 10.2: moving stock between bins creates a put-away task for floor staff to physically execute and confirm — it never
        silently moves the record. This is also where the earlier bin-to-bin migration request lands.
      </p>
      {message && <p>{message}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="field">
        <label>Product</label>
        {product ? (
          <div>{product.name} <button className="btn-secondary" onClick={() => { setProduct(null); setLocation(null); }}>Change</button></div>
        ) : (
          <SearchBar context="app_lookup" onSelect={pickProduct} />
        )}
      </div>
      {locations.length > 0 && (
        <div className="field">
          <label>Current location</label>
          <select value={location?.batch_id ?? ""} onChange={(e) => setLocation(locations.find((l) => l.batch_id === e.target.value) ?? null)}>
            <option value="">Choose a batch/bin…</option>
            {locations.map((l) => <option key={l.batch_id + l.bin_id} value={l.batch_id}>{l.batch_no} @ {l.bin_code} — {l.quantity_base_units} available</option>)}
          </select>
        </div>
      )}
      {location && (
        <>
          <div className="field">
            <label>Quantity to move (base units, max {location.quantity_base_units})</label>
            <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="field">
            <label>Destination bin</label>
            <select value={destinationBinId} onChange={(e) => setDestinationBinId(e.target.value)}>
              <option value="">Choose a bin…</option>
              {bins.filter((b) => b.id !== location.bin_id).map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
            </select>
          </div>
          <button className="btn-primary" disabled={busy || !destinationBinId || !quantity} onClick={submit}>Create move task</button>
        </>
      )}
    </div>
  );
}

interface BulkKind {
  key: "stock-adjustment" | "bin-reassignment" | "price-update";
  label: string;
  columns: string;
  needsReason: boolean;
}
const BULK_KINDS: BulkKind[] = [
  { key: "stock-adjustment", label: "Stock adjustment", columns: "product,batch_no,bin_code,new_quantity", needsReason: true },
  { key: "bin-reassignment", label: "Bulk bin reassignment", columns: "product,batch_no,from_bin_code,to_bin_code,quantity", needsReason: false },
  { key: "price-update", label: "Bulk price update", columns: "product,batch_no,new_mrp", needsReason: true },
];

function BulkImportTab() {
  const [kind, setKind] = useState<BulkKind>(BULK_KINDS[0]!);
  const [csv, setCsv] = useState(kind.columns + "\n");
  const [diff, setDiff] = useState<any[] | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function selectKind(k: BulkKind) {
    setKind(k);
    setCsv(k.columns + "\n");
    setDiff(null);
    setResult(null);
    setError(null);
  }

  async function preview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setDiff(await api.post(`/inventory/bulk/${kind.key}/preview`, { csv }));
    } catch {
      setError("Could not parse this CSV.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (kind.needsReason && (!reasonCode || !note)) { setError("Reason and note are required before committing."); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/inventory/bulk/${kind.key}/commit`, { csv, reasonCode: reasonCode || undefined, note: note || undefined, deviceId: "web-console" });
      setResult(kind.key === "bin-reassignment" ? `${res.applied} move task(s) created, ${res.skipped} skipped.` : `${res.applied} row(s) applied, ${res.skipped} skipped.`);
      setDiff(null);
    } catch {
      setError("Could not commit this import.");
    } finally {
      setBusy(false);
    }
  }

  const okCount = diff?.filter((d) => d.ok).length ?? 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {BULK_KINDS.map((k) => (
          <button key={k.key} className={kind.key === k.key ? "btn-primary" : "btn-secondary"} onClick={() => selectKind(k)}>{k.label}</button>
        ))}
      </div>
      <p className="hint-text">
        Every bulk change goes through a mandatory preview-and-confirm diff (Section 10.2) — nothing is written until you review the
        rows below and click Commit. Header row: <code>{kind.columns}</code>. Plain CSV only — no quoted fields, no embedded commas.
      </p>
      <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setDiff(null); }} rows={8} style={{ width: "100%", fontFamily: "monospace" }} />
      {kind.needsReason && <div style={{ marginTop: 8 }}><ReasonNoteFields reasonCode={reasonCode} setReasonCode={setReasonCode} note={note} setNote={setNote} /></div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn-secondary" disabled={busy} onClick={preview}>Preview</button>
        <button className="btn-primary" disabled={busy || !diff || okCount === 0} onClick={commit}>Commit {diff ? `(${okCount} row${okCount === 1 ? "" : "s"})` : ""}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {result && <p>{result}</p>}
      {diff && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Row</th><th>Product</th><th>Batch</th><th>From</th><th>To</th><th>Status</th></tr></thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.rowNumber} style={{ background: d.ok ? undefined : "color-mix(in srgb, var(--status-warn) 10%, white)" }}>
                <td>{d.rowNumber}</td>
                <td>{d.productName}</td>
                <td>{d.batchNo}</td>
                <td>{String(d.from ?? "—")}</td>
                <td>{String(d.to ?? "—")}</td>
                <td>{d.ok ? "Will apply" : d.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
