import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useWebManualOverride, WebManualOverrideFields } from "../components/WebManualOverride.js";

/**
 * Section 7: pick list generation (walk-path sorted, FEFO batch shown to
 * the picker for scan/confirm), short-pick handling with substitute
 * lookup, and packing verify (blind scan against the pick list). Section
 * 6A.8: completing packing generates the delivery invoice.
 */
export default function PickPackPage() {
  const [tab, setTab] = useState<"pickpack" | "returns">("pickpack");
  const [orders, setOrders] = useState<any[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function load() {
    const active = await api.get("/orders/active");
    setOrders(active.filter((o: any) => ["customer_confirmed", "picking", "picked"].includes(o.status)));
  }
  useEffect(() => { load(); }, []);

  if (selectedId) return <OrderPickPack orderId={selectedId} onBack={() => { setSelectedId(null); load(); }} />;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Pick &amp; pack</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "pickpack" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("pickpack")}>Pick &amp; pack</button>
        <button className={tab === "returns" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("returns")}>Returns to store</button>
      </div>
      {tab === "pickpack" && (
        <>
          <button className="btn-secondary" onClick={load} style={{ marginBottom: 8 }}>Refresh</button>
          <div className="card">
            <table className="data-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Status</th></tr></thead>
              <tbody>
                {orders?.map((o) => (
                  <tr key={o.id} style={{ cursor: "pointer" }} onClick={() => setSelectedId(o.id)}>
                    <td>{o.order_number}</td>
                    <td>{o.customer_name}</td>
                    <td>{o.status}</td>
                  </tr>
                ))}
                {orders && orders.length === 0 && <tr><td colSpan={3} className="hint-text">Nothing waiting to be picked or packed.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === "returns" && <ReturnsToStoreTab />}
    </div>
  );
}

function OrderPickPack({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { setData(await api.get(`/orders/${orderId}`)); }
  useEffect(() => { load(); }, [orderId]);

  async function act(fn: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Action failed.") : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div>Loading…</div>;
  const { order, pickLines } = data;

  return (
    <div>
      <button className="btn-secondary" onClick={onBack} style={{ marginBottom: 12 }}>← Back</button>
      <h2 style={{ marginTop: 0 }}>{order.order_number} — {order.status}</h2>
      <p className="hint-text">{order.customer_name} · {order.customer_phone} · {order.delivery_address ?? ""} {order.delivery_pincode ?? ""}</p>
      {error && <p className="error-text">{error}</p>}

      {order.status === "customer_confirmed" && (
        <button className="btn-primary" disabled={busy} onClick={() => act(async () => {
          const res = await api.post(`/orders/${orderId}/start-picking`);
          if (res.status === "awaiting_prescription") setError("This order needs prescription verification first — see Delivery orders.");
        })}>
          Start picking
        </button>
      )}

      {order.status === "picking" && <PickList orderId={orderId} pickLines={pickLines} onChanged={load} />}
      {order.status === "picked" && <PackChecklist orderId={orderId} pickLines={pickLines} onChanged={load} />}
      {["packed", "partially_available"].includes(order.status) && <p>Packed. Sale generated — see Delivery orders for status.</p>}
    </div>
  );
}

function PickList({ orderId, pickLines, onChanged }: { orderId: string; pickLines: any[]; onChanged: () => void }) {
  const allConfirmed = pickLines.length > 0 && pickLines.every((p) => p.scanned_confirmed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const override = useWebManualOverride();

  async function completePicking() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/complete-picking`, { deviceId: "web-console", reasonCode: override.reasonCode, note: override.note });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not complete picking.") : "Could not complete picking.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="hint-text">Sorted by bin walk path — pick in this order. The system already chose the batch (FEFO); confirm it matches what's on the shelf.</p>
      {error && <p className="error-text">{error}</p>}
      <table className="data-table">
        <thead><tr><th>#</th><th>Item</th><th>Bin</th><th>Batch</th><th>Expiry</th><th>Qty</th><th></th></tr></thead>
        <tbody>
          {pickLines.map((pl) => <PickLineRow key={pl.id} orderId={orderId} pickLine={pl} onChanged={onChanged} />)}
        </tbody>
      </table>
      {allConfirmed && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <p className="hint-text" style={{ margin: 0 }}>No scanner on web (Section 10.1) — confirming this picking session needs a reason:</p>
          <WebManualOverrideFields reasonCode={override.reasonCode} setReasonCode={override.setReasonCode} note={override.note} setNote={override.setNote} />
        </div>
      )}
      <button className="btn-primary" disabled={!allConfirmed || !override.valid || busy} onClick={completePicking} style={{ marginTop: 12 }}>
        {allConfirmed ? "Complete picking" : "Confirm every line to continue"}
      </button>
    </div>
  );
}

function PickLineRow({ orderId, pickLine, onChanged }: { orderId: string; pickLine: any; onChanged: () => void }) {
  const [scanValue, setScanValue] = useState("");
  const [showShort, setShowShort] = useState(false);
  const [actualFound, setActualFound] = useState("0");
  const [shortReason, setShortReason] = useState("");
  const [substitutes, setSubstitutes] = useState<any[] | null>(null);
  const [shortfall, setShortfall] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/pick-lines/${pickLine.id}/confirm`, { scannedBatchNo: scanValue });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Batch doesn't match.") : "Batch doesn't match.");
    } finally {
      setBusy(false);
    }
  }

  async function submitShort() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/orders/pick-lines/${pickLine.id}/short`, { actualFound: Number(actualFound), shortReason });
      setSubstitutes(res.substitutes);
      setShortfall(res.shortfall);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not record short pick.") : "Could not record short pick.");
    } finally {
      setBusy(false);
    }
  }

  async function applySubstitute(productId: string, qty: number) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/pick-lines/${pickLine.id}/substitute`, { newProductId: productId, shortfallQuantity: qty });
      setShowShort(false);
      setSubstitutes(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not apply substitute.") : "Could not apply substitute.");
    } finally {
      setBusy(false);
    }
  }

  if (pickLine.scanned_confirmed) {
    return (
      <tr>
        <td>{pickLine.walk_sequence}</td>
        <td>{pickLine.product_name}{pickLine.short_picked && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Short</span>}</td>
        <td>{pickLine.bin_code}</td>
        <td>{pickLine.batch_no}</td>
        <td>{new Date(pickLine.expiry_date).toLocaleDateString("en-IN")}</td>
        <td>{pickLine.actual_quantity_found ?? pickLine.quantity_base_units}</td>
        <td><span className="badge badge-good">Confirmed</span></td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{pickLine.walk_sequence}</td>
      <td>{pickLine.product_name}</td>
      <td>{pickLine.bin_code}</td>
      <td>{pickLine.batch_no}</td>
      <td>{new Date(pickLine.expiry_date).toLocaleDateString("en-IN")}</td>
      <td>{pickLine.quantity_base_units}</td>
      <td>
        {error && <div className="error-text">{error}</div>}
        {!showShort && (
          <>
            <input placeholder="Scan/type batch no." value={scanValue} onChange={(e) => setScanValue(e.target.value)} style={{ width: 140 }} />
            <button className="btn-secondary" disabled={busy} onClick={confirm}>Confirm</button>{" "}
            <button className="btn-secondary" disabled={busy} onClick={() => setShowShort(true)}>Short pick</button>
          </>
        )}
        {showShort && (
          <div>
            <input type="number" placeholder="Qty actually found" value={actualFound} onChange={(e) => setActualFound(e.target.value)} style={{ width: 80 }} />
            <input placeholder="Reason" value={shortReason} onChange={(e) => setShortReason(e.target.value)} style={{ width: 140 }} />
            <button className="btn-secondary" disabled={busy} onClick={submitShort}>Record</button>
            {substitutes && substitutes.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <p className="hint-text">Shortfall: {shortfall}. In-stock substitutes:</p>
                {substitutes.map((s) => (
                  <div key={s.id}>
                    {s.name} ({s.stock_base_units} in stock){" "}
                    <button className="btn-secondary" onClick={() => applySubstitute(s.id, Math.min(shortfall, s.stock_base_units))}>Use this</button>
                  </div>
                ))}
              </div>
            )}
            {substitutes && substitutes.length === 0 && <p className="hint-text">No in-stock substitute — order will go partial for this item.</p>}
          </div>
        )}
      </td>
    </tr>
  );
}

