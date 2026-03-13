#!/bin/bash
# daily-pl-report.sh — Reporte diario P&L via Telegram
# Corre a las 8pm todos los dias via scheduled_tasks

DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"

# Load env vars safely (grep instead of source to avoid pipefail issues)
TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2)
BOT_TOKEN=$(grep -E '^BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2)
ALLOWED_CHAT_ID=$(grep -E '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d= -f2)

TOKEN="${BOT_TOKEN:-$TELEGRAM_BOT_TOKEN}"
CHAT="$ALLOWED_CHAT_ID"

TODAY=$(date '+%Y-%m-%d')
MONTH=$(date '+%Y-%m')
MONTH_LABEL=$(date '+%B %Y')

# --- INGRESOS HOY ---
INCOME_TODAY=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(amount),2), 0)
  FROM financial_transactions
  WHERE type = 'income'
    AND date(created_at) = '$TODAY'
    AND amount > 0;
")

# --- GASTOS HOY ---
EXPENSES_TODAY=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(amount),2), 0)
  FROM financial_transactions
  WHERE type = 'expense'
    AND date(created_at) = '$TODAY'
    AND amount > 0;
")

# --- COSTO IA HOY (llm_costs + token_usage) ---
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

# --- INGRESOS MES ---
INCOME_MONTH=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(amount),2), 0)
  FROM financial_transactions
  WHERE type = 'income'
    AND strftime('%Y-%m', created_at) = '$MONTH'
    AND amount > 0;
")

# --- GASTOS MES ---
EXPENSES_MONTH=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(amount),2), 0)
  FROM financial_transactions
  WHERE type = 'expense'
    AND strftime('%Y-%m', created_at) = '$MONTH'
    AND amount > 0;
")

# --- COSTO IA MES (llm_costs + token_usage) ---
LLM_MONTH_A=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(cost_usd), 2), 0)
  FROM llm_costs
  WHERE strftime('%Y-%m', created_at) = '$MONTH';
")

LLM_MONTH_B=$(sqlite3 "$DB" "
  SELECT COALESCE(ROUND(SUM(cost_usd), 2), 0)
  FROM token_usage
  WHERE strftime('%Y-%m', datetime(created_at, 'unixepoch')) = '$MONTH';
")

LLM_MONTH=$(python3 -c "print(round($LLM_MONTH_A + $LLM_MONTH_B, 2))")

# --- CALCULOS NETO ---
NET_TODAY=$(python3 -c "v=round($INCOME_TODAY - $EXPENSES_TODAY - $LLM_TODAY, 2); print(('+' if v>=0 else '') + '\$' + str(abs(v)))")
NET_MONTH=$(python3 -c "v=round($INCOME_MONTH - $EXPENSES_MONTH - $LLM_MONTH, 2); print(('+' if v>=0 else '') + '\$' + str(abs(v)))")

# --- TOP AREAS DE INGRESO HOY ---
TOP_AREAS_RAW=$(sqlite3 "$DB" "
  SELECT area, ROUND(SUM(amount), 2) as total
  FROM financial_transactions
  WHERE type = 'income'
    AND date(created_at) = '$TODAY'
    AND amount > 0
  GROUP BY area
  ORDER BY total DESC
  LIMIT 3;
")

if [ -z "$TOP_AREAS_RAW" ]; then
  AREAS_BLOCK="Sin movimientos por area"
else
  AREAS_BLOCK=$(echo "$TOP_AREAS_RAW" | awk -F'|' '{printf "- %s: $%s\n", $1, $2}')
fi

# --- ACTIVIDAD AGENTES HOY ---
AGENT_TASKS=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM agent_activity
  WHERE date(created_at) = '$TODAY'
    AND type IN ('success', 'task');
")

# --- COMPONER MENSAJE ---
MESSAGE="<b>P&amp;L Diario — $TODAY</b>

<b>Hoy</b>
Ingresos: \$$INCOME_TODAY
Gastos: \$$EXPENSES_TODAY
Costo IA: \$$LLM_TODAY
Neto: $NET_TODAY

<b>Mes ($MONTH_LABEL)</b>
Ingresos: \$$INCOME_MONTH
Gastos: \$$EXPENSES_MONTH
Costo IA: \$$LLM_MONTH
Neto: $NET_MONTH

<b>Areas (hoy)</b>
$AREAS_BLOCK

<b>Ops</b>
Acciones completadas hoy: $AGENT_TASKS"

# --- ENVIAR A TELEGRAM ---
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT}" \
  -d "parse_mode=HTML" \
  --data-urlencode "text=${MESSAGE}" \
  > /dev/null

# --- LOG EN DASHBOARD ---
sqlite3 "$DB" "INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('silas-vane', 'Silas', '⚡', 'Reporte P&L diario enviado a Telegram', 'success', 'engineering', datetime('now'))"

echo "P&L report sent — $TODAY"
