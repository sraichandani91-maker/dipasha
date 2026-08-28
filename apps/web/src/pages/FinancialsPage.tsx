import { useState } from "react";
import { api } from "../api.js";

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

function Money({ value }: { value: number | null }) {
  if (value === null) return <span className="hint-text">n/a</span>;
  return <span className={value < 0 ? "stock-out" : undefined}>₹{value.toFixed(2)}</span>;
}

/**
 * Section 10B.1's management P&L / payables-receivables dashboard and
 * Section 10B.4's Owner daily summary — both read the same
 * `computeFinancialSummary` result (`GET /financial-summary`), just for
 * different date ranges. Owner-only, same bar as Margins — this is cost
 * and profit data.
 */
export default function FinancialsPage() {
  const [tab, setTab] = useState<"summary" | "valuation">("summary");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Financials</h2>
      <p className="hint-text">
        Section 10B — the books-quality data layer (not a Tally replacement): P&amp;L, payables/receivables, and
        stock valuation, all computed from the same movement ledger and sales/purchase records the rest of the
        console already trusts. An optional daily WhatsApp digest of the four headline figures can be turned on
        under Settings → Accounting &amp; PO tracking.
      </p>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "summary" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("summary")}>P&amp;L summary</button>
        <button className={tab === "valuation" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("valuation")}>Stock valuation</button>
      </div>
      {tab === "summary" && <SummaryTab />}
      {tab === "valuation" && <ValuationTab />}
    </div>
  );
}

function quickRange(kind: "today" | "week" | "month" | "prev-month"): { from: string; to: string } {
  const now = new Date();
  if (kind === "today") {
    const d = now.toISOString().slice(0, 10);
    return { from: d, to: d };
  }
  if (kind === "week") {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  }
  if (kind === "prev-month") {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }
  return defaultRange();
}

// Section 10B.4's "previous-period comparison" — same length window
// immediately preceding the selected range, so a delta always compares
// like-for-like durations rather than e.g. 7 days against a full month.
function previousPeriod(range: { from: string; to: string }): { from: string; to: string } {
  const from = new Date(range.from + "T00:00:00Z");
  const to = new Date(range.to + "T00:00:00Z");
  const spanMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 24 * 60 * 60 * 1000);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const good = pct >= 0;
  return (
    <span className={good ? "badge badge-info" : "badge badge-warn"} title={`Previous period: ₹${previous.toFixed(2)}`}>
      {good ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% vs previous period
    </span>
  );
}