function PackChecklist({ orderId, pickLines, onChanged }: { orderId: string; pickLines: any[]; onChanged: () => void }) {
  const allPacked = pickLines.length > 0 && pickLines.every((p) => p.packed_confirmed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const override = useWebManualOverride();

  async function completePacking() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/complete-packing`, { deviceId: "web-console", reasonCode: override.reasonCode, note: override.note });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not complete packing.") : "Could not complete packing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="hint-text">Blind verify — scan or search each item at the packing bench; quantity isn't shown until it's confirmed.</p>
      {error && <p className="error-text">{error}</p>}
      <table className="data-table">
        <thead><tr><th>#</th><th>Item</th><th></th></tr></thead>
        <tbody>
          {pickLines.map((pl) => <PackLineRow key={pl.id} pickLine={pl} onChanged={onChanged} />)}
        </tbody>
      </table>
      {allPacked && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <p className="hint-text" style={{ margin: 0 }}>No scanner on web (Section 10.1) — confirming this packing session needs a reason:</p>
          <WebManualOverrideFields reasonCode={override.reasonCode} setReasonCode={override.setReasonCode} note={override.note} setNote={override.setNote} />
        </div>
      )}
      <button className="btn-primary" disabled={!allPacked || !override.valid || busy} onClick={completePacking} style={{ marginTop: 12 }}>
        {allPacked ? "Complete packing" : "Confirm every line to continue"}
      </button>
    </div>
  );
}

function PackLineRow({ pickLine, onChanged }: { pickLine: any; onChanged: () => void }) {
  const [scanValue, setScanValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.get(`/search?q=${encodeURIComponent(scanValue)}&context=delivery_order`);
      if (res.mode !== "barcode" || !res.exactProductId) throw new Error("not_recognized");
      await api.post(`/orders/pick-lines/${pickLine.id}/pack-scan`, { scannedProductId: res.exactProductId });
      onChanged();
    } catch {
      setError("Barcode not recognized as this item.");
    } finally {
      setBusy(false);
    }
  }

  if (pickLine.packed_confirmed) {
    return <tr><td>{pickLine.walk_sequence}</td><td>{pickLine.product_name}</td><td><span className="badge badge-good">Packed</span></td></tr>;
  }

  return (
    <tr>
      <td>{pickLine.walk_sequence}</td>
      <td>Item #{pickLine.walk_sequence}</td>
      <td>
        {error && <div className="error-text">{error}</div>}
        <input placeholder="Scan barcode" value={scanValue} onChange={(e) => setScanValue(e.target.value)} style={{ width: 140 }} />
        <button className="btn-secondary" disabled={busy} onClick={confirm}>Confirm</button>
      </td>
    </tr>
  );
}

// Section 8: "Failed deliveries generate a return-to-store task -> items
// must be scanned back into their bins, not silently restocked."
function ReturnsToStoreTab() {
  const [tasks, setTasks] = useState<any[] | null>(null);
  async function load() { setTasks(await api.get("/delivery-returns")); }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <p className="hint-text">Items coming back from a failed delivery — scan/type the bin they're actually going into, never assume the suggestion.</p>
      <button className="btn-secondary" onClick={load} style={{ marginBottom: 8 }}>Refresh</button>
      <table className="data-table">
        <thead><tr><th>Order</th><th>Item</th><th>Batch</th><th>Qty</th><th>Suggested bin</th><th></th></tr></thead>
        <tbody>
          {tasks?.map((t) => <ReturnTaskRow key={t.id} task={t} onChanged={load} />)}
          {tasks && tasks.length === 0 && <tr><td colSpan={6} className="hint-text">No pending returns.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ReturnTaskRow({ task, onChanged }: { task: any; onChanged: () => void }) {
  const [binCode, setBinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!binCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/delivery-returns/${task.id}/confirm`, { scannedBinCode: binCode.trim(), deviceId: "web-console" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not confirm.") : "Could not confirm.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{task.order_number}</td>
      <td>{task.product_name}</td>
      <td>{task.batch_no}</td>
      <td>{task.quantity_base_units}</td>
      <td>{task.suggested_bin_code ?? "—"}</td>
      <td>
        {error && <div className="error-text">{error}</div>}
        <input placeholder="Scan/type bin code" value={binCode} onChange={(e) => setBinCode(e.target.value)} style={{ width: 140 }} />
        <button className="btn-secondary" disabled={busy} onClick={confirm}>Confirm</button>
      </td>
    </tr>
  );
}
