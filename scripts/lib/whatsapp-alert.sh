# Minimal, standalone WhatsApp send for ops alerts (uptime-check.sh,
# backup-freshness-check.sh) — sourced, not run directly.
#
# Deliberately NOT reusing apps/api's own dispatcher
# (domain/notifications.ts): these two scripts exist specifically to
# fire when the API or its database might be unreachable, so routing
# through the app's own pipeline isn't just unnecessary here, it's the
# one case that structurally cannot work. Same "real WhatsApp Business
# API account is the owner's to set up (Section 14); an honest log
# fallback until then" story as `apps/api/src/lib/whatsapp-sender.ts` —
# talks to the real Meta Cloud API (Section 12A.1's own stated choice)
# directly via curl once credentials exist, since a whole SDK is
# overkill for two alert scripts sending plain text.
send_whatsapp_alert() {
  local message="$1"
  local to="${WHATSAPP_ALERT_PHONE:-}"

  if [ -z "$to" ]; then
    echo "ALERT (WHATSAPP_ALERT_PHONE not set — printing instead of sending): $message" >&2
    return 0
  fi

  if [ -z "${WHATSAPP_CLOUD_API_TOKEN:-}" ] || [ -z "${WHATSAPP_CLOUD_API_PHONE_NUMBER_ID:-}" ]; then
    echo "ALERT (no real WhatsApp Business API credentials configured — logging instead of sending to $to): $message" >&2
    return 0
  fi

  local escaped="${message//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  escaped="${escaped//$'\n'/\\n}"

  if curl -sf -X POST "https://graph.facebook.com/v21.0/${WHATSAPP_CLOUD_API_PHONE_NUMBER_ID}/messages" \
    -H "Authorization: Bearer ${WHATSAPP_CLOUD_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"messaging_product\":\"whatsapp\",\"to\":\"${to}\",\"type\":\"text\",\"text\":{\"body\":\"${escaped}\"}}" \
    >/dev/null; then
    echo "Alert sent via WhatsApp to $to: $message"
  else
    echo "ALERT (WhatsApp send failed — see above for the message that couldn't go out): $message" >&2
  fi
}
