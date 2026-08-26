/**
 * M5: customer request book (Section 6B), purchase orders fed by low
 * stock + open requests + manual additions (Section 6B.3), and stock
 * reservation for the callback loop (Section 6B.4).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE request_status AS ENUM ('open', 'on_po', 'received', 'customer_notified', 'fulfilled', 'cancelled', 'lapsed');
  `);
  pgm.sql(`CREATE TYPE request_urgency AS ENUM ('urgent', 'normal', 'can_wait');`);

  pgm.sql(`
    CREATE TABLE customer_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_name text NOT NULL,
      customer_phone text NOT NULL, -- Section 6B.1: "phone is the key — it drives the callback"
      -- Exactly one of these three is set, per Section 6B.1's three cases.
      product_id uuid NULL REFERENCES products(id),         -- known SKU
      pending_product_id uuid NULL REFERENCES products(id), -- unknown item -> created as status=pending
      free_text_item text NULL,                              -- unknown item, not yet turned into a product
      quantity_requested_units int NULL,
      quantity_requested_note text NULL, -- as typed, e.g. "2 strips" — free-text items may not resolve to base units yet
      urgency request_urgency NOT NULL DEFAULT 'normal',
      has_prescription_in_hand boolean NOT NULL DEFAULT false,
      expected_date date NULL,
      note text NULL,
      status request_status NOT NULL DEFAULT 'open',
      purchase_order_id uuid NULL, -- FK added after purchase_orders exists, below
      could_not_source_reason text NULL,
      unreachable_attempts int NOT NULL DEFAULT 0,
      fulfilled_sale_id uuid NULL REFERENCES sales(id),
      logged_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      source movement_source NOT NULL DEFAULT 'app',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_customer_requests_status ON customer_requests(status);`);
  pgm.sql(`CREATE INDEX idx_customer_requests_phone ON customer_requests(customer_phone);`);
  pgm.sql(`CREATE INDEX idx_customer_requests_product ON customer_requests(product_id) WHERE product_id IS NOT NULL;`);

  pgm.sql(`
    CREATE TABLE purchase_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      po_number text NOT NULL UNIQUE,
      vendor_id uuid NOT NULL REFERENCES vendors(id),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received', 'cancelled')),
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`ALTER TABLE customer_requests ADD CONSTRAINT fk_customer_requests_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id);`);

  pgm.sql(`
    CREATE TABLE purchase_order_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      source_reasons text[] NOT NULL DEFAULT '{}' -- e.g. {'low_stock','customer_request'}
    );
  `);
  pgm.sql(`CREATE INDEX idx_po_lines_po ON purchase_order_lines(purchase_order_id);`);

  // Keeps the individual request links even after aggregation onto one
  // PO line, "so every requester is notified on arrival" (Section 6B.3).
  pgm.sql(`
    CREATE TABLE purchase_order_line_requests (
      purchase_order_line_id uuid NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
      customer_request_id uuid NOT NULL REFERENCES customer_requests(id),
      PRIMARY KEY (purchase_order_line_id, customer_request_id)
    );
  `);

  // Section 6B.4: reserved stock is excluded from sellable quantity.
  // Threaded through FEFO allocation and search so a walk-in can't buy
  // what's already promised to someone who was just called.
  pgm.sql(`
    CREATE TABLE stock_reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      bin_id uuid NOT NULL REFERENCES bins(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      customer_request_id uuid NOT NULL REFERENCES customer_requests(id),
      reserved_until timestamptz NOT NULL,
      released_at timestamptz NULL,
      released_reason text NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_stock_reservations_active ON stock_reservations(product_id, batch_id, bin_id) WHERE released_at IS NULL;`);
  pgm.sql(`CREATE INDEX idx_stock_reservations_request ON stock_reservations(customer_request_id);`);

  // Section 6B.4: "Reserved stock is excluded from sellable quantity."
  // One view, so FEFO allocation and search both read the same truth
  // rather than each reimplementing the reservation subtraction.
  pgm.sql(`
    CREATE VIEW sellable_stock AS
    SELECT
      s.product_id, s.bin_id, s.batch_id,
      (s.quantity_base_units - COALESCE(r.reserved_qty, 0))::int AS quantity_base_units
    FROM stock s
    LEFT JOIN (
      SELECT product_id, bin_id, batch_id, SUM(quantity_base_units) AS reserved_qty
      FROM stock_reservations
      WHERE released_at IS NULL AND reserved_until > now()
      GROUP BY product_id, bin_id, batch_id
    ) r ON r.product_id = s.product_id AND r.bin_id = s.bin_id AND r.batch_id = s.batch_id;
  `);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('reorder_trailing_window_days', '14'::jsonb, 'Trailing window for computing sales velocity feeding low-stock PO suggestions (Section 6B.3/9A.7). No default given in the brief — a reasonable starting point, owner-editable.'),
      ('reorder_default_lead_time_days', '7'::jsonb, 'Assumed vendor lead time for reorder-level computation, until per-vendor lead times exist (Section 9A.6). Same caveat as above.'),
      ('reorder_safety_buffer_percent', '20'::jsonb, 'Safety buffer added on top of lead-time demand for the reorder level (Section 9A.7). Same caveat as above.'),
      ('po_number_prefix', '"PO"'::jsonb, 'Prefix for purchase order numbers.');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN ('reorder_trailing_window_days', 'reorder_default_lead_time_days', 'reorder_safety_buffer_percent', 'po_number_prefix');`);
  pgm.sql(`DROP VIEW IF EXISTS sellable_stock;`);
  pgm.sql(`DROP TABLE IF EXISTS stock_reservations;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_order_line_requests;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_order_lines;`);
  pgm.sql(`ALTER TABLE customer_requests DROP CONSTRAINT IF EXISTS fk_customer_requests_po;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_orders;`);
  pgm.sql(`DROP TABLE IF EXISTS customer_requests;`);
  pgm.sql(`DROP TYPE IF EXISTS request_urgency;`);
  pgm.sql(`DROP TYPE IF EXISTS request_status;`);
};
