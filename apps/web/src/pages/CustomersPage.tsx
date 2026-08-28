import { useState } from "react";
import { api, ApiError } from "../api.js";
import { buildReceiptHtml } from "../lib/receipt.js";

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  credit_enabled: boolean;
  credit_limit: number | null;
  account_customer_id: string | null;
  whatsapp_transactional_opt_in: boolean;
  whatsapp_marketing_opt_in: boolean;
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Section 9A.4 — credit customers (khata) with ageing, balances, and
 * payment recording. Owner/Store Manager only, same bar as the API
 * routes — financially sensitive data.
 */
export default function CustomersPage() {
  const [tab, setTab] = useState<"search" | "ageing" | "bulk-import">("search");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Customers</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "search" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("search")}>Customer ledger</button>
        <button className={tab === "ageing" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("ageing")}>Ageing report</button>
        <button className={tab === "bulk-import" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("bulk-import")}>Bulk import</button>
      </div>
      {tab === "search" && <SearchTab />}
      {tab === "ageing" && <AgeingTab />}
      {tab === "bulk-import" && <BulkImportTab />}
    </div>
  );
}

function SearchTab() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CustomerRow[]>([]);
  const [selected, setSelected] = useState<CustomerRow | null>(null);

  async function search(query: string) {
    setQ(query);
    if (!query.trim()) { setResults([]); return; }
    setResults(await api.get(`/customers/search?q=${encodeURIComponent(query)}`));
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <input placeholder="Search by name or phone…" value={q} onChange={(e) => search(e.target.value)} style={{ width: "100%" }} />
        {results.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {results.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => setSelected(c)}>
                <span>{c.name} {c.phone && <span className="hint-text">· {c.phone}</span>}</span>
                {c.credit_enabled && <span className="badge badge-info">Credit enabled</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && <CustomerDetail customer={selected} onUpdated={(c) => setSelected(c)} />}
    </div>
  );
}

