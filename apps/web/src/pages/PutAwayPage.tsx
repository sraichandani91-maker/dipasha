import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";

const WEB_MANUAL_REASON_CODES = ["scanner_unavailable", "remote_correction", "device_failure", "training"];
const VARIANCE_REASON_CODES = ["short_received", "excess_received", "damaged_in_transit", "miscount_at_entry", "other"];
const VARIANCE_ELIGIBLE_REFERENCE_TYPES = ["purchase_invoice", "stock_received"];

interface Task {
  id: string;
  productName: string;
  batchNo: string;
  expiryDate: string;
  quantityBaseUnits: number;
  stagingBinCode: string;
  suggestedBinCode: string | null;
  isColdChain: boolean;
  scheduleCategory: string;
  referenceType: string;
}

/**
 * Section 6.6 put-away. The web console has no scanner (Section 10.1),
 * so this is manual bin-code entry with a mandatory reason code —
 * source: web_manual on the ledger, never pretending to be a real scan.
 */
export default function PutAwayPage() {
  const [tab, setTab] = useState<"queue" | "variances">("queue");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  async function load() {
    setTasks(await api.get("/putaway-tasks"));
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Put-away</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "queue" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("queue")}>Queue</button>
        <button className={tab === "variances" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("variances")}>Receiving variances</button>
      </div>

      {tab === "queue" && (
        <>
          <p className="hint-text">
            Stock sitting in staging, waiting to be moved to its shelf bin. No scanner on the web console (Section 10.1) —
            every confirmation here is manual entry with a mandatory reason, logged as <code>source = web_manual</code>.
          </p>

          {tasks.length === 0 && <div className="card"><p className="hint-text" style={{ margin: 0 }}>Nothing pending.</p></div>}

          {tasks.map((t) => (
            <div key={t.id} className="card" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{t.productName}</strong>
                {t.isColdChain && <span className="badge badge-info" style={{ marginLeft: 8 }}>Cold chain — must go to CC-*</span>}
                {t.scheduleCategory === "H1" && <span className="badge badge-warn" style={{ marginLeft: 8 }}>H1 — must go to SH-*</span>}
                <div className="hint-text">
                  Batch {t.batchNo} · exp {new Date(t.expiryDate).toLocaleDateString("en-IN", { month: "short", year: "2-digit" })} ·
                  {" "}{t.quantityBaseUnits} units in {t.stagingBinCode}
                  {t.suggestedBinCode && <> · suggested bin <strong>{t.suggestedBinCode}</strong></>}
                </div>
              </div>
              <button className="btn-primary" onClick={() => setActiveTask(t)}>Confirm put-away</button>
            </div>
          ))}

          {activeTask && (
            <ConfirmModal
              task={activeTask}
              onClose={() => setActiveTask(null)}
              onDone={() => { setActiveTask(null); load(); }}
            />
          )}
        </>
      )}

      {tab === "variances" && <VariancesTab />}
    </div>
  );
}

function VariancesTab() {
  const [statusFilter, setStatusFilter] = useState<"open" | "resolved">("open");
  const [rows, setRows] = useState<any[] | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  async function load() {
    setRows(await api.get(`/putaway-variances?status=${statusFilter}`));
  }
  useEffect(() => { load(); }, [statusFilter]);

  return (
    <div>
      <p className="hint-text">
        Section 6.6: what a receipt was invoiced or entered for, versus what put-away staff actually counted while
        moving it out of staging. Every variance needs a resolution note before it's considered closed.
      </p>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={statusFilter === "open" ? "btn-primary" : "btn-secondary"} onClick={() => setStatusFilter("open")}>Open</button>
        <button className={statusFilter === "resolved" ? "btn-primary" : "btn-secondary"} onClick={() => setStatusFilter("resolved")}>Resolved</button>
      </div>
      {rows?.length === 0 && <div className="card"><p className="hint-text" style={{ margin: 0 }}>None.</p></div>}
      {rows?.map((v) => (
        <div key={v.id} className="card" style={{ marginBottom: 8 }}>
          <strong>{v.product_name}</strong> — batch {v.batch_no}
          <div className="hint-text">
            Expected {v.expected_quantity_base_units}, found {v.actual_quantity_base_units}
            {" "}({v.variance_base_units > 0 ? "+" : ""}{v.variance_base_units}) · {v.reason_code.replace(/_/g, " ")} · {v.note}
            {" "}· reported by {v.reported_by_name}, {new Date(v.created_at).toLocaleString("en-IN")}
          </div>
          {v.status === "resolved" ? (
            <div className="hint-text" style={{ marginTop: 4 }}>Resolved by {v.resolved_by_name}: {v.resolution_note}</div>
          ) : resolvingId === v.id ? (
            <ResolveVarianceForm variance={v} onDone={() => { setResolvingId(null); load(); }} onCancel={() => setResolvingId(null)} />
          ) : (
            <button className="btn-secondary" style={{ marginTop: 4 }} onClick={() => setResolvingId(v.id)}>Resolve</button>
          )}
        </div>
      ))}
    </div>
  );
}

