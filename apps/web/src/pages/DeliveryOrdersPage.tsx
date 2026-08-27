import { useEffect, useState } from "react";
import { api, ApiError, apiPdfUrl, downloadFile, getTokens, postForm } from "../api.js";
import SearchBar from "../components/SearchBar.js";

interface CatalogLine {
  productId: string;
  name: string;
  quantityRequestedUnits: number;
}

const STATUS_LABEL: Record<string, string> = {
  received: "Received",
  under_review: "Under review",
  quoted: "Quoted — awaiting customer",
  customer_confirmed: "Confirmed",
  awaiting_prescription: "Awaiting Rx verification",
  picking: "Picking",
  picked: "Picked",
  packed: "Packed",
  partially_available: "Packed — partial",
  rejected: "Declined",
  cancelled: "Cancelled",
  assigned: "Assigned to rider",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
};

/**
 * Section 7 delivery order entry + Section 7A unstructured-order review
 * queue. Customer-app screens are out of scope (Section 2) — this is
 * staff building/reviewing orders on the customer's behalf, per Section
 * 7's own "orders arrive from... WhatsApp/phone entered manually by the
 * Manager."
 */
export default function DeliveryOrdersPage() {
  const [tab, setTab] = useState<"new" | "queue" | "active" | "all">("queue");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  if (selectedOrderId) {
    return <OrderReview orderId={selectedOrderId} onBack={() => setSelectedOrderId(null)} />;
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Delivery orders</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "queue" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("queue")}>Pending review</button>
        <button className={tab === "active" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("active")}>Active orders</button>
        <button className={tab === "all" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("all")}>All orders</button>
        <button className={tab === "new" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("new")}>+ New order</button>
      </div>
      {tab === "queue" && <PendingQueue onOpen={setSelectedOrderId} />}
      {tab === "active" && <ActiveOrders onOpen={setSelectedOrderId} />}
      {tab === "all" && <AllOrdersTab onOpen={setSelectedOrderId} />}
      {tab === "new" && <NewOrderForm onCreated={setSelectedOrderId} />}
    </div>
  );
}

