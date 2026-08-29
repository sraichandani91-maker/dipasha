import { pool } from "../db.js";
import { computeFinancialSummary, getStockValuationAsOf } from "./financial-summary.js";
import { getCashOrBankBook } from "./accounting.js";
import { getCustomerHomeStats, getCustomerDuesList } from "./customers.js";
import { getVendorDuesList } from "./vendors.js";
import { getProductVelocity } from "./margin-reports.js";
import { listRefillDue } from "./chronic.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function shiftRangeBack(fromDate: string, toDate: string): { from: string; to: string } {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const spanDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

async function getPurchaseDailyTrend(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `SELECT invoice_date::text AS date, COALESCE(SUM(net_payable_computed), 0)::numeric(14,2) AS value
     FROM purchase_invoices WHERE invoice_date BETWEEN $1 AND $2 GROUP BY invoice_date ORDER BY invoice_date`,
    [fromDate, toDate]
  );
  return rows.map((r: any) => ({ date: r.date, value: Number(r.value) }));
}

// Same measure as summary.sales.total (SUM of sales.grand_total) — kept
// separate from computeFinancialSummary's own dailyTrend, which tracks
// gross profit by day, not revenue by day, and drops revenue entirely
// once grossProfit is computed.
async function getSalesDailyTrend(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `SELECT business_date::text AS date, COALESCE(SUM(grand_total), 0)::numeric(14,2) AS value
     FROM sales WHERE status = 'completed' AND business_date BETWEEN $1 AND $2 GROUP BY business_date ORDER BY business_date`,
    [fromDate, toDate]
  );
  return rows.map((r: any) => ({ date: r.date, value: Number(r.value) }));
}

/**
 * Owner Home dashboard (owner-requested, from a competitor app
 * screenshot) — one consolidated call rather than the web page firing
 * eight separate requests. Every figure here already has a canonical
 * source elsewhere in the build (P&L, stock valuation, cash/bank book,
 * customer/vendor ageing, refill-due) and is read from that source
 * directly, never recomputed a second way — same "one aggregation path"
 * discipline `computeFinancialSummary` itself documents. The three
 * genuinely new pieces (customer counts, per-entity dues with a nearest
 * invoice, product velocity) live next to the functions they extend
 * (`repo/customers.ts`, `repo/vendors.ts`, `repo/margin-reports.ts`), not
 * duplicated here.
 */
export async function getOwnerHomeDashboard(fromDate: string, toDate: string) {
  const previous = shiftRangeBack(fromDate, toDate);

  const [
    summary,
    previousSummary,
    stockValuation,
    customerStats,
    cashBook,
    bankBook,
    salesDailyTrend,
    purchaseDailyTrend,
    customerDues,
    vendorDues,
    velocity,
    refillDue,
  ] = await Promise.all([
    computeFinancialSummary(fromDate, toDate),
    computeFinancialSummary(previous.from, previous.to),
    getStockValuationAsOf(toDate),
    getCustomerHomeStats(fromDate, toDate),
    getCashOrBankBook("cash", fromDate, toDate),
    getCashOrBankBook("bank", fromDate, toDate),
    getSalesDailyTrend(fromDate, toDate),
    getPurchaseDailyTrend(fromDate, toDate),
    getCustomerDuesList(),
    getVendorDuesList(),
    getProductVelocity(fromDate, toDate),
    listRefillDue(),
  ]);

  const netPaymentCollection = round2(
    cashBook.days.reduce((a, d) => a + d.receipts, 0) + bankBook.days.reduce((a, d) => a + d.receipts, 0)
  );

  return {
    period: { from: fromDate, to: toDate },
    netSales: {
      value: summary.sales.total,
      previousValue: previousSummary.sales.total,
      dailyTrend: salesDailyTrend,
    },
    stockValue: { valueAtCost: stockValuation.valueAtCost, valueAtMrp: stockValuation.valueAtMrp },
    customers: {
      totalCustomers: customerStats.totalCustomers,
      avgOrderValue: summary.sales.averageBillValue,
      newCustomers: customerStats.newCustomers,
      repeatCustomers: customerStats.repeatCustomers,
    },
    netPurchase: {
      value: summary.purchases.gstTotal,
      previousValue: previousSummary.purchases.gstTotal,
      dailyTrend: purchaseDailyTrend,
    },
    netPaymentCollection,
    profit: { grossProfit: summary.grossProfit.value, netProfit: summary.netProfit },
    slowMoving: velocity.slowMoving,
    fastMoving: velocity.fastMoving,
    duePayments: {
      customer: customerDues,
      distributor: vendorDues,
      totalCustomerDue: round2(customerDues.reduce((a, r) => a + r.totalDue, 0)),
      totalDistributorDue: round2(vendorDues.reduce((a, r) => a + r.totalDue, 0)),
    },
    refillReminders: refillDue.slice(0, 10),
  };
}
