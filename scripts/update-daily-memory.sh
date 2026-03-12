#!/usr/bin/env bash
# update-daily-memory.sh — Updates today's daily memory document
# Runs every 30 min via cron. Replaces (upserts) the day's entry in SQLite.
# Never sends Telegram messages.

DB_PATH="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
TODAY=$(date '+%Y-%m-%d')
TODAY_LONG=$(date '+%A, %B %-d %Y')
NOW=$(date '+%H:%M')

# --- Gather data for today ---

TASKS_ACTIVE=$(sqlite3 "$DB_PATH" "
  SELECT '- ' || assignee_name || ' — ' || title || ' (' || COALESCE(progress,0) || '% completado)'
  FROM agent_tasks
  WHERE status = 'in_progress'
  ORDER BY updated_at DESC LIMIT 15;
" 2>/dev/null)

TASKS_DONE=$(sqlite3 "$DB_PATH" "
  SELECT '- [' || COALESCE(strftime('%H:%M', updated_at),'-') || '] ' || assignee_name || ' — ' || title
  FROM agent_tasks
  WHERE status = 'done' AND date(updated_at) = '$TODAY'
  ORDER BY updated_at DESC LIMIT 20;
" 2>/dev/null)

TASKS_FAILED=$(sqlite3 "$DB_PATH" "
  SELECT '- ' || assignee_name || ' — ' || title
  FROM agent_tasks
  WHERE status = 'failed' AND date(updated_at) = '$TODAY'
  ORDER BY updated_at DESC LIMIT 10;
" 2>/dev/null)

ERRORS=$(sqlite3 "$DB_PATH" "
  SELECT '- [' || COALESCE(strftime('%H:%M', created_at),'-') || '] ' || agent_name || ': ' || action
  FROM agent_activity
  WHERE type = 'error' AND date(created_at) = '$TODAY'
  ORDER BY created_at DESC LIMIT 15;
" 2>/dev/null)

FIXES=$(sqlite3 "$DB_PATH" "
  SELECT '- [' || COALESCE(strftime('%H:%M', created_at),'-') || '] ' || agent_name || ': ' || action
  FROM agent_activity
  WHERE type = 'success' AND date(created_at) = '$TODAY'
    AND (action LIKE '%Monitor%' OR action LIKE '%Watchdog%' OR action LIKE '%arregl%' OR action LIKE '%reinici%' OR action LIKE '%fix%')
  ORDER BY created_at DESC LIMIT 10;
" 2>/dev/null)

AGENT_ACTIVITY=$(sqlite3 "$DB_PATH" "
  SELECT '- ' || agent_name || ': ' || COUNT(*) || ' acciones'
  FROM agent_activity
  WHERE date(created_at) = '$TODAY'
  GROUP BY agent_name
  ORDER BY COUNT(*) DESC LIMIT 12;
" 2>/dev/null)

RECENT_ACTIVITY=$(sqlite3 "$DB_PATH" "
  SELECT '- [' || COALESCE(strftime('%H:%M', created_at),'-') || '] ' || agent_name || ': ' || action
  FROM agent_activity
  WHERE date(created_at) = '$TODAY' AND type IN ('success','info','task')
  ORDER BY created_at DESC LIMIT 20;
" 2>/dev/null)

COST_TODAY=$(sqlite3 "$DB_PATH" "
  SELECT ROUND(SUM(cost_usd), 4)
  FROM llm_usage
  WHERE date(created_at) = '$TODAY';
" 2>/dev/null)

TOTAL_DONE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agent_tasks WHERE status='done' AND date(updated_at)='$TODAY';" 2>/dev/null)
TOTAL_ACTIVE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agent_tasks WHERE status='in_progress';" 2>/dev/null)
TOTAL_FAILED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agent_tasks WHERE status='failed' AND date(updated_at)='$TODAY';" 2>/dev/null)

# --- Build the daily memory document ---
CONTENT="# $TODAY_LONG
_Ultima actualizacion: $NOW — documento auto-generado cada 30 min_

---

## Resumen del Dia
- Tareas completadas hoy: ${TOTAL_DONE:-0}
- Tareas en curso ahorita: ${TOTAL_ACTIVE:-0}
- Tareas fallidas hoy: ${TOTAL_FAILED:-0}
- Costo del dia: \$${COST_TODAY:-0.00}

---

## Tareas En Curso
$([ -n "$TASKS_ACTIVE" ] && echo "$TASKS_ACTIVE" || echo "- Ninguna en este momento")

---

## Completadas Hoy
$([ -n "$TASKS_DONE" ] && echo "$TASKS_DONE" || echo "- Ninguna aun")

---

## Fallidas Hoy
$([ -n "$TASKS_FAILED" ] && echo "$TASKS_FAILED" || echo "- Ninguna")

---

## Errores Detectados
$([ -n "$ERRORS" ] && echo "$ERRORS" || echo "- Sin errores")

---

## Arreglos Automaticos
$([ -n "$FIXES" ] && echo "$FIXES" || echo "- Ninguno necesario")

---

## Actividad de Agentes (acciones totales hoy)
$([ -n "$AGENT_ACTIVITY" ] && echo "$AGENT_ACTIVITY" || echo "- Sin actividad registrada")

---

## Log de Actividad Reciente
$([ -n "$RECENT_ACTIVITY" ] && echo "$RECENT_ACTIVITY" || echo "- Sin actividad")
"

# --- Upsert into SQLite memories table ---
EPOCH=$(date +%s)
python3 << PYEOF
import sqlite3, sys
db = sqlite3.connect("$DB_PATH")
content = """$CONTENT"""
today = "$TODAY"
exists = db.execute("SELECT id FROM memories WHERE sector='daily' AND topic_key='daily_' || ? LIMIT 1", (today,)).fetchone()
if exists:
    db.execute("UPDATE memories SET content=?, accessed_at=? WHERE id=?", (content, $EPOCH, exists[0]))
else:
    db.execute("INSERT INTO memories (chat_id,topic_key,content,sector,salience,created_at,accessed_at) VALUES (?,?,?,?,?,?,?)",
        ("opoclaw-system", f"daily_{today}", content, "daily", 3.0, $EPOCH, $EPOCH))
db.commit()
db.close()
PYEOF

echo "[memory] Daily memory updated for $TODAY at $NOW"
