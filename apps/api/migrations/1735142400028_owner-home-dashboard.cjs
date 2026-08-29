/**
 * Owner-requested "Home" dashboard (a competitor pharmacy-retail app
 * screenshot, asked to be recreated on the web console, Owner-only —
 * not the staff console). No new tables needed; every widget reads
 * existing data. The one gap this surfaced: no WhatsApp trigger existed
 * for reminding a customer about an outstanding balance (only chronic
 * refills had a "remind now" button) — this migration just seeds that
 * trigger's enabled-setting, matching every other trigger's own
 * `..._enabled` row.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES (
      'whatsapp_trigger_payment_due_reminder_enabled',
      'true'::jsonb,
      'Owner Home dashboard: allow the manual "remind now" action on a customer due-payment row to actually send a WhatsApp reminder.'
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key = 'whatsapp_trigger_payment_due_reminder_enabled';`);
};
