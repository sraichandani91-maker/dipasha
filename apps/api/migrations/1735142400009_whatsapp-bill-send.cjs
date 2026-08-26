/**
 * Section 6A.6 / Section 14 — "send bill via WhatsApp" as a post-sale
 * action alongside print. Same reprint-is-tracked-not-blocked pattern as
 * `print_count` (Section 6A.6): sending again is always allowed, but
 * counted, so a reviewer can tell "sent once" from "sent five times."
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE sales ADD COLUMN whatsapp_send_count int NOT NULL DEFAULT 0;`);
  pgm.sql(`ALTER TABLE sales ADD COLUMN whatsapp_last_sent_at timestamptz NULL;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE sales DROP COLUMN whatsapp_send_count;`);
  pgm.sql(`ALTER TABLE sales DROP COLUMN whatsapp_last_sent_at;`);
};
