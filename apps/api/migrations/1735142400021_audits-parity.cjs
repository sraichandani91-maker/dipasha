/**
 * M13.8: Section 10.2 "Audits" — schedule/assign cycle counts (the
 * cycle_count_selection_reason enum has carried a 'manual' value since
 * M6 for exactly this, unused until now — no schema change needed for
 * that half) and a cold-chain temperature log with gap/out-of-range
 * alerting (genuinely new: no temperature-tracking table has existed at
 * any point before this build).
 *
 * No per-fridge/unit model exists anywhere in this build (bins only
 * carry a `zone = 'CC'` flag, not a specific piece of equipment), so
 * this logs one shop-wide cold-chain reading stream rather than
 * inventing a multi-unit concept nothing else in the schema supports —
 * flagged in DECISIONS.md as a real open question if the shop runs more
 * than one cold-chain unit.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["cold_chain_temp_min_celsius", 2, "Lower bound of the acceptable cold-chain storage range (Section 9) — WHO/vaccine cold-chain standard, not an owner-confirmed number yet. CONFIRM against the shop's actual equipment and product labels."],
  ["cold_chain_temp_max_celsius", 8, "Upper bound of the acceptable cold-chain storage range (Section 9) — same caveat as the minimum above."],
  ["cold_chain_max_gap_hours", 8, "How long without a new reading before a gap alert fires (Section 9) — a placeholder (roughly twice-daily checks), not an owner-confirmed number."],
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE cold_chain_temperature_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      temperature_celsius numeric(4,1) NOT NULL,
      in_range boolean NOT NULL,
      note text NULL,
      recorded_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      source movement_source NOT NULL DEFAULT 'web'
    );
  `);
  pgm.sql(`CREATE INDEX idx_cold_chain_temperature_logs_recorded_at ON cold_chain_temperature_logs(recorded_at);`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS cold_chain_temperature_logs;`);
};
