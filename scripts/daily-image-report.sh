#!/bin/bash
# daily-image-report.sh — Reporte visual diario via DALL-E 3 + Telegram
# Corre a las 8pm todos los dias via scheduled_tasks

set -euo pipefail

DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"

# Load credentials (use grep with default empty to avoid unbound variable errors)
OPENAI_API_KEY=$(grep -E '^OPENAI_API_KEY=' "$ENV_FILE" | cut -d= -f2 || true)
BOT_TOKEN=$(grep -E '^BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
ALLOWED_CHAT_ID=$(grep -E '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- || true)

TOKEN="${BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
CHAT="${ALLOWED_CHAT_ID:-}"

TODAY=$(date '+%Y-%m-%d')
TODAY_LABEL=$(date '+%B %d, %Y')
MONTH=$(date '+%Y-%m')

echo "[$TODAY] Starting daily image report..."

# --- GATHER DATA ---

# Agent actions today (success + task types)
AGENT_ACTIONS=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM agent_activity
  WHERE date(created_at) = '$TODAY'
    AND type IN ('success', 'task');
")

# Tasks completed today
TASKS_DONE=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM agent_tasks
  WHERE date(updated_at) = '$TODAY'
    AND status = 'done';
")

# Total tasks in progress or done today
TASKS_ACTIVE=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM agent_tasks
  WHERE date(updated_at) = '$TODAY';
")

# AI cost today
LLM_TODAY_A=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(cost_usd), 4), 0)
  FROM llm_costs
  WHERE date(created_at) = '$TODAY';
")

LLM_TODAY_B=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(cost_usd), 4), 0)
  FROM token_usage
  WHERE date(created_at, 'unixepoch') = '$TODAY';
")

LLM_TODAY=$(python3 -c "print(round($LLM_TODAY_A + $LLM_TODAY_B, 4))")

# Income today
INCOME_TODAY=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(amount), 2), 0)
  FROM financial_transactions
  WHERE type = 'income'
    AND date(created_at) = '$TODAY'
    AND amount > 0;
")

# Income this month
INCOME_MONTH=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(amount), 2), 0)
  FROM financial_transactions
  WHERE type = 'income'
    AND strftime('%Y-%m', created_at) = '$MONTH'
    AND amount > 0;
")

# Trading/crypto activity today
TRADING_ACTIVITY=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM agent_activity
  WHERE date(created_at) = '$TODAY'
    AND (
      lower(action) LIKE '%trading%'
      OR lower(action) LIKE '%crypto%'
      OR lower(action) LIKE '%trade%'
      OR lower(action) LIKE '%bitcoin%'
      OR lower(action) LIKE '%btc%'
    );
")

# Most active agent today
TOP_AGENT=$(sqlite3 "$DB" "
  SELECT agent_name
  FROM agent_activity
  WHERE date(created_at) = '$TODAY'
  GROUP BY agent_name
  ORDER BY COUNT(*) DESC
  LIMIT 1;
")

TOP_AGENT="${TOP_AGENT:-Sin actividad}"

# Revenue status for image prompt
INCOME_TODAY_POS=$(python3 -c "print(1 if float('${INCOME_TODAY}') > 0 else 0)" 2>/dev/null || echo 0)
INCOME_MONTH_POS=$(python3 -c "print(1 if float('${INCOME_MONTH}') > 0 else 0)" 2>/dev/null || echo 0)

if [ "$INCOME_TODAY_POS" = "1" ]; then
  REVENUE_STATUS="revenue: \$${INCOME_TODAY} today"
elif [ "$INCOME_MONTH_POS" = "1" ]; then
  REVENUE_STATUS="monthly revenue: \$${INCOME_MONTH}, no new income today"
else
  REVENUE_STATUS="revenue tracking active, no new transactions today"
fi

# Trading status
if [ "$TRADING_ACTIVITY" -gt 0 ]; then
  TRADING_NOTE="${TRADING_ACTIVITY} trading signals processed"
else
  TRADING_NOTE="no trading activity"
fi

echo "Data gathered: actions=$AGENT_ACTIONS tasks_done=$TASKS_DONE llm_cost=\$$LLM_TODAY income=\$$INCOME_TODAY trading=$TRADING_ACTIVITY"

# --- BUILD DALL-E PROMPT ---
IMAGE_PROMPT="Cinematic sci-fi mission control dashboard, dark teal background, glowing orange holographic UI panels, dramatic rim lighting. The screen shows 'OpoClaw AI — ${TODAY_LABEL}'. Floating data displays show: ${AGENT_ACTIONS} ops completed, ${TASKS_DONE} tasks done, AI cost \$${LLM_TODAY}, ${REVENUE_STATUS}, ${TRADING_NOTE}. The main agent shown is '${TOP_AGENT}'. Pixar 3D animated style, ultra-detailed, photorealistic lighting, deep shadows, futuristic command center aesthetic. No real people, pure interface visualization."

echo "Generating image with DALL-E 3..."

# --- GENERATE IMAGE ---
PORTRAIT_RESPONSE=$(curl -s -X POST https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"dall-e-3\",
    \"prompt\": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$IMAGE_PROMPT"),
    \"n\": 1,
    \"size\": \"1024x1024\",
    \"quality\": \"standard\"
  }")

