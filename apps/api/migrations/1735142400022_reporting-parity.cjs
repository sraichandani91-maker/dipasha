/**
 * M13.10: Section 10.2 "Reporting/query layer" — a read-only SQL console
 * (Owner only), a prebuilt operational dashboard (computed live, no new
 * table needed for that half), and a daily auto-report snapshotted once
 * per business day and sent to the Owner over the existing WhatsApp
 * dispatcher (Section 12A) — a new trigger type on infrastructure M8
 * already built, not a second notification mechanism.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["daily_report_enabled", true, "Whether the automatic end-of-day report is generated at all (Section 10.2). Viewable in-app regardless of the WhatsApp trigger below."],
  ["daily_report_time_local", "21:00", "Shop-local (IST) time of day the daily report is generated, once that business date's data is done for the day."],
  ["whatsapp_template_daily_report", null, "Meta-approved template name for the daily-report message, once one exists. Null until the owner has one — the dev sender ignores this and sends plain text."],
  ["whatsapp_trigger_daily_report_enabled", true, "Section 12A.2-style trigger toggle: whether the daily report is also sent to the Owner over WhatsApp (the in-app copy is unaffected either way)."],
];

exports.up = (pgm) => {
  // Snapshotted at generation time, same reasoning as every other
  // point-in-time record in this build (cycle count's system_quantity,
  // batch_corrections' old_value) — a report about a closed business day
  // shouldn't silently reflect data written after the fact.
  pgm.sql(`
    CREATE TABLE daily_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_date date NOT NULL UNIQUE,
      generated_at timestamptz NOT NULL DEFAULT now(),
      summary jsonb NOT NULL
    );
  `);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS daily_reports;`);
};
