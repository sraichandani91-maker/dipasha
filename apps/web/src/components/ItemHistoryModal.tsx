import { useEffect, useState } from "react";
import { api } from "../api.js";
import { buildReceiptHtml, buildPurchaseInvoiceHtml } from "../lib/receipt.js";

interface SaleHistoryRow {
  id: string;
  bill_number: string;
  business_date: string;
  channel: string;
  status: string;
  customer_name: string | null;
  quantity_base_units: number;
  line_total: string;
}

interface PurchaseHistoryRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  vendor_name: string;
  quantity_base_units: number;
  line_total: string;
}

/**
 * Section 5B's F4 item ledger (owner-requested) — press F4 on a medicine
 * while searching, or click the "History" link on a search result, to see
 * every sale and every GST purchase it's ever appeared on, one row per
 * date/transaction. Clicking a row opens that transaction's own original
 * document (the printed bill or the purchase invoice) in a new window —
 * same "open a new window, write the real document HTML" pattern POS
 * already uses for a just-completed sale's receipt.
 */
export default function ItemHistoryModal({
  productId,
  productName,
  onClose,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ sales: SaleHistoryRow[]; purchases: PurchaseHistoryRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    api.get(`/products/${productId}/history`).then(setData).catch(() => setError("Could not load history for this item."));
  }, [productId]);

  async function openSale(id: string) {
    setOpeningId(id);
    try {
      const detail = await api.get(`/sales/${id}`);
      const w = window.open("", "_blank", "width=380,height=600");
      if (!w) return;
      w.document.write(buildReceiptHtml(detail));
      w.document.close();
    } catch {
      setError("Could not open that bill.");
    } finally {
      setOpeningId(null);
    }
  }

  async function openPurchase(id: string) {
    setOpeningId(id);
    try {
      const detail = await api.get(`/purchase-invoices/${id}`);
      const w = window.open("", "_blank", "width=760,height=800");
      if (!w) return;
      w.document.write(buildPurchaseInvoiceHtml(detail));
      w.document.close();
    } catch {
      setError("Could not open that purchase invoice.");
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }} onClick={onClose}>
      <div className="card" style={{ width: 640, maxHeight: "85vh", overflowY: "auto", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 style={{ marginTop: 0 }}>History — {productName}</h3>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error-text">{error}</p>}
        {!data && !error && <p className="hint-text">Loading…</p>}
        {data && (
          <>
            <h4 style={{ marginBottom: 4 }}>Sales</h4>
            {data.sales.length === 0 && <p className="hint-text" style={{ marginTop: 0 }}>No sales recorded for this item yet.</p>}
            {data.sales.length > 0 && (
              <table className="data-table" style={{ marginBottom: 16 }}>
                <thead><tr><th>Date</th><th>Bill</th><th>Qty</th><th>Amount</th><th>Customer</th></tr></thead>
                <tbody>
                  {data.sales.map((s) => (
                    <tr key={s.id} style={{ cursor: "pointer", opacity: s.status === "cancelled" ? 0.55 : 1 }} onClick={() => openSale(s.id)}>
                      <td>{new Date(s.business_date).toLocaleDateString("en-IN")}</td>
                      <td>{s.bill_number}{s.status === "cancelled" && <span className="hint-text"> (cancelled)</span>}</td>
                      <td>{s.quantity_base_units}</td>
                      <td>₹{Number(s.line_total).toFixed(2)}</td>
                      <td>{s.customer_name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4 style={{ marginBottom: 4 }}>Purchases</h4>
            {data.purchases.length === 0 && <p className="hint-text" style={{ marginTop: 0 }}>No purchases recorded for this item yet.</p>}
            {data.purchases.length > 0 && (
              <table className="data-table">
                <thead><tr><th>Date</th><th>Invoice</th><th>Vendor</th><th>Qty</th><th>Amount</th></tr></thead>
                <tbody>
                  {data.purchases.map((p) => (
                    <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => openPurchase(p.id)}>
                      <td>{new Date(p.invoice_date).toLocaleDateString("en-IN")}</td>
                      <td>{p.invoice_number}</td>
                      <td>{p.vendor_name}</td>
                      <td>{p.quantity_base_units}</td>
                      <td>₹{Number(p.line_total).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="hint-text" style={{ marginTop: 12 }}>{openingId ? "Opening…" : "Click any row to open the original bill or purchase invoice."}</p>
          </>
        )}
      </div>
    </div>
  );
}
