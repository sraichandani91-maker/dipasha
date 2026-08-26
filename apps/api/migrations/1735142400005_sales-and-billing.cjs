/**
 * M4: counter sales / GST billing (Section 6A). One `sales` table for
 * both channels (Section 6A.8) — `channel` distinguishes counter from
 * delivery, but the ledger, GST computation, and Schedule H/H1 capture
 * are identical either way. Delivery's own pick/pack/dispatch lifecycle
 * doesn't exist yet (M7/M10); this milestone only drives the counter
 * path end to end.
 *
 * A `sales` row only ever represents a REAL transaction (FEFO-committed
 * batches, stock deducted, a real bill number) — as final as a ledger
 * entry. "Hold" (Section 6A.4) and "draft/quotation" are both just an
 * unsaved bill sitting in the browser: `held_bills` is a plain JSONB
 * parking slot for that in-progress state, not a half-formed sale row —
 * it never touches stock or gets a bill number until actually completed.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Gapless bill/credit-note numbering (Section 6A.6): incrementing this
  // counter inside the SAME transaction as the sale insert means a
  // rolled-back sale also rolls back the number it reserved — unlike a
  // native SEQUENCE, which never rolls back and would leave a gap.
  pgm.sql(`
    CREATE TABLE bill_number_counters (
      prefix text PRIMARY KEY,
      next_number int NOT NULL DEFAULT 1
    );
  `);

  pgm.sql(`
    CREATE TABLE customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      phone text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;`);

  pgm.sql(`CREATE TYPE sale_channel AS ENUM ('counter', 'delivery');`);
  pgm.sql(`CREATE TYPE sale_status AS ENUM ('completed', 'cancelled');`);
  pgm.sql(`CREATE TYPE tender_type AS ENUM ('cash', 'upi', 'card', 'credit');`);

  pgm.sql(`
    CREATE TABLE sales (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bill_number text NOT NULL,
      channel sale_channel NOT NULL DEFAULT 'counter',
      status sale_status NOT NULL DEFAULT 'completed',
      customer_id uuid NULL REFERENCES customers(id),
      customer_name text NULL,
      customer_phone text NULL,
      taxable_value numeric(12,2) NOT NULL DEFAULT 0,
      bill_discount_value numeric(12,2) NOT NULL DEFAULT 0,
      tax_total numeric(12,2) NOT NULL DEFAULT 0,
      round_off numeric(8,2) NOT NULL DEFAULT 0,
      grand_total numeric(12,2) NOT NULL DEFAULT 0,
      amount_tendered numeric(12,2) NOT NULL DEFAULT 0,
      change_due numeric(12,2) NOT NULL DEFAULT 0,
      print_count int NOT NULL DEFAULT 0,
      cancelled_reason text NULL,
      cancelled_at timestamptz NULL,
      cancelled_by uuid NULL REFERENCES users(id),
      source movement_source NOT NULL DEFAULT 'app',
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL DEFAULT CURRENT_DATE
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_sales_bill_number ON sales(bill_number);`);
  pgm.sql(`CREATE INDEX idx_sales_status ON sales(status);`);
  pgm.sql(`CREATE INDEX idx_sales_business_date ON sales(business_date);`);

  pgm.sql(`
    CREATE TABLE sale_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      -- Several rows share this when FEFO auto-splits one requested line
      -- across batches (Section 6A.2) — same printed line, one sub-line
      -- per batch.
      requested_line_no int NOT NULL,
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      bin_id uuid NOT NULL REFERENCES bins(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      mrp numeric(10,2) NOT NULL,
      discount_percent numeric(5,2) NOT NULL DEFAULT 0,
      discount_value numeric(12,2) NOT NULL DEFAULT 0,
      taxable_value numeric(12,2) NOT NULL,
      gst_rate numeric(5,2) NOT NULL,
      cgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      sgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      line_total numeric(12,2) NOT NULL,
      -- Snapshotted at sale time so a margin figure can always be
      -- explained later even if something about the batch changes.
      effective_cost_per_base_unit_snapshot numeric(12,4) NULL,
      manual_batch_override boolean NOT NULL DEFAULT false,
      manual_batch_override_reason text NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);`);
  pgm.sql(`CREATE INDEX idx_sale_lines_batch ON sale_lines(batch_id);`);

  pgm.sql(`
    CREATE TABLE sale_tenders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      tender_type tender_type NOT NULL,
      amount numeric(12,2) NOT NULL,
      reference_number text NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_sale_tenders_sale ON sale_tenders(sale_id);`);

  // Section 6A.3: prompted, never blocking. One capture per bill covers
  // every H/H1 line on it — the register (Section 10A.3) is a view over
  // this plus the sale, never a separate manual entry.
  pgm.sql(`
    CREATE TABLE sale_prescriber_details (
      sale_id uuid PRIMARY KEY REFERENCES sales(id) ON DELETE CASCADE,
      prescriber_name text NULL,
      prescriber_registration_number text NULL,
      patient_name text NULL,
      patient_contact text NULL,
      rx_image_note text NULL -- placeholder until object storage exists (Section 12B.1); no file upload yet
    );
  `);

  pgm.sql(`
    CREATE TABLE credit_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_note_number text NOT NULL,
      original_sale_id uuid NOT NULL REFERENCES sales(id),
      reason text NOT NULL,
      total_refund_value numeric(12,2) NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      source movement_source NOT NULL DEFAULT 'app',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_credit_notes_number ON credit_notes(credit_note_number);`);

  pgm.sql(`
    CREATE TABLE credit_note_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_note_id uuid NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
      sale_line_id uuid NOT NULL REFERENCES sale_lines(id),
      quantity_returned int NOT NULL CHECK (quantity_returned > 0),
      refund_value numeric(12,2) NOT NULL,
      condition text NOT NULL CHECK (condition IN ('good', 'damaged')),
      destination_bin_id uuid NOT NULL REFERENCES bins(id)
    );
  `);

  // Hold/recall + draft-quotation parking slot (Section 6A.4) — never
  // touches stock or a bill number; just the client's in-progress bill
  // state, saved so it can be recalled from a fresh page load.
  pgm.sql(`
    CREATE TABLE held_bills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label text NOT NULL,
      payload jsonb NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Section 6A.5 / Section 8: end-of-day cash reconciliation for the
  // counter, same shape as the rider COD reconciliation later.
  pgm.sql(`
    CREATE TABLE day_close (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  pgm.sql(`CREATE UNIQUE INDEX idx_day_close_business_date ON day_close(business_date);`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('bill_number_prefix', '"DPS"'::jsonb, 'Prefix for counter/delivery bill numbers (Section 6A.6). Placeholder — owner-editable once the settings screen exists (M13).'),
      ('credit_note_prefix', '"CN"'::jsonb, 'Prefix for sale-return credit notes (Section 6A.7).'),
      ('separate_bill_series_by_channel', 'false'::jsonb, 'Whether counter and delivery bills use separate numbering series (Section 6A.8) or one shared series.'),
      ('below_cost_discount_warn_only', 'true'::jsonb, 'A discount taking a line below zero margin warns but never blocks the sale (Section 6A.9).');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN ('bill_number_prefix', 'credit_note_prefix', 'separate_bill_series_by_channel', 'below_cost_discount_warn_only');`);
  pgm.sql(`DROP TABLE IF EXISTS day_close;`);
  pgm.sql(`DROP TABLE IF EXISTS held_bills;`);
  pgm.sql(`DROP TABLE IF EXISTS credit_note_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS credit_notes;`);
  pgm.sql(`DROP TABLE IF EXISTS sale_prescriber_details;`);
  pgm.sql(`DROP TABLE IF EXISTS sale_tenders;`);
  pgm.sql(`DROP TABLE IF EXISTS sale_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS sales;`);
  pgm.sql(`DROP TYPE IF EXISTS tender_type;`);
  pgm.sql(`DROP TYPE IF EXISTS sale_status;`);
  pgm.sql(`DROP TYPE IF EXISTS sale_channel;`);
  pgm.sql(`DROP TABLE IF EXISTS customers;`);
  pgm.sql(`DROP TABLE IF EXISTS bill_number_counters;`);
};
