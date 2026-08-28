import { useEffect, useState } from "react";
import { api, ApiError, downloadFile, postForm } from "../api.js";

interface Vendor {
  id: string;
  name: string;
  gstin: string | null;
  phone: string | null;
  email: string | null;
}

const EXPENSE_CATEGORIES = ["rent", "salaries", "electricity", "transport", "packaging", "delivery_fuel", "software", "other"] as const;
const PAYMENT_METHODS = ["cash", "upi", "card", "cheque", "bank_transfer"] as const;

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Section 10B.1 — vendor ledger, expenses, day-book, cash/bank book, and
 * the Tally-compatible export, plus Section 10B.3's e-way bill stub.
 * Owner/store_manager, same bar as the customer ledger and every other
 * bookkeeping (not pure-margin) screen in this build.
 */
export default function AccountingPage() {
  const [tab, setTab] = useState<"vendors" | "expenses" | "day-book" | "cash-bank" | "tally" | "eway">("vendors");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Accounting</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {([
          ["vendors", "Vendor ledger"], ["expenses", "Expenses"], ["day-book", "Day-book"],
          ["cash-bank", "Cash / bank book"], ["tally", "Tally export"], ["eway", "E-way bills"],
        ] as Array<[typeof tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "vendors" && <VendorLedgerTab />}
      {tab === "expenses" && <ExpensesTab />}
      {tab === "day-book" && <DayBookTab />}
      {tab === "cash-bank" && <CashBankTab />}
      {tab === "tally" && <TallyExportTab />}
      {tab === "eway" && <EwayBillTab />}
    </div>
  );
}

function VendorLedgerTab() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Vendor | null>(null);

  useEffect(() => { api.get("/vendors").then(setVendors); }, []);

  const results = q.trim() ? vendors.filter((v) => v.name.toLowerCase().includes(q.trim().toLowerCase())) : [];

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <input placeholder="Search vendor by name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
        {results.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {results.map((v) => (
              <div key={v.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => setSelected(v)}>
                <span>{v.name} {v.gstin && <span className="hint-text">· {v.gstin}</span>}</span>
                {!v.phone && !v.email && <span className="badge badge-warn">No contact on file</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <VendorDetail
          vendor={selected}
          onUpdated={(v) => { setSelected(v); setVendors((vs) => vs.map((x) => (x.id === v.id ? v : x))); }}
        />
      )}
    </div>
  );
}

function VendorDetail({ vendor, onUpdated }: { vendor: Vendor; onUpdated: (v: Vendor) => void }) {
  const [balance, setBalance] = useState<any>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  const [phone, setPhone] = useState(vendor.phone ?? "");
  const [email, setEmail] = useState(vendor.email ?? "");
  const [savingContact, setSavingContact] = useState(false);

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("cash");
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [paymentResult, setPaymentResult] = useState<string | null>(null);

  const [range, setRange] = useState(defaultRange());
  const [statement, setStatement] = useState<any>(null);

  async function loadBalance() {
    setLoadingBalance(true);
    try {
      setBalance(await api.get(`/vendors/${vendor.id}/balance`));
    } finally {
      setLoadingBalance(false);
    }
  }

  async function saveContact() {
    setSavingContact(true);
    try {
      await api.patch(`/vendors/${vendor.id}/contact`, { phone: phone || null, email: email || null });
      onUpdated({ ...vendor, phone: phone || null, email: email || null });
    } finally {
      setSavingContact(false);
    }
  }

  async function recordPayment() {
    if (!paymentAmount || Number(paymentAmount) <= 0) return;
    setRecordingPayment(true);
    setPaymentResult(null);
    try {
      const res = await api.post(`/vendors/${vendor.id}/payments`, {
        amount: Number(paymentAmount), paymentMethod, referenceNumber: null, note: null,
        allocateToInvoiceId: null, deviceId: "web-console",
      });
      setPaymentResult(res.unallocatedAmount > 0 ? `Recorded. ₹${res.unallocatedAmount.toFixed(2)} left unallocated (paid more than was outstanding).` : "Recorded and fully allocated.");
      setPaymentAmount("");
      await loadBalance();
    } finally {
      setRecordingPayment(false);
    }
  }

  async function loadStatement() {
    setStatement(await api.get(`/vendors/${vendor.id}/statement?from=${range.from}&to=${range.to}`));
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{vendor.name} {vendor.gstin && <span className="hint-text">· {vendor.gstin}</span>}</h3>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>Contact (needed to send a PO)</strong>
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="For WhatsApp send" /></div>
          <div className="field"><label>Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="For email send" /></div>
          <button className="btn-primary" disabled={savingContact} onClick={saveContact} style={{ marginTop: 6 }}>{savingContact ? "Saving…" : "Save contact"}</button>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>Balance</strong>
          <div style={{ marginTop: 6 }}>
            <button className="btn-secondary" disabled={loadingBalance} onClick={loadBalance}>{loadingBalance ? "Loading…" : "Check balance"}</button>
          </div>
          {balance && <p style={{ marginTop: 8 }}>Outstanding: <strong className={balance.balance > 0 ? "stock-out" : undefined}>₹{balance.balance.toFixed(2)}</strong></p>}
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>Record a payment</strong>
          <div className="field"><label>Amount ₹</label><input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} /></div>
          <div className="field">
            <label>Method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <p className="hint-text">Allocated oldest-invoice-first automatically.</p>
          <button className="btn-primary" disabled={recordingPayment || !paymentAmount} onClick={recordPayment}>{recordingPayment ? "Recording…" : "Record payment"}</button>
          {paymentResult && <p className="hint-text" style={{ marginTop: 6 }}>{paymentResult}</p>}
        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
      <strong>Statement</strong>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-secondary" onClick={loadStatement}>Run</button>
        <button className="btn-secondary" onClick={() => downloadFile(`/vendors/${vendor.id}/statement?from=${range.from}&to=${range.to}&format=csv`, `${vendor.name}-statement.csv`)}>Export CSV</button>
      </div>
      {statement && (
        <div style={{ marginTop: 8 }}>
          <h4>Invoices</h4>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Invoice #</th><th>Net payable</th></tr></thead>
            <tbody>
              {statement.invoices.map((i: any) => (
                <tr key={i.id}><td>{new Date(i.invoice_date).toLocaleDateString("en-IN")}</td><td>{i.invoice_number}</td><td>₹{Number(i.net_payable_computed).toFixed(2)}</td></tr>
              ))}
              {statement.invoices.length === 0 && <tr><td colSpan={3} className="hint-text">No invoices in this range.</td></tr>}
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

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
      <button className="btn-secondary" onClick={() => downloadFile("/vendors/ageing?format=csv", "vendor-ageing.csv")}>Export full vendor ageing (CSV)</button>
      <AgeingSummary />
    </div>
  );
}

function AgeingSummary() {
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get("/vendors/ageing")); }
  return (
    <div style={{ marginTop: 12 }}>
      <button className="btn-secondary" onClick={load}>Show vendor ageing</button>
      {rows && rows.length === 0 && <p className="hint-text" style={{ marginTop: 8 }}>No outstanding vendor balances.</p>}
      {rows && rows.length > 0 && (
        <table className="data-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Vendor</th><th>Current</th><th>31-60 days</th><th>61-90 days</th><th>90+ days</th><th>Total</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.vendor_id}>
                <td>{r.name}</td>
                <td>₹{Number(r.current_bucket).toFixed(2)}</td>
                <td>₹{Number(r.bucket_30).toFixed(2)}</td>
                <td className={Number(r.bucket_60) > 0 ? "stock-out" : undefined}>₹{Number(r.bucket_60).toFixed(2)}</td>
                <td className={Number(r.bucket_90_plus) > 0 ? "stock-out" : undefined}>₹{Number(r.bucket_90_plus).toFixed(2)}</td>
                <td style={{ fontWeight: 700 }}>₹{Number(r.total_outstanding).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ExpensesTab() {
  const [range, setRange] = useState(defaultRange());
  const [rows, setRows] = useState<any[] | null>(null);
  const [category, setCategory] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [expCategory, setExpCategory] = useState<(typeof EXPENSE_CATEGORIES)[number]>("other");
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("cash");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const q = `from=${range.from}&to=${range.to}${category ? `&category=${category}` : ""}`;
    setRows(await api.get(`/expenses?${q}`));
  }

  async function submit() {
    if (!amount || Number(amount) <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("category", expCategory);
      form.set("amount", amount);
      form.set("expenseDate", expenseDate);
      form.set("note", note);
      form.set("paymentMethod", paymentMethod);
      form.set("deviceId", "web-console");
      if (photo) form.set("photo", photo);
      await postForm("/expenses", form);
      setAmount("");
      setNote("");
      setPhoto(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? "Could not log the expense." : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <strong>Log an expense</strong>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <div className="field">
            <label>Category</label>
            <select value={expCategory} onChange={(e) => setExpCategory(e.target.value as any)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
            </select>
          </div>
          <div className="field"><label>Amount ₹</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Date</label><input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} /></div>
          <div className="field">
            <label>Payment method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field"><label>Note</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="field"><label>Bill photo (optional)</label><input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" disabled={busy || !amount} onClick={submit} style={{ marginTop: 8 }}>{busy ? "Saving…" : "Log expense"}</button>
      </div>

      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
          </select>
        </div>
        <button className="btn-secondary" onClick={load}>Run</button>
        <button className="btn-secondary" onClick={() => downloadFile(`/expenses?from=${range.from}&to=${range.to}${category ? `&category=${category}` : ""}&format=csv`, "expenses.csv")}>Export CSV</button>
      </div>

      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Date</th><th>Category</th><th>Amount</th><th>Method</th><th>Paid by</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td>{new Date(r.expense_date).toLocaleDateString("en-IN")}</td>
                  <td style={{ textTransform: "capitalize" }}>{r.category.replace("_", " ")}</td>
                  <td>₹{Number(r.amount).toFixed(2)}</td>
                  <td>{r.payment_method}</td>
                  <td>{r.paid_by_name}</td>
                  <td className="hint-text">{r.note ?? "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="hint-text">No expenses in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DayBookTab() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<any[] | null>(null);
  async function load() { setRows(await api.get(`/accounting/day-book?date=${date}`)); }
  return (
    <div>
      <p className="hint-text">Every financial transaction of the day, one screen — sales, purchase invoices (a payable from entry, even before payment), customer/vendor payments, expenses, and refunds.</p>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <button className="btn-primary" onClick={load}>Run</button>
        <button className="btn-secondary" onClick={() => downloadFile(`/accounting/day-book?date=${date}&format=csv`, `day-book-${date}.csv`)}>Export CSV</button>
      </div>
      {rows && (
        <div className="card">
          <table className="data-table">
            <thead><tr><th>Time</th><th>Kind</th><th>Description</th><th>Amount</th><th>Direction</th><th>Method</th></tr></thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{new Date(r.occurred_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
                  <td style={{ textTransform: "capitalize" }}>{r.kind.replace("_", " ")}</td>
                  <td>{r.description}</td>
                  <td>₹{Number(r.amount).toFixed(2)}</td>
                  <td className={r.direction === "out" ? "stock-out" : undefined}>{r.direction}</td>
                  <td>{r.payment_method ?? "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="hint-text">No transactions on this date.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CashBankTab() {
  const [account, setAccount] = useState<"cash" | "bank">("cash");
  const [range, setRange] = useState(defaultRange());
  const [result, setResult] = useState<any>(null);
  async function load() { setResult(await api.get(`/accounting/${account}-book?from=${range.from}&to=${range.to}`)); }
  return (
    <div>
      <p className="hint-text">"Bank" covers every non-cash instrument (UPI, card, cheque, bank transfer) — one account, not four. Opening balance is the cumulative net movement of everything before the range start; there's no stated starting figure anywhere in this build.</p>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field">
          <label>Book</label>
          <select value={account} onChange={(e) => setAccount(e.target.value as any)}>
            <option value="cash">Cash</option><option value="bank">Bank</option>
          </select>
        </div>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-primary" onClick={load}>Run</button>
        <button className="btn-secondary" onClick={() => downloadFile(`/accounting/${account}-book?from=${range.from}&to=${range.to}&format=csv`, `${account}-book.csv`)}>Export CSV</button>
      </div>
      {result && (
        <div className="card">
          <p style={{ margin: "0 0 8px" }}>Opening: ₹{result.openingBalance.toFixed(2)} · Closing: <strong>₹{result.closingBalance.toFixed(2)}</strong></p>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Opening</th><th>Receipts</th><th>Payments</th><th>Closing</th></tr></thead>
            <tbody>
              {result.days.map((d: any) => (
                <tr key={d.date}>
                  <td>{new Date(d.date).toLocaleDateString("en-IN")}</td>
                  <td>₹{d.opening.toFixed(2)}</td><td>₹{d.receipts.toFixed(2)}</td><td>₹{d.payments.toFixed(2)}</td>
                  <td style={{ fontWeight: 700 }}>₹{d.closing.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TallyExportTab() {
  const [range, setRange] = useState(defaultRange());
  return (
    <div>
      <p className="hint-text">
        Section 10B.1's Tally-compatible export. Shipped as CSV — a hand-rolled Tally XML voucher schema can't be
        validated against a real Tally instance in this build, and a CSV that's honestly a CSV beats an XML file
        that looks right but might silently fail to import. Sales, purchase, receipt, and payment vouchers for the
        range, one row per voucher.
      </p>
      <div className="card" style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div className="field"><label>From</label><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></div>
        <div className="field"><label>To</label><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></div>
        <button className="btn-primary" onClick={() => downloadFile(`/accounting/tally-export?from=${range.from}&to=${range.to}`, `tally-export-${range.from}-to-${range.to}.csv`)}>Download CSV</button>
      </div>
    </div>
  );
}

function EwayBillTab() {
  const [referenceType, setReferenceType] = useState<"sale" | "purchase_invoice">("sale");
  const [referenceId, setReferenceId] = useState("");
  const [check, setCheck] = useState<any>(null);
  const [list, setList] = useState<any[] | null>(null);
  const [transporterName, setTransporterName] = useState("");
  const [transporterGstin, setTransporterGstin] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [distanceKm, setDistanceKm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup() {
    if (!referenceId) return;
    setError(null);
    try {
      const [c, l] = await Promise.all([
        api.get(`/eway-bills/check?referenceType=${referenceType}&referenceId=${referenceId}`),
        api.get(`/eway-bills?referenceType=${referenceType}&referenceId=${referenceId}`),
      ]);
      setCheck(c);
      setList(l);
    } catch (err) {
      setError(err instanceof ApiError && err.body?.error === "not_found" ? "No sale or purchase invoice with that ID." : "Not found.");
      setCheck(null);
      setList(null);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/eway-bills", {
        referenceType, referenceId,
        transporterName: transporterName || null, transporterGstin: transporterGstin || null,
        vehicleNumber: vehicleNumber || null, distanceKm: distanceKm ? Number(distanceKm) : null,
      });
      await lookup();
    } catch {
      setError("Could not generate the e-way bill upload data.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="hint-text">
        Section 10B.3 — stub only: generates the data shaped for the NIC portal's manual upload, stored for
        reference. Nothing here submits to a live GSP; the e-way bill number is recorded back manually once you
        have it from the actual portal.
      </p>
      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field">
          <label>Reference type</label>
          <select value={referenceType} onChange={(e) => setReferenceType(e.target.value as any)}>
            <option value="sale">Sale</option><option value="purchase_invoice">Purchase invoice</option>
          </select>
        </div>
        <div className="field"><label>Reference ID</label><input value={referenceId} onChange={(e) => setReferenceId(e.target.value)} placeholder="sale or purchase invoice UUID" style={{ width: 300 }} /></div>
        <button className="btn-primary" onClick={lookup}>Check</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {check && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p style={{ margin: 0 }}>
            {check.required
              ? <span className="badge badge-warn">Required — value ₹{check.value.toFixed(2)} ≥ threshold ₹{check.threshold.toFixed(2)}</span>
              : <span className="badge badge-info">Not required — value ₹{check.value.toFixed(2)} below threshold ₹{check.threshold.toFixed(2)}</span>}
          </p>
        </div>
      )}
      {check?.required && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Generate upload data</strong>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <div className="field"><label>Transporter name</label><input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} /></div>
            <div className="field"><label>Transporter GSTIN</label><input value={transporterGstin} onChange={(e) => setTransporterGstin(e.target.value)} /></div>
            <div className="field"><label>Vehicle number</label><input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} /></div>
            <div className="field"><label>Distance (km)</label><input type="number" value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} /></div>
          </div>
          <button className="btn-primary" disabled={busy} onClick={generate} style={{ marginTop: 8 }}>{busy ? "Generating…" : "Generate"}</button>
        </div>
      )}
      {list && list.length > 0 && (
        <div className="card">
          <strong>Generated e-way bills for this reference</strong>
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Created</th><th>Vehicle</th><th>E-way bill #</th><th>Valid until</th></tr></thead>
            <tbody>
              {list.map((e: any) => (
                <tr key={e.id}>
                  <td>{new Date(e.created_at).toLocaleDateString("en-IN")}</td>
                  <td>{e.vehicle_number ?? "—"}</td>
                  <td>{e.eway_bill_number ?? <RecordNumberInline id={e.id} onRecorded={lookup} />}</td>
                  <td>{e.valid_until ? new Date(e.valid_until).toLocaleString("en-IN") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecordNumberInline({ id, onRecorded }: { id: string; onRecorded: () => void }) {
  const [number, setNumber] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!number || !validUntil) return;
    setBusy(true);
    try {
      await api.patch(`/eway-bills/${id}`, { ewayBillNumber: number, validUntil: new Date(validUntil).toISOString() });
      onRecorded();
    } finally {
      setBusy(false);
    }
  }
  return (
    <span style={{ display: "flex", gap: 4 }}>
      <input placeholder="E-way bill #" value={number} onChange={(e) => setNumber(e.target.value)} style={{ width: 120 }} />
      <input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      <button className="btn-secondary" disabled={busy} onClick={save}>Save</button>
    </span>
  );
}
