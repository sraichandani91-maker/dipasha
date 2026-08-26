/**
 * M9: AI invoice scanning (Section 6.3) — capture, extract, match/review,
 * commit. "The AI never commits stock. A human always confirms."
 *
 * `purchase_invoice_scans` is the whole lifecycle of one upload — from
 * capture through extraction through (optionally) the committed
 * purchase invoice it became. `purchase_invoice_scan_pages` holds the
 * actual files: one row for a single-file PDF (Claude reads multi-page
 * PDFs natively, no per-page split needed), or one row per photo for a
 * multi-image capture — the same model covers both without a special
 * case either way.
 *
 * `vendor_product_aliases` is Section 6.3's "the system should need
 * materially less correction by the twentieth invoice than the first" —
 * every accepted product match is remembered per vendor, so the same
 * vendor's odd abbreviation for a product auto-resolves next time.
 */

exports.shorthands = undefined;

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  [
    "ai_invoice_extraction_model",
    "claude-opus-5",
    "Vision-capable model used for invoice extraction (Section 6.3). Configurable so the owner can trade accuracy for cost without a code change once real invoice volume shows what's actually needed.",
  ],
  [
    "ai_invoice_confidence_threshold",
    0.7,
    "Per-field confidence (0-1) below which the review screen visually flags a field amber (Section 6.3: 'anything below threshold gets visually flagged'). No number given in the brief — a reasonable default, owner-editable later.",
  ],
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE purchase_invoice_scans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      image_hash text NOT NULL,
      status text NOT NULL DEFAULT 'captured'
        CHECK (status IN ('captured', 'extracting', 'extracted', 'extraction_failed', 'committed')),
      vendor_id uuid NULL REFERENCES vendors(id),
      raw_extraction jsonb NULL,
      extraction_error text NULL,
      extraction_model text NULL,
      corrected_fields jsonb NULL,             -- diff of human-edited fields vs raw_extraction, written at commit
      purchase_invoice_id uuid NULL REFERENCES purchase_invoices(id),
      created_by uuid NOT NULL REFERENCES users(id),
      device_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      extracted_at timestamptz NULL,
      committed_at timestamptz NULL
    );
  `);
  // Section 6.3: "cache by image hash so an accidental re-upload does not
  // re-bill" — a non-unique index (not a constraint) since a genuine
  // second invoice can legitimately share bytes-for-bytes identical
  // pages only in pathological cases, and the cache lookup itself
  // filters by status = 'extracted' anyway.
  pgm.sql(`CREATE INDEX idx_purchase_invoice_scans_hash ON purchase_invoice_scans(image_hash) WHERE status = 'extracted';`);
  pgm.sql(`CREATE INDEX idx_purchase_invoice_scans_status ON purchase_invoice_scans(status);`);

  pgm.sql(`
    CREATE TABLE purchase_invoice_scan_pages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scan_id uuid NOT NULL REFERENCES purchase_invoice_scans(id) ON DELETE CASCADE,
      page_number int NOT NULL,
      file_path text NOT NULL,
      mime_type text NOT NULL,
      UNIQUE (scan_id, page_number)
    );
  `);

  pgm.sql(`
    CREATE TABLE vendor_product_aliases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_id uuid NOT NULL REFERENCES vendors(id),
      alias_text text NOT NULL,
      product_id uuid NOT NULL REFERENCES products(id),
      use_count int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (vendor_id, alias_text)
    );
  `);
  pgm.sql(`CREATE INDEX idx_vendor_product_aliases_lookup ON vendor_product_aliases(vendor_id, alias_text);`);

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
      INSERT INTO settings (key, value, description)
      VALUES (${sqlLiteral(key)}, ${sqlLiteral(JSON.stringify(value))}::jsonb, ${sqlLiteral(description)});
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key IN (${SETTINGS.map((s) => `'${s[0]}'`).join(", ")});`);
  pgm.sql(`DROP TABLE IF EXISTS vendor_product_aliases;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_invoice_scan_pages;`);
  pgm.sql(`DROP TABLE IF EXISTS purchase_invoice_scans;`);
};
