#!/bin/bash
# generate-podcast-audio.sh — Generate podcast audio with ElevenLabs.
# Uses the EXACT same voice settings as voice.ts (stability 0.90,
# similarity_boost 0.80, style 0.0, use_speaker_boost true) so the
# podcast sounds identical to Thorn's regular voice responses.
#
# Usage: bash generate-podcast-audio.sh [script_file] [output_file]
# Defaults: script=/tmp/podcast_script.txt output=/tmp/morning_podcast.mp3

set -e

SCRIPT_FILE="${1:-/tmp/podcast_script.txt}"
OUTPUT_FILE="${2:-/tmp/morning_podcast.mp3}"
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"

# Load env
source "$ENV_FILE" 2>/dev/null || true

if [ -z "${ELEVENLABS_API_KEY:-}" ] || [ -z "${ELEVENLABS_VOICE_ID:-}" ]; then
  echo "ERROR: ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set in .env" >&2
  exit 1
fi

if [ ! -f "$SCRIPT_FILE" ]; then
  echo "ERROR: Script file not found: $SCRIPT_FILE" >&2
  exit 1
fi

SCRIPT_TEXT=$(cat "$SCRIPT_FILE")

python3 - << PYEOF
import json, urllib.request, sys

key = "${ELEVENLABS_API_KEY}"
vid = "${ELEVENLABS_VOICE_ID}"
text = """${SCRIPT_TEXT}"""

payload = json.dumps({
    "text": text,
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
        "stability": 0.90,
        "similarity_boost": 0.80,
        "style": 0.0,
        "use_speaker_boost": True
    }
}).encode()

req = urllib.request.Request(
    f"https://api.elevenlabs.io/v1/text-to-speech/{vid}",
    data=payload,
    headers={
        "xi-api-key": key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
    }
)

try:
    with urllib.request.urlopen(req, timeout=60) as r:
        audio = r.read()
        with open("${OUTPUT_FILE}", "wb") as f:
            f.write(audio)
    print(f"ok — {len(audio)} bytes saved to ${OUTPUT_FILE}")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
