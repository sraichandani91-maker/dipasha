import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";

const WEB_MANUAL_REASON_CODES = ["scanner_unavailable", "remote_correction", "device_failure", "training"];

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
}

/**
 * Section 6.6 put-away. The web console has no scanner (Section 10.1),
 * so this is manual bin-code entry with a mandatory reason code —
 * source: web_manual on the ledger, never pretending to be a real scan.
 */
export default function PutAwayPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  async function load() {
    setTasks(await api.get("/putaway-tasks"));
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Put-away queue</h2>
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
    </div>
  );
}

function ConfirmModal({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [binCode, setBinCode] = useState(task.suggestedBinCode ?? "");
  const [reasonCode, setReasonCode] = useState(WEB_MANUAL_REASON_CODES[0]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/putaway-tasks/${task.id}/confirm`, { scannedBinCode: binCode.toUpperCase(), reasonCode, note, deviceId: "web-console" });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "zone_violation") {
        setError(`This product must go into a ${err.body.requiredZone}-* bin — ${binCode} isn't one.`);
      } else if (err instanceof ApiError && err.body?.error === "bin_not_found") {
        setError("No active bin with that code.");
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
          <button className="btn-primary" disabled={busy || !binCode || !note} onClick={confirm}>{busy ? "Confirming…" : "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}
