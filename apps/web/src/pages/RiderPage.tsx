import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useWebManualOverride, WebManualOverrideFields } from "../components/WebManualOverride.js";

const FAILURE_REASONS: Array<{ code: string; label: string }> = [
  { code: "customer_unavailable", label: "Customer unavailable" },
  { code: "wrong_address", label: "Wrong address" },
  { code: "refused", label: "Refused" },
  { code: "payment_failed", label: "Payment failed" },
  { code: "rx_invalid", label: "Rx invalid" },
];

// Section 8: "Capture GPS ping... every 60s in-transit." Best-effort,
// browser-tab-scoped — same honesty as M5's daily review alarm: this
// only runs while the rider's tab is open and location permission is
// granted, there is no always-on background tracking without a native
// app (Section 13's Android app, not built yet).
function useInTransitGpsPings(orderId: string | null) {
  useEffect(() => {
    if (!orderId || !navigator.geolocation) return;
    const ping = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          api.post(`/rider/orders/${orderId}/gps-ping`, { lat: pos.coords.latitude, lng: pos.coords.longitude, kind: "in_transit" }).catch(() => {});
        },
        () => {},
        { timeout: 5000 }
      );
    };
    const interval = setInterval(ping, 60_000);
    return () => clearInterval(interval);
  }, [orderId]);
}

function getGpsOnce(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 5000 }
    );
  });
}

/**
 * Section 8: rider/dispatch module. "Rider logs in, sees assigned trips
 * only" — everything here is scoped server-side to the logged-in rider.
 */
export default function RiderPage() {
  const [tab, setTab] = useState<"trips" | "cash">("trips");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>My trips</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "trips" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("trips")}>Trips</button>
        <button className={tab === "cash" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("cash")}>End-of-shift cash</button>
      </div>
      {tab === "trips" && <TripsTab />}
      {tab === "cash" && <CashReconciliationTab />}
    </div>
  );
}

