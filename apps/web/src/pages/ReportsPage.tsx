import { useEffect, useState } from "react";
import { api, downloadFile } from "../api.js";

type Tab = "registers" | "gstr1" | "gstr3b" | "traceability" | "inventory" | "exceptions" | "sync-conflicts" | "manual-overrides";

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

const DISCLAIMER = "Working file for your accountant's review — computed from this system's own records, not a filing and not guaranteed to match the GST portal's exact format.";

/**
 * Section 10A — statutory and compliance reports. Every report here is
 * computed on demand, never a separately-maintained copy, and every
 * screen repeats the same caveat rather than burying it in docs
 * (10A.6): these are working files for a human to review, not
 * filing-ready output.
 */
export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("registers");
  const [range, setRange] = useState(defaultRange());

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Statutory reports</h2>
      <p className="hint-text" style={{ background: "color-mix(in srgb, var(--status-warn) 10%, white)", padding: 8, borderRadius: 6 }}>{DISCLAIMER}</p>

      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {([
          ["registers", "Registers"], ["gstr1", "GSTR-1"], ["gstr3b", "GSTR-3B"],
          ["traceability", "Batch traceability"], ["inventory", "Location-wise inventory"], ["exceptions", "Negative stock"],
          ["sync-conflicts", "Sync conflicts"], ["manual-overrides", "Manual overrides"],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab !== "traceability" && tab !== "inventory" && tab !== "exceptions" && tab !== "sync-conflicts" && tab !== "manual-overrides" && (
        <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
          <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
          <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        </div>
      )}

      {tab === "registers" && <RegistersTab range={range} />}
      {tab === "gstr1" && <Gstr1Tab range={range} />}
      {tab === "gstr3b" && <Gstr3bTab range={range} />}
      {tab === "traceability" && <TraceabilityTab />}
      {tab === "inventory" && <InventoryTab />}
      {tab === "exceptions" && <ExceptionsTab />}
      {tab === "sync-conflicts" && <SyncConflictsTab />}
      {tab === "manual-overrides" && <ManualOverridesTab />}
    </div>
  );
}

// Section 10.1: "Surface every web_manual row on a dedicated Manual
// Override report" — every scan-backed action done from web without a
// scanner (put-away, pick, pack, rider handover, cycle count entry),
// each with the reason code and note the person supplied at the time.
function ManualOverridesTab() {
  const [rows, setRows] = useState<any[] | null>(null);

  function load() {
    api.get("/reports/manual-overrides").then(setRows);
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <p className="hint-text">
        Every action recorded as manual entry because web has no scanner (Section 10.1). Not a sign of misuse on its own —
        it's the entire operation today, since there's no separate scanning client yet — but every row here is visible, not silently absorbed.
      </p>
      <button className="btn-secondary" onClick={load} style={{ marginBottom: 8 }}>Refresh</button>
      <table className="data-table">
        <thead><tr><th>When</th><th>Action</th><th>Reference</th><th>Reason</th><th>Note</th><th>By</th><th>Device</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.occurredAt).toLocaleString()}</td>
              <td>{r.action}</td>
              <td>{r.referenceType ?? "—"} {r.referenceId ? r.referenceId.slice(0, 8) : ""}</td>
              <td>{r.reasonCode ?? "—"}</td>
              <td>{r.note ?? "—"}</td>
              <td>{r.actorName}</td>
              <td>{r.deviceId}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={7} className="hint-text">No manual overrides recorded.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// Section 6A.9 / Section 11: "any conflict escalated to the Owner rather
