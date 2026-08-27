/**
 * M13.1: Staff & roles (Section 10.2). Full user account management on
 * web — create/edit/suspend, role assignment, PIN reset, per-user
 * permission overrides above the base role, rider onboarding (vehicle +
 * documents), and a real per-user activity log ("every action that user
 * has taken, filterable by date and type").
 *
 * The activity log is populated by a single generic Fastify onResponse
 * hook (see src/plugins/activity-log.ts), not by hand-instrumenting every
 * route — so "every action" is actually true, not best-effort coverage
 * of whichever routes happened to remember to log.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Section 10.2: "Per-user permission overrides above the base role."
  // permission_key reuses the exact role-name strings already passed to
  // requireRole(...) everywhere in the codebase (owner/store_manager/
  // picker_packer/rider) — granting user X an override for 'owner' means
  // requireRole("owner") now also passes for X, with no per-route
  // changes needed anywhere else. See plugins/auth.ts.
  pgm.sql(`
    CREATE TABLE permission_overrides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_key text NOT NULL CHECK (permission_key IN ('owner', 'store_manager', 'picker_packer', 'rider')),
      granted_by uuid NOT NULL REFERENCES users(id),
      granted_at timestamptz NOT NULL DEFAULT now(),
      note text NULL
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_permission_overrides_user_key ON permission_overrides(user_id, permission_key);`);

  // Section 10.2: "Rider onboarding: details, vehicle, documents upload,
  // active/inactive status." Active/inactive reuses the existing
  // users.status column (active/suspended) rather than a second,
  // possibly-contradictory flag — one row here per rider user.
  pgm.sql(`
    CREATE TABLE rider_details (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      vehicle_type text NULL,
      vehicle_number text NULL,
      license_number text NULL,
      notes text NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE rider_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type text NOT NULL CHECK (doc_type IN ('driving_license', 'vehicle_rc', 'id_proof', 'other')),
      file_path text NOT NULL,
      uploaded_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_rider_documents_user ON rider_documents(user_id);`);

  // Section 10.2: "Per-user activity log — every action that user has
  // taken, filterable by date and type." Also doubles as the honest data
  // source for "who is logged in now" / "hours logged this week" (Shift
  // and roster view) — this build has no real session table (stateless
  // JWT, Section 1's own stack choice), so those two are approximated
  // from activity recency/spread rather than a true clock-in/out system.
  // Documented as an approximation in DECISIONS.md, same honesty pattern
  // as M5's alarm and M11's GPS pings.
  pgm.sql(`
    CREATE TABLE activity_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NULL REFERENCES users(id),
      method text NOT NULL,
      path text NOT NULL,
      route text NULL,
      status_code int NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_activity_log_user_time ON activity_log(user_id, occurred_at DESC);`);
  pgm.sql(`CREATE INDEX idx_activity_log_time ON activity_log(occurred_at DESC);`);

  // "Who is logged in now" needs presence from every authenticated
  // request (GET included — browsing counts as "logged in"), but logging
  // a full activity_log row per GET/poll would flood the audit trail
  // with noise nobody asked to see. Kept as a separate one-row-per-user
  // upsert instead of piggybacking on activity_log.
  pgm.sql(`
    CREATE TABLE user_last_seen (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at timestamptz NOT NULL
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS user_last_seen;`);
  pgm.sql(`DROP TABLE IF EXISTS activity_log;`);
  pgm.sql(`DROP TABLE IF EXISTS rider_documents;`);
  pgm.sql(`DROP TABLE IF EXISTS rider_details;`);
  pgm.sql(`DROP TABLE IF EXISTS permission_overrides;`);
};
