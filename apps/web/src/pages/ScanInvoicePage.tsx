import { useEffect, useRef, useState } from "react";
import { api, ApiError, apiPdfUrl, getTokens, postForm } from "../api.js";
import SearchBar from "../components/SearchBar.js";
import QuantityInput from "../components/QuantityInput.js";

interface Vendor { id: string; name: string; gstin: string | null; paymentTermsDays: number }

interface ExtractedLine {
  productNameAsPrinted: string;
  batchNumber: string | null;
  expiryRaw: string | null;
  expiryNormalized: string | null;
  quantityBaseUnits: number;
  freeQuantityBaseUnits: number;
  rateBeforeDiscount: number;
  discountPercent: number | null;
  discountValue: number | null;
  gstRate: number | null;
  mrp: number | null;
  lineTotal: number | null;
  confidence: number;
}
interface ExtractedInvoice {
  vendorNameExtracted: string;
  gstinExtracted: string | null;
  invoiceNumberExtracted: string;
  invoiceDateExtracted: string | null;
  invoiceTotalExtracted: number | null;
  taxableValueExtracted: number | null;
  cgstExtracted: number | null;
  sgstExtracted: number | null;
  igstExtracted: number | null;
  headerConfidence: Record<string, number>;
  lines: ExtractedLine[];
}
interface MatchCandidate { productId: string; productName: string; score: number }

const CONFIDENCE_THRESHOLD = 0.7; // apps/api migration 1735142400011's seeded ai_invoice_confidence_threshold default

/**
 * Section 6.3 — AI invoice scanning. Three sub-views in one page rather
 * than three routes (this app has no router): a scan history list, the
 * upload/capture form, and the review screen (image left, editable
 * table right) that also serves as the Section 6.3 fallback — an
 * extraction_failed scan lands on the same review screen with a blank
 * line table instead of a pre-filled one, image still alongside, "never
 * a dead end."
 */
