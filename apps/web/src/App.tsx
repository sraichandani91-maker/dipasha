import { useEffect, useState } from "react";
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
import ColdChainPage from "./pages/ColdChainPage.js";
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
import RiderPage from "./pages/RiderPage.js";
import StaffPage from "./pages/StaffPage.js";
import InventoryPage from "./pages/InventoryPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import WhatsAppInboxPage from "./pages/WhatsAppInboxPage.js";
import ChronicPage from "./pages/ChronicPage.js";
import AccountingPage from "./pages/AccountingPage.js";
import FinancialsPage from "./pages/FinancialsPage.js";
import HomePage from "./pages/HomePage.js";
import ActivityLogsPage from "./pages/ActivityLogsPage.js";
import OrderBookPage from "./pages/OrderBookPage.js";

type Tab =
  | "home"
  | "pos" | "products" | "bins" | "purchases" | "stock-received" | "putaway" | "requests" | "purchase-orders"
  | "cycle-counts" | "cold-chain" | "expiry-audit" | "write-offs" | "reports"
  | "prescribers" | "margins" | "customers" | "vendor-comparison" | "notifications" | "scan-invoice"
  | "delivery-orders" | "pick-pack" | "rider" | "staff" | "inventory" | "settings" | "whatsapp-inbox" | "chronic"
  | "accounting" | "financials" | "activity-logs" | "order-book";

const ROLES = ["owner", "store_manager", "picker_packer", "rider"];

export default function App() {
  const { user, loading, logout, impersonate } = useAuth();
  const [tab, setTab] = useState<Tab>("products");
  const [fulfillRequest, setFulfillRequest] = useState<FulfillRequest | null>(null);
  const [reviewMode, setReviewMode] = useState(false);

  // Rider's role has no use for the default "products" landing tab
  // (Section 8: "Rider logs in, sees assigned trips only") — `user` only
  // resolves after an async /auth/me call, so this can't be `tab`'s
  // initial useState value; it has to catch up once the role is known.
  // Same reasoning for Owner landing on the new Home dashboard instead —
  // it's the actual "homepage" this was modelled on.
  useEffect(() => {
    if (user?.role === "rider") setTab("rider");
    else if (user?.role === "owner") setTab("home");
  }, [user?.role]);

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
          {user.role === "owner" && (
            <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>Home</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "pos" ? "active" : ""} onClick={() => setTab("pos")}>Billing (POS)</button>
          )}
          <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>Products</button>
          <button className={tab === "bins" ? "active" : ""} onClick={() => setTab("bins")}>Bins</button>
          {(user.role === "owner" || user.role === "store_manager" || user.role === "picker_packer") && (
            <button className={tab === "inventory" ? "active" : ""} onClick={() => setTab("inventory")}>Inventory</button>
          )}
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
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "order-book" ? "active" : ""} onClick={() => setTab("order-book")}>Order book</button>
          )}
          <button className={tab === "cycle-counts" ? "active" : ""} onClick={() => setTab("cycle-counts")}>Cycle counts</button>
          <button className={tab === "cold-chain" ? "active" : ""} onClick={() => setTab("cold-chain")}>Cold chain</button>
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
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "chronic" ? "active" : ""} onClick={() => setTab("chronic")}>Chronic patients</button>
          )}
          {user.role === "owner" && (
            <button className={tab === "margins" ? "active" : ""} onClick={() => setTab("margins")}>Margins</button>
          )}
          {user.role === "owner" && (
            <button className={tab === "financials" ? "active" : ""} onClick={() => setTab("financials")}>Financials</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "accounting" ? "active" : ""} onClick={() => setTab("accounting")}>Accounting</button>
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
            <button className={tab === "whatsapp-inbox" ? "active" : ""} onClick={() => setTab("whatsapp-inbox")}>WhatsApp inbox</button>
          )}
          {(user.role === "owner" || user.role === "store_manager") && (
            <button className={tab === "delivery-orders" ? "active" : ""} onClick={() => setTab("delivery-orders")}>Delivery orders</button>
          )}
          {(user.role === "owner" || user.role === "store_manager" || user.role === "picker_packer") && (
            <button className={tab === "pick-pack" ? "active" : ""} onClick={() => setTab("pick-pack")}>Pick &amp; pack</button>
          )}
          {user.role === "rider" && (
            <button className={tab === "rider" ? "active" : ""} onClick={() => setTab("rider")}>My trips</button>
          )}
          {user.role === "owner" && (
            <button className={tab === "staff" ? "active" : ""} onClick={() => setTab("staff")}>Staff</button>
          )}
          {user.role === "owner" && (
            <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
          )}
          {user.role === "owner" && (
            <button className={tab === "activity-logs" ? "active" : ""} onClick={() => setTab("activity-logs")}>Activity logs</button>
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
            {tab === "home" && <HomePage />}
            {tab === "pos" && <PosPage fulfillRequest={fulfillRequest} onConsumeFulfillRequest={() => setFulfillRequest(null)} />}
            {tab === "products" && <ProductsPage />}
            {tab === "bins" && <BinsPage />}
            {tab === "inventory" && <InventoryPage />}
            {tab === "purchases" && <PurchaseEntryPage />}
            {tab === "stock-received" && <StockReceivedPage />}
            {tab === "putaway" && <PutAwayPage />}
            {tab === "requests" && <RequestBookPage onFulfillAtPos={fulfillAtPos} />}
            {tab === "purchase-orders" && <PurchaseOrdersPage />}
            {tab === "order-book" && <OrderBookPage />}
            {tab === "cycle-counts" && <CycleCountPage />}
            {tab === "cold-chain" && <ColdChainPage />}
            {tab === "expiry-audit" && <ExpiryAuditPage />}
            {tab === "write-offs" && <WriteOffsPage />}
            {tab === "reports" && <ReportsPage />}
            {tab === "prescribers" && <PrescribersPage />}
            {tab === "chronic" && <ChronicPage />}
            {tab === "margins" && <MarginReportsPage />}
            {tab === "financials" && <FinancialsPage />}
            {tab === "accounting" && <AccountingPage />}
            {tab === "customers" && <CustomersPage />}
            {tab === "vendor-comparison" && <VendorComparisonPage />}
            {tab === "notifications" && <NotificationsPage />}
            {tab === "whatsapp-inbox" && <WhatsAppInboxPage />}
            {tab === "scan-invoice" && <ScanInvoicePage />}
            {tab === "delivery-orders" && <DeliveryOrdersPage />}
            {tab === "pick-pack" && <PickPackPage />}
            {tab === "rider" && <RiderPage />}
            {tab === "staff" && <StaffPage />}
            {tab === "settings" && <SettingsPage />}
            {tab === "activity-logs" && <ActivityLogsPage />}
          </>
        )}
      </div>
    </div>
  );
}
