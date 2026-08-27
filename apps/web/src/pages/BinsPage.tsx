import { useEffect, useState } from "react";
import { api, apiPdfUrl, ApiError } from "../api.js";
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

type Tab = "list" | "rack-map";

export default function BinsPage() {
  const [tab, setTab] = useState<Tab>("list");
  const [bins, setBins] = useState<Bin[]>([]);
  const [zoneFilter, setZoneFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [renaming, setRenaming] = useState<Bin | null>(null);
  const [merging, setMerging] = useState<Bin | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function retire(bin: Bin) {
    setError(null);
    try {
      await api.patch(`/bins/${bin.id}`, { status: "retired" });
      load();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "bin_has_stock") {
        setError(`${bin.code} still holds ${err.body.details?.quantityBaseUnits ?? "some"} unit(s) — move or merge its stock out first.`);
      } else {
        setError(`Could not retire ${bin.code}.`);
      }
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

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {([["list", "List"], ["rack-map", "Rack map"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {showCreate && <CreateBinModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {renaming && <RenameBinModal bin={renaming} onClose={() => setRenaming(null)} onRenamed={() => { setRenaming(null); load(); }} />}
      {merging && <MergeBinModal bin={merging} bins={bins} onClose={() => setMerging(null)} onMerged={() => { setMerging(null); load(); }} />}

      {tab === "list" && (
        <div className="card">
          {error && <p className="error-text">{error}</p>}
          <table className="data-table">
            <thead><tr><th>Code</th><th>Zone</th><th>Restricted</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600, fontFamily: "monospace" }}>{b.code}</td>
                  <td>{b.zone ? <span className="badge badge-info">{ZONE_LABELS[b.zone] ?? b.zone}</span> : "—"}</td>
                  <td>{b.restricted ? <span className="badge badge-warn">PIN required</span> : ""}</td>
                  <td>{b.status}</td>
                  <td style={{ display: "flex", gap: 4 }}>
                    {b.status === "active" && (
                      <>
                        <button className="btn-secondary" onClick={() => setRenaming(b)}>Rename</button>
                        <button className="btn-secondary" onClick={() => setMerging(b)}>Merge into…</button>
                        <button className="btn-secondary" onClick={() => retire(b)}>Retire</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {bins.length === 0 && <p className="hint-text">No bins match this filter.</p>}
        </div>
      )}
      {tab === "rack-map" && <RackMapTab />}
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

function RenameBinModal({ bin, onClose, onRenamed }: { bin: Bin; onClose: () => void; onRenamed: () => void }) {
  const [code, setCode] = useState(bin.code);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/bins/${bin.id}`, { code });
      onRenamed();
    } catch {
      setError("Could not rename — code may already be in use.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 360, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Rename {bin.code}</h3>
        <div className="field"><label>New code</label><input style={{ width: "100%" }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus /></div>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !code}>{busy ? "Saving…" : "Rename"}</button>
        </div>
      </div>
    </div>
  );
}

function MergeBinModal({ bin, bins, onClose, onMerged }: { bin: Bin; bins: Bin[]; onClose: () => void; onMerged: () => void }) {
  const [targetBinId, setTargetBinId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/bins/${bin.id}/merge`, { targetBinId });
      setResult(
        res.taskIds.length > 0
          ? `${res.taskIds.length} move task(s) queued on Put-away — ${bin.code} can be retired once they're all confirmed.`
          : `${bin.code} has no stock to move.`
      );
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not merge.") : "Could not merge.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 420, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Merge {bin.code} into…</h3>
        <p className="hint-text">
          Queues a put-away task for every item currently in {bin.code}, moving it into the target bin — never a silent record change.
          {bin.code} can be retired once a floor staffer has scan-confirmed every task.
        </p>
        {result && <p>{result}</p>}
        {error && <p className="error-text">{error}</p>}
        {!result && (
          <>
            <div className="field">
              <label>Target bin</label>
              <select value={targetBinId} onChange={(e) => setTargetBinId(e.target.value)}>
                <option value="">Choose a bin…</option>
                {bins.filter((b) => b.id !== bin.id && b.status === "active").map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={busy || !targetBinId} onClick={submit}>{busy ? "Queuing…" : "Merge"}</button>
            </div>
          </>
        )}
        {result && <button className="btn-secondary" onClick={onMerged}>Close</button>}
      </div>
    </div>
  );
}

interface RackMapBin {
  id: string;
  code: string;
  zone: string | null;
  aisle: string | null;
  bay: string | null;
  shelfLevel: string | null;
  position: number | null;
  capacityScore: number | null;
  quantityBaseUnits: number;
  value: number;
  fillPercent: number | null;
}

function fillColor(fillPercent: number | null): string {
  if (fillPercent === null) return "var(--surface)";
  const pct = Math.min(fillPercent, 100);
  // Empty -> pale, full -> a real heat colour. Plain CSS var mixing, no
  // colour meaning beyond "more stock value sitting here."
  return `color-mix(in srgb, var(--status-warn) ${Math.round(pct)}%, var(--surface))`;
}

function RackMapTab() {
  const [bins, setBins] = useState<RackMapBin[] | null>(null);
  const [dragBin, setDragBin] = useState<RackMapBin | null>(null);
  const [reslot, setReslot] = useState<{ source: RackMapBin; target: RackMapBin } | null>(null);

  async function load() {
    setBins(await api.get("/bins/rack-map"));
  }
  useEffect(() => { load(); }, []);

  if (!bins) return <p>Loading…</p>;

  const regular = bins.filter((b) => b.aisle);
  const special = bins.filter((b) => !b.aisle);
  const aisles = [...new Set(regular.map((b) => b.aisle))].sort();

  return (
    <div>
      <p className="hint-text">
        Section 10.2: fill % is each bin's stock (base units) against its own capacity score; darker = more value sitting there.
        Drag a bin onto another to reslot its stock — this queues a put-away task, exactly like Move stock on the Inventory screen.
      </p>
      {aisles.map((aisle) => {
        const bays = [...new Set(regular.filter((b) => b.aisle === aisle).map((b) => b.bay))].sort();
        return (
          <div key={aisle} className="card" style={{ marginBottom: 12 }}>
            <div className="hint-text" style={{ marginBottom: 6 }}>Aisle {aisle}</div>
            {bays.map((bay) => (
              <div key={bay} style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                {regular.filter((b) => b.aisle === aisle && b.bay === bay).map((b) => (
                  <div
                    key={b.id}
                    draggable
                    onDragStart={() => setDragBin(b)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragBin && dragBin.id !== b.id) setReslot({ source: dragBin, target: b }); }}
                    title={`${b.code} — ${b.quantityBaseUnits} units, ₹${b.value}`}
                    style={{
                      width: 90, padding: 6, borderRadius: 4, border: "1px solid var(--border)",
                      background: fillColor(b.fillPercent), cursor: "grab", fontSize: 11,
                    }}
                  >
                    <div style={{ fontFamily: "monospace", fontWeight: 600 }}>{b.code}</div>
                    <div>{b.fillPercent ?? 0}% · ₹{Math.round(b.value)}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
      {special.length > 0 && (
        <div className="card">
          <div className="hint-text" style={{ marginBottom: 6 }}>Special zones</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {special.map((b) => (
              <div key={b.id} title={`${b.code} — ${b.quantityBaseUnits} units, ₹${b.value}`} style={{ width: 90, padding: 6, borderRadius: 4, border: "1px solid var(--border)", background: fillColor(b.fillPercent), fontSize: 11 }}>
                <div style={{ fontFamily: "monospace", fontWeight: 600 }}>{b.code}</div>
                <div>{b.fillPercent ?? 0}% · ₹{Math.round(b.value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {reslot && <ReslotModal source={reslot.source} target={reslot.target} onClose={() => setReslot(null)} onDone={() => { setReslot(null); load(); }} />}
    </div>
  );
}

function ReslotModal({ source, target, onClose, onDone }: { source: RackMapBin; target: RackMapBin; onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get(`/inventory/stock?binId=${source.id}`).then(setLines); }, [source.id]);

  async function submit() {
    if (!selected || Number(quantity) <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/inventory/move-stock", {
        productId: selected.product_id, batchId: selected.batch_id,
        sourceBinId: source.id, destinationBinId: target.id, quantityBaseUnits: Number(quantity),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? (err.body?.error ?? "Could not queue this move.") : "Could not queue this move.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 460, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Reslot {source.code} → {target.code}</h3>
        {error && <p className="error-text">{error}</p>}
        {lines === null && <p>Loading…</p>}
        {lines && lines.length === 0 && <p className="hint-text">{source.code} has no stock to move.</p>}
        {lines && lines.length > 0 && (
          <>
            <div className="field">
              <label>Item</label>
              <select value={selected ? `${selected.batch_id}` : ""} onChange={(e) => setSelected(lines.find((l) => l.batch_id === e.target.value) ?? null)}>
                <option value="">Choose…</option>
                {lines.map((l) => <option key={l.batch_id} value={l.batch_id}>{l.product_name} — {l.batch_no} ({l.quantity_base_units} available)</option>)}
              </select>
            </div>
            {selected && (
              <div className="field">
                <label>Quantity (max {selected.quantity_base_units})</label>
                <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={busy || !selected || !quantity} onClick={submit}>{busy ? "Queuing…" : "Queue move task"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
