/**
 * M13.11: Section 12A.4/12A.5 — the WhatsApp inbound webhook and shared
 * inbox, and automatic STOP-reply handling. Explicitly deferred to here
 * since M8 (Section 7A.5's order_messages comment, Section 12A.5's
 * updateWhatsAppConsent comment): "no inbound channel yet... that's
 * M13's shared inbox."
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["whatsapp_webhook_verify_token", "change-me-verify-token", "Shared secret Meta's webhook subscription handshake (GET /whatsapp/inbound) must present back — owner-editable once a real WhatsApp Business API app exists to configure with this value."],
  ["whatsapp_trigger_inbox_reply_enabled", true, "Whether staff can send a free-text reply from the shared inbox over WhatsApp (Section 12A.4) — same per-trigger toggle convention as every other WhatsApp trigger."],
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE whatsapp_inbound_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      from_phone text NOT NULL,
      body text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      matched_customer_id uuid NULL REFERENCES customers(id),
      matched_order_id uuid NULL REFERENCES orders(id),
      is_stop_keyword boolean NOT NULL DEFAULT false,
      handled boolean NOT NULL DEFAULT false,
      handled_by uuid NULL REFERENCES users(id),
      handled_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_whatsapp_inbound_messages_handled ON whatsapp_inbound_messages(handled);`);
  pgm.sql(`CREATE INDEX idx_whatsapp_inbound_messages_customer ON whatsapp_inbound_messages(matched_customer_id);`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS whatsapp_inbound_messages;`);
};
