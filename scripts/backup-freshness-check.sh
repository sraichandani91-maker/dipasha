#!/usr/bin/env bash
# Section 12B.3: "Weekly automated check that the latest backup exists
# and is non-zero, alerting to WhatsApp if not." Run this weekly via cron
# (see RUNBOOK.md) — separate from backup.sh itself, since a check that
# only runs as part of the backup job could never catch the job silently
# not running at all (a stopped cron daemon, a removed crontab entry, a
# reboot that didn't bring cron back).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
source scripts/lib/whatsapp-alert.sh

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
# A daily backup job means the newest file should never be much older
# than 24h; this check itself only runs weekly, so a generous margin
# avoids a false alarm from clock drift or a slightly-late cron tick,
# while still catching "backups stopped running three days ago."
MAX_AGE_HOURS="${BACKUP_FRESHNESS_MAX_AGE_HOURS:-48}"

# `|| true` on a missing BACKUP_DIR: find's own nonzero exit would
# otherwise kill the script under `set -e`/`pipefail` right here, before
# ever reaching the "no backup found" alert this line exists to feed —
# the exact same gotcha fixed live in uptime-check.sh.
LATEST_DB_DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -name 'dipasha-db-*.sql.gz' -type f 2>/dev/null | sort | tail -1 || true)"

if [ -z "$LATEST_DB_DUMP" ]; then
  send_whatsapp_alert "Dipasha backup check: no database backup found in $BACKUP_DIR at all. Backups may never have run, or the directory is wrong."
  exit 1
fi

if [ ! -s "$LATEST_DB_DUMP" ]; then
  send_whatsapp_alert "Dipasha backup check: the latest backup ($LATEST_DB_DUMP) is zero bytes. Today's backup likely failed."
  exit 1
fi

AGE_HOURS=$(( ( $(date +%s) - $(date -r "$LATEST_DB_DUMP" +%s) ) / 3600 ))
if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  send_whatsapp_alert "Dipasha backup check: the latest backup ($LATEST_DB_DUMP) is $AGE_HOURS hours old — expected a fresh one within $MAX_AGE_HOURS hours. The backup job may have stopped running."
  exit 1
fi

echo "OK — latest backup $LATEST_DB_DUMP is $AGE_HOURS hours old, $(du -h "$LATEST_DB_DUMP" | cut -f1)."
