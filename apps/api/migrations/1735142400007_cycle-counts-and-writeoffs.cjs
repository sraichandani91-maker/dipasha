/**
 * M6: cycle counting (Section 9), damage/write-off log (Section 9,
 * 9A.8's approval-above-threshold rule). Expiry audit and the statutory
 * reports need no new schema — they're read queries over what already
 * exists (batches.blocked/blocked_reason from M3, movement_ledger).
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  ["cycle_count_variance_manager_threshold_inr", 500, "Cycle count variance value (₹) above which a bin auto-escalates to Store Manager for review (Section 9). No default given in the brief — a reasonable starting point, owner-editable."],
  ["cycle_count_variance_owner_threshold_inr", 2000, "Cycle count variance value (₹) above which a bin auto-escalates to Owner (Section 9). Same caveat as above."],
  ["cycle_count_movement_lookback_days", 30, "Trailing window used by the 'highest movement' bin-selection strategy for daily cycle counts (Section 9)."],
  ["writeoff_approval_threshold_inr", 1000, "Damage/write-off value (₹) above which Owner approval is required before the stock is actually removed (Section 9, 9A.8). No default given in the brief."],
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE cycle_count_selection_reason AS ENUM ('highest_value', 'highest_movement', 'longest_since_counted', 'flagged_variance_history', 'manual');
  `);
  pgm.sql(`CREATE TYPE cycle_count_task_status AS ENUM ('pending', 'counted', 'reviewed');`);
  pgm.sql(`CREATE TYPE cycle_count_review_outcome AS ENUM ('approved', 'rejected');`);

  // One row per bin selected for a given day's count (Section 9: "daily
  // blind count of N bins"). `escalated_to` is computed once every line
  // in the task is counted — see repo/cycle-counts.ts.
  pgm.sql(`
    CREATE TABLE cycle_count_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bin_id uuid NOT NULL REFERENCES bins(id),
      business_date date NOT NULL,
      selection_reason cycle_count_selection_reason NOT NULL,
      status cycle_count_task_status NOT NULL DEFAULT 'pending',
      assigned_to uuid NULL REFERENCES users(id),
      counted_by uuid NULL REFERENCES users(id),
      counted_at timestamptz NULL,
      total_variance_value numeric(12,2) NULL,
      escalated_to text NULL CHECK (escalated_to IS NULL OR escalated_to IN ('manager', 'owner')),
      reviewed_by uuid NULL REFERENCES users(id),
      reviewed_at timestamptz NULL,
      review_outcome cycle_count_review_outcome NULL,
      review_note text NULL,
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_cycle_count_tasks_date ON cycle_count_tasks(business_date);`);
  pgm.sql(`CREATE INDEX idx_cycle_count_tasks_bin ON cycle_count_tasks(bin_id);`);
  pgm.sql(`CREATE INDEX idx_cycle_count_tasks_status ON cycle_count_tasks(status);`);

  // system_quantity_base_units is captured at task-generation time but
  // deliberately never sent to the counting client until after counted_
  // quantity is submitted — "blind means blind" (Section 9). An "extra"
  // find with nothing expected in the system uses system_quantity 0.
  pgm.sql(`
    CREATE TABLE cycle_count_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_count_task_id uuid NOT NULL REFERENCES cycle_count_tasks(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      system_quantity_base_units int NOT NULL,
      counted_quantity_base_units int NULL,
      variance_base_units int NULL,
      variance_value numeric(12,2) NULL,
      is_unexpected_find boolean NOT NULL DEFAULT false,
      note text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_cycle_count_lines_task ON cycle_count_lines(cycle_count_task_id);`);

  // Damage/write-off (Section 9, 9A.8): photo evidence + owner approval
  // above a value threshold. No stock moves until approved — the ledger
  // row (movement_type = 'write_off') is written only on approval, so a
  // rejected write-off leaves stock untouched, same "no in-place edits"
  // rule as everywhere else.
  pgm.sql(`
    CREATE TABLE write_offs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id),
      batch_id uuid NOT NULL REFERENCES batches(id),
      bin_id uuid NOT NULL REFERENCES bins(id),
      quantity_base_units int NOT NULL CHECK (quantity_base_units > 0),
      reason_code text NOT NULL,
      note text NOT NULL,
      photo_path text NULL,
      estimated_value numeric(12,2) NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      requires_approval boolean NOT NULL,
      requested_by uuid NOT NULL REFERENCES users(id),
      approved_by uuid NULL REFERENCES users(id),
      approved_at timestamptz NULL,
      rejection_reason text NULL,
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_write_offs_status ON write_offs(status);`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS write_offs;`);
  pgm.sql(`DROP TABLE IF EXISTS cycle_count_lines;`);
  pgm.sql(`DROP TABLE IF EXISTS cycle_count_tasks;`);
  pgm.sql(`DROP TYPE IF EXISTS cycle_count_review_outcome;`);
  pgm.sql(`DROP TYPE IF EXISTS cycle_count_task_status;`);
  pgm.sql(`DROP TYPE IF EXISTS cycle_count_selection_reason;`);
};
