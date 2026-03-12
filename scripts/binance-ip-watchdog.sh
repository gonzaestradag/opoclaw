#!/bin/bash
# Binance IP Watchdog
# Polls Binance API every 30 seconds until the IP whitelist is active.
# Automatically starts trading-bot via PM2 once auth succeeds.
# Run once: pm2 start /Users/opoclaw1/claudeclaw/scripts/binance-ip-watchdog.sh --name binance-ip-watchdog --interpreter bash

LOGFILE="/Users/opoclaw1/claudeclaw/trading-bot/logs/ip-watchdog.log"
BOT_ECOSYSTEM="/Users/opoclaw1/claudeclaw/trading-bot/ecosystem.config.cjs"
NOTIFY_SCRIPT="/Users/opoclaw1/claudeclaw/scripts/tg-notify.sh"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOGFILE"
}

CURRENT_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 icanhazip.com 2>/dev/null || echo "unknown")
log "Binance IP watchdog started. Current public IP: $CURRENT_IP"
log "Waiting for Gonzalo to whitelist $CURRENT_IP in Binance API settings..."
bash "$NOTIFY_SCRIPT" "Watchdog activo. IP publica actual del Mac Mini: ${CURRENT_IP}. Whitelist esa IP en Binance API settings y el trading bot arranca automaticamente."

while true; do
  # Try an authenticated call — fetchBalance requires valid IP+key
  RESULT=$(node -e "
    require('dotenv').config({ path: '/Users/opoclaw1/claudeclaw/.env', quiet: true });
    const ccxt = require('ccxt');
    const ex = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
      options: { defaultType: 'spot' }
    });
    ex.fetchBalance().then(b => {
      const usdt = (b.free['USDT'] || 0).toFixed(2);
      console.log('OK:' + usdt);
    }).catch(e => {
      if (e.message.includes('-2015') || e.message.includes('WAF') || e.message.includes('IP')) {
        console.log('IP_BLOCKED');
      } else if (e.message.includes('-2008') || e.message.includes('Invalid Api-Key')) {
        console.log('IP_BLOCKED');
      } else {
        console.log('ERROR:' + e.message);
      }
    });
  " 2>/dev/null)

  if [[ "$RESULT" == OK:* ]]; then
    USDT_BAL="${RESULT#OK:}"
    log "IP whitelisted! Balance: $USDT_BAL USDT. Starting trading bot..."

    # Stop the errored bot and restart cleanly
    pm2 delete trading-bot 2>/dev/null
    sleep 2
    pm2 start "$BOT_ECOSYSTEM"
    pm2 save

    log "Trading bot started via PM2."
    bash "$NOTIFY_SCRIPT" "IP activado. Trading bot arrancado. Balance: \$${USDT_BAL} USDT. Estrategia RSI en ADA/USDT y VET/USDT corriendo 24/7."

    # Log to dashboard
    sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
      "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('trading-bot','Trading Bot','📈','Trading bot activado — IP whitelisted. Balance: \$${USDT_BAL} USDT','success','ventures',datetime('now'))"

    # Self-terminate watchdog
    pm2 delete binance-ip-watchdog 2>/dev/null
    exit 0
  else
    log "Still waiting... IP ${CURRENT_IP} not yet whitelisted on Binance"
  fi

  sleep 30
done
