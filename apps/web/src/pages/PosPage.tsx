import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import SearchBar from "../components/SearchBar.js";
import QuantityInput from "../components/QuantityInput.js";
import RequestFormModal from "../components/RequestFormModal.js";
import { buildReceiptHtml } from "../lib/receipt.js";

interface Line {
  key: number;
  productId: string;
  productName: string;
  manufacturer: string;
  packSize: number;
  baseUnit: string;
  mrp: number;
  scheduleCategory: string;
  isColdChain: boolean;
  quantityBaseUnits: number;
  discountPercent: number;
  discountMode: "percent" | "value" | "target";
  discountValueInput: number;
  targetPriceInput: number;
  // owner-only, filled from pricing-preview
  effectiveCostPerBaseUnit: number | null | undefined;
}

let keySeq = 0;

function computeLinePreview(l: Line) {
  const mrpPerBaseUnit = l.mrp / l.packSize;
  const gross = l.quantityBaseUnits * mrpPerBaseUnit;
  let discountValue = 0;
  if (l.discountMode === "percent") discountValue = (gross * l.discountPercent) / 100;
  else if (l.discountMode === "value") discountValue = l.discountValueInput;
  else discountValue = Math.max(0, gross - l.targetPriceInput);
  const taxable = gross - discountValue;
  const discountPercentEffective = gross > 0 ? (discountValue / gross) * 100 : 0;
  return { mrpPerBaseUnit, gross, discountValue, taxable, discountPercentEffective };
}

export interface FulfillRequest {
  id: string;
  product_id: string | null;
  product_name: string | null;
  customer_name: string;
  customer_phone: string;
  quantity_requested_units: number | null;
}