// than silently resolved." A queued offline sale that couldn't replay
// (most often stock moved while the device was offline) lands here,
// durable on the server regardless of which device raised it.
function SyncConflictsTab() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "resolved" | "">("open");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    setRows(await api.get(`/sync-conflicts${statusFilter ? `?status=${statusFilter}` : ""}`));
  }

  async function resolve(id: string) {
    if (!note.trim()) return;
    await api.post(`/sync-conflicts/${id}/resolve`, { resolutionNote: note });
    setResolvingId(null);
    setNote("");
    await load();
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </select>
        <button className="btn-primary" onClick={load}>Load</button>
      </div>
      {rows && rows.length === 0 && <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)" }}><p style={{ margin: 0 }}>Nothing here.</p></div>}
      {rows && rows.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 8 }}>
          <p style={{ margin: 0 }}><strong>{r.conflict_type}</strong> · device {r.device_id} · raised by {r.raised_by_name} · {new Date(r.created_at).toLocaleString("en-IN")}</p>
          <p className="hint-text" style={{ margin: "4px 0" }}>
            {r.original_payload?.customerName ?? "Walk-in"} — bill {r.original_payload?.preAssignedBillNumber} · {JSON.stringify(r.error_details)}
          </p>
          {r.status === "resolved" && <p className="hint-text">Resolved: {r.resolution_note}</p>}
          {r.status === "open" && resolvingId !== r.id && (
            <button className="btn-secondary" onClick={() => setResolvingId(r.id)}>Resolve</button>
          )}
          {r.status === "open" && resolvingId === r.id && (
            <div>
              <input placeholder="How was this handled?" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 300 }} />
              <button className="btn-primary" onClick={() => resolve(r.id)} style={{ marginLeft: 8 }}>Save</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RegistersTab({ range }: { range: { from: string; to: string } }) {
  const registers = [
    { key: "sales-register", label: "Sales register" },
    { key: "purchase-register", label: "Purchase register" },
    { key: "non-gst-movement-register", label: "Non-GST movement register" },
    { key: "credit-debit-note-register", label: "Credit / debit note register" },
  ];
  return (
    <div className="card">
      {registers.map((r) => (
        <div key={r.key} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
          <span>{r.label}</span>
          <button
            className="btn-secondary"
            onClick={() => downloadFile(`/statutory-reports/${r.key}?from=${range.from}&to=${range.to}&format=csv`, `${r.key}-${range.from}-to-${range.to}.csv`)}
          >
            Download CSV
          </button>
        </div>
      ))}
    </div>
  );
}