export default function ScanInvoicePage() {
  const [view, setView] = useState<"list" | "upload" | "review">("list");
  const [activeScanId, setActiveScanId] = useState<string | null>(null);

  function openReview(scanId: string) {
    setActiveScanId(scanId);
    setView("review");
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Scan invoice</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className={view === "list" ? "btn-primary" : "btn-secondary"} onClick={() => setView("list")}>History</button>
          <button className={view === "upload" ? "btn-primary" : "btn-secondary"} onClick={() => setView("upload")}>+ New scan</button>
        </div>
      </div>
      <p className="hint-text">
        Section 6.3 — a vision-capable LLM reads the invoice and pre-fills the line table below; every field stays
        editable and nothing commits to stock until you confirm. If extraction fails, you get a blank entry form with
        the image still shown alongside — never a dead end.
      </p>
      {view === "list" && <ScanListView onOpen={openReview} />}
      {view === "upload" && <UploadView onUploaded={openReview} />}
      {view === "review" && activeScanId && <ReviewView scanId={activeScanId} onDone={() => setView("list")} />}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  captured: "Captured", extracting: "Extracting…", extracted: "Extracted — needs review",
  extraction_failed: "Extraction failed — manual entry", committed: "Committed",
};

function ScanListView({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api.get("/purchase-scans").then(setRows); }, []);
  return (
    <div className="card">
      <table className="data-table">
        <thead><tr><th>When</th><th>Vendor</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString("en-IN")}</td>
              <td>{r.vendor_name ?? "—"}</td>
              <td><span className="badge badge-info">{STATUS_LABEL[r.status] ?? r.status}</span></td>
              <td>{r.status !== "committed" && <button className="btn-secondary" onClick={() => onOpen(r.id)}>Open</button>}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={4} className="hint-text">No scans yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function UploadView({ onUploaded }: { onUploaded: (id: string) => void }) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.get("/vendors").then(setVendors); }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]);
  }

  async function upload() {
    if (!vendorId || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("vendorId", vendorId);
      form.append("deviceId", "web-console");
      for (const f of files) form.append("pages", f);
      const scan = await postForm("/purchase-scans", form);
      onUploaded(scan.id);
    } catch {
      setError("Could not upload — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="field" style={{ marginBottom: 12 }}>
        <label>Vendor</label>
        <select style={{ width: 320 }} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          <option value="">Select vendor…</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{ border: "2px dashed var(--border)", borderRadius: 8, padding: 32, textAlign: "center", cursor: "pointer" }}
      >
        <p style={{ margin: 0 }}>Drop invoice pages here, or click to choose files</p>
        <p className="hint-text" style={{ margin: "4px 0 0" }}>PDF, JPG, or PNG — a multi-page PDF is one file; several photos are several files, in page order.</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="application/pdf,image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])}
        />
      </div>

      {files.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {files.map((f, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span>{i + 1}. {f.name}</span>
              <button className="btn-secondary" onClick={() => setFiles((fs) => fs.filter((_, idx) => idx !== i))}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      <button className="btn-primary" style={{ marginTop: 12 }} disabled={busy || !vendorId || files.length === 0} onClick={upload}>
        {busy ? "Uploading and extracting…" : "Upload and extract"}
      </button>
    </div>
  );
}

function usePageBlobUrls(scanId: string, pages: Array<{ page_number: number; mime_type: string }>) {
  const [urls, setUrls] = useState<Record<number, string>>({});
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    (async () => {
      const { accessToken } = getTokens();
      for (const p of pages) {
        const res = await fetch(apiPdfUrl(`/purchase-scans/${scanId}/pages/${p.page_number}`), { headers: { Authorization: `Bearer ${accessToken}` } });
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        created.push(url);
        if (!cancelled) setUrls((u) => ({ ...u, [p.page_number]: url }));
      }
    })();
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // scan (and so scan.pages) loads asynchronously in a separate effect
    // one render after this component mounts — depending on scanId alone
    // captured pages=[] from that first render and never re-ran once the
    // real page list arrived (caught live: the image panel stuck on
    // "Loading page 1…" forever). pages.length, not the array itself, so
    // this doesn't re-fire on every parent re-render's new `?? []` literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId, pages.length]);
  return urls;
}

interface EditableLine {
  key: number;
  printedNameForAlias: string | null;
  productId: string;
  productName: string;
  packSize: number;
  baseUnit: string;
  batchNo: string;
  expiryDate: string;
  quantityBaseUnits: number;
  freeQuantityBaseUnits: number;
  mrp: number;
  rateBeforeDiscount: number;
  discountPercent: number;
  gstRate: number;
  cess: number;
  confidence: number | null;
}

let lineKeySeq = 0;

function ReviewView({ scanId, onDone }: { scanId: string; onDone: () => void }) {
  const [scan, setScan] = useState<any>(null);
  const [vendorId, setVendorId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [invoiceValueStated, setInvoiceValueStated] = useState<number | "">("");
  const [billLevelDiscount, setBillLevelDiscount] = useState(0);
  const [freightAndCharges, setFreightAndCharges] = useState(0);
  const [roundOff, setRoundOff] = useState(0);
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [showAddLine, setShowAddLine] = useState(false);
  const [conflict, setConflict] = useState<{ error: string; details: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<any>(null);

  useEffect(() => {
    api.get(`/purchase-scans/${scanId}`).then((s) => {
      setScan(s);
      setVendorId(s.vendor_id ?? "");
      const extracted: ExtractedInvoice | null = s.raw_extraction;
      if (s.status === "extracted" && extracted) {
        setInvoiceNumber(extracted.invoiceNumberExtracted ?? "");
        setInvoiceDate(extracted.invoiceDateExtracted ?? new Date().toISOString().slice(0, 10));
        setInvoiceValueStated(extracted.invoiceTotalExtracted ?? "");
        const matches: Record<string, { candidates: MatchCandidate[]; aliasMatch: boolean }> = s.suggestedMatches ?? {};
        setLines(
          extracted.lines.map((l) => {
            const suggestion = matches[l.productNameAsPrinted];
            const best = suggestion?.candidates[0];
            const confidentEnough = best && (suggestion.aliasMatch || best.score >= 0.4);
            return {
              key: lineKeySeq++,
              printedNameForAlias: l.productNameAsPrinted,
              productId: confidentEnough ? best!.productId : "",
              productName: confidentEnough ? best!.productName : l.productNameAsPrinted,
              packSize: 1,
              baseUnit: "unit",
              batchNo: l.batchNumber ?? "",
              expiryDate: l.expiryNormalized ?? "",
              quantityBaseUnits: l.quantityBaseUnits,
              freeQuantityBaseUnits: l.freeQuantityBaseUnits,
              mrp: l.mrp ?? 0,
              rateBeforeDiscount: l.rateBeforeDiscount,
              discountPercent: l.discountPercent ?? 0,
              gstRate: l.gstRate ?? 12,
              cess: 0,
              confidence: l.confidence,
            };
          })
        );
      } else {
        setInvoiceDate(new Date().toISOString().slice(0, 10));
      }
    });
  }, [scanId]);

  const pageUrls = usePageBlobUrls(scanId, scan?.pages ?? []);

  function updateLine(key: number, patch: Partial<EditableLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }
  function addManualLine(p: any) {
    setLines((ls) => [
      ...ls,
      {
        key: lineKeySeq++, printedNameForAlias: null, productId: p.id, productName: p.name,
        packSize: p.packSize, baseUnit: p.baseUnit, batchNo: "", expiryDate: "",
        quantityBaseUnits: 0, freeQuantityBaseUnits: 0, mrp: p.mrp ?? 0, rateBeforeDiscount: 0,
        discountPercent: 0, gstRate: 12, cess: 0, confidence: null,
      },
    ]);
    setShowAddLine(false);
  }

  const lineTotals = lines.map((l) => {
    const gross = l.quantityBaseUnits * l.rateBeforeDiscount;
    const discountValue = (gross * l.discountPercent) / 100;
    const taxable = gross - discountValue;
    const tax = (taxable * l.gstRate) / 100;
    return { ...l, taxable, tax, total: taxable + tax + l.cess };
  });
  const computedNet = lineTotals.reduce((a, l) => a + l.total, 0) - billLevelDiscount + freightAndCharges + roundOff;
  const stated = invoiceValueStated === "" ? 0 : Number(invoiceValueStated);
  const reconDiff = Math.round((computedNet - stated) * 100) / 100;

  async function submit(overrideNearExpiry = false, acknowledgeReconciliationMismatch = false) {
    setBusy(true);
    setConflict(null);
    try {
      const res = await api.post(`/purchase-scans/${scanId}/commit`, {
        vendorId, invoiceNumber, invoiceDate,
        invoiceValueStated: stated,
        billLevelDiscount, freightAndCharges, roundOff,
        overrideNearExpiry, acknowledgeReconciliationMismatch,
        deviceId: "web-console",
        lines: lines.map((l) => ({
          productId: l.productId, printedNameForAlias: l.printedNameForAlias,
          batchNo: l.batchNo, expiryDate: l.expiryDate,
          quantityBaseUnits: l.quantityBaseUnits, freeQuantityBaseUnits: l.freeQuantityBaseUnits,
          mrp: l.mrp, rateBeforeDiscount: l.rateBeforeDiscount, discountPercent: l.discountPercent,
          gstRate: l.gstRate, cess: l.cess,
        })),
      });
      setCommitted(res);
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

  if (!scan) return <p className="hint-text">Loading…</p>;

  if (committed) {
    return (
      <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)" }}>
        <p style={{ margin: 0, fontWeight: 700 }}>Invoice committed. Stock is in staging, awaiting put-away.</p>
        <p className="hint-text">Taxable ₹{committed.taxableValueTotal} · Tax ₹{committed.taxTotal} · Net payable ₹{committed.netPayableComputed}</p>
        <button className="btn-primary" style={{ marginTop: 8 }} onClick={onDone}>Back to history</button>
      </div>
    );
  }

  const readyToReview = scan.status === "extracted" || scan.status === "extraction_failed";

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 1, position: "sticky", top: 76, alignSelf: "flex-start" }}>
        <div className="card">
          <strong>Invoice image</strong>
          {scan.pages.map((p: any) => (
            <div key={p.page_number} style={{ marginTop: 8 }}>
              {pageUrls[p.page_number] ? (
                p.mime_type === "application/pdf" ? (
                  <embed src={pageUrls[p.page_number]} type="application/pdf" style={{ width: "100%", height: 500 }} />
                ) : (
                  <img src={pageUrls[p.page_number]} style={{ maxWidth: "100%" }} alt={`Page ${p.page_number}`} />
                )
              ) : (
                <p className="hint-text">Loading page {p.page_number}…</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }}>
        {!readyToReview && <p className="hint-text">Still extracting…</p>}

        {scan.status === "extraction_failed" && (
          <div className="card" style={{ marginBottom: 12, background: "color-mix(in srgb, var(--status-warn) 10%, white)" }}>
            <p style={{ margin: 0, fontWeight: 700 }}>Extraction didn't complete — enter this invoice manually below.</p>
            <p className="hint-text" style={{ margin: "4px 0 0" }}>{scan.extraction_error}</p>
          </div>
        )}

        {readyToReview && (
          <>
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                <div className="field"><label>Vendor</label><input style={{ width: "100%" }} value={scan.vendor_name ?? ""} disabled /></div>
                <div className="field">
                  <label>Invoice number {lowConfidence(scan, "invoiceNumber") && <Amber />}</label>
                  <input style={{ width: "100%" }} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
                </div>
                <div className="field">
                  <label>Invoice date {lowConfidence(scan, "invoiceDate") && <Amber />}</label>
                  <input type="date" style={{ width: "100%" }} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                </div>
                <div className="field">
                  <label>Invoice value (stated) {lowConfidence(scan, "invoiceTotal") && <Amber />}</label>
                  <input type="number" style={{ width: "100%" }} value={invoiceValueStated} onChange={(e) => setInvoiceValueStated(e.target.value === "" ? "" : Number(e.target.value))} />
                </div>
                <div className="field"><label>Bill-level discount ₹</label><input type="number" style={{ width: "100%" }} value={billLevelDiscount} onChange={(e) => setBillLevelDiscount(Number(e.target.value))} /></div>
                <div className="field"><label>Freight / charges ₹</label><input type="number" style={{ width: "100%" }} value={freightAndCharges} onChange={(e) => setFreightAndCharges(Number(e.target.value))} /></div>
                <div className="field"><label>Round off ₹</label><input type="number" style={{ width: "100%" }} value={roundOff} onChange={(e) => setRoundOff(Number(e.target.value))} /></div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong>Lines</strong>
                <button className="btn-secondary" onClick={() => setShowAddLine((s) => !s)}>+ Add line</button>
              </div>
              {showAddLine && <div style={{ marginBottom: 12 }}><SearchBar context="purchase_entry" onSelect={addManualLine} autoFocus /></div>}

              {lines.length === 0 && <p className="hint-text">No lines yet.</p>}

              {lineTotals.map((l) => (
                <LineEditor key={l.key} line={l} scan={scan} onChange={(patch) => updateLine(l.key, patch)} onRemove={() => removeLine(l.key)} />
              ))}

              {lines.length > 0 && (
                <div className="card" style={{ background: "var(--surface)", border: "2px solid var(--border)", marginTop: 8 }}>
                  <p style={{ margin: 0 }}>
                    Computed net ₹{computedNet.toFixed(2)} vs stated ₹{stated.toFixed(2)}
                    {reconDiff !== 0 && <strong style={{ color: Math.abs(reconDiff) > 1 ? "var(--status-bad)" : "inherit" }}> · diff ₹{reconDiff.toFixed(2)}</strong>}
                  </p>
                </div>
              )}
            </div>

            {conflict && (
              <ConflictPanel
                conflict={conflict}
                busy={busy}
                onOverrideExpiry={() => submit(true, false)}
                onAcknowledgeRecon={() => submit(false, true)}
              />
            )}

            <button
              className="btn-primary"
              disabled={busy || !vendorId || !invoiceNumber || !invoiceValueStated || lines.length === 0 || lines.some((l) => !l.productId)}
              onClick={() => submit(false, false)}
            >
              {busy ? "Committing…" : "Commit — create GRN"}
            </button>
            {lines.some((l) => !l.productId) && <p className="hint-text">Every line needs a matched (or newly created) product before this can commit.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function lowConfidence(scan: any, field: string): boolean {
  const c = scan.raw_extraction?.headerConfidence?.[field];
  return typeof c === "number" && c < CONFIDENCE_THRESHOLD;
}

function Amber() {
  return <span className="badge" style={{ background: "color-mix(in srgb, var(--status-warn) 25%, white)", marginLeft: 6 }}>low confidence</span>;
}

function LineEditor({ line, scan, onChange, onRemove }: { line: EditableLine & { taxable: number; tax: number; total: number }; scan: any; onChange: (p: Partial<EditableLine>) => void; onRemove: () => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const suggestion = line.printedNameForAlias ? scan.suggestedMatches?.[line.printedNameForAlias] : null;
  const lowConf = line.confidence !== null && line.confidence < CONFIDENCE_THRESHOLD;
  const unmatched = !line.productId;

  return (
    <div
      className="card"
      style={{ marginBottom: 8, background: unmatched ? "color-mix(in srgb, var(--status-bad) 8%, white)" : lowConf ? "color-mix(in srgb, var(--status-warn) 8%, white)" : "var(--brand-green-tint)" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          {line.printedNameForAlias && <div className="hint-text">Printed: "{line.printedNameForAlias}"</div>}
          {suggestion && suggestion.candidates.length > 0 ? (
            <select style={{ width: "100%" }} value={line.productId} onChange={(e) => {
              const c = suggestion.candidates.find((x: MatchCandidate) => x.productId === e.target.value);
              onChange({ productId: e.target.value, productName: c?.productName ?? "" });
            }}>
              <option value="">— choose a match —</option>
              {suggestion.candidates.map((c: MatchCandidate) => (
                <option key={c.productId} value={c.productId}>{c.productName} ({Math.round(c.score * 100)}% match)</option>
              ))}
            </select>
          ) : (
            <strong>{line.productName || "No product matched"}</strong>
          )}
          {unmatched && <button className="btn-secondary" style={{ marginTop: 4 }} onClick={() => setShowCreate((s) => !s)}>+ Create new SKU</button>}
          {showCreate && (
            <InlineCreateSku
              initialName={line.printedNameForAlias ?? ""}
              initialGstRate={line.gstRate}
              onCreated={(p) => { onChange({ productId: p.id, productName: p.name }); setShowCreate(false); }}
              onCancel={() => setShowCreate(false)}
            />
          )}
        </div>
        <button className="btn-secondary" onClick={onRemove}>Remove</button>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, alignItems: "flex-end" }}>
        <div className="field"><label>Batch no.</label><input style={{ width: 110 }} value={line.batchNo} onChange={(e) => onChange({ batchNo: e.target.value })} /></div>
        <div className="field"><label>Expiry</label><input type="date" style={{ width: 130 }} value={line.expiryDate} onChange={(e) => onChange({ expiryDate: e.target.value })} /></div>
        <div className="field"><label>Quantity (base units)</label><input type="number" style={{ width: 90 }} value={line.quantityBaseUnits} onChange={(e) => onChange({ quantityBaseUnits: Number(e.target.value) })} /></div>
        <div className="field"><label>Free qty</label><input type="number" style={{ width: 80 }} value={line.freeQuantityBaseUnits} onChange={(e) => onChange({ freeQuantityBaseUnits: Number(e.target.value) })} /></div>
        <div className="field"><label>MRP</label><input type="number" style={{ width: 80 }} value={line.mrp} onChange={(e) => onChange({ mrp: Number(e.target.value) })} /></div>
        <div className="field"><label>Rate / base unit</label><input type="number" style={{ width: 90 }} value={line.rateBeforeDiscount} onChange={(e) => onChange({ rateBeforeDiscount: Number(e.target.value) })} /></div>
        <div className="field"><label>Discount %</label><input type="number" style={{ width: 70 }} value={line.discountPercent} onChange={(e) => onChange({ discountPercent: Number(e.target.value) })} /></div>
        <div className="field"><label>GST %</label><input type="number" style={{ width: 60 }} value={line.gstRate} onChange={(e) => onChange({ gstRate: Number(e.target.value) })} /></div>
      </div>
      <p className="hint-text" style={{ marginTop: 6, marginBottom: 0 }}>
        taxable ₹{line.taxable.toFixed(2)} · line total ≈ ₹{line.total.toFixed(2)}
        {lowConf && " · low extraction confidence — check this line"}
      </p>
    </div>
  );
}

function InlineCreateSku({ initialName, initialGstRate, onCreated, onCancel }: { initialName: string; initialGstRate: number; onCreated: (p: { id: string; name: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState(initialName);
  const [manufacturer, setManufacturer] = useState("");
  const [form, setForm] = useState("tablet");
  const [scheduleCategory, setScheduleCategory] = useState("OTC");
  const [hsnCode, setHsnCode] = useState("3004");
  const [gstRate, setGstRate] = useState(initialGstRate);
  const [baseUnit, setBaseUnit] = useState("tablet");
  const [packSize, setPackSize] = useState(10);
  const [saltName, setSaltName] = useState("");
  const [strength, setStrength] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const p = await api.post("/products", {
        name, manufacturer, form, scheduleCategory, hsnCode, gstRate, baseUnit, packSize,
        compositions: saltName.trim() ? [{ saltName, strength }] : [{ saltName: name, strength: "n/a" }],
        confirmDuplicate: true,
      });
      onCreated(p);
    } catch {
      setError("Could not create — check the fields.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 8, background: "var(--surface)" }}>
      <p className="hint-text" style={{ marginTop: 0 }}>Section 6.3: "do not force the user to leave the screen" — a minimal SKU, editable fully on the Products screen later.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div className="field"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Manufacturer</label><input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} /></div>
        <div className="field"><label>Form</label><input style={{ width: 90 }} value={form} onChange={(e) => setForm(e.target.value)} /></div>
        <div className="field">
          <label>Schedule</label>
          <select value={scheduleCategory} onChange={(e) => setScheduleCategory(e.target.value)}>
            {["OTC", "H", "H1", "X", "Ayurvedic", "Cosmetic", "Device"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="field"><label>HSN</label><input style={{ width: 80 }} value={hsnCode} onChange={(e) => setHsnCode(e.target.value)} /></div>
        <div className="field"><label>GST %</label><input type="number" style={{ width: 60 }} value={gstRate} onChange={(e) => setGstRate(Number(e.target.value))} /></div>
        <div className="field"><label>Base unit</label><input style={{ width: 80 }} value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} /></div>
        <div className="field"><label>Pack size</label><input type="number" style={{ width: 70 }} value={packSize} onChange={(e) => setPackSize(Number(e.target.value))} /></div>
        <div className="field"><label>Salt</label><input value={saltName} onChange={(e) => setSaltName(e.target.value)} /></div>
        <div className="field"><label>Strength</label><input style={{ width: 90 }} value={strength} onChange={(e) => setStrength(e.target.value)} /></div>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div style={{ marginTop: 8 }}>
        <button className="btn-primary" disabled={busy || !name || !manufacturer} onClick={create}>{busy ? "Creating…" : "Create"}</button>
        <button className="btn-secondary" style={{ marginLeft: 8 }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ConflictPanel({ conflict, onOverrideExpiry, onAcknowledgeRecon, busy }: { conflict: { error: string; details: any }; onOverrideExpiry: () => void; onAcknowledgeRecon: () => void; busy: boolean }) {
  if (conflict.error === "duplicate_invoice") {
    return <div className="card error-text" style={{ marginBottom: 12 }}>An invoice with this number already exists for this vendor. Change the invoice number to commit.</div>;
  }
  if (conflict.error === "near_expiry_lines") {
    return (
      <div className="card" style={{ background: "color-mix(in srgb, var(--status-warn) 12%, white)", marginBottom: 12 }}>
        <p style={{ margin: "0 0 8px" }}>
          {conflict.details.lines.length} line(s) expire within {conflict.details.thresholdMonths} months. Manager/Owner override required.
        </p>
        <button className="btn-secondary" disabled={busy} onClick={onOverrideExpiry}>Override and commit anyway</button>
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
        <button className="btn-secondary" disabled={busy} onClick={onAcknowledgeRecon}>Acknowledge mismatch and commit anyway</button>
      </div>
    );
  }
  return <div className="card error-text" style={{ marginBottom: 12 }}>Could not commit — check the fields and try again.</div>;
}
