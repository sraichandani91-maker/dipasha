import { useState } from "react";
import { api, ApiError } from "../api.js";

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
  const [tab, setTab] = useState<"search" | "ageing">("search");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Credit customers</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button className={tab === "search" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("search")}>Customer ledger</button>
        <button className={tab === "ageing" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("ageing")}>Ageing report</button>
      </div>
      {tab === "search" && <SearchTab />}
      {tab === "ageing" && <AgeingTab />}
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

  async function loadStatement() {
    setStatement(await api.get(`/customers/${customer.id}/statement?from=${range.from}&to=${range.to}`));
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
      <strong>Statement</strong>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 8 }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-secondary" onClick={loadStatement}>Run</button>
      </div>
      {statement && (
        <div style={{ marginTop: 8 }}>
          <h4>Bills</h4>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Bill #</th><th>Total</th><th>Credit portion</th></tr></thead>
            <tbody>
              {statement.bills.map((b: any) => (
                <tr key={b.id}><td>{new Date(b.business_date).toLocaleDateString("en-IN")}</td><td>{b.bill_number}</td><td>₹{Number(b.grand_total).toFixed(2)}</td><td>₹{Number(b.credit_amount).toFixed(2)}</td></tr>
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
