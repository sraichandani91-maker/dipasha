import { pool } from "../db.js";
import { marginBySku, marginByCategory, belowCostSales } from "./margin-reports.js";
import { getAgeingReport } from "./customers.js";
import { getVendorAgeingReport } from "./vendors.js";
import { getSetting } from "./settings.js";
import { getTodayBusinessDate } from "./reports.js";
import { enqueueAndSendNow } from "../domain/notifications.js";
import type { MinimalLogger } from "../lib/whatsapp-sender.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Section 10B.1's management P&L and Section 10B.4's owner daily summary
 * share this one computation for a date range — the same "compute once,
 * correctly" rule Section 6A.9 already states for effective cost itself.
 * 10B.4 is a richer presentation of the exact same numbers (plus
 * drill-through and a previous-period comparison, both built in the
 * route/web layer on top of this), not a second aggregation path that
 * could quietly drift from this one.
 */
export async function computeFinancialSummary(fromDate: string, toDate: string) {
  const db = requirePool();

  const [salesTotals, channelSplit, paymentSplit, returnsTotals, costTotals, expenseTotals, purchaseTotals, vendorPurchases, freeGoods] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(grand_total), 0)::numeric(14,2) AS total, COUNT(*)::int AS bill_count,
              COALESCE(SUM(taxable_value + tax_total), 0)::numeric(14,2) AS taxable_plus_tax
       FROM sales WHERE status = 'completed' AND business_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT channel, COALESCE(SUM(grand_total), 0)::numeric(14,2) AS value, COUNT(*)::int AS count
       FROM sales WHERE status = 'completed' AND business_date BETWEEN $1 AND $2 GROUP BY channel`,
      [fromDate, toDate]
    ),
    // A cash tender's amount is what the customer physically handed
    // over, not net revenue — sales.change_due (always cash, per
    // repo/sales.ts's createSale) comes back off here, the same netting
    // repo/accounting.ts's cash book applies, so this reconciliation
    // guard compares like against like rather than flagging every
    // ordinary cash-with-change sale as a mismatch.
    db.query(
      `SELECT st.tender_type,
              COALESCE(SUM(st.amount - CASE WHEN st.tender_type = 'cash' THEN COALESCE(s.change_due, 0) ELSE 0 END), 0)::numeric(14,2) AS value
       FROM sale_tenders st JOIN sales s ON s.id = st.sale_id
       WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
       GROUP BY st.tender_type`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT COUNT(*)::int AS cancelled_count, COALESCE(SUM(grand_total), 0)::numeric(14,2) AS cancelled_value,
              (SELECT COUNT(*) FROM credit_notes cn JOIN sales s2 ON s2.id = cn.original_sale_id WHERE s2.business_date BETWEEN $1 AND $2)::int AS return_count,
              (SELECT COALESCE(SUM(cn.total_refund_value), 0) FROM credit_notes cn JOIN sales s2 ON s2.id = cn.original_sale_id WHERE s2.business_date BETWEEN $1 AND $2)::numeric(14,2) AS return_value
       FROM sales WHERE status = 'cancelled' AND business_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT
         SUM(sl.taxable_value)::numeric(14,2) AS revenue,
         SUM(sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NOT NULL)::numeric(14,2) AS cost,
         COUNT(*) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NULL)::int AS cost_unknown_line_count,
         COALESCE(SUM(sl.quantity_base_units), 0)::int AS total_items
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT category, COALESCE(SUM(amount), 0)::numeric(14,2) AS total
       FROM expense_entries WHERE expense_date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT COALESCE(SUM(net_payable_computed), 0)::numeric(14,2) AS gst_total, COUNT(*)::int AS invoice_count
       FROM purchase_invoices WHERE invoice_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT v.name AS vendor_name, COALESCE(SUM(pi.net_payable_computed), 0)::numeric(14,2) AS value
       FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
       WHERE pi.invoice_date BETWEEN $1 AND $2 GROUP BY v.name ORDER BY value DESC`,
      [fromDate, toDate]
    ),
    db.query(
      `SELECT COALESCE(SUM(pil.free_quantity_base_units * (pil.rate_before_discount * (1 - pil.discount_percent / 100.0))), 0)::numeric(14,2) AS value
       FROM purchase_invoice_lines pil JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
       WHERE pi.invoice_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
  ]);

  const sales = salesTotals.rows[0];
  const revenue = Number(costTotals.rows[0].revenue ?? 0);
  const cost = costTotals.rows[0].cost === null ? null : Number(costTotals.rows[0].cost);
  const costUnknownLineCount = Number(costTotals.rows[0].cost_unknown_line_count);
  const grossProfit = cost === null ? null : round2(revenue - cost);
  const grossMarginPercent = cost === null || revenue === 0 ? null : Math.round(((revenue - cost) / revenue) * 1000) / 10;

  const expensesTotal = expenseTotals.rows.reduce((a: number, r: any) => a + Number(r.total), 0);
  const netProfit = grossProfit === null ? null : round2(grossProfit - expensesTotal);

  const paymentByType: { cash: number; upi: number; card: number; credit: number } = { cash: 0, upi: 0, card: 0, credit: 0 };
  for (const r of paymentSplit.rows) (paymentByType as Record<string, number>)[r.tender_type] = Number(r.value);
  const reconciliationSum = round2(paymentByType.cash + paymentByType.upi + paymentByType.card + paymentByType.credit);
  const reconciliationDifference = round2(Number(sales.total) - reconciliationSum);

  const [byProductRaw, byCategory, bottomPerformers, receivables, payables, dailyTrend] = await Promise.all([
    marginBySku(fromDate, toDate),
    marginByCategory(fromDate, toDate),
    belowCostSales(fromDate, toDate),
    getAgeingReport(),
    getVendorAgeingReport(),
    db.query(
      `SELECT s.business_date::text AS date,
         SUM(sl.taxable_value)::numeric(14,2) AS revenue,
         SUM(sl.effective_cost_per_base_unit_snapshot * sl.quantity_base_units) FILTER (WHERE sl.effective_cost_per_base_unit_snapshot IS NOT NULL)::numeric(14,2) AS cost
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.status = 'completed' AND s.business_date BETWEEN $1 AND $2
       GROUP BY s.business_date ORDER BY s.business_date`,
      [fromDate, toDate]
    ),
  ]);

  const topProductsByProfit = [...byProductRaw]
    .filter((p) => p.marginValue !== null)
    .sort((a, b) => b.marginValue! - a.marginValue!)
    .slice(0, 10);

  return {
    period: { from: fromDate, to: toDate },
    sales: {
      total: Number(sales.total),
      billCount: Number(sales.bill_count),
      averageBillValue: Number(sales.bill_count) > 0 ? round2(Number(sales.total) / Number(sales.bill_count)) : 0,
      itemsPerBill: Number(sales.bill_count) > 0 ? round2(Number(costTotals.rows[0].total_items) / Number(sales.bill_count)) : 0,
      byChannel: channelSplit.rows.map((r) => ({ channel: r.channel, value: Number(r.value), count: r.count })),
      byPaymentMethod: paymentByType,
      returns: {
        cancelledCount: Number(returnsTotals.rows[0].cancelled_count),
        cancelledValue: Number(returnsTotals.rows[0].cancelled_value),
        returnCount: Number(returnsTotals.rows[0].return_count),
        returnValue: Number(returnsTotals.rows[0].return_value),
      },
    },
    purchases: {
      gstTotal: Number(purchaseTotals.rows[0].gst_total),
      invoiceCount: Number(purchaseTotals.rows[0].invoice_count),
      byVendor: vendorPurchases.rows.map((r) => ({ vendorName: r.vendor_name, value: Number(r.value) })),
      freeGoodsValue: Number(freeGoods.rows[0].value),
    },
    grossProfit: {
      revenue: round2(revenue),
      cost: cost === null ? null : round2(cost),
      value: grossProfit,
      marginPercent: grossMarginPercent,
      costUnknownLineCount,
      costUnknownWarning: costUnknownLineCount > 0
        ? `${costUnknownLineCount} item(s) excluded from margin — cost unknown`
        : null,
    },
    profitDetail: {
      dailyTrend: dailyTrend.rows.map((r: any) => ({
        date: r.date,
        grossProfit: r.cost === null ? null : round2(Number(r.revenue) - Number(r.cost)),
      })),
      topProductsByProfit,
      bottomPerformers: bottomPerformers.slice(0, 20),
      marginByCategory: byCategory,
    },
    expenses: {
      total: round2(expensesTotal),
      byCategory: expenseTotals.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
    },
    netProfit,
    payablesReceivables: {
      totalReceivable: round2(receivables.reduce((a: number, r: any) => a + Number(r.total_outstanding), 0)),
      totalPayable: round2(payables.reduce((a: number, r: any) => a + Number(r.total_outstanding), 0)),
      receivablesByCustomer: receivables,
      payablesByVendor: payables,
    },
    reconciliation: {
      salesRegisterTotal: Number(sales.total),
      cash: paymentByType.cash,
      upi: paymentByType.upi,
      card: paymentByType.card,
      credit: paymentByType.credit,
      sumOfPayments: reconciliationSum,
      difference: reconciliationDifference,
      matches: Math.abs(reconciliationDifference) < 0.01,
    },
  };
}

/**
 * Section 10B.1's "stock valuation at cost and at MRP for any date." Not
 * just the current `stock` view — reconstructed from the movement ledger
 * (every quantity_delta up to end-of-day on the requested date), the same
 * append-only source of truth every other point-in-time figure in this
 * build reads from, so a valuation for a past date is genuinely as of
 * that date rather than approximated.
 */
export async function getStockValuationAsOf(asOfDate: string) {
  const { rows } = await requirePool().query(
    `
    WITH balances AS (
      SELECT ml.batch_id, SUM(ml.quantity_delta)::int AS quantity_base_units
      FROM movement_ledger ml
      WHERE ml.created_at < (($1::date + 1))::timestamptz
      GROUP BY ml.batch_id
      HAVING SUM(ml.quantity_delta) > 0
    )
    SELECT
      COALESCE(SUM(bal.quantity_base_units * b.effective_cost_per_base_unit) FILTER (WHERE b.cost_unknown = false), 0)::numeric(14,2) AS value_at_cost,
      COALESCE(SUM(bal.quantity_base_units * (b.mrp / p.pack_size)), 0)::numeric(14,2) AS value_at_mrp,
      COUNT(*) FILTER (WHERE b.cost_unknown = true)::int AS cost_unknown_batch_count,
      COALESCE(SUM(bal.quantity_base_units) FILTER (WHERE b.cost_unknown = true), 0)::int AS cost_unknown_units
    FROM balances bal
    JOIN batches b ON b.id = bal.batch_id
    JOIN products p ON p.id = b.product_id
    `,
    [asOfDate]
  );
  const r = rows[0];
  return {
    asOfDate,
    valueAtCost: Number(r.value_at_cost),
    valueAtMrp: Number(r.value_at_mrp),
    costUnknownBatchCount: Number(r.cost_unknown_batch_count),
    costUnknownUnits: Number(r.cost_unknown_units),
  };
}

function currentIstTimeHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

/**
 * Section 10B.4: "optional daily WhatsApp digest to the Owner's number
 * at a configurable hour with the four headline figures. Owner opt-in,
 * off by default." Distinct from M13.10's operational daily report —
 * same plain `setInterval` poller pattern, its own settings, and its own
 * idempotency: a settings row (`financial_daily_digest_last_sent_date`)
 * tracks the last business date sent, since there's no dedicated table
 * to key a UNIQUE constraint off the way the operational report has
 * `daily_reports.business_date`. Written directly (not through
 * `updateSetting`) since this is internal bookkeeping state, not a
 * user-facing settings edit — same character as chronic_medications'
 * own `reminder_sent_for_exhaustion_date` column.
 */
export async function sendFinancialDailyDigestIfDue(log: MinimalLogger): Promise<void> {
  const enabled = await getSetting("financial_daily_digest_enabled", false);
  if (!enabled) return;

  const configuredTime = await getSetting("financial_daily_digest_time_local", "21:30");
  if (currentIstTimeHHMM() < configuredTime) return;

  const businessDate = await getTodayBusinessDate();
  const lastSent = await getSetting<string | null>("financial_daily_digest_last_sent_date", null);
  if (lastSent === businessDate) return;

  const summary = await computeFinancialSummary(businessDate, businessDate);
  const db = requirePool();
  const { rows: owners } = await db.query(`SELECT phone FROM users WHERE role = 'owner' AND status = 'active'`);
  for (const owner of owners) {
    await enqueueAndSendNow(
      {
        triggerType: "financial_daily_digest",
        category: "transactional",
        templateKey: "whatsapp_template_financial_daily_digest",
        triggerEnabledSettingKey: "financial_daily_digest_enabled",
        recipientCustomerId: null,
        recipientPhone: owner.phone,
        referenceType: "financial_summary",
        referenceId: null,
        payload: {
          businessDate,
          salesTotal: summary.sales.total,
          purchasesTotal: summary.purchases.gstTotal,
          grossProfit: summary.grossProfit.value,
          grossMarginPercent: summary.grossProfit.marginPercent,
        },
      },
      log
    );
  }

  await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'financial_daily_digest_last_sent_date'`, [JSON.stringify(businessDate)]);
}
