#!/bin/bash
# Morning Podcast Generator
# Llamado por el cron de Thorn cada mañana

set -e

ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE" 2>/dev/null || true

OPENAI_KEY="${OPENAI_API_KEY:-}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
CHAT_ID="${ALLOWED_CHAT_ID:-}"
SCRIPT_FILE="/tmp/podcast_script.txt"
AUDIO_FILE="/tmp/morning_podcast.mp3"

echo "Script listo. Genera el guion y llama a este script con el texto como argumento o en stdin."
