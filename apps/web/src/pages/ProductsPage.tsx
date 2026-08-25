import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import SaltAutocomplete from "../components/SaltAutocomplete.js";
import SearchBar from "../components/SearchBar.js";

interface Batch {
  batchNo: string;
  expiryDate: string;
  mrp: number;
  quantityBaseUnits: number;
  costUnknown: boolean;
  effectiveCostPerBaseUnit?: number | null; // present only for Owner — see Section 6A.9/10B.4
}
interface Product {
  id: string;
  name: string;
  manufacturer: string;
  form: string;
  scheduleCategory: string;
  hsnCode: string;
  gstRate: number;
  packSize: number;
  baseUnit: string;
  stockBaseUnits: number;
  substituteGroupId: string | null;
  batches: Batch[];
}

interface CompositionRow { saltName: string; strength: string }

const emptyForm = () => ({
  name: "", manufacturer: "", form: "tablet", scheduleCategory: "OTC" as string,
  hsnCode: "3004", gstRate: 12, baseUnit: "tablet", packSize: 10,
  compositions: [{ saltName: "", strength: "" }] as CompositionRow[],
});

export default function ProductsPage() {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSearchPreview, setShowSearchPreview] = useState(false);

  async function load() {
    setProducts(await api.get("/products?limit=200"));
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Product master</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-secondary" onClick={() => setShowSearchPreview((s) => !s)}>
            {showSearchPreview ? "Hide" : "Try"} unified search
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New product</button>
        </div>
      </div>

      {showSearchPreview && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="hint-text" style={{ marginTop: 0 }}>
            Section 5B: one search bar, reused everywhere (POS, request book, purchase entry). This is the same
            component and the same endpoint each of those will use.
          </p>
          <SearchBar context="app_lookup" autoFocus />
        </div>
      )}

      {showCreate && <CreateProductModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Manufacturer</th><th>Form</th><th>Schedule</th>
              <th>Pack</th><th>Stock</th><th>MRP</th>
              {user?.role === "owner" && <th>Cost/unit</th>}
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const batch = p.batches[0];
              return (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td>{p.manufacturer}</td>
                  <td>{p.form}</td>
                  <td>{p.scheduleCategory !== "OTC" && <span className="badge badge-info">{p.scheduleCategory}</span>}</td>
                  <td>{p.packSize} {p.baseUnit}s</td>
                  <td className={p.stockBaseUnits === 0 ? "stock-out" : "stock-ok"}>{p.stockBaseUnits}</td>
                  <td>{batch ? `₹${batch.mrp}` : "—"}</td>
                  {user?.role === "owner" && (
                    <td>
                      {batch && batch.effectiveCostPerBaseUnit != null
                        ? `₹${batch.effectiveCostPerBaseUnit.toFixed(2)}`
                        : <span title="No purchase history — cost genuinely unknown, not zero">—</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreateProductModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Array<{ id: string; name: string; manufacturer: string }> | null>(null);
  const [busy, setBusy] = useState(false);

  function updateComposition(i: number, patch: Partial<CompositionRow>) {
    setForm((f) => ({ ...f, compositions: f.compositions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));
  }

  async function submit(confirmDuplicate = false) {
    setError(null);
    setBusy(true);
    try {
      await api.post("/products", {
        ...form,
        compositions: form.compositions.filter((c) => c.saltName.trim() && c.strength.trim()).map((c) => ({ saltName: c.saltName, strength: c.strength })),
        confirmDuplicate,
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDuplicates(err.body.existingProducts);
      } else {
        setError("Could not create product — check the fields and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 480, maxHeight: "85vh", overflowY: "auto", background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>New product</h3>

        {duplicates && (
          <div className="card" style={{ background: "color-mix(in srgb, var(--status-warn) 10%, white)", marginBottom: 12 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600 }}>An existing SKU shares this exact composition, strength and form:</p>
            <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
              {duplicates.map((d) => <li key={d.id}>{d.name} ({d.manufacturer})</li>)}
            </ul>
            <p className="hint-text">Consider linking this as a substitute instead of creating a near-duplicate.</p>
            <button className="btn-secondary" onClick={() => submit(true)} disabled={busy}>Create anyway</button>
          </div>
        )}

        <div className="field">
          <label>Brand name</label>
          <input style={{ width: "100%" }} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="field">
          <label>Manufacturer</label>
          <input style={{ width: "100%" }} value={form.manufacturer} onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Form</label>
            <input style={{ width: "100%" }} value={form.form} onChange={(e) => setForm((f) => ({ ...f, form: e.target.value }))} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Schedule</label>
            <select style={{ width: "100%" }} value={form.scheduleCategory} onChange={(e) => setForm((f) => ({ ...f, scheduleCategory: e.target.value }))}>
              {["OTC", "H", "H1", "X", "Ayurvedic", "Cosmetic", "Device"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Base unit</label>
            <input style={{ width: "100%" }} value={form.baseUnit} onChange={(e) => setForm((f) => ({ ...f, baseUnit: e.target.value }))} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Pack size</label>
            <input type="number" style={{ width: "100%" }} value={form.packSize} onChange={(e) => setForm((f) => ({ ...f, packSize: Number(e.target.value) }))} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>HSN code</label>
            <input style={{ width: "100%" }} value={form.hsnCode} onChange={(e) => setForm((f) => ({ ...f, hsnCode: e.target.value }))} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>GST rate %</label>
            <input type="number" style={{ width: "100%" }} value={form.gstRate} onChange={(e) => setForm((f) => ({ ...f, gstRate: Number(e.target.value) }))} />
          </div>
        </div>

        <label>Composition (multi-salt supported)</label>
        {form.compositions.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 2 }}><SaltAutocomplete value={c.saltName} onChange={(v) => updateComposition(i, { saltName: v })} /></div>
            <input style={{ flex: 1 }} placeholder="Strength" value={c.strength} onChange={(e) => updateComposition(i, { strength: e.target.value })} />
          </div>
        ))}
        <button className="btn-secondary" style={{ marginBottom: 12 }} onClick={() => setForm((f) => ({ ...f, compositions: [...f.compositions, { saltName: "", strength: "" }] }))}>
          + Add salt
        </button>

        {error && <p className="error-text">{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => submit(false)} disabled={busy || !form.name || !form.manufacturer}>
            {busy ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