export default function PosPage({
  fulfillRequest,
  onConsumeFulfillRequest,
}: {
  fulfillRequest?: FulfillRequest | null;
  onConsumeFulfillRequest?: () => void;
}) {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [lines, setLines] = useState<Line[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [fulfillsRequestId, setFulfillsRequestId] = useState<string | null>(null);
  const [fulfillNote, setFulfillNote] = useState<string | null>(null);
  const [billDiscountValue, setBillDiscountValue] = useState(0);
  const [roundOff, setRoundOff] = useState(0);
  const [cashTendered, setCashTendered] = useState<number | "">("");
  const [tenderType, setTenderType] = useState<"cash" | "upi" | "card" | "credit">("cash");
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberReg, setPrescriberReg] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientContact, setPatientContact] = useState("");
  const [held, setHeld] = useState<any[]>([]);
  const [showSearch, setShowSearch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completedBill, setCompletedBill] = useState<any>(null);
  const [requestModalProduct, setRequestModalProduct] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => { api.get("/held-bills").then(setHeld).catch(() => {}); }, []);

  function addLine(p: any): number {
    const key = keySeq++;
    setLines((ls) => [...ls, {
      key, productId: p.id, productName: p.name, manufacturer: p.manufacturer, packSize: p.packSize, baseUnit: p.baseUnit,
      mrp: p.mrp ?? 0, scheduleCategory: p.scheduleCategory, isColdChain: p.isColdChain,
      quantityBaseUnits: 0, discountPercent: 0, discountMode: "percent", discountValueInput: 0, targetPriceInput: 0,
      effectiveCostPerBaseUnit: undefined,
    }]);
    setShowSearch(false);
    return key;
  }

  // Section 6B.4 hand-off: the request book's "Customer arrived — bill
  // now" button lifts the request up to App, which hands it back down
  // here. There's no product-by-id lookup endpoint, so this reuses the
  // same unified search the rest of POS already goes through. Guarded by
  // a ref (not just the dep array) so StrictMode's dev-time double-invoke
  // can't add the line twice for the same request.
  const fulfillHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fulfillRequest) return;
    if (fulfillHandledRef.current === fulfillRequest.id) return;
    fulfillHandledRef.current = fulfillRequest.id;
    setCustomerName(fulfillRequest.customer_name);
    setCustomerPhone(fulfillRequest.customer_phone);
    setFulfillsRequestId(fulfillRequest.id);
    setFulfillNote(null);
    (async () => {
      if (!fulfillRequest.product_id || !fulfillRequest.product_name) {
        setFulfillNote("This request has no linked catalogue product — add the item manually below.");
        onConsumeFulfillRequest?.();
        return;
      }
      try {
        const res = await api.get(`/search?q=${encodeURIComponent(fulfillRequest.product_name)}&context=pos`);
        const product = res.groups.flatMap((g: any) => g.products).find((p: any) => p.id === fulfillRequest.product_id);
        if (product) {
          const key = addLine(product);
          const qty = fulfillRequest.quantity_requested_units ?? 1;
          await onQuantityChange(key, product.id, qty);
        } else {
          setFulfillNote("Couldn't preload the reserved item — add it manually below.");
        }
      } finally {
        onConsumeFulfillRequest?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fulfillRequest]);

  async function updateLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function onQuantityChange(key: number, productId: string, qty: number) {
    updateLine(key, { quantityBaseUnits: qty, effectiveCostPerBaseUnit: undefined });
    if (qty <= 0) return;
    try {
      const res = await api.get(`/sales/pricing-preview?productId=${productId}&quantityBaseUnits=${qty}`);
      if (isOwner) {
        const batches = res.batches as Array<{ quantity: number; effectiveCostPerBaseUnit: number | null }>;
        const known = batches.filter((b) => b.effectiveCostPerBaseUnit !== null);
        const totalQty = batches.reduce((a, b) => a + b.quantity, 0);
        const blendedCost = known.length === batches.length
          ? known.reduce((a, b) => a + b.effectiveCostPerBaseUnit! * b.quantity, 0) / totalQty
          : null;
        updateLine(key, { effectiveCostPerBaseUnit: blendedCost });
      }
    } catch {
      // insufficient stock etc — leave qty as typed, complete-sale will surface the real error
    }
  }

  function removeLine(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }

  const previews = lines.map((l) => ({ ...l, ...computeLinePreview(l) }));
  const taxableTotal = previews.reduce((a, p) => a + p.taxable, 0);
  const taxTotal = previews.reduce((a, p) => {
    const gstRate = 12; // display-only estimate; server computes the authoritative split per product's real gst_rate
    return a + (p.taxable * gstRate) / 100;
  }, 0);
  const grandTotal = Math.round((taxableTotal + taxTotal - billDiscountValue + roundOff) * 100) / 100;
  const needsPrescriberCapture = lines.some((l) => l.scheduleCategory === "H" || l.scheduleCategory === "H1");

  const costKnownLines = previews.filter((p) => isOwner && p.effectiveCostPerBaseUnit != null);
  const totalCost = costKnownLines.reduce((a, p) => a + p.effectiveCostPerBaseUnit! * p.quantityBaseUnits, 0);
  const totalRevenueForKnownCost = costKnownLines.reduce((a, p) => a + p.taxable, 0);
  const blendedMarginPercent = totalRevenueForKnownCost > 0 ? ((totalRevenueForKnownCost - totalCost) / totalRevenueForKnownCost) * 100 : null;

  async function completeSale() {
    setBusy(true);
    setError(null);
    try {
      const tenders = [{ tenderType, amount: tenderType === "cash" ? Number(cashTendered || grandTotal) : grandTotal, referenceNumber: null }];
      const res = await api.post("/sales", {
        channel: "counter",
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        lines: lines.map((l) => {
          const preview = computeLinePreview(l);
          return { productId: l.productId, quantityBaseUnits: l.quantityBaseUnits, discountPercent: 0, discountValue: preview.discountValue };
        }),
        billDiscountValue,
        roundOff,
        tenders,
        prescriberDetails: needsPrescriberCapture ? { prescriberName, prescriberRegistrationNumber: prescriberReg, patientName, patientContact } : null,
        fulfillsRequestId,
        deviceId: "web-console",
      });
      setCompletedBill(res);
      setLines([]);
      setCustomerName(""); setCustomerPhone(""); setBillDiscountValue(0); setRoundOff(0);
      setCashTendered(""); setPrescriberName(""); setPrescriberReg(""); setPatientName(""); setPatientContact("");
      setFulfillsRequestId(null); setFulfillNote(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.body?.error === "insufficient_stock") setError(`Only ${err.body.details.available} in stock, ${err.body.details.requested} requested.`);
        else if (err.body?.error === "insufficient_tender") setError(`Tendered amount doesn't cover the total (₹${err.body.details.grandTotal}).`);
        else setError("Could not complete the sale — check the lines and try again.");
      } else setError("Could not complete the sale.");
    } finally {
      setBusy(false);
    }
  }

  async function holdBill() {
    if (lines.length === 0) return;
    const label = customerName || `Bill ${new Date().toLocaleTimeString()}`;
    await api.post("/held-bills", { label, payload: { lines, customerName, customerPhone, billDiscountValue }, deviceId: "web-console" });
    setLines([]); setCustomerName(""); setCustomerPhone("");
    setHeld(await api.get("/held-bills"));
  }

  async function recallBill(h: any) {
    setLines(h.payload.lines);
    setCustomerName(h.payload.customerName ?? "");
    setCustomerPhone(h.payload.customerPhone ?? "");
    setBillDiscountValue(h.payload.billDiscountValue ?? 0);
    await api.delete(`/held-bills/${h.id}`).catch(() => {});
    setHeld(await api.get("/held-bills"));
  }

  async function printReceipt() {
    if (!completedBill) return;
    await api.post(`/sales/${completedBill.id}/mark-printed`).catch(() => {});
    const detail = await api.get(`/sales/${completedBill.id}`);
    const w = window.open("", "_blank", "width=380,height=600");
    if (!w) return;
    w.document.write(buildReceiptHtml(detail));
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 2 }}>
        <h2 style={{ marginTop: 0 }}>Counter billing</h2>

        {completedBill && (
          <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)", marginBottom: 16 }}>
            <p style={{ margin: 0, fontWeight: 700 }}>Bill {completedBill.billNumber} completed — ₹{completedBill.grandTotal}</p>
            {completedBill.changeDue > 0 && <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>Change due: ₹{completedBill.changeDue}</p>}
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={printReceipt}>Print receipt</button>
          </div>
        )}

        {fulfillsRequestId && (
          <div className="card" style={{ background: "color-mix(in srgb, var(--status-info) 10%, white)", marginBottom: 16 }}>
            <p style={{ margin: 0 }}>
              <strong>Fulfilling a reserved request</strong> — this sale will release the reservation and mark it fulfilled.
            </p>
            {fulfillNote && <p className="hint-text" style={{ margin: "4px 0 0" }}>{fulfillNote}</p>}
          </div>
        )}

        <div className="card" style={{ marginBottom: 12 }}>
          <button className="btn-secondary" onClick={() => setShowSearch((s) => !s)}>{showSearch ? "Hide" : "+ Add item"} search</button>
          {showSearch && (
            <div style={{ marginTop: 10 }}>
              <SearchBar context="pos" onSelect={addLine} onRequestBook={(p) => setRequestModalProduct({ id: p.id, name: p.name })} autoFocus />
            </div>
          )}
        </div>

        {requestModalProduct && (
          <RequestFormModal
            initialProduct={requestModalProduct}
            onClose={() => setRequestModalProduct(null)}
            onCreated={() => setRequestModalProduct(null)}
          />
        )}

        <div className="card">
          <table className="data-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Discount</th><th>Taxable</th>{isOwner && <th>Margin</th>}<th></th></tr></thead>
            <tbody>
              {previews.map((l) => {
                const marginValue = isOwner && l.effectiveCostPerBaseUnit != null ? l.taxable - l.effectiveCostPerBaseUnit * l.quantityBaseUnits : null;
                const marginPercent = marginValue !== null && l.taxable > 0 ? (marginValue / l.taxable) * 100 : null;
                const zeroMarginFloorPercent = isOwner && l.effectiveCostPerBaseUnit != null && l.gross > 0
                  ? Math.max(0, 100 - (l.effectiveCostPerBaseUnit * l.quantityBaseUnits / l.gross) * 100)
                  : null;
                return (
                  <tr key={l.key}>
                    <td>
                      <strong>{l.productName}</strong>
                      {l.scheduleCategory !== "OTC" && <span className="badge badge-info" style={{ marginLeft: 6 }}>{l.scheduleCategory}</span>}
                      <div className="hint-text">₹{l.mrp}/pack · ₹{l.mrpPerBaseUnit.toFixed(2)}/{l.baseUnit}</div>
                    </td>
                    <td><QuantityInput packSize={l.packSize} baseUnitLabel={l.baseUnit} packLabel="Strips" onChange={(q) => onQuantityChange(l.key, l.productId, q)} /></td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <select value={l.discountMode} onChange={(e) => updateLine(l.key, { discountMode: e.target.value as Line["discountMode"] })}>
                          <option value="percent">%</option>
                          <option value="value">₹</option>
                          <option value="target">Target ₹</option>
                        </select>
                        {l.discountMode === "percent" && <input type="number" style={{ width: 60 }} value={l.discountPercent} onChange={(e) => updateLine(l.key, { discountPercent: Number(e.target.value) })} />}
                        {l.discountMode === "value" && <input type="number" style={{ width: 70 }} value={l.discountValueInput} onChange={(e) => updateLine(l.key, { discountValueInput: Number(e.target.value) })} />}
                        {l.discountMode === "target" && <input type="number" style={{ width: 70 }} value={l.targetPriceInput} onChange={(e) => updateLine(l.key, { targetPriceInput: Number(e.target.value) })} />}
                      </div>
                      {l.discountPercentEffective > 0 && <div className="hint-text">{l.discountPercentEffective.toFixed(1)}% off</div>}
                    </td>
                    <td>₹{l.taxable.toFixed(2)}</td>
                    {isOwner && (
                      <td>
                        {l.effectiveCostPerBaseUnit === undefined ? <span className="hint-text">—</span>
                          : l.effectiveCostPerBaseUnit === null ? <span title="Cost unknown for this batch">n/a</span>
                          : (
                            <>
                              <span className={marginPercent! < 0 ? "stock-out" : marginPercent! < 10 ? "" : "stock-ok"} style={{ color: marginPercent! < 0 ? "var(--status-bad)" : marginPercent! < 10 ? "var(--status-warn)" : "var(--status-good)", fontWeight: 700 }}>
                                {marginPercent!.toFixed(1)}%
                              </span>
                              <div className="hint-text">₹{marginValue!.toFixed(2)} · floor {zeroMarginFloorPercent!.toFixed(1)}%</div>
                            </>
                          )}
                      </td>
                    )}
                    <td><button className="btn-secondary" onClick={() => removeLine(l.key)}>×</button></td>
                  </tr>
                );
              })}
              {lines.length === 0 && <tr><td colSpan={isOwner ? 6 : 5} className="hint-text">No items yet — search above.</td></tr>}
            </tbody>
          </table>
        </div>

        {needsPrescriberCapture && (
          <div className="card" style={{ marginTop: 12, background: "color-mix(in srgb, var(--status-warn) 8%, white)" }}>
            <strong>Schedule H/H1 item(s) — prescriber details (optional, never blocks the sale)</strong>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <div className="field"><label>Prescriber name</label><input value={prescriberName} onChange={(e) => setPrescriberName(e.target.value)} /></div>
              <div className="field"><label>Registration no.</label><input value={prescriberReg} onChange={(e) => setPrescriberReg(e.target.value)} /></div>
              <div className="field"><label>Patient name</label><input value={patientName} onChange={(e) => setPatientName(e.target.value)} /></div>
              <div className="field"><label>Patient contact</label><input value={patientContact} onChange={(e) => setPatientContact(e.target.value)} /></div>
            </div>
          </div>
        )}

        {held.length > 0 && (
          <div className="card" style={{ marginTop: 12 }}>
            <strong>Held bills</strong>
            {held.map((h) => (
              <div key={h.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                <span>{h.label}</span>
                <button className="btn-secondary" onClick={() => recallBill(h)}>Recall</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }}>
        <div className="card" style={{ position: "sticky", top: 76 }}>
          <div className="field"><label>Customer (optional)</label><input placeholder="Name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} style={{ width: "100%", marginBottom: 6 }} /><input placeholder="Phone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} style={{ width: "100%" }} /></div>
          <div className="field"><label>Bill-level discount ₹</label><input type="number" style={{ width: "100%" }} value={billDiscountValue} onChange={(e) => setBillDiscountValue(Number(e.target.value))} /></div>
          <div className="field"><label>Round off ₹</label><input type="number" style={{ width: "100%" }} value={roundOff} onChange={(e) => setRoundOff(Number(e.target.value))} /></div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" }} />
          <p style={{ margin: "4px 0", display: "flex", justifyContent: "space-between" }}><span>Taxable</span><strong>₹{taxableTotal.toFixed(2)}</strong></p>
          <p style={{ margin: "4px 0", display: "flex", justifyContent: "space-between" }}><span>Est. tax</span><strong>₹{taxTotal.toFixed(2)}</strong></p>
          <p style={{ margin: "4px 0", display: "flex", justifyContent: "space-between", fontSize: 18 }}><span>Total</span><strong>₹{grandTotal.toFixed(2)}</strong></p>
          {isOwner && blendedMarginPercent !== null && (
            <p className="hint-text" style={{ margin: "4px 0" }}>Blended margin: {blendedMarginPercent.toFixed(1)}%{costKnownLines.length < lines.length && " (some lines excluded — cost unknown)"}</p>
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" }} />
          <div className="field">
            <label>Tender</label>
            <select value={tenderType} onChange={(e) => setTenderType(e.target.value as any)} style={{ width: "100%" }}>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="credit">Credit (khata)</option>
            </select>
          </div>
          {tenderType === "cash" && (
            <div className="field">
              <label>Amount tendered</label>
              <input type="number" style={{ width: "100%" }} value={cashTendered} placeholder={String(grandTotal)} onChange={(e) => setCashTendered(e.target.value === "" ? "" : Number(e.target.value))} />
              {cashTendered !== "" && Number(cashTendered) > grandTotal && (
                <p style={{ fontSize: 22, fontWeight: 700, margin: "6px 0 0" }}>Change: ₹{(Number(cashTendered) - grandTotal).toFixed(2)}</p>
              )}
            </div>
          )}

          {error && <p className="error-text">{error}</p>}

          <button className="btn-primary" style={{ width: "100%", marginTop: 8 }} disabled={busy || lines.length === 0 || lines.some((l) => l.quantityBaseUnits <= 0)} onClick={completeSale}>
            {busy ? "Completing…" : `Complete sale — ₹${grandTotal.toFixed(2)}`}
          </button>
          <button className="btn-secondary" style={{ width: "100%", marginTop: 8 }} disabled={lines.length === 0} onClick={holdBill}>Hold bill</button>
        </div>
      </div>
    </div>
  );
}
