import { useState } from "react";
import { useAuth } from "./auth/AuthContext.js";
import LoginPage from "./pages/LoginPage.js";
import ProductsPage from "./pages/ProductsPage.js";
import BinsPage from "./pages/BinsPage.js";

type Tab = "products" | "bins";

const ROLES = ["owner", "store_manager", "picker_packer", "rider"];

export default function App() {
  const { user, loading, logout, impersonate } = useAuth();
  const [tab, setTab] = useState<Tab>("products");

  if (loading) return null;
  if (!user) return <LoginPage />;

  return (
    <div className="app-shell" style={{ flexDirection: "column" }}>
      <div className="topbar">
        <span className="brand">Dipasha Console</span>
        <nav>
          <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>Products</button>
          <button className={tab === "bins" ? "active" : ""} onClick={() => setTab("bins")}>Bins</button>
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
        {tab === "products" && <ProductsPage />}
        {tab === "bins" && <BinsPage />}
      </div>
    </div>
  );
}
