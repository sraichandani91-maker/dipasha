import { useEffect, useState } from "react";
import { api, apiPdfUrl, ApiError, getTokens, postForm } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import SearchBar from "../components/SearchBar.js";
import QuantityInput from "../components/QuantityInput.js";

const REASON_CODES = ["damaged_in_store", "damaged_in_transit", "expired", "spillage_breakage", "recalled", "other"] as const;

interface WriteOff {
  id: string;
  product_name: string;
  batch_no: string;
  bin_code: string;
  quantity_base_units: number;
  reason_code: string;
  note: string;
  photo_path: string | null;
  estimated_value: string;
  status: "pending" | "approved" | "rejected";
  requires_approval: boolean;
  requested_by_name: string;
  approved_by_name: string | null;
  rejection_reason: string | null;
  created_at: string;
}

/**
 * Section 9, 9A.8 — damage/write-off log with photo evidence. Below the
 * approval threshold, submitting IS the write-off (stock drops
 * immediately); above it, it queues for Owner approval and stock stays
 * untouched until then.
 */
export default function WriteOffsPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [writeOffs, setWriteOffs] = useState<WriteOff[]>([]);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setWriteOffs(await api.get("/write-offs"));
  }
  useEffect(() => { load(); }, []);

  const pending = writeOffs.filter((w) => w.status === "pending");
  const others = writeOffs.filter((w) => w.status !== "pending");

  async function approve(id: string) {
    await api.post(`/write-offs/${id}/approve`);
    await load();
  }
  async function reject(id: string) {
    const reason = window.prompt("Reason for rejecting this write-off?");
    if (!reason) return;
    await api.post(`/write-offs/${id}/reject`, { rejectionReason: reason });
    await load();
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ marginTop: 0 }}>Damage / write-off log</h2>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ Log damage / write-off</button>
      </div>
      <p className="hint-text">Section 9, 9A.8 — photo evidence, and Owner approval above the value threshold.</p>

      {pending.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3>Pending approval ({pending.length})</h3>
          {pending.map((w) => (
            <div key={w.id} className="card" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{w.product_name}</strong> · {w.quantity_base_units} units · ₹{Number(w.estimated_value).toFixed(2)}
                <div className="hint-text">Batch {w.batch_no} · {w.bin_code} · {w.reason_code.replace(/_/g, " ")} · requested by {w.requested_by_name}</div>
                <div className="hint-text">{w.note}</div>
                {w.photo_path && <PhotoThumb photoPath={w.photo_path} />}
              </div>
              {isOwner && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn-secondary" onClick={() => reject(w.id)}>Reject</button>
                  <button className="btn-primary" onClick={() => approve(w.id)}>Approve</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <h3>History</h3>
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Date</th><th>Item</th><th>Qty</th><th>Value</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>
              {others.map((w) => (
                <tr key={w.id}>
                  <td>{new Date(w.created_at).toLocaleDateString("en-IN")}</td>
                  <td>{w.product_name} <span className="hint-text">({w.batch_no})</span></td>
                  <td>{w.quantity_base_units}</td>
                  <td>₹{Number(w.estimated_value).toFixed(2)}</td>
                  <td>{w.reason_code.replace(/_/g, " ")}</td>
                  <td>
                    <span className={`badge ${w.status === "approved" ? "badge-good" : "badge-bad"}`}>{w.status}</span>
                    {w.rejection_reason && <div className="hint-text">{w.rejection_reason}</div>}
                  </td>
                </tr>
              ))}
              {others.length === 0 && <tr><td colSpan={6} className="hint-text">No history yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && <NewWriteOffModal onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load(); }} />}
    </div>
  );
}

function PhotoThumb({ photoPath }: { photoPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const { accessToken } = getTokens();
    fetch(apiPdfUrl(`/uploads/${photoPath}`), { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} })
      .then((r) => r.blob())
      .then((b) => setUrl(URL.createObjectURL(b)));
  }, [photoPath]);
  if (!url) return null;
  return <img src={url} alt="Write-off evidence" style={{ maxWidth: 120, marginTop: 6, borderRadius: 4, border: "1px solid var(--border)" }} />;
}

function NewWriteOffModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const [locations, setLocations] = useState<any[] | null>(null);
  const [location, setLocation] = useState<any | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [reasonCode, setReasonCode] = useState<typeof REASON_CODES[number]>("damaged_in_store");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickProduct(p: any) {
    setProduct({ id: p.id, name: p.name });
    setLocation(null);
    setLocations(await api.get(`/products/${p.id}/stock-locations`));
  }

  const mrpPerBaseUnit = location ? Number(location.mrp ?? 0) / (location.pack_size || 1) : 0;
  const estimatedValue = quantity * mrpPerBaseUnit;

  async function submit() {
    if (!product || !location || quantity <= 0 || !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("productId", product.id);
      form.set("batchId", location.batch_id);
      form.set("binId", location.bin_id);
      form.set("quantityBaseUnits", String(quantity));
      form.set("reasonCode", reasonCode);
      form.set("note", note);
      form.set("estimatedValue", String(estimatedValue || 1));
      form.set("deviceId", "web-console");
      if (photo) form.set("photo", photo);
      await postForm("/write-offs", form);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "insufficient_stock") {
        setError("Not enough stock in that bin — recheck the quantity.");
      } else {
        setError(err instanceof ApiError ? "Could not log the write-off." : "Network error.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 480, maxHeight: "90vh", overflowY: "auto", background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Log damage / write-off</h3>

        <div className="field">
          <label>Item</label>
          {product ? (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>{product.name}</strong>
              <button className="btn-secondary" onClick={() => { setProduct(null); setLocations(null); }}>Change</button>
            </div>
          ) : (
            <SearchBar context="app_lookup" onSelect={pickProduct} />
          )}
        </div>

        {locations && (
          <div className="field">
            <label>Which batch / bin</label>
            <select value={location ? `${location.batch_id}|${location.bin_id}` : ""} onChange={(e) => setLocation(locations.find((l) => `${l.batch_id}|${l.bin_id}` === e.target.value))}>
              <option value="">Select…</option>
              {locations.map((l) => (
                <option key={`${l.batch_id}|${l.bin_id}`} value={`${l.batch_id}|${l.bin_id}`}>
                  {l.batch_no} · {l.bin_code} · {l.quantity_base_units} in stock
                </option>
              ))}
            </select>
            {locations.length === 0 && <p className="hint-text">No stock found for this product.</p>}
          </div>
        )}

        {location && (
          <div className="field">
            <label>Quantity damaged (max {location.quantity_base_units} in stock here)</label>
            <QuantityInput packSize={location.pack_size} baseUnitLabel={location.base_unit} packLabel="Strips" onChange={setQuantity} />
          </div>
        )}

        <div className="field">
          <label>Reason</label>
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as any)}>
            {REASON_CODES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div className="field"><label>Note (required)</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="field">
          <label>Photo evidence (optional)</label>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </div>

        {location && <p className="hint-text">Estimated value: ₹{estimatedValue.toFixed(2)} (at MRP)</p>}
        {error && <p className="error-text">{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!product || !location || quantity <= 0 || !note.trim() || busy} onClick={submit}>
            {busy ? "Submitting…" : "Log write-off"}
          </button>
        </div>
      </div>
    </div>
  );
}
