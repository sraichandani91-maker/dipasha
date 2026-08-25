/**
 * Seeds the settings table with the defaults the build prompt explicitly
 * states (Section 15: every configurable number goes in settings, not
 * hardcoded — these are the doc's own stated defaults, not invented
 * values, so seeding them here is faithful execution). Each is owner-
 * editable later once the settings screen exists (M13).
 *
 * Only seeding what's relevant so far or explicitly given as a global
 * default; thresholds tied to a milestone not yet built (e.g. write-off
 * approval value, Section 9A.8) get added in that milestone's migration
 * instead of guessed now.
 */

exports.shorthands = undefined;

const SETTINGS = [
  ["session_idle_lock_minutes", 5, "Manager/Owner app session lock after N minutes idle (Section 3) — PIN re-entry, not full re-login."],
  ["web_session_idle_minutes", 15, "Web console idle timeout (Section 10.4) — shorter than the app."],
  ["cycle_count_bins_per_day", 10, "Default daily blind cycle count bin count (Section 9)."],
  ["near_expiry_pick_block_days", 30, "Batches within N days of expiry are excluded from FEFO picking (Section 9)."],
  ["expiry_reject_threshold_months", 6, "GST purchase entry rejects (warn-and-override by Manager) stock under this many months to expiry (Section 6.2)."],
  ["sale_return_window_days", 7, "Default window for accepting a sale return (Section 6A.7)."],
  ["order_batch_window_minutes", 8, "Rolling window for batching delivery orders to the same zone (Section 7)."],
  ["order_batch_max_orders", 3, "Max orders per rider batch for the pilot (Section 7)."],
  ["stock_reservation_hours", 48, "Default hold window when reserving stock for a notified customer (Section 6B.4)."],
  ["daily_request_review_time_local", "18:00", "Time the daily request-book review alarm fires (Section 6B.5)."],
  ["daily_request_review_repeat_minutes", 15, "Re-ring interval until the daily request queue is cleared (Section 6B.5)."],
  ["daily_request_review_max_snoozes", 3, "Max snoozes for the daily request review alarm (Section 6B.5)."],
  ["daily_request_review_escalation_minutes", 90, "Minutes unresolved before escalating to the Owner via WhatsApp (Section 6B.5)."],
  ["pending_order_response_target_minutes", 15, "Target response time for the Pending Orders queue ageing indicator (Section 7A.3)."],
  ["eway_bill_threshold_inr", 50000, "Invoice value above which an e-way bill may be required (Section 10B.3)."],
  ["invoice_reconciliation_tolerance_inr", 1, "Allowed rupee mismatch between computed and stated invoice net payable before requiring explicit acknowledgement (Section 6.4)."],
];

// node-pg-migrate's pgm.sql() does string interpolation of named
// placeholders, not parameterized queries — there's no bind-parameter
// path for a plain INSERT here. These values are all developer-authored
// constants above (never external input), so manual SQL-literal escaping
// is safe and sufficient.
const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
};
