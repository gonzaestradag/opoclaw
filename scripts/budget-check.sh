#!/bin/bash
# budget-check.sh — Budget alert system for OpoClaw
# Checks daily, weekly, and monthly LLM spending against thresholds.
# Fires a Telegram notification once per threshold breach (deduped via SQLite).
#
# Thresholds:
#   Daily:   $5
#   Weekly:  $25
#   Monthly: $100
#
# Run hourly via cron: 0 * * * * bash /Users/opoclaw1/claudeclaw/scripts/budget-check.sh

set -euo pipefail

DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
SCRIPT_DIR="$(dirname "$0")"

# Load env for Telegram
source /Users/opoclaw1/claudeclaw/.env 2>/dev/null || true

DAILY_THRESHOLD=5
WEEKLY_THRESHOLD=25
MONTHLY_THRESHOLD=100

# ── Ensure budget_alert_fired table exists (dedup tracker) ───────────────────
sqlite3 "$DB" "
CREATE TABLE IF NOT EXISTS budget_alert_fired (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  period     TEXT NOT NULL,   -- 'daily', 'weekly', 'monthly'
  period_key TEXT NOT NULL,   -- e.g. '2026-03-06', '2026-W10', '2026-03'
  threshold  REAL NOT NULL,
  fired_at   INTEGER NOT NULL,
  UNIQUE(period, period_key, threshold)
);
"

# ── Get current spend ────────────────────────────────────────────────────────
# Combine llm_costs (agent tasks) + token_usage (Thorn conversation)

DAILY_COST=$(sqlite3 "$DB" "
SELECT COALESCE(
  (SELECT COALESCE(SUM(cost_usd),0) FROM llm_costs WHERE created_at >= date('now'))
  +
  (SELECT COALESCE(SUM(cost_usd),0) FROM token_usage WHERE datetime(created_at,'unixepoch') >= date('now'))
, 0);
")

WEEKLY_COST=$(sqlite3 "$DB" "
SELECT COALESCE(
  (SELECT COALESCE(SUM(cost_usd),0) FROM llm_costs WHERE created_at >= date('now','-7 days'))
  +
  (SELECT COALESCE(SUM(cost_usd),0) FROM token_usage WHERE datetime(created_at,'unixepoch') >= date('now','-7 days'))
, 0);
")

MONTHLY_COST=$(sqlite3 "$DB" "
SELECT COALESCE(
  (SELECT COALESCE(SUM(cost_usd),0) FROM llm_costs WHERE created_at >= date('now','start of month'))
  +
  (SELECT COALESCE(SUM(cost_usd),0) FROM token_usage WHERE datetime(created_at,'unixepoch') >= date('now','start of month'))
, 0);
")

# Period keys for dedup
TODAY=$(date +%Y-%m-%d)
WEEK_KEY=$(date +%Y-W%V)
MONTH_KEY=$(date +%Y-%m)

NOW=$(date +%s)

# ── Notify function ──────────────────────────────────────────────────────────
fire_alert() {
  local period="$1"
  local period_key="$2"
  local threshold="$3"
  local spent="$4"
  local message="$5"

  # Check if already fired for this period+threshold
  ALREADY=$(sqlite3 "$DB" "
    SELECT COUNT(*) FROM budget_alert_fired
    WHERE period='$period' AND period_key='$period_key' AND threshold=$threshold;
  ")

  if [ "$ALREADY" -eq "0" ]; then
    # Fire the alert
    bash "$SCRIPT_DIR/tg-notify.sh" "$message"

    # Record it so we don't fire again
    sqlite3 "$DB" "
      INSERT OR IGNORE INTO budget_alert_fired (period, period_key, threshold, fired_at)
      VALUES ('$period', '$period_key', $threshold, $NOW);
    "

    # Log to activity feed
    sqlite3 "$DB" "
      INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
      VALUES ('jordan-walsh', 'Jordan', '💰', 'Budget alert fired: $period threshold \$$threshold crossed (spent \$$spent)', 'warning', 'finance', datetime('now'));
    "

    echo "[budget-check] Alert fired: $period \$$threshold | spent: \$$spent"
  else
    echo "[budget-check] Alert already fired: $period \$$threshold | period: $period_key"
  fi
}

# ── Check daily threshold ────────────────────────────────────────────────────
echo "[budget-check] Daily: \$$DAILY_COST / \$$DAILY_THRESHOLD"
DAILY_EXCEEDED=$(echo "$DAILY_COST $DAILY_THRESHOLD" | awk '{print ($1 > $2) ? 1 : 0}')
if [ "$DAILY_EXCEEDED" -eq "1" ]; then
  DAILY_PRETTY=$(printf "%.2f" "$DAILY_COST")
  fire_alert "daily" "$TODAY" "$DAILY_THRESHOLD" "$DAILY_PRETTY" \
    "Alerta de gasto: se cruzaron \$${DAILY_THRESHOLD} en el dia de hoy. Gastado: \$${DAILY_PRETTY}."
fi

# ── Check weekly threshold ───────────────────────────────────────────────────
echo "[budget-check] Weekly: \$$WEEKLY_COST / \$$WEEKLY_THRESHOLD"
WEEKLY_EXCEEDED=$(echo "$WEEKLY_COST $WEEKLY_THRESHOLD" | awk '{print ($1 > $2) ? 1 : 0}')
if [ "$WEEKLY_EXCEEDED" -eq "1" ]; then
  WEEKLY_PRETTY=$(printf "%.2f" "$WEEKLY_COST")
  fire_alert "weekly" "$WEEK_KEY" "$WEEKLY_THRESHOLD" "$WEEKLY_PRETTY" \
    "Alerta de gasto: se cruzaron \$${WEEKLY_THRESHOLD} esta semana. Gastado: \$${WEEKLY_PRETTY}."
fi

# ── Check monthly threshold ──────────────────────────────────────────────────
echo "[budget-check] Monthly: \$$MONTHLY_COST / \$$MONTHLY_THRESHOLD"
MONTHLY_EXCEEDED=$(echo "$MONTHLY_COST $MONTHLY_THRESHOLD" | awk '{print ($1 > $2) ? 1 : 0}')
if [ "$MONTHLY_EXCEEDED" -eq "1" ]; then
  MONTHLY_PRETTY=$(printf "%.2f" "$MONTHLY_COST")
  fire_alert "monthly" "$MONTH_KEY" "$MONTHLY_THRESHOLD" "$MONTHLY_PRETTY" \
    "Alerta de gasto: se cruzaron \$${MONTHLY_THRESHOLD} este mes. Gastado: \$${MONTHLY_PRETTY}."
fi

echo "[budget-check] Done. Daily: \$${DAILY_COST} | Weekly: \$${WEEKLY_COST} | Monthly: \$${MONTHLY_COST}"
