import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Prescriber {
  id: string;
  name: string;
  registration_number: string | null;
  speciality: string | null;
  clinic_or_hospital: string | null;
  phone: string | null;
  address: string | null;
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Section 9A.1 — prescriber master and the commercial-intelligence
 * reports built on top of it (sales by prescriber, molecule mix, new
 * prescribers, dropped volume). Owner/Store Manager only, same bar as
 * the API routes — this links patients to prescriptions.
 */
export default function PrescribersPage() {
  const [tab, setTab] = useState<"directory" | "sales" | "molecules" | "new" | "dropped">("directory");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Prescribers</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {([
          ["directory", "Directory"], ["sales", "Sales by prescriber"], ["molecules", "Molecule mix"],
          ["new", "New this range"], ["dropped", "Dropped volume"],
        ] as Array<[typeof tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "directory" && <DirectoryTab />}
      {tab === "sales" && <SalesByPrescriberTab />}
      {tab === "molecules" && <MoleculesTab />}
      {tab === "new" && <NewPrescribersTab />}
      {tab === "dropped" && <DroppedVolumeTab />}
    </div>
  );
}

function DirectoryTab() {
  const [list, setList] = useState<Prescriber[]>([]);
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", registrationNumber: "", speciality: "", clinicOrHospital: "", phone: "", address: "" });
  const [busy, setBusy] = useState(false);

  async function load(search?: string) {
    setList(await api.get(`/prescribers${search ? `?search=${encodeURIComponent(search)}` : ""}`));
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      await api.post("/prescribers", {
        name: form.name,
        registrationNumber: form.registrationNumber || null,
        speciality: form.speciality || null,
        clinicOrHospital: form.clinicOrHospital || null,
        phone: form.phone || null,
        address: form.address || null,
      });
      setForm({ name: "", registrationNumber: "", speciality: "", clinicOrHospital: "", phone: "", address: "" });
      setShowNew(false);
      await load(q);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Search by name…" value={q} onChange={(e) => { setQ(e.target.value); load(e.target.value); }} style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancel" : "+ New prescriber"}</button>
        </div>
        {showNew && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <div className="field"><label>Name *</label><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
            <div className="field"><label>Registration no.</label><input value={form.registrationNumber} onChange={(e) => setForm((f) => ({ ...f, registrationNumber: e.target.value }))} /></div>
            <div className="field"><label>Speciality</label><input value={form.speciality} onChange={(e) => setForm((f) => ({ ...f, speciality: e.target.value }))} /></div>
            <div className="field"><label>Clinic / hospital</label><input value={form.clinicOrHospital} onChange={(e) => setForm((f) => ({ ...f, clinicOrHospital: e.target.value }))} /></div>
            <div className="field"><label>Phone</label><input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></div>
            <div className="field"><label>Address</label><input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></div>
            <div style={{ alignSelf: "flex-end" }}><button className="btn-primary" disabled={busy || !form.name.trim()} onClick={create}>{busy ? "Saving…" : "Save"}</button></div>
          </div>
        )}
      </div>
      <div className="card">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Reg. no.</th><th>Speciality</th><th>Clinic / hospital</th><th>Phone</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}><td>{p.name}</td><td>{p.registration_number ?? "—"}</td><td>{p.speciality ?? "—"}</td><td>{p.clinic_or_hospital ?? "—"}</td><td>{p.phone ?? "—"}</td></tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="hint-text">No prescribers found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RangePicker({ range, setRange }: { range: { from: string; to: string }; setRange: (r: { from: string; to: string }) => void }) {
  return (
    <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
      <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
      <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
    </div>
  );
}

function SalesByPrescriberTab() {
  const [range, setRange] = useState(defaultRange());
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/prescribers/reports/sales-by-prescriber?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <RangePicker range={range} setRange={setRange} />
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Prescriber</th><th>Clinic / hospital</th><th>Bills</th><th>Taxable value</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}><td>{r.prescriber_name}</td><td>{r.clinic_or_hospital ?? "—"}</td><td>{r.bill_count}</td><td>₹{Number(r.total_taxable_value).toFixed(2)}</td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="hint-text">No prescriber-linked sales in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MoleculesTab() {
  const [range, setRange] = useState(defaultRange());
  const [prescribers, setPrescribers] = useState<Prescriber[]>([]);
  const [prescriberId, setPrescriberId] = useState("");
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api.get("/prescribers").then(setPrescribers); }, []);
  async function load() {
    if (!prescriberId) return;
    setRows(await api.get(`/prescribers/${prescriberId}/reports/molecules?from=${range.from}&to=${range.to}`));
  }
  return (
    <div>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field">
          <label>Prescriber</label>
          <select style={{ width: 260 }} value={prescriberId} onChange={(e) => setPrescriberId(e.target.value)}>
            <option value="">Select…</option>
            {prescribers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-primary" disabled={!prescriberId} onClick={load}>Run</button>
      </div>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Salt / molecule</th><th>Units sold</th><th>Bills</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}><td>{r.salt_name}</td><td>{r.total_quantity}</td><td>{r.bill_count}</td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="hint-text">No molecule data for this prescriber in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewPrescribersTab() {
  const [range, setRange] = useState(defaultRange());
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/prescribers/reports/new-this-range?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <RangePicker range={range} setRange={setRange} />
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Clinic / hospital</th><th>First sale</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}><td>{r.name}</td><td>{r.clinic_or_hospital ?? "—"}</td><td>{new Date(r.first_date).toLocaleDateString("en-IN")}</td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="hint-text">No new prescribers added in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DroppedVolumeTab() {
  const [windowDays, setWindowDays] = useState(30);
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/prescribers/reports/dropped-volume?windowDays=${windowDays}`)); }
  return (
    <div>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field"><label>Comparison window (days)</label><input type="number" style={{ width: 100 }} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} /></div>
        <button className="btn-primary" onClick={load}>Run</button>
      </div>
      <p className="hint-text">Compares each prescriber's last window against the window before it — a prescriber who's quietly stopped sending patients your way.</p>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Prescriber</th><th>Prior window bills</th><th>Recent window bills</th><th>Change</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const dropPercent = r.prior_bill_count > 0 ? Math.round((1 - r.recent_bill_count / r.prior_bill_count) * 1000) / 10 : 100;
                return (
                  <tr key={i}>
                    <td>{r.name}</td><td>{r.prior_bill_count}</td><td>{r.recent_bill_count}</td>
                    <td className="stock-out">-{dropPercent}%</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={4} className="hint-text">No drop-offs found for this window.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