function SummaryTab() {
  const [range, setRange] = useState(defaultRange());
  const [summary, setSummary] = useState<any>(null);
  const [prevSummary, setPrevSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [asOfTimestamp, setAsOfTimestamp] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const prev = previousPeriod(range);
      const [s, p] = await Promise.all([
        api.get(`/financial-summary?from=${range.from}&to=${range.to}`),
        api.get(`/financial-summary?from=${prev.from}&to=${prev.to}`),
      ]);
      setSummary(s);
      setPrevSummary(p);
      setAsOfTimestamp(new Date().toLocaleString("en-IN"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn-secondary" onClick={() => setRange(quickRange("today"))}>Today</button>
          <button className="btn-secondary" onClick={() => setRange(quickRange("week"))}>Last 7 days</button>
          <button className="btn-secondary" onClick={() => setRange(quickRange("month"))}>This month</button>
          <button className="btn-secondary" onClick={() => setRange(quickRange("prev-month"))}>Last month</button>
        </div>
        <button className="btn-primary" disabled={loading} onClick={load}>{loading ? "Running…" : "Run"}</button>
      </div>

      {summary && (
        <>
          {asOfTimestamp && <p className="hint-text">As of {asOfTimestamp}. Compared against the equal-length period immediately before this range ({previousPeriod(range).from} to {previousPeriod(range).to}).</p>}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div className="card" style={{ flex: 1, minWidth: 200 }}>
              <strong>Sales</strong>
              <p style={{ fontSize: 22, margin: "6px 0" }}><Money value={summary.sales.total} /></p>
              <DeltaBadge current={summary.sales.total} previous={prevSummary?.sales.total ?? 0} />
              <p className="hint-text" style={{ marginTop: 6 }}>{summary.sales.billCount} bill(s) · avg ₹{summary.sales.averageBillValue.toFixed(2)}</p>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 200 }}>
              <strong>Purchases (GST)</strong>
              <p style={{ fontSize: 22, margin: "6px 0" }}><Money value={summary.purchases.gstTotal} /></p>
              <DeltaBadge current={summary.purchases.gstTotal} previous={prevSummary?.purchases.gstTotal ?? 0} />
              <p className="hint-text" style={{ marginTop: 6 }}>{summary.purchases.invoiceCount} invoice(s)</p>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 200 }}>
              <strong>Gross profit</strong>
              <p style={{ fontSize: 22, margin: "6px 0" }}>
                <Money value={summary.grossProfit.value} /> {summary.grossProfit.marginPercent !== null && <span className="hint-text">({summary.grossProfit.marginPercent.toFixed(1)}%)</span>}
              </p>
              {summary.grossProfit.value !== null && <DeltaBadge current={summary.grossProfit.value} previous={prevSummary?.grossProfit.value ?? 0} />}
              {summary.grossProfit.costUnknownWarning && <p className="hint-text" style={{ color: "var(--status-warn)", marginTop: 6 }}>{summary.grossProfit.costUnknownWarning}</p>}
            </div>
            <div className="card" style={{ flex: 1, minWidth: 200 }}>
              <strong>Net profit (after expenses)</strong>
              <p style={{ fontSize: 22, margin: "6px 0" }}><Money value={summary.netProfit} /></p>
              <p className="hint-text" style={{ marginTop: 6 }}>Expenses: ₹{summary.expenses.total.toFixed(2)}</p>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <strong>Reconciliation guard</strong>
            <p className="hint-text">Sales register total should always equal the sum of cash/UPI/card/credit tenders — a mismatch means a data-integrity bug, not a real variance.</p>
            <table className="data-table" style={{ marginTop: 8 }}>
              <thead><tr><th>Sales register</th><th>Cash</th><th>UPI</th><th>Card</th><th>Credit</th><th>Sum of tenders</th><th>Difference</th><th>Status</th></tr></thead>
              <tbody>
                <tr>
                  <td>₹{summary.reconciliation.salesRegisterTotal.toFixed(2)}</td>
                  <td>₹{summary.reconciliation.cash.toFixed(2)}</td>
                  <td>₹{summary.reconciliation.upi.toFixed(2)}</td>
                  <td>₹{summary.reconciliation.card.toFixed(2)}</td>
                  <td>₹{summary.reconciliation.credit.toFixed(2)}</td>
                  <td>₹{summary.reconciliation.sumOfPayments.toFixed(2)}</td>
                  <td className={summary.reconciliation.matches ? undefined : "stock-out"}>₹{summary.reconciliation.difference.toFixed(2)}</td>
                  <td>{summary.reconciliation.matches ? <span className="badge badge-info">Matches</span> : <span className="badge badge-warn">Mismatch — investigate</span>}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div className="card" style={{ flex: 1, minWidth: 280 }}>
              <strong>Payables (vendors)</strong>
              <p style={{ fontSize: 20, margin: "6px 0" }}>₹{summary.payablesReceivables.totalPayable.toFixed(2)}</p>
              <table className="data-table">
                <thead><tr><th>Vendor</th><th>Outstanding</th></tr></thead>
                <tbody>
                  {summary.payablesReceivables.payablesByVendor.slice(0, 10).map((r: any) => (
                    <tr key={r.vendor_id}><td>{r.name}</td><td>₹{Number(r.total_outstanding).toFixed(2)}</td></tr>
                  ))}
                  {summary.payablesReceivables.payablesByVendor.length === 0 && <tr><td colSpan={2} className="hint-text">None outstanding.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 280 }}>
              <strong>Receivables (customers)</strong>
              <p style={{ fontSize: 20, margin: "6px 0" }}>₹{summary.payablesReceivables.totalReceivable.toFixed(2)}</p>
              <table className="data-table">
                <thead><tr><th>Customer</th><th>Outstanding</th></tr></thead>
                <tbody>
                  {summary.payablesReceivables.receivablesByCustomer.slice(0, 10).map((r: any) => (
                    <tr key={r.customer_id}><td>{r.name}</td><td>₹{Number(r.total_outstanding).toFixed(2)}</td></tr>
                  ))}
                  {summary.payablesReceivables.receivablesByCustomer.length === 0 && <tr><td colSpan={2} className="hint-text">None outstanding.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <strong>Top products by profit</strong>
            <table className="data-table" style={{ marginTop: 8 }}>
              <thead><tr><th>Item</th><th>Revenue</th><th>Margin</th></tr></thead>
              <tbody>
                {summary.profitDetail.topProductsByProfit.map((p: any) => (
                  <tr key={p.product_id}>
                    <td>{p.product_name}</td><td>₹{p.revenue.toFixed(2)}</td>
                    <td>{p.marginValue === null ? <span className="hint-text">n/a</span> : `₹${p.marginValue.toFixed(2)} (${p.marginPercent.toFixed(1)}%)`}</td>
                  </tr>
                ))}
                {summary.profitDetail.topProductsByProfit.length === 0 && <tr><td colSpan={3} className="hint-text">No sales in this range.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <strong>Expenses by category</strong>
            <table className="data-table" style={{ marginTop: 8 }}>
              <thead><tr><th>Category</th><th>Total</th></tr></thead>
              <tbody>
                {summary.expenses.byCategory.map((e: any) => (
                  <tr key={e.category}><td style={{ textTransform: "capitalize" }}>{e.category.replace("_", " ")}</td><td>₹{e.total.toFixed(2)}</td></tr>
                ))}
                {summary.expenses.byCategory.length === 0 && <tr><td colSpan={2} className="hint-text">No expenses logged in this range.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ValuationTab() {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<any>(null);
  async function load() { setResult(await api.get(`/stock-valuation?asOf=${asOf}`)); }
  return (
    <div>
      <p className="hint-text">Reconstructed from the movement ledger up to end-of-day on the chosen date, not the live stock view — a past date is genuinely as of that date.</p>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field"><label>As of date</label><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        <button className="btn-primary" onClick={load}>Run</button>
      </div>
      {result && (
        <div className="card" style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div>
            <strong>Value at cost</strong>
            <p style={{ fontSize: 22, margin: "6px 0" }}>₹{result.valueAtCost.toFixed(2)}</p>
          </div>
          <div>
            <strong>Value at MRP</strong>
            <p style={{ fontSize: 22, margin: "6px 0" }}>₹{result.valueAtMrp.toFixed(2)}</p>
          </div>
          {result.costUnknownBatchCount > 0 && (
            <div>
              <strong>Cost unknown</strong>
              <p className="hint-text" style={{ marginTop: 6 }}>{result.costUnknownBatchCount} batch(es), {result.costUnknownUnits} unit(s) excluded from the cost figure above.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
