import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import SearchBar from "../components/SearchBar.js";

interface RefillDueRow {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  product_name: string;
  pack_size: number;
  base_unit: string;
  prescriber_name: string | null;
  daily_dose_base_units: string;
  last_purchase_date: string | null;
  last_purchase_quantity_base_units: number | null;
  expected_exhaustion_date: string;
  days_until_exhaustion: number;
  is_overdue: boolean;
  is_churn_risk: boolean;
  standing_order_enabled: boolean;
  manually_notified_at: string | null;
}

type Tab = "refill-due" | "patients";

/**
 * Section 9A.3 — chronic patients and refill management. "The highest-
 * return report in the whole system" (the refill-due/overdue/churn list)
 * is the default tab; the second tab manages the underlying (customer,
 * product) chronic flags and doubles as the patient-profile lookup.
 * Owner/store_manager only, same patient-data bar as Prescribers/Credit
 * customers.
 */
export default function ChronicPage() {
  const [tab, setTab] = useState<Tab>("refill-due");
  const [showNewModal, setShowNewModal] = useState(false);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ marginTop: 0 }}>Chronic patients</h2>
        <button className="btn-primary" onClick={() => setShowNewModal(true)}>+ Flag chronic medication</button>
      </div>
      <p className="hint-text">
        Section 9A.3 — the customer who buys the same thing every month is a pharmacy's most reliable revenue.
        Overdue by more than a few days is a churn signal worth a phone call.
      </p>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "refill-due" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("refill-due")}>Refill due</button>
        <button className={tab === "patients" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("patients")}>Patient lookup</button>
      </div>
      {tab === "refill-due" && <RefillDueTab />}
      {tab === "patients" && <PatientLookupTab />}
      {showNewModal && <NewChronicModal onClose={() => setShowNewModal(false)} onCreated={() => setShowNewModal(false)} />}
    </div>
  );
}

