import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Vendor {
  id: string;
  name: string;
  paymentTermsDays: number;
  defaultMinOrderPackUnits: number | null;
}
interface RateRiseFlag {
  vendor_name: string;
  product_name: string;
  latest_rate: number;
  prior_avg_rate: number;
  latest_invoice_date: string;
  rise_percent: number;
}
interface ScorecardRow {
  vendor_id: string;
  vendor_name: string;
  pos_fulfilled: number;
  avg_lead_time_days: number | null;
  invoice_count: number;
  total_spend: number;
  fill_rate_percent: number | null;
}

/**
 * Section 9A.6 — multi-vendor rate comparison and the vendor scorecard.
 * Lives on its own tab rather than folded into Purchase Orders since it's
 * vendor-management, not PO-building — the PO screen already shows the
 * best last rate per line, which is where "on PO creation, show the best
 * rate" actually needed to live (Section 9A.6's other half).
 */
export default function VendorComparisonPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [rateRises, setRateRises] = useState<RateRiseFlag[]>([]);
  const [scorecard, setScorecard] = useState<ScorecardRow[]>([]);
  const [moqEdits, setMoqEdits] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    const [v, r, s] = await Promise.all([
      api.get("/vendors"),
      api.get("/vendor-comparison/rate-rises"),
      api.get("/vendor-comparison/scorecard"),
    ]);
    setVendors(v);
    setRateRises(r);
    setScorecard(s);
  }
  useEffect(() => { load(); }, []);

  async function saveMoq(vendorId: string) {
    const raw = moqEdits[vendorId];
    const value = raw === undefined || raw === "" ? null : Number(raw);
    setSavingId(vendorId);
    try {
      await api.patch(`/vendors/${vendorId}/moq`, { defaultMinOrderPackUnits: value });
      setVendors((vs) => vs.map((v) => (v.id === vendorId ? { ...v, defaultMinOrderPackUnits: value } : v)));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Vendor comparison</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Minimum order pack, per vendor</h3>
        <p className="hint-text">
          Used to round up suggested order quantities on the Purchase orders screen (distributors sell by the box, not
          the strip). One default per vendor — see DECISIONS.md.
        </p>
        <table className="data-table">
          <thead><tr><th>Vendor</th><th>Payment terms</th><th>Min order pack (base units)</th><th></th></tr></thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.id}>
                <td>{v.name}</td>
                <td>{v.paymentTermsDays} days</td>
                <td>
                  <input
                    type="number"
                    style={{ width: 100 }}
                    placeholder="none"
                    value={moqEdits[v.id] ?? v.defaultMinOrderPackUnits ?? ""}
                    onChange={(e) => setMoqEdits((m) => ({ ...m, [v.id]: e.target.value }))}
                  />
                </td>
                <td><button className="btn-secondary" disabled={savingId === v.id} onClick={() => saveMoq(v.id)}>{savingId === v.id ? "Saving…" : "Save"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Rate rise flags</h3>
        <p className="hint-text">A vendor's latest rate on a SKU, more than 5% above their own average on prior purchases of it.</p>
        {rateRises.length === 0 && <p className="hint-text">No flags — either rates are steady, or there's not yet more than one purchase on record for any vendor+SKU pair.</p>}
        {rateRises.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Vendor</th><th>Item</th><th>Prior avg rate</th><th>Latest rate</th><th>Rise</th><th>As of</th></tr></thead>
            <tbody>
              {rateRises.map((r, i) => (
                <tr key={i}>
                  <td>{r.vendor_name}</td><td>{r.product_name}</td>
                  <td>₹{r.prior_avg_rate.toFixed(2)}</td><td>₹{r.latest_rate.toFixed(2)}</td>
                  <td className="stock-out">+{r.rise_percent}%</td>
                  <td>{new Date(r.latest_invoice_date).toLocaleDateString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Vendor scorecard</h3>
        <p className="hint-text">
          Lead time and fill rate only cover purchase orders raised in this system and later matched to an invoice —
          a vendor never ordered from via a PO here won't appear. Invoice accuracy isn't shown yet; it needs the
          AI-scan correction data that doesn't exist until M9.
        </p>
        {scorecard.length === 0 && <p className="hint-text">No PO-linked invoices yet.</p>}
        {scorecard.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Vendor</th><th>POs fulfilled</th><th>Avg lead time</th><th>Fill rate</th><th>Invoices</th><th>Total spend</th></tr></thead>
            <tbody>
              {scorecard.map((r) => (
                <tr key={r.vendor_id}>
                  <td>{r.vendor_name}</td>
                  <td>{r.pos_fulfilled}</td>
                  <td>{r.avg_lead_time_days === null ? "—" : `${r.avg_lead_time_days} day${r.avg_lead_time_days === 1 ? "" : "s"}`}</td>
                  <td>{r.fill_rate_percent === null ? "—" : `${r.fill_rate_percent}%`}</td>
                  <td>{r.invoice_count}</td>
                  <td>₹{r.total_spend.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
