import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";

function defaultRange() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 6);
  return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

function quickRange(kind: "today" | "week" | "month"): { from: string; to: string } {
  const now = new Date();
  if (kind === "today") {
    const d = now.toISOString().slice(0, 10);
    return { from: d, to: d };
  }
  if (kind === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  }
  return defaultRange();
}

function money(v: number): string {
  return `₹${v.toFixed(2)}`;
}

// Section 10B.4/M15's own previousPeriod reasoning, reused here: a delta
// always compares like-for-like window lengths, never e.g. 7 days against
// a full month.
function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const good = pct >= 0;
  return (
    <span className={good ? "badge badge-info" : "badge badge-warn"} title={`Previous period: ${money(previous)}`}>
      {good ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

// A 12-point-ish sparkline — one series, so no legend (dataviz skill:
// "a single series needs no legend box"). 2px line, brand green, a
// larger accent dot with a surface ring on the last (current) point.
function Sparkline({ points }: { points: Array<{ date: string; value: number }> }) {
  if (points.length < 2) return <div style={{ height: 32 }} className="hint-text">Not enough data yet</div>;
  const w = 220, h = 40, pad = 4;
  const values = points.map((p) => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0.01);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p.value - min) / range) * (h - pad * 2);
    return { x, y };
  });
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Trend over the selected range">
      <path d={path} fill="none" stroke="var(--brand-green)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y} r={4} fill="var(--brand-green)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

function StatTile({ label, value, delta, trend }: { label: string; value: string; delta?: { current: number; previous: number }; trend?: Array<{ date: string; value: number }> }) {
  return (
    <div className="card">
      <p className="hint-text" style={{ margin: 0 }}>{label}</p>
      <p style={{ fontSize: 26, fontWeight: 700, margin: "4px 0" }}>{value}</p>
      {delta && <DeltaBadge current={delta.current} previous={delta.previous} />}
      {trend && <div style={{ marginTop: 8 }}><Sparkline points={trend} /></div>}
    </div>
  );
}

