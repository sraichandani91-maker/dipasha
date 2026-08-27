/**
 * M13.7: Section 10.2 "Inbound/GRN" — full list/detail for purchase
 * invoices and stock-received entries (currently create-only, no read
 * path at all beyond the DB itself), a scanned invoice document attached
 * to a purchase invoice record, a correction audit trail for invoice
 * header data-entry mistakes, and the receiving-count variance step
 * flagged as a gap back in M3 (DECISIONS.md: "Section 6.6 mentions
 * invoice-versus-received variance is logged... there's no separate
 * physical-count-at-receipt step distinct from data entry yet").
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // A scanned/photographed copy of the physical invoice attached to an
  // already-created purchase_invoices record — audit evidence, same
  // character as Section 6.3's AI-scan pages, but for the ordinary manual
  // entry path where nothing was ever photographed at capture time.
  pgm.sql(`
    CREATE TABLE purchase_invoice_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_invoice_id uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      file_path text NOT NULL,
      mime_type text NOT NULL,
      uploaded_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_purchase_invoice_documents_invoice ON purchase_invoice_documents(purchase_invoice_id);`);

  // Deliberately narrow: header/identification fields only (invoice
  // number, invoice date, vendor, payment terms) — never quantity, rate,
  // or GST fields, which already feed posted movement_ledger rows and
  // batch cost data. See DECISIONS.md for why that line is drawn here.
  pgm.sql(`
    CREATE TABLE purchase_invoice_corrections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_invoice_id uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      field text NOT NULL CHECK (field IN ('invoice_number', 'invoice_date', 'vendor_id', 'payment_terms_days')),
      old_value text NOT NULL,
      new_value text NOT NULL,
      reason_code text NOT NULL CHECK (reason_code IN ('data_entry_correction', 'wrong_vendor_selected', 'wrong_invoice_number', 'other')),
      note text NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_purchase_invoice_corrections_invoice ON purchase_invoice_corrections(purchase_invoice_id);`);

  // The receiving-count variance step. expected_quantity_base_units is
  // what was entered on the purchase_invoice/stock_received record;
  // actual_quantity_base_units is what put-away staff physically counted
  // while moving it out of staging. Only ever written when the two
  // differ — a matching count leaves no row at all.
  pgm.sql(`
    CREATE TABLE putaway_variances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      putaway_task_id uuid NOT NULL REFERENCES putaway_tasks(id),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      reference_type text NOT NULL,
      reference_id uuid NOT NULL,
      expected_quantity_base_units int NOT NULL,
      actual_quantity_base_units int NOT NULL,
      variance_base_units int NOT NULL,
      reason_code text NOT NULL CHECK (reason_code IN ('short_received', 'excess_received', 'damaged_in_transit', 'miscount_at_entry', 'other')),
      note text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      reported_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_by uuid NULL REFERENCES users(id),
      resolution_note text NULL,
      resolved_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_putaway_variances_status ON putaway_variances(status);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS putaway_variances;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_invoice_corrections;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_invoice_documents;`);
};