# Check for error
if echo "$PORTRAIT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'data' in d else 1)" 2>/dev/null; then
  IMAGE_URL=$(echo "$PORTRAIT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['url'])")
else
  ERROR=$(echo "$PORTRAIT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message','Unknown error'))" 2>/dev/null || echo "Unknown error")
  echo "DALL-E error: $ERROR"
  sqlite3 "$DB" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','⚙️','Error generando imagen diaria: $ERROR','error','engineering',datetime('now'))"
  exit 1
fi

echo "Image generated. Downloading..."

# --- DOWNLOAD IMAGE ---
curl -s "$IMAGE_URL" -o /tmp/daily-report.png

if [ ! -f /tmp/daily-report.png ] || [ ! -s /tmp/daily-report.png ]; then
  echo "Error: image file is empty or missing"
  exit 1
fi

echo "Image downloaded. Building caption..."

# --- BUILD CAPTION ---
if [ "$INCOME_TODAY_POS" = "1" ]; then
  REVENUE_CAPTION="Ingresos hoy: \$$INCOME_TODAY."
elif [ "$INCOME_MONTH_POS" = "1" ]; then
  REVENUE_CAPTION="Ingresos este mes: \$$INCOME_MONTH."
else
  REVENUE_CAPTION="Sin transacciones registradas hoy."
fi

if [ "$TRADING_ACTIVITY" -gt 0 ]; then
  TRADING_CAPTION=" Actividad de trading: $TRADING_ACTIVITY senales procesadas."
else
  TRADING_CAPTION=""
fi

CAPTION="OpoClaw | $TODAY_LABEL. Agente mas activo: $TOP_AGENT. Operaciones completadas: $AGENT_ACTIONS. Tareas listas: $TASKS_DONE. Costo IA: \$$LLM_TODAY. $REVENUE_CAPTION$TRADING_CAPTION"

echo "Sending to Telegram..."

# --- SEND TO TELEGRAM ---
SEND_RESULT=$(curl -s \
  -F "chat_id=$CHAT" \
  -F "photo=@/tmp/daily-report.png" \
  -F "caption=$CAPTION" \
  "https://api.telegram.org/bot${TOKEN}/sendPhoto")

if echo "$SEND_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" 2>/dev/null; then
  echo "Photo sent successfully."
else
  echo "Telegram send error: $SEND_RESULT"
  sqlite3 "$DB" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','⚙️','Error enviando reporte diario a Telegram','error','engineering',datetime('now'))"
  exit 1
fi

# --- LOG SUCCESS ---
sqlite3 "$DB" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','⚙️','Reporte visual diario enviado: $AGENT_ACTIONS ops, $TASKS_DONE tareas, \$$LLM_TODAY IA','success','engineering',datetime('now'))"

echo "Daily image report done — $TODAY"
