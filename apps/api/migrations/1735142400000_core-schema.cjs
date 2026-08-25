/**
 * M1 core schema: settings, users, OTP codes, salt master, product master
 * (with composition child table), bin master, batches.
 *
 * The movement ledger and the stock view live in the next migration
 * (1735142400001_movement-ledger.js) since they depend on these tables.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  // -- settings: every configurable threshold in one place (Section 15) --
  pgm.sql(`
    CREATE TABLE settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      description text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid NULL
    );
  `);

  // -- users / roles (Section 3) --
  pgm.sql(`
    CREATE TYPE user_role AS ENUM ('owner', 'store_manager', 'picker_packer', 'rider');
  `);
  pgm.sql(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone text NOT NULL UNIQUE,
      name text NOT NULL,
      role user_role NOT NULL,
      pin_hash text NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NULL REFERENCES users(id)
    );
  `);

  // Phone + OTP login (Section 12). Codes are hashed at rest; never store
  // the plaintext OTP. The dev SMS sender (no real provider wired up yet,
  // per Section 14) logs the code instead of sending it.
  pgm.sql(`
    CREATE TABLE otp_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone text NOT NULL,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz NULL,
      attempts int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_otp_codes_phone ON otp_codes(phone, created_at DESC);`);

  // -- Salt master (Section 6B.2, 9A.1) --
  pgm.sql(`
    CREATE TABLE salts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`
    CREATE TABLE salt_synonyms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      salt_id uuid NOT NULL REFERENCES salts(id) ON DELETE CASCADE,
      synonym text NOT NULL,
      UNIQUE (salt_id, synonym)
    );
  `);
  pgm.sql(`CREATE INDEX idx_salt_synonyms_synonym ON salt_synonyms USING gin (synonym gin_trgm_ops);`);

  // -- Product master (Section 5, 5A) --
  // MRP, purchase rate and effective cost are NOT stored here — Section
  // 9A.8 is explicit that MRP lives on the batch (packs of the same SKU
  // legitimately carry different MRPs), and Section 6.5 computes effective
  // cost per batch from the purchase line. A flat per-SKU cost/margin
  // field would be wrong the first time two batches differ. See
  // DECISIONS.md.
  pgm.sql(`
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      manufacturer text NOT NULL,
      form text NOT NULL,
      schedule_category text NOT NULL CHECK (schedule_category IN
        ('OTC', 'H', 'H1', 'X', 'Ayurvedic', 'Cosmetic', 'Device')),
      requires_prescription boolean NOT NULL DEFAULT false,
      hsn_code text NOT NULL,
      gst_rate numeric(5,2) NOT NULL,
      base_unit text NOT NULL,
      pack_size int NOT NULL CHECK (pack_size > 0),
      outer_pack_size int NULL CHECK (outer_pack_size IS NULL OR outer_pack_size > 0),
      allow_loose_sale boolean NOT NULL DEFAULT true,
      loose_sale_markup_percent numeric(5,2) NOT NULL DEFAULT 0,
      is_cold_chain boolean NOT NULL DEFAULT false,
      barcode text NULL,
      substitute_group_id uuid NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'inactive')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NULL REFERENCES users(id)
    );
  `);
  pgm.sql(`CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);`);
  pgm.sql(`CREATE INDEX idx_products_manufacturer_trgm ON products USING gin (manufacturer gin_trgm_ops);`);
  pgm.sql(`CREATE INDEX idx_products_substitute_group ON products(substitute_group_id);`);
  pgm.sql(`CREATE UNIQUE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;`);

  // Composition is a repeatable child table, not one text field, so a
  // combination drug can carry several salt+strength pairs (Section 6B.2).
  pgm.sql(`
    CREATE TABLE product_compositions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      salt_id uuid NOT NULL REFERENCES salts(id),
      strength text NOT NULL,
      position int NOT NULL DEFAULT 0
    );
  `);
  pgm.sql(`CREATE INDEX idx_product_compositions_product ON product_compositions(product_id);`);
  pgm.sql(`CREATE INDEX idx_product_compositions_salt ON product_compositions(salt_id);`);

  // -- Bin master (Section 4) --
  pgm.sql(`
    CREATE TABLE bins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      zone text NULL CHECK (zone IS NULL OR zone IN ('CC', 'SH', 'RX', 'IN', 'QC', 'PK', 'FM')),
      aisle text NULL,
      bay text NULL,
      shelf_level text NULL,
      position int NULL,
      capacity_score numeric(6,2) NULL,
      pick_frequency_rank int NULL,
      restricted boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // -- Batches (Section 5, 6.5, 9A.2) --
  // Every stock movement carries batch_no and expiry_date; effective
  // landed cost is computed once here and never recomputed ad hoc
  // elsewhere (Section 6.5).
  pgm.sql(`
    CREATE TABLE batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_no text NOT NULL,
      expiry_date date NOT NULL,
      mrp numeric(10,2) NOT NULL,
      cost_unknown boolean NOT NULL DEFAULT false,
      rate_before_discount numeric(12,4) NULL,
      discount_value numeric(12,4) NULL,
      apportioned_charges numeric(12,4) NULL,
      free_quantity_base_units int NOT NULL DEFAULT 0,
      effective_cost_per_base_unit numeric(12,4) NULL,
      blocked boolean NOT NULL DEFAULT false,
      blocked_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (product_id, batch_no)
    );
  `);
  pgm.sql(`CREATE INDEX idx_batches_product ON batches(product_id);`);
  pgm.sql(`CREATE INDEX idx_batches_expiry ON batches(expiry_date);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS batches;`);
  pgm.sql(`DROP TABLE IF EXISTS bins;`);
  pgm.sql(`DROP TABLE IF EXISTS product_compositions;`);
  pgm.sql(`DROP TABLE IF EXISTS products;`);
  pgm.sql(`DROP TABLE IF EXISTS salt_synonyms;`);
  pgm.sql(`DROP TABLE IF EXISTS salts;`);
  pgm.sql(`DROP TABLE IF EXISTS otp_codes;`);
  pgm.sql(`DROP TABLE IF EXISTS users;`);
  pgm.sql(`DROP TYPE IF EXISTS user_role;`);
  pgm.sql(`DROP TABLE IF EXISTS settings;`);
};
