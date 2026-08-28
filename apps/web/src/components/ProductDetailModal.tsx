import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import SaltAutocomplete from "./SaltAutocomplete.js";

interface ProductDetail {
  id: string;
  name: string;
  manufacturer: string;
  form: string;
  scheduleCategory: string;
  requiresPrescription: boolean;
  hsnCode: string;
  gstRate: number;
  baseUnit: string;
  packSize: number;
  outerPackSize: number | null;
  allowLooseSale: boolean;
  looseSaleMarkupPercent: number;
  isColdChain: boolean;
  barcode: string | null;
  substituteGroupId: string | null;
  status: string;
  compositions: Array<{ saltId: string; saltName: string; strength: string }>;
}

interface StockLocation {
  bin_id: string;
  bin_code: string;
  batch_no: string;
  expiry_date: string;
  quantity_base_units: number;
  blocked: boolean;
}

interface CompositionRow {
  saltName: string;
  strength: string;
}

type EditForm = Omit<ProductDetail, "id" | "compositions" | "substituteGroupId"> & { compositions: CompositionRow[] };

function toEditForm(d: ProductDetail): EditForm {
  const { id, compositions, substituteGroupId, ...rest } = d;
  return { ...rest, compositions: compositions.map((c) => ({ saltName: c.saltName, strength: c.strength })) };
}

/**
 * Section 5B's F3 item-details lookup (owner-requested) — press F3 on a
 * medicine while searching, or click "Details" on a result, to see every
 * field the product master carries (pack size, composition, strip-to-
 * base-unit conversion, GST, rack locations) and, for Owner/store_manager,
 * edit and save all of it in place. Rack locations are shown read-only —
 * they come from `stock`, not `products`, and are moved via the Inventory
 * screen's Move-stock action (M13.3), not re-implemented here.
 */
