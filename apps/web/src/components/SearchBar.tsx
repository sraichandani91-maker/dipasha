import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import ItemHistoryModal from "./ItemHistoryModal.js";
import ProductDetailModal from "./ProductDetailModal.js";

interface SearchProduct {
  id: string;
  name: string;
  manufacturer: string;
  form: string;
  scheduleCategory: string;
  isColdChain: boolean;
  packSize: number;
  baseUnit: string;
  mrp: number | null;
  perBaseUnitRate: number | null;
  stockBaseUnits: number;
  nearestExpiry: string | null;
  topBinCode: string | null;
}
interface SearchGroup {
  substituteGroupId: string;
  compositionLabel: string;
  products: SearchProduct[];
  isExactMatchGroup: boolean;
}
interface SearchResponse {
  mode: string;
  exactProductId: string | null;
  groups: SearchGroup[];
}

function strAndLoose(qty: number, packSize: number, baseUnit: string): string {
  if (packSize <= 1) return `${qty} ${baseUnit}${qty === 1 ? "" : "s"}`;
  const strips = Math.floor(qty / packSize);
  const loose = qty % packSize;
  const parts = [];
  if (strips > 0) parts.push(`${strips} strip${strips === 1 ? "" : "s"}`);
  if (loose > 0 || strips === 0) parts.push(`${loose} ${baseUnit}${loose === 1 ? "" : "s"}`);
  return parts.join(" + ");
}

function ScheduleBadge({ schedule }: { schedule: string }) {
  if (schedule === "OTC") return null;
  const cls = schedule === "X" ? "badge-bad" : schedule === "H1" ? "badge-warn" : "badge-info";
  return <span className={`badge ${cls}`}>{schedule}</span>;
}

/**
 * THE unified search bar (Section 5B) — one component, reused everywhere
 * a product needs to be found. `context` tags intent for the search log;
 * `onSelect` is what a caller (POS line, request book, PO line) does with
 * a chosen product — undefined here since M2 is lookup-only, wired up
 * properly once those screens exist (M3/M4/M6B).
 */
