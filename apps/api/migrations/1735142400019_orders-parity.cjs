/**
 * M13.6: Section 10.2 "Orders" — cancel with automatic stock reversal,
 * force-reassign to a different rider, and a refund-initiation stub.
 * Full order list/export, manual creation, and edit-pre-pick (add/remove
 * line, change quantity, substitute) reuse existing tables/columns —
 * order_status already has 'cancelled', order_lines already supports
 * being added to or removed pre-pick with no downstream FK before
 * start-picking creates order_pick_lines.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN cancelled_reason_code text NULL CHECK (cancelled_reason_code IS NULL OR cancelled_reason_code IN
        ('customer_requested', 'duplicate_order', 'payment_issue', 'out_of_stock', 'other')),
      ADD COLUMN cancelled_note text NULL,
      ADD COLUMN cancelled_by uuid NULL REFERENCES users(id),
      ADD COLUMN cancelled_at timestamptz NULL;
  `);

  // Section 10.2: "Force-reassign an order to a different rider" — a
  // real audit trail, same reasoning as M13.4's product_group_changes:
  // this is a dispatch judgment call (rider called in sick, a delivery
  // is stuck), not an error correction, so it's a required note rather
  // than a fixed reason-code taxonomy.
  pgm.sql(`
    CREATE TABLE order_reassignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      old_rider_id uuid NULL REFERENCES users(id),
      new_rider_id uuid NOT NULL REFERENCES users(id),
      note text NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_reassignments_order ON order_reassignments(order_id);`);

  // Section 10.2: "Refund initiation (stubbed until the payment gateway
  // is live)." A real record of intent — who asked, how much, why — not
  // a fake success. status stays 'requested' forever in this build
  // because there is nowhere for it to go from there yet (Section 14:
  // payment gateway is out of scope, handled by the Owner separately).
  pgm.sql(`
    CREATE TABLE order_refunds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount numeric(12,2) NOT NULL CHECK (amount > 0),
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processed_manually')),
      requested_by uuid NOT NULL REFERENCES users(id),
      requested_at timestamptz NOT NULL DEFAULT now(),
      resolved_note text NULL,
      resolved_by uuid NULL REFERENCES users(id),
      resolved_at timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_refunds_order ON order_refunds(order_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS order_refunds;`);
  pgm.sql(`DROP TABLE IF EXISTS order_reassignments;`);
  pgm.sql(`
    ALTER TABLE orders
      DROP COLUMN IF EXISTS cancelled_reason_code,
      DROP COLUMN IF EXISTS cancelled_note,
      DROP COLUMN IF EXISTS cancelled_by,
      DROP COLUMN IF EXISTS cancelled_at;
  `);
};
