#!/usr/bin/env bash
# update-general-memory.sh — Updates the master system memory document
# Runs weekly (or manually). This is the fallback brain for when things fail.

DB_PATH="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
NOW=$(date '+%Y-%m-%d %H:%M')

# --- Top agents by completed tasks ---
TOP_AGENTS=$(sqlite3 "$DB_PATH" "
  SELECT assignee_name, COUNT(*) as done
  FROM agent_tasks WHERE status = 'done'
  GROUP BY assignee_name ORDER BY done DESC LIMIT 8;
" 2>/dev/null | tr '|' ': ' | sed 's/^/- /')

# --- Most common task types ---
TOP_TASKS=$(sqlite3 "$DB_PATH" "
  SELECT title, COUNT(*) as cnt
  FROM agent_tasks
  WHERE status = 'done'
  GROUP BY title ORDER BY cnt DESC LIMIT 10;
" 2>/dev/null | tr '|' ' x ' | sed 's/^/- /')

# --- Error patterns (last 30 days) ---
ERROR_PATTERNS=$(sqlite3 "$DB_PATH" "
  SELECT action, COUNT(*) as cnt
  FROM agent_activity
  WHERE type = 'error' AND created_at > datetime('now', '-30 days')
  GROUP BY action ORDER BY cnt DESC LIMIT 8;
" 2>/dev/null | tr '|' ' — ' | sed 's/^/- /')

# --- Cost summary ---
COST_WEEK=$(sqlite3 "$DB_PATH" "SELECT ROUND(SUM(cost_usd),4) FROM llm_usage WHERE created_at > datetime('now','-7 days');" 2>/dev/null)
COST_MONTH=$(sqlite3 "$DB_PATH" "SELECT ROUND(SUM(cost_usd),4) FROM llm_usage WHERE created_at > datetime('now','-30 days');" 2>/dev/null)

# --- Total tasks ---
TOTAL_DONE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agent_tasks WHERE status='done';" 2>/dev/null)
TOTAL_FAILED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agent_tasks WHERE status='failed';" 2>/dev/null)

CONTENT="# General System Memory — OpoClaw
Last updated: $NOW

## System Overview
- 12 AI agents orchestrated by Thorn (COO)
- Node.js gateway on port 4000 (PM2: openclaw-gateway)
- Dashboard on port 3001 (PM2: dashboard-server)
- SQLite DB: /Users/opoclaw1/claudeclaw/store/opoclaw.db
- Neon PostgreSQL: secondary, used by gateway
- ngrok tunnel: keisha-inescapable-clavately.ngrok-free.dev → localhost:3001

## Critical Commands
- Deploy dashboard: bash /Users/opoclaw1/claudeclaw/scripts/deploy-dashboard.sh
- Restart gateway: pm2 restart openclaw-gateway --update-env
- View PM2 status: pm2 list
- View logs: pm2 logs dashboard-server

## Agent Roster (active)
- Thorn (COO, executive) — thorn
- Marcus (Engineering Director) — marcus-reyes
- Lucas (Frontend) — lucas-park
- Elias (Backend) — elias-mora
- Silas (DevOps/Automation) — silas-vane
- Rafael (Intelligence) — rafael-silva
- Kaelen (Deep Research) — kaelen-ward
- Maya (Operations) — maya-chen
- Jordan (Finance) — jordan-walsh
- Sofia (Content) — sofia-ramos
- Aria (Strategy) — aria-nakamura

## Top Agents by Completed Work
$TOP_AGENTS

## Most Common Task Types
$TOP_TASKS

## Recurring Error Patterns (last 30 days)
${ERROR_PATTERNS:-None recorded}

## Cost Summary
- Last 7 days: \$${COST_WEEK:-0}
- Last 30 days: \$${COST_MONTH:-0}

## Task Stats (all time)
- Completed: ${TOTAL_DONE:-0}
- Failed: ${TOTAL_FAILED:-0}

## Key Architectural Decisions
- Dashboard uses compiled dist/ — always run deploy-dashboard.sh after code changes
- API calls use runtime URL resolution — works from localhost AND ngrok
- Watchdog runs every 15 min — auto-retries stuck tasks up to 2x, then escalates
- Daily memory updates every 30 min — sector='daily' in memories table
- Night mode runs at 2 AM — silent, logs to /tmp/nightly_summary.txt
- Morning brief runs at 7 AM — generates audio + stores in /api/briefs
"

EPOCH=$(date +%s)
python3 << PYEOF
import sqlite3
db = sqlite3.connect("$DB_PATH")
content = """$CONTENT"""
exists = db.execute("SELECT id FROM memories WHERE sector='general' LIMIT 1").fetchone()
if exists:
    db.execute("UPDATE memories SET content=?, accessed_at=? WHERE id=?", (content, $EPOCH, exists[0]))
else:
    db.execute("INSERT INTO memories (chat_id,topic_key,content,sector,salience,created_at,accessed_at) VALUES (?,?,?,?,?,?,?)",
        ("opoclaw-system", "general", content, "general", 5.0, $EPOCH, $EPOCH))
db.commit()
db.close()
PYEOF

echo "[memory] General memory updated at $NOW"
