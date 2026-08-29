/**
 * vendor_debit_note_lines was missing a cess_amount column to mirror
 * purchase_invoice_lines.cess_amount — added right after cess got a real
 * input on Purchase Entry (M16-era hardening pass), so a debit note on a
 * cess-bearing line can proportion cess back out too, not just GST.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE vendor_debit_note_lines ADD COLUMN cess_amount numeric(12,2) NOT NULL DEFAULT 0;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE vendor_debit_note_lines DROP COLUMN IF EXISTS cess_amount;`);
};
