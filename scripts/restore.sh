#!/usr/bin/env bash
# Section 12B.3: "a documented, tested restore procedure. A backup that
# has never been restored is not a backup." Restores a db dump (and
# optionally an uploads tarball) produced by backup.sh into a fresh,
# separate database — intended for staging or a throwaway scratch
# database. Never restores over the live database name, which is what
# makes it safe to run against a production host to actually test a
# real backup.
#
# Usage: scripts/restore.sh <db-dump.sql.gz> [uploads-tar.gz] [target-db-name]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_DUMP="${1:?Usage: scripts/restore.sh <db-dump.sql.gz> [uploads-tar.gz] [target-db-name]}"
UPLOADS_TAR="${2:-}"
TARGET_DB="${3:-dipasha_restore_test}"

if [ ! -f .env ]; then
  echo "Missing .env." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in .env." >&2
  exit 1
fi

# Swap the db name in DATABASE_URL for the target scratch database,
# rather than asking for a second connection string — same connection,
# same credentials, deliberately never the live database.
ADMIN_URL="${DATABASE_URL%/*}/postgres"
TARGET_URL="${DATABASE_URL%/*}/$TARGET_DB"

echo "==> Restoring $DB_DUMP into a fresh database: $TARGET_DB"
echo "    (never the live database — restoring into $TARGET_DB is what makes this safe to run against production)"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $TARGET_DB;" \
  -c "CREATE DATABASE $TARGET_DB;"

START=$(date +%s)
gunzip -c "$DB_DUMP" | psql "$TARGET_URL" >/tmp/dipasha-restore.log 2>&1
END=$(date +%s)

ROW_CHECK=$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM settings;")
echo "==> Restored in $((END - START))s. Sanity check — settings table row count: $ROW_CHECK"
if [ "$ROW_CHECK" -eq 0 ]; then
  echo "WARNING: settings table is empty after restore — this dump is probably not what you think it is. Check /tmp/dipasha-restore.log." >&2
  exit 1
fi

if [ -n "$UPLOADS_TAR" ]; then
  RESTORE_DIR="./uploads-restore-test"
  echo "==> Extracting $UPLOADS_TAR to $RESTORE_DIR (not overwriting the live uploads directory)"
  mkdir -p "$RESTORE_DIR"
  tar xzf "$UPLOADS_TAR" -C "$RESTORE_DIR"
  echo "==> Extracted $(find "$RESTORE_DIR" -type f | wc -l) files"
fi

echo "==> Restore test complete. Drop the test database when done: psql \"$ADMIN_URL\" -c 'DROP DATABASE $TARGET_DB;'"
