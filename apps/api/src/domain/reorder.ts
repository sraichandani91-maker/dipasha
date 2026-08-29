import { pool } from "../db.js";
import { getSetting } from "../repo/settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface ClearanceCandidate {
  productId: string;
  productName: string;
  nearExpiryStock: number;
  totalSellableStock: number;
}

export interface ShortbookSettings {
  minStockDays: number;
  maxStockDays: number;
  reorderPointDays: number;
  demandCalcPeriodDays: number;
  seasonalityEnabled: boolean;
}

export async function getShortbookSettings(): Promise<ShortbookSettings> {
  const [minStockDays, maxStockDays, reorderPointDays, demandCalcPeriodDays, seasonalityEnabled] = await Promise.all([
    getSetting("shortbook_min_stock_days", 3),
    getSetting("shortbook_max_stock_days", 14),
    getSetting("shortbook_reorder_point_days", 2),
    getSetting("shortbook_demand_calc_period_days", 30),
    getSetting("shortbook_seasonality_enabled", false),
  ]);
  return { minStockDays, maxStockDays, reorderPointDays, demandCalcPeriodDays, seasonalityEnabled };
}

export interface ShortbookItem {
  productId: string;
  productName: string;
  currentStock: number;
  avgDailyDemand: number;
  daysOfCover: number | null;
  suggestedQty: number;
  seasonalityMultiplier: number;
}

/**
 * "Order book" / Shortbook — days-of-cover reorder model (owner asked for
 * this after seeing a competitor app's Shortbook Settings: min/max stock
 * in days, reorder point in days, a demand-calculation period, and an
 * optional same-period-last-year blend), replacing the old trailing-
 * window + lead-time + safety-buffer-percent model this file used to
 * hold. A SKU is "short" once its remaining days of cover fall to or
 * below the reorder point; a reorder brings it back up to max stock
 * days' worth of cover.
 *
 * Same "never suggest reordering a SKU whose remaining stock is near
 * expiry" rule as before — those are returned separately as clearance
 * candidates rather than folded into the suggestion, unchanged from the
 * prior model.
 */
export async function shortbookItems(): Promise<{ items: ShortbookItem[]; clearanceCandidates: ClearanceCandidate[] }> {
  const db = requirePool();
  const settings = await getShortbookSettings();
  const nearExpiryDays = await getSetting("near_expiry_pick_block_days", 30);

  const { rows } = await db.query(
    `
    WITH current_demand AS (
      SELECT product_id, SUM(-quantity_delta)::numeric / $1 AS avg_daily_units
      FROM movement_ledger
      WHERE movement_type IN ('gst_sale', 'stock_issue')
        AND created_at > now() - ($1 || ' days')::interval
      GROUP BY product_id
    ),
    prior_year_demand AS (
      SELECT product_id, SUM(-quantity_delta)::numeric / $1 AS avg_daily_units
      FROM movement_ledger
      WHERE movement_type IN ('gst_sale', 'stock_issue')
        AND created_at <= now() - interval '1 year'
        AND created_at > now() - interval '1 year' - ($1 || ' days')::interval
      GROUP BY product_id
    ),
    current_stock AS (
      SELECT product_id, SUM(quantity_base_units)::int AS qty FROM sellable_stock GROUP BY product_id
    ),
    near_expiry_stock AS (
      SELECT s.product_id, SUM(s.quantity_base_units)::int AS qty
      FROM sellable_stock s JOIN batches b ON b.id = s.batch_id
      WHERE b.expiry_date <= CURRENT_DATE + ($2 || ' days')::interval
      GROUP BY s.product_id
    )
    SELECT p.id AS product_id, p.name AS product_name, p.seasonality_multiplier,
      COALESCE(cs.qty, 0) AS current_stock,
      COALESCE(cd.avg_daily_units, 0) AS current_avg_daily_units,
      COALESCE(pyd.avg_daily_units, 0) AS prior_year_avg_daily_units,
      COALESCE(nes.qty, 0) AS near_expiry_stock
    FROM products p
    LEFT JOIN current_demand cd ON cd.product_id = p.id
    LEFT JOIN prior_year_demand pyd ON pyd.product_id = p.id
    LEFT JOIN current_stock cs ON cs.product_id = p.id
    LEFT JOIN near_expiry_stock nes ON nes.product_id = p.id
    WHERE p.status = 'active'
    `,
    [settings.demandCalcPeriodDays, nearExpiryDays]
  );

  const items: ShortbookItem[] = [];
  const clearanceCandidates: ClearanceCandidate[] = [];

  for (const r of rows) {
    const seasonalityMultiplier = Number(r.seasonality_multiplier);
    const currentAvg = Number(r.current_avg_daily_units);
    const priorYearAvg = Number(r.prior_year_avg_daily_units);
    const blended = settings.seasonalityEnabled && priorYearAvg > 0 ? (currentAvg + priorYearAvg) / 2 : currentAvg;
    const avgDailyDemand = blended * seasonalityMultiplier;
    const currentStock = r.current_stock as number;

    const daysOfCover = avgDailyDemand > 0 ? currentStock / avgDailyDemand : null;
    const isShort = daysOfCover !== null && daysOfCover <= settings.reorderPointDays;
    if (!isShort) continue;

    const allRemainingStockIsNearExpiry = currentStock > 0 && r.near_expiry_stock >= currentStock;
    if (allRemainingStockIsNearExpiry) {
      clearanceCandidates.push({
        productId: r.product_id,
        productName: r.product_name,
        nearExpiryStock: r.near_expiry_stock,
        totalSellableStock: currentStock,
      });
      continue;
    }

    const targetStockQty = Math.ceil(avgDailyDemand * settings.maxStockDays);
    const suggestedQty = Math.max(0, targetStockQty - currentStock);
    if (suggestedQty <= 0) continue;

    items.push({
      productId: r.product_id,
      productName: r.product_name,
      currentStock,
      avgDailyDemand,
      daysOfCover,
      suggestedQty,
      seasonalityMultiplier,
    });
  }

  return { items, clearanceCandidates };
}
