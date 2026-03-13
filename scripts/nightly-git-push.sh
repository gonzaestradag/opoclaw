#!/bin/bash
# Nightly Git Push — runs at 2 AM via PM2 cron
# Commits any system changes (code, scripts, dashboard, etc.) and pushes to GitHub
# Never touches: .env, store/, workspace/, opo-work/, tradesv3.sqlite (covered by .gitignore)

set -e

REPO="/Users/opoclaw1/claudeclaw"
BRANCH="main"
LOG="/tmp/nightly-git-push.log"

cd "$REPO"

echo "[$(date)] Starting nightly git push..." >> "$LOG"

# ── Sync wizard before committing ───────────────────────────────────────────
# Detects new features/env vars and auto-updates CLAUDE.md wizard section
bash "$REPO/scripts/wizard-sync.sh" || true   # never block the push if this fails

# Stage all changes (safe — .gitignore blocks sensitive files)
git add -A

# ── Security scan — auto-unstage any flagged files, push everything else ─────
# Scans staged files for API keys, tokens, hardcoded defaults, etc.
# If something is found: unstage ONLY those files, log for morning podcast,
# then continue pushing everything else clean. Never blocks the whole push.
> /tmp/security-check-BLOCKED.log   # reset from previous runs
if ! bash "$REPO/scripts/security-check.sh" 2>&1; then
  echo "[$(date)] Security issues found — auto-unstaging flagged files." >> "$LOG"

  # Extract the filenames that were flagged from the block log
  FLAGGED=$(grep "BLOCKED:" /tmp/security-check-BLOCKED.log 2>/dev/null \
    | sed 's/.*BLOCKED: //' | sed 's/ —.*//' | sort -u)

  if [ -n "$FLAGGED" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      git restore --staged "$f" 2>/dev/null || true
      echo "[$(date)] Unstaged: $f" >> "$LOG"
    done <<< "$FLAGGED"
  fi

  # After unstaging, re-check if there's still something to commit
  if git diff --cached --quiet; then
    echo "[$(date)] Nothing left to commit after unstaging flagged files — skipping push." >> "$LOG"
    exit 0
  fi
fi

# Only commit if there's actually something to commit
if git diff --cached --quiet; then
  echo "[$(date)] Nothing to commit — skipping." >> "$LOG"
  exit 0
fi

DATE=$(date '+%Y-%m-%d')
COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')

git commit -m "Nightly system update ${DATE} — ${COUNT} files

Auto-commit: scripts, dashboard, agent configs, strategy updates.
No personal data. API keys excluded via .gitignore.

Co-Authored-By: Thorn <noreply@opoclaw.com>"

git push origin "$BRANCH"

echo "[$(date)] Push complete — ${COUNT} files updated." >> "$LOG"

# ── Append security report to nightly summary (picked up by morning podcast) ──
SECURITY_REPORT="/tmp/security-morning-report.txt"
NIGHTLY_SUMMARY="/tmp/nightly_summary.txt"
if [ -s "$SECURITY_REPORT" ]; then
  echo "" >> "$NIGHTLY_SUMMARY"
  echo "=== SECURITY — ARCHIVOS NO PUSHEADOS ===" >> "$NIGHTLY_SUMMARY"
  cat "$SECURITY_REPORT" >> "$NIGHTLY_SUMMARY"
  echo "" >> "$NIGHTLY_SUMMARY"
  > "$SECURITY_REPORT"   # clear after appending so it doesn't repeat tomorrow
  echo "[$(date)] Security report appended to nightly_summary.txt for morning podcast." >> "$LOG"
fi
