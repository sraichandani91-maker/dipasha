import { useState } from "react";
import { api } from "../api.js";

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

function MarginCell({ marginValue, marginPercent }: { marginValue: number | null; marginPercent: number | null }) {
  if (marginValue === null) return <span title="Some or all cost data unknown for this line" className="hint-text">n/a</span>;
  return (
    <span style={{ color: marginPercent! < 0 ? "var(--status-bad)" : marginPercent! < 10 ? "var(--status-warn)" : "var(--status-good)", fontWeight: 700 }}>
      ₹{marginValue.toFixed(2)} ({marginPercent!.toFixed(1)}%)
    </span>
  );
}

/**
 * Section 9A.2 — margin on effective cost (never invoice rate), plus
 * scheme promised-vs-actual tracking. Owner-only tab, separate from the
 * Store-Manager-visible Reports tab: this is cost data, same "absent,
 * not blanked" bar used everywhere else in the build.
 */
export default function MarginReportsPage() {
  const [tab, setTab] = useState<"sku" | "category" | "vendor" | "below-cost" | "schemes">("sku");
  const [range, setRange] = useState(defaultRange());

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Margin reports</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {([
          ["sku", "By SKU"], ["category", "By schedule category"], ["vendor", "By vendor"],
          ["below-cost", "Below-cost sales"], ["schemes", "Scheme shortfalls"],
        ] as Array<[typeof tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
      </div>
      {tab === "sku" && <SkuTab range={range} />}
      {tab === "category" && <CategoryTab range={range} />}
      {tab === "vendor" && <VendorTab range={range} />}
      {tab === "below-cost" && <BelowCostTab range={range} />}
      {tab === "schemes" && <SchemesTab range={range} />}
    </div>
  );
}

function SkuTab({ range }: { range: { from: string; to: string } }) {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/margin-reports/by-sku?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Item</th><th>Revenue</th><th>Margin</th><th>Cost-unknown lines</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.product_id}>
                  <td>{r.product_name}</td><td>₹{r.revenue.toFixed(2)}</td>
                  <td><MarginCell marginValue={r.marginValue} marginPercent={r.marginPercent} /></td>
                  <td>{r.cost_unknown_line_count > 0 ? r.cost_unknown_line_count : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="hint-text">No sales in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CategoryTab({ range }: { range: { from: string; to: string } }) {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/margin-reports/by-category?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <p className="hint-text">"Category" here is the schedule category (OTC/H/H1/X/…) — the only categorical dimension a product has in this build; there's no separate merchandising taxonomy.</p>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Category</th><th>Revenue</th><th>Margin</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.category}</td><td>₹{r.revenue.toFixed(2)}</td>
                  <td><MarginCell marginValue={r.marginValue} marginPercent={r.marginPercent} /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="hint-text">No sales in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VendorTab({ range }: { range: { from: string; to: string } }) {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/margin-reports/by-vendor?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <p className="hint-text">Vendor comes from the purchase invoice line that first brought each batch in. A batch with no purchase-invoice record (non-GST stock received, opening stock) is grouped under "Unknown / non-GST source".</p>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Vendor</th><th>Revenue</th><th>Margin</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.vendor_name}</td><td>₹{r.revenue.toFixed(2)}</td>
                  <td><MarginCell marginValue={r.marginValue} marginPercent={r.marginPercent} /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="hint-text">No sales in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BelowCostTab({ range }: { range: { from: string; to: string } }) {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/margin-reports/below-cost-sales?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <p className="hint-text">Line-level, not averaged — a single below-cost sale doesn't hide inside an otherwise-profitable SKU.</p>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && rows.length === 0 && <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)" }}><p style={{ margin: 0 }}>No below-cost sales in this range.</p></div>}
      {rows && rows.length > 0 && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Bill</th><th>Date</th><th>Item</th><th>Batch</th><th>Qty</th><th>Sold for</th><th>Cost</th><th>Loss</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.bill_number}</td><td>{new Date(r.business_date).toLocaleDateString("en-IN")}</td>
                  <td>{r.product_name}</td><td>{r.batch_no}</td><td>{r.quantity_base_units}</td>
                  <td>₹{Number(r.taxable_value).toFixed(2)}</td><td>₹{Number(r.cost).toFixed(2)}</td>
                  <td className="stock-out">₹{Number(r.loss).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SchemesTab({ range }: { range: { from: string; to: string } }) {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/margin-reports/scheme-shortfalls?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <p className="hint-text">Only invoice lines where a promised quantity was actually recorded at purchase entry, and less than promised arrived.</p>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && rows.length === 0 && <p className="hint-text">No scheme shortfalls in this range.</p>}
      {rows && rows.length > 0 && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Invoice date</th><th>Invoice #</th><th>Vendor</th><th>Item</th><th>Promised qty</th><th>Actual qty</th><th>Promised free</th><th>Actual free</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{new Date(r.invoice_date).toLocaleDateString("en-IN")}</td><td>{r.invoice_number}</td><td>{r.vendor_name}</td><td>{r.product_name}</td>
                  <td>{r.promised_quantity_base_units ?? "—"}</td><td>{r.actual_quantity_base_units}</td>
                  <td>{r.promised_free_quantity_base_units ?? "—"}</td><td>{r.actual_free_quantity_base_units}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
