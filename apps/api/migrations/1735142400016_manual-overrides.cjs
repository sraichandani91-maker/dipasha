/**
 * M13.2: Section 10.1's manual-override rule, extended to the four
 * scan-backed actions that didn't already have it. Put-away confirmation
 * (M3) already does this unconditionally — see its own comment in
 * repo/putaway.ts — because there's still no separate scanning client in
 * this build; the same reasoning now applies here to pick confirmation,
 * packing verification, rider handover, and cycle count entry.
 *
 * Put-away and cycle-count-approval already write a real movement_ledger
 * row at the moment stock changes, so those get `source = 'web_manual'`
 * directly on that row (cycle-count-approval as of this migration too —
 * see cycle_count_tasks' new columns). Pick confirmation and rider
 * handover have no ledger row of their own to tag (no stock moves at
 * either point), so they get a row in this new table instead. Packing
 * verification does eventually move stock (via the pack-time sale), so
 * its ledger rows get tagged `web_manual` directly *and* get a row here
 * for the human-readable reason/note — the same duplication put-away
 * doesn't need only because put-away's ledger row already carries a
 * `note` column of its own that a sale-driven ledger row doesn't.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE web_manual_overrides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      action text NOT NULL CHECK (action IN ('pick', 'pack', 'cycle_count', 'rider_handover')),
      reference_type text NOT NULL,
      reference_id uuid NOT NULL,
      reason_code text NOT NULL CHECK (reason_code IN ('scanner_unavailable', 'remote_correction', 'device_failure', 'training')),
      note text NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_web_manual_overrides_created ON web_manual_overrides(created_at DESC);`);
  pgm.sql(`CREATE INDEX idx_web_manual_overrides_reference ON web_manual_overrides(reference_type, reference_id);`);

  // Cycle count entry (Section 10.1's fifth listed action) captures its
  // reason at submitCount time, but the actual ledger row only gets
  // written later, at review/approval — these columns carry the reason
  // across that gap so reviewTask can tag the eventual adjustment row.
  pgm.sql(`
    ALTER TABLE cycle_count_tasks
      ADD COLUMN count_reason_code text NULL CHECK (count_reason_code IS NULL OR count_reason_code IN
        ('scanner_unavailable', 'remote_correction', 'device_failure', 'training')),
      ADD COLUMN count_note text NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE cycle_count_tasks DROP COLUMN IF EXISTS count_reason_code, DROP COLUMN IF EXISTS count_note;`);
  pgm.sql(`DROP TABLE IF EXISTS web_manual_overrides;`);
};