export default function SearchBar({
  context = "app_lookup",
  onSelect,
  onRequestBook,
  autoFocus,
}: {
  context?: "pos" | "app_lookup" | "request_book" | "purchase_entry" | "delivery_order";
  onSelect?: (product: SearchProduct) => void;
  onRequestBook?: (product: SearchProduct) => void;
  autoFocus?: boolean;
}) {
  const { user } = useAuth();
  const canViewHistory = user?.role === "owner" || user?.role === "store_manager";
  const canEditProduct = user?.role === "owner" || user?.role === "store_manager";
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);
  const [detailsTargetId, setDetailsTargetId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shared by F3 (details) and F4 (history): defaults to the exact-match
  // product when one exists, else the first result of the first group —
  // the same "top of the list" product a biller would otherwise just click.
  function defaultTargetProduct(): SearchProduct | null {
    if (!result) return null;
    const allProducts = result.groups.flatMap((g) => g.products);
    if (result.exactProductId) {
      const exact = allProducts.find((p) => p.id === result.exactProductId);
      if (exact) return exact;
    }
    return allProducts[0] ?? null;
  }

  function openHistory(p: SearchProduct) {
    setHistoryTarget({ id: p.id, name: p.name });
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResult(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get(`/search?q=${encodeURIComponent(query)}&context=${context}`);
        setResult(res);
        // Non-exact-match groups collapsed by default (Section 5B.2).
        const initialCollapse: Record<string, boolean> = {};
        res.groups.forEach((g: SearchGroup) => {
          if (!g.isExactMatchGroup) initialCollapse[g.substituteGroupId] = true;
        });
        setCollapsed(initialCollapse);
      } finally {
        setLoading(false);
      }
    }, 120);
  }, [query, context]);

  return (
    <div>
      <input
        className="search-bar"
        placeholder="Search brand, salt, manufacturer, or scan a barcode…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "F3") {
            e.preventDefault();
            const target = defaultTargetProduct();
            if (target) setDetailsTargetId(target.id);
            return;
          }
          if (e.key === "F4" && canViewHistory) {
            e.preventDefault();
            const target = defaultTargetProduct();
            if (target) openHistory(target);
          }
        }}
        autoFocus={autoFocus}
      />
      {result && result.groups.length > 0 && (
        <p className="hint-text" style={{ margin: "4px 0 0" }}>
          Press F3, or click "Details", to see (and {canEditProduct ? "edit " : ""}) a medicine's full details.
          {canViewHistory && <> Press F4, or click "History", for its past sales and purchases.</>}
        </p>
      )}
      {loading && <p className="hint-text">Searching…</p>}
      {result && result.groups.length === 0 && (
        <p className="hint-text">No matches — this search has been logged and feeds the request book.</p>
      )}
      {result && (
        <div style={{ marginTop: 10 }}>
          {result.groups.map((group) => {
            const isCollapsed = collapsed[group.substituteGroupId];
            const otherCount = group.products.length - (group.isExactMatchGroup ? 1 : 0);
            return (
              <div key={group.substituteGroupId} className={`substitute-group ${group.isExactMatchGroup ? "exact" : ""}`}>
                {group.isExactMatchGroup && group.products.length > 1 && (
                  <div
                    className="substitute-group-header"
                    onClick={() => setCollapsed((c) => ({ ...c, [group.substituteGroupId]: !c[group.substituteGroupId] }))}
                  >
                    <span>{group.compositionLabel} — {otherCount} other brand{otherCount === 1 ? "" : "s"} in stock</span>
                    <span>{isCollapsed ? "▸ expand" : "▾ collapse"}</span>
                  </div>
                )}
                {!group.isExactMatchGroup && (
                  <div className="substitute-group-header" style={{ cursor: "default", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
                    {group.compositionLabel}
                  </div>
                )}
                {(!isCollapsed || group.isExactMatchGroup === false) && group.products.map((p, idx) => {
                  if (group.isExactMatchGroup && idx > 0 && isCollapsed) return null;
                  const outOfStock = p.stockBaseUnits === 0;
                  return (
                    <div
                      key={p.id}
                      onClick={() => onSelect?.(p)}
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--border)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: onSelect ? "pointer" : "default",
                        opacity: outOfStock ? 0.55 : 1,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {p.name} <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>({p.manufacturer})</span>{" "}
                          <ScheduleBadge schedule={p.scheduleCategory} />{" "}
                          {p.isColdChain && <span className="badge badge-info">Cold chain</span>}
                        </div>
                        <div className="hint-text" style={{ marginTop: 2 }}>
                          {p.form}, pack of {p.packSize} · MRP ₹{p.mrp ?? "—"} (₹{p.perBaseUnitRate?.toFixed(2) ?? "—"}/{p.baseUnit})
                          {p.nearestExpiry && <> · exp {new Date(p.nearestExpiry).toLocaleDateString("en-IN", { month: "short", year: "2-digit" })}</>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className={outOfStock ? "stock-out" : "stock-ok"}>
                          {outOfStock ? "Out of stock" : strAndLoose(p.stockBaseUnits, p.packSize, p.baseUnit)}
                        </div>
                        {p.topBinCode && <div className="hint-text">{p.topBinCode}</div>}
                        {outOfStock && onRequestBook && (
                          <button
                            className="btn-secondary"
                            style={{ marginTop: 4, fontSize: 11, padding: "4px 8px" }}
                            onClick={(e) => { e.stopPropagation(); onRequestBook(p); }}
                          >
                            + Request book
                          </button>
                        )}
                        <button
                          className="btn-secondary"
                          style={{ marginTop: 4, fontSize: 11, padding: "4px 8px" }}
                          onClick={(e) => { e.stopPropagation(); setDetailsTargetId(p.id); }}
                        >
                          Details
                        </button>
                        {canViewHistory && (
                          <button
                            className="btn-secondary"
                            style={{ marginTop: 4, fontSize: 11, padding: "4px 8px" }}
                            onClick={(e) => { e.stopPropagation(); openHistory(p); }}
                          >
                            History
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {historyTarget && (
        <ItemHistoryModal productId={historyTarget.id} productName={historyTarget.name} onClose={() => setHistoryTarget(null)} />
      )}
      {detailsTargetId && (
        <ProductDetailModal productId={detailsTargetId} canEdit={canEditProduct} onClose={() => setDetailsTargetId(null)} />
      )}
    </div>
  );
}
