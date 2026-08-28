/**
 * M15: Section 10B — the accounting layer, distributor-ordering
 * tracking, and the e-way bill/e-invoicing stub. Section 10B.1 is
 * explicit about scope: "build the books-quality data layer, not a
 * replacement for Tally" — no journal vouchers, no trial balance, no
 * balance sheet. What's here is the vendor-side mirror of M7's customer
 * ledger, a plain expense log, PO tracking widened onto M5's existing
 * purchase_orders, and stub storage for e-way bill / e-invoicing fields.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

// `eway_bill_threshold_inr` already exists (seeded at M1, Section 10B.3
// anticipated that far back) — reused as-is below, not duplicated. Adding
// a second, differently-named threshold here would recreate exactly the
// kind of seeded-twice mess M13.9's Settings screen flagged and left for
// a real cleanup pass; this one's easy to just not repeat.
const SETTINGS = [
  ["po_chase_window_days", 3, "Section 10B.2: a sent PO with no acknowledgement past this many days appears on the chase list."],
  ["whatsapp_trigger_po_sent_enabled", true, "Section 12A.2-style trigger toggle for the one-tap 'send PO over WhatsApp' action (Section 10B.2)."],
  ["whatsapp_template_po_sent", null, "Meta-approved template name for the PO-sent message, once one exists. Null until the owner has one — the dev sender ignores this and sends plain text."],
  ["financial_daily_digest_enabled", false, "Section 10B.4: Owner-opt-in WhatsApp digest of the day's four headline figures (sales, purchases, gross profit, gross margin) — off by default, distinct from M13.10's operational daily report."],
  ["financial_daily_digest_time_local", "21:30", "Shop-local (IST) time of day the financial daily digest is sent, once enabled."],
  ["financial_daily_digest_last_sent_date", null, "Internal bookkeeping, not a real threshold — the last business date the financial digest was actually sent for, so the poller sends at most once per day. Not meant to be hand-edited."],
  ["whatsapp_template_financial_daily_digest", null, "Meta-approved template name for the financial digest message, once one exists. Null until the owner has one — the dev sender ignores this and sends plain text."],
];

exports.up = (pgm) => {
  // --- PO send-and-track (10B.2) needs somewhere to actually send a PO
  // to — vendors carried neither a phone nor an email until now.
  pgm.sql(`ALTER TABLE vendors ADD COLUMN phone text NULL;`);
  pgm.sql(`ALTER TABLE vendors ADD COLUMN email text NULL;`);

  // --- Vendor ledger (10B.1) — the mirror of M7's customer_payments /
  // customer_payment_allocations, same "written once at record time,
  // never recomputed lazily" reasoning.
  pgm.sql(`
    CREATE TABLE vendor_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_id uuid NOT NULL REFERENCES vendors(id),
      amount numeric(12,2) NOT NULL CHECK (amount > 0),
      payment_method text NOT NULL CHECK (payment_method IN ('cash', 'upi', 'card', 'cheque', 'bank_transfer')),
      reference_number text NULL,
      note text NULL,
      paid_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`
    CREATE TABLE vendor_payment_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_payment_id uuid NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
      purchase_invoice_id uuid NOT NULL REFERENCES purchase_invoices(id),
      amount_allocated numeric(12,2) NOT NULL CHECK (amount_allocated > 0)
    );
  `);
  pgm.sql(`CREATE INDEX idx_vendor_payment_allocations_invoice ON vendor_payment_allocations(purchase_invoice_id);`);
  pgm.sql(`CREATE INDEX idx_vendor_payment_allocations_payment ON vendor_payment_allocations(vendor_payment_id);`);

  // --- Expenses (10B.1): "simple head-and-amount entry, dated, with
  // optional bill photo." Reuses the same local-disk upload storage
  // pattern as invoice scans / write-off photos (M6/M9) — a text path,
  // not a blob column.
  pgm.sql(`
    CREATE TABLE expense_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      category text NOT NULL CHECK (category IN ('rent', 'salaries', 'electricity', 'transport', 'packaging', 'delivery_fuel', 'software', 'other')),
      amount numeric(12,2) NOT NULL CHECK (amount > 0),
      expense_date date NOT NULL DEFAULT CURRENT_DATE,
      note text NULL,
      bill_photo_path text NULL,
      payment_method text NOT NULL CHECK (payment_method IN ('cash', 'upi', 'card', 'cheque', 'bank_transfer')),
      paid_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_expense_entries_date ON expense_entries(expense_date);`);

  // --- PO tracking (10B.2): widen M5's purchase_orders rather than
  // replace it — 'received' (M5's original terminal state) is kept as a
  // synonym for "fully received" so no backfill is needed on existing
  // rows; the new states slot in ahead of it in the lifecycle.
  pgm.sql(`ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;`);
  pgm.sql(`ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
    CHECK (status IN ('open', 'sent', 'acknowledged', 'partially_received', 'received', 'cancelled'));`);
  pgm.sql(`ALTER TABLE purchase_orders ADD COLUMN sent_at timestamptz NULL;`);
  pgm.sql(`ALTER TABLE purchase_orders ADD COLUMN sent_via text NULL CHECK (sent_via IN ('whatsapp', 'email'));`);
  pgm.sql(`ALTER TABLE purchase_orders ADD COLUMN acknowledged_at timestamptz NULL;`);

  // Cumulative received quantity per line, updated when a purchase
  // invoice is matched against this PO — "ordered versus received
  // versus billed, line by line" (10B.2). Billed is the invoice line
  // itself; ordered is quantity_base_units already on this table;
  // received is this new column.
  pgm.sql(`ALTER TABLE purchase_order_lines ADD COLUMN quantity_received_base_units int NOT NULL DEFAULT 0;`);

  // Note: `purchase_invoices.purchase_order_id` already exists (added in
  // M7 for the vendor scorecard's lead-time/fill-rate link) — reused
  // here as-is for "goods-in matched against PO", not re-added.

  // --- E-way bill / e-invoicing stub (10B.3). One table covers both a
  // sale and a purchase invoice crossing the threshold (either direction
  // can trigger an e-way bill), distinguished by reference_type.
  pgm.sql(`
    CREATE TABLE eway_bills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reference_type text NOT NULL CHECK (reference_type IN ('sale', 'purchase_invoice')),
      reference_id uuid NOT NULL,
      transporter_name text NULL,
      transporter_gstin text NULL,
      vehicle_number text NULL,
      distance_km numeric(6,1) NULL,
      -- The portal's accepted upload format, generated on request and
      -- stored for reference — never actually submitted anywhere
      -- (Section 10B.3: "stub with a clean interface... avoids a GSP
      -- integration you almost certainly do not need").
      generated_json jsonb NULL,
      eway_bill_number text NULL,
      valid_until timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NOT NULL REFERENCES users(id)
    );
  `);
  pgm.sql(`CREATE INDEX idx_eway_bills_reference ON eway_bills(reference_type, reference_id);`);

  // E-invoicing stub: "structure the invoice data so an IRN and QR code
  // can be added later without reworking the schema — costs nothing now,
  // saves a rebuild later." Storage only; nothing generates these yet.
  pgm.sql(`ALTER TABLE sales ADD COLUMN irn text NULL;`);
  pgm.sql(`ALTER TABLE sales ADD COLUMN irn_qr_code_data text NULL;`);

  // A real gap the cash book (10B.1) would otherwise paper over: a sale
  // return's `total_refund_value` (M4) never recorded which instrument
  // the refund actually went out through, so "net cash that should be in
  // the drawer" (10B.4) could never account for a cash refund reducing
  // it. Nullable — a return recorded before this milestone existed
  // stays unclassified rather than being guessed at.
  pgm.sql(`ALTER TABLE credit_notes ADD COLUMN refund_payment_method text NULL CHECK (refund_payment_method IN ('cash', 'upi', 'card', 'cheque', 'bank_transfer'));`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`ALTER TABLE vendors DROP COLUMN IF EXISTS email;`);
  pgm.sql(`ALTER TABLE vendors DROP COLUMN IF EXISTS phone;`);
  pgm.sql(`ALTER TABLE credit_notes DROP COLUMN IF EXISTS refund_payment_method;`);
  pgm.sql(`ALTER TABLE sales DROP COLUMN IF EXISTS irn_qr_code_data;`);
  pgm.sql(`ALTER TABLE sales DROP COLUMN IF EXISTS irn;`);
  pgm.sql(`DROP TABLE IF EXISTS eway_bills;`);
  pgm.sql(`ALTER TABLE purchase_order_lines DROP COLUMN IF EXISTS quantity_received_base_units;`);
  pgm.sql(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS acknowledged_at;`);
  pgm.sql(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS sent_via;`);
  pgm.sql(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS sent_at;`);
  pgm.sql(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;`);
  pgm.sql(`ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK (status IN ('open', 'received', 'cancelled'));`);
  pgm.sql(`DROP TABLE IF EXISTS expense_entries;`);
  pgm.sql(`DROP TABLE IF EXISTS vendor_payment_allocations;`);
  pgm.sql(`DROP TABLE IF EXISTS vendor_payments;`);
};
