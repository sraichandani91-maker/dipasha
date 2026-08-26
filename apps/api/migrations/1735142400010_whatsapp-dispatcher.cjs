/**
 * M8: WhatsApp integration (Section 12A) — "build it as a notification
 * service with pluggable templates, not calls scattered through the
 * code — every message goes through one dispatcher." This migration is
 * that dispatcher's storage: one `notification_log` table that is both
 * the outbound queue (status='pending' rows) and the permanent send log
 * Section 12A.5 asks for ("recipient, template, timestamp, status,
 * cost, error — queryable from the SQL console"), plus per-customer
 * WhatsApp consent (Section 12A.5's opt-out requirement).
 *
 * Supersedes the ad-hoc `sales.whatsapp_send_count` /
 * `whatsapp_last_sent_at` columns added just before this milestone —
 * that was a reasonable single-purpose counter for one owner-requested
 * button, but a real dispatcher makes a per-table counter redundant
 * (send history for any sale is just `notification_log` rows with
 * reference_type='sale'), so those two columns are dropped here rather
 * than kept as a second, driftable source of truth.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["whatsapp_trigger_bill_generated_enabled", true, "Section 12A.2: whether the bill-generated WhatsApp notification fires automatically. Each trigger is individually switchable per the brief."],
  ["whatsapp_trigger_callback_enabled", true, "Section 12A.2: whether 'requested item now in stock' fires automatically when staff reserve stock for a customer request."],
  ["whatsapp_template_bill_generated", null, "Meta-approved template name for the bill-generated message, once one exists (Section 12A.1). Null until the owner has an approved template — the dev sender ignores this and sends plain text."],
  ["whatsapp_template_callback_stock_available", null, "Meta-approved template name for the callback/stock-available message, once one exists."],
  ["whatsapp_max_send_attempts", 3, "How many delivery attempts before a queued notification is marked permanently failed and surfaces on the Failed Notifications list. No number given in the brief — a reasonable default, owner-editable later."],
];

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE sales DROP COLUMN IF EXISTS whatsapp_send_count;`);
  pgm.sql(`ALTER TABLE sales DROP COLUMN IF EXISTS whatsapp_last_sent_at;`);

  // Section 12A.5: consent per customer per category (transactional vs
  // marketing) — transactional defaults to true (a bill for a purchase
  // they made is legitimate without separate opt-in, per the brief);
  // marketing defaults to false (explicit consent required). No inbound
  // WhatsApp webhook exists yet (that's M13's shared inbox), so there is
  // no automatic STOP-reply handling yet — these are staff-set from a
  // customer's stated preference until then (see DECISIONS.md).
  pgm.sql(`ALTER TABLE customers ADD COLUMN whatsapp_transactional_opt_in boolean NOT NULL DEFAULT true;`);
  pgm.sql(`ALTER TABLE customers ADD COLUMN whatsapp_marketing_opt_in boolean NOT NULL DEFAULT false;`);
  // Section 12A.1: "do not assume [a number is on WhatsApp]... cache the
  // result." Null = never checked. No real provider exists to actually
  // perform this check yet, so it stays null until one does.
  pgm.sql(`ALTER TABLE customers ADD COLUMN whatsapp_available boolean NULL;`);
  pgm.sql(`ALTER TABLE customers ADD COLUMN whatsapp_checked_at timestamptz NULL;`);

  pgm.sql(`
    CREATE TABLE notification_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms')),
      trigger_type text NOT NULL,             -- e.g. 'bill_generated', 'callback_stock_available'
      category text NOT NULL CHECK (category IN ('transactional', 'marketing')),
      template_key text NOT NULL,             -- settings key naming the approved template to use
      recipient_customer_id uuid NULL REFERENCES customers(id),
      recipient_phone text NOT NULL,
      reference_type text NULL,               -- 'sale' | 'customer_request' | ...
      reference_id uuid NULL,
      payload jsonb NOT NULL,                 -- template variables (never the message body for a scheduled drug — Section 12A.5)
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'logged_dev_mode', 'failed', 'skipped_opted_out', 'skipped_trigger_disabled')),
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text NULL,
      provider_message_id text NULL,
      cost_inr numeric(8,2) NULL,             -- Section 12A.1: per-message cost, once a real provider reports one
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_notification_log_pending ON notification_log(next_attempt_at) WHERE status = 'pending';`);
  pgm.sql(`CREATE INDEX idx_notification_log_status ON notification_log(status);`);
  pgm.sql(`CREATE INDEX idx_notification_log_reference ON notification_log(reference_type, reference_id);`);
  pgm.sql(`CREATE INDEX idx_notification_log_customer ON notification_log(recipient_customer_id);`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS notification_log;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS whatsapp_checked_at;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS whatsapp_available;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS whatsapp_marketing_opt_in;`);
  pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS whatsapp_transactional_opt_in;`);
  pgm.sql(`ALTER TABLE sales ADD COLUMN whatsapp_send_count int NOT NULL DEFAULT 0;`);
  pgm.sql(`ALTER TABLE sales ADD COLUMN whatsapp_last_sent_at timestamptz NULL;`);
};
