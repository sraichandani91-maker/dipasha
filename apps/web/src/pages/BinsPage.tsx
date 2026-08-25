import { useEffect, useState } from "react";
import { api, apiPdfUrl } from "../api.js";
import { getTokens } from "../api.js";

interface Bin {
  id: string;
  code: string;
  zone: string | null;
  restricted: boolean;
  status: string;
  pickFrequencyRank: number | null;
}

const ZONE_LABELS: Record<string, string> = {
  CC: "Cold chain", SH: "Schedule H1", RX: "Rx hold", IN: "Inbound staging",
  QC: "Quarantine", PK: "Packed staging", FM: "Fast movers",
};

export default function BinsPage() {
  const [bins, setBins] = useState<Bin[]>([]);
  const [zoneFilter, setZoneFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function load() {
    const q = zoneFilter ? `?zone=${zoneFilter}` : "";
    setBins(await api.get(`/bins${q}`));
  }
  useEffect(() => { load(); }, [zoneFilter]);

  // Label PDFs need the bearer token, so this fetches as a blob rather
  // than a plain <a href> download (Section 4: printable A4 label sheet).
  async function downloadLabels() {
    setDownloading(true);
    try {
      const { accessToken } = getTokens();
      const path = zoneFilter ? `/bins/label-sheet?zone=${zoneFilter}` : "/bins/label-sheet";
      const res = await fetch(apiPdfUrl(path), { headers: { Authorization: `Bearer ${accessToken}` } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bin-labels.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Bin master</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}>
            <option value="">All zones</option>
            {Object.entries(ZONE_LABELS).map(([code, label]) => <option key={code} value={code}>{label} ({code}-*)</option>)}
          </select>
          <button className="btn-secondary" onClick={downloadLabels} disabled={downloading}>
            {downloading ? "Building PDF…" : "Print label sheet (A4)"}
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New bin</button>
        </div>
      </div>

      {showCreate && <CreateBinModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}

      <div className="card">
        <table className="data-table">
          <thead><tr><th>Code</th><th>Zone</th><th>Restricted</th><th>Status</th></tr></thead>
          <tbody>
            {bins.map((b) => (
              <tr key={b.id}>
                <td style={{ fontWeight: 600, fontFamily: "monospace" }}>{b.code}</td>
                <td>{b.zone ? <span className="badge badge-info">{ZONE_LABELS[b.zone] ?? b.zone}</span> : "—"}</td>
                <td>{b.restricted ? <span className="badge badge-warn">PIN required</span> : ""}</td>
                <td>{b.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bins.length === 0 && <p className="hint-text">No bins match this filter.</p>}
      </div>
    </div>
  );
}

function CreateBinModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.post("/bins", { code });
      onCreated();
    } catch {
      setError("Could not create bin — check the code format (A-03-B-2 or CC-01).");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 360, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>New bin</h3>
        <div className="field">
          <label>Bin code</label>
          <input style={{ width: "100%" }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="A-03-B-2 or CC-01" autoFocus />
        </div>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !code}>{busy ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}