function CustomerDetail({ customer, onUpdated }: { customer: CustomerRow; onUpdated: (c: CustomerRow) => void }) {
  const [balance, setBalance] = useState<any>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [creditEnabled, setCreditEnabled] = useState(customer.credit_enabled);
  const [creditLimit, setCreditLimit] = useState<string>(customer.credit_limit?.toString() ?? "");
  const [paymentTermsDays, setPaymentTermsDays] = useState(0);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "upi" | "card" | "cheque" | "bank_transfer">("cash");
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [paymentResult, setPaymentResult] = useState<string | null>(null);

  const [range, setRange] = useState(defaultRange());
  const [statement, setStatement] = useState<any>(null);
  const [openingBillId, setOpeningBillId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [transactionalOptIn, setTransactionalOptIn] = useState(customer.whatsapp_transactional_opt_in);
  const [marketingOptIn, setMarketingOptIn] = useState(customer.whatsapp_marketing_opt_in);
  const [savingConsent, setSavingConsent] = useState(false);
  const [consentSaved, setConsentSaved] = useState(false);

  async function saveConsent() {
    setSavingConsent(true);
    setConsentSaved(false);
    try {
      await api.patch(`/customers/${customer.id}/whatsapp-consent`, { transactionalOptIn, marketingOptIn });
      onUpdated({ ...customer, whatsapp_transactional_opt_in: transactionalOptIn, whatsapp_marketing_opt_in: marketingOptIn });
      setConsentSaved(true);
    } finally {
      setSavingConsent(false);
    }
  }

  async function loadBalance() {
    setLoadingBalance(true);
    try {
      setBalance(await api.get(`/customers/${customer.id}/balance`));
    } finally {
      setLoadingBalance(false);
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    setSettingsError(null);
    try {
      await api.patch(`/customers/${customer.id}/credit-settings`, {
        creditEnabled,
        creditLimit: creditLimit === "" ? null : Number(creditLimit),
        paymentTermsDays,
        accountCustomerId: null,
      });
      onUpdated({ ...customer, credit_enabled: creditEnabled, credit_limit: creditLimit === "" ? null : Number(creditLimit) });
      await loadBalance();
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.body?.error ?? "Could not save." : "Could not save.");
    } finally {
      setSavingSettings(false);
    }
  }

  async function recordPayment() {
    if (!paymentAmount || Number(paymentAmount) <= 0) return;
    setRecordingPayment(true);
    setPaymentResult(null);
    try {
      const res = await api.post(`/customers/${customer.id}/payments`, {
        amount: Number(paymentAmount),
        paymentMethod,
        referenceNumber: null,
        note: null,
        allocateToSaleId: null,
        deviceId: "web-console",
      });
      setPaymentResult(res.unallocatedAmount > 0 ? `Recorded. ₹${res.unallocatedAmount.toFixed(2)} left unallocated (paid more than was outstanding).` : "Recorded and fully allocated.");
      setPaymentAmount("");
      await loadBalance();
    } finally {
      setRecordingPayment(false);
    }
  }

  async function loadStatement(overrideRange?: { from: string; to: string }) {
    const r = overrideRange ?? range;
    setStatement(await api.get(`/customers/${customer.id}/statement?from=${r.from}&to=${r.to}`));
  }

  // No stated "founding date" anywhere in this build to bound an actual
  // all-time query — 2000-01-01 predates any possible sale, which is the
  // simplest honest stand-in without a schema change just for this.
  function loadAllTime() {
    const allTime = { from: "2000-01-01", to: new Date().toISOString().slice(0, 10) };
    setRange(allTime);
    loadStatement(allTime);
  }

  // Same "open the real original document in a new window" pattern F4's
  // item history already uses (components/ItemHistoryModal.tsx) — a
  // customer's purchase history is only actually useful if every bill
  // drills into what was really bought, not just a total.
  async function openBill(saleId: string) {
    setOpeningBillId(saleId);
    setOpenError(null);
    try {
      const detail = await api.get(`/sales/${saleId}`);
      const w = window.open("", "_blank", "width=380,height=600");
      if (!w) return;
      w.document.write(buildReceiptHtml(detail));
      w.document.close();
    } catch {
      setOpenError("Could not open that bill.");
    } finally {
      setOpeningBillId(null);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{customer.name} {customer.phone && <span className="hint-text">· {customer.phone}</span>}</h3>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>Credit settings</strong>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <label><input type="checkbox" checked={creditEnabled} onChange={(e) => setCreditEnabled(e.target.checked)} /> Credit enabled</label>
          </div>
          <div className="field"><label>Credit limit ₹ (blank = no limit)</label><input type="number" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} /></div>
          <div className="field"><label>Payment terms (days)</label><input type="number" value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(Number(e.target.value))} /></div>
          {settingsError && <p className="error-text">{settingsError === "cannot_be_own_account_holder" ? "A customer can't be their own account holder." : settingsError}</p>}
          <button className="btn-primary" disabled={savingSettings} onClick={saveSettings} style={{ marginTop: 6 }}>{savingSettings ? "Saving…" : "Save credit settings"}</button>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>Balance</strong>
          <div style={{ marginTop: 6 }}>
            <button className="btn-secondary" disabled={loadingBalance} onClick={loadBalance}>{loadingBalance ? "Loading…" : "Check balance"}</button>
          </div>
          {balance && (
            <div style={{ marginTop: 8 }}>
              <p style={{ margin: "4px 0" }}>Outstanding: <strong className={balance.overLimit ? "stock-out" : ""}>₹{balance.balance.toFixed(2)}</strong></p>
              <p style={{ margin: "4px 0" }} className="hint-text">Limit: {balance.creditLimit === null ? "none" : `₹${balance.creditLimit.toFixed(2)}`}</p>
              {balance.overLimit && <p className="error-text">Over credit limit.</p>}
              {balance.accountHolderId !== customer.id && <p className="hint-text">Billed under family account: {balance.accountHolderName}</p>}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>WhatsApp consent</strong>
          <p className="hint-text" style={{ margin: "4px 0" }}>No inbound WhatsApp reply handling exists yet — set these from what the customer has told staff directly.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            <label><input type="checkbox" checked={transactionalOptIn} onChange={(e) => setTransactionalOptIn(e.target.checked)} /> Transactional (bill notifications, stock callbacks)</label>
            <label><input type="checkbox" checked={marketingOptIn} onChange={(e) => setMarketingOptIn(e.target.checked)} /> Marketing (promotions — requires explicit consent)</label>
          </div>
          <button className="btn-primary" disabled={savingConsent} onClick={saveConsent} style={{ marginTop: 6 }}>{savingConsent ? "Saving…" : "Save consent"}</button>
          {consentSaved && <p className="hint-text" style={{ marginTop: 4 }}>Saved.</p>}
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>Record a payment</strong>
          <div className="field"><label>Amount ₹</label><input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} /></div>
          <div className="field">
            <label>Method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)}>
              <option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option>
              <option value="cheque">Cheque</option><option value="bank_transfer">Bank transfer</option>
            </select>
          </div>
          <p className="hint-text">Allocated oldest-bill-first automatically.</p>
          <button className="btn-primary" disabled={recordingPayment || !paymentAmount} onClick={recordPayment}>{recordingPayment ? "Recording…" : "Record payment"}</button>
          {paymentResult && <p className="hint-text" style={{ marginTop: 6 }}>{paymentResult}</p>}
        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
      <strong>Purchase history</strong>
      <p className="hint-text" style={{ margin: "4px 0 8px" }}>Click any bill below to open the real original invoice — every medicine on it, batch, quantity, GST, the lot.</p>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-secondary" onClick={() => loadStatement()}>Run</button>
        <button className="btn-primary" onClick={loadAllTime}>All time</button>
      </div>
      {openError && <p className="error-text">{openError}</p>}
      {statement && (
        <div style={{ marginTop: 8 }}>
          <h4>Bills {openingBillId && <span className="hint-text">— opening…</span>}</h4>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Bill #</th><th>Total</th><th>Credit portion</th></tr></thead>
            <tbody>
              {statement.bills.map((b: any) => (
                <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => openBill(b.id)} title="Open the original invoice">
                  <td style={{ textDecoration: "underline" }}>{new Date(b.business_date).toLocaleDateString("en-IN")}</td>
                  <td>{b.bill_number}</td><td>₹{Number(b.grand_total).toFixed(2)}</td><td>₹{Number(b.credit_amount).toFixed(2)}</td>
                </tr>
              ))}
              {statement.bills.length === 0 && <tr><td colSpan={4} className="hint-text">No bills in this range.</td></tr>}
            </tbody>
          </table>
          <h4 style={{ marginTop: 12 }}>Payments</h4>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Amount</th><th>Method</th></tr></thead>
            <tbody>
              {statement.payments.map((p: any) => (
                <tr key={p.id}><td>{new Date(p.created_at).toLocaleDateString("en-IN")}</td><td>₹{Number(p.amount).toFixed(2)}</td><td>{p.payment_method}</td></tr>
              ))}
              {statement.payments.length === 0 && <tr><td colSpan={3} className="hint-text">No payments in this range.</td></tr>}
            </tbody>
          </table>
          <p style={{ fontWeight: 700, marginTop: 8 }}>Current balance: ₹{Number(statement.currentBalance).toFixed(2)}</p>
        </div>
      )}
    </div>
  );
}

