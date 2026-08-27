/**
 * M13.4: Section 10.2 "Product master" — manual substitute_group_id
 * management (bypassing the M2 auto-computed-from-composition value,
 * which has no override path today), bulk CSV import with preview diff,
 * and product barcode label sheet generation (bins already had this
 * since M2; products didn't).
 *
 * product_group_changes is the audit trail for the one thing this
 * screen does that's a real judgment call rather than a data-entry
 * correction: linking or splitting products as substitutes is a
 * pharmacist's professional call, not an error being fixed, so it's
 * logged with a note rather than a fixed reason-code taxonomy.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_group_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id),
      old_group_id uuid NULL,
      new_group_id uuid NOT NULL,
      note text NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_product_group_changes_product ON product_group_changes(product_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS product_group_changes;`);
};
