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

# Stage all changes (safe — .gitignore blocks sensitive files)
git add -A

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
