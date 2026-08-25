/**
 * Section 5B.3: "Log every search, and especially every search returning
 * no result — that list is a direct feed into the request book and your
 * new-SKU decisions." One log table for the one unified search endpoint.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE search_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      query text NOT NULL,
      context text NULL,
      result_count int NOT NULL,
      user_id uuid NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_search_log_zero_results ON search_log(created_at) WHERE result_count = 0;`);
  pgm.sql(`CREATE INDEX idx_search_log_created_at ON search_log(created_at);`);

  pgm.sql(`
    INSERT INTO settings (key, value, description) VALUES (
      'search_sort_within_group',
      '"in_stock_first_then_mrp_asc"'::jsonb,
      'Default sort order for results within a composition group in the unified search (Section 5B.2). Owner-editable later.'
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM settings WHERE key = 'search_sort_within_group';`);
  pgm.sql(`DROP TABLE IF EXISTS search_log;`);
};
