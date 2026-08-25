/**
 * The movement ledger (Section 6.1, 11, 15) — one append-only table for
 * every stock change, all 9 movement_type values. On-hand quantity is
 * ALWAYS a derived sum, never an editable field: `stock` below is a VIEW,
 * not a table, so there is no quantity column anywhere to accidentally
 * UPDATE. Immutability is enforced with a trigger, not just convention —
 * a ledger row you could still UPDATE or DELETE isn't actually a ledger.
 *
 * `transfer` (bin-to-bin) and a batch-spanning sale/return write TWO rows
 * sharing a `transfer_group_id`, rather than one row with two bin
 * columns — this keeps every row a single, unambiguous stock effect,
 * consistent with how Section 6A.2 describes a multi-batch sale line
 * auto-splitting into one printed sub-line per batch.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE movement_type AS ENUM (
      'gst_purchase',
      'stock_received',
      'gst_sale',
      'stock_issue',
      'purchase_return',
      'sale_return',
      'write_off',
      'adjustment',
      'transfer'
    );
  `);

  pgm.sql(`
    CREATE TYPE movement_source AS ENUM ('app', 'web', 'web_manual');
  `);

  pgm.sql(`
    CREATE TABLE movement_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_type movement_type NOT NULL,
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      bin_id uuid NOT NULL REFERENCES bins(id),
      -- Signed delta in base units (Section 5A.1: never fractional packs,
      -- never a separate "loose" column). Positive = stock added to this
      -- bin/batch, negative = removed. This single sign convention is why
      -- SUM(quantity_delta) is always the right on-hand answer regardless
      -- of movement_type.
      quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
      reason_code text NULL,
      note text NULL,
      -- Polymorphic link to the document that caused this row (a purchase
      -- invoice, a sale, a cycle count) — those tables arrive in later
      -- milestones (M3/M4/M6). Nullable now, populated once they exist.
      reference_type text NULL,
      reference_id uuid NULL,
      transfer_group_id uuid NULL,
      source movement_source NOT NULL DEFAULT 'app',
      actor_user_id uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_ledger_stock_key ON movement_ledger(product_id, bin_id, batch_id);`);
  pgm.sql(`CREATE INDEX idx_ledger_batch ON movement_ledger(batch_id);`);
  pgm.sql(`CREATE INDEX idx_ledger_created_at ON movement_ledger(created_at);`);
  pgm.sql(`CREATE INDEX idx_ledger_movement_type ON movement_ledger(movement_type);`);
  pgm.sql(`CREATE INDEX idx_ledger_reference ON movement_ledger(reference_type, reference_id) WHERE reference_type IS NOT NULL;`);

  // Append-only, enforced at the database, not just by convention.
  pgm.sql(`
    CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'movement_ledger is append-only: % is not permitted (row id %)', TG_OP, OLD.id;
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER trg_movement_ledger_no_update
      BEFORE UPDATE ON movement_ledger
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
  `);
  pgm.sql(`
    CREATE TRIGGER trg_movement_ledger_no_delete
      BEFORE DELETE ON movement_ledger
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
  `);

  // On-hand stock, always derived. Section 4: keyed on (sku, bin, batch),
  // not a location field on the product.
  pgm.sql(`
    CREATE VIEW stock AS
    SELECT
      product_id,
      bin_id,
      batch_id,
      SUM(quantity_delta)::int AS quantity_base_units
    FROM movement_ledger
    GROUP BY product_id, bin_id, batch_id
    HAVING SUM(quantity_delta) <> 0;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP VIEW IF EXISTS stock;`);
  pgm.sql(`DROP TRIGGER IF EXISTS trg_movement_ledger_no_delete ON movement_ledger;`);
  pgm.sql(`DROP TRIGGER IF EXISTS trg_movement_ledger_no_update ON movement_ledger;`);
  pgm.sql(`DROP FUNCTION IF EXISTS prevent_ledger_mutation;`);
  pgm.sql(`DROP TABLE IF EXISTS movement_ledger;`);
  pgm.sql(`DROP TYPE IF EXISTS movement_source;`);
  pgm.sql(`DROP TYPE IF EXISTS movement_type;`);
};
