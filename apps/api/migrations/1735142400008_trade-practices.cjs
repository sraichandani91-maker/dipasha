/**
 * M7: trade practices (Section 9A) — prescriber master, scheme/effective-
 * cost reporting, credit customers with ageing, pack-aware reorder,
 * vendor rate comparison.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 9A.1 — prescriber master. sale_prescriber_details keeps its existing
  // free-text columns (Section 6A.3: prompted, not blocked — a prescriber
  // not yet in the master must never stop a sale); prescriber_id is an
  // optional enrichment when the biller matches or creates a master row.
  pgm.sql(`
    CREATE TABLE prescribers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      registration_number text NULL,
      speciality text NULL,
      clinic_or_hospital text NULL,
      phone text NULL,
      address text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_prescribers_name_trgm ON prescribers USING gin (name gin_trgm_ops);`);

  pgm.sql(`ALTER TABLE sale_prescriber_details ADD COLUMN prescriber_id uuid NULL REFERENCES prescribers(id);`);

  // 9A.2 — scheme tracking: what was promised vs what actually arrived.
  // Nullable — only filled when the biller actually knows the promised
  // figures (a scheme agreement, a vendor's PO confirmation); most
  // invoices won't have this, and that's fine, not every purchase is a
  // scheme purchase.
  pgm.sql(`ALTER TABLE purchase_invoice_lines ADD COLUMN promised_quantity_base_units int NULL;`);
  pgm.sql(`ALTER TABLE purchase_invoice_lines ADD COLUMN promised_free_quantity_base_units int NULL;`);

  // 9A.4 — credit customers. `account_customer_id` is the family-grouping
  // mechanism: a family member bills against the account holder's limit
  // and balance, but their own sales still show who actually bought what
  // (Section 9A.4: "each identified on the statement"). One level only —
  // an account holder's own account_customer_id is always null.
  pgm.sql(`ALTER TABLE customers ADD COLUMN credit_enabled boolean NOT NULL DEFAULT false;`);
  pgm.sql(`ALTER TABLE customers ADD COLUMN credit_limit numeric(12,2) NULL;`);
  pgm.sql(`ALTER TABLE customers ADD COLUMN payment_terms_days int NOT NULL DEFAULT 0;`);
  pgm.sql(`ALTER TABLE customers ADD COLUMN account_customer_id uuid NULL REFERENCES customers(id);`);

  pgm.sql(`
    CREATE TABLE customer_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id),
      amount numeric(12,2) NOT NULL CHECK (amount > 0),
      payment_method text NOT NULL CHECK (payment_method IN ('cash', 'upi', 'card', 'cheque', 'bank_transfer')),
      reference_number text NULL,
      note text NULL,
      received_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Allocations are written once, at payment-recording time (oldest-bill-
  // first or a chosen bill) — not recomputed lazily — so a sale's
  // outstanding balance is always just credit_tendered minus
  // SUM(allocations), and ageing buckets by each bill's own age.
  pgm.sql(`
    CREATE TABLE customer_payment_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_payment_id uuid NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
      sale_id uuid NOT NULL REFERENCES sales(id),
      amount_allocated numeric(12,2) NOT NULL CHECK (amount_allocated > 0)
    );
  `);
  pgm.sql(`CREATE INDEX idx_payment_allocations_sale ON customer_payment_allocations(sale_id);`);
  pgm.sql(`CREATE INDEX idx_payment_allocations_payment ON customer_payment_allocations(customer_payment_id);`);

  // 9A.7 — pack-aware reorder: vendor MOQ (simplified to one default per
  // vendor, not per product-vendor pair — the brief says "the vendor's
  // minimum order pack" generically) and a per-product seasonality
  // multiplier, both nullable/defaulted so existing rows are unaffected.
  pgm.sql(`ALTER TABLE vendors ADD COLUMN default_min_order_pack_units int NULL;`);
  pgm.sql(`ALTER TABLE products ADD COLUMN seasonality_multiplier numeric(4,2) NOT NULL DEFAULT 1.0;`);

  // 9A.6 — vendor scorecard needs an actual PO -> invoice link to compute
  // lead time and fill rate, which didn't exist until now (M5's PO
  // creation had nothing downstream connecting a GRN back to its PO).
  pgm.sql(`ALTER TABLE purchase_invoices ADD COLUMN purchase_order_id uuid NULL REFERENCES purchase_orders(id);`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE purchase_invoices DROP COLUMN IF EXISTS purchase_order_id;`);
  pgm.sql(`ALTER TABLE products DROP COLUMN IF EXISTS seasonality_multiplier;`);
  pgm.sql(`ALTER TABLE vendors DROP COLUMN IF EXISTS default_min_order_pack_units;`);
  pgm.sql(`DROP TABLE IF EXISTS customer_payment_allocations;`);
  pgm.sql(`DROP TABLE IF EXISTS customer_payments;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS account_customer_id;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS payment_terms_days;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS credit_limit;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS credit_enabled;`);
  pgm.sql(`ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS promised_free_quantity_base_units;`);
  pgm.sql(`ALTER TABLE purchase_invoice_lines DROP COLUMN IF EXISTS promised_quantity_base_units;`);
  pgm.sql(`ALTER TABLE sale_prescriber_details DROP COLUMN IF EXISTS prescriber_id;`);
  pgm.sql(`DROP TABLE IF EXISTS prescribers;`);
};
