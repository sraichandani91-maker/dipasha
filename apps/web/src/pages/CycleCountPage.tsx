import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import QuantityInput from "../components/QuantityInput.js";
import SearchBar from "../components/SearchBar.js";

interface Task {
  id: string;
  bin_id: string;
  bin_code: string;
  selection_reason: string;
  status: "pending" | "counted" | "reviewed";
  assigned_to_name: string | null;
  counted_by_name: string | null;
  total_variance_value: string | null;
  escalated_to: string | null;
  review_outcome: string | null;
}

const REASON_LABELS: Record<string, string> = {
  highest_value: "Highest value",
  highest_movement: "Highest movement",
  longest_since_counted: "Longest since counted",
  flagged_variance_history: "Flagged history",
  manual: "Manual",
};

/**
 * Section 9 cycle counting — daily blind count of N bins. "Blind means
 * blind": the counting modal never receives or displays a system
 * quantity, only what's supposed to be in the bin (product/batch), so
 * there's nothing here even a curious counter could read off.
 */
export default function CycleCountPage() {
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "store_manager";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [countingTask, setCountingTask] = useState<Task | null>(null);
  const [reviewingTask, setReviewingTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setTasks(await api.get("/cycle-counts/today"));
  }
  useEffect(() => { load(); }, []);

  async function generateToday() {
    setBusy(true);
    try {
      await api.post("/cycle-counts/generate-today", { deviceId: "web-console" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const grouped = {
    pending: tasks.filter((t) => t.status === "pending"),
    counted: tasks.filter((t) => t.status === "counted"),
    reviewed: tasks.filter((t) => t.status === "reviewed"),
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ marginTop: 0 }}>Cycle count — today</h2>
        {canManage && (
          <button className="btn-primary" disabled={busy} onClick={generateToday}>
            {busy ? "Generating…" : tasks.length > 0 ? "Top up today's queue" : "Generate today's queue"}
          </button>
        )}
      </div>
      <p className="hint-text">
        Section 9 — blind count of a rotating set of bins. Selected by highest value, highest movement, longest
        since last counted, and flagged variance history. The counter never sees the system quantity.
      </p>

      {tasks.length === 0 && <div className="card"><p className="hint-text" style={{ margin: 0 }}>No bins queued yet today.</p></div>}

      {(["pending", "counted", "reviewed"] as const).map((status) =>
        grouped[status].length === 0 ? null : (
          <div key={status} style={{ marginTop: 16 }}>
            <h3 style={{ textTransform: "capitalize" }}>{status} ({grouped[status].length})</h3>
            {grouped[status].map((t) => (
              <div key={t.id} className="card" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>{t.bin_code}</strong>{" "}
                  <span className="badge badge-info">{REASON_LABELS[t.selection_reason] ?? t.selection_reason}</span>
                  {t.escalated_to && <span className="badge badge-bad" style={{ marginLeft: 6 }}>Escalated to {t.escalated_to}</span>}
                  {t.review_outcome && <span className={`badge ${t.review_outcome === "approved" ? "badge-good" : "badge-warn"}`} style={{ marginLeft: 6 }}>{t.review_outcome}</span>}
                  {t.total_variance_value !== null && <div className="hint-text">Variance value: ₹{Number(t.total_variance_value).toFixed(2)}</div>}
                  {t.counted_by_name && <div className="hint-text">Counted by {t.counted_by_name}</div>}
                </div>
                {status === "pending" && <button className="btn-primary" onClick={() => setCountingTask(t)}>Count this bin</button>}
                {status === "counted" && canManage && <button className="btn-primary" onClick={() => setReviewingTask(t)}>Review variance</button>}
              </div>
            ))}
          </div>
        )
      )}

      {countingTask && (
        <CountModal task={countingTask} onClose={() => setCountingTask(null)} onDone={() => { setCountingTask(null); load(); }} />
      )}
      {reviewingTask && (
        <ReviewModal task={reviewingTask} onClose={() => setReviewingTask(null)} onDone={() => { setReviewingTask(null); load(); }} />
      )}
    </div>
  );
}

interface CountLine {
  id: string;
  product_id: string;
  product_name: string;
  pack_size: number;
  base_unit: string;
  batch_id: string;
  batch_no: string;
  expiry_date: string;
}
interface ExtraFind {
  productId: string;
  productName: string;
  batchNo: string;
  countedQuantityBaseUnits: number;
  note: string;
}

function CountModal({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<CountLine[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [extraFinds, setExtraFinds] = useState<ExtraFind[]>([]);
  const [showAddFind, setShowAddFind] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/cycle-counts/${task.id}`).then((res) => setLines(res.lines));
  }, [task.id]);

  function addExtraFind(p: any) {
    setExtraFinds((f) => [...f, { productId: p.id, productName: p.name, batchNo: "", countedQuantityBaseUnits: 0, note: "" }]);
    setShowAddFind(false);
  }

  const allCounted = lines !== null && lines.every((l) => counts[l.id] !== undefined) && extraFinds.every((f) => f.batchNo.trim() && f.countedQuantityBaseUnits > 0);

  async function submit() {
    if (!lines) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/cycle-counts/${task.id}/submit`, {
        counts: lines.map((l) => ({ lineId: l.id, countedQuantityBaseUnits: counts[l.id] ?? 0 })),
        extraFinds: extraFinds.filter((f) => f.batchNo.trim()).map((f) => ({ productId: f.productId, batchNo: f.batchNo.trim(), countedQuantityBaseUnits: f.countedQuantityBaseUnits, note: f.note || null })),
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "unknown_batch") {
        setError("One of the found items has a batch number that doesn't exist in the catalogue — double-check it.");
      } else {
        setError("Could not submit the count — try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 560, maxHeight: "90vh", overflowY: "auto", background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Blind count — bin {task.bin_code}</h3>
        <p className="hint-text">Count what's physically in this bin. No system quantity is shown — this is a real blind count.</p>

        {lines === null && <p>Loading…</p>}
        {lines && lines.map((l) => (
          <div key={l.id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <strong>{l.product_name}</strong>
            <div className="hint-text">Batch {l.batch_no} · Exp {new Date(l.expiry_date).toLocaleDateString("en-IN", { month: "short", year: "2-digit" })}</div>
            <div style={{ marginTop: 6 }}>
              <QuantityInput packSize={l.pack_size} baseUnitLabel={l.base_unit} packLabel="Strips" onChange={(q) => setCounts((c) => ({ ...c, [l.id]: q }))} />
            </div>
          </div>
        ))}

        {extraFinds.map((f, idx) => (
          <div key={idx} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0", background: "color-mix(in srgb, var(--status-warn) 8%, white)" }}>
            <strong>{f.productName}</strong> <span className="badge badge-warn">Unexpected find</span>
            <div className="field" style={{ marginTop: 6 }}>
              <label>Batch number</label>
              <input value={f.batchNo} onChange={(e) => setExtraFinds((fs) => fs.map((x, i) => i === idx ? { ...x, batchNo: e.target.value } : x))} placeholder="Type the batch number found" />
            </div>
            <div className="field">
              <label>Quantity found (base units)</label>
              <input type="number" style={{ width: 100 }} value={f.countedQuantityBaseUnits} onChange={(e) => setExtraFinds((fs) => fs.map((x, i) => i === idx ? { ...x, countedQuantityBaseUnits: Number(e.target.value) } : x))} />
            </div>
            <p className="hint-text">The batch must already exist in the catalogue under this product — type the batch number exactly as printed.</p>
          </div>
        ))}

        {lines && (
          <div style={{ marginTop: 10 }}>
            <button className="btn-secondary" onClick={() => setShowAddFind((s) => !s)}>{showAddFind ? "Hide" : "+ Found something unexpected"}</button>
            {showAddFind && <div style={{ marginTop: 8 }}><SearchBar context="app_lookup" onSelect={addExtraFind} /></div>}
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!allCounted || busy} onClick={submit}>{busy ? "Submitting…" : "Submit count"}</button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function review(outcome: "approved" | "rejected") {
    setBusy(true);
    try {
      await api.post(`/cycle-counts/${task.id}/review`, { outcome, note: note || null, deviceId: "web-console" });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 420, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Review variance — bin {task.bin_code}</h3>
        <p>Total variance value: <strong>₹{Number(task.total_variance_value ?? 0).toFixed(2)}</strong></p>
        {task.escalated_to && <p className="error-text">Escalated to {task.escalated_to} — above the auto-escalation threshold.</p>}
        <div className="field"><label>Note (optional)</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <p className="hint-text">Approve writes an adjustment to bring the system in line with the physical count. Reject leaves stock as-is (the count is disputed).</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-secondary" disabled={busy} onClick={() => review("rejected")}>Reject</button>
          <button className="btn-primary" disabled={busy} onClick={() => review("approved")}>Approve</button>
        </div>
      </div>
    </div>
  );
}
