import { useState } from "react";
import { api } from "../api.js";
import SearchBar from "./SearchBar.js";

interface PickedProduct {
  id: string;
  name: string;
}

/**
 * Section 6B.1 intake — three cases in one form: known SKU (picked via the
 * same unified search everywhere else), unknown item (free text), and the
 * "customer already has it in hand, wants more" case is just a known-SKU
 * request too. `initialProduct` pre-fills case 1 when opened from search's
 * "+ Request book" button on an out-of-stock result.
 */
export default function RequestFormModal({
  initialProduct = null,
  onClose,
  onCreated,
}: {
  initialProduct?: PickedProduct | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [product, setProduct] = useState<PickedProduct | null>(initialProduct);
  const [freeTextItem, setFreeTextItem] = useState("");
  const [pickingProduct, setPickingProduct] = useState(!initialProduct);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [quantityRequestedUnits, setQuantityRequestedUnits] = useState<number | "">("");
  const [quantityRequestedNote, setQuantityRequestedNote] = useState("");
  const [urgency, setUrgency] = useState<"urgent" | "normal" | "can_wait">("normal");
  const [hasPrescriptionInHand, setHasPrescriptionInHand] = useState(false);
  const [expectedDate, setExpectedDate] = useState("");
  const [note, setNote] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = customerName.trim() && customerPhone.trim() && (product || freeTextItem.trim());

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post("/requests", {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        productId: product?.id ?? null,
        freeTextItem: product ? null : freeTextItem.trim(),
        quantityRequestedUnits: quantityRequestedUnits === "" ? null : quantityRequestedUnits,
        quantityRequestedNote: quantityRequestedNote || null,
        urgency,
        hasPrescriptionInHand,
        expectedDate: expectedDate || null,
        note: note || null,
        deviceId: "web-console",
      });
      if (result.warning) {
        setWarning(result.warning);
        setBusy(false);
        return;
      }
      onCreated();
    } catch {
      setError("Could not log the request — check the fields and try again.");
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 480, maxHeight: "90vh", overflowY: "auto", background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Log a customer request</h3>

        {warning && (
          <div className="card" style={{ background: "color-mix(in srgb, var(--status-warn) 12%, white)", marginBottom: 12 }}>
            <p style={{ margin: 0 }}>{warning}</p>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={onCreated}>Log it anyway</button>
            <button className="btn-secondary" style={{ marginTop: 8, marginLeft: 8 }} onClick={onClose}>Cancel</button>
          </div>
        )}

        {!warning && (
          <>
            <div className="field">
              <label>Item</label>
              {product ? (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                  <strong>{product.name}</strong>
                  <button className="btn-secondary" onClick={() => { setProduct(null); setPickingProduct(true); }}>Change</button>
                </div>
              ) : pickingProduct ? (
                <>
                  <SearchBar
                    context="request_book"
                    onSelect={(p) => { setProduct({ id: p.id, name: p.name }); setPickingProduct(false); }}
                  />
                  <button className="btn-secondary" style={{ marginTop: 6 }} onClick={() => setPickingProduct(false)}>
                    Can't find it — log as free text instead
                  </button>
                </>
              ) : (
                <>
                  <input style={{ width: "100%" }} placeholder="What the customer asked for" value={freeTextItem} onChange={(e) => setFreeTextItem(e.target.value)} />
                  <button className="btn-secondary" style={{ marginTop: 6 }} onClick={() => setPickingProduct(true)}>Search catalogue instead</button>
                </>
              )}
            </div>

            <div className="field"><label>Customer name</label><input style={{ width: "100%" }} value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></div>
            <div className="field"><label>Customer phone (drives the callback)</label><input style={{ width: "100%" }} value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} /></div>

            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Quantity (units)</label>
                <input type="number" style={{ width: "100%" }} value={quantityRequestedUnits} onChange={(e) => setQuantityRequestedUnits(e.target.value === "" ? "" : Number(e.target.value))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Quantity as told (e.g. "2 strips")</label>
                <input style={{ width: "100%" }} value={quantityRequestedNote} onChange={(e) => setQuantityRequestedNote(e.target.value)} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Urgency</label>
                <select style={{ width: "100%" }} value={urgency} onChange={(e) => setUrgency(e.target.value as any)}>
                  <option value="urgent">Urgent</option>
                  <option value="normal">Normal</option>
                  <option value="can_wait">Can wait</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Expected by (optional)</label>
                <input type="date" style={{ width: "100%" }} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
              </div>
            </div>

            <div className="field">
              <label><input type="checkbox" checked={hasPrescriptionInHand} onChange={(e) => setHasPrescriptionInHand(e.target.checked)} /> Has prescription in hand</label>
            </div>
            <div className="field"><label>Note</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>

            {error && <p className="error-text">{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={!canSubmit || busy} onClick={submit}>{busy ? "Logging…" : "Log request"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
