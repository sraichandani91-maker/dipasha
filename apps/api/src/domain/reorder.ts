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
}

/**
 * Section 6B.3 / 9A.7: "below reorder level, computed from sales
 * velocity, not a fixed number." No default trailing window, lead time
 * or safety buffer is given anywhere in the brief for this — the values
 * used here are seeded, owner-editable settings (see the M5 migration
 * and DECISIONS.md), not a hardcoded business rule.
 */
export async function lowStockSuggestions(): Promise<LowStockSuggestion[]> {
  const db = requirePool();
  const windowDays = await getSetting("reorder_trailing_window_days", 14);
  const leadTimeDays = await getSetting("reorder_default_lead_time_days", 7);
  const bufferPercent = await getSetting("reorder_safety_buffer_percent", 20);

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
    )
    SELECT p.id AS product_id, p.name AS product_name,
      COALESCE(cs.qty, 0) AS current_sellable_stock,
      COALESCE(v.avg_daily_units, 0) AS avg_daily_units,
      CEIL(COALESCE(v.avg_daily_units, 0) * $2 * (1 + $3::numeric / 100))::int AS reorder_level
    FROM products p
    LEFT JOIN velocity v ON v.product_id = p.id
    LEFT JOIN current_stock cs ON cs.product_id = p.id
    WHERE p.status = 'active'
    `,
    [windowDays, leadTimeDays, bufferPercent]
  );

  return rows
    .map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      currentSellableStock: r.current_sellable_stock,
      avgDailyUnits: Number(r.avg_daily_units),
      reorderLevel: r.reorder_level,
      suggestedQty: Math.max(0, r.reorder_level - r.current_sellable_stock),
    }))
    .filter((r) => r.suggestedQty > 0);
}
