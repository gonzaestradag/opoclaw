#!/usr/bin/env bash
# trading-watchdog.sh — monitors satoshi-bot, nakamoto-bot, cruz-bot, opo-dca-bot
# Checks REAL health via freqtrade API + Binance auth, not just PM2 status
# Alerts Gonzalo on auth errors with the EXACT fix needed
# Runs every 2 minutes via PM2 (trading-watchdog process)

set -uo pipefail

ENV_FILE="/Users/opoclaw1/claudeclaw/.env"
DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
LOG="/Users/opoclaw1/claudeclaw/logs/trading-watchdog.log"
ALERT_FLAG="/tmp/trading_auth_alert_sent"

# Load env
[ -f "$ENV_FILE" ] && export $(grep -E '^(TELEGRAM_BOT_TOKEN|ALLOWED_CHAT_ID)=' "$ENV_FILE" | xargs) 2>/dev/null || true

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${ALLOWED_CHAT_ID:-}"

# Bot config: name | PM2 name | freqtrade API port | user | pass
declare -a BOTS=(
  "satoshi|satoshi-bot|8081|satoshi|$(grep SATOSHI_BOT_PASS "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 'opoclaw2026')"
  "nakamoto|nakamoto-bot|8082|nakamoto|$(grep NAKAMOTO_BOT_PASS "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 'opoclaw2026')"
  "cruz|cruz-bot|8083|cruz|$(grep CRUZ_BOT_PASS "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 'opoclaw2026')"
)

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

log() { echo "[$(timestamp)] $1" >> "$LOG"; }

send_tg() {
  local msg="$1"
  [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ] && \
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${msg}" \
      --max-time 10 > /dev/null 2>&1 || true
}

log_db() {
  local action="$1" type="$2"
  sqlite3 "$DB" \
    "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at)
     VALUES ('trading-watchdog','Trading Watchdog','📈','${action}','${type}','trading',datetime('now'))" \
    2>/dev/null || true
}

# ── Check current public IP ───────────────────────────────────
CURRENT_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "unknown")
STORED_IP=""
[ -f /tmp/last_known_ip ] && STORED_IP=$(cat /tmp/last_known_ip)

if [ -n "$CURRENT_IP" ] && [ "$CURRENT_IP" != "unknown" ] && [ "$CURRENT_IP" != "$STORED_IP" ]; then
  echo "$CURRENT_IP" > /tmp/last_known_ip
  if [ -n "$STORED_IP" ]; then
    # IP changed — this is likely why bots are failing
    MSG="ALERTA: La IP del Mac Mini cambio de ${STORED_IP} a ${CURRENT_IP}. Esto rompe los bots de trading si tienen restriccion de IP en Binance. Ve a binance.com → API Management y agrega la nueva IP: ${CURRENT_IP}"
    log "IP changed: $STORED_IP → $CURRENT_IP"
    # send_tg "$MSG"  # Disabled — Gonzalo handles IP changes manually
    log_db "IP del Mac Mini cambio a ${CURRENT_IP} — actualizar whitelist en Binance" "warning"
  else
    log "IP initialized: $CURRENT_IP"
  fi
fi

# ── Check each bot ────────────────────────────────────────────
AUTH_ERRORS=0
DOWN_BOTS=()

for BOT_CONFIG in "${BOTS[@]}"; do
  IFS='|' read -r NAME PM2_NAME PORT USER PASS <<< "$BOT_CONFIG"

  # 1. Check PM2 status
  PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
  procs=json.load(sys.stdin)
  for p in procs:
    if p.get('name')=='${PM2_NAME}':
      print(p.get('pm2_env',{}).get('status','unknown'))
      break
  else: print('not_found')
except: print('error')
" 2>/dev/null || echo "error")

  log "${NAME}: PM2=${PM2_STATUS}"

  # 2. If PM2 says it's not online, restart it
  if [ "$PM2_STATUS" != "online" ]; then
    log "${NAME} is ${PM2_STATUS} — restarting via PM2"
    pm2 restart "$PM2_NAME" 2>>"$LOG" || true
    sleep 5
  fi

  # 3. Check for auth errors in recent logs (last 50 lines)
  RECENT_LOGS=$(pm2 logs "$PM2_NAME" --lines 50 --nostream 2>/dev/null || echo "")
  AUTH_ERROR=$(echo "$RECENT_LOGS" | grep -c "AuthenticationError\|-2015\|Invalid API-key\|IP.*permission" 2>/dev/null || echo "0")

  if [ "$AUTH_ERROR" -gt "0" ]; then
    AUTH_ERRORS=$((AUTH_ERRORS + 1))
    DOWN_BOTS+=("$NAME")
    log "${NAME}: BINANCE AUTH ERROR detected in logs"
  else
    # 4. Check freqtrade API health
    FT_HEALTH=$(curl -s --max-time 3 \
      -u "${USER}:${PASS}" \
      "http://localhost:${PORT}/api/v1/ping" 2>/dev/null || echo "")

    if echo "$FT_HEALTH" | grep -q "pong\|status"; then
      log "${NAME}: freqtrade API healthy"
      log_db "${NAME} saludable — API respondiendo en puerto ${PORT}" "info"
    else
      log "${NAME}: freqtrade API not responding on port ${PORT}"
      DOWN_BOTS+=("$NAME (API no responde)")
    fi
  fi
done

# ── Send ONE alert if auth errors found (don't spam) ─────────
if [ "$AUTH_ERRORS" -gt "0" ]; then
  BOTS_STR=$(IFS=', '; echo "${DOWN_BOTS[*]}")
  LAST_ALERT=""
  [ -f "$ALERT_FLAG" ] && LAST_ALERT=$(cat "$ALERT_FLAG")
  NOW_EPOCH=$(date +%s)
  ALERT_AGO=$((NOW_EPOCH - ${LAST_ALERT:-0}))

  # Only alert once per hour max
  if [ "$ALERT_AGO" -gt "3600" ]; then
    echo "$NOW_EPOCH" > "$ALERT_FLAG"
    MSG="ALERTA TRADING: ${BOTS_STR} estan fallando por autenticacion Binance (error -2015).

Causa probable: tu IP publica es ${CURRENT_IP} y no esta en la whitelist de Binance.

Solucion en 2 minutos:
1. binance.com → perfil → API Management
2. Para cada API key → Edit
3. En 'Restrict access to trusted IPs' agrega: ${CURRENT_IP}
4. O cambia a 'Unrestricted' si no quieres manejar IPs

Los bots se reconectan solos una vez que autorices la IP."

    # send_tg "$MSG"  # Disabled — Gonzalo handles IP/auth issues manually
    log_db "ALERTA: ${BOTS_STR} con auth error Binance. IP: ${CURRENT_IP}" "error"
    log "Auth alert sent to Telegram"
  else
    log "Auth errors found but alert already sent ${ALERT_AGO}s ago — skipping"
  fi
fi

# ── Summary ───────────────────────────────────────────────────
if [ "$AUTH_ERRORS" -eq "0" ] && [ "${#DOWN_BOTS[@]}" -eq "0" ]; then
  log "All trading bots healthy. IP: ${CURRENT_IP}"
fi

log "Watchdog check complete."
