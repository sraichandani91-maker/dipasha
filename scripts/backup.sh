#!/usr/bin/env bash
# Section 12B.3: "treat as the highest priority item." Daily Postgres dump
# plus a tarball of the uploads directory (prescription/write-off/expense
# photos — a statutory record, Section 12B.1/12B.3's "object storage
# backed up separately," done here against the local-disk storage this
# pilot actually uses instead — see DECISIONS.md for why there's no real
# object storage yet). Run from the repo root, as a cron job — see
# RUNBOOK.md for the crontab line and the one-time VPS prerequisite
# (`apt install postgresql-client`).
#
# Talks to Postgres via $DATABASE_URL directly (pg_dump/psql), not
# `docker compose exec` — this is what makes the script identical in
# local dev, this sandbox, and the real VPS: docker-compose.yml keeps
# Postgres's port bound to 127.0.0.1 specifically so a host-level cron
# job (this script) can reach it without stepping outside a loopback bind,
# which Section 12B.5's "not exposed to the public internet" rule was
# always about the public internet, not the host itself.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  echo "Missing .env — nothing to back up against." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in .env — nothing to connect to." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

DB_DUMP="$BACKUP_DIR/dipasha-db-$STAMP.sql.gz"
UPLOADS_TAR="$BACKUP_DIR/dipasha-uploads-$STAMP.tar.gz"

echo "==> Dumping Postgres to $DB_DUMP"
pg_dump "$DATABASE_URL" | gzip > "$DB_DUMP"

if [ ! -s "$DB_DUMP" ]; then
  echo "Dump is empty — treating this as a failed backup, not a successful empty one." >&2
  rm -f "$DB_DUMP"
  exit 1
fi

echo "==> Archiving uploads to $UPLOADS_TAR"
# apps/api/config.ts defaults UPLOAD_DIR to "./uploads", resolved
# relative to the API process's own cwd — apps/api when run directly
# (npm workspaces sets cwd to the workspace dir), matching what's
# actually on disk in local/bare-metal dev; /repo/uploads inside the
# Docker image, which is why that case falls through to the named-volume
# branch below instead (a host path can't reach into a container).
UPLOAD_DIR="${UPLOAD_DIR:-./apps/api/uploads}"
if [ -d "$UPLOAD_DIR" ]; then
  # Local-disk uploads directory — local dev, or a VPS deployment that
  # bind-mounts a host path instead of a named Docker volume.
  tar czf "$UPLOADS_TAR" -C "$UPLOAD_DIR" .
elif docker volume inspect dipasha_uploads >/dev/null 2>&1; then
  # The real docker-compose deployment's shape: a named volume, not a
  # host path — a throwaway container mounts it read-only just to tar it,
  # no need for the api container itself to be running.
  docker run --rm -v dipasha_uploads:/uploads:ro -v "$(cd "$BACKUP_DIR" && pwd)":/backup alpine \
    tar czf "/backup/$(basename "$UPLOADS_TAR")" -C /uploads .
else
  echo "WARNING: no uploads directory ($UPLOAD_DIR) and no dipasha_uploads Docker volume found — skipping the uploads archive. If real uploads exist somewhere else, this backup is incomplete." >&2
  UPLOADS_TAR=""
fi

if [ -n "$UPLOADS_TAR" ]; then
  echo "==> Local copies written: $(du -h "$DB_DUMP" | cut -f1) db, $(du -h "$UPLOADS_TAR" | cut -f1) uploads"
else
  echo "==> Local copy written: $(du -h "$DB_DUMP" | cut -f1) db (no uploads archive — see warning above)"
fi

# Section 12B.3: "Backups stored off the app server, in a different
# location." No object storage account exists yet (Section 14 — the
# owner's to purchase) — rclone is provider-agnostic (S3, Backblaze B2,
# Google Drive, etc. all speak the same `rclone copy` command), so once a
# remote exists this is a one-line config change, not a script rewrite.
# Until then, this is loud about the gap rather than silently leaving
# backups sitting on the same disk as what they're backing up.
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "==> Copying to off-server remote: $BACKUP_RCLONE_REMOTE"
  rclone copy "$DB_DUMP" "$BACKUP_RCLONE_REMOTE"
  [ -n "$UPLOADS_TAR" ] && rclone copy "$UPLOADS_TAR" "$BACKUP_RCLONE_REMOTE"
else
  echo "WARNING: BACKUP_RCLONE_REMOTE is not set — backups are sitting on the same disk as the data they protect, not actually off-server yet. See RUNBOOK.md's Backups section." >&2
fi

echo "==> Pruning local backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -name 'dipasha-db-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'dipasha-uploads-*.tar.gz' -mtime "+$RETENTION_DAYS" -print -delete

echo "==> Backup complete: $STAMP"