function ResolveVarianceForm({ variance, onDone, onCancel }: { variance: any; onDone: () => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function resolve() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api.post(`/putaway-variances/${variance.id}/resolve`, { resolutionNote: note });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input placeholder="e.g. vendor credit note requested, accepted as data-entry error…" style={{ width: 360 }} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn-primary" disabled={busy || !note.trim()} onClick={resolve} style={{ marginLeft: 8 }}>Save</button>
      <button className="btn-secondary" disabled={busy} onClick={onCancel} style={{ marginLeft: 8 }}>Cancel</button>
    </div>
  );
}

function ConfirmModal({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [binCode, setBinCode] = useState(task.suggestedBinCode ?? "");
  const [reasonCode, setReasonCode] = useState(WEB_MANUAL_REASON_CODES[0]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const varianceEligible = VARIANCE_ELIGIBLE_REFERENCE_TYPES.includes(task.referenceType);
  const [actualQuantityFound, setActualQuantityFound] = useState(task.quantityBaseUnits);
  const [varianceReasonCode, setVarianceReasonCode] = useState(VARIANCE_REASON_CODES[0]);
  const [varianceNote, setVarianceNote] = useState("");
  const hasVariance = varianceEligible && actualQuantityFound !== task.quantityBaseUnits;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/putaway-tasks/${task.id}/confirm`, {
        scannedBinCode: binCode.toUpperCase(), reasonCode, note, deviceId: "web-console",
        ...(varianceEligible ? { actualQuantityFound } : {}),
        ...(hasVariance ? { varianceReasonCode, varianceNote } : {}),
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "zone_violation") {
        setError(`This product must go into a ${err.body.requiredZone}-* bin — ${binCode} isn't one.`);
      } else if (err instanceof ApiError && err.body?.error === "bin_not_found") {
        setError("No active bin with that code.");
      } else if (err instanceof ApiError && err.body?.error === "variance_reason_required") {
        setError("A variance reason and note are required when the quantity found doesn't match.");
      } else {
        setError("Could not confirm — check the bin code and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 380, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Confirm put-away — {task.productName}</h3>
        <p className="hint-text">Type the bin code in full — never select a pre-filled dropdown (Section 10.1).</p>
        <div className="field">
          <label>Bin code</label>
          <input style={{ width: "100%" }} value={binCode} onChange={(e) => setBinCode(e.target.value.toUpperCase())} autoFocus />
        </div>
        {varianceEligible && (
          <div className="field">
            <label>Quantity found ({task.quantityBaseUnits} recorded)</label>
            <input type="number" style={{ width: "100%" }} value={actualQuantityFound} onChange={(e) => setActualQuantityFound(Number(e.target.value))} />
          </div>
        )}
        {hasVariance && (
          <div className="card" style={{ background: "color-mix(in srgb, var(--status-warn, orange) 10%, white)", marginBottom: 8 }}>
            <p className="hint-text" style={{ margin: "0 0 8px" }}>
              {actualQuantityFound - task.quantityBaseUnits > 0 ? "+" : ""}{actualQuantityFound - task.quantityBaseUnits} vs. what was recorded — this gets logged as a receiving variance for resolution.
            </p>
            <div className="field">
              <label>Variance reason</label>
              <select style={{ width: "100%" }} value={varianceReasonCode} onChange={(e) => setVarianceReasonCode(e.target.value)}>
                {VARIANCE_REASON_CODES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div className="field"><label>Variance note (required)</label><input style={{ width: "100%" }} value={varianceNote} onChange={(e) => setVarianceNote(e.target.value)} /></div>
          </div>
        )}
        <div className="field">
          <label>Reason (no scanner on web)</label>
          <select style={{ width: "100%" }} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {WEB_MANUAL_REASON_CODES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div className="field"><label>Note</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !binCode || !note || (hasVariance && !varianceNote.trim())} onClick={confirm}>{busy ? "Confirming…" : "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}