function AgeingTab() {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get("/customers/ageing")); }
  return (
    <div>
      <button className="btn-primary" onClick={load} style={{ marginBottom: 12 }}>Run</button>
      {rows && rows.length === 0 && <p className="hint-text">No outstanding credit balances.</p>}
      {rows && rows.length > 0 && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Customer</th><th>Current</th><th>31-60 days</th><th>61-90 days</th><th>90+ days</th><th>Total</th><th>Limit</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.customer_id}>
                  <td>{r.name}</td>
                  <td>₹{Number(r.current_bucket).toFixed(2)}</td>
                  <td>₹{Number(r.bucket_30).toFixed(2)}</td>
                  <td className={Number(r.bucket_60) > 0 ? "stock-out" : undefined}>₹{Number(r.bucket_60).toFixed(2)}</td>
                  <td className={Number(r.bucket_90_plus) > 0 ? "stock-out" : undefined}>₹{Number(r.bucket_90_plus).toFixed(2)}</td>
                  <td style={{ fontWeight: 700 }}>₹{Number(r.total_outstanding).toFixed(2)}</td>
                  <td>{r.credit_limit === null ? "—" : `₹${Number(r.credit_limit).toFixed(2)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const CUSTOMER_BULK_IMPORT_COLUMNS = "name,phone,credit_enabled,credit_limit,payment_terms_days,whatsapp_transactional_opt_in,whatsapp_marketing_opt_in";

// Owner-requested — bulk-load a customer list (e.g. from an old system)
// with the same preview-diff safety net as the product master's bulk
// import: nothing is written until Commit, and every row's create/update
// action is shown first. Matched by phone; a row with no phone always
// creates a new customer, same as a walk-in with no number given at POS.
function BulkImportTab() {
  const [csv, setCsv] = useState(CUSTOMER_BULK_IMPORT_COLUMNS + "\n");
  const [diff, setDiff] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setDiff(await api.post("/customers/bulk-import/preview", { csv }));
    } catch {
      setError("Could not parse this CSV.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/customers/bulk-import/commit", { csv });
      setResult(`${res.created} created, ${res.updated} updated, ${res.skipped} skipped.`);
      setDiff(null);
    } catch {
      setError("Could not commit this import.");
    } finally {
      setBusy(false);
    }
  }

  const okCount = diff?.filter((d) => d.ok).length ?? 0;

  return (
    <div>
      <p className="hint-text">
        Bulk-load a customer list with a mandatory preview-and-confirm diff — nothing is written until you review the
        rows and click Commit. Rows are matched by phone number: no match (or a blank phone — same as a walk-in with
        no number given at billing) creates a new customer; a match updates name, credit settings, and WhatsApp
        consent. <code>credit_enabled</code>, <code>whatsapp_transactional_opt_in</code>, and{" "}
        <code>whatsapp_marketing_opt_in</code> are <code>true</code>/<code>false</code>; leave a cell blank to keep
        the existing value (or the default — transactional opt-in defaults on, everything else off) rather than
        overwrite it. Plain CSV only — no quoted fields, no embedded commas.
      </p>
      <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setDiff(null); }} rows={8} style={{ width: "100%", fontFamily: "monospace" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn-secondary" disabled={busy} onClick={preview}>Preview</button>
        <button className="btn-primary" disabled={busy || !diff || okCount === 0} onClick={commit}>Commit {diff ? `(${okCount} row${okCount === 1 ? "" : "s"})` : ""}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {result && <p>{result}</p>}
      {diff && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Row</th><th>Customer</th><th>Action</th><th>Changes</th><th>Status</th></tr></thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.rowNumber} style={{ background: d.ok ? undefined : "color-mix(in srgb, var(--status-warn) 10%, white)" }}>
                <td>{d.rowNumber}</td>
                <td>{d.name} {d.phone && <span className="hint-text">· {d.phone}</span>}</td>
                <td>{d.action ?? "—"}</td>
                <td>{d.changes?.map((c: any) => `${c.field}: ${c.from ?? "—"} → ${c.to}`).join("; ") || "no changes"}</td>
                <td>{d.ok ? "Will apply" : d.error === "duplicate_phone_in_file" ? "Duplicate phone earlier in this file" : d.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
