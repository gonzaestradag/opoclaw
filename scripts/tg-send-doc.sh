#!/usr/bin/env bash
# tg-send-doc.sh — Send a file as a Telegram document
# Usage: bash tg-send-doc.sh /path/to/file.txt "Optional caption"

FILE_PATH="$1"
CAPTION="${2:-}"

BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2 | tr -d '"')
# Prefer ALLOWED_CHAT_ID (the canonical var used across all scripts); fall back to TELEGRAM_CHAT_ID for backwards compat
CHAT_ID=$(grep -E '^ALLOWED_CHAT_ID=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2 | tr -d '"')
if [ -z "$CHAT_ID" ]; then
  CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2 | tr -d '"')
fi

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env"
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo "Error: File not found: $FILE_PATH"
  exit 1
fi

if [ -n "$CAPTION" ]; then
  curl -s \
    -F "chat_id=$CHAT_ID" \
    -F "document=@${FILE_PATH}" \
    -F "caption=${CAPTION}" \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument"
else
  curl -s \
    -F "chat_id=$CHAT_ID" \
    -F "document=@${FILE_PATH}" \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument"
fi
