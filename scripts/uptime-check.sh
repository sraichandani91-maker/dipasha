#!/usr/bin/env bash
# Section 12B.4: "Uptime monitoring with an alert to WhatsApp if the API
# goes down. If billing stops, I need to know before a customer tells
# me." Runs outside the API's own process (cron, not a setInterval in
# index.ts — see RUNBOOK.md for the crontab line) so it still works when
# the thing it's checking is the one that's down.
#
# Alerts only on a state *change* (up→down, down→up), not on every failed
# check — a health check running every few minutes would otherwise send
# a fresh WhatsApp message every single tick for as long as an outage
# lasts, which trains everyone to ignore the alerts. State is a plain
# file next to this script; safe to delete if it ever gets out of sync.
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

HEALTH_URL="${UPTIME_CHECK_URL:-https://${DOMAIN:-localhost}/api/health}"
STATE_FILE="${UPTIME_STATE_FILE:-./scripts/.uptime-state}"
PREV_STATE="unknown"
[ -f "$STATE_FILE" ] && PREV_STATE="$(cat "$STATE_FILE")"

# No -f: a non-200 is exactly what this script is checking for, not
# something to make curl itself fail on. curl already writes "000" to
# the -w format on a connection-level failure (refused, timed out, DNS)
# — but curl's own exit code is still nonzero in that case, and under
# `set -e` a failing command inside a `var=$(...)` substitution kills the
# script right there (found live: a real connection-refused test exited
# silently before ever reaching the alert logic below). `|| true` is
# deliberate here, not laziness — HTTP_CODE itself already carries all
# the information this script needs from curl's exit status.
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
[ -z "$HTTP_CODE" ] && HTTP_CODE="000"

if [ "$HTTP_CODE" = "200" ]; then
  CURR_STATE="up"
else
  CURR_STATE="down"
fi

echo "$(date -u +%FT%TZ) $HEALTH_URL -> $HTTP_CODE ($CURR_STATE, was $PREV_STATE)"

if [ "$CURR_STATE" != "$PREV_STATE" ]; then
  if [ "$CURR_STATE" = "down" ]; then
    send_whatsapp_alert "Dipasha API is DOWN — $HEALTH_URL returned HTTP $HTTP_CODE. Billing may be affected."
  elif [ "$PREV_STATE" = "down" ]; then
    send_whatsapp_alert "Dipasha API is back UP — $HEALTH_URL is responding again."
  fi
  # First-ever run (PREV_STATE=unknown, CURR_STATE=up) is deliberately
  # silent — that's normal startup, not a recovery from anything.
fi

echo "$CURR_STATE" > "$STATE_FILE"
