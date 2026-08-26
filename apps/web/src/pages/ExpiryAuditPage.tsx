import { useEffect, useState } from "react";
import { api } from "../api.js";

interface ExpiryRow {
  batchId: string;
  productId: string;
  productName: string;
  batchNo: string;
  expiryDate: string;
  daysToExpiry: number;
  bucket: "expired" | "30" | "60" | "90";
  totalQuantityBaseUnits: number;
  valueAtRiskMrp: number;
  blocked: boolean;
}

const BUCKET_LABELS: Record<string, string> = { expired: "Already expired", "30": "Within 30 days", "60": "31–60 days", "90": "61–90 days" };
const BUCKET_ORDER = ["expired", "30", "60", "90"];

/**
 * Section 9 expiry audit — rolling 90/60/30-day report with value at
 * risk. "Move to QC" blocks the batch immediately (stops FEFO picking
 * that instant) and creates a put-away task to physically relocate it —
 * a human still has to confirm the move, same as every other bin move.
 */
export default function ExpiryAuditPage() {
  const [rows, setRows] = useState<ExpiryRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRows(await api.get("/expiry-audit"));
  }
  useEffect(() => { load(); }, []);

  async function moveToQuarantine(batchId: string) {
    setBusyId(batchId);
    setError(null);
    try {
      await api.post(`/expiry-audit/${batchId}/move-to-quarantine`, { deviceId: "web-console" });
      await load();
    } catch {
      setError("Could not create the quarantine move — check the QC bin is configured.");
    } finally {
      setBusyId(null);
    }
  }

  if (rows === null) return <p>Loading…</p>;

  const grouped = BUCKET_ORDER.map((b) => ({ bucket: b, rows: rows.filter((r) => r.bucket === b) })).filter((g) => g.rows.length > 0);
  const totalValueAtRisk = rows.reduce((a, r) => a + r.valueAtRiskMrp, 0);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Expiry audit</h2>
      <p className="hint-text">Section 9 — everything expiring within 90 days, with value at risk at MRP. Total: ₹{totalValueAtRisk.toFixed(2)}.</p>
      {error && <p className="error-text">{error}</p>}

      {rows.length === 0 && <div className="card"><p className="hint-text" style={{ margin: 0 }}>Nothing expiring within 90 days.</p></div>}

      {grouped.map((g) => (
        <div key={g.bucket} style={{ marginTop: 16 }}>
          <h3>{BUCKET_LABELS[g.bucket]} ({g.rows.length})</h3>
          <div className="card">
            <table className="data-table">
              <thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th>Qty</th><th>Value at risk</th><th></th></tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.batchId}>
                    <td>{r.productName}</td>
                    <td>{r.batchNo}</td>
                    <td className={g.bucket === "expired" || g.bucket === "30" ? "stock-out" : ""}>
                      {new Date(r.expiryDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} ({r.daysToExpiry}d)
                    </td>
                    <td>{r.totalQuantityBaseUnits}</td>
                    <td>₹{r.valueAtRiskMrp.toFixed(2)}</td>
                    <td>
                      {r.blocked ? (
                        <span className="badge badge-warn">Already quarantined</span>
                      ) : (
                        <button className="btn-secondary" disabled={busyId === r.batchId} onClick={() => moveToQuarantine(r.batchId)}>
                          {busyId === r.batchId ? "Moving…" : "Move to QC — return to vendor"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
