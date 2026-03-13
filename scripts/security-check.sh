#!/bin/bash
# security-check.sh — Pre-push security scan
# Runs before every git commit (nightly push + manual commits via git hook).
# BLOCKS the push if it finds API keys, tokens, hardcoded personal data, or secrets.
#
# Safe files it never flags:
#   .env.example   — shows variable NAMES only, no values (safe by design)
#   *.md comments  — lines that only say "Get at: ..." or contain placeholder text
#   node_modules/  — never scanned

set -e

REPO="/Users/opoclaw1/claudeclaw"
LOG="/tmp/security-check.log"
ALERT_LOG="/tmp/security-check-BLOCKED.log"
FOUND=0

cd "$REPO"

# Files to scan: only what git is tracking + staged (never node_modules or .gitignored)
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
if [ -z "$STAGED_FILES" ]; then
  # If called manually (not in a commit flow), scan all tracked files
  STAGED_FILES=$(git ls-files)
fi

# Filter out safe files we never need to scan
SCAN_FILES=$(echo "$STAGED_FILES" | grep -v \
  -e "^node_modules/" \
  -e "\.gitignore$" \
  -e "package-lock\.json$" \
  -e "^dashboard/node_modules/" \
  -e "\.png$" \
  -e "\.jpg$" \
  -e "\.ico$" \
  -e "\.woff" \
  -e "\.ttf$" \
  2>/dev/null || true)

echo "[$(date)] security-check: scanning $(echo "$SCAN_FILES" | wc -l | tr -d ' ') files..." >> "$LOG"

flag() {
  local file="$1"
  local reason="$2"
  local line="$3"
  FOUND=1
  MSG="  BLOCKED: $file — $reason"
  [ -n "$line" ] && MSG="$MSG\n    -> $line"
  echo -e "$MSG" | tee -a "$ALERT_LOG"
  echo -e "[$(date)] $MSG" >> "$LOG"
}

