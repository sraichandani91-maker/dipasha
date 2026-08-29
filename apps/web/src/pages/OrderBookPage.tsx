import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.js";
import { api, ApiError } from "../api.js";

interface Dashboard {
  shortbookItems: number;
  distributors: number;
  itemsInCart: number;
  orderedItems: number;
  orderAnalysisShort: number;
}
interface ShortbookItem {
  productId: string;
  productName: string;
  currentStock: number;
  avgDailyDemand: number;
  daysOfCover: number | null;
  suggestedQty: number;
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  lastRate: number | null;
  marginPercent: number | null;
}
interface ClearanceCandidate {
  productId: string;
  productName: string;
  nearExpiryStock: number;
  totalSellableStock: number;
}
interface CartRow {
  productId: string;
  productName: string;
  quantityBaseUnits: number;
  vendorId: string | null;
  vendorName: string | null;
}
interface Vendor {
  id: string;
  name: string;
}

function StatTile({ label, sub, value, tone }: { label: string; sub: string; value: number; tone: string }) {
  return (
    <div className="card" style={{ borderTop: `3px solid ${tone}`, flex: 1, minWidth: 140 }}>
      <p style={{ fontSize: 30, fontWeight: 700, margin: "2px 0", color: tone }}>{value}</p>
      <p style={{ margin: 0, fontWeight: 600 }}>{label}</p>
      <p className="hint-text" style={{ margin: 0 }}>{sub}</p>
    </div>
  );
}

/**
 * "Order book" / Shortbook — the owner asked for this after seeing a
 * competitor app's Orderbook Dashboard + Shortbook Settings screens. The
 * dashboard's five tiles and the settings panel's five fields map
 * directly onto what was shown; the underlying suggestion engine is
 * domain/reorder.ts's days-of-cover model (repo/shortbook.ts), and
 * checkout reuses the existing createPurchaseOrder path (repo/purchase-
 * orders.ts) — one PO per vendor, same constraint the old Create-PO
 * screen already had.
 */
