#!/bin/bash
# Nightly Financial Report — OpoClaw
# Pulls Binance balance + card balance, generates voice report, saves doc.
# Scheduled: 04:00 UTC = 10:00pm Monterrey (CST)

set -euo pipefail

# ── Load env ──────────────────────────────────────────────────────────
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"
if [[ -f "$ENV_FILE" ]]; then
  # || true prevents set -e from killing on grep no-match
  BINANCE_API_KEY=$(grep "^BINANCE_API_KEY=" "$ENV_FILE" | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
  BINANCE_SECRET_KEY=$(grep "^BINANCE_SECRET_KEY=" "$ENV_FILE" | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
  # CHAT_ID may be stored as ALLOWED_CHAT_ID
  TELEGRAM_CHAT_ID=$(grep "^TELEGRAM_CHAT_ID=\|^ALLOWED_CHAT_ID=" "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
fi

# ── Paths ─────────────────────────────────────────────────────────────
REPORTS_DIR="/Users/opoclaw1/claudeclaw/workspace/reports"
CARD_BALANCE_FILE="/Users/opoclaw1/claudeclaw/workspace/finance/card-balance.txt"
DIST_DIR="/Users/opoclaw1/claudeclaw/dist"
TG_NOTIFY="/Users/opoclaw1/claudeclaw/scripts/tg-notify.sh"
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date --date="yesterday" +%Y-%m-%d 2>/dev/null || echo "")
REPORT_FILE="$REPORTS_DIR/report-$TODAY.txt"
SNAPSHOT_FILE="$REPORTS_DIR/snapshot-$TODAY.json"
YESTERDAY_SNAPSHOT="$REPORTS_DIR/snapshot-${YESTERDAY}.json"

mkdir -p "$REPORTS_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
}

log "=== Nightly Financial Report — $TODAY ==="

# ── Spanish date ──────────────────────────────────────────────────────
DAY=$(date +%-d)
MONTH_NUM=$(date +%-m)
YEAR=$(date +%Y)
case "$MONTH_NUM" in
  1)  MONTH_ES="enero" ;;
  2)  MONTH_ES="febrero" ;;
  3)  MONTH_ES="marzo" ;;
  4)  MONTH_ES="abril" ;;
  5)  MONTH_ES="mayo" ;;
  6)  MONTH_ES="junio" ;;
  7)  MONTH_ES="julio" ;;
  8)  MONTH_ES="agosto" ;;
  9)  MONTH_ES="septiembre" ;;
  10) MONTH_ES="octubre" ;;
  11) MONTH_ES="noviembre" ;;
  12) MONTH_ES="diciembre" ;;
  *)  MONTH_ES="mes" ;;
esac
DATE_ES="${DAY} de ${MONTH_ES} de ${YEAR}"

# ── Read card balance ─────────────────────────────────────────────────
if [[ -f "$CARD_BALANCE_FILE" ]]; then
  CARD_BALANCE=$(tr -d '[:space:]' < "$CARD_BALANCE_FILE")
else
  CARD_BALANCE="54.13"
  echo "$CARD_BALANCE" > "$CARD_BALANCE_FILE"
fi
log "Card balance: $CARD_BALANCE"

# ── Write Node.js helper to a temp file ──────────────────────────────
# .cjs extension: project uses "type":"module" so we must use CommonJS explicitly.
TMP_JS="/Users/opoclaw1/claudeclaw/binance-check-$$.cjs"
cat > "$TMP_JS" << 'JSEOF'
// Suppress dotenv debug output before requiring it
const originalWrite = process.stderr.write.bind(process.stderr);
process.env.DOTENV_DEBUG = '';

require('dotenv').config({ path: '/Users/opoclaw1/claudeclaw/.env', override: false });

const ccxt = require('ccxt');

const ex = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  options: { defaultType: 'spot' }
});

async function run() {
  try {
    const [balance, tickers] = await Promise.all([
      ex.fetchBalance(),
      ex.fetchTickers(['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','ADA/USDT','VET/USDT'])
    ]);

    const prices = {};
    for (const [sym, data] of Object.entries(tickers)) {
      const base = sym.split('/')[0];
      prices[base] = data.last || 0;
    }
    prices['USDT'] = 1;

    const assets = [];
    let totalUSD = 0;

    for (const [asset, amounts] of Object.entries(balance.total)) {
      const total = amounts || 0;
      if (total < 0.0001) continue;
      const price = prices[asset] || 0;
      const usd = total * price;
      if (usd < 0.01 && total < 0.001) continue;
      assets.push({ asset, amount: total, price, usd });
      totalUSD += usd;
    }

    assets.sort((a, b) => b.usd - a.usd);

    // Print ONLY the JSON line to stdout — no other output
    process.stdout.write(JSON.stringify({ ok: true, assets, totalUSD, prices }) + '\n');
  } catch(e) {
    const isIPBlock = !!(e.message && (
      e.message.includes('-2015') ||
      e.message.includes('WAF') ||
      e.message.includes('IP') ||
      e.message.includes('-2008') ||
      e.message.includes('Invalid Api-Key') ||
      e.message.includes('403')
    ));
    process.stdout.write(JSON.stringify({ ok: false, ipBlocked: isIPBlock, error: e.message }) + '\n');
  }
}
run();
JSEOF

