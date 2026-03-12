#!/bin/bash
# brain-save.sh — save a file to the Brain Vault and register it in the DB
#
# Usage:
#   bash /Users/opoclaw1/claudeclaw/scripts/brain-save.sh /path/to/file.pdf "FolderName"
#
# Valid folders:
#   Trading    — trading reports, Binance analysis, market data
#   Negocio    — business plans, strategies, company docs
#   Finanzas   — financial reports, budgets, cost analysis
#   Personal   — personal documents
#   Juntas     — meeting notes, agendas, call summaries
#   Familia    — family-related documents
#   Varios     — miscellaneous files
#   Documentos — default catch-all for uploads and uncategorized files
#
# Examples:
#   bash /Users/opoclaw1/claudeclaw/scripts/brain-save.sh /tmp/report.pdf "Trading"
#   bash /Users/opoclaw1/claudeclaw/scripts/brain-save.sh /tmp/plan.docx "Negocio"
#   bash /Users/opoclaw1/claudeclaw/scripts/brain-save.sh /tmp/photo.jpg "Personal"
#
# After calling this script, the file appears immediately on the Brain page in the dashboard.
# No restart or rebuild required.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: bash brain-save.sh /path/to/file [FolderName]" >&2
  exit 1
fi

FILE_PATH="$1"
FOLDER="${2:-Documentos}"
BRAIN_ROOT="/Users/opoclaw1/claudeclaw/workspace/brain"
DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"

if [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")
mkdir -p "$BRAIN_ROOT/$FOLDER"
DEST="$BRAIN_ROOT/$FOLDER/$FILENAME"
cp "$FILE_PATH" "$DEST"

SIZE=$(stat -f%z "$DEST" 2>/dev/null || stat -c%s "$DEST" 2>/dev/null || echo 0)

# Determine MIME type from extension
EXT="${FILENAME##*.}"
case "$EXT" in
  pdf)   MIMETYPE="application/pdf" ;;
  docx)  MIMETYPE="application/vnd.openxmlformats-officedocument.wordprocessingml.document" ;;
  xlsx)  MIMETYPE="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ;;
  pptx)  MIMETYPE="application/vnd.openxmlformats-officedocument.presentationml.presentation" ;;
  png)   MIMETYPE="image/png" ;;
  jpg|jpeg) MIMETYPE="image/jpeg" ;;
  gif)   MIMETYPE="image/gif" ;;
  mp4)   MIMETYPE="video/mp4" ;;
  mp3)   MIMETYPE="audio/mpeg" ;;
  txt)   MIMETYPE="text/plain" ;;
  md)    MIMETYPE="text/markdown" ;;
  csv)   MIMETYPE="text/csv" ;;
  json)  MIMETYPE="application/json" ;;
  *)     MIMETYPE="application/octet-stream" ;;
esac

# Generate unique ID using timestamp + random hex
ID="bf_$(date +%s%3N)_$(openssl rand -hex 3)"

sqlite3 "$DB" "INSERT OR REPLACE INTO brain_files (id, name, path, type, mimetype, size, created_at) VALUES ('$ID', '$FILENAME', '$FOLDER/$FILENAME', 'file', '$MIMETYPE', $SIZE, datetime('now'))"

echo "Saved to Brain: $FOLDER/$FILENAME (${SIZE} bytes, id=$ID)"
