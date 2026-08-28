/**
 * M14: Section 9A.3 "Chronic patients and refill management" — the
 * tracked entity is a (customer, product) pairing, not a bare product
 * flag: every capability the spec lists (expected exhaustion date,
 * refill-due list, churn signal, WhatsApp reminder, patient profile,
 * standing order) needs a specific customer's dosing and purchase
 * history, which only exists at that granularity. "Flag a SKU... as
 * chronic" (the spec's other wording) is this same action — picking the
 * product when creating the pairing — not a second, product-only flag;
 * see DECISIONS.md.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["refill_due_within_days", 7, "Section 9A.3: a chronic refill is shown on the due-soon list starting this many days before its expected exhaustion date."],
  ["chronic_overdue_churn_days", 7, "Section 9A.3: 'overdue by more than a few days is a churn signal' — how many days past the expected exhaustion date before a refill is flagged as a possible churn, not just late."],
  ["refill_reminder_days_before", 3, "Section 9A.3/12A.2: how many days before the expected exhaustion date the WhatsApp refill reminder is sent."],
  ["whatsapp_trigger_refill_reminder_enabled", true, "Section 12A.2-style trigger toggle for the chronic-refill WhatsApp reminder."],
  ["whatsapp_template_refill_reminder", null, "Meta-approved template name for the refill-reminder message, once one exists. Null until the owner has one — the dev sender ignores this and sends plain text."],
];

exports.up = (pgm) => {
  // The standing-order auto-request (below) is written by a background
  // poller, not a staff member at a device — none of the three existing
  // movement_source values honestly describe that, so a fourth is added
  // rather than mislabeling it as 'web'. Not usable until this
  // transaction commits (Postgres enum-value rule since PG12), which is
  // fine — nothing in this same migration reads it back.
  pgm.sql(`ALTER TYPE movement_source ADD VALUE IF NOT EXISTS 'automated';`);

  pgm.sql(`
    CREATE TABLE chronic_medications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id),
      product_id uuid NOT NULL REFERENCES products(id),
      prescriber_id uuid NULL REFERENCES prescribers(id),
      -- "30 tablets at one daily is 30 days" — a dose the system has no
      -- other source for (nothing else in this schema captures dosage),
      -- so it's entered once here and reused every cycle. Numeric, not
      -- int, since half-tablet doses are common.
      daily_dose_base_units numeric(6,2) NOT NULL CHECK (daily_dose_base_units > 0),
      last_purchase_date date NULL,
      last_purchase_quantity_base_units int NULL,
      -- Recomputed by repo/chronic.ts whenever last_purchase_* changes,
      -- and stored (not computed on read) so the refill-due list and the
      -- reminder poller can both index/filter on a plain date column.
      expected_exhaustion_date date NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
      standing_order_enabled boolean NOT NULL DEFAULT false,
      -- Sending exactly once per cycle: set to expected_exhaustion_date
      -- right after a reminder/standing-order fires for it; a fresh
      -- purchase changes expected_exhaustion_date, which naturally
      -- un-silences the next cycle without a separate "reset" step.
      reminder_sent_for_exhaustion_date date NULL,
      -- Distinct from the field above: a human tapping "mark notified"
      -- after actually calling the patient (Section 6B.3's request-book
      -- callback queue uses the same one-tap pattern), not the
      -- automated WhatsApp send.
      manually_notified_at timestamptz NULL,
      note text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NOT NULL REFERENCES users(id),
      UNIQUE (customer_id, product_id)
    );
  `);
  pgm.sql(`CREATE INDEX idx_chronic_medications_customer ON chronic_medications(customer_id);`);
  pgm.sql(`CREATE INDEX idx_chronic_medications_exhaustion ON chronic_medications(expected_exhaustion_date) WHERE status = 'active';`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS chronic_medications;`);
  // Postgres has no ALTER TYPE ... DROP VALUE — the 'automated' label
  // stays on movement_source even on rollback, same accepted limitation
  // as every other enum value this build has ever added.
};
