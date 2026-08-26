import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import RequestFormModal from "../components/RequestFormModal.js";
import SearchBar from "../components/SearchBar.js";

export interface RequestRow {
  id: string;
  customer_name: string;
  customer_phone: string;
  product_id: string | null;
  product_name: string | null;
  pending_product_id: string | null;
  pending_product_name: string | null;
  free_text_item: string | null;
  quantity_requested_units: number | null;
  quantity_requested_note: string | null;
  urgency: "urgent" | "normal" | "can_wait";
  has_prescription_in_hand: boolean;
  expected_date: string | null;
  note: string | null;
  status: string;
  could_not_source_reason: string | null;
  unreachable_attempts: number;
  days_waiting: number;
  purchase_order_id: string | null;
}

const TABS: Array<{ key: string; label: string; statuses: string[] | null }> = [
  { key: "open", label: "Open", statuses: ["open"] },
  { key: "on_po", label: "On PO", statuses: ["on_po"] },
  { key: "callback", label: "Callback queue", statuses: ["received"] },
  { key: "notified", label: "Notified", statuses: ["customer_notified"] },
  { key: "history", label: "History", statuses: ["fulfilled", "cancelled", "lapsed"] },
];

function UrgencyBadge({ urgency }: { urgency: string }) {
  const cls = urgency === "urgent" ? "badge-bad" : urgency === "normal" ? "badge-info" : "";
  return <span className={`badge ${cls}`}>{urgency.replace("_", " ")}</span>;
}

export function itemLabel(r: RequestRow): string {
  return r.product_name ?? r.pending_product_name ?? r.free_text_item ?? "(unknown item)";
}

/**
 * Section 6B — customer request book, callback queue (status=received),
 * and the fulfilment hand-off into POS. `onFulfillAtPos` lifts a chosen
 * request up to App so it can switch to the Billing tab and pre-load the
 * line — the web console has no router, so this is a plain prop bridge.
 */
