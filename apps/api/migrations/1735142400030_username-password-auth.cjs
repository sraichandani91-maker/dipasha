exports.up = (pgm) => {
  // Owner-requested: username + password instead of phone + OTP — a real
  // SMS/WhatsApp OTP provider costs money per message, and this build
  // never had one wired up anyway (the dev sender just echoed the code
  // to the screen). `phone` stays on the account — it's still the target
  // for the daily-digest WhatsApp message sent to the Owner (Section
  // 10B.4) and every other staff-facing notification — it just stops
  // being the login identifier, so it becomes optional.
  pgm.sql(`ALTER TABLE users ADD COLUMN username text UNIQUE NULL;`);
  pgm.sql(`ALTER TABLE users ADD COLUMN password_hash text NULL;`);
  pgm.sql(`ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;`);

  // The OTP mechanism this replaces, table and all — a genuine
  // replacement, not a second login path left dangling.
  pgm.sql(`DROP TABLE IF EXISTS otp_codes;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE otp_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone text NOT NULL,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz NULL,
      attempts int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`ALTER TABLE users ALTER COLUMN phone SET NOT NULL;`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS password_hash;`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS username;`);
};