export default function ProductDetailModal({
  productId,
  canEdit,
  onClose,
}: {
  productId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [locations, setLocations] = useState<StockLocation[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [d, l] = await Promise.all([
      api.get(`/products/${productId}`),
      api.get(`/products/${productId}/stock-locations`),
    ]);
    setDetail(d);
    setLocations(l);
  }
  useEffect(() => { load(); }, [productId]);

  function startEdit() {
    if (!detail) return;
    setForm(toEditForm(detail));
    setEditing(true);
    setError(null);
  }

  function updateComposition(i: number, patch: Partial<CompositionRow>) {
    setForm((f) => (f ? { ...f, compositions: f.compositions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) } : f));
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/products/${productId}`, {
        ...form,
        compositions: form.compositions.filter((c) => c.saltName.trim() && c.strength.trim()).map((c) => ({ saltName: c.saltName, strength: c.strength })),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not save changes.") : "Could not save changes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }} onClick={onClose}>
      <div className="card" style={{ width: 560, maxHeight: "88vh", overflowY: "auto", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 style={{ marginTop: 0 }}>{detail ? detail.name : "Item details"}</h3>
          <div style={{ display: "flex", gap: 8 }}>
            {canEdit && detail && !editing && <button className="btn-secondary" onClick={startEdit}>Edit</button>}
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>

        {!detail && <p className="hint-text">Loading…</p>}
        {error && <p className="error-text">{error}</p>}

        {detail && !editing && (
          <div>
            <table className="data-table">
              <tbody>
                <tr><td>Manufacturer</td><td>{detail.manufacturer}</td></tr>
                <tr><td>Form</td><td>{detail.form}</td></tr>
                <tr><td>Schedule</td><td>{detail.scheduleCategory}{detail.requiresPrescription && " (Rx required)"}</td></tr>
                <tr><td>Composition</td><td>{detail.compositions.map((c) => `${c.saltName} ${c.strength}`).join(" + ") || "—"}</td></tr>
                <tr><td>Pack size / conversion</td><td>1 strip = {detail.packSize} {detail.baseUnit}{detail.packSize === 1 ? "" : "s"}{detail.outerPackSize ? ` · 1 box = ${detail.outerPackSize} strips` : ""}</td></tr>
                <tr><td>Loose sale</td><td>{detail.allowLooseSale ? `Allowed (markup ${detail.looseSaleMarkupPercent}%)` : "Not allowed"}</td></tr>
                <tr><td>HSN code</td><td>{detail.hsnCode}</td></tr>
                <tr><td>GST rate</td><td>{detail.gstRate}%</td></tr>
                <tr><td>Cold chain</td><td>{detail.isColdChain ? "Yes" : "No"}</td></tr>
                <tr><td>Barcode</td><td>{detail.barcode ?? "—"}</td></tr>
                <tr><td>Status</td><td>{detail.status}</td></tr>
              </tbody>
            </table>

            <h4 style={{ marginBottom: 4 }}>Rack locations</h4>
            {locations === null && <p className="hint-text">Loading…</p>}
            {locations && locations.length === 0 && <p className="hint-text" style={{ marginTop: 0 }}>No stock currently in any bin.</p>}
            {locations && locations.length > 0 && (
              <table className="data-table">
                <thead><tr><th>Rack</th><th>Batch</th><th>Expiry</th><th>Qty</th></tr></thead>
                <tbody>
                  {locations.map((l, i) => (
                    <tr key={i} style={{ opacity: l.blocked ? 0.55 : 1 }}>
                      <td>{l.bin_code}</td>
                      <td>{l.batch_no}{l.blocked && " (blocked)"}</td>
                      <td>{new Date(l.expiry_date).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</td>
                      <td>{l.quantity_base_units}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="hint-text" style={{ marginTop: 8 }}>To move stock to a different rack, use Inventory → Move stock.</p>
          </div>
        )}

        {detail && editing && form && (
          <div>
            <div className="field"><label>Brand name</label><input style={{ width: "100%" }} value={form.name} onChange={(e) => setForm((f) => f && { ...f, name: e.target.value })} /></div>
            <div className="field"><label>Manufacturer</label><input style={{ width: "100%" }} value={form.manufacturer} onChange={(e) => setForm((f) => f && { ...f, manufacturer: e.target.value })} /></div>
            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Form</label>
                <input style={{ width: "100%" }} value={form.form} onChange={(e) => setForm((f) => f && { ...f, form: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Schedule</label>
                <select style={{ width: "100%" }} value={form.scheduleCategory} onChange={(e) => setForm((f) => f && { ...f, scheduleCategory: e.target.value })}>
                  {["OTC", "H", "H1", "X", "Ayurvedic", "Cosmetic", "Device"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <label>Composition (multi-salt supported)</label>
            {form.compositions.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <div style={{ flex: 2 }}><SaltAutocomplete value={c.saltName} onChange={(v) => updateComposition(i, { saltName: v })} /></div>
                <input style={{ flex: 1 }} placeholder="Strength" value={c.strength} onChange={(e) => updateComposition(i, { strength: e.target.value })} />
                <button className="btn-secondary" onClick={() => setForm((f) => f && { ...f, compositions: f.compositions.filter((_, idx) => idx !== i) })}>×</button>
              </div>
            ))}
            <button className="btn-secondary" style={{ marginBottom: 12 }} onClick={() => setForm((f) => f && { ...f, compositions: [...f.compositions, { saltName: "", strength: "" }] })}>
              + Add salt
            </button>

            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Base unit</label>
                <input style={{ width: "100%" }} value={form.baseUnit} onChange={(e) => setForm((f) => f && { ...f, baseUnit: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Pack size (units per strip)</label>
                <input type="number" style={{ width: "100%" }} value={form.packSize} onChange={(e) => setForm((f) => f && { ...f, packSize: Number(e.target.value) })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Outer pack (strips per box)</label>
                <input type="number" style={{ width: "100%" }} value={form.outerPackSize ?? ""} onChange={(e) => setForm((f) => f && { ...f, outerPackSize: e.target.value === "" ? null : Number(e.target.value) })} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>HSN code</label>
                <input style={{ width: "100%" }} value={form.hsnCode} onChange={(e) => setForm((f) => f && { ...f, hsnCode: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>GST rate %</label>
                <input type="number" style={{ width: "100%" }} value={form.gstRate} onChange={(e) => setForm((f) => f && { ...f, gstRate: Number(e.target.value) })} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label><input type="checkbox" checked={form.allowLooseSale} onChange={(e) => setForm((f) => f && { ...f, allowLooseSale: e.target.checked })} /> Allow loose sale</label>
              </div>
              {form.allowLooseSale && (
                <div className="field" style={{ flex: 1 }}>
                  <label>Loose sale markup %</label>
                  <input type="number" style={{ width: "100%" }} value={form.looseSaleMarkupPercent} onChange={(e) => setForm((f) => f && { ...f, looseSaleMarkupPercent: Number(e.target.value) })} />
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label><input type="checkbox" checked={form.isColdChain} onChange={(e) => setForm((f) => f && { ...f, isColdChain: e.target.checked })} /> Cold chain item</label>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label><input type="checkbox" checked={form.requiresPrescription} onChange={(e) => setForm((f) => f && { ...f, requiresPrescription: e.target.checked })} /> Requires prescription</label>
              </div>
            </div>

            <div className="field"><label>Barcode</label><input style={{ width: "100%" }} value={form.barcode ?? ""} onChange={(e) => setForm((f) => f && { ...f, barcode: e.target.value || null })} /></div>
            <div className="field">
              <label>Status</label>
              <select style={{ width: "100%" }} value={form.status} onChange={(e) => setForm((f) => f && { ...f, status: e.target.value })}>
                {["active", "pending", "inactive"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>

            {error && <p className="error-text">{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={save} disabled={busy || !form.name.trim() || !form.manufacturer.trim()}>{busy ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
