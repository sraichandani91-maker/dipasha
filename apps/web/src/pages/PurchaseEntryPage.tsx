import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
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
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [showNewVendor, setShowNewVendor] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
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
        })),
      };
      const res = await api.post("/purchase-invoices", payload);
      setResult(res);
      setLines([]);
      setInvoiceNumber("");
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
            </div>
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
