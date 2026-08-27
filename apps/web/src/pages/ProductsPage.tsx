import { useEffect, useState } from "react";
import { api, ApiError, downloadFile } from "../api.js";
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

type Tab = "catalogue" | "substitute-groups" | "bulk-import";

export default function ProductsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("catalogue");
  const [products, setProducts] = useState<Product[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSearchPreview, setShowSearchPreview] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  async function load() {
    setProducts(await api.get("/products?limit=200"));
  }
  useEffect(() => { load(); }, []);

  function toggleSelected(id: string) {
    setSelectedIds((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  async function downloadLabels() {
    const ids = [...selectedIds];
    await downloadFile(`/products/label-sheet${ids.length ? `?ids=${ids.join(",")}` : ""}`, "product-labels.pdf");
  }

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

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {([["catalogue", "Catalogue"], ["substitute-groups", "Substitute groups"], ["bulk-import", "Bulk import"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
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

      {tab === "catalogue" && (
        <>
          <div style={{ marginBottom: 8 }}>
            <button className="btn-secondary" onClick={downloadLabels}>
              Download barcode labels{selectedIds.size > 0 ? ` (${selectedIds.size} selected)` : " (all)"}
            </button>
            <span className="hint-text" style={{ marginLeft: 8 }}>Tick rows to limit the sheet to a selection — products with no barcode assigned are skipped.</span>
          </div>
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th></th><th>Name</th><th>Manufacturer</th><th>Form</th><th>Schedule</th>
                  <th>Pack</th><th>Stock</th><th>MRP</th>
                  {user?.role === "owner" && <th>Cost/unit</th>}
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const batch = p.batches[0];
                  return (
                    <tr key={p.id}>
                      <td><input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelected(p.id)} /></td>
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
        </>
      )}
      {tab === "substitute-groups" && <SubstituteGroupsTab />}
      {tab === "bulk-import" && <BulkImportTab onDone={load} />}
    </div>
  );
}

function SubstituteGroupsTab() {
  const [groups, setGroups] = useState<Array<{ groupId: string; products: Array<{ id: string; name: string; manufacturer: string; form: string }> }> | null>(null);
  const [moving, setMoving] = useState<{ id: string; name: string } | null>(null);

  async function load() {
    setGroups(await api.get("/products/substitute-groups"));
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <p className="hint-text">
        Section 10.2: substitute_group_id is auto-computed from composition + strength + form when a product is
        created — this is where you override that, linking products you know are interchangeable in practice or
        splitting a group that shouldn't have been merged.
      </p>
      {groups?.map((g) => (
        <div key={g.groupId} className="card" style={{ marginBottom: 8 }}>
          <div className="hint-text" style={{ marginBottom: 4 }}>Group {g.groupId.slice(0, 8)} — {g.products.length} product{g.products.length === 1 ? "" : "s"}</div>
          {g.products.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span>{p.name} ({p.manufacturer}, {p.form})</span>
              <button className="btn-secondary" onClick={() => setMoving({ id: p.id, name: p.name })}>Change group</button>
            </div>
          ))}
        </div>
      ))}
      {moving && <ChangeGroupModal product={moving} onClose={() => setMoving(null)} onChanged={load} />}
    </div>
  );
}

function ChangeGroupModal({ product, onClose, onChanged }: { product: { id: string; name: string }; onClose: () => void; onChanged: () => void }) {
  const [mode, setMode] = useState<"link" | "split">("link");
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!note.trim() || (mode === "link" && !target)) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/products/${product.id}/substitute-group`, { targetProductId: mode === "link" ? target!.id : null, note });
      onChanged();
      onClose();
    } catch {
      setError("Could not change this product's substitute group.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 460, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Change group — {product.name}</h3>
        {error && <p className="error-text">{error}</p>}
        <div className="field">
          <label>Action</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="link">Link to another product's group</option>
            <option value="split">Split into its own new group</option>
          </select>
        </div>
        {mode === "link" && (
          <div className="field">
            <label>Link with</label>
            {target ? (
              <div>{target.name} <button className="btn-secondary" onClick={() => setTarget(null)}>Change</button></div>
            ) : (
              <SearchBar context="app_lookup" onSelect={(p) => setTarget({ id: p.id, name: p.name })} />
            )}
          </div>
        )}
        <div className="field"><label>Note (required — why these are/aren't substitutes)</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn-primary" disabled={busy || !note.trim() || (mode === "link" && !target)} onClick={submit}>Apply</button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const BULK_IMPORT_COLUMNS = "name,manufacturer,form,schedule_category,hsn_code,gst_rate,base_unit,pack_size,is_cold_chain,allow_loose_sale,barcode,status,composition";

function BulkImportTab({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState(BULK_IMPORT_COLUMNS + "\n");
  const [diff, setDiff] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setDiff(await api.post("/products/bulk-import/preview", { csv }));
    } catch {
      setError("Could not parse this CSV.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/products/bulk-import/commit", { csv });
      setResult(`${res.created} created, ${res.updated} updated, ${res.skipped} skipped.`);
      setDiff(null);
      onDone();
    } catch {
      setError("Could not commit this import.");
    } finally {
      setBusy(false);
    }
  }

  const okCount = diff?.filter((d) => d.ok).length ?? 0;

  return (
    <div>
      <p className="hint-text">
        Section 10.2: bulk CSV import with a mandatory preview-and-confirm diff — nothing is written until you review
        the rows and click Commit. Rows are matched by name + manufacturer: no match creates a new product (composition
        required, format <code>SaltName:Strength|SaltName2:Strength2</code>); a match updates only barcode, allow_loose_sale,
        and status — not form/schedule/HSN/GST/pack size, which this screen won't silently change on an existing SKU.
        Plain CSV only — no quoted fields, no embedded commas.
      </p>
      <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setDiff(null); }} rows={8} style={{ width: "100%", fontFamily: "monospace" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn-secondary" disabled={busy} onClick={preview}>Preview</button>
        <button className="btn-primary" disabled={busy || !diff || okCount === 0} onClick={commit}>Commit {diff ? `(${okCount} row${okCount === 1 ? "" : "s"})` : ""}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {result && <p>{result}</p>}
      {diff && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Row</th><th>Product</th><th>Action</th><th>Changes</th><th>Status</th></tr></thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.rowNumber} style={{ background: d.ok ? undefined : "color-mix(in srgb, var(--status-warn) 10%, white)" }}>
                <td>{d.rowNumber}</td>
                <td>{d.name} ({d.manufacturer})</td>
                <td>{d.action ?? "—"}</td>
                <td>{d.changes?.map((c: any) => `${c.field}: ${c.from ?? "—"} → ${c.to}`).join("; ") || "no changes"}</td>
                <td>{d.ok ? "Will apply" : d.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
