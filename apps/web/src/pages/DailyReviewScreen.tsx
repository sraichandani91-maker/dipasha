import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { itemLabel, type RequestRow } from "./RequestBookPage.js";

const REVIEWABLE_STATUSES = ["open", "on_po", "received"];

/**
 * Section 6B.5 — the daily forced review: every open/on_po/received
 * request gets looked at, one at a time, with a single tap to either act
 * on it or explicitly defer it. This is deliberately the SAME actions the
 * request book already offers (reserve, link product, could-not-source) —
 * there's no separate "reviewed" flag in the schema, so "reviewed" here
 * means "a human looked at this card and made a call," not a new status.
 */
export default function DailyReviewScreen({ onDone }: { onDone: () => void }) {
  const [queue, setQueue] = useState<RequestRow[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get("/requests").then((rows: RequestRow[]) => {
      setQueue(rows.filter((r) => REVIEWABLE_STATUSES.includes(r.status)));
    });
  }, []);

  if (queue === null) return <div className="card">Loading today's queue…</div>;

  if (index >= queue.length) {
    return (
      <div className="card" style={{ maxWidth: 480, margin: "40px auto", textAlign: "center" }}>
        <h2>Review complete</h2>
        <p className="hint-text">Every open request has been looked at. Anything skipped stays in the request book for next time.</p>
        <button className="btn-primary" onClick={onDone}>Done</button>
      </div>
    );
  }

  const r = queue[index];
  if (!r) return null;

  function advance() {
    setIndex((i) => i + 1);
    setError(null);
  }

  const reserve = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/requests/${r.id}/reserve`, { deviceId: "web-console" });
      advance();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "insufficient_stock") setError("Not enough sellable stock to reserve right now.");
      else if (err instanceof ApiError && err.body?.error === "no_linked_product") setError("Link this to a catalogue product first.");
      else setError("Could not reserve stock.");
    } finally {
      setBusy(false);
    }
  };

  const couldNotSource = async () => {
    setBusy(true);
    try {
      await api.patch(`/requests/${r.id}/status`, { status: "cancelled", couldNotSourceReason: "Closed out during daily review" });
      advance();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: "24px auto" }}>
      <p className="hint-text" style={{ textAlign: "center" }}>Daily request review — {index + 1} of {queue.length}</p>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{itemLabel(r)}</h3>
        <p className="hint-text" style={{ margin: 0 }}>
          {r.customer_name} · {r.customer_phone} · {r.quantity_requested_units ?? r.quantity_requested_note ?? "qty not specified"}
        </p>
        <p className="hint-text">
          Status: <strong>{r.status.replace("_", " ")}</strong> · waiting {r.days_waiting}d
          {r.unreachable_attempts > 0 && ` · ${r.unreachable_attempts} unreachable attempt(s)`}
        </p>
        {r.note && <p className="hint-text">Note: {r.note}</p>}

        {error && <p className="error-text">{error}</p>}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {r.status === "received" && (
            <button className="btn-primary" disabled={busy} onClick={reserve}>Reserve & notify customer</button>
          )}
          <button className="btn-secondary" disabled={busy} onClick={couldNotSource}>Could not source</button>
          <button className="btn-secondary" disabled={busy} onClick={advance}>Skip — review later</button>
        </div>
      </div>
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button className="btn-secondary" onClick={onDone}>Close review</button>
      </div>
    </div>
  );
}
