#!/bin/bash
# tg-send-voice-to.sh — Generate ElevenLabs TTS audio and send to any Telegram chat.
# ALWAYS uses ElevenLabs (Gonzalo's cloned voice). Never OpenAI TTS.
#
# Usage:
#   bash tg-send-voice-to.sh <CHAT_ID> "Text to speak"
#
# CHAT_ID can be a user ID, group ID, or @username.
# @username values are resolved to numeric IDs via the telegram_contacts DB table,
# or via the Telegram getChat API as a fallback.
# Falls back to text message if ElevenLabs fails.

set -e

CHAT_ID="$1"
TEXT="$2"

if [ -z "$CHAT_ID" ] || [ -z "$TEXT" ]; then
  echo "Usage: tg-send-voice-to.sh <CHAT_ID> \"Text to speak\""
  exit 1
fi

# 1. Load ENV (must happen before username resolution)
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"
BOT_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')
ELEVEN_KEY=$(grep "^ELEVENLABS_API_KEY=" "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')
ELEVEN_VOICE=$(grep "^ELEVENLABS_VOICE_ID=" "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')

if [ -z "$BOT_TOKEN" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN not found in .env"
  exit 1
fi

# 2. If CHAT_ID is a @username, resolve to numeric ID
if [[ "$CHAT_ID" == @* ]]; then
  UNAME_BARE="${CHAT_ID#@}"  # strip the @ for external_users lookup
  DB_CHAT_ID=$(sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \
    "SELECT telegram_chat_id FROM telegram_contacts WHERE telegram_username='${CHAT_ID}' AND telegram_chat_id IS NOT NULL AND telegram_chat_id != '' LIMIT 1;" 2>/dev/null)
  if [ -n "$DB_CHAT_ID" ]; then
    CHAT_ID="$DB_CHAT_ID"
  else
    # Fallback 1: check telegram_external_users (auto-saved when they messaged the bot)
    EXT_CHAT_ID=$(sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \
      "SELECT chat_id FROM telegram_external_users WHERE username='${UNAME_BARE}' LIMIT 1;" 2>/dev/null)
    if [ -n "$EXT_CHAT_ID" ]; then
      CHAT_ID="$EXT_CHAT_ID"
    else
      # Fallback 2: try Telegram getChat API
      RESOLVED=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${CHAT_ID}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['id']) if d.get('ok') else print('')" 2>/dev/null)
      if [ -n "$RESOLVED" ]; then
        CHAT_ID="$RESOLVED"
        sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \
          "UPDATE telegram_contacts SET telegram_chat_id='${RESOLVED}', updated_at=datetime('now') WHERE telegram_username='@${UNAME_BARE}';" 2>/dev/null || true
      else
        echo "WARNING: Could not resolve ${CHAT_ID} to a numeric ID." >&2
      fi
    fi
  fi
fi

TMP_AUDIO="/tmp/tg_voice_to_$(date +%s).mp3"

# Generate audio with ElevenLabs
if [ -n "$ELEVEN_KEY" ] && [ -n "$ELEVEN_VOICE" ]; then
  python3 - << PYEOF
import json, urllib.request, sys

key = "$ELEVEN_KEY"
vid = "$ELEVEN_VOICE"
text = """$TEXT"""

payload = json.dumps({
    "text": text,
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {"stability": 0.90, "similarity_boost": 0.80, "style": 0.0, "use_speaker_boost": True}
}).encode()

req = urllib.request.Request(
    f"https://api.elevenlabs.io/v1/text-to-speech/{vid}",
    data=payload,
    headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"}
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        with open("$TMP_AUDIO", "wb") as f:
            f.write(r.read())
    print("ok")
except Exception as e:
    print(f"error: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF

  if [ -f "$TMP_AUDIO" ] && [ -s "$TMP_AUDIO" ]; then
    # Send as voice note
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendVoice" \
      -F "chat_id=${CHAT_ID}" \
      -F "voice=@${TMP_AUDIO}" \
      > /dev/null
    rm -f "$TMP_AUDIO"
    # Log to contact_messages DB
    CONTACT_NAME=$(sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \
      "SELECT name FROM telegram_contacts WHERE telegram_chat_id='${CHAT_ID}' OR telegram_username='${1}' LIMIT 1;" 2>/dev/null || echo "${1}")
    sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \
      "INSERT INTO contact_messages (contact_name, contact_username, channel, message_text) VALUES ('${CONTACT_NAME:-${1}}', '${1}', 'telegram', $(python3 -c "import sys; print(repr('${TEXT//\'/\\'\'}'[:500]))" 2>/dev/null || echo "'${TEXT:0:100}''));" 2>/dev/null || true
    echo "Voice sent to $CHAT_ID via ElevenLabs"
  else
    echo "ElevenLabs audio generation failed — sending as text"
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${TEXT}" \
      > /dev/null
  fi
else
  # No ElevenLabs keys — send as text
  echo "No ElevenLabs keys found — sending as text"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${TEXT}" \
    > /dev/null
fi
