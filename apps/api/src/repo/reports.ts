import { pool } from "../db.js";
import { getSetting } from "./settings.js";
import { enqueueAndSendNow } from "../domain/notifications.js";
import type { MinimalLogger } from "../lib/whatsapp-sender.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

// --- M13.10: prebuilt dashboard + the daily auto-report share this one
// summary shape. The dashboard calls it for "today," live; the daily
// report calls it once for the business date just ending and freezes
// the result into `daily_reports.summary` — same snapshot-at-the-
// meaningful-moment reasoning as cycle counts' system_quantity and
// batch_corrections' old_value, so a report about a closed day never
// silently drifts as later data comes in. ---

export interface DailySummary {
  businessDate: string;
  salesTotal: number;
  billCount: number;
  pendingDeliveryOrders: number;
  pendingPutawayTasks: number;
  openCycleCountTasks: number;
  pendingWriteOffApprovals: number;
  coldChainHasGap: boolean;
  coldChainOutOfRange: boolean;
}

const DELIVERY_ORDER_TERMINAL_STATUSES = ["delivered", "cancelled", "rejected"];

export async function computeDailySummary(businessDate: string): Promise<DailySummary> {
  const db = requirePool();

  const [sales, orders, putaway, cycleCounts, writeOffs, coldChain] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count FROM sales WHERE business_date = $1 AND status = 'completed'`, [businessDate]),
    db.query(`SELECT COUNT(*) AS count FROM orders WHERE created_at::date = $1 AND status NOT IN (${DELIVERY_ORDER_TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(",")})`, [businessDate, ...DELIVERY_ORDER_TERMINAL_STATUSES]),
    db.query(`SELECT COUNT(*) AS count FROM putaway_tasks WHERE status = 'pending'`),
    db.query(`SELECT COUNT(*) AS count FROM cycle_count_tasks WHERE business_date = $1 AND status IN ('pending', 'counted')`, [businessDate]),
    db.query(`SELECT COUNT(*) AS count FROM write_offs WHERE status = 'pending'`),
    db.query(`SELECT recorded_at, in_range FROM cold_chain_temperature_logs ORDER BY recorded_at DESC LIMIT 1`),
  ]);

  const maxGapHours = await getSetting("cold_chain_max_gap_hours", 8);
  const lastReading = coldChain.rows[0];
  const hoursSince = lastReading ? (Date.now() - new Date(lastReading.recorded_at).getTime()) / (1000 * 60 * 60) : Infinity;

  return {
    businessDate,
    salesTotal: Number(sales.rows[0].total),
    billCount: Number(sales.rows[0].count),
    pendingDeliveryOrders: Number(orders.rows[0].count),
    pendingPutawayTasks: Number(putaway.rows[0].count),
    openCycleCountTasks: Number(cycleCounts.rows[0].count),
    pendingWriteOffApprovals: Number(writeOffs.rows[0].count),
    coldChainHasGap: hoursSince > maxGapHours,
    coldChainOutOfRange: lastReading ? !lastReading.in_range : false,
  };
}

// DB's own CURRENT_DATE, not the app server's clock — same reasoning as
// cycle-counts' getCurrentBusinessDate.
export async function getTodayBusinessDate(): Promise<string> {
  const { rows } = await requirePool().query(`SELECT CURRENT_DATE::text AS d`);
  return rows[0].d;
}

export interface ItemLedgerRow {
  productId: string;
  productName: string;
  openingStock: number;
  purchasedUnits: number;
  soldUnits: number;
  otherMovementUnits: number;
  closingStock: number;
}

// Owner-requested (post-M16): "sales, purchase, and closing stock at item
// level for a date range" — flagged as a real gap back in M7 (there
// asked as a "reorder book") and deferred to this reporting layer, never
// actually built after that. Same balance-reconstruction technique as
// Financials' stock valuation (`getStockValuationAsOf`) — a product's
// stock as of any moment is `SUM(movement_ledger.quantity_delta)` up to
// that moment, never a separately-maintained running total — just run
// twice (once for the day before the range starts, once for the range's
// last day) instead of once. Purchased/sold are the two movement-type
// groups everyone means by those words (`gst_purchase`/`stock_received`
// and `gst_sale`/`stock_issue`); everything else that can move stock in
// this build (returns, write-offs, adjustments, transfers) is summed
// separately into `otherMovementUnits` rather than silently folded into
// one of the two, so `opening + purchased - sold + other = closing`
// always reconciles exactly instead of looking like it doesn't.
export async function getItemLedgerReport(fromDate: string, toDate: string): Promise<ItemLedgerRow[]> {
  const { rows } = await requirePool().query(
    `
    WITH opening AS (
      SELECT b.product_id, SUM(ml.quantity_delta)::int AS qty
      FROM movement_ledger ml JOIN batches b ON b.id = ml.batch_id
      WHERE ml.created_at < $1::timestamptz
      GROUP BY b.product_id
    ),
    closing AS (
      SELECT b.product_id, SUM(ml.quantity_delta)::int AS qty
      FROM movement_ledger ml JOIN batches b ON b.id = ml.batch_id
      WHERE ml.created_at < ($2::date + 1)::timestamptz
      GROUP BY b.product_id
    ),
    purchased AS (
      SELECT b.product_id, SUM(ml.quantity_delta)::int AS qty
      FROM movement_ledger ml JOIN batches b ON b.id = ml.batch_id
      WHERE ml.movement_type IN ('gst_purchase', 'stock_received')
        AND ml.created_at >= $1::timestamptz AND ml.created_at < ($2::date + 1)::timestamptz
      GROUP BY b.product_id
    ),
    sold AS (
      SELECT b.product_id, SUM(-ml.quantity_delta)::int AS qty
      FROM movement_ledger ml JOIN batches b ON b.id = ml.batch_id
      WHERE ml.movement_type IN ('gst_sale', 'stock_issue')
        AND ml.created_at >= $1::timestamptz AND ml.created_at < ($2::date + 1)::timestamptz
      GROUP BY b.product_id
    ),
    other AS (
      SELECT b.product_id, SUM(ml.quantity_delta)::int AS qty
      FROM movement_ledger ml JOIN batches b ON b.id = ml.batch_id
      WHERE ml.movement_type NOT IN ('gst_purchase', 'stock_received', 'gst_sale', 'stock_issue')
        AND ml.created_at >= $1::timestamptz AND ml.created_at < ($2::date + 1)::timestamptz
      GROUP BY b.product_id
    )
    SELECT p.id AS product_id, p.name AS product_name,
      COALESCE(o.qty, 0) AS opening_stock,
      COALESCE(pu.qty, 0) AS purchased_units,
      COALESCE(s.qty, 0) AS sold_units,
      COALESCE(ot.qty, 0) AS other_movement_units,
      COALESCE(c.qty, 0) AS closing_stock
    FROM products p
    LEFT JOIN opening o ON o.product_id = p.id
    LEFT JOIN closing c ON c.product_id = p.id
    LEFT JOIN purchased pu ON pu.product_id = p.id
    LEFT JOIN sold s ON s.product_id = p.id
    LEFT JOIN other ot ON ot.product_id = p.id
    WHERE COALESCE(o.qty, 0) <> 0 OR COALESCE(c.qty, 0) <> 0 OR COALESCE(pu.qty, 0) <> 0 OR COALESCE(s.qty, 0) <> 0
    ORDER BY p.name
    `,
    [fromDate, toDate]
  );
  return rows.map((r) => ({
    productId: r.product_id, productName: r.product_name,
    openingStock: r.opening_stock, purchasedUnits: r.purchased_units, soldUnits: r.sold_units,
    otherMovementUnits: r.other_movement_units, closingStock: r.closing_stock,
  }));
}

export async function listDailyReports(limit = 30) {
  const { rows } = await requirePool().query(
    `SELECT id, business_date, generated_at, summary FROM daily_reports ORDER BY business_date DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// Shop-local (IST) wall-clock time, independent of whatever timezone the
// server OS/container happens to be set to — the same unstated
// assumption the browser-side daily-request-review alarm already makes
// for "local," made explicit and enforced here instead of left to
// whatever TZ the deployment host is in.
function currentIstTimeHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

/**
 * Section 10.2's daily auto-report. Called from a plain `setInterval`
 * poller (index.ts), same "no background job runner, a Postgres-backed
 * check polled by whoever's running" pattern M8's notification
 * dispatcher already established — not a second scheduling mechanism.
 * Idempotent per business date (`daily_reports.business_date` is
 * UNIQUE): a second tick the same day, or a restart, never double-sends.
 */
export async function generateDailyReportIfDue(log: MinimalLogger): Promise<void> {
  const enabled = await getSetting("daily_report_enabled", true);
  if (!enabled) return;

  const configuredTime = await getSetting("daily_report_time_local", "21:00");
  if (currentIstTimeHHMM() < configuredTime) return;

  const db = requirePool();
  const businessDate = await getTodayBusinessDate();

  const { rows: existing } = await db.query(`SELECT 1 FROM daily_reports WHERE business_date = $1`, [businessDate]);
  if (existing.length > 0) return;

  const summary = await computeDailySummary(businessDate);
  await db.query(`INSERT INTO daily_reports (business_date, summary) VALUES ($1, $2)`, [businessDate, JSON.stringify(summary)]);

  const triggerEnabled = await getSetting("whatsapp_trigger_daily_report_enabled", true);
  if (!triggerEnabled) return;

  const { rows: owners } = await db.query(`SELECT phone FROM users WHERE role = 'owner' AND status = 'active'`);
  for (const owner of owners) {
    await enqueueAndSendNow(
      {
        triggerType: "daily_report",
        category: "transactional",
        templateKey: "whatsapp_template_daily_report",
        triggerEnabledSettingKey: "whatsapp_trigger_daily_report_enabled",
        recipientCustomerId: null,
        recipientPhone: owner.phone,
        referenceType: "daily_report",
        referenceId: null,
        payload: summary as unknown as Record<string, unknown>,
      },
      log
    );
  }
}

// Section 6A.3 / 10A.3: "writes automatically to the statutory register
// — no separate manual entry, ever. The register is a view over sales
// data." This query IS that view — there is no separate register table
// to keep in sync.
export async function scheduleHRegister(fromDate: string, toDate: string) {
  const { rows } = await requirePool().query(
    `
    SELECT
      s.bill_number, s.created_at, s.customer_name,
      p.name AS drug_name, p.schedule_category, b.batch_no, sl.quantity_base_units,
      spd.prescriber_name, spd.prescriber_registration_number, spd.patient_name, spd.patient_contact,
      u.name AS pharmacist_name
    FROM sale_lines sl
    JOIN sales s ON s.id = sl.sale_id
    JOIN products p ON p.id = sl.product_id
    JOIN batches b ON b.id = sl.batch_id
    JOIN users u ON u.id = s.created_by
    LEFT JOIN sale_prescriber_details spd ON spd.sale_id = s.id
    WHERE s.status = 'completed'
      AND p.schedule_category IN ('H', 'H1')
      AND s.business_date BETWEEN $1 AND $2
    ORDER BY s.created_at
    `,
    [fromDate, toDate]
  );
  return rows;
}
