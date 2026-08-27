/**
 * M12: offline mode and sync ledger, POS offline first (Section 11 /
 * Section 6A.9). "Sync ledger" here means: the append-only
 * `movement_ledger` M1 already built is what makes offline sync safe in
 * the first place (every stock change is an immutable row, on-hand qty
 * a derived sum) — nothing new is needed there. What IS new is the
 * machinery an offline device needs before it can safely create a real
 * sale later: a pre-reserved block of bill numbers (Section 6A.9:
 * "reserved in blocks per device to prevent collisions on sync"), an
 * idempotency key so a retried sync can never double-create a sale, and
 * a durable, server-visible place for a sync conflict to land (Section
 * 6A.9/11: "any conflict escalated to the Owner rather than silently
 * resolved" — the offline device's own local storage is not durable or
 * visible enough for that on its own).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Traceability only — the counter itself already lives in
  // bill_number_counters (M4); this just records which device asked
  // for which range and when, so a gap in the sequence (an abandoned
  // block a device never fully used — an accepted, bounded tradeoff of
  // reserving numbers before they're needed offline) has a documented
  // explanation rather than looking like an unexplained audit problem.
  pgm.sql(`
    CREATE TABLE bill_number_blocks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id text NOT NULL,
      prefix text NOT NULL,
      range_start int NOT NULL,
      range_end int NOT NULL,
      issued_by uuid NOT NULL REFERENCES users(id),
      issued_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_bill_number_blocks_device ON bill_number_blocks(device_id);`);

  // Lets a synced sale be traced back to the exact offline bill number
  // it was created against, and makes replaying the same queued sale
  // twice (a real risk on flaky reconnect) a safe no-op instead of a
  // duplicate sale.
  pgm.sql(`ALTER TABLE sales ADD COLUMN idempotency_key text NULL;`);
  pgm.sql(`CREATE UNIQUE INDEX idx_sales_idempotency_key ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL;`);

  pgm.sql(`
    CREATE TABLE sync_conflicts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id text NOT NULL,
      idempotency_key text NOT NULL,
      conflict_type text NOT NULL,
      error_details jsonb NOT NULL,
      original_payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution_note text NULL,
      resolved_by uuid NULL REFERENCES users(id),
      resolved_at timestamptz NULL,
      raised_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_sync_conflicts_idempotency_key ON sync_conflicts(idempotency_key);`);
  pgm.sql(`CREATE INDEX idx_sync_conflicts_status ON sync_conflicts(status);`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES
      ('offline_bill_number_block_size', '5'::jsonb, 'Section 6A.9: how many bill numbers a device pre-reserves at once for offline billing. Small on purpose — a device that goes offline permanently with an unused block leaves that many numbers as a gap.');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key = 'offline_bill_number_block_size';`);
  pgm.sql(`DROP TABLE IF EXISTS sync_conflicts;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_sales_idempotency_key;`);
  pgm.sql(`ALTER TABLE sales DROP COLUMN IF EXISTS idempotency_key;`);
  pgm.sql(`DROP TABLE IF EXISTS bill_number_blocks;`);
};
