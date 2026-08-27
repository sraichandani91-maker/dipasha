import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import SearchBar from "../components/SearchBar.js";
import QuantityInput from "../components/QuantityInput.js";
import RequestFormModal from "../components/RequestFormModal.js";
import { buildReceiptHtml } from "../lib/receipt.js";
import { useOfflineSync } from "../offline/useOfflineSync.js";
import {
  refreshPosSnapshot, refillBillNumberPool, poolSize, getSnapshotMeta, queueOfflineSale,
  searchSnapshotProducts, buildOfflineReceiptHtml, type SnapshotProduct, type QueuedOfflineSale,
} from "../offline/pos-offline.js";

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
  const [prescriberId, setPrescriberId] = useState<string | null>(null);
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberReg, setPrescriberReg] = useState("");
  const [prescriberSuggestions, setPrescriberSuggestions] = useState<any[]>([]);
  const [patientName, setPatientName] = useState("");
  const [patientContact, setPatientContact] = useState("");
  const [creditBalance, setCreditBalance] = useState<any>(null);
  const [creditBalanceLoading, setCreditBalanceLoading] = useState(false);
  const [held, setHeld] = useState<any[]>([]);
  const [showSearch, setShowSearch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completedBill, setCompletedBill] = useState<any>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<string | null>(null);
  const [whatsappBusy, setWhatsappBusy] = useState(false);
  const [requestModalProduct, setRequestModalProduct] = useState<{ id: string; name: string } | null>(null);
  const offline = useOfflineSync();

  useEffect(() => { api.get("/held-bills").then(setHeld).catch(() => {}); }, []);

  // Section 6A.9: "POS must bill fully offline against the local
  // cache." Refreshed opportunistically whenever the tab is online —
  // this is the same "works while the tab is open" honesty as every
  // other browser-only capability in this build (M5's alarm, M11's GPS
  // pings) since there's no background sync without a native app.
  useEffect(() => {
    if (!offline.isOnline) return;
    refreshPosSnapshot().catch(() => {});
    poolSize().then((n) => {
      if (n < 2) refillBillNumberPool("web-console").catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline.isOnline]);

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

  async function searchPrescribers(q: string) {
    setPrescriberName(q);
    setPrescriberId(null);
    if (q.trim().length < 2) { setPrescriberSuggestions([]); return; }
    try {
      setPrescriberSuggestions(await api.get(`/prescribers?search=${encodeURIComponent(q)}`));
    } catch {
      // autocomplete failing shouldn't block manual entry
    }
  }

  function selectPrescriber(p: any) {
    setPrescriberId(p.id);
    setPrescriberName(p.name);
    setPrescriberReg(p.registration_number ?? "");
    setPrescriberSuggestions([]);
  }

  // Section 9A.4: "running balance shown to the biller before the sale
  // completes." Looked up by phone since that's all POS captures — a
  // credit sale for a phone with no matching customer record simply has
  // no balance to preview (createSale's own findOrCreateCustomer will
  // create one at completion).
  async function checkCreditBalance() {
    if (!customerPhone.trim()) return;
    setCreditBalanceLoading(true);
    setCreditBalance(null);
    try {
      const matches = await api.get(`/customers/search?q=${encodeURIComponent(customerPhone.trim())}`);
      const match = matches.find((c: any) => c.phone === customerPhone.trim());
      if (match) setCreditBalance(await api.get(`/customers/${match.id}/balance`));
    } finally {
      setCreditBalanceLoading(false);
    }
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

  // Section 6A.9: POS bills fully offline against the local cache when
  // there's no connection — same lines/tenders shape, just resolved
  // against the cached snapshot instead of a live call, and queued for
  // /sync/sales to replay on reconnect. Schedule H/H1 prescriber capture
  // isn't wired into this path yet (a disclosed simplification, see
  // DECISIONS.md) — an offline H/H1 sale still queues and syncs, just
  // without prescriber details.
  async function completeSaleOffline() {
    setBusy(true);
    setError(null);
    try {
      const tenders = [{ tenderType, amount: tenderType === "cash" ? Number(cashTendered || grandTotal) : grandTotal, referenceNumber: null }];
      const sale = await queueOfflineSale({
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        lines: lines.map((l) => {
          const preview = computeLinePreview(l);
          return { productId: l.productId, quantityBaseUnits: l.quantityBaseUnits, discountValue: preview.discountValue };
        }),
        billDiscountValue,
        roundOff,
        tenders,
        deviceId: "web-console",
      });
      setCompletedBill({ billNumber: sale.preAssignedBillNumber, grandTotal: sale.grandTotalEstimate, changeDue: 0, customerPhone: sale.customerPhone, queuedOffline: true, offlineSale: sale });
      setWhatsappStatus(null);
      setLines([]);
      setCustomerName(""); setCustomerPhone(""); setBillDiscountValue(0); setRoundOff(0);
      setCashTendered(""); setPrescriberId(null); setPrescriberName(""); setPrescriberReg(""); setPatientName(""); setPatientContact("");
      setFulfillsRequestId(null); setFulfillNote(null); setCreditBalance(null);
      await offline.refreshPendingCount();
    } catch (err) {
      if (err instanceof Error && err.message === "insufficient_stock_offline") setError("Not enough stock in the offline cache for this item.");
      else if (err instanceof Error && err.message === "no_offline_bill_numbers_reserved") setError("No offline bill numbers available — reconnect briefly to reserve a block before going offline.");
      else setError("Could not complete the sale offline.");
    } finally {
      setBusy(false);
    }
  }

  async function completeSale() {
    if (!offline.isOnline) return completeSaleOffline();
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
        prescriberDetails: needsPrescriberCapture ? { prescriberId, prescriberName, prescriberRegistrationNumber: prescriberReg, patientName, patientContact } : null,
        fulfillsRequestId,
        deviceId: "web-console",
      });
      setCompletedBill(res);
      setWhatsappStatus(null);
      setLines([]);
      setCustomerName(""); setCustomerPhone(""); setBillDiscountValue(0); setRoundOff(0);
      setCashTendered(""); setPrescriberId(null); setPrescriberName(""); setPrescriberReg(""); setPatientName(""); setPatientContact("");
      setFulfillsRequestId(null); setFulfillNote(null); setCreditBalance(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.body?.error === "insufficient_stock") setError(`Only ${err.body.details.available} in stock, ${err.body.details.requested} requested.`);
        else if (err.body?.error === "insufficient_tender") setError(`Tendered amount doesn't cover the total (₹${err.body.details.grandTotal}).`);
        else if (err.body?.error === "credit_requires_customer") setError("Credit sales need a customer phone number.");
        else if (err.body?.error === "credit_tender_exceeds_total") setError(`Credit tendered (₹${err.body.details.tendered}) is more than the bill total (₹${err.body.details.grandTotal}).`);
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

  async function sendWhatsApp() {
    if (!completedBill || completedBill.queuedOffline) return;
    setWhatsappBusy(true);
    setWhatsappStatus(null);
    try {
      const res = await api.post(`/sales/${completedBill.id}/send-whatsapp`);
      setWhatsappStatus(
        res.status === "logged_dev_mode"
          ? "No WhatsApp provider is set up yet — the message was logged on the server instead of actually sent (see DECISIONS.md)."
          : res.isResend ? "Sent again." : "Sent."
      );
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "no_customer_phone") {
        setWhatsappStatus("This bill has no customer phone number — add one before completing the sale to send via WhatsApp.");
      } else {
        setWhatsappStatus("Could not send — try again.");
      }
    } finally {
      setWhatsappBusy(false);
    }
  }

  async function printReceipt() {
    if (!completedBill) return;
    const w = window.open("", "_blank", "width=380,height=600");
    if (!w) return;
    if (completedBill.queuedOffline) {
      w.document.write(buildOfflineReceiptHtml(completedBill.offlineSale as QueuedOfflineSale));
    } else {
      await api.post(`/sales/${completedBill.id}/mark-printed`).catch(() => {});
      const detail = await api.get(`/sales/${completedBill.id}`);
      w.document.write(buildReceiptHtml(detail));
    }
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 2 }}>
        <h2 style={{ marginTop: 0 }}>Counter billing</h2>
        <OfflineBanner offline={offline} />

        {completedBill && (
          <div className="card" style={{ background: completedBill.queuedOffline ? "color-mix(in srgb, var(--status-warn, orange) 12%, white)" : "color-mix(in srgb, var(--status-good) 10%, white)", marginBottom: 16 }}>
            {completedBill.queuedOffline && <p style={{ margin: "0 0 4px", fontWeight: 700 }}>Queued offline — will sync when reconnected</p>}
            <p style={{ margin: 0, fontWeight: 700 }}>Bill {completedBill.billNumber} completed — ₹{completedBill.grandTotal}</p>
            {completedBill.changeDue > 0 && <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>Change due: ₹{completedBill.changeDue}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn-primary" onClick={printReceipt}>Print receipt</button>
              {!completedBill.queuedOffline && (
                <button className="btn-secondary" disabled={whatsappBusy || !completedBill.customerPhone} onClick={sendWhatsApp}>
                  {whatsappBusy ? "Sending…" : "Send via WhatsApp"}
                </button>
              )}
              {completedBill.queuedOffline && <span className="hint-text">WhatsApp send will be available once this bill syncs</span>}
              {!completedBill.queuedOffline && !completedBill.customerPhone && <span className="hint-text">No customer phone on this bill</span>}
            </div>
            {whatsappStatus && <p className="hint-text" style={{ marginTop: 6 }}>{whatsappStatus}</p>}
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
              {offline.isOnline ? (
                <SearchBar context="pos" onSelect={addLine} onRequestBook={(p) => setRequestModalProduct({ id: p.id, name: p.name })} autoFocus />
              ) : (
                <OfflineProductPicker onSelect={addLine} />
              )}
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
              <div className="field" style={{ position: "relative" }}>
                <label>Prescriber name</label>
                <input value={prescriberName} onChange={(e) => searchPrescribers(e.target.value)} placeholder="Start typing to search…" />
                {prescriberId && <span className="badge badge-info" style={{ marginLeft: 6 }}>Matched</span>}
                {prescriberSuggestions.length > 0 && (
                  <div className="card" style={{ position: "absolute", zIndex: 5, top: "100%", left: 0, minWidth: 240, padding: 4 }}>
                    {prescriberSuggestions.map((p) => (
                      <div key={p.id} style={{ padding: "4px 6px", cursor: "pointer" }} onClick={() => selectPrescriber(p)}>
                        {p.name} {p.clinic_or_hospital && <span className="hint-text">· {p.clinic_or_hospital}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
            <select value={tenderType} onChange={(e) => { setTenderType(e.target.value as any); setCreditBalance(null); }} style={{ width: "100%" }}>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="credit">Credit (khata)</option>
            </select>
          </div>
          {tenderType === "credit" && (
            <div className="field">
              {!customerPhone && <p className="hint-text" style={{ margin: "4px 0" }}>Credit sales need a customer phone number (above).</p>}
              <button className="btn-secondary" type="button" disabled={!customerPhone || creditBalanceLoading} onClick={checkCreditBalance}>
                {creditBalanceLoading ? "Checking…" : "Check credit balance"}
              </button>
              {creditBalance && (
                <p style={{ margin: "6px 0 0" }}>
                  Outstanding: <strong className={creditBalance.overLimit ? "stock-out" : ""}>₹{creditBalance.balance.toFixed(2)}</strong>
                  {creditBalance.creditLimit !== null && ` of ₹${creditBalance.creditLimit.toFixed(2)} limit`}
                  {creditBalance.overLimit && <span className="error-text" style={{ display: "block" }}>Already over limit.</span>}
                </p>
              )}
            </div>
          )}
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

// Section 6A.9 / Section 11 offline mode. `isOnline` is the honest
// signal a web tab actually has (browser online/offline events); real
// pending-sale count and last-sync outcome come from the local outbox,
// not guessed.
function OfflineBanner({ offline }: { offline: ReturnType<typeof useOfflineSync> }) {
  const [snapshotAge, setSnapshotAge] = useState<string | null>(null);
  useEffect(() => {
    getSnapshotMeta().then((meta) => setSnapshotAge(meta ? new Date(meta.refreshedAt).toLocaleString("en-IN") : null));
  }, [offline.isOnline]);

  if (offline.isOnline && offline.pendingCount === 0) return null;

  return (
    <div className="card" style={{ background: offline.isOnline ? "color-mix(in srgb, var(--status-info) 10%, white)" : "color-mix(in srgb, var(--status-warn, orange) 12%, white)", marginBottom: 12 }}>
      {!offline.isOnline && (
        <p style={{ margin: 0, fontWeight: 700 }}>
          Offline — billing against the cached catalogue{snapshotAge ? ` (last synced ${snapshotAge})` : ""}. Sales will queue and sync automatically once reconnected.
        </p>
      )}
      {offline.pendingCount > 0 && (
        <p style={{ margin: offline.isOnline ? 0 : "4px 0 0" }}>
          {offline.pendingCount} sale{offline.pendingCount === 1 ? "" : "s"} queued, not yet synced.
          {offline.isOnline && (
            <button className="btn-secondary" style={{ marginLeft: 8 }} disabled={offline.syncing} onClick={() => offline.runSync()}>
              {offline.syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
        </p>
      )}
      {offline.lastSync && offline.lastSync.conflictCount > 0 && (
        <p className="hint-text" style={{ margin: "4px 0 0" }}>
          {offline.lastSync.conflictCount} sale{offline.lastSync.conflictCount === 1 ? "" : "s"} could not sync as-is — see Sync conflicts on the Reports screen.
        </p>
      )}
    </div>
  );
}

function OfflineProductPicker({ onSelect }: { onSelect: (p: any) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SnapshotProduct[]>([]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    searchSnapshotProducts(query).then(setResults);
  }, [query]);

  return (
    <div>
      <p className="hint-text" style={{ marginTop: 0 }}>Offline — searching the cached catalogue only.</p>
      <input className="search-bar" placeholder="Search cached products…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus style={{ width: "100%" }} />
      {results.map((p) => {
        const nearestBatch = [...p.batches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))[0];
        const stock = p.batches.reduce((sum, b) => sum + b.quantityBaseUnits, 0);
        return (
          <div key={p.id} className="card offline-product-result" style={{ marginTop: 6, cursor: "pointer" }} onClick={() => onSelect({ id: p.id, name: p.name, manufacturer: p.manufacturer, packSize: p.packSize, baseUnit: p.baseUnit, mrp: nearestBatch?.mrp ?? 0, scheduleCategory: p.scheduleCategory, isColdChain: false })}>
            <strong>{p.name}</strong> — {p.manufacturer}
            <div className="hint-text">Stock (cached): {stock} {p.baseUnit}(s) · MRP ₹{nearestBatch?.mrp?.toFixed(2) ?? "—"}</div>
          </div>
        );
      })}
      {query.trim() && results.length === 0 && <p className="hint-text">No match in the cached catalogue.</p>}
    </div>
  );
}
