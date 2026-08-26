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
import DailyReviewScreen from "./pages/DailyReviewScreen.js";
import DailyReviewAlarm from "./components/DailyReviewAlarm.js";
import CycleCountPage from "./pages/CycleCountPage.js";
import ExpiryAuditPage from "./pages/ExpiryAuditPage.js";
import WriteOffsPage from "./pages/WriteOffsPage.js";
import ReportsPage from "./pages/ReportsPage.js";
import PrescribersPage from "./pages/PrescribersPage.js";
import MarginReportsPage from "./pages/MarginReportsPage.js";
import CustomersPage from "./pages/CustomersPage.js";
import VendorComparisonPage from "./pages/VendorComparisonPage.js";
import NotificationsPage from "./pages/NotificationsPage.js";
import ScanInvoicePage from "./pages/ScanInvoicePage.js";
import DeliveryOrdersPage from "./pages/DeliveryOrdersPage.js";
import PickPackPage from "./pages/PickPackPage.js";

type Tab =
  | "pos" | "products" | "bins" | "purchases" | "stock-received" | "putaway" | "requests" | "purchase-orders"
  | "cycle-counts" | "expiry-audit" | "write-offs" | "reports"
  | "prescribers" | "margins" | "customers" | "vendor-comparison" | "notifications" | "scan-invoice"
  | "delivery-orders" | "pick-pack";

const ROLES = ["owner", "store_manager", "picker_packer", "rider"];

export default function App() {
  const { user, loading, logout, impersonate } = useAuth();
  const [tab, setTab] = useState<Tab>("products");
  const [fulfillRequest, setFulfillRequest] = useState<FulfillRequest | null>(null);
  const [reviewMode, setReviewMode] = useState(false);

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
            <button className={tab === "scan-invoice" ? "active" : ""} onClick={() => setTab("scan-invoice")}>Scan invoice</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "stock-received" ? "active" : ""} onClick={() => setTab("stock-received")}>Stock received</button>
          )}
          <button className={tab === "putaway" ? "active" : ""} onClick={() => setTab("putaway")}>Put-away</button>
          <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>Requests</button>
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "purchase-orders" ? "active" : ""} onClick={() => setTab("purchase-orders")}>Purchase orders</button>
          )}
          <button className={tab === "cycle-counts" ? "active" : ""} onClick={() => setTab("cycle-counts")}>Cycle counts</button>
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "expiry-audit" ? "active" : ""} onClick={() => setTab("expiry-audit")}>Expiry audit</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "write-offs" ? "active" : ""} onClick={() => setTab("write-offs")}>Write-offs</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>Reports</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "prescribers" ? "active" : ""} onClick={() => setTab("prescribers")}>Prescribers</button>
          )}
          {user.role === "owner" && (
            <button className={tab === "margins" ? "active" : ""} onClick={() => setTab("margins")}>Margins</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "customers" ? "active" : ""} onClick={() => setTab("customers")}>Customers</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "vendor-comparison" ? "active" : ""} onClick={() => setTab("vendor-comparison")}>Vendor comparison</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "notifications" ? "active" : ""} onClick={() => setTab("notifications")}>Notifications</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "delivery-orders" ? "active" : ""} onClick={() => setTab("delivery-orders")}>Delivery orders</button>
          )}
          {(user.role === "owner" || user.role === "store_manager" || user.role === "picker_packer") && (
            <button className={tab === "pick-pack" ? "active" : ""} onClick={() => setTab("pick-pack")}>Pick &amp; pack</button>
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
      <DailyReviewAlarm onReviewNow={() => setReviewMode(true)} />
      <div className="content">
        {reviewMode ? (
          <DailyReviewScreen onDone={() => setReviewMode(false)} />
        ) : (
          <>
            {tab === "pos" && <PosPage fulfillRequest={fulfillRequest} onConsumeFulfillRequest={() => setFulfillRequest(null)} />}
            {tab === "products" && <ProductsPage />}
            {tab === "bins" && <BinsPage />}
            {tab === "purchases" && <PurchaseEntryPage />}
            {tab === "stock-received" && <StockReceivedPage />}
            {tab === "putaway" && <PutAwayPage />}
            {tab === "requests" && <RequestBookPage onFulfillAtPos={fulfillAtPos} />}
            {tab === "purchase-orders" && <PurchaseOrdersPage />}
            {tab === "cycle-counts" && <CycleCountPage />}
            {tab === "expiry-audit" && <ExpiryAuditPage />}
            {tab === "write-offs" && <WriteOffsPage />}
            {tab === "reports" && <ReportsPage />}
            {tab === "prescribers" && <PrescribersPage />}
            {tab === "margins" && <MarginReportsPage />}
            {tab === "customers" && <CustomersPage />}
            {tab === "vendor-comparison" && <VendorComparisonPage />}
            {tab === "notifications" && <NotificationsPage />}
            {tab === "scan-invoice" && <ScanInvoicePage />}
            {tab === "delivery-orders" && <DeliveryOrdersPage />}
            {tab === "pick-pack" && <PickPackPage />}
          </>
        )}
      </div>
    </div>
  );
}
