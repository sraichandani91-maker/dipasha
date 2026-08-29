import { useEffect, useState } from "react";
import { api, ApiError, downloadFile, postForm } from "../api.js";
import SearchBar from "../components/SearchBar.js";
import QuantityInput from "../components/QuantityInput.js";

interface Vendor { id: string; name: string; gstin: string | null; paymentTermsDays: number }

interface Line {
  key: number;
  productId: string;
  productName: string;
  packSize: number;
  baseUnit: string;
  batchNo: string;
  expiryMonthYear: string; // "MM/YY" as printed on the invoice, Section 6.4
  quantityBaseUnits: number;
  freeQuantityBaseUnits: number;
  mrp: number;
  ratePerPack: number;
  discountPercent: number;
  gstRate: number;
  cess: number;
  // Section 9A.2 scheme tracking — what the vendor actually promised
  // (a scheme agreement, a PO confirmation), left blank on most lines.
  // Only meaningful when it differs from the actual quantity/free
  // quantity above; the Margins > Scheme shortfalls report reads this.
  promisedQuantityBaseUnits: number | "";
  promisedFreeQuantityBaseUnits: number | "";
}

function expiryToIsoDate(mmYY: string): string | null {
  const m = mmYY.match(/^(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(year, month, 0).getDate(); // last day of that month
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

let lineKeySeq = 0;

export default function PurchaseEntryPage() {
  const [tab, setTab] = useState<"new" | "invoices">("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (selectedId) {
    return <InvoiceDetail invoiceId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "new" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("new")}>+ New invoice</button>
        <button className={tab === "invoices" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("invoices")}>Invoices</button>
      </div>
      {tab === "new" && <NewInvoiceForm />}
      {tab === "invoices" && <InvoiceListTab onOpen={setSelectedId} />}
    </div>
  );
}

function InvoiceListTab({ onOpen }: { onOpen: (id: string) => void }) {
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
    setRows(await api.get(`/purchase-invoices?${query()}`));
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12, flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field"><label>Search invoice #</label><input value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 180 }} /></div>
        <button className="btn-primary" onClick={load}>Filter</button>
      </div>
      <table className="data-table">
        <thead><tr><th>Invoice #</th><th>Vendor</th><th>Date</th><th>Net payable</th><th>Lines</th><th>Docs</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>
              <td>{r.invoice_number}</td>
              <td>{r.vendor_name}</td>
              <td>{new Date(r.invoice_date).toLocaleDateString("en-IN")}</td>
              <td>₹{r.net_payable_computed}{Number(r.reconciliation_diff) !== 0 && <span className="badge badge-warn" style={{ marginLeft: 6 }}>recon diff</span>}</td>
              <td>{r.line_count}</td>
              <td>{r.document_count > 0 ? r.document_count : "—"}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={6} className="hint-text">No invoices match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const CORRECTION_FIELDS = ["invoice_number", "invoice_date", "payment_terms_days"] as const;
const CORRECTION_REASON_CODES = ["data_entry_correction", "wrong_vendor_selected", "wrong_invoice_number", "other"];

function InvoiceDetail({ invoiceId, onBack }: { invoiceId: string; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCorrect, setShowCorrect] = useState(false);
  const [field, setField] = useState<(typeof CORRECTION_FIELDS)[number]>("invoice_number");
  const [newValue, setNewValue] = useState("");
  const [reasonCode, setReasonCode] = useState(CORRECTION_REASON_CODES[0]);
  const [note, setNote] = useState("");

  async function load() {
    setData(await api.get(`/purchase-invoices/${invoiceId}`));
  }
  useEffect(() => { load(); }, [invoiceId]);

  async function submitCorrection() {
    if (!newValue.trim() || !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/purchase-invoices/${invoiceId}`, { field, newValue, reasonCode, note, deviceId: "web-console" });
      setShowCorrect(false);
      setNewValue("");
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Correction failed.") : "Correction failed.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocument(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("document", file);
      await postForm(`/purchase-invoices/${invoiceId}/documents`, form);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Upload failed.") : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div>Loading…</div>;
  const { invoice, lines, documents, corrections } = data;

  return (
    <div>
      <button className="btn-secondary" onClick={onBack} style={{ marginBottom: 12 }}>← Back</button>
      <h2 style={{ marginTop: 0 }}>{invoice.invoice_number} — {invoice.vendor_name}</h2>
      <p className="hint-text">
        {new Date(invoice.invoice_date).toLocaleDateString("en-IN")} · net payable ₹{invoice.net_payable_computed}
        {invoice.reconciliation_diff !== "0.00" && <> · reconciliation diff ₹{invoice.reconciliation_diff}</>} · entered {invoice.entry_method}
      </p>
      {error && <p className="error-text">{error}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Lines</h3>
        <table className="data-table">
          <thead><tr><th>Item</th><th>Batch</th><th>Qty</th><th>Rate</th><th>GST%</th><th>Line total</th></tr></thead>
          <tbody>
            {lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.product_name}</td>
                <td>{l.batch_no}</td>
                <td>{l.quantity_base_units}{l.free_quantity_base_units > 0 && ` (+${l.free_quantity_base_units} free)`}</td>
                <td>₹{l.rate_before_discount}</td>
                <td>{l.gst_rate}%</td>
                <td>₹{l.line_total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Documents</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>Scanned or photographed copy of the physical invoice — audit evidence, not required to save the invoice itself.</p>
        {documents.length > 0 && (
          <ul style={{ marginTop: 0 }}>
            {documents.map((d: any) => (
              <li key={d.id}>
                <button className="btn-secondary" onClick={() => downloadFile(`/purchase-invoices/${invoiceId}/documents/${d.id}`, `${invoice.invoice_number}-${d.id}.${d.mime_type === "application/pdf" ? "pdf" : "jpg"}`)}>
                  View
                </button>{" "}
                uploaded by {d.uploaded_by_name} · {new Date(d.created_at).toLocaleString("en-IN")}
              </li>
            ))}
          </ul>
        )}
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDocument(f); e.target.value = ""; }} />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Edit invoice header</h3>
        <p className="hint-text" style={{ marginTop: 0 }}>
          Invoice number, date, and payment terms only — quantity, rate, and GST already feed posted stock movements and can't be edited here.
        </p>
        {corrections.length > 0 && (
          <ul className="hint-text">
            {corrections.map((c: any, i: number) => (
              <li key={i}>{c.field}: "{c.old_value}" → "{c.new_value}" ({c.reason_code.replace(/_/g, " ")}) — {c.note} · {c.actor_name}, {new Date(c.created_at).toLocaleString("en-IN")}</li>
            ))}
          </ul>
        )}
        {!showCorrect ? (
          <button className="btn-secondary" disabled={busy} onClick={() => setShowCorrect(true)}>Correct a field</button>
        ) : (
          <div>
            <div className="field">
              <label>Field</label>
              <select value={field} onChange={(e) => setField(e.target.value as any)}>
                {CORRECTION_FIELDS.map((f) => <option key={f} value={f}>{f.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div className="field"><label>New value</label><input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={field === "invoice_date" ? "YYYY-MM-DD" : ""} /></div>
            <div className="field">
              <label>Reason</label>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                {CORRECTION_REASON_CODES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div className="field"><label>Note (required)</label><input value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 320 }} /></div>
            <button className="btn-primary" disabled={busy || !newValue.trim() || !note.trim()} onClick={submitCorrection}>Save correction</button>
            <button className="btn-secondary" disabled={busy} onClick={() => setShowCorrect(false)} style={{ marginLeft: 8 }}>Never mind</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NewInvoiceForm() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [showNewVendor, setShowNewVendor] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceTime, setInvoiceTime] = useState("");
  const [invoiceValueStated, setInvoiceValueStated] = useState<number | "">("");
  const [billLevelDiscount, setBillLevelDiscount] = useState(0);
  const [freightAndCharges, setFreightAndCharges] = useState(0);
  const [roundOff, setRoundOff] = useState(0);

  const [lines, setLines] = useState<Line[]>([]);
  const [showAddLine, setShowAddLine] = useState(false);

  const [result, setResult] = useState<any>(null);
  const [conflict, setConflict] = useState<{ error: string; details: any } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get("/vendors").then(setVendors); }, []);

  function addLineFromSearch(p: any) {
    setLines((ls) => [
      ...ls,
      {
        key: lineKeySeq++,
        productId: p.id, productName: `${p.name} (${p.manufacturer})`, packSize: p.packSize, baseUnit: p.baseUnit,
        batchNo: "", expiryMonthYear: "", quantityBaseUnits: 0, freeQuantityBaseUnits: 0,
        mrp: p.mrp ?? 0, ratePerPack: 0, discountPercent: 0, gstRate: p.scheduleCategory ? 12 : 12, cess: 0,
        promisedQuantityBaseUnits: "", promisedFreeQuantityBaseUnits: "",
      },
    ]);
    setShowAddLine(false);
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }

  const linePreviews = lines.map((l) => {
    const ratePerBaseUnit = l.packSize > 0 ? l.ratePerPack / l.packSize : 0;
    const discountValue = (l.quantityBaseUnits * ratePerBaseUnit * l.discountPercent) / 100;
    const taxableValue = l.quantityBaseUnits * ratePerBaseUnit - discountValue;
    const estTax = (taxableValue * l.gstRate) / 100;
    return { ...l, ratePerBaseUnit, discountValue, taxableValue, estTax, lineTotal: taxableValue + estTax + l.cess };
  });
  const previewTaxable = linePreviews.reduce((a, l) => a + l.taxableValue, 0);
  const previewTax = linePreviews.reduce((a, l) => a + l.estTax, 0);
  const previewNet = previewTaxable + previewTax - billLevelDiscount + freightAndCharges + roundOff;

  async function submit(overrideNearExpiry = false, acknowledgeReconciliationMismatch = false) {
    setBusy(true);
    setConflict(null);
    try {
      const payload = {
        vendorId, invoiceNumber, invoiceDate,
        invoiceTime: invoiceTime.trim() || null,
        invoiceValueStated: Number(invoiceValueStated),
        billLevelDiscount, freightAndCharges, roundOff,
        overrideNearExpiry, acknowledgeReconciliationMismatch,
        deviceId: "web-console",
        lines: lines.map((l) => ({
          productId: l.productId,
          batchNo: l.batchNo,
          expiryDate: expiryToIsoDate(l.expiryMonthYear),
          quantityBaseUnits: l.quantityBaseUnits,
          freeQuantityBaseUnits: l.freeQuantityBaseUnits,
          mrp: l.mrp,
          rateBeforeDiscount: l.packSize > 0 ? l.ratePerPack / l.packSize : 0,
          discountPercent: l.discountPercent,
          gstRate: l.gstRate,
          cess: l.cess,
          promisedQuantityBaseUnits: l.promisedQuantityBaseUnits === "" ? null : l.promisedQuantityBaseUnits,
          promisedFreeQuantityBaseUnits: l.promisedFreeQuantityBaseUnits === "" ? null : l.promisedFreeQuantityBaseUnits,
        })),
      };
      const res = await api.post("/purchase-invoices", payload);
      setResult(res);
      setLines([]);
      setInvoiceNumber("");
      setInvoiceTime("");
      setInvoiceValueStated("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict({ error: err.body.error, details: err.body.details });
      } else {
        setConflict({ error: "unknown", details: null });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>GST purchase entry</h2>

      {result && (
        <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)", marginBottom: 16 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Invoice saved. Stock is in IN-01 staging, awaiting put-away.</p>
          <p className="hint-text">
            Taxable ₹{result.taxableValueTotal} · Tax ₹{result.taxTotal} · Net payable ₹{result.netPayableComputed}
            {result.reconciliationDiff !== 0 && <> · reconciliation diff ₹{result.reconciliationDiff}</>}
          </p>
          {result.warnings?.map((w: any, i: number) => <p key={i} className="hint-text" style={{ color: "var(--status-warn)" }}>⚠ {w.message}</p>)}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <div className="field">
            <label>Vendor</label>
            <select value={vendorId} onChange={(e) => e.target.value === "__new" ? setShowNewVendor(true) : setVendorId(e.target.value)} style={{ width: "100%" }}>
              <option value="">Select vendor…</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              <option value="__new">+ New vendor…</option>
            </select>
          </div>
          <div className="field"><label>Invoice number</label><input style={{ width: "100%" }} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} /></div>
          <div className="field"><label>Invoice date</label><input type="date" style={{ width: "100%" }} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></div>
          <div className="field"><label>Invoice time (optional)</label><input placeholder="e.g. 12:35 pm" style={{ width: "100%" }} value={invoiceTime} onChange={(e) => setInvoiceTime(e.target.value)} /></div>
          <div className="field"><label>Invoice value (stated)</label><input type="number" style={{ width: "100%" }} value={invoiceValueStated} onChange={(e) => setInvoiceValueStated(e.target.value === "" ? "" : Number(e.target.value))} /></div>
          <div className="field"><label>Bill-level discount ₹</label><input type="number" style={{ width: "100%" }} value={billLevelDiscount} onChange={(e) => setBillLevelDiscount(Number(e.target.value))} /></div>
          <div className="field"><label>Freight / charges ₹</label><input type="number" style={{ width: "100%" }} value={freightAndCharges} onChange={(e) => setFreightAndCharges(Number(e.target.value))} /></div>
          <div className="field"><label>Round off ₹</label><input type="number" style={{ width: "100%" }} value={roundOff} onChange={(e) => setRoundOff(Number(e.target.value))} /></div>
        </div>

        {showNewVendor && <NewVendorInline onCreated={(v) => { setVendors((vs) => [...vs, v]); setVendorId(v.id); setShowNewVendor(false); }} onCancel={() => setShowNewVendor(false)} />}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Lines</strong>
          <button className="btn-secondary" onClick={() => setShowAddLine((s) => !s)}>+ Add line (same search as everywhere else)</button>
        </div>
        {showAddLine && <div style={{ marginBottom: 12 }}><SearchBar context="purchase_entry" onSelect={addLineFromSearch} autoFocus /></div>}

        {lines.length === 0 && <p className="hint-text">No lines yet.</p>}

        {linePreviews.map((l) => (
          <div key={l.key} className="card" style={{ marginBottom: 8, background: "var(--brand-green-tint)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>{l.productName}</strong>
              <button className="btn-secondary" onClick={() => removeLine(l.key)}>Remove</button>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, alignItems: "flex-end" }}>
              <div className="field"><label>Batch no.</label><input style={{ width: 110 }} value={l.batchNo} onChange={(e) => updateLine(l.key, { batchNo: e.target.value })} /></div>
              <div className="field"><label>Expiry (MM/YY)</label><input style={{ width: 70 }} placeholder="01/28" value={l.expiryMonthYear} onChange={(e) => updateLine(l.key, { expiryMonthYear: e.target.value })} /></div>
              <div>
                <label>Quantity</label>
                <QuantityInput packSize={l.packSize} baseUnitLabel={l.baseUnit} packLabel="Strips" onChange={(q) => updateLine(l.key, { quantityBaseUnits: q })} />
              </div>
              <div>
                <label>Free quantity</label>
                <QuantityInput packSize={l.packSize} baseUnitLabel={l.baseUnit} packLabel="Strips" onChange={(q) => updateLine(l.key, { freeQuantityBaseUnits: q })} />
              </div>
              <div className="field"><label>MRP (per pack)</label><input type="number" style={{ width: 80 }} value={l.mrp} onChange={(e) => updateLine(l.key, { mrp: Number(e.target.value) })} /></div>
              <div className="field"><label>Rate (per pack)</label><input type="number" style={{ width: 80 }} value={l.ratePerPack} onChange={(e) => updateLine(l.key, { ratePerPack: Number(e.target.value) })} /></div>
              <div className="field"><label>Discount %</label><input type="number" style={{ width: 70 }} value={l.discountPercent} onChange={(e) => updateLine(l.key, { discountPercent: Number(e.target.value) })} /></div>
              <div className="field"><label>GST %</label><input type="number" style={{ width: 60 }} value={l.gstRate} onChange={(e) => updateLine(l.key, { gstRate: Number(e.target.value) })} /></div>
              <div className="field"><label>Cess ₹</label><input type="number" style={{ width: 70 }} value={l.cess} onChange={(e) => updateLine(l.key, { cess: Number(e.target.value) })} /></div>
            </div>
            <details style={{ marginTop: 8 }}>
              <summary className="hint-text" style={{ cursor: "pointer" }}>Scheme promised qty (only if the vendor promised more than what actually arrived)</summary>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
                <div className="field">
                  <label>Promised quantity</label>
                  <input type="number" style={{ width: 90 }} value={l.promisedQuantityBaseUnits}
                    onChange={(e) => updateLine(l.key, { promisedQuantityBaseUnits: e.target.value === "" ? "" : Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>Promised free quantity</label>
                  <input type="number" style={{ width: 90 }} value={l.promisedFreeQuantityBaseUnits}
                    onChange={(e) => updateLine(l.key, { promisedFreeQuantityBaseUnits: e.target.value === "" ? "" : Number(e.target.value) })} />
                </div>
              </div>
            </details>
            <p className="hint-text" style={{ marginTop: 6, marginBottom: 0 }}>
              ₹{l.ratePerBaseUnit.toFixed(2)}/{l.baseUnit} · taxable ₹{l.taxableValue.toFixed(2)} · est. tax ₹{l.estTax.toFixed(2)} · line total ≈ ₹{l.lineTotal.toFixed(2)}
            </p>
          </div>
        ))}

        {lines.length > 0 && (
          <div className="card" style={{ background: "var(--surface)", border: "2px solid var(--border)" }}>
            <p style={{ margin: 0 }}>
              Preview — taxable ₹{previewTaxable.toFixed(2)} · est. tax ₹{previewTax.toFixed(2)} · net payable ≈ ₹{previewNet.toFixed(2)}
            </p>
            <p className="hint-text" style={{ margin: "4px 0 0" }}>
              Final CGST/SGST/IGST split and exact totals are computed server-side from the vendor's GST state code on save.
            </p>
          </div>
        )}
      </div>

      {conflict && <ConflictPanel conflict={conflict} onOverrideExpiry={() => submit(true, false)} onAcknowledgeRecon={() => submit(false, true)} busy={busy} />}

      <button
        className="btn-primary"
        disabled={busy || !vendorId || !invoiceNumber || !invoiceValueStated || lines.length === 0}
        onClick={() => submit(false, false)}
      >
        {busy ? "Saving…" : "Save invoice"}
      </button>
    </div>
  );
}

function ConflictPanel({ conflict, onOverrideExpiry, onAcknowledgeRecon, busy }: { conflict: { error: string; details: any }; onOverrideExpiry: () => void; onAcknowledgeRecon: () => void; busy: boolean }) {
  if (conflict.error === "duplicate_invoice") {
    return <div className="card error-text" style={{ marginBottom: 12 }}>An invoice with this number already exists for this vendor. Change the invoice number to save.</div>;
  }
  if (conflict.error === "near_expiry_lines") {
    return (
      <div className="card" style={{ background: "color-mix(in srgb, var(--status-warn) 12%, white)", marginBottom: 12 }}>
        <p style={{ margin: "0 0 8px" }}>
          {conflict.details.lines.length} line(s) expire within {conflict.details.thresholdMonths} months. Manager/Owner override required.
        </p>
        <button className="btn-secondary" disabled={busy} onClick={onOverrideExpiry}>Override and save anyway</button>
      </div>
    );
  }
  if (conflict.error === "reconciliation_mismatch") {
    const d = conflict.details;
    return (
      <div className="card" style={{ background: "color-mix(in srgb, var(--status-warn) 12%, white)", marginBottom: 12 }}>
        <p style={{ margin: "0 0 8px" }}>
          Computed net payable (₹{d.netPayableComputed}) doesn't match the stated invoice value (₹{d.invoiceValueStated}) — difference ₹{d.diff}, outside the ₹{d.toleranceInr} tolerance.
        </p>
        <button className="btn-secondary" disabled={busy} onClick={onAcknowledgeRecon}>Acknowledge mismatch and save anyway</button>
      </div>
    );
  }
  return <div className="card error-text" style={{ marginBottom: 12 }}>Could not save — check the fields and try again.</div>;
}

function NewVendorInline({ onCreated, onCancel }: { onCreated: (v: Vendor) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [gstin, setGstin] = useState("");
  const [terms, setTerms] = useState(30);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const v = await api.post("/vendors", { name, gstin: gstin || null, paymentTermsDays: terms });
      onCreated(v);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12, background: "var(--brand-green-tint)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div className="field"><label>Vendor name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>GSTIN (15 chars)</label><input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} /></div>
        <div className="field"><label>Payment terms (days)</label><input type="number" style={{ width: 80 }} value={terms} onChange={(e) => setTerms(Number(e.target.value))} /></div>
        <button className="btn-primary" disabled={busy || !name} onClick={create}>Create</button>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