export default function RequestBookPage({ onFulfillAtPos }: { onFulfillAtPos: (req: RequestRow) => void }) {
  const { user } = useAuth();
  const canBill = user?.role === "owner" || user?.role === "store_manager";
  const [tab, setTab] = useState("open");
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [showNewModal, setShowNewModal] = useState(false);
  const [linkingRow, setLinkingRow] = useState<RequestRow | null>(null);
  const [outcomeRow, setOutcomeRow] = useState<RequestRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  async function load() {
    setRows(await api.get("/requests"));
  }
  useEffect(() => { load(); }, []);

  const activeTab = TABS.find((t) => t.key === tab)!;
  const visible = rows.filter((r) => activeTab.statuses === null || activeTab.statuses.includes(r.status));

  async function reserve(r: RequestRow) {
    setBusyId(r.id);
    setRowError((e) => ({ ...e, [r.id]: "" }));
    try {
      await api.post(`/requests/${r.id}/reserve`, { deviceId: "web-console" });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "insufficient_stock") {
        setRowError((e) => ({ ...e, [r.id]: "Not enough sellable stock to reserve right now." }));
      } else if (err instanceof ApiError && err.body?.error === "no_linked_product") {
        setRowError((e) => ({ ...e, [r.id]: "Link this to a catalogue product first." }));
      } else {
        setRowError((e) => ({ ...e, [r.id]: "Could not reserve stock." }));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function markUnreachable(r: RequestRow) {
    setBusyId(r.id);
    try {
      await api.patch(`/requests/${r.id}/unreachable`);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ marginTop: 0 }}>Customer request book</h2>
        <button className="btn-primary" onClick={() => setShowNewModal(true)}>+ New request</button>
      </div>
      <p className="hint-text">
        Section 6B — the single most valuable data a pharmacy throws away. Every "we don't have it" gets logged here,
        fed into purchase orders, and looped back to the customer when stock arrives.
      </p>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(t.key)}>
            {t.label} ({t.statuses === null ? rows.length : rows.filter((r) => t.statuses!.includes(r.status)).length})
          </button>
        ))}
      </div>

      {visible.length === 0 && <div className="card"><p className="hint-text" style={{ margin: 0 }}>Nothing here.</p></div>}

      {visible.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <strong>{itemLabel(r)}</strong>{" "}
              <UrgencyBadge urgency={r.urgency} />{" "}
              {r.has_prescription_in_hand && <span className="badge badge-info">Rx in hand</span>}
              {!r.product_id && !r.pending_product_id && <span className="badge badge-warn">Unmatched item</span>}
              <div className="hint-text" style={{ marginTop: 2 }}>
                {r.customer_name} · {r.customer_phone} ·{" "}
                {r.quantity_requested_units ?? r.quantity_requested_note ?? "qty not specified"} ·{" "}
                {r.days_waiting === 0 ? "logged today" : `waiting ${r.days_waiting}d`}
                {r.unreachable_attempts > 0 && ` · ${r.unreachable_attempts} unreachable attempt${r.unreachable_attempts === 1 ? "" : "s"}`}
              </div>
              {r.note && <div className="hint-text">Note: {r.note}</div>}
              {r.could_not_source_reason && <div className="hint-text">Could not source: {r.could_not_source_reason}</div>}
            </div>
            <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              {r.status === "open" && !r.product_id && (
                <button className="btn-secondary" onClick={() => setLinkingRow(r)}>Link to catalogue product</button>
              )}
              {r.status === "received" && (
                <>
                  <button className="btn-primary" disabled={busyId === r.id} onClick={() => reserve(r)}>
                    {busyId === r.id ? "Reserving…" : "Reserve & notify customer"}
                  </button>
                  {!r.product_id && !r.pending_product_id && (
                    <button className="btn-secondary" onClick={() => setLinkingRow(r)}>Link to catalogue product</button>
                  )}
                </>
              )}
              {r.status === "customer_notified" && (
                <>
                  {canBill && <button className="btn-primary" onClick={() => onFulfillAtPos(r)}>Customer arrived — bill now</button>}
                  <button className="btn-secondary" disabled={busyId === r.id} onClick={() => markUnreachable(r)}>
                    Could not reach customer
                  </button>
                </>
              )}
              {["open", "on_po", "received", "customer_notified"].includes(r.status) && (
                <button className="btn-secondary" onClick={() => setOutcomeRow(r)}>Could not source / cancel</button>
              )}
              {rowError[r.id] && <p className="error-text" style={{ margin: 0, fontSize: 12 }}>{rowError[r.id]}</p>}
            </div>
          </div>
        </div>
      ))}

      {showNewModal && (
        <RequestFormModal onClose={() => setShowNewModal(false)} onCreated={() => { setShowNewModal(false); load(); }} />
      )}

      {linkingRow && (
        <LinkProductModal row={linkingRow} onClose={() => setLinkingRow(null)} onLinked={() => { setLinkingRow(null); load(); }} />
      )}

      {outcomeRow && (
        <OutcomeModal row={outcomeRow} onClose={() => setOutcomeRow(null)} onDone={() => { setOutcomeRow(null); load(); }} />
      )}
    </div>
  );
}

function LinkProductModal({ row, onClose, onLinked }: { row: RequestRow; onClose: () => void; onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  async function link(productId: string) {
    setBusy(true);
    try {
      await api.patch(`/requests/${row.id}/link-pending-product`, { productId });
      onLinked();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 480, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Link "{row.free_text_item}" to a catalogue product</h3>
        <p className="hint-text">Once the item exists in the product master, link it here so the callback loop can match GRNs against it.</p>
        <SearchBar context="request_book" onSelect={(p) => !busy && link(p.id)} />
        <div style={{ marginTop: 10, textAlign: "right" }}>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function OutcomeModal({ row, onClose, onDone }: { row: RequestRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function cancel() {
    setBusy(true);
    try {
      await api.patch(`/requests/${row.id}/status`, { status: "cancelled", couldNotSourceReason: reason || null });
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 420, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Close out this request</h3>
        <p className="hint-text">{row.customer_name} — {itemLabel(row)}</p>
        <div className="field"><label>Reason (optional)</label><input style={{ width: "100%" }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. vendor discontinued, customer no longer needs it" /></div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Back</button>
          <button className="btn-primary" disabled={busy} onClick={cancel}>{busy ? "Closing…" : "Close request"}</button>
        </div>
      </div>
    </div>
  );
}
