import { useState } from "react";
import { useAuth } from "./auth/AuthContext.js";
import LoginPage from "./pages/LoginPage.js";
import ProductsPage from "./pages/ProductsPage.js";
import BinsPage from "./pages/BinsPage.js";
import PurchaseEntryPage from "./pages/PurchaseEntryPage.js";
import StockReceivedPage from "./pages/StockReceivedPage.js";
import PutAwayPage from "./pages/PutAwayPage.js";
import PosPage, { type FulfillRequest } from "./pages/PosPage.js";
import RequestBookPage from "./pages/RequestBookPage.js";
import PurchaseOrdersPage from "./pages/PurchaseOrdersPage.js";

type Tab = "pos" | "products" | "bins" | "purchases" | "stock-received" | "putaway" | "requests" | "purchase-orders";

const ROLES = ["owner", "store_manager", "picker_packer", "rider"];

export default function App() {
  const { user, loading, logout, impersonate } = useAuth();
  const [tab, setTab] = useState<Tab>("products");
  const [fulfillRequest, setFulfillRequest] = useState<FulfillRequest | null>(null);

  function fulfillAtPos(req: FulfillRequest) {
    setFulfillRequest(req);
    setTab("pos");
  }

  if (loading) return null;
  if (!user) return <LoginPage />;

  return (
    <div className="app-shell" style={{ flexDirection: "column" }}>
      <div className="topbar">
        <span className="brand">Dipasha Console</span>
        <nav>
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "pos" ? "active" : ""} onClick={() => setTab("pos")}>Billing (POS)</button>
          )}
          <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>Products</button>
          <button className={tab === "bins" ? "active" : ""} onClick={() => setTab("bins")}>Bins</button>
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "purchases" ? "active" : ""} onClick={() => setTab("purchases")}>Purchase entry</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "stock-received" ? "active" : ""} onClick={() => setTab("stock-received")}>Stock received</button>
          )}
          <button className={tab === "putaway" ? "active" : ""} onClick={() => setTab("putaway")}>Put-away</button>
          <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>Requests</button>
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "purchase-orders" ? "active" : ""} onClick={() => setTab("purchase-orders")}>Purchase orders</button>
          )}
        </nav>
        <div className="spacer" />
        {user.impersonating && <span className="impersonating">IMPERSONATING {user.role.toUpperCase()}</span>}
        {user.role === "owner" && !user.impersonating && (
          <select
            value=""
            onChange={(e) => e.target.value && impersonate(e.target.value)}
            style={{ background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)" }}
          >
            <option value="">Impersonate role (testing)…</option>
            {ROLES.filter((r) => r !== "owner").map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        <span className="who">{user.name}<br />{user.role}</span>
        <button className="btn-secondary" onClick={logout} style={{ marginLeft: 8 }}>Sign out</button>
      </div>
      <div className="content">
        {tab === "pos" && <PosPage fulfillRequest={fulfillRequest} onConsumeFulfillRequest={() => setFulfillRequest(null)} />}
        {tab === "products" && <ProductsPage />}
        {tab === "bins" && <BinsPage />}
        {tab === "purchases" && <PurchaseEntryPage />}
        {tab === "stock-received" && <StockReceivedPage />}
        {tab === "putaway" && <PutAwayPage />}
        {tab === "requests" && <RequestBookPage onFulfillAtPos={fulfillAtPos} />}
        {tab === "purchase-orders" && <PurchaseOrdersPage />}
      </div>
    </div>
  );
}
