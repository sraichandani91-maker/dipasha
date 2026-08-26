import { pool } from "../db.js";
import { getSetting } from "../repo/settings.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface LowStockSuggestion {
  productId: string;
  productName: string;
  currentSellableStock: number;
  avgDailyUnits: number;
  reorderLevel: number;
  suggestedQty: number;
  seasonalityMultiplier: number;
}

export interface ClearanceCandidate {
  productId: string;
  productName: string;
  nearExpiryStock: number;
  totalSellableStock: number;
}

/**
 * Section 6B.3 / 9A.7: "below reorder level, computed from sales
 * velocity, not a fixed number." No default trailing window, lead time
 * or safety buffer is given anywhere in the brief for this — the values
 * used here are seeded, owner-editable settings (see the M5 migration
 * and DECISIONS.md), not a hardcoded business rule.
 *
 * Also: "never suggest reordering a SKU whose existing stock is near
 * expiry — surface that as a clearance action instead." A SKU whose
 * entire remaining sellable stock sits inside the near-expiry window is
 * dropped from suggestions and returned separately — buying more of
 * something that needs clearing out is the wrong move even if velocity
 * math alone would say "reorder."
 */
export async function lowStockSuggestions(): Promise<{ suggestions: LowStockSuggestion[]; clearanceCandidates: ClearanceCandidate[] }> {
  const db = requirePool();
  const windowDays = await getSetting("reorder_trailing_window_days", 14);
  const leadTimeDays = await getSetting("reorder_default_lead_time_days", 7);
  const bufferPercent = await getSetting("reorder_safety_buffer_percent", 20);
  const nearExpiryDays = await getSetting("near_expiry_pick_block_days", 30);

  const { rows } = await db.query(
    `
    WITH velocity AS (
      SELECT product_id, SUM(-quantity_delta)::numeric / $1 AS avg_daily_units
      FROM movement_ledger
      WHERE movement_type IN ('gst_sale', 'stock_issue')
        AND created_at > now() - ($1 || ' days')::interval
      GROUP BY product_id
    ),
    current_stock AS (
      SELECT product_id, SUM(quantity_base_units)::int AS qty FROM sellable_stock GROUP BY product_id
    ),
    near_expiry_stock AS (
      SELECT s.product_id, SUM(s.quantity_base_units)::int AS qty
      FROM sellable_stock s JOIN batches b ON b.id = s.batch_id
      WHERE b.expiry_date <= CURRENT_DATE + ($4 || ' days')::interval
      GROUP BY s.product_id
    )
    SELECT p.id AS product_id, p.name AS product_name, p.seasonality_multiplier,
      COALESCE(cs.qty, 0) AS current_sellable_stock,
      COALESCE(v.avg_daily_units, 0) AS avg_daily_units,
      CEIL(COALESCE(v.avg_daily_units, 0) * $2 * (1 + $3::numeric / 100) * p.seasonality_multiplier)::int AS reorder_level,
      COALESCE(nes.qty, 0) AS near_expiry_stock
    FROM products p
    LEFT JOIN velocity v ON v.product_id = p.id
    LEFT JOIN current_stock cs ON cs.product_id = p.id
    LEFT JOIN near_expiry_stock nes ON nes.product_id = p.id
    WHERE p.status = 'active'
    `,
    [windowDays, leadTimeDays, bufferPercent, nearExpiryDays]
  );

  const suggestions: LowStockSuggestion[] = [];
  const clearanceCandidates: ClearanceCandidate[] = [];

  for (const r of rows) {
    const suggestedQty = Math.max(0, r.reorder_level - r.current_sellable_stock);
    if (suggestedQty <= 0) continue;

    const allRemainingStockIsNearExpiry = r.current_sellable_stock > 0 && r.near_expiry_stock >= r.current_sellable_stock;
    if (allRemainingStockIsNearExpiry) {
      clearanceCandidates.push({
        productId: r.product_id,
        productName: r.product_name,
        nearExpiryStock: r.near_expiry_stock,
        totalSellableStock: r.current_sellable_stock,
      });
      continue;
    }

    suggestions.push({
      productId: r.product_id,
      productName: r.product_name,
      currentSellableStock: r.current_sellable_stock,
      avgDailyUnits: Number(r.avg_daily_units),
      reorderLevel: r.reorder_level,
      suggestedQty,
      seasonalityMultiplier: Number(r.seasonality_multiplier),
    });
  }

  return { suggestions, clearanceCandidates };
}
