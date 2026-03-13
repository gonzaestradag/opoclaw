#!/bin/bash
# wizard-sync.sh — Auto-update CLAUDE.md wizard when new features land
# Called by nightly-git-push.sh before committing.
#
# What it does:
#   1. Detects new .env.example variables not yet mentioned in the wizard
#   2. Detects new scripts/integrations added since last wizard update
#   3. Uses Claude to write wizard instructions for anything missing
#   4. Patches CLAUDE.md in place — nightly push picks it up automatically

set -e

REPO="/Users/opoclaw1/claudeclaw"
CLAUDE_MD="$REPO/CLAUDE.md"
ENV_EXAMPLE="$REPO/.env.example"
LOG="/tmp/wizard-sync.log"

cd "$REPO"

echo "[$(date)] wizard-sync: starting..." >> "$LOG"

# ── 1. Extract env var names from .env.example ──────────────────────────────
# Only non-commented, non-empty lines that define a KEY=
ENV_VARS=$(grep -E '^[A-Z_]+=?' "$ENV_EXAMPLE" 2>/dev/null \
  | sed 's/=.*//' \
  | sort)

# ── 2. Find vars missing from the wizard section of CLAUDE.md ───────────────
# The wizard section ends at "Do not read the rest of this file"
WIZARD_SECTION=$(awk '/^## FRESH INSTALL DETECTION/,/^Do not read the rest of this file/' "$CLAUDE_MD")

MISSING_VARS=""
while IFS= read -r var; do
  if ! echo "$WIZARD_SECTION" | grep -q "$var"; then
    MISSING_VARS="${MISSING_VARS}${var}\n"
  fi
done <<< "$ENV_VARS"

# ── 3. Check if any scripts were added/changed since last wizard touch ───────
WIZARD_MTIME=$(stat -f %m "$CLAUDE_MD" 2>/dev/null || echo 0)
NEW_SCRIPTS=$(find "$REPO/scripts" -name "*.sh" -o -name "*.cjs" -o -name "*.ts" 2>/dev/null \
  | while read f; do
      FMTIME=$(stat -f %m "$f" 2>/dev/null || echo 0)
      [ "$FMTIME" -gt "$WIZARD_MTIME" ] && echo "$f"
    done | head -20)

# ── 4. Build change summary for Claude ──────────────────────────────────────
if [ -z "$MISSING_VARS" ] && [ -z "$NEW_SCRIPTS" ]; then
  echo "[$(date)] wizard-sync: nothing new to document — skipping." >> "$LOG"
  exit 0
fi

CHANGE_SUMMARY=""
if [ -n "$MISSING_VARS" ]; then
  CHANGE_SUMMARY="${CHANGE_SUMMARY}New .env vars not yet in wizard:\n${MISSING_VARS}\n"
fi
if [ -n "$NEW_SCRIPTS" ]; then
  CHANGE_SUMMARY="${CHANGE_SUMMARY}New/modified scripts since last wizard update:\n${NEW_SCRIPTS}\n"
fi

echo "[$(date)] wizard-sync: found changes — asking Claude to update wizard..." >> "$LOG"
echo -e "$CHANGE_SUMMARY" >> "$LOG"

# ── 5. Ask Claude to patch the wizard ───────────────────────────────────────
# We give it the current CLAUDE.md wizard section + what's new, and ask it
# to insert the right wizard steps. It edits the file directly.

PROMPT="You are updating the OpoClaw setup wizard in CLAUDE.md.

The wizard is the section from '## FRESH INSTALL DETECTION' up to 'Do not read the rest of this file'.

The following changes were detected in the codebase that may need wizard setup steps:

$(echo -e "$CHANGE_SUMMARY")

Your job:
1. Read CLAUDE.md at $CLAUDE_MD
2. For each new .env variable listed above, check if it belongs in the wizard (i.e. it needs user input during setup). Skip internal/auto-generated vars (DASHBOARD_TOKEN, *_HASH, *_ID vars that get auto-filled, etc.).
3. For any new scripts that represent a user-facing integration (not internal utilities), check if they need a setup step in the wizard.
4. For anything that genuinely needs a new wizard step: insert it into the correct Section (1=Telegram, 2=Voice, 3=AI Models, 4=Google OAuth, 5=Optional Integrations). Match the existing style exactly — bilingual EN/ES, explicit options in parentheses, double confirmation for skippable steps.
5. If nothing needs a user-facing setup step, do nothing and exit.
6. Only add what's genuinely new. Do not duplicate existing steps.
7. Do not touch anything outside the wizard section.

Make the edits directly to $CLAUDE_MD."

# Run claude non-interactively with a timeout
if command -v claude &>/dev/null; then
  echo "$PROMPT" | timeout 120 claude --dangerously-skip-permissions -p - 2>> "$LOG" && \
    echo "[$(date)] wizard-sync: Claude updated the wizard." >> "$LOG" || \
    echo "[$(date)] wizard-sync: Claude returned non-zero (may be nothing to do)." >> "$LOG"
else
  echo "[$(date)] wizard-sync: claude CLI not found — skipping." >> "$LOG"
  exit 0
fi

echo "[$(date)] wizard-sync: done." >> "$LOG"