# ── Load .env to know what values to block ──────────────────────────────────
# We pull actual secret VALUES from .env so we can detect if they leak into code
ENV_FILE="$REPO/.env"
declare -a SECRET_VALUES=()
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    # Skip comments, empty lines, and keys with no value
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    [[ -z "$value" ]] && continue
    # Skip obviously safe/generic values
    [[ "$value" == "production" ]] && continue
    [[ "$value" == "true" ]] && continue
    [[ "$value" == "false" ]] && continue
    [[ ${#value} -lt 16 ]] && continue  # too short to be a secret
    # Skip file paths — never secrets
    [[ "$value" == ~/* ]] && continue
    [[ "$value" == /* ]] && continue
    # Skip URLs — not secrets
    [[ "$value" == http://* ]] && continue
    [[ "$value" == https://* ]] && continue
    [[ "$value" == ws://* ]] && continue
    # Skip env keys that are inherently non-secret (paths, ports, usernames, names)
    [[ "$key" == *_PATH ]] && continue
    [[ "$key" == *_PORT ]] && continue
    [[ "$key" == *_URL ]] && continue
    [[ "$key" == *_DIR ]] && continue
    [[ "$key" == OWNER_NAME ]] && continue
    [[ "$key" == BOT_NAME ]] && continue
    [[ "$key" == ASSISTANT_NAME ]] && continue
    [[ "$key" == NODE_ENV ]] && continue
    [[ "$key" == DASHBOARD_USERNAME ]] && continue  # login username, not a secret
    # Only include values that look like actual secrets (hex/base64/random strings)
    # Must contain at least some non-alphanumeric chars OR be long enough to be a key
    [[ ${#value} -lt 24 ]] && [[ ! "$value" =~ [^a-zA-Z0-9] ]] && continue
    SECRET_VALUES+=("$value")
  done < <(grep -v '^#' "$ENV_FILE" | grep -v '^$')
fi

# ── Patterns that are NEVER okay in committed code ───────────────────────────

while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ ! -f "$file" ] && continue

  # .env.example is always safe — it has key names but no real values
  [[ "$file" == ".env.example" ]] && continue
  # CLAUDE.md wizard has placeholder examples that look like keys — safe
  # but we still scan it for actual values leaked from .env

  CONTENT=$(cat "$file" 2>/dev/null || true)
  [ -z "$CONTENT" ] && continue

  # ── 1. Real API key patterns ───────────────────────────────────────────────

  # OpenAI keys (sk-proj-... or sk-... with 40+ chars)
  while IFS= read -r match; do
    # Exclude obvious placeholders
    [[ "$match" =~ "sk-your" ]] && continue
    [[ "$match" =~ "sk-xxx" ]] && continue
    [[ "$match" =~ "sk-..." ]] && continue
    flag "$file" "OpenAI API key" "$match"
  done < <(grep -oE 'sk-[a-zA-Z0-9_-]{20,}' "$file" 2>/dev/null || true)

  # Anthropic keys
  while IFS= read -r match; do
    [[ "$match" =~ "sk-ant-your" ]] && continue
    flag "$file" "Anthropic API key" "$match"
  done < <(grep -oE 'sk-ant-[a-zA-Z0-9_-]{20,}' "$file" 2>/dev/null || true)

  # ElevenLabs keys (32 hex chars)
  while IFS= read -r match; do
    flag "$file" "ElevenLabs API key" "$match"
  done < <(grep -oE 'ELEVENLABS_API_KEY=[a-f0-9]{32}' "$file" 2>/dev/null || true)

  # Groq keys
  while IFS= read -r match; do
    flag "$file" "Groq API key" "$match"
  done < <(grep -oE 'gsk_[a-zA-Z0-9]{40,}' "$file" 2>/dev/null || true)

  # Google API keys (AIza...)
  while IFS= read -r match; do
    flag "$file" "Google API key" "$match"
  done < <(grep -oE 'AIza[a-zA-Z0-9_-]{35}' "$file" 2>/dev/null || true)

  # Telegram bot tokens (numbers:letters format)
  while IFS= read -r match; do
    # Exclude the .env.example placeholder explanation
    [[ "$match" =~ "1234567890:AAF" ]] && continue
    flag "$file" "Telegram bot token" "$match"
  done < <(grep -oE '[0-9]{9,10}:[a-zA-Z0-9_-]{35}' "$file" 2>/dev/null || true)

  # HeyGen API keys
  while IFS= read -r match; do
    flag "$file" "HeyGen API key" "$match"
  done < <(grep -oE 'HEYGEN_API_KEY=[a-zA-Z0-9_-]{30,}' "$file" 2>/dev/null || true)

  # Moonshot keys
  while IFS= read -r match; do
    flag "$file" "Moonshot API key" "$match"
  done < <(grep -oE 'sk-[a-zA-Z0-9]{40,}' "$file" 2>/dev/null || true)

  # Binance keys
  while IFS= read -r match; do
    flag "$file" "Binance API key" "$match"
  done < <(grep -oE 'BINANCE_(API|SECRET)_KEY=[a-zA-Z0-9]{40,}' "$file" 2>/dev/null || true)

  # Cloudflare tunnel tokens (eyJ... JWTs)
  while IFS= read -r match; do
    [[ ${#match} -lt 100 ]] && continue  # short JWTs are test/example tokens
    flag "$file" "Cloudflare tunnel token (JWT)" "${match:0:60}..."
  done < <(grep -oE 'eyJ[a-zA-Z0-9_-]{50,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}' "$file" 2>/dev/null || true)

  # Generic Bearer tokens in Authorization headers
  while IFS= read -r match; do
    [[ "$match" =~ "Bearer YOUR" ]] && continue
    [[ "$match" =~ "Bearer \$" ]] && continue   # shell variable reference — safe
    [[ "$match" =~ "Bearer <" ]] && continue    # placeholder
    [[ ${#match} -lt 40 ]] && continue
    flag "$file" "Hardcoded Bearer token" "$match"
  done < <(grep -oE 'Bearer [a-zA-Z0-9_.-]{30,}' "$file" 2>/dev/null || true)

  # Twitter/X session cookies (what we had before)
  while IFS= read -r match; do
    flag "$file" "Twitter/X auth_token cookie" "$match"
  done < <(grep -oE 'auth_token[^a-zA-Z0-9][a-f0-9]{40}' "$file" 2>/dev/null || true)
  while IFS= read -r match; do
    flag "$file" "Twitter/X ct0 cookie" "$match"
  done < <(grep -oE 'ct0[^a-zA-Z0-9][a-f0-9]{32,}' "$file" 2>/dev/null || true)

  # Slack tokens
  while IFS= read -r match; do
    # Skip obvious placeholders
    [[ "$match" =~ "your-token" ]] && continue
    [[ "$match" =~ "your_token" ]] && continue
    [[ "$match" =~ "xxx" ]] && continue
    [[ "$match" =~ "YOUR" ]] && continue
    flag "$file" "Slack token" "$match"
  done < <(grep -oE 'xox[bpsa]-[a-zA-Z0-9-]{10,}' "$file" 2>/dev/null || true)

  # Vapi keys
  while IFS= read -r match; do
    flag "$file" "Vapi API key" "$match"
  done < <(grep -oE 'VAPI_API_KEY=[a-zA-Z0-9_-]{20,}' "$file" 2>/dev/null || true)

  # ── 2. Personal data that must never be hardcoded ─────────────────────────

  # Hardcoded Telegram chat IDs (9-10 digit numbers in code context)
  # We look for them assigned to variables, not just any number
  while IFS= read -r match; do
    # Skip if it's inside ALLOWED_CHAT_ID= (that's the env var, fine)
    [[ "$match" =~ "ALLOWED_CHAT_ID" ]] && continue
    [[ "$match" =~ "CHAT_ID=" ]] && continue   # env var assignment = fine
    # Skip if it's a comment example
    grep -n "$match" "$file" | grep -q '^\s*[#/]' && continue
    flag "$file" "Hardcoded Telegram chat ID" "$match"
  done < <(grep -oE "(chat_id|CHAT_ID|chatId)['\": ]+[0-9]{9,10}" "$file" 2>/dev/null || true)

  # Phone numbers (Mexican/international format hardcoded in code)
  while IFS= read -r match; do
    # Skip examples in comments and .md files
    [[ "$file" == *.md ]] && continue
    [[ "$match" =~ "52 81" ]] && flag "$file" "Hardcoded phone number" "$match" || true
    [[ "$match" =~ "+52" ]] && [[ ${#match} -gt 10 ]] && flag "$file" "Hardcoded phone number" "$match" || true
  done < <(grep -oE '\+52[0-9 ]{8,}' "$file" 2>/dev/null || true)

  # Personal emails hardcoded (not opoclaw@gmail.com which is the business email)
  while IFS= read -r match; do
    [[ "$match" =~ "opoclaw@gmail.com" ]] && continue    # business email — fine
    [[ "$match" =~ "example.com" ]] && continue           # placeholder
    [[ "$match" =~ "your@email" ]] && continue
    [[ "$match" =~ "you@" ]] && continue
    [[ "$file" == *.md ]] && continue                     # docs use example emails
    flag "$file" "Hardcoded personal email" "$match"
  done < <(grep -oE '[a-zA-Z0-9._%+-]+@(gmail|hotmail|yahoo|icloud|outlook)\.(com|mx)' "$file" 2>/dev/null || true)

  # ── 3. Known weak hardcoded defaults ─────────────────────────────────────
  # These are values that were once hardcoded defaults and must never reappear
  while IFS= read -r match; do
    [[ "$file" == *".env.example" ]] && continue
    [[ "$file" == *"security-check.sh" ]] && continue   # this file itself
    flag "$file" "Weak hardcoded default token" "$match"
  done < <(grep -oE "(thorn2026|changeme|secret123|password123|your_token_here)" "$file" 2>/dev/null || true)

  # ── 4. Actual .env values leaked into code ────────────────────────────────
  # Check if any real secret value from .env appears verbatim in the file
  for secret in "${SECRET_VALUES[@]}"; do
    [[ ${#secret} -lt 16 ]] && continue
    if grep -qF "$secret" "$file" 2>/dev/null; then
      LINE=$(grep -nF "$secret" "$file" | head -1)
      [[ "$LINE" =~ '\$' ]] && continue
      [[ "$LINE" =~ 'process.env' ]] && continue
      [[ "$LINE" =~ 'os.environ' ]] && continue
      flag "$file" "Literal .env secret value found in code" "${LINE:0:80}"
    fi
  done

done <<< "$SCAN_FILES"

# ── Result ───────────────────────────────────────────────────────────────────

if [ "$FOUND" -eq 0 ]; then
  echo "[$(date)] security-check: CLEAN — nothing sensitive found." >> "$LOG"
  exit 0
fi

# ── Save blocked files list for morning podcast ───────────────────────────────
MORNING_LOG="/tmp/security-morning-report.txt"
{
  echo "=== SECURITY ALERT — $(date '+%Y-%m-%d') ==="
  echo "Sensitive data was detected in the following files during the nightly push."
  echo "These files were NOT pushed to GitHub. Review and fix before next push."
  echo ""
  cat "$ALERT_LOG" 2>/dev/null
  echo ""
  echo "Full log: $ALERT_LOG"
} >> "$MORNING_LOG"

echo "[$(date)] security-check: blocked files logged to $MORNING_LOG for morning podcast." >> "$LOG"

# ── DO NOT alert via Telegram at night (nightly silence rule) ─────────────────
# Alerts go ONLY into the morning podcast via /tmp/security-morning-report.txt
# The morning brief script reads this file and includes the alert in the podcast.
# Exception: if this is called manually during the day, print to stdout only.
HOUR=$(date +%H)
if [ "$HOUR" -lt 22 ] && [ "$HOUR" -ge 7 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  SECURITY CHECK FAILED — FILES WILL NOT BE PUSHED           ║"
  echo "║  Sensitive data detected. See details above.                ║"
  echo "║  Full log: $ALERT_LOG"
  echo "╚══════════════════════════════════════════════════════════════╝"
fi

exit 1
