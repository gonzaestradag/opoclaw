#!/bin/bash
# Sends a message to Gonzalo's Telegram chat
# Usage: ./tg-notify.sh "your message here"
# Or: echo "message" | ./tg-notify.sh

set -euo pipefail

# Load env
source /Users/opoclaw1/claudeclaw/.env 2>/dev/null || true

MESSAGE="${1:-$(cat -)}"

if [ -z "${BOT_TOKEN:-}" ] && [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "ERROR: No BOT_TOKEN or TELEGRAM_BOT_TOKEN in .env" >&2
  exit 1
fi

CHAT="${ALLOWED_CHAT_ID}"
BOT_INJECT_PORT="${BOT_INJECT_PORT:-3142}"

# ── Nightly silence window (10 PM – 7 AM) ────────────────────────────────
# Autonomous/scheduled work must never ping Gonzalo at night.
# Everything queues until the morning brief. Set FORCE_NOTIFY=1 to override
# (used only for genuine emergencies or manual triggers from Gonzalo himself).
HOUR=$(date +%H)
if [ "${FORCE_NOTIFY:-0}" != "1" ] && { [ "$HOUR" -ge 22 ] || [ "$HOUR" -lt 7 ]; }; then
  # Still fire the ack resolver so Thorn stops typing — just don't deliver to Telegram
  curl -s -X POST "http://127.0.0.1:${BOT_INJECT_PORT}/thorn-ack/${CHAT}" \
    > /dev/null 2>&1 || true
  touch "/tmp/opoclaw_tg_notify_sent_${CHAT}" 2>/dev/null || true
  echo "Silenced (nightly window). Message queued for morning brief." >> /tmp/nightly_suppressed_msgs.txt
  echo "$(date '+%H:%M') — $MESSAGE" >> /tmp/nightly_suppressed_msgs.txt
  echo "Silenced."
  exit 0
fi

# Route through the inject server's /thorn-notify endpoint.
# The server checks if the original input was voice → sends TTS audio.
# If text → sends as text. This ensures voice inputs get voice completions automatically.
# The endpoint also fires the ack resolver to stop Thorn's typing immediately.
ESCAPED_MSG=$(python3 -c "import json,sys; print(json.dumps({'text':sys.argv[1]}))" "$MESSAGE" 2>/dev/null || echo "{\"text\":\"$MESSAGE\"}")
NOTIFY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://127.0.0.1:${BOT_INJECT_PORT}/thorn-notify/${CHAT}" \
  -H "Content-Type: application/json" \
  -d "$ESCAPED_MSG" 2>/dev/null)

if [ "$NOTIFY_STATUS" != "202" ]; then
  # Fallback: inject server unavailable — send text directly to Telegram
  TOKEN="${BOT_TOKEN:-${TELEGRAM_BOT_TOKEN}}"
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=${MESSAGE}" \
    > /dev/null
  # Also fire ack via old endpoint as fallback
  curl -s -X POST "http://127.0.0.1:${BOT_INJECT_PORT}/thorn-ack/${CHAT}" \
    > /dev/null 2>&1 || true
fi

touch "/tmp/opoclaw_tg_notify_sent_${CHAT}" 2>/dev/null || true
echo "Sent."
