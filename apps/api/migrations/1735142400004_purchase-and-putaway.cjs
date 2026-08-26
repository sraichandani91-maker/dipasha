/**
 * M3: vendor master, GST purchase invoices (header + line, matching the
 * distributor-bill column order of Section 6.4), and put-away tasks
 * (Section 6.6).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE vendors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      gstin text NULL,
      -- First two digits of a valid Indian GSTIN are the state code.
      -- Stored separately so the CGST/SGST vs IGST split (Section 6.4)
      -- never has to re-parse the GSTIN at billing time.
      gst_state_code text NULL,
      payment_terms_days int NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NULL REFERENCES users(id)
    );
  `);

  pgm.sql(`
    CREATE TABLE purchase_invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_id uuid NOT NULL REFERENCES vendors(id),
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      invoice_value_stated numeric(12,2) NOT NULL,
      payment_terms_days int NOT NULL DEFAULT 0,
      due_date date NULL,
      bill_level_discount numeric(12,2) NOT NULL DEFAULT 0,
      freight_and_charges numeric(12,2) NOT NULL DEFAULT 0,
      round_off numeric(8,2) NOT NULL DEFAULT 0,
      taxable_value_total numeric(12,2) NOT NULL,
      tax_total numeric(12,2) NOT NULL,
      net_payable_computed numeric(12,2) NOT NULL,
      reconciliation_diff numeric(12,2) NOT NULL,
      reconciliation_acknowledged boolean NOT NULL DEFAULT false,
      entry_method text NOT NULL DEFAULT 'manual' CHECK (entry_method IN ('manual', 'ai_scan')),
      source movement_source NOT NULL DEFAULT 'app',
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      -- Section 6.2: "Reject a duplicate (vendor, invoice_number)
      -- combination" — a real hard block, unlike most other validations
      -- in this build, enforced here so it can never be bypassed by a
      -- race between two concurrent entries either.
      UNIQUE (vendor_id, invoice_number)
    );
  `);

  pgm.sql(`
    CREATE TABLE purchase_invoice_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_invoice_id uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      pack_as_printed text NULL,
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      free_quantity_base_units int NOT NULL DEFAULT 0,
      rate_before_discount numeric(12,4) NOT NULL,
      discount_percent numeric(5,2) NOT NULL DEFAULT 0,
      discount_value numeric(12,4) NOT NULL DEFAULT 0,
      taxable_value numeric(12,2) NOT NULL,
      gst_rate numeric(5,2) NOT NULL,
      cgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      sgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      igst_amount numeric(12,2) NOT NULL DEFAULT 0,
      cess_amount numeric(12,2) NOT NULL DEFAULT 0,
      line_total numeric(12,2) NOT NULL,
      apportioned_bill_discount numeric(12,4) NOT NULL DEFAULT 0,
      apportioned_charges numeric(12,4) NOT NULL DEFAULT 0
    );
  `);
  pgm.sql(`CREATE INDEX idx_purchase_invoice_lines_invoice ON purchase_invoice_lines(purchase_invoice_id);`);

  pgm.sql(`
    CREATE TABLE putaway_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      staging_bin_id uuid NOT NULL REFERENCES bins(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      suggested_bin_id uuid NULL REFERENCES bins(id),
      reference_type text NOT NULL, -- 'purchase_invoice' | 'stock_received'
      reference_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      completed_bin_id uuid NULL REFERENCES bins(id),
      completed_by uuid NULL REFERENCES users(id),
      completed_device_id text NULL,
      completed_source movement_source NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_putaway_tasks_status ON putaway_tasks(status);`);
  pgm.sql(`CREATE INDEX idx_putaway_tasks_reference ON putaway_tasks(reference_type, reference_id);`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES (
      'shop_gst_state_code',
      '"09"'::jsonb,
      'This shop''s own GST state code, for the CGST/SGST vs IGST split on purchases (Section 6.4). Inferred as Uttar Pradesh (09) from the Prayagraj address given in the build brief — CONFIRM against the shop''s actual GSTIN and correct if wrong, before this is relied on for real filing.'
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key = 'shop_gst_state_code';`);
  pgm.sql(`DROP TABLE IF EXISTS putaway_tasks;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_invoice_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_invoices;`);
  pgm.sql(`DROP TABLE IF EXISTS vendors;`);
};
