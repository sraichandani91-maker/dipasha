import { useState } from "react";
import { api, ApiError } from "../api.js";

interface InboxRow {
  id: string;
  from_phone: string;
  body: string;
  received_at: string;
  matched_customer_id: string | null;
  customer_name: string | null;
  matched_order_id: string | null;
  order_number: string | null;
  is_stop_keyword: boolean;
  handled: boolean;
  handled_by_name: string | null;
  handled_at: string | null;
}

/**
 * Section 12A.4 — the WhatsApp inbound shared inbox. Every message a
 * customer sends in lands here, matched to a customer/order where
 * possible (never auto-creating a customer, see repo/whatsapp-inbound.ts).
 * A STOP-keyword message is flagged but still shown, since a human should
 * see that it happened even though the opt-out itself is already automatic.
 */
export default function WhatsAppInboxPage() {
  const [filter, setFilter] = useState<"unhandled" | "all">("unhandled");
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(f: "unhandled" | "all" = filter) {
    setError(null);
    try {
      const qs = f === "unhandled" ? "?handled=false" : "";
      setRows(await api.get(`/whatsapp/inbox${qs}`));
    } catch {
      setError("Could not load the inbox.");
    }
  }

  async function markHandled(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/whatsapp/inbox/${id}/mark-handled`);
      await load();
    } catch {
      setError("Could not mark that message handled.");
    } finally {
      setBusyId(null);
    }
  }

  async function reply(id: string) {
    const body = (replyDrafts[id] ?? "").trim();
    if (!body) return;
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/whatsapp/inbox/${id}/reply`, { body });
      setReplyDrafts((d) => ({ ...d, [id]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? "Could not send the reply — try again." : "Could not send the reply.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>WhatsApp inbox</h2>
      <p className="hint-text">
        Messages customers sent in over WhatsApp. A message matched to an in-progress order also appears on that
        order's conversation thread. "STOP" and similar words opt the customer out automatically — no action needed
        for those unless you want to follow up.
      </p>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={filter === "unhandled" ? "btn-primary" : "btn-secondary"} onClick={() => { setFilter("unhandled"); load("unhandled"); }}>Unhandled</button>
        <button className={filter === "all" ? "btn-primary" : "btn-secondary"} onClick={() => { setFilter("all"); load("all"); }}>All</button>
        <button className="btn-secondary" onClick={() => load()}>Refresh</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {rows === null && <p className="hint-text">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)" }}>
          <p style={{ margin: 0 }}>Nothing here.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div key={r.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <strong>{r.customer_name ?? r.from_phone}</strong>
                  {r.customer_name && <span className="hint-text"> · {r.from_phone}</span>}
                  {r.order_number && <span className="badge badge-info" style={{ marginLeft: 8 }}>Order {r.order_number}</span>}
                  {r.is_stop_keyword && <span className="badge" style={{ marginLeft: 8, background: "color-mix(in srgb, var(--status-bad) 15%, white)", color: "var(--status-bad)" }}>STOP — opted out</span>}
                  {!r.matched_customer_id && <span className="hint-text" style={{ marginLeft: 8 }}>(unmatched number)</span>}
                </div>
                <span className="hint-text">{new Date(r.received_at).toLocaleString("en-IN")}</span>
              </div>
              <p style={{ margin: "8px 0" }}>{r.body}</p>
              {r.handled ? (
                <p className="hint-text" style={{ margin: 0 }}>
                  Handled{r.handled_by_name ? ` by ${r.handled_by_name}` : ""}{r.handled_at ? ` at ${new Date(r.handled_at).toLocaleString("en-IN")}` : ""}
                </p>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input
                    type="text"
                    placeholder="Reply…"
                    value={replyDrafts[r.id] ?? ""}
                    onChange={(e) => setReplyDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    style={{ flex: 1 }}
                  />
                  <button className="btn-primary" disabled={busyId === r.id || !(replyDrafts[r.id] ?? "").trim()} onClick={() => reply(r.id)}>
                    {busyId === r.id ? "Sending…" : "Send reply"}
                  </button>
                  <button className="btn-secondary" disabled={busyId === r.id} onClick={() => markHandled(r.id)}>Mark handled</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
