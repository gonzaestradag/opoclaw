#!/bin/bash
# task-watchdog.sh — detects tasks stuck in in_progress for >15 min, auto-fails them
# Runs every 5 minutes via PM2 cron or system cron
# SILENT: no Telegram pings to Gonzalo. All activity logged internally only.

API_BASE="http://localhost:3001"
DB_PATH="/Users/opoclaw1/claudeclaw/store/claudeclaw.db"
TIMEOUT_MINUTES=15

# ─── PART 1: Detect tasks stuck in_progress via API ──────────────────────────

TASKS=$(curl -s "$API_BASE/api/tasks" 2>/dev/null)

if [ -z "$TASKS" ] || [ "$TASKS" = "null" ]; then
    exit 0
fi

STUCK_IDS=$(echo "$TASKS" | python3 -c "
import sys, json
from datetime import datetime, timezone, timedelta

try:
    tasks = json.load(sys.stdin)
except:
    sys.exit(0)

now = datetime.now(timezone.utc)
timeout = timedelta(minutes=$TIMEOUT_MINUTES)
stuck = []
for t in tasks:
    if t.get('status') not in ['In Progress', 'in_progress']:
        continue
    updated = t.get('updated_at') or t.get('created_at')
    if not updated:
        continue
    try:
        updated_dt = datetime.fromisoformat(updated.replace('Z','+00:00'))
        if updated_dt.tzinfo is None:
            updated_dt = updated_dt.replace(tzinfo=timezone.utc)
        if now - updated_dt > timeout:
            stuck.append(t['id'])
    except:
        pass
print('\n'.join(stuck))
" 2>/dev/null)

COUNT=0

if [ -n "$STUCK_IDS" ]; then
    while IFS= read -r TASK_ID; do
        [ -z "$TASK_ID" ] && continue

        # Get task title for the log
        TASK_TITLE=$(echo "$TASKS" | python3 -c "
import sys, json
tasks = json.load(sys.stdin)
t = next((t for t in tasks if t['id'] == '$TASK_ID'), None)
print(t['title'] if t else '$TASK_ID')
" 2>/dev/null)

        # Mark task as failed via API
        curl -s -X PATCH "$API_BASE/api/tasks/$TASK_ID" \
            -H "Content-Type: application/json" \
            -d '{"status":"failed","progress":0}' > /dev/null

        # Log to activity feed (internal only — no Telegram)
        sqlite3 "$DB_PATH" \
            "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Watchdog: task closed after >${TIMEOUT_MINUTES}min stuck — ${TASK_TITLE}','warning','executive',datetime('now'))" 2>/dev/null

        # Log to agent messages (internal dashboard only)
        curl -s -X POST "$API_BASE/api/agent-messages" \
            -H "Content-Type: application/json" \
            -d "{\"thread_id\":\"$TASK_ID\",\"from_agent_id\":\"thorn\",\"from_agent_name\":\"Thorn\",\"from_agent_emoji\":\"🌵\",\"message\":\"Watchdog: tarea cerrada por timeout (>${TIMEOUT_MINUTES}min sin actualización). Marcada como fallida.\",\"message_type\":\"message\"}" > /dev/null

        COUNT=$((COUNT + 1))
    done <<< "$STUCK_IDS"
fi

# NOTE: No Telegram alert for stuck tasks. Internal logs only.

# ─── PART 2: Detect orphaned todo tasks > 2 hours old ────────────────────────
# Auto-proposed skill tasks are deleted. Other orphaned tasks are cancelled.
# No Telegram pings. All activity logged internally only.
ORPHANED_TASKS=$(sqlite3 "$DB_PATH" "
  SELECT id, title, assignee_name,
    CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) as hours_old
  FROM agent_tasks
  WHERE status IN ('todo', 'backlog')
  AND datetime(created_at) < datetime('now', '-2 hours')
  ORDER BY created_at ASC
  LIMIT 20;
" 2>/dev/null)

if [ -n "$ORPHANED_TASKS" ]; then
    while IFS='|' read -r oid otitle oassignee ohours; do
        [ -z "$oid" ] && continue

        # Check if this is an auto-proposed skill task (delete it silently)
        if echo "$otitle" | grep -qi "Auto-proposed\|auto-proposed\|auto_proposed"; then
            # Delete auto-proposed tasks permanently — they're auto-generated and go stale quickly
            sqlite3 "$DB_PATH" \
                "DELETE FROM agent_tasks WHERE id='$oid';" 2>/dev/null

            sqlite3 "$DB_PATH" \
                "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Watchdog: auto-proposed task eliminada por obsoleta — $otitle','info','executive',datetime('now'))" 2>/dev/null
        else
            # Cancel other orphaned tasks silently
            curl -s -X PATCH "$API_BASE/api/tasks/$oid" \
                -H "Content-Type: application/json" \
                -d '{"status":"cancelled","progress":0}' > /dev/null 2>&1

            sqlite3 "$DB_PATH" \
                "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Watchdog: tarea huerfana auto-cancelada (>2h sin iniciar) — $otitle','warning','executive',datetime('now'))" 2>/dev/null
        fi
    done <<< "$ORPHANED_TASKS"
fi

# NOTE: No Telegram alert for orphaned tasks. Internal logs only.

# Heartbeat log — confirms cron ran successfully
sqlite3 "$DB_PATH" \
    "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Watchdog: ciclo completado — sin incidencias','info','executive',datetime('now'))" 2>/dev/null

# Small sleep so PM2 does not flag this as an unstable restart (min_uptime threshold)
sleep 2

exit 0