// New vs repeat customers — a two-segment donut. Categorical slots 1/2
// (blue/orange) per the dataviz skill's validated ordering; orange fails
// the light-surface contrast check on its own, so both segments carry a
// visible direct label rather than relying on color alone (the skill's
// "relief rule").
function CustomerDonut({ newCount, repeatCount }: { newCount: number; repeatCount: number }) {
  const total = newCount + repeatCount;
  if (total === 0) return <p className="hint-text">No customer activity in this range.</p>;
  const r = 34, cx = 40, cy = 40, strokeWidth = 14;
  const circumference = 2 * Math.PI * r;
  const newFrac = newCount / total;
  const newLen = circumference * newFrac;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width={80} height={80} viewBox="0 0 80 80">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--status-warn)" strokeWidth={strokeWidth} />
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke="var(--status-info)" strokeWidth={strokeWidth}
          strokeDasharray={`${newLen} ${circumference - newLen}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </svg>
      <div style={{ fontSize: 13 }}>
        <div><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--status-info)", marginRight: 6, borderRadius: 2 }} />New: <strong>{newCount}</strong></div>
        <div style={{ marginTop: 4 }}><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--status-warn)", marginRight: 6, borderRadius: 2 }} />Repeat: <strong>{repeatCount}</strong></div>
      </div>
    </div>
  );
}

/**
 * Owner-requested Home dashboard (a competitor pharmacy-retail app
 * screenshot, asked to be recreated here) — Owner-only, matching
 * Financials/Margins/Staff/Settings' own visibility bar; never shown to
 * store_manager or any other role. `GET /owner-dashboard` consolidates
 * everything into one call rather than the page firing eight separate
 * requests.
 */
export default function HomePage() {
  const [range, setRange] = useState(defaultRange());
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueTab, setDueTab] = useState<"customer" | "distributor">("customer");
  const [velocityTab, setVelocityTab] = useState<"slow" | "fast">("slow");
  const [reminding, setReminding] = useState<string | null>(null);
  const [remindStatus, setRemindStatus] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get(`/owner-dashboard?from=${range.from}&to=${range.to}`));
    } catch {
      setError("Could not load the dashboard.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function remindDue(customerId: string) {
    setReminding(customerId);
    setRemindStatus(null);
    try {
      const res = await api.post(`/customers/${customerId}/remind-due`);
      setRemindStatus(res.status === "logged_dev_mode" ? "Reminder logged (no WhatsApp provider set up yet)." : "Reminder sent.");
    } catch (err) {
      setRemindStatus(err instanceof ApiError && err.body?.error === "no_customer_phone" ? "This customer has no phone number on file." : "Could not send the reminder.");
    } finally {
      setReminding(null);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Home</h2>
      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-secondary" onClick={() => setRange(quickRange("today"))}>Today</button>
        <button className="btn-secondary" onClick={() => setRange(quickRange("week"))}>Last 7 days</button>
        <button className="btn-secondary" onClick={() => setRange(quickRange("month"))}>This month</button>
        <button className="btn-primary" onClick={load}>Run</button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && !data && <p className="hint-text">Loading…</p>}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
            <StatTile label="Net sales" value={money(data.netSales.value)} delta={{ current: data.netSales.value, previous: data.netSales.previousValue }} trend={data.netSales.dailyTrend} />
            <StatTile label="Stock value (at cost)" value={money(data.stockValue.valueAtCost)} />
            <div className="card">
              <p className="hint-text" style={{ margin: 0 }}>Customers</p>
              <div style={{ display: "flex", gap: 16, marginTop: 4, marginBottom: 8 }}>
                <div><span style={{ fontSize: 22, fontWeight: 700 }}>{data.customers.totalCustomers}</span><div className="hint-text">Total</div></div>
                <div><span style={{ fontSize: 22, fontWeight: 700 }}>{money(data.customers.avgOrderValue)}</span><div className="hint-text">Avg order value</div></div>
              </div>
              <CustomerDonut newCount={data.customers.newCustomers} repeatCount={data.customers.repeatCustomers} />
            </div>
            <StatTile label="Net purchase" value={money(data.netPurchase.value)} delta={{ current: data.netPurchase.value, previous: data.netPurchase.previousValue }} trend={data.netPurchase.dailyTrend} />
            <StatTile label="Net payment collection" value={money(data.netPaymentCollection)} />
            <StatTile label="Profit" value={data.profit.grossProfit === null ? "n/a" : money(data.profit.grossProfit)} />
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div className="card" style={{ flex: 1, minWidth: 340 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Due payments</strong>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className={dueTab === "customer" ? "btn-primary" : "btn-secondary"} onClick={() => setDueTab("customer")}>Customer</button>
                  <button className={dueTab === "distributor" ? "btn-primary" : "btn-secondary"} onClick={() => setDueTab("distributor")}>Distributor</button>
                </div>
              </div>
              <p style={{ margin: "8px 0" }}>
                Total due: <strong style={{ fontSize: 18 }}>{money(dueTab === "customer" ? data.duePayments.totalCustomerDue : data.duePayments.totalDistributorDue)}</strong>
              </p>
              {remindStatus && <p className="hint-text">{remindStatus}</p>}
              <table className="data-table">
                <thead><tr><th>Name</th><th>Oldest bill</th><th>Due date</th><th>Amount</th>{dueTab === "customer" && <th></th>}</tr></thead>
                <tbody>
                  {(dueTab === "customer" ? data.duePayments.customer : data.duePayments.distributor).map((d: any) => (
                    <tr key={d.customerId ?? d.vendorId}>
                      <td>{d.name}</td>
                      <td>{d.oldestBillNumber ?? d.oldestInvoiceNumber}</td>
                      <td>{new Date(d.dueDate).toLocaleDateString("en-IN")}</td>
                      <td>{money(d.totalDue)}</td>
                      {dueTab === "customer" && (
                        <td>
                          <button className="btn-secondary" disabled={reminding === d.customerId} onClick={() => remindDue(d.customerId)} style={{ fontSize: 11, padding: "4px 8px" }}>
                            {reminding === d.customerId ? "…" : "Remind now"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {(dueTab === "customer" ? data.duePayments.customer : data.duePayments.distributor).length === 0 && (
                    <tr><td colSpan={5} className="hint-text">Nothing outstanding.</td></tr>
                  )}
                </tbody>
              </table>
              <p className="hint-text" style={{ marginTop: 8 }}>Record a payment from the Customers or Accounting screen's ledger.</p>
            </div>

            <div className="card" style={{ flex: 1, minWidth: 300 }}>
              <strong>Refill reminders</strong>
              <p className="hint-text" style={{ margin: "4px 0 8px" }}>See the Chronic patients tab for the full queue and reminder actions.</p>
              <table className="data-table">
                <thead><tr><th>Customer</th><th>Item</th><th>Status</th></tr></thead>
                <tbody>
                  {data.refillReminders.map((r: any, i: number) => (
                    <tr key={i}>
                      <td>{r.customer_name}</td>
                      <td>{r.product_name}</td>
                      <td>{r.is_overdue ? <span className="badge badge-warn">Overdue</span> : `Due in ${r.days_until_exhaustion}d`}</td>
                    </tr>
                  ))}
                  {data.refillReminders.length === 0 && <tr><td colSpan={3} className="hint-text">No refills due.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              <button className={velocityTab === "slow" ? "btn-primary" : "btn-secondary"} onClick={() => setVelocityTab("slow")}>Slow moving</button>
              <button className={velocityTab === "fast" ? "btn-primary" : "btn-secondary"} onClick={() => setVelocityTab("fast")}>Fast moving</button>
            </div>
            <table className="data-table">
              <thead><tr><th>Product</th><th>Company</th><th>Qty sold</th><th>Stock</th><th>Last sold</th></tr></thead>
              <tbody>
                {(velocityTab === "slow" ? data.slowMoving : data.fastMoving).map((p: any) => (
                  <tr key={p.productId}>
                    <td>{p.productName}</td>
                    <td>{p.manufacturer}</td>
                    <td>{p.qtySold}</td>
                    <td>{p.stock}</td>
                    <td>{p.lastSoldDate ? new Date(p.lastSoldDate).toLocaleDateString("en-IN") : "Never"}</td>
                  </tr>
                ))}
                {(velocityTab === "slow" ? data.slowMoving : data.fastMoving).length === 0 && (
                  <tr><td colSpan={5} className="hint-text">Nothing to show for this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