# ── Pull Binance data ─────────────────────────────────────────────────
# Run from project dir so node_modules resolves. grep for JSON line only
# to strip any dotenv informational output from stdout.
BINANCE_RESULT=$(cd /Users/opoclaw1/claudeclaw && node "$TMP_JS" 2>/dev/null | grep '^{' | tail -1 || echo '{"ok":false,"ipBlocked":false,"error":"node failed"}')
rm -f "$TMP_JS"

log "Binance result: $BINANCE_RESULT"

# ── Parse result ──────────────────────────────────────────────────────
BINANCE_OK=$(python3 -c "import sys,json; d=json.loads('$BINANCE_RESULT'.replace(\"'\",\"'\")); print('true' if d.get('ok') else 'false')" 2>/dev/null || echo "false")
IP_BLOCKED=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print('true' if d.get('ipBlocked') else 'false')" "$BINANCE_RESULT" 2>/dev/null || echo "false")

# ── Build report text ─────────────────────────────────────────────────
if [[ "$BINANCE_OK" == "true" ]]; then
  TOTAL_BINANCE=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
print('{:.2f}'.format(d['totalUSD']))
" "$BINANCE_RESULT" 2>/dev/null || echo "0.00")

  ASSET_LINES=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
lines = []
for a in d['assets'][:6]:
    asset = a['asset']
    amount = a['amount']
    usd = a['usd']
    if asset == 'USDT':
        lines.append('USDT disponible: \${:.2f}'.format(amount))
    else:
        lines.append('{}: {:.4f} (~\${:.2f} USD)'.format(asset, amount, usd))
print('. '.join(lines))
" "$BINANCE_RESULT" 2>/dev/null || echo "Sin activos")

  SNAPSHOT_JSON=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
out = {'date': sys.argv[2], 'totalBinanceUSD': d['totalUSD'], 'assets': d['assets'], 'cardBalance': float(sys.argv[3])}
print(json.dumps(out, indent=2))
" "$BINANCE_RESULT" "$TODAY" "$CARD_BALANCE" 2>/dev/null || echo "{}")

  # Day-over-day comparison
  DELTA_TEXT=""
  if [[ -f "$YESTERDAY_SNAPSHOT" && -n "$YESTERDAY" ]]; then
    DELTA_TEXT=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        prev = json.load(f)
    prev_total = prev.get('totalBinanceUSD', 0)
    curr_total = float(sys.argv[2])
    delta = curr_total - prev_total
    pct = (delta / prev_total * 100) if prev_total > 0 else 0
    sign = '+' if delta >= 0 else ''
    print('. Variacion vs ayer: {}{:.2f} USD ({}{:.1f}%)'.format(sign, delta, sign, pct))
except:
    print('')
" "$YESTERDAY_SNAPSHOT" "$TOTAL_BINANCE" 2>/dev/null || echo "")
  fi

  GRAND_TOTAL=$(python3 -c "print('{:.2f}'.format(float('$TOTAL_BINANCE') + float('$CARD_BALANCE')))" 2>/dev/null || echo "0.00")
  REPORT_TEXT="Reporte financiero del ${DATE_ES}. Binance: ${ASSET_LINES}. Total Binance: \$${TOTAL_BINANCE} USD. Tarjeta disponible: \$${CARD_BALANCE} USD. Total general: \$${GRAND_TOTAL} USD${DELTA_TEXT}."

  echo "$SNAPSHOT_JSON" > "$SNAPSHOT_FILE"
  log "Snapshot saved: $SNAPSHOT_FILE"

else
  if [[ "$IP_BLOCKED" == "true" ]]; then
    STATUS_NOTE="Binance no disponible por restriccion de IP"
  else
    STATUS_NOTE="Binance no disponible"
  fi

  GRAND_TOTAL=$(python3 -c "print('{:.2f}'.format(float('$CARD_BALANCE')))" 2>/dev/null || echo "$CARD_BALANCE")
  REPORT_TEXT="Reporte financiero del ${DATE_ES}. ${STATUS_NOTE}. Tarjeta disponible: \$${CARD_BALANCE} USD. Total verificable: \$${GRAND_TOTAL} USD."
  echo "{\"date\":\"$TODAY\",\"totalBinanceUSD\":0,\"cardBalance\":${CARD_BALANCE},\"error\":\"${STATUS_NOTE}\"}" > "$SNAPSHOT_FILE"
fi

log "Report text: $REPORT_TEXT"

# ── Save text report ──────────────────────────────────────────────────
{
  echo "===== Reporte Financiero Nocturno — $TODAY ====="
  echo ""
  echo "$REPORT_TEXT"
  echo ""
  echo "Generado: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$REPORT_FILE"

log "Report saved: $REPORT_FILE"

# ── Log to dashboard ──────────────────────────────────────────────────
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('jordan-walsh','Jordan','💰','Reporte nocturno generado — Total: \$${GRAND_TOTAL} USD','success','finance',datetime('now'))" 2>/dev/null || true

# ── Send via TTS (fallback to tg-notify) ─────────────────────────────
log "Sending via TTS..."
node "$DIST_DIR/index.js" tts "$REPORT_TEXT" \
  || bash "$TG_NOTIFY" "$REPORT_TEXT"

log "=== Report complete ==="
