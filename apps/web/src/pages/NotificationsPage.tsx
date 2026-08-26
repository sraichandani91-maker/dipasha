import { useState } from "react";
import { api, ApiError } from "../api.js";

interface NotificationRow {
  id: string;
  trigger_type: string;
  category: string;
  recipient_name: string | null;
  recipient_phone: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  sent: "Sent",
  logged_dev_mode: "Logged (dev mode)",
  failed: "Failed",
  skipped_opted_out: "Skipped — opted out",
  skipped_trigger_disabled: "Skipped — trigger off",
};

function StatusBadge({ status }: { status: string }) {
  const cls = status === "failed" ? "badge-warn" : status.startsWith("skipped") ? "" : status === "pending" ? "badge-info" : "badge-info";
  return <span className={`badge ${cls}`} style={status === "failed" ? { background: "color-mix(in srgb, var(--status-bad) 15%, white)", color: "var(--status-bad)" } : undefined}>{STATUS_LABEL[status] ?? status}</span>;
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Section 12A.5 — the WhatsApp send log and Failed Notifications list.
 * "A permanent failure surfaces here, never silently disappears." Also
 * the honest monthly spend report (Section 12A.1) — currently always
 * ₹0 since no real WhatsApp provider reports a per-message cost yet.
 */
export default function NotificationsPage() {
  const [tab, setTab] = useState<"log" | "failed" | "spend">("log");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Notifications</h2>
      <p className="hint-text">
        No real WhatsApp provider is configured yet (see DECISIONS.md) — every send below was logged on the server
        rather than actually delivered. This log is real and will keep working the same way once one is wired up.
      </p>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "log" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("log")}>Send log</button>
        <button className={tab === "failed" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("failed")}>Failed</button>
        <button className={tab === "spend" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("spend")}>Monthly spend</button>
      </div>
      {tab === "log" && <LogTab />}
      {tab === "failed" && <FailedTab />}
      {tab === "spend" && <SpendTab />}
    </div>
  );
}

function LogTab() {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  async function load() { setRows(await api.get("/notifications")); }
  return (
    <div>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Load recent</button>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>When</th><th>Trigger</th><th>Recipient</th><th>Status</th><th>Attempts</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString("en-IN")}</td>
                  <td>{r.trigger_type}</td>
                  <td>{r.recipient_name ?? "—"} · {r.recipient_phone}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.attempts}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="hint-text">No notifications yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FailedTab() {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() { setRows(await api.get("/notifications?status=failed")); }

  async function retry(id: string) {
    setRetryingId(id);
    setError(null);
    try {
      await api.post(`/notifications/${id}/retry`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? "Could not retry — try again." : "Could not retry.");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div>
      <p className="hint-text">Delivery was attempted and gave up after the configured number of retries — these need a human look.</p>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Load failed</button>
      {error && <p className="error-text">{error}</p>}
      {rows && rows.length === 0 && <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)" }}><p style={{ margin: 0 }}>Nothing failed.</p></div>}
      {rows && rows.length > 0 && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>When</th><th>Trigger</th><th>Recipient</th><th>Error</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString("en-IN")}</td>
                  <td>{r.trigger_type}</td>
                  <td>{r.recipient_name ?? "—"} · {r.recipient_phone}</td>
                  <td className="hint-text">{r.last_error ?? "—"}</td>
                  <td><button className="btn-secondary" disabled={retryingId === r.id} onClick={() => retry(r.id)}>{retryingId === r.id ? "Retrying…" : "Retry"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SpendTab() {
  const [range, setRange] = useState(defaultRange());
  const [data, setData] = useState<any>(null);
  async function load() { setData(await api.get(`/notifications/spend-summary?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-primary" onClick={load}>Run</button>
      </div>
      {data && (
        <div className="card">
          {!data.hasCostData && <p className="hint-text">No real provider cost data exists yet — every send below is ₹0 until one is wired up.</p>}
          <table className="data-table">
            <thead><tr><th>Status</th><th>Count</th><th>Cost</th></tr></thead>
            <tbody>
              {data.byStatus.map((r: any, i: number) => (
                <tr key={i}><td>{STATUS_LABEL[r.status] ?? r.status}</td><td>{r.count}</td><td>₹{Number(r.total_cost).toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontWeight: 700, marginTop: 8 }}>Total: ₹{data.totalCost.toFixed(2)}</p>
        </div>
      )}
    </div>
  );
}
