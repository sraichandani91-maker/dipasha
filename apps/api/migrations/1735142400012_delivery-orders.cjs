/**
 * M10: delivery channel (Section 7) + Section 7A unstructured-order
 * intake, order states, and the staff Pending Orders queue. Customer-app
 * screens are out of scope (Section 2) — this is the API, data model,
 * and staff-side handling only, built to also serve WhatsApp intake once
 * M13 wires up inbound messages.
 *
 * One `orders` table covers both paths named in Section 7's "order
 * intake": a structured order staff builds directly from the catalogue
 * (Section 7's own "manual order entry screen... you will use it from
 * day one"), and an unstructured one carrying free text and/or images
 * (Section 7A) that must be reviewed by a human before it can be picked
 * or priced. `has_unstructured_content` is what decides whether an order
 * can skip straight past `under_review` (Section 7A.2: "an order
 * containing any unstructured content cannot skip under_review").
 *
 * `order_pick_lines` deliberately doubles as both the pick list (Section
 * 7's walk-path sequence) and the packing checklist (blind scan verify)
 * — one row per (order line, batch) the same way `notification_log` is
 * both queue and log in M8, rather than two tables that have to agree
 * with each other.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Section 6A.8: "invoice generated at pack time." A delivery order is
  // normally COD (Section 8 title: "COD reconciliation") — the customer
  // pays the rider on handover, not at pack time — so the invoice this
  // milestone generates at pack has nothing genuinely tendered yet.
  // Recording it as 'cash' already collected would corrupt same-day cash
  // reconciliation; recording it as 'credit' would wrongly post it to
  // the customer's account-credit ledger (Section 9A.4's khata, a
  // different real thing). Neither existing tender_type fits, so this
  // adds one that means exactly "amount due, to be collected on
  // delivery" — M11's rider/COD reconciliation is what actually settles
  // it once that milestone exists.
  pgm.sql(`ALTER TYPE tender_type ADD VALUE 'cod_pending';`);

  pgm.sql(`
    CREATE TYPE order_status AS ENUM (
      'received', 'under_review', 'quoted', 'customer_confirmed',
      'awaiting_prescription', 'picking', 'picked', 'packed',
      'partially_available', 'rejected', 'cancelled'
    );
  `);
  pgm.sql(`CREATE TYPE order_intake_channel AS ENUM ('manual', 'whatsapp', 'api_stub');`);
  pgm.sql(`CREATE TYPE order_line_source AS ENUM ('catalog', 'free_text', 'image');`);
  pgm.sql(`CREATE TYPE order_line_status AS ENUM ('pending', 'matched', 'substituted', 'unavailable', 'pushed_to_request_book');`);

  // Section 7 batching: "same delivery pincode/zone AND created within a
  // rolling window AND combined weight/volume under rider capacity."
  // Weight/volume isn't tracked anywhere in the product schema (no field
  // for it, and adding one would be inventing data this build has no
  // source for) — batching here enforces pincode + time window + the
  // pilot cap of 3 only. Cold-chain orders never join a batch at all
  // (single-drop, per Section 7's own explicit fallback), so a
  // cold-chain order's `orders.delivery_batch_id` just stays NULL.
  pgm.sql(`
    CREATE TABLE delivery_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_pincode text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
      window_started_at timestamptz NOT NULL DEFAULT now(),
      order_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_delivery_batches_open ON delivery_batches(delivery_pincode, status) WHERE status = 'open';`);

  pgm.sql(`
    CREATE TABLE orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number text NOT NULL UNIQUE,
      status order_status NOT NULL DEFAULT 'received',
      intake_channel order_intake_channel NOT NULL DEFAULT 'manual',
      has_unstructured_content boolean NOT NULL DEFAULT false,
      customer_id uuid NULL REFERENCES customers(id),
      customer_name text NOT NULL,
      customer_phone text NOT NULL,
      delivery_address text NULL,
      delivery_pincode text NULL,
      free_text_note text NULL,
      staff_note text NULL,
      delivery_charge numeric(10,2) NOT NULL DEFAULT 0,
      quote_total numeric(12,2) NULL,
      rejection_reason text NULL,
      -- Section 7A.4: gate on ANY resolved line needing an Rx.
      rx_required boolean NOT NULL DEFAULT false,
      rx_verified boolean NOT NULL DEFAULT false,
      rx_verified_by uuid NULL REFERENCES users(id),
      rx_verified_at timestamptz NULL,
      -- Section 7 short-pick: "order goes partial" — set once packing
      -- completes with at least one line that never got fulfilled.
      is_partial boolean NOT NULL DEFAULT false,
      delivery_batch_id uuid NULL REFERENCES delivery_batches(id),
      sale_id uuid NULL REFERENCES sales(id), -- set at pack time (Section 6A.8: "invoice generated at pack time")
      quoted_at timestamptz NULL,
      quoted_by uuid NULL REFERENCES users(id),
      customer_confirmed_at timestamptz NULL,
      pick_started_at timestamptz NULL,
      pick_completed_at timestamptz NULL,
      pack_completed_at timestamptz NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      source movement_source NOT NULL DEFAULT 'app',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_orders_status ON orders(status);`);
  pgm.sql(`CREATE INDEX idx_orders_customer_phone ON orders(customer_phone);`);
  pgm.sql(`CREATE INDEX idx_orders_created_at ON orders(created_at);`);

  pgm.sql(`
    CREATE TABLE order_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      line_no int NOT NULL,
      source_type order_line_source NOT NULL,
      description_as_entered text NULL,
      product_id uuid NULL REFERENCES products(id),
      quantity_requested_units int NULL,
      quantity_note text NULL,
      quantity_confirmed_units int NULL,
      unit_price numeric(10,2) NULL,
      line_status order_line_status NOT NULL DEFAULT 'pending',
      requires_prescription boolean NOT NULL DEFAULT false,
      substituted_from_product_id uuid NULL REFERENCES products(id),
      unavailable_reason text NULL,
      pushed_customer_request_id uuid NULL REFERENCES customer_requests(id),
      -- Optional AI pre-parse (Section 7A.3) is deliberately not built
      -- this milestone — the section itself calls it optional ("the
      -- queue must work without it"), and it isn't named in M10's own
      -- build-order bullet. These columns are ready for it so adding the
      -- call later doesn't need another migration.
      ai_suggested_product_id uuid NULL REFERENCES products(id),
      ai_confidence numeric(4,3) NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_lines_order ON order_lines(order_id);`);

  pgm.sql(`
    CREATE TABLE order_images (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      file_path text NOT NULL,
      kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('prescription', 'strip_photo', 'other')),
      uploaded_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_images_order ON order_images(order_id);`);

  // Section 7A.4: "restrict access to Owner, Manager and pharmacist
  // roles... and log every view." A row per view, not a single
  // last-viewed column — the brief asks for a log, not a flag.
  pgm.sql(`
    CREATE TABLE order_image_views (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_image_id uuid NOT NULL REFERENCES order_images(id) ON DELETE CASCADE,
      viewed_by uuid NOT NULL REFERENCES users(id),
      viewed_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Section 7A.5 two-way conversation — in-app thread only this
  // milestone. Live WhatsApp bridging needs the inbound webhook + shared
  // inbox, both explicitly M13 (same call already made for M8's
  // callback trigger). `sender = 'customer'` rows are staff transcribing
  // what the customer said by phone or a relayed WhatsApp reply, since
  // there's no inbound channel yet for the customer to post directly.
  pgm.sql(`
    CREATE TABLE order_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sender text NOT NULL CHECK (sender IN ('customer', 'staff')),
      body text NOT NULL,
      created_by uuid NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_messages_order ON order_messages(order_id);`);

  // Pick list + packing checklist, one row per (order line, batch)
  // sub-allocation. `walk_sequence` is the serpentine bin-walk order
  // (Section 7: "aisle A left-to-right, aisle B right-to-left").
  // Pinning the exact batch/bin here at pick-generation time, and
  // reusing it unchanged at pack/invoice time via the same manual-batch-
  // override path Section 6A.2 already defines for POS, is what keeps
  // the eventual sale's batch/expiry data truthful to what a picker
  // actually scanned off the shelf — re-running FEFO fresh at pack time
  // could silently select a different batch if stock moved in between.
  pgm.sql(`
    CREATE TABLE order_pick_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      order_line_id uuid NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      bin_id uuid NOT NULL REFERENCES bins(id),
      batch_no text NOT NULL,
      expiry_date date NOT NULL,
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      walk_sequence int NOT NULL,
      scanned_confirmed boolean NOT NULL DEFAULT false,
      scanned_at timestamptz NULL,
      short_picked boolean NOT NULL DEFAULT false,
      short_reason text NULL,
      -- Set only when short-picked: how many were actually physically
      -- found, distinct from quantity_base_units (what the plan
      -- expected) so the original expectation stays on record even
      -- after a shortfall. A genuine stock-count discrepancy behind a
      -- shortfall is a cycle-count matter (Section 9) — out of scope
      -- here, which only tracks what got delivered.
      actual_quantity_found int NULL,
      packed_confirmed boolean NOT NULL DEFAULT false,
      packed_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_pick_lines_order ON order_pick_lines(order_id, walk_sequence);`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('order_number_prefix', '"ORD"'::jsonb, 'Prefix for delivery order numbers (Section 7), reserved gaplessly the same way bill numbers are.'),
      ('order_response_target_minutes', '15'::jsonb, 'Section 7A.3: Pending Orders queue ageing indicator turns amber then red against this target.'),
      ('delivery_batch_window_minutes', '8'::jsonb, 'Section 7: rolling window for grouping same-pincode orders into one delivery batch.'),
      ('delivery_batch_cap', '3'::jsonb, 'Section 7: pilot cap on orders per delivery batch.'),
      ('whatsapp_trigger_order_confirmed_enabled', 'true'::jsonb, 'Section 12A.2: "Delivery order: confirmed" — fires once an order is genuinely committed (catalogue order created, or an unstructured one accepted).'),
      ('whatsapp_trigger_order_quote_enabled', 'true'::jsonb, 'Section 7A.3: "quoting back... sent by WhatsApp and in-app."'),
      ('whatsapp_trigger_order_partial_enabled', 'true'::jsonb, 'Section 7: "order goes partial with customer notification triggered" — fires when packing completes with a short-picked line that had no substitute.'),
      ('whatsapp_template_order_confirmed', 'null'::jsonb, 'Meta-approved template name for the order-confirmed message, once one exists. Null until the owner has one — the dev sender ignores this and sends plain text.'),
      ('whatsapp_template_order_quote', 'null'::jsonb, 'Meta-approved template name for the order-quote message, once one exists.'),
      ('whatsapp_template_order_partial', 'null'::jsonb, 'Meta-approved template name for the order-partially-available message, once one exists.');
  `);
};

exports.down = (pgm) => {
  // Postgres can't drop a single enum value cleanly (would need to
  // rebuild tender_type and every column/index that uses it, owned by
  // an earlier migration). Leaving 'cod_pending' defined on rollback is
  // harmless — an unused enum member, not a functional difference.
  pgm.sql(`DELETE FROM settings WHERE key IN (
    'order_number_prefix', 'order_response_target_minutes', 'delivery_batch_window_minutes', 'delivery_batch_cap',
    'whatsapp_trigger_order_confirmed_enabled', 'whatsapp_trigger_order_quote_enabled', 'whatsapp_trigger_order_partial_enabled',
    'whatsapp_template_order_confirmed', 'whatsapp_template_order_quote', 'whatsapp_template_order_partial'
  );`);
  pgm.sql(`DROP TABLE IF EXISTS order_pick_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS order_messages;`);
  pgm.sql(`DROP TABLE IF EXISTS order_image_views;`);
  pgm.sql(`DROP TABLE IF EXISTS order_images;`);
  pgm.sql(`DROP TABLE IF EXISTS order_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS orders;`);
  pgm.sql(`DROP TABLE IF EXISTS delivery_batches;`);
  pgm.sql(`DROP TYPE IF EXISTS order_line_status;`);
  pgm.sql(`DROP TYPE IF EXISTS order_line_source;`);
  pgm.sql(`DROP TYPE IF EXISTS order_intake_channel;`);
  pgm.sql(`DROP TYPE IF EXISTS order_status;`);
};
