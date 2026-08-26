import { useEffect, useState } from "react";
import { api, ApiError, apiPdfUrl, getTokens, postForm } from "../api.js";
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
  const [tab, setTab] = useState<"new" | "queue" | "active">("queue");
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
        <button className={tab === "new" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("new")}>+ New order</button>
      </div>
      {tab === "queue" && <PendingQueue onOpen={setSelectedOrderId} />}
      {tab === "active" && <ActiveOrders onOpen={setSelectedOrderId} />}
      {tab === "new" && <NewOrderForm onCreated={setSelectedOrderId} />}
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

function OrderReview({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deliveryCharge, setDeliveryCharge] = useState("0");
  const [addLineText, setAddLineText] = useState("");

  async function load() {
    setData(await api.get(`/orders/${orderId}`));
  }
  useEffect(() => { load(); }, [orderId]);

  if (!data) return <div>Loading…</div>;
  const { order, lines, images, messages, pickLines } = data;

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
                <OrderLineRow key={l.id} orderId={orderId} line={l} onChanged={load} disabled={!["received", "under_review"].includes(order.status)} />
              ))}
            </tbody>
          </table>
          {["received", "under_review"].includes(order.status) && (
            <div style={{ marginTop: 8 }}>
              <input placeholder="Describe an item from the free text/image (e.g. cough syrup)" value={addLineText} onChange={(e) => setAddLineText(e.target.value)} style={{ width: 320 }} />
              <button className="btn-secondary" onClick={addBlankLine} disabled={busy}>+ Add line</button>
            </div>
          )}

          {order.rx_required && !order.rx_verified && (
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
        </div>
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
        action: "match", productId: p.id, quantityConfirmedUnits: p.packSize ?? line.quantity_requested_units ?? 1, deviceId: "web-console",
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
        {!disabled && line.line_status !== "matched" && line.line_status !== "substituted" && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setShowResolve((s) => !s)}>Match</button>{" "}
            <button className="btn-secondary" disabled={busy} onClick={markUnavailable}>Unavailable</button>{" "}
            <button className="btn-secondary" disabled={busy} onClick={pushToRequestBook}>To request book</button>
          </>
        )}
      </td>
    </tr>
  );
}
