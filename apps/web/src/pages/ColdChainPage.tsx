import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Section 9 / Section 10.2: cold-chain temperature log + gap alerts.
 * One shop-wide reading stream — no per-fridge/unit model exists
 * anywhere in this build (bins only carry a CC zone flag), so this
 * doesn't invent a multi-unit concept the schema never supported. See
 * DECISIONS.md if the shop actually runs more than one cold-chain unit.
 */
export default function ColdChainPage() {
  const [gap, setGap] = useState<any>(null);
  const [logs, setLogs] = useState<any[] | null>(null);
  const [temperature, setTemperature] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setGap(await api.get("/cold-chain/gap-check"));
    setLogs(await api.get("/cold-chain/temperature-logs"));
  }
  useEffect(() => { load(); }, []);

  async function submit() {
    if (temperature === "") return;
    setBusy(true);
    try {
      await api.post("/cold-chain/temperature-logs", { temperatureCelsius: Number(temperature), note: note || null, deviceId: "web-console" });
      setTemperature("");
      setNote("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Cold chain</h2>
      <p className="hint-text">
        Section 9: a temperature reading log for cold-chain storage, with an alert when a reading is missing or out
        of range for too long. Acceptable range and check frequency are configured — CONFIRM the defaults below
        against your actual equipment.
      </p>

      {gap && (gap.hasGap || gap.lastReadingOutOfRange) && (
        <div className="card" style={{ background: "color-mix(in srgb, var(--status-bad, red) 10%, white)", marginBottom: 16 }}>
          {gap.hasGap && (
            <p style={{ margin: "0 0 4px" }}>
              {gap.lastReadingAt
                ? `No reading in ${gap.hoursSinceLastReading}h — expected at least every ${gap.maxGapHours}h.`
                : `No temperature reading has ever been logged (expected at least every ${gap.maxGapHours}h).`}
            </p>
          )}
          {gap.lastReadingOutOfRange && (
            <p style={{ margin: 0 }}>The most recent reading was outside the acceptable {gap.minCelsius}–{gap.maxCelsius}°C range.</p>
          )}
        </div>
      )}
      {gap && !gap.hasGap && !gap.lastReadingOutOfRange && (
        <div className="card" style={{ background: "color-mix(in srgb, var(--status-good) 10%, white)", marginBottom: 16 }}>
          <p style={{ margin: 0 }}>Last reading {gap.hoursSinceLastReading}h ago, within range ({gap.minCelsius}–{gap.maxCelsius}°C).</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Log a reading</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field"><label>Temperature °C</label><input type="number" step="0.1" style={{ width: 100 }} value={temperature} onChange={(e) => setTemperature(e.target.value)} /></div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}><label>Note (optional)</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <button className="btn-primary" disabled={busy || temperature === ""} onClick={submit}>{busy ? "Saving…" : "Log reading"}</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent readings</h3>
        <table className="data-table">
          <thead><tr><th>When</th><th>°C</th><th>In range</th><th>Note</th><th>By</th></tr></thead>
          <tbody>
            {logs?.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.recorded_at).toLocaleString("en-IN")}</td>
                <td>{l.temperature_celsius}</td>
                <td>{l.in_range ? <span className="badge badge-good">yes</span> : <span className="badge badge-bad">no</span>}</td>
                <td>{l.note ?? "—"}</td>
                <td>{l.recorded_by_name}</td>
              </tr>
            ))}
            {logs && logs.length === 0 && <tr><td colSpan={5} className="hint-text">No readings logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
