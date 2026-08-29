/**
 * Owner-requested, found by checking a real vendor GST invoice
 * (Medicine House -> Dipasha Medical Store) against what Purchase Entry
 * actually captures. Three real gaps that bill exposed:
 *
 *  1. No vendor bank account details anywhere (the bill's own HDFC
 *     A/C + IFSC block, needed to actually pay the vendor).
 *  2. No bill time (only date) — minor, but the bill has one.
 *  3. The bill's own "CR/DR NOTE" line has nowhere to land — no way in
 *     this system to record returning goods to a vendor or a
 *     vendor-issued debit note at all. `purchase_return` has sat in the
 *     movement_type enum unused since M1's original migration,
 *     anticipating exactly this.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["debit_note_prefix", "DN", "Section 6A.7's credit-note numbering pattern, mirrored for the vendor side: gapless, sequential, via the same reserveNumber() bill-numbering utility."],
];

exports.up = (pgm) => {
  // --- 1. Vendor bank account (for actually paying the vendor) ---
  pgm.sql(`ALTER TABLE vendors ADD COLUMN bank_name text NULL;`);
  pgm.sql(`ALTER TABLE vendors ADD COLUMN bank_account_number text NULL;`);
  pgm.sql(`ALTER TABLE vendors ADD COLUMN bank_ifsc text NULL;`);

  // --- 2. Bill time. Free text (e.g. "12:35 pm"), not a `time` column —
  // this is a display/reference field off the printed slip, never used
  // in business logic, so encoding it as a real time type would only
  // add format/timezone questions with no actual benefit.
  pgm.sql(`ALTER TABLE purchase_invoices ADD COLUMN invoice_time text NULL;`);

  // --- 3. Vendor debit notes (return-to-vendor). Always tied to real
  // stock leaving a real bin, via a new 'purchase_return' movement_ledger
  // row — the same "physical reality, not just a financial adjustment"
  // discipline write-offs and sale returns already follow. A row here
  // always traces back to the exact purchase invoice line it originated
  // from, so "how much of what I bought did I end up sending back" is a
  // real, direct join, not an inference.
  //
  // Scope: goods physically returned to the vendor (damaged, expired,
  // wrong item, short supply) — not a pure financial-only price
  // correction with no stock movement, which is a different, separate
  // concept this pass didn't build (see DECISIONS.md).
  pgm.sql(`
    CREATE TABLE vendor_debit_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      debit_note_number text NOT NULL,
      vendor_id uuid NOT NULL REFERENCES vendors(id),
      purchase_invoice_id uuid NOT NULL REFERENCES purchase_invoices(id),
      reason_code text NOT NULL CHECK (reason_code IN ('damaged', 'expired', 'wrong_item', 'short_supply', 'other')),
      note text NOT NULL,
      taxable_value numeric(12,2) NOT NULL,
      cgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      sgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      igst_amount numeric(12,2) NOT NULL DEFAULT 0,
      total_value numeric(12,2) NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (vendor_id, debit_note_number)
    );
  `);
  pgm.sql(`CREATE INDEX idx_vendor_debit_notes_invoice ON vendor_debit_notes(purchase_invoice_id);`);

  pgm.sql(`
    CREATE TABLE vendor_debit_note_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_debit_note_id uuid NOT NULL REFERENCES vendor_debit_notes(id) ON DELETE CASCADE,
      purchase_invoice_line_id uuid NOT NULL REFERENCES purchase_invoice_lines(id),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      bin_id uuid NOT NULL REFERENCES bins(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      rate_before_discount numeric(12,4) NOT NULL,
      taxable_value numeric(12,2) NOT NULL,
      gst_rate numeric(5,2) NOT NULL,
      cgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      sgst_amount numeric(12,2) NOT NULL DEFAULT 0,
      igst_amount numeric(12,2) NOT NULL DEFAULT 0,
      line_total numeric(12,2) NOT NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_vendor_debit_note_lines_note ON vendor_debit_note_lines(vendor_debit_note_id);`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS vendor_debit_note_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS vendor_debit_notes;`);
  pgm.sql(`ALTER TABLE purchase_invoices DROP COLUMN IF EXISTS invoice_time;`);
  pgm.sql(`ALTER TABLE vendors DROP COLUMN IF EXISTS bank_ifsc;`);
  pgm.sql(`ALTER TABLE vendors DROP COLUMN IF EXISTS bank_account_number;`);
  pgm.sql(`ALTER TABLE vendors DROP COLUMN IF EXISTS bank_name;`);
};
