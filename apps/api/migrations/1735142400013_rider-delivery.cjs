/**
 * M11: rider role, handover scan, delivery marking, COD reconciliation
 * (Section 8). Extends the same `orders` lifecycle M10 built — a
 * delivery order that reaches `packed`/`partially_available` now
 * continues through assignment, handover, and delivery/failure, rather
 * than stopping at "packed."
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Section 8's own funnel names these stages, and 12A.2's WhatsApp
  // trigger text ("confirmed -> out for delivery -> delivered") uses
  // this exact terminology. Added to the same enum M10 created rather
  // than a parallel "delivery_status" column, so an order's lifecycle
  // always lives in one place.
  pgm.sql(`ALTER TYPE order_status ADD VALUE 'assigned';`);
  pgm.sql(`ALTER TYPE order_status ADD VALUE 'out_for_delivery';`);
  pgm.sql(`ALTER TYPE order_status ADD VALUE 'delivered';`);
  pgm.sql(`ALTER TYPE order_status ADD VALUE 'delivery_failed';`);

  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN rider_id uuid NULL REFERENCES users(id),
      ADD COLUMN assigned_at timestamptz NULL,
      ADD COLUMN assigned_by uuid NULL REFERENCES users(id),
      ADD COLUMN handover_scanned_at timestamptz NULL,
      ADD COLUMN reached_at timestamptz NULL,
      ADD COLUMN delivered_at timestamptz NULL,
      -- Section 8: "mark delivered (with OTP or signature)." Neither a
      -- real OTP-delivery channel nor a signature-capture UI exists in
      -- this build yet (no customer app, no WhatsApp inbound before
      -- M13) — this is a free-text field for whatever proof the rider
      -- actually has (a verbal OTP, "signed on paper", etc.), not a
      -- faked verification system.
      ADD COLUMN delivery_proof_note text NULL,
      ADD COLUMN failed_at timestamptz NULL,
      ADD COLUMN delivery_failed_reason_code text NULL
        CHECK (delivery_failed_reason_code IS NULL OR delivery_failed_reason_code IN
          ('customer_unavailable', 'wrong_address', 'refused', 'payment_failed', 'rx_invalid')),
      ADD COLUMN delivery_failed_note text NULL;
  `);
  pgm.sql(`CREATE INDEX idx_orders_rider ON orders(rider_id) WHERE rider_id IS NOT NULL;`);

  // Section 8: "Capture GPS ping at handover, at delivery, and every 60s
  // in-transit (battery-conscious; store polyline, not every raw ping)."
  // One row per ping at a 60s cadence is already the "not every raw
  // ping" version — a real GPS chip reports far more often than that;
  // this table itself doubles as the polyline (ORDER BY captured_at).
  pgm.sql(`
    CREATE TABLE order_gps_pings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      rider_id uuid NOT NULL REFERENCES users(id),
      lat numeric(9,6) NOT NULL,
      lng numeric(9,6) NOT NULL,
      kind text NOT NULL CHECK (kind IN ('handover', 'in_transit', 'delivered')),
      captured_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_gps_pings_order ON order_gps_pings(order_id, captured_at);`);

  // Section 8: "Failed deliveries generate a return-to-store task ->
  // items must be scanned back into their bins, not silently
  // restocked." Same scan-to-confirm shape as putaway_tasks, but a
  // dedicated table rather than reusing putaway_tasks directly — a
  // putaway task assumes the stock is already sitting in a real
  // staging bin; a failed-delivery return is physically in the
  // rider's bag until scanned, so there is no staging_bin_id to point
  // at yet.
  pgm.sql(`
    CREATE TABLE delivery_return_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sale_line_id uuid NOT NULL REFERENCES sale_lines(id),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      suggested_bin_id uuid NULL REFERENCES bins(id),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      completed_bin_id uuid NULL REFERENCES bins(id),
      completed_by uuid NULL REFERENCES users(id),
      completed_device_id text NULL,
      completed_source movement_source NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_delivery_return_tasks_status ON delivery_return_tasks(status);`);

  // Section 8: "end-of-shift cash reconciliation screen showing expected
  // vs declared, with variance flagged to Manager" — same shape as
  // day_close (Section 6A.5), but keyed per rider per day rather than
  // one row per business date, since multiple riders can close the same
  // day independently.
  pgm.sql(`
    CREATE TABLE rider_cash_reconciliations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rider_id uuid NOT NULL REFERENCES users(id),
      business_date date NOT NULL,
      expected_cash numeric(12,2) NOT NULL,
      declared_cash numeric(12,2) NOT NULL,
      variance numeric(12,2) NOT NULL,
      note text NULL,
      closed_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      closed_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_rider_cash_recon_rider_date ON rider_cash_reconciliations(rider_id, business_date);`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('whatsapp_trigger_out_for_delivery_enabled', 'true'::jsonb, 'Section 12A.2: "Delivery order:... out for delivery with rider name and number" — fires on handover scan.'),
      ('whatsapp_trigger_delivered_enabled', 'true'::jsonb, 'Section 12A.2: "...delivered" — fires when the rider marks an order delivered.'),
      ('whatsapp_template_out_for_delivery', 'null'::jsonb, 'Meta-approved template name for the out-for-delivery message, once one exists.'),
      ('whatsapp_template_delivered', 'null'::jsonb, 'Meta-approved template name for the delivered message, once one exists.');
  `);
};

exports.down = (pgm) => {
  // Postgres can't drop a single enum value cleanly (same reasoning as
  // M10's cod_pending addition) — the four new order_status values are
  // left in place on rollback, harmless as unused enum members.
  pgm.sql(`DELETE FROM settings WHERE key IN (
    'whatsapp_trigger_out_for_delivery_enabled', 'whatsapp_trigger_delivered_enabled',
    'whatsapp_template_out_for_delivery', 'whatsapp_template_delivered'
  );`);
  pgm.sql(`DROP TABLE IF EXISTS rider_cash_reconciliations;`);
  pgm.sql(`DROP TABLE IF EXISTS delivery_return_tasks;`);
  pgm.sql(`DROP TABLE IF EXISTS order_gps_pings;`);
  pgm.sql(`
    ALTER TABLE orders
      DROP COLUMN IF EXISTS rider_id,
      DROP COLUMN IF EXISTS assigned_at,
      DROP COLUMN IF EXISTS assigned_by,
      DROP COLUMN IF EXISTS handover_scanned_at,
      DROP COLUMN IF EXISTS reached_at,
      DROP COLUMN IF EXISTS delivered_at,
      DROP COLUMN IF EXISTS delivery_proof_note,
      DROP COLUMN IF EXISTS failed_at,
      DROP COLUMN IF EXISTS delivery_failed_reason_code,
      DROP COLUMN IF EXISTS delivery_failed_note;
  `);
};