function RefillDueTab() {
  const [rows, setRows] = useState<RefillDueRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRows(await api.get("/chronic-medications/refill-due"));
  }
  useEffect(() => { load(); }, []);

  async function remindNow(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/chronic-medications/${id}/send-reminder-now`);
      await load();
    } catch {
      setError("Could not send the reminder.");
    } finally {
      setBusyId(null);
    }
  }

  async function markNotified(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/chronic-medications/${id}/mark-notified`);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (rows === null) return <p className="hint-text">Loading…</p>;
  if (rows.length === 0) return <div className="card"><p className="hint-text" style={{ margin: 0 }}>Nothing due — every active chronic flag is well ahead of its refill date.</p></div>;

  return (
    <div>
      {error && <p className="error-text">{error}</p>}
      {rows.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <strong>{r.customer_name}</strong>{" "}
              {r.customer_phone && <span className="hint-text">· {r.customer_phone}</span>}{" "}
              {r.is_churn_risk && <span className="badge badge-bad">Possible churn</span>}
              {r.is_overdue && !r.is_churn_risk && <span className="badge badge-warn">Overdue</span>}
              {!r.is_overdue && <span className="badge badge-info">Due soon</span>}
              {r.standing_order_enabled && <span className="badge badge-info">Standing order</span>}
              <div className="hint-text" style={{ marginTop: 2 }}>
                {r.product_name} · last bought {r.last_purchase_quantity_base_units ?? "—"} {r.base_unit}
                {r.last_purchase_quantity_base_units === 1 ? "" : "s"} on {r.last_purchase_date ? new Date(r.last_purchase_date).toLocaleDateString("en-IN") : "—"}
              </div>
              <div className="hint-text">
                Expected exhaustion {new Date(r.expected_exhaustion_date).toLocaleDateString("en-IN")} —{" "}
                {r.is_overdue ? `${Math.abs(r.days_until_exhaustion)} day(s) overdue` : `due in ${r.days_until_exhaustion} day(s)`}
              </div>
              {r.prescriber_name && <div className="hint-text">Prescriber: {r.prescriber_name}</div>}
              {r.manually_notified_at && <div className="hint-text">Notified {new Date(r.manually_notified_at).toLocaleString("en-IN")}</div>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              {r.customer_phone && <a className="btn-secondary" style={{ textAlign: "center" }} href={`tel:${r.customer_phone}`}>Call</a>}
              <button className="btn-secondary" disabled={busyId === r.id || !r.customer_phone} onClick={() => remindNow(r.id)}>
                {busyId === r.id ? "Sending…" : "Remind via WhatsApp now"}
              </button>
              <button className="btn-secondary" disabled={busyId === r.id} onClick={() => markNotified(r.id)}>Mark notified</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PatientLookupTab() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [profile, setProfile] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(query: string) {
    setQ(query);
    if (!query.trim()) { setResults([]); return; }
    setResults(await api.get(`/customers/search?q=${encodeURIComponent(query)}`));
  }

  async function selectCustomer(c: any) {
    setSelected(c);
    setResults([]);
    setProfile(await api.get(`/customers/${c.id}/chronic-medications`));
  }

  async function pause(id: string, status: "active" | "paused" | "stopped") {
    setError(null);
    try {
      await api.patch(`/chronic-medications/${id}`, { status });
      if (selected) setProfile(await api.get(`/customers/${selected.id}/chronic-medications`));
    } catch {
      setError("Could not update this flag.");
    }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <input placeholder="Search customer by name or phone…" value={q} onChange={(e) => search(e.target.value)} style={{ width: "100%" }} />
        {results.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {results.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => selectCustomer(c)}>
                <span>{c.name}</span><span className="hint-text">{c.phone}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {selected && profile && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{selected.name}'s chronic medications</h3>
          {profile.length === 0 && <p className="hint-text">No chronic medications flagged for this customer yet.</p>}
          {profile.map((m: any) => (
            <div key={m.id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <strong>{m.product_name}</strong>{" "}
                  <span className={`badge ${m.status === "active" ? "badge-info" : ""}`}>{m.status}</span>
                  <div className="hint-text">
                    Dose: {m.daily_dose_base_units} {m.base_unit}/day · pack of {m.pack_size}
                    {m.prescriber_name && ` · Prescriber: ${m.prescriber_name}`}
                  </div>
                  {m.expected_exhaustion_date && <div className="hint-text">Expected exhaustion: {new Date(m.expected_exhaustion_date).toLocaleDateString("en-IN")}</div>}
                  {m.note && <div className="hint-text">Note: {m.note}</div>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {m.status === "active" && <button className="btn-secondary" onClick={() => pause(m.id, "paused")}>Pause</button>}
                  {m.status === "paused" && <button className="btn-secondary" onClick={() => pause(m.id, "active")}>Resume</button>}
                  {m.status !== "stopped" && <button className="btn-secondary" onClick={() => pause(m.id, "stopped")}>Stop</button>}
                </div>
              </div>
              {m.purchase_history?.length > 0 && (
                <table className="data-table" style={{ marginTop: 8 }}>
                  <thead><tr><th>Purchase date</th><th>Qty</th></tr></thead>
                  <tbody>
                    {m.purchase_history.map((h: any, i: number) => (
                      <tr key={i}><td>{new Date(h.business_date).toLocaleDateString("en-IN")}</td><td>{h.quantity_base_units}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewChronicModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<any[]>([]);
  const [customer, setCustomer] = useState<any | null>(null);
  const [product, setProduct] = useState<{ id: string; name: string; baseUnit: string } | null>(null);
  const [dailyDose, setDailyDose] = useState<number | "">("");
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberId, setPrescriberId] = useState<string | null>(null);
  const [prescriberSuggestions, setPrescriberSuggestions] = useState<any[]>([]);
  const [standingOrderEnabled, setStandingOrderEnabled] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function searchCustomer(q: string) {
    setCustomerQuery(q);
    setCustomer(null);
    if (!q.trim()) { setCustomerResults([]); return; }
    setCustomerResults(await api.get(`/customers/search?q=${encodeURIComponent(q)}`));
  }

  async function searchPrescriber(q: string) {
    setPrescriberName(q);
    setPrescriberId(null);
    if (q.trim().length < 2) { setPrescriberSuggestions([]); return; }
    setPrescriberSuggestions(await api.get(`/prescribers?search=${encodeURIComponent(q)}`));
  }

  const canSubmit = customer && product && dailyDose !== "" && Number(dailyDose) > 0;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/chronic-medications", {
        customerId: customer.id,
        productId: product!.id,
        prescriberId,
        dailyDoseBaseUnits: Number(dailyDose),
        standingOrderEnabled,
        note: note || null,
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === "already_flagged") {
        setError("This customer already has a chronic flag for this item.");
      } else {
        setError("Could not create the chronic flag.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 480, maxHeight: "88vh", overflowY: "auto", background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>Flag a chronic medication</h3>

        <div className="field" style={{ position: "relative" }}>
          <label>Customer</label>
          {customer ? (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
              <strong>{customer.name} · {customer.phone}</strong>
              <button className="btn-secondary" onClick={() => setCustomer(null)}>Change</button>
            </div>
          ) : (
            <>
              <input style={{ width: "100%" }} placeholder="Search by name or phone…" value={customerQuery} onChange={(e) => searchCustomer(e.target.value)} />
              {customerResults.length > 0 && (
                <div className="card" style={{ position: "absolute", zIndex: 5, top: "100%", left: 0, right: 0, padding: 4 }}>
                  {customerResults.map((c) => (
                    <div key={c.id} style={{ padding: "4px 6px", cursor: "pointer" }} onClick={() => { setCustomer(c); setCustomerResults([]); }}>
                      {c.name} <span className="hint-text">· {c.phone}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="field">
          <label>Medication</label>
          {product ? (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
              <strong>{product.name}</strong>
              <button className="btn-secondary" onClick={() => setProduct(null)}>Change</button>
            </div>
          ) : (
            <SearchBar context="app_lookup" onSelect={(p) => setProduct({ id: p.id, name: p.name, baseUnit: p.baseUnit })} />
          )}
        </div>

        <div className="field">
          <label>Daily dose ({product?.baseUnit ?? "base unit"}/day) — e.g. 1 tablet daily = 1</label>
          <input type="number" step="0.5" style={{ width: "100%" }} value={dailyDose} onChange={(e) => setDailyDose(e.target.value === "" ? "" : Number(e.target.value))} />
        </div>

        <div className="field" style={{ position: "relative" }}>
          <label>Prescriber (optional)</label>
          <input style={{ width: "100%" }} value={prescriberName} onChange={(e) => searchPrescriber(e.target.value)} placeholder="Start typing to search…" />
          {prescriberId && <span className="badge badge-info">Matched</span>}
          {prescriberSuggestions.length > 0 && (
            <div className="card" style={{ position: "absolute", zIndex: 5, top: "100%", left: 0, right: 0, padding: 4 }}>
              {prescriberSuggestions.map((p) => (
                <div key={p.id} style={{ padding: "4px 6px", cursor: "pointer" }} onClick={() => { setPrescriberId(p.id); setPrescriberName(p.name); setPrescriberSuggestions([]); }}>
                  {p.name} {p.clinic_or_hospital && <span className="hint-text">· {p.clinic_or_hospital}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="field">
          <label><input type="checkbox" checked={standingOrderEnabled} onChange={(e) => setStandingOrderEnabled(e.target.checked)} /> Standing order — auto-create a request each cycle, ready for confirmation</label>
        </div>

        <div className="field"><label>Note (optional)</label><input style={{ width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></div>

        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSubmit || busy} onClick={submit}>{busy ? "Saving…" : "Flag as chronic"}</button>
        </div>
      </div>
    </div>
  );
}
