/**
 * M13.3: Section 10.2 "Inventory" — full stock view with filters, stock
 * edits (quantity/batch/expiry/MRP) that always write an audit row rather
 * than an in-place overwrite, move-stock-between-bins, block/unblock a
 * batch, and bulk CSV operations with a mandatory preview-and-confirm
 * diff.
 *
 * Quantity corrections reuse movement_ledger's existing 'adjustment'
 * movement type (same as cycle-count variance approval) — no schema
 * change needed there. Move-stock-between-bins reuses putaway_tasks
 * as-is (reference_type = 'bin_transfer', no new column — that table's
 * reference_type was already free text, not an enum). Block/unblock
 * reuses batches.blocked / blocked_reason, already added in M0/M1 and
 * already respected by FEFO allocation — this milestone just exposes a
 * generic toggle for it beyond the expiry-audit-specific path that set
 * it before.
 *
 * batch_corrections is new: batch_no/expiry_date/mrp aren't stock
 * movements (no quantity_delta to log), so they can't go through
 * movement_ledger's CHECK (quantity_delta <> 0) — this is a dedicated,
 * append-only audit trail for the one thing on a batch record that
 * genuinely isn't a movement.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE batch_corrections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES batches(id),
      field text NOT NULL CHECK (field IN ('batch_no', 'expiry_date', 'mrp')),
      old_value text NOT NULL,
      new_value text NOT NULL,
      reason_code text NOT NULL CHECK (reason_code IN
        ('physical_recount', 'data_entry_correction', 'damage_pending_writeoff', 'system_error', 'other')),
      note text NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_batch_corrections_batch ON batch_corrections(batch_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS batch_corrections;`);
};