/** Section 10.2: "full order list, filterable, exportable." */
function AllOrdersTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  function query() {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (search.trim()) params.set("search", search.trim());
    return params.toString();
  }

  async function load() {
    setRows(await api.get(`/orders?${query()}`));
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12, flexWrap: "wrap" }}>
        <div className="field">
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}>
            <option value="">All</option>
            {Object.keys(STATUS_LABEL).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field"><label>Search</label><input placeholder="order #, customer, phone" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} /></div>
        <button className="btn-primary" onClick={load}>Filter</button>
        <button className="btn-secondary" onClick={() => downloadFile(`/orders?${query()}&format=csv`, "orders.csv")}>Export CSV</button>
      </div>
      <table className="data-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Rider</th><th>Created</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>
              <td>{r.order_number}</td>
              <td>{r.customer_name} · {r.customer_phone}</td>
              <td>{STATUS_LABEL[r.status] ?? r.status}</td>
              <td>{r.rider_name ?? "—"}</td>
              <td>{new Date(r.created_at).toLocaleString()}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={5} className="hint-text">No orders match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AgeBadge({ level, minutes }: { level: string; minutes: number }) {
  const cls = level === "red" ? "badge-bad" : level === "amber" ? "badge-warn" : "badge-info";
  return <span className={`badge ${cls}`}>{minutes}m</span>;
}

function PendingQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get("/orders/pending")); }
  useEffect(() => { load(); }, []);

  return (
    <div className="card">
      <p className="hint-text">
        New orders land here — anything with unstructured content (free text or images) must be reviewed before it can
        be quoted or picked (Section 7A.2).
      </p>
      <button className="btn-secondary" onClick={load} style={{ marginBottom: 8 }}>Refresh</button>
      <table className="data-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Age</th><th>Rx</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>
              <td>{r.order_number}</td>
              <td>{r.customer_name} · {r.customer_phone}</td>
              <td>{STATUS_LABEL[r.status] ?? r.status}</td>
              <td><AgeBadge level={r.ageLevel} minutes={r.ageMinutes} /></td>
              <td>{r.rx_required ? <span className="badge badge-warn">Rx</span> : ""}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={5} className="hint-text">Nothing pending — all caught up.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ActiveOrders({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [riders, setRiders] = useState<Array<{ id: string; name: string; phone: string }>>([]);
  async function load() {
    setRows(await api.get("/orders/active"));
    setRiders(await api.get("/riders"));
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="card">
      <button className="btn-secondary" onClick={load} style={{ marginBottom: 8 }}>Refresh</button>
      <table className="data-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Pincode</th><th>Status</th><th>Rider</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>{r.order_number}</td>
              <td style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>{r.customer_name} · {r.customer_phone}</td>
              <td>{r.delivery_pincode ?? "—"}</td>
              <td>{STATUS_LABEL[r.status] ?? r.status}{r.is_partial && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Partial</span>}</td>
              <td>
                {r.rider_name ? r.rider_name : ["packed", "partially_available"].includes(r.status) ? (
                  <AssignRiderControl orderId={r.id} riders={riders} onAssigned={load} />
                ) : "—"}
              </td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={5} className="hint-text">No orders in flight.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AssignRiderControl({ orderId, riders, onAssigned }: { orderId: string; riders: Array<{ id: string; name: string; phone: string }>; onAssigned: () => void }) {
  const [riderId, setRiderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign() {
    if (!riderId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/assign-rider`, { riderId });
      onAssigned();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not assign.") : "Could not assign.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <select value={riderId} onChange={(e) => setRiderId(e.target.value)} disabled={busy}>
        <option value="">Assign rider…</option>
        {riders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>{" "}
      <button className="btn-secondary" disabled={!riderId || busy} onClick={assign}>Assign</button>
      {error && <div className="error-text">{error}</div>}
    </span>
  );
}

function NewOrderForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryPincode, setDeliveryPincode] = useState("");
  const [deliveryCharge, setDeliveryCharge] = useState("0");
  const [freeTextNote, setFreeTextNote] = useState("");
  const [catalogLines, setCatalogLines] = useState<CatalogLine[]>([]);
  const [images, setImages] = useState<Array<{ file: File; kind: "prescription" | "strip_photo" | "other" }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addLineFromSearch(p: any) {
    setCatalogLines((lines) => [...lines, { productId: p.id, name: p.name, quantityRequestedUnits: p.packSize ?? 1 }]);
  }
  function updateQty(i: number, qty: number) {
    setCatalogLines((lines) => lines.map((l, idx) => (idx === i ? { ...l, quantityRequestedUnits: qty } : l)));
  }
  function removeLine(i: number) {
    setCatalogLines((lines) => lines.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setError(null);
    if (!customerName.trim() || !customerPhone.trim()) return setError("Customer name and phone are required.");
    if (catalogLines.length === 0 && !freeTextNote.trim() && images.length === 0) {
      return setError("Add at least one catalogue item, a free-text note, or an image.");
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("customerName", customerName);
      form.append("customerPhone", customerPhone);
      form.append("deliveryAddress", deliveryAddress);
      form.append("deliveryPincode", deliveryPincode);
      form.append("deliveryCharge", deliveryCharge);
      form.append("freeTextNote", freeTextNote);
      form.append("deviceId", "web-console");
      form.append("catalogLines", JSON.stringify(catalogLines.map((l) => ({ productId: l.productId, quantityRequestedUnits: l.quantityRequestedUnits }))));
      for (const img of images) {
        form.append("imageKind", img.kind);
        form.append("image", img.file);
      }
      const result = await postForm("/orders", form);
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not create order.") : "Could not create order.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <p className="hint-text">
        Section 7A: mixed orders are essential — catalogue items, a free-text note, and photos can all go on one order.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field"><label>Customer name</label><input value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></div>
        <div className="field"><label>Customer phone</label><input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} /></div>
        <div className="field"><label>Delivery address</label><input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} /></div>
        <div className="field"><label>Pincode</label><input value={deliveryPincode} onChange={(e) => setDeliveryPincode(e.target.value)} /></div>
        <div className="field"><label>Delivery charge</label><input type="number" value={deliveryCharge} onChange={(e) => setDeliveryCharge(e.target.value)} /></div>
      </div>

      <h3>Catalogue items</h3>
      <SearchBar context="delivery_order" onSelect={addLineFromSearch} />
      {catalogLines.length > 0 && (
        <table className="data-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Item</th><th>Quantity (base units)</th><th></th></tr></thead>
          <tbody>
            {catalogLines.map((l, i) => (
              <tr key={i}>
                <td>{l.name}</td>
                <td><input type="number" value={l.quantityRequestedUnits} onChange={(e) => updateQty(i, Number(e.target.value))} style={{ width: 80 }} /></td>
                <td><button className="btn-secondary" onClick={() => removeLine(i)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Can't find it? Type the order</h3>
      <div className="field" style={{ maxWidth: 500 }}>
        <label>Free-text note (as the customer said it)</label>
        <textarea rows={3} value={freeTextNote} onChange={(e) => setFreeTextNote(e.target.value)} placeholder="dolo 650 2 strip, cough syrup, band aid" />
      </div>

      <h3>Upload prescription / photo</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select id="new-image-kind" defaultValue="prescription">
          <option value="prescription">Prescription</option>
          <option value="strip_photo">Photo of strip/box</option>
          <option value="other">Other</option>
        </select>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const kind = (document.getElementById("new-image-kind") as HTMLSelectElement).value as any;
            setImages((imgs) => [...imgs, { file, kind }]);
            e.target.value = "";
          }}
        />
      </div>
      {images.length > 0 && (
        <ul>
          {images.map((img, i) => (
            <li key={i}>{img.file.name} ({img.kind}) <button className="btn-secondary" onClick={() => setImages((imgs) => imgs.filter((_, idx) => idx !== i))}>Remove</button></li>
          ))}
        </ul>
      )}

      {error && <p className="error-text">{error}</p>}
      <button className="btn-primary" disabled={busy} onClick={submit} style={{ marginTop: 12 }}>{busy ? "Creating…" : "Create order"}</button>
    </div>
  );
}

function useOrderImageUrl(imageId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!imageId) { setUrl(null); return; }
    let cancelled = false;
    let created: string | null = null;
    (async () => {
      const { accessToken } = getTokens();
      const res = await fetch(apiPdfUrl(`/orders/images/${imageId}`), { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return;
      const blob = await res.blob();
      created = URL.createObjectURL(blob);
      if (!cancelled) setUrl(created);
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [imageId]);
  return url;
}

function OrderImageThumb({ imageId, kind }: { imageId: string; kind: string }) {
  const [open, setOpen] = useState(false);
  const url = useOrderImageUrl(open ? imageId : null);
  return (
    <div className="card" style={{ display: "inline-block", marginRight: 8, marginBottom: 8, padding: 8 }}>
      <div className="hint-text">{kind}</div>
      {!open && <button className="btn-secondary" onClick={() => setOpen(true)}>View</button>}
      {open && url && <img src={url} alt={kind} style={{ maxWidth: 320, maxHeight: 420, display: "block" }} />}
    </div>
  );
}

const PRE_PICK_STATUSES = ["received", "under_review", "quoted", "customer_confirmed", "awaiting_prescription"];

function OrderReview({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deliveryCharge, setDeliveryCharge] = useState("0");
  const [addLineText, setAddLineText] = useState("");
  const [showAddCatalogLine, setShowAddCatalogLine] = useState(false);

  async function load() {
    setData(await api.get(`/orders/${orderId}`));
  }
  useEffect(() => { load(); }, [orderId]);

  if (!data) return <div>Loading…</div>;
  const { order, lines, images, messages, pickLines } = data;
  const editablePrePick = PRE_PICK_STATUSES.includes(order.status);

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

  async function addBlankLine() {
    if (!addLineText.trim()) return;
    await act(() => api.post(`/orders/${orderId}/lines`, { sourceType: "free_text", descriptionAsEntered: addLineText }));
    setAddLineText("");
  }

  async function addCatalogLine(p: any) {
    await act(() => api.post(`/orders/${orderId}/catalog-lines`, { productId: p.id, quantityRequestedUnits: p.packSize ?? 1 }));
    setShowAddCatalogLine(false);
  }

  return (
    <div>
      <button className="btn-secondary" onClick={onBack} style={{ marginBottom: 12 }}>← Back</button>
      <h2 style={{ marginTop: 0 }}>{order.order_number} — {STATUS_LABEL[order.status] ?? order.status}</h2>
      <p className="hint-text">{order.customer_name} · {order.customer_phone} · {order.delivery_address ?? "no address"} {order.delivery_pincode ?? ""}</p>
      {error && <p className="error-text">{error}</p>}

      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h3>Customer's input</h3>
          {order.free_text_note && <div className="card" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{order.free_text_note}</div>}
          {images.map((img: any) => <OrderImageThumb key={img.id} imageId={img.id} kind={img.kind} />)}
          {!order.free_text_note && images.length === 0 && <p className="hint-text">No unstructured content on this order.</p>}

          <h3>Conversation</h3>
          {messages.map((m: any) => (
            <div key={m.id} className="hint-text" style={{ marginBottom: 4 }}>
              <strong>{m.sender === "staff" ? (m.staff_name ?? "Staff") : "Customer"}:</strong> {m.body}
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }}>
          <h3>Order being assembled</h3>
          <table className="data-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {lines.map((l: any) => (
                <OrderLineRow key={l.id} orderId={orderId} line={l} onChanged={load} disabled={!editablePrePick} />
              ))}
            </tbody>
          </table>
          {["received", "under_review"].includes(order.status) && (
            <div style={{ marginTop: 8 }}>
              <input placeholder="Describe an item from the free text/image (e.g. cough syrup)" value={addLineText} onChange={(e) => setAddLineText(e.target.value)} style={{ width: 320 }} />
              <button className="btn-secondary" onClick={addBlankLine} disabled={busy}>+ Add line</button>
            </div>
          )}
          {editablePrePick && (
            <div style={{ marginTop: 8 }}>
              {showAddCatalogLine ? (
                <SearchBar context="delivery_order" onSelect={addCatalogLine} autoFocus />
              ) : (
                <button className="btn-secondary" onClick={() => setShowAddCatalogLine(true)} disabled={busy}>+ Add item from catalogue</button>
              )}
            </div>
          )}

          {order.rx_required && !order.rx_verified && editablePrePick && (
            <div className="card" style={{ marginTop: 12, background: "color-mix(in srgb, var(--status-warn, orange) 10%, white)" }}>
              <p>This order needs prescription verification before picking can start.</p>
              <button className="btn-primary" disabled={busy} onClick={() => act(() => api.post(`/orders/${orderId}/verify-prescription`))}>Mark prescription verified</button>
            </div>
          )}

          {["received", "under_review"].includes(order.status) && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="field"><label>Delivery charge</label><input type="number" value={deliveryCharge} onChange={(e) => setDeliveryCharge(e.target.value)} style={{ width: 100 }} /></div>
              <button className="btn-primary" disabled={busy} onClick={() => act(() => api.post(`/orders/${orderId}/quote`, { deliveryCharge: Number(deliveryCharge) }))}>Send quote</button>
            </div>
          )}

          {order.status === "quoted" && (
            <div className="card" style={{ marginTop: 12 }}>
              <p>Quote total: ₹{order.quote_total}</p>
              <button className="btn-primary" disabled={busy} onClick={() => act(() => api.post(`/orders/${orderId}/confirm`))}>Customer confirmed</button>
              <button className="btn-secondary" disabled={busy} onClick={() => act(() => api.post(`/orders/${orderId}/decline`, { reason: "Customer declined" }))} style={{ marginLeft: 8 }}>Customer declined</button>
            </div>
          )}

          {["picking", "picked", "packed", "partially_available"].includes(order.status) && pickLines.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <p className="hint-text">Pick/pack in progress — see the Pick &amp; Pack screen.</p>
            </div>
          )}

          <OrderActionsPanel order={order} busy={busy} act={act} />
        </div>
      </div>
    </div>
  );
}

const ORDER_CANCEL_REASON_CODES = ["customer_requested", "duplicate_order", "payment_issue", "out_of_stock", "other"];
const REASSIGNABLE_STATUSES = ["assigned", "out_for_delivery"];
const TERMINAL_ORDER_STATUSES = ["cancelled", "rejected", "delivered"];
const DISPATCHED_STATUSES = ["assigned", "out_for_delivery", "delivery_failed"];

/**
 * Section 10.2: cancel-with-reversal, force-reassign rider, and a refund
 * stub. Cancel/reassign are only offered pre-terminal; the refund section
 * stays visible on a terminal order too — a refund initiated against a
 * cancelled order is exactly the record the Owner still needs to see.
 */
function OrderActionsPanel({ order, busy, act }: { order: any; busy: boolean; act: (fn: () => Promise<any>) => Promise<void> }) {
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState(ORDER_CANCEL_REASON_CODES[0]);
  const [cancelNote, setCancelNote] = useState("");

  const [showReassign, setShowReassign] = useState(false);
  const [riders, setRiders] = useState<Array<{ id: string; name: string }>>([]);
  const [newRiderId, setNewRiderId] = useState("");
  const [reassignNote, setReassignNote] = useState("");

  const [showRefund, setShowRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refunds, setRefunds] = useState<any[] | null>(null);

  useEffect(() => {
    if (showReassign && riders.length === 0) api.get("/riders").then(setRiders);
  }, [showReassign]);

  async function loadRefunds() {
    setRefunds(await api.get(`/orders/${order.id}/refunds`));
  }
  useEffect(() => { loadRefunds(); }, [order.id]);

  const isTerminal = TERMINAL_ORDER_STATUSES.includes(order.status);
  const canCancel = !isTerminal && !DISPATCHED_STATUSES.includes(order.status);
  const showDispatchedNotice = !isTerminal && DISPATCHED_STATUSES.includes(order.status);

  async function cancel() {
    if (!cancelNote.trim()) return;
    await act(() => api.post(`/orders/${order.id}/cancel`, { reasonCode: cancelReason, note: cancelNote, deviceId: "web-console" }));
    setShowCancel(false);
    setCancelNote("");
  }

  async function reassign() {
    if (!newRiderId || !reassignNote.trim()) return;
    await act(() => api.post(`/orders/${order.id}/reassign-rider`, { riderId: newRiderId, note: reassignNote }));
    setShowReassign(false);
    setNewRiderId("");
    setReassignNote("");
  }

  async function submitRefund() {
    if (!refundAmount || Number(refundAmount) <= 0 || !refundReason.trim()) return;
    await act(async () => {
      await api.post(`/orders/${order.id}/refunds`, { amount: Number(refundAmount), reason: refundReason });
      await loadRefunds();
    });
    setShowRefund(false);
    setRefundAmount("");
    setRefundReason("");
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Order actions</h3>

      {canCancel && (
        <div style={{ marginBottom: 12 }}>
          {!showCancel ? (
            <button className="btn-secondary" disabled={busy} onClick={() => setShowCancel(true)}>Cancel order</button>
          ) : (
            <div>
              <div className="field">
                <label>Reason</label>
                <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ width: 200 }}>
                  {ORDER_CANCEL_REASON_CODES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Note (required)</label>
                <input value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} style={{ width: 320 }} />
              </div>
              <button className="btn-primary" disabled={busy || !cancelNote.trim()} onClick={cancel}>Confirm cancel</button>
              <button className="btn-secondary" disabled={busy} onClick={() => setShowCancel(false)} style={{ marginLeft: 8 }}>Never mind</button>
            </div>
          )}
        </div>
      )}
      {showDispatchedNotice && (
        <p className="hint-text">This order is already out for delivery — cancelling it here won't retrieve a package already in a rider's hands. Use the delivery-failure flow on the Rider screen instead.</p>
      )}

      {REASSIGNABLE_STATUSES.includes(order.status) && (
        <div style={{ marginBottom: 12 }}>
          {!showReassign ? (
            <button className="btn-secondary" disabled={busy} onClick={() => setShowReassign(true)}>Force-reassign rider</button>
          ) : (
            <div>
              <p className="hint-text">This only corrects the system record — it doesn't physically move a package already with {order.rider_name ?? "the current rider"}.</p>
              <div className="field">
                <label>New rider</label>
                <select value={newRiderId} onChange={(e) => setNewRiderId(e.target.value)} style={{ width: 200 }}>
                  <option value="">Select…</option>
                  {riders.filter((r) => r.id !== order.rider_id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Note (required)</label>
                <input value={reassignNote} onChange={(e) => setReassignNote(e.target.value)} style={{ width: 320 }} placeholder="e.g. original rider called in sick" />
              </div>
              <button className="btn-primary" disabled={busy || !newRiderId || !reassignNote.trim()} onClick={reassign}>Confirm reassignment</button>
              <button className="btn-secondary" disabled={busy} onClick={() => setShowReassign(false)} style={{ marginLeft: 8 }}>Never mind</button>
            </div>
          )}
        </div>
      )}

      <div>
        <h4 style={{ marginBottom: 4 }}>Refunds</h4>
        <p className="hint-text" style={{ marginTop: 0 }}>Stub only — records intent for the Owner to process manually. No payment gateway is connected.</p>
        {refunds && refunds.length > 0 && (
          <table className="data-table" style={{ marginBottom: 8 }}>
            <thead><tr><th>Amount</th><th>Reason</th><th>Status</th><th>Requested by</th></tr></thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}><td>₹{r.amount}</td><td>{r.reason}</td><td>{r.status}</td><td>{r.requested_by_name}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {!showRefund ? (
          <button className="btn-secondary" disabled={busy} onClick={() => setShowRefund(true)}>Initiate refund</button>
        ) : (
          <div>
            <div className="field"><label>Amount</label><input type="number" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} style={{ width: 100 }} /></div>
            <div className="field"><label>Reason</label><input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} style={{ width: 320 }} /></div>
            <button className="btn-primary" disabled={busy || !refundAmount || Number(refundAmount) <= 0 || !refundReason.trim()} onClick={submitRefund}>Record refund request</button>
            <button className="btn-secondary" disabled={busy} onClick={() => setShowRefund(false)} style={{ marginLeft: 8 }}>Never mind</button>
          </div>
        )}
      </div>
    </div>
  );
}

function OrderLineRow({ orderId, line, onChanged, disabled }: { orderId: string; line: any; onChanged: () => void; disabled: boolean }) {
  const [showResolve, setShowResolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolveMatch(p: any) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/lines/${line.id}/resolve`, {
        action: line.product_id ? "substitute" : "match", productId: p.id, quantityConfirmedUnits: p.packSize ?? line.quantity_requested_units ?? 1, deviceId: "web-console",
      });
      setShowResolve(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not resolve.") : "Could not resolve.");
    } finally {
      setBusy(false);
    }
  }
  async function markUnavailable() {
    setBusy(true);
    try {
      await api.post(`/orders/${orderId}/lines/${line.id}/resolve`, { action: "unavailable", unavailableReason: "Not in stock", deviceId: "web-console" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function pushToRequestBook() {
    setBusy(true);
    try {
      await api.post(`/orders/${orderId}/lines/${line.id}/resolve`, { action: "push_to_request_book", deviceId: "web-console" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function removeLine() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/orders/${orderId}/lines/${line.id}`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not remove.") : "Could not remove.");
    } finally {
      setBusy(false);
    }
  }

  const isMatched = line.line_status === "matched" || line.line_status === "substituted";

  return (
    <tr>
      <td>
        {line.product_name ?? line.description_as_entered ?? "—"}
        {error && <div className="error-text">{error}</div>}
        {showResolve && <div style={{ marginTop: 4 }}><SearchBar context="delivery_order" onSelect={resolveMatch} autoFocus /></div>}
      </td>
      <td>{line.quantity_confirmed_units ?? line.quantity_requested_units ?? "—"}</td>
      <td>{line.line_status}</td>
      <td>
        {!disabled && !isMatched && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setShowResolve((s) => !s)}>Match</button>{" "}
            <button className="btn-secondary" disabled={busy} onClick={markUnavailable}>Unavailable</button>{" "}
            <button className="btn-secondary" disabled={busy} onClick={pushToRequestBook}>To request book</button>
          </>
        )}
        {/* Section 10.2 "edit pre-pick": once a line is already matched, its quantity/product can still be
            changed (substitution) here — the only thing that can't happen post-pick is adding/removing lines,
            which is gated at the parent's "+ Add item" control and this Remove button instead. */}
        {!disabled && isMatched && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setShowResolve((s) => !s)}>Substitute</button>{" "}
            <button className="btn-secondary" disabled={busy} onClick={removeLine}>Remove</button>
          </>
        )}
      </td>
    </tr>
  );
}