function Gstr1Tab({ range }: { range: { from: string; to: string } }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setData(await api.get(`/statutory-reports/gstr1?from=${range.from}&to=${range.to}`));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button className="btn-primary" disabled={loading} onClick={load}>{loading ? "Loading…" : "Run GSTR-1 working"}</button>
      {data && (
        <div style={{ marginTop: 12 }}>
          <p className="hint-text">{data.disclaimer}</p>

          <h4>B2C small (consolidated by rate)</h4>
          <div className="card">
            <table className="data-table">
              <thead><tr><th>Rate</th><th>Invoices</th><th>Taxable</th><th>CGST</th><th>SGST</th></tr></thead>
              <tbody>
                {data.b2cSmall.map((r: any) => (
                  <tr key={r.gst_rate}><td>{r.gst_rate}%</td><td>{r.invoice_count}</td><td>₹{r.taxable_value}</td><td>₹{r.cgst_amount}</td><td>₹{r.sgst_amount}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginTop: 16 }}>HSN-wise summary</h4>
          <div className="card">
            <div style={{ textAlign: "right", marginBottom: 8 }}>
              <button className="btn-secondary" onClick={() => downloadFile(`/statutory-reports/gstr1/hsn-summary?from=${range.from}&to=${range.to}&format=csv`, `gstr1-hsn-summary-${range.from}-to-${range.to}.csv`)}>Download CSV</button>
            </div>
            <table className="data-table">
              <thead><tr><th>HSN</th><th>Sample item</th><th>UQC</th><th>Qty</th><th>Rate</th><th>Taxable</th></tr></thead>
              <tbody>
                {data.hsnSummary.map((r: any, i: number) => (
                  <tr key={i}><td>{r.hsn_code}</td><td>{r.sample_description}</td><td>{r.uqc}</td><td>{r.total_quantity}</td><td>{r.gst_rate}%</td><td>₹{r.taxable_value}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginTop: 16 }}>Document series summary</h4>
          <div className="card">
            <table className="data-table">
              <thead><tr><th>Series</th><th>From</th><th>To</th><th>Issued</th><th>Cancelled</th><th>Net</th></tr></thead>
              <tbody>
                {data.documentSeriesSummary.map((r: any, i: number) => (
                  <tr key={i}><td>{r.series_prefix}</td><td>{r.from_number}</td><td>{r.to_number}</td><td>{r.total_issued}</td><td>{r.cancelled}</td><td>{r.net}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.b2b.length === 0 && (
            <p className="hint-text" style={{ marginTop: 12 }}>B2B: empty — no counter sale in this build captures a customer GSTIN yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Gstr3bTab({ range }: { range: { from: string; to: string } }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setData(await api.get(`/statutory-reports/gstr3b?from=${range.from}&to=${range.to}`));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button className="btn-primary" disabled={loading} onClick={load}>{loading ? "Loading…" : "Run GSTR-3B working"}</button>
      {data && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="hint-text">{data.disclaimer}</p>
          <h4>Outward taxable supplies by rate</h4>
          <table className="data-table">
            <thead><tr><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th></tr></thead>
            <tbody>
              {data.outwardByRate.map((r: any) => (
                <tr key={r.gst_rate}><td>{r.gst_rate}%</td><td>₹{r.taxable_value}</td><td>₹{r.cgst_amount}</td><td>₹{r.sgst_amount}</td></tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ marginTop: 12 }}>Input tax credit</h4>
          <p>Available — CGST ₹{data.itcAvailable.cgst.toFixed(2)} · SGST ₹{data.itcAvailable.sgst.toFixed(2)} · IGST ₹{data.itcAvailable.igst.toFixed(2)}</p>
          <p className="hint-text">Reversed — ₹0.00 (no eligibility-tracking data source in this build yet; verify manually)</p>
          <p style={{ fontSize: 18, fontWeight: 700 }}>Net tax payable (working): ₹{data.netTaxPayableWorking.toFixed(2)}</p>
        </div>
      )}
    </div>
  );
}

function TraceabilityTab() {
  const [batchNo, setBatchNo] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!batchNo.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.get(`/statutory-reports/batch-traceability?batchNo=${encodeURIComponent(batchNo.trim())}`));
    } catch {
      setError("Could not run the lookup.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="hint-text">Enter a batch number to get every inbound, every sale, and every customer who received it — ready for a recall notice.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input placeholder="Batch number" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <button className="btn-primary" disabled={loading} onClick={search}>{loading ? "Searching…" : "Look up"}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {result && result.batches.length === 0 && <p className="hint-text" style={{ marginTop: 8 }}>No batch found with that number.</p>}
      {result && result.batches.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="card">
            <strong>{result.batches.length} matching batch record(s)</strong>
            {result.batches.map((b: any) => (
              <div key={b.id} className="hint-text">Expiry {new Date(b.expiry_date).toLocaleDateString("en-IN")} · MRP ₹{b.mrp}</div>
            ))}
          </div>
          <h4 style={{ marginTop: 12 }}>Inbound ({result.inbound.length})</h4>
          <div className="card"><table className="data-table"><tbody>
            {result.inbound.map((r: any, i: number) => <tr key={i}><td>{r.invoice_date}</td><td>{r.invoice_number}</td><td>{r.vendor_name}</td><td>{r.quantity_base_units}</td></tr>)}
          </tbody></table></div>
          <h4 style={{ marginTop: 12 }}>Sold to ({result.outbound.length})</h4>
          <div className="card"><table className="data-table"><tbody>
            {result.outbound.map((r: any, i: number) => <tr key={i}><td>{new Date(r.created_at).toLocaleDateString("en-IN")}</td><td>{r.bill_number}</td><td>{r.customer_name}</td><td>{r.customer_phone}</td><td>{r.quantity_base_units}</td></tr>)}
          </tbody></table></div>
          <h4 style={{ marginTop: 12 }}>Customers to notify ({result.affectedCustomers.length})</h4>
          <div className="card">
            {result.affectedCustomers.map((c: any, i: number) => <div key={i}>{c.name} — {c.phone}</div>)}
            {result.affectedCustomers.length === 0 && <p className="hint-text" style={{ margin: 0 }}>No phone numbers captured for these sales.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function InventoryTab() {
  const [rows, setRows] = useState<any[] | null>(null);

  async function load() {
    setRows(await api.get("/statutory-reports/location-wise-inventory"));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button className="btn-primary" onClick={load}>Load</button>
        <button className="btn-secondary" onClick={() => downloadFile("/statutory-reports/location-wise-inventory?format=csv", "location-wise-inventory.csv")}>Download CSV</button>
        <button className="btn-secondary" onClick={() => downloadFile("/statutory-reports/bin-count-sheet?format=csv", "bin-count-sheet.csv")}>Download blind count sheet</button>
      </div>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Zone</th><th>Bin</th><th>Item</th><th>Batch</th><th>Qty</th><th>MRP value</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}><td>{r.zone ?? "—"}</td><td>{r.bin_code}</td><td>{r.product_name}</td><td>{r.batch_no}</td><td>{r.quantity_base_units}</td><td>₹{r.mrp_value}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExceptionsTab() {
  const [rows, setRows] = useState<any[] | null>(null);

  async function load() {
    setRows(await api.get("/statutory-reports/negative-stock-exception"));
  }

  return (
    <div>
      <p className="hint-text">On a correct ledger this should always be empty. If it isn't, something is wrong and you want to know today.</p>
      <button className="btn-primary" onClick={load}>Check now</button>
      {rows && rows.length === 0 && <div className="card" style={{ marginTop: 8, background: "color-mix(in srgb, var(--status-good) 10%, white)" }}><p style={{ margin: 0 }}>Clean — no negative stock anywhere.</p></div>}
      {rows && rows.length > 0 && (
        <div className="card" style={{ marginTop: 8 }}>
          <table className="data-table">
            <thead><tr><th>Item</th><th>Batch</th><th>Bin</th><th>Quantity</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}><td>{r.product_name}</td><td>{r.batch_no}</td><td>{r.bin_code}</td><td className="stock-out">{r.quantity_base_units}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
