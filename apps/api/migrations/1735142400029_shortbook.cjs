exports.up = (pgm) => {
  // Order Book / Shortbook: replaces the old velocity+lead-time+buffer
  // reorder model with a days-of-cover model (min/max stock in days,
  // reorder point in days, demand-calculation period, optional
  // same-period-last-year seasonality blend) — the shape the owner asked
  // for after seeing a competitor app's Shortbook Settings screen. The
  // three settings this replaces (reorder_trailing_window_days,
  // reorder_default_lead_time_days, reorder_safety_buffer_percent) drop
  // out of domain/reorder.ts entirely, so they're removed here rather
  // than left behind as dead, still-editable rows on the Settings screen.
  pgm.sql(`DELETE FROM settings WHERE key IN ('reorder_trailing_window_days', 'reorder_default_lead_time_days', 'reorder_safety_buffer_percent');`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('shortbook_min_stock_days', '3'::jsonb, 'Order Book — minimum days of cover to keep on hand. Below this, an item shows as short.'),
      ('shortbook_max_stock_days', '14'::jsonb, 'Order Book — target days of cover a reorder brings stock back up to. Must be greater than min stock days.'),
      ('shortbook_reorder_point_days', '2'::jsonb, 'Order Book — days-of-cover threshold that triggers a shortage flag. Must be between min and max stock days.'),
      ('shortbook_demand_calc_period_days', '30'::jsonb, 'Order Book — trailing window (days) used to compute average daily demand per item. Must be greater than max stock days and at most 90.'),
      ('shortbook_seasonality_enabled', 'false'::jsonb, 'Order Book — when on, blends this year''s recent demand with the same calendar window a year ago.');
  `);

  // One cart, store-wide (single-store build, same scope as every other
  // owner-facing screen here) — staged items awaiting a reorder, so the
  // "Items in Cart" dashboard tile reflects real state across page loads
  // rather than being scoped to one browser tab like the old in-memory
  // PO-suggestions selection was.
  pgm.sql(`
    CREATE TABLE shortbook_cart_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id) UNIQUE,
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      vendor_id uuid NULL REFERENCES vendors(id),
      added_by uuid NULL REFERENCES users(id),
      added_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS shortbook_cart_items;`);
  pgm.sql(`DELETE FROM settings WHERE key IN ('shortbook_min_stock_days', 'shortbook_max_stock_days', 'shortbook_reorder_point_days', 'shortbook_demand_calc_period_days', 'shortbook_seasonality_enabled');`);
  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('reorder_trailing_window_days', '14'::jsonb, 'Trailing window for computing sales velocity feeding low-stock PO suggestions (Section 6B.3/9A.7).'),
      ('reorder_default_lead_time_days', '7'::jsonb, 'Assumed vendor lead time for reorder-level computation, until per-vendor lead times exist (Section 9A.6).'),
      ('reorder_safety_buffer_percent', '20'::jsonb, 'Safety buffer added on top of lead-time demand for the reorder level (Section 9A.7).');
  `);
};