function TripsTab() {
  const [orders, setOrders] = useState<any[] | null>(null);
  const [scanValue, setScanValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { setOrders(await api.get("/rider/orders")); }
  useEffect(() => { load(); }, []);

  const outForDelivery = orders?.find((o) => o.status === "out_for_delivery") ?? null;
  useInTransitGpsPings(outForDelivery?.id ?? null);
  const override = useWebManualOverride();

  async function handover() {
    if (!scanValue.trim() || !override.valid) return;
    setBusy(true);
    setError(null);
    try {
      const gps = await getGpsOnce();
      await api.post("/rider/handover", {
        orderNumber: scanValue.trim(),
        gps,
        deviceId: "web-console",
        reasonCode: override.reasonCode,
        note: override.note,
      });
      setScanValue("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not scan.") : "Could not scan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <p className="hint-text">Scan (or type) the order label at the store to mark handover. No scanner on web (Section 10.1) — a reason is required.</p>
        <input placeholder="Order number, e.g. ORD-000005" value={scanValue} onChange={(e) => setScanValue(e.target.value)} style={{ width: 240, marginBottom: 6 }} />
        <div>
          <WebManualOverrideFields reasonCode={override.reasonCode} setReasonCode={override.setReasonCode} note={override.note} setNote={override.setNote} />
        </div>
        <button className="btn-primary" disabled={busy || !scanValue.trim() || !override.valid} onClick={handover} style={{ marginTop: 8 }}>Handover scan</button>
        {error && <p className="error-text">{error}</p>}
      </div>

      {orders?.map((o) => <TripCard key={o.id} order={o} onChanged={load} />)}
      {orders && orders.length === 0 && <p className="hint-text">No trips assigned right now.</p>}
    </div>
  );
}

function TripCard({ order, onChanged }: { order: any; onChanged: () => void }) {
  const [showDelivered, setShowDelivered] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tenderType, setTenderType] = useState<"cash" | "upi">("cash");
  const [amountCollected, setAmountCollected] = useState("");
  const [proofNote, setProofNote] = useState("");

  const [failureReason, setFailureReason] = useState(FAILURE_REASONS[0]!.code);
  const [failureNote, setFailureNote] = useState("");

  async function act(fn: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Action failed.") : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function markReached() {
    await act(() => api.post(`/rider/orders/${order.id}/reached`));
  }

  async function markDelivered() {
    if (!amountCollected || !proofNote.trim()) return setError("Enter the collected amount and a delivery proof note.");
    const gps = await getGpsOnce();
    await act(() => api.post(`/rider/orders/${order.id}/delivered`, {
      tenderType, amountCollected: Number(amountCollected), deliveryProofNote: proofNote, gps,
    }));
  }

  async function markFailed() {
    if (!failureNote.trim()) return setError("Add a note explaining the failure.");
    await act(() => api.post(`/rider/orders/${order.id}/failed`, { reasonCode: failureReason, note: failureNote }));
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>{order.order_number} — {order.status}</h3>
      <p className="hint-text">{order.customer_name} · {order.customer_phone} · {order.delivery_address ?? ""} {order.delivery_pincode ?? ""}</p>
      {error && <p className="error-text">{error}</p>}

      {order.status === "assigned" && <p className="hint-text">Scan handover above to start this trip.</p>}

      {order.status === "out_for_delivery" && (
        <div>
          {!order.reached_at && <button className="btn-secondary" disabled={busy} onClick={markReached}>Mark reached</button>}
          {order.reached_at && !showDelivered && !showFailed && (
            <>
              <button className="btn-primary" disabled={busy} onClick={() => setShowDelivered(true)}>Mark delivered</button>{" "}
              <button className="btn-secondary" disabled={busy} onClick={() => setShowFailed(true)}>Mark failed</button>
            </>
          )}
          {showDelivered && (
            <div style={{ marginTop: 8 }}>
              <div className="field">
                <label>Collected via</label>
                <select value={tenderType} onChange={(e) => setTenderType(e.target.value as any)}>
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                </select>
              </div>
              <div className="field"><label>Amount collected</label><input type="number" value={amountCollected} onChange={(e) => setAmountCollected(e.target.value)} style={{ width: 120 }} /></div>
              <div className="field"><label>Delivery proof (OTP / signature note)</label><input value={proofNote} onChange={(e) => setProofNote(e.target.value)} style={{ width: 260 }} /></div>
              <button className="btn-primary" disabled={busy} onClick={markDelivered}>Confirm delivered</button>{" "}
              <button className="btn-secondary" disabled={busy} onClick={() => setShowDelivered(false)}>Cancel</button>
            </div>
          )}
          {showFailed && (
            <div style={{ marginTop: 8 }}>
              <div className="field">
                <label>Reason</label>
                <select value={failureReason} onChange={(e) => setFailureReason(e.target.value)}>
                  {FAILURE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </div>
              <div className="field"><label>Note</label><input value={failureNote} onChange={(e) => setFailureNote(e.target.value)} style={{ width: 260 }} /></div>
              <button className="btn-primary" disabled={busy} onClick={markFailed}>Confirm failed</button>{" "}
              <button className="btn-secondary" disabled={busy} onClick={() => setShowFailed(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function CashReconciliationTab() {
  const [businessDate, setBusinessDate] = useState(todayIso());
  const [preview, setPreview] = useState<{ expectedCash: number } | null>(null);
  const [declaredCash, setDeclaredCash] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPreview() {
    setPreview(await api.get(`/rider/cash/preview?businessDate=${businessDate}`));
  }
  useEffect(() => { loadPreview(); }, [businessDate]);

  async function close() {
    if (!declaredCash) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/rider/cash/close", { businessDate, declaredCash: Number(declaredCash), note: note || null, deviceId: "rider-web" });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not close shift.") : "Could not close shift.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <p className="hint-text">Expected cash is computed from what the system recorded as collected today — declare what you're actually handing in.</p>
      <div className="field"><label>Business date</label><input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} /></div>
      {preview && <p>Expected cash: <strong>₹{preview.expectedCash.toFixed(2)}</strong></p>}
      <div className="field"><label>Declared cash</label><input type="number" value={declaredCash} onChange={(e) => setDeclaredCash(e.target.value)} style={{ width: 120 }} /></div>
      <div className="field"><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 260 }} /></div>
      {error && <p className="error-text">{error}</p>}
      <button className="btn-primary" disabled={busy || !declaredCash} onClick={close}>Close shift</button>
      {result && (
        <div className="card" style={{ marginTop: 12, background: result.variance !== 0 ? "color-mix(in srgb, var(--status-warn, orange) 12%, white)" : undefined }}>
          <p>Expected ₹{result.expectedCash.toFixed(2)} · Declared ₹{result.declaredCash.toFixed(2)} · Variance ₹{result.variance.toFixed(2)}</p>
          {result.variance !== 0 && <p className="hint-text">Variance flagged — visible to Manager/Owner.</p>}
        </div>
      )}
    </div>
  );
}