export default function OrderBookPage() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [items, setItems] = useState<ShortbookItem[]>([]);
  const [clearance, setClearance] = useState<ClearanceCandidate[]>([]);
  const [cart, setCart] = useState<CartRow[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<{ created: Array<{ vendorName: string; poNumber: string }>; unassignedProductIds: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [dash, itemsRes, cartRes, vendorsRes] = await Promise.all([
      api.get("/shortbook/dashboard"),
      api.get("/shortbook/items"),
      api.get("/shortbook/cart"),
      api.get("/vendors"),
    ]);
    setDashboard(dash);
    setItems(itemsRes.items);
    setClearance(itemsRes.clearanceCandidates ?? []);
    setCart(cartRes);
    setVendors(vendorsRes);
  }
  useEffect(() => { load(); }, []);

  async function addToCart(item: ShortbookItem, qty: number, vendorId: string | null) {
    setBusyProductId(item.productId);
    setError(null);
    try {
      await api.post("/shortbook/cart", { productId: item.productId, quantityBaseUnits: qty, vendorId });
      await load();
    } catch {
      setError("Could not add that item to the cart.");
    } finally {
      setBusyProductId(null);
    }
  }

  async function removeFromCart(productId: string) {
    setBusyProductId(productId);
    try {
      await api.delete(`/shortbook/cart/${productId}`);
      await load();
    } finally {
      setBusyProductId(null);
    }
  }

  async function setCartVendor(productId: string, quantityBaseUnits: number, vendorId: string) {
    await api.post("/shortbook/cart", { productId, quantityBaseUnits, vendorId: vendorId || null });
    await load();
  }

  async function createOrder() {
    setError(null);
    try {
      const res = await api.post("/shortbook/cart/checkout", { deviceId: "web-console" });
      setCheckoutResult(res);
      await load();
    } catch {
      setError("Could not create the order book. Check that every cart item has a distributor assigned.");
    }
  }

  const cartIsEmpty = cart.length === 0;
  const cartHasUnassigned = cart.some((c) => !c.vendorId);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Orderbook Dashboard</h2>
          <p className="hint-text" style={{ margin: 0 }}>List of stock items which are in shortage</p>
        </div>
        {user?.role === "owner" && (
          <button className="btn-secondary" onClick={() => setShowSettings(true)}>⚙ Shortbook Settings</button>
        )}
      </div>

      {dashboard && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <StatTile label="Shortbook Items" sub="Stock items in shortage" value={dashboard.shortbookItems} tone="#6d5bd0" />
          <StatTile label="Distributors" sub="Whom to order from" value={dashboard.distributors} tone="#d43f7e" />
          <StatTile label="Items in Cart" sub="Items finalized for order" value={dashboard.itemsInCart} tone="#e08a3c" />
          <StatTile label="Ordered Items" sub="Items that are in order" value={dashboard.orderedItems} tone="#3f9d5c" />
          <StatTile label="Order Analysis" sub="Lines short on active orders" value={dashboard.orderAnalysisShort} tone="#8a4bd0" />
        </div>
      )}

      {checkoutResult && (
        <div className="card" style={{ marginBottom: 12, background: "color-mix(in srgb, var(--status-good) 10%, white)" }}>
          {checkoutResult.created.length > 0 && (
            <p style={{ margin: 0, fontWeight: 700 }}>
              Created {checkoutResult.created.length} purchase order{checkoutResult.created.length === 1 ? "" : "s"}:{" "}
              {checkoutResult.created.map((c) => `${c.poNumber} (${c.vendorName})`).join(", ")}
            </p>
          )}
          {checkoutResult.unassignedProductIds.length > 0 && (
            <p className="hint-text" style={{ margin: "4px 0 0" }}>
              {checkoutResult.unassignedProductIds.length} item(s) stayed in the cart — assign a distributor and create the order again.
            </p>
          )}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      {clearance.length > 0 && (
        <div className="card" style={{ marginBottom: 12, background: "color-mix(in srgb, var(--status-warn) 8%, white)" }}>
          <strong>Not on the shortbook — remaining stock is near-expiry</strong>
          <p className="hint-text" style={{ marginTop: 4 }}>
            These would otherwise show as short, but every unit left is close to expiry. Clear it first (Expiry audit), then it
            resurfaces here once healthy stock is actually low.
          </p>
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Item</th><th>Near-expiry units</th><th>Total sellable</th></tr></thead>
            <tbody>
              {clearance.map((c) => <tr key={c.productId}><td>{c.productName}</td><td>{c.nearExpiryStock}</td><td>{c.totalSellableStock}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div className="card" style={{ flex: 2 }}>
          <h3 style={{ marginTop: 0 }}>Shortbook items</h3>
          <table className="data-table">
            <thead><tr><th>Item</th><th>Stock</th><th>Days of cover</th><th>Priority distributor (best margin)</th><th>Qty to order</th><th></th></tr></thead>
            <tbody>
              {items.map((item) => (
                <ShortbookRow
                  key={item.productId}
                  item={item}
                  inCart={cart.some((c) => c.productId === item.productId)}
                  busy={busyProductId === item.productId}
                  onAdd={(qty, vendorId) => addToCart(item, qty, vendorId)}
                />
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="hint-text">Nothing is short right now.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>Cart — {cart.length} item{cart.length === 1 ? "" : "s"}</h3>
          {cart.map((c) => (
            <div key={c.productId} style={{ borderBottom: "1px solid var(--border-subtle, #e5e5e5)", padding: "8px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{c.productName}</strong>
                <button className="btn-secondary" disabled={busyProductId === c.productId} onClick={() => removeFromCart(c.productId)}>Remove</button>
              </div>
              <div className="hint-text">Qty: {c.quantityBaseUnits}</div>
              <select
                style={{ width: "100%", marginTop: 4 }}
                value={c.vendorId ?? ""}
                onChange={(e) => setCartVendor(c.productId, c.quantityBaseUnits, e.target.value)}
              >
                <option value="">Assign distributor…</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          ))}
          {cartIsEmpty && <p className="hint-text">Add items from the shortbook list to build an order.</p>}
          {!cartIsEmpty && cartHasUnassigned && <p className="hint-text">Some items still need a distributor assigned.</p>}
          <button className="btn-primary" style={{ marginTop: 12, width: "100%" }} disabled={cartIsEmpty} onClick={createOrder}>
            Create order — {cart.length} item{cart.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>

      {showSettings && <ShortbookSettingsModal onClose={() => setShowSettings(false)} onSaved={load} />}
    </div>
  );
}

function ShortbookRow({ item, inCart, busy, onAdd }: { item: ShortbookItem; inCart: boolean; busy: boolean; onAdd: (qty: number, vendorId: string | null) => void }) {
  const [qty, setQty] = useState(item.suggestedQty);
  return (
    <tr>
      <td>{item.productName}</td>
      <td>{item.currentStock}</td>
      <td>{item.daysOfCover === null ? "—" : item.daysOfCover.toFixed(1)}</td>
      <td className="hint-text">
        {item.suggestedVendorName ?? "—"}
        {item.lastRate !== null && ` · ₹${item.lastRate.toFixed(2)}`}
        {item.marginPercent !== null && <span className="badge badge-info" style={{ marginLeft: 6 }}>{item.marginPercent.toFixed(1)}% margin</span>}
      </td>
      <td><input type="number" style={{ width: 80 }} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></td>
      <td>
        <button className="btn-secondary" disabled={busy || inCart} onClick={() => onAdd(qty, item.suggestedVendorId)}>
          {inCart ? "In cart" : "Add to cart"}
        </button>
      </td>
    </tr>
  );
}

interface ShortbookSettingsValues {
  shortbook_min_stock_days: number;
  shortbook_max_stock_days: number;
  shortbook_reorder_point_days: number;
  shortbook_demand_calc_period_days: number;
  shortbook_seasonality_enabled: boolean;
}

function ShortbookSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<ShortbookSettingsValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get("/settings").then((rows: Array<{ key: string; value: unknown }>) => {
      const map = new Map(rows.map((r) => [r.key, r.value]));
      setValues({
        shortbook_min_stock_days: map.get("shortbook_min_stock_days") as number,
        shortbook_max_stock_days: map.get("shortbook_max_stock_days") as number,
        shortbook_reorder_point_days: map.get("shortbook_reorder_point_days") as number,
        shortbook_demand_calc_period_days: map.get("shortbook_demand_calc_period_days") as number,
        shortbook_seasonality_enabled: map.get("shortbook_seasonality_enabled") as boolean,
      });
    });
  }, []);

  if (!values) return null;

  const validationError =
    values.shortbook_max_stock_days <= values.shortbook_min_stock_days ? "Max stock must be greater than min stock." :
    values.shortbook_reorder_point_days < values.shortbook_min_stock_days || values.shortbook_reorder_point_days > values.shortbook_max_stock_days ? "Reorder point must be between min and max stock." :
    values.shortbook_demand_calc_period_days <= values.shortbook_max_stock_days ? "Calculation period must be greater than max stock days." :
    values.shortbook_demand_calc_period_days > 90 ? "Calculation period can be at most 90 days." :
    null;

  async function apply() {
    if (!values || validationError) return;
    setBusy(true);
    setError(null);
    try {
      await Promise.all(
        (Object.keys(values) as Array<keyof ShortbookSettingsValues>).map((key) => api.patch(`/settings/${key}`, { value: values[key] }))
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? "Could not save — check every value is valid." : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 460, maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ margin: 0 }}>Shortbook Settings</h3>
            <p className="hint-text" style={{ margin: 0 }}>Verify &amp; update the details below</p>
          </div>
          <button className="btn-secondary" onClick={onClose}>✕</button>
        </div>

        <div className="field">
          <label>Min stock (days)</label>
          <input type="number" value={values.shortbook_min_stock_days} onChange={(e) => setValues({ ...values, shortbook_min_stock_days: Number(e.target.value) })} />
          <p className="hint-text">Value in number of days</p>
        </div>
        <div className="field">
          <label>Max stock (days)</label>
          <input type="number" value={values.shortbook_max_stock_days} onChange={(e) => setValues({ ...values, shortbook_max_stock_days: Number(e.target.value) })} />
          <p className="hint-text">Max stock &gt; min stock</p>
        </div>
        <div className="field">
          <label>Reorder point (days)</label>
          <input type="number" value={values.shortbook_reorder_point_days} onChange={(e) => setValues({ ...values, shortbook_reorder_point_days: Number(e.target.value) })} />
          <p className="hint-text">Min stock &lt;= reorder point &lt;= max stock</p>
        </div>
        <div className="field">
          <label>Period for demand calculation (days)</label>
          <input type="number" value={values.shortbook_demand_calc_period_days} onChange={(e) => setValues({ ...values, shortbook_demand_calc_period_days: Number(e.target.value) })} />
          <p className="hint-text">Max stock &lt; calculation period &lt;= last 90 days</p>
        </div>
        <div className="field" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <label>Seasonality in demand calculation</label>
            <p className="hint-text">Same period demand from previous year</p>
          </div>
          <input
            type="checkbox"
            checked={values.shortbook_seasonality_enabled}
            onChange={(e) => setValues({ ...values, shortbook_seasonality_enabled: e.target.checked })}
          />
        </div>

        {validationError && <p className="error-text">{validationError}</p>}
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" style={{ width: "100%", marginTop: 8 }} disabled={busy || !!validationError} onClick={apply}>
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
