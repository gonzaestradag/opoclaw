#!/bin/bash
# nightly-finance-report.sh — Reporte Financiero Nocturno
# Genera reporte markdown diario con: P&L, Binance, banco.
# Guarda en workspace/reports/daily/, memoria en DB, envia como documento a Telegram.
# Scheduled: 04:30 UTC = 10:30pm Monterrey (CST)

set -uo pipefail

# ── Load env ──────────────────────────────────────────────────────────
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"
DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
DIST_DIR="/Users/opoclaw1/claudeclaw/dist"
TG_NOTIFY="/Users/opoclaw1/claudeclaw/scripts/tg-notify.sh"

BINANCE_API_KEY=$(grep "^BINANCE_API_KEY=" "$ENV_FILE" | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
BINANCE_SECRET_KEY=$(grep "^BINANCE_SECRET_KEY=" "$ENV_FILE" | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
BOT_TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=|^BOT_TOKEN=" "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
CHAT_ID=$(grep -E "^TELEGRAM_CHAT_ID=|^ALLOWED_CHAT_ID=" "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)

# ── Paths ─────────────────────────────────────────────────────────────
DAILY_DIR="/Users/opoclaw1/claudeclaw/workspace/reports/daily"
SNAPSHOTS_DIR="/Users/opoclaw1/claudeclaw/workspace/reports"
FINANCE_DIR="/Users/opoclaw1/claudeclaw/workspace/finance"
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date --date="yesterday" +%Y-%m-%d 2>/dev/null || echo "")
REPORT_FILE="$DAILY_DIR/${TODAY}-finance.md"
SNAPSHOT_FILE="$SNAPSHOTS_DIR/snapshot-$TODAY.json"
YESTERDAY_SNAPSHOT="$SNAPSHOTS_DIR/snapshot-${YESTERDAY}.json"

mkdir -p "$DAILY_DIR"
mkdir -p "$FINANCE_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"; }

log "=== Nightly Finance Report — $TODAY ==="

# ── Spanish date ──────────────────────────────────────────────────────
DAY=$(date +%-d)
MONTH_NUM=$(date +%-m)
YEAR=$(date +%Y)
WEEKDAY=$(date +%A)
case "$WEEKDAY" in
  Monday)    WEEKDAY_ES="Lunes" ;;
  Tuesday)   WEEKDAY_ES="Martes" ;;
  Wednesday) WEEKDAY_ES="Miercoles" ;;
  Thursday)  WEEKDAY_ES="Jueves" ;;
  Friday)    WEEKDAY_ES="Viernes" ;;
  Saturday)  WEEKDAY_ES="Sabado" ;;
  Sunday)    WEEKDAY_ES="Domingo" ;;
  *)         WEEKDAY_ES="$WEEKDAY" ;;
esac
case "$MONTH_NUM" in
  1)  MONTH_ES="Enero" ;;   2)  MONTH_ES="Febrero" ;;
  3)  MONTH_ES="Marzo" ;;   4)  MONTH_ES="Abril" ;;
  5)  MONTH_ES="Mayo" ;;    6)  MONTH_ES="Junio" ;;
  7)  MONTH_ES="Julio" ;;   8)  MONTH_ES="Agosto" ;;
  9)  MONTH_ES="Septiembre" ;; 10) MONTH_ES="Octubre" ;;
  11) MONTH_ES="Noviembre" ;; 12) MONTH_ES="Diciembre" ;;
  *)  MONTH_ES="Mes" ;;
esac
DATE_ES="${WEEKDAY_ES}, ${DAY} de ${MONTH_ES} de ${YEAR}"
MONTH_KEY=$(date +%Y-%m)
MONTH_LABEL=$(echo "$MONTH_ES $YEAR")

# ── Card / bank balance ───────────────────────────────────────────────
CARD_BALANCE_FILE="$FINANCE_DIR/card-balance.txt"
if [[ -f "$CARD_BALANCE_FILE" ]]; then
  CARD_BALANCE=$(tr -d '[:space:]' < "$CARD_BALANCE_FILE")
else
  CARD_BALANCE="54.13"
  echo "$CARD_BALANCE" > "$CARD_BALANCE_FILE"
fi
log "Card balance: $CARD_BALANCE"

# ── Binance balance via HMAC-SHA256 ──────────────────────────────────
TMP_JS="/tmp/binance-nightly-$$.cjs"
cat > "$TMP_JS" << 'JSEOF'
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
      ex.fetchTickers(['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','ADA/USDT','VET/USDT','XRP/USDT','DOT/USDT'])
    ]);
    const prices = {};
    for (const [sym, data] of Object.entries(tickers)) {
      prices[sym.split('/')[0]] = data.last || 0;
    }
    prices['USDT'] = 1;
    const assets = [];
    let totalUSD = 0;
    for (const [asset, amounts] of Object.entries(balance.total || {})) {
      const total = parseFloat(amounts) || 0;
      if (total < 0.0001) continue;
      const price = prices[asset] || 0;
      const usd = total * price;
      if (usd < 0.01 && total < 0.001) continue;
      assets.push({ asset, amount: total, price, usd });
      totalUSD += usd;
    }
    assets.sort((a, b) => b.usd - a.usd);
    process.stdout.write(JSON.stringify({ ok: true, assets, totalUSD }) + '\n');
  } catch(e) {
    const isIPBlock = !!(e.message && (
      e.message.includes('-2015') || e.message.includes('WAF') ||
      e.message.includes('-2008') || e.message.includes('Invalid Api-Key') ||
      e.message.includes('403') || e.message.includes('IP')
    ));
    process.stdout.write(JSON.stringify({ ok: false, ipBlocked: isIPBlock, error: e.message }) + '\n');
  }
}
run();
JSEOF

BINANCE_RESULT=$(cd /Users/opoclaw1/claudeclaw && node "$TMP_JS" 2>/dev/null | grep '^{' | tail -1 || echo '{"ok":false,"ipBlocked":false,"error":"node failed"}')
rm -f "$TMP_JS"
log "Binance: $BINANCE_RESULT"

BINANCE_OK=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print('true' if d.get('ok') else 'false')" "$BINANCE_RESULT" 2>/dev/null || echo "false")
IP_BLOCKED=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print('true' if d.get('ipBlocked') else 'false')" "$BINANCE_RESULT" 2>/dev/null || echo "false")

# ── P&L from internal DB ──────────────────────────────────────────────
INCOME_TODAY=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(amount),2),0) FROM financial_transactions WHERE type='income' AND date(created_at)='$TODAY' AND amount>0;" 2>/dev/null || echo "0")
EXPENSES_TODAY=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(amount),2),0) FROM financial_transactions WHERE type='expense' AND date(created_at)='$TODAY' AND amount>0;" 2>/dev/null || echo "0")
LLM_TODAY_A=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(cost_usd),4),0) FROM llm_costs WHERE date(created_at)='$TODAY';" 2>/dev/null || echo "0")
LLM_TODAY_B=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(cost_usd),4),0) FROM token_usage WHERE date(created_at,'unixepoch')='$TODAY';" 2>/dev/null || echo "0")
LLM_TODAY=$(python3 -c "print(round($LLM_TODAY_A + $LLM_TODAY_B, 4))")
NET_TODAY=$(python3 -c "v=round($INCOME_TODAY - $EXPENSES_TODAY - $LLM_TODAY, 2); print(('+' if v>=0 else '-') + str(abs(v)))")

INCOME_MONTH=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(amount),2),0) FROM financial_transactions WHERE type='income' AND strftime('%Y-%m',created_at)='$MONTH_KEY' AND amount>0;" 2>/dev/null || echo "0")
EXPENSES_MONTH=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(amount),2),0) FROM financial_transactions WHERE type='expense' AND strftime('%Y-%m',created_at)='$MONTH_KEY' AND amount>0;" 2>/dev/null || echo "0")
LLM_MONTH_A=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(cost_usd),2),0) FROM llm_costs WHERE strftime('%Y-%m',created_at)='$MONTH_KEY';" 2>/dev/null || echo "0")
LLM_MONTH_B=$(sqlite3 "$DB" "SELECT COALESCE(ROUND(SUM(cost_usd),2),0) FROM token_usage WHERE strftime('%Y-%m',datetime(created_at,'unixepoch'))='$MONTH_KEY';" 2>/dev/null || echo "0")
LLM_MONTH=$(python3 -c "print(round($LLM_MONTH_A + $LLM_MONTH_B, 2))")
NET_MONTH=$(python3 -c "v=round($INCOME_MONTH - $EXPENSES_MONTH - $LLM_MONTH, 2); print(('+' if v>=0 else '-') + str(abs(v)))")

# Agent ops count
AGENT_OPS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_activity WHERE date(created_at)='$TODAY' AND type IN ('success','task');" 2>/dev/null || echo "0")

# ── Binance section for report ────────────────────────────────────────
if [[ "$BINANCE_OK" == "true" ]]; then
  TOTAL_BINANCE=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print('{:.2f}'.format(d['totalUSD']))" "$BINANCE_RESULT" 2>/dev/null || echo "0.00")

  ASSET_TABLE=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
lines = []
for a in d['assets'][:8]:
    asset = a['asset']
    amount = a['amount']
    price = a.get('price', 0)
    usd = a['usd']
    if asset == 'USDT':
        lines.append('| USDT | {:.2f} | \$1.00 | \${:.2f} |'.format(amount, usd))
    elif price > 0:
        lines.append('| {} | {:.4f} | \${:,.2f} | \${:.2f} |'.format(asset, amount, price, usd))
    else:
        lines.append('| {} | {:.4f} | N/A | N/A |'.format(asset, amount))
print('\n'.join(lines))
" "$BINANCE_RESULT" 2>/dev/null || echo "| Error | - | - | - |")

  DELTA_LINE=""
  if [[ -f "$YESTERDAY_SNAPSHOT" && -n "$YESTERDAY" ]]; then
    DELTA_LINE=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        prev = json.load(f)
    prev_total = float(prev.get('totalBinanceUSD', 0))
    curr_total = float(sys.argv[2])
    delta = curr_total - prev_total
    pct = (delta / prev_total * 100) if prev_total > 0 else 0
    sign = '+' if delta >= 0 else ''
    print('Variacion 24h: {}{:.2f} USD ({}{:.1f}%)'.format(sign, delta, sign, pct))
except:
    print('')
" "$YESTERDAY_SNAPSHOT" "$TOTAL_BINANCE" 2>/dev/null || echo "")
  fi

  GRAND_TOTAL=$(python3 -c "print('{:.2f}'.format(float('$TOTAL_BINANCE') + float('$CARD_BALANCE')))" 2>/dev/null || echo "0.00")

  echo "{\"date\":\"$TODAY\",\"totalBinanceUSD\":$TOTAL_BINANCE,\"assets\":$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(json.dumps(d['assets']))" "$BINANCE_RESULT" 2>/dev/null || echo '[]'),\"cardBalance\":$CARD_BALANCE}" > "$SNAPSHOT_FILE"

  BINANCE_SECTION=$(cat << BEOF
## Binance

| Asset | Cantidad | Precio | Valor USD |
|-------|----------|--------|-----------|
$ASSET_TABLE

**Total Binance: \$$TOTAL_BINANCE USD**
$DELTA_LINE
BEOF
)
  BINANCE_STATUS="Disponible"
  BINANCE_TOTAL_LINE="Total Binance: \$$TOTAL_BINANCE USD"

else
  if [[ "$IP_BLOCKED" == "true" ]]; then
    BINANCE_NOTE="Binance no disponible — restriccion de IP (VPN requerida para acceso directo)"
  else
    BINANCE_NOTE="Binance no disponible"
  fi
  TOTAL_BINANCE="0.00"
  GRAND_TOTAL=$(python3 -c "print('{:.2f}'.format(float('$CARD_BALANCE')))" 2>/dev/null || echo "$CARD_BALANCE")

  echo "{\"date\":\"$TODAY\",\"totalBinanceUSD\":0,\"cardBalance\":$CARD_BALANCE,\"error\":\"$BINANCE_NOTE\"}" > "$SNAPSHOT_FILE"

  BINANCE_SECTION=$(cat << BEOF
## Binance

$BINANCE_NOTE

**Total Binance: \$0.00 USD** (sin datos disponibles)
BEOF
)
  BINANCE_STATUS="No disponible"
  BINANCE_TOTAL_LINE="Total Binance: N/A"
fi

# ── Write markdown report ─────────────────────────────────────────────
GENERATED_AT=$(date -u +"%Y-%m-%d %H:%M UTC")

cat > "$REPORT_FILE" << MDEOF
# Reporte Financiero Nocturno
**$DATE_ES**
Generado: $GENERATED_AT

---

## P&L del Dia

| Concepto | Hoy | Mes ($MONTH_LABEL) |
|----------|-----|------|
| Ingresos | \$$INCOME_TODAY | \$$INCOME_MONTH |
| Gastos | \$$EXPENSES_TODAY | \$$EXPENSES_MONTH |
| Costo IA | \$$LLM_TODAY | \$$LLM_MONTH |
| **Neto** | **$NET_TODAY** | **$NET_MONTH** |

Acciones completadas hoy: $AGENT_OPS

---

$BINANCE_SECTION

---

## Banco / Tarjeta

| Cuenta | Saldo |
|--------|-------|
| Banorte (tarjeta) | \$$CARD_BALANCE USD |

> Actualizar manualmente: editar \`/Users/opoclaw1/claudeclaw/workspace/finance/card-balance.txt\`

---

## Resumen

| Rubro | Valor |
|-------|-------|
| Binance | \$$TOTAL_BINANCE USD |
| Banorte tarjeta | \$$CARD_BALANCE USD |
| **Total general** | **\$$GRAND_TOTAL USD** |

---

*Reporte generado automaticamente por Jordan (Finance Director, OpoClaw)*
MDEOF

log "Markdown report saved: $REPORT_FILE"

# ── Save memory to DB ─────────────────────────────────────────────────
CHAT_ID_DB=$(sqlite3 "$DB" "SELECT chat_id FROM sessions LIMIT 1;" 2>/dev/null || echo "default")
MEMORY_CONTENT="Reporte financiero $TODAY: Binance $BINANCE_STATUS (\$$TOTAL_BINANCE USD), Banorte tarjeta \$$CARD_BALANCE USD, Total general \$$GRAND_TOTAL USD. P&L hoy: ingresos \$$INCOME_TODAY, gastos \$$EXPENSES_TODAY, costo IA \$$LLM_TODAY, neto $NET_TODAY. Costo IA mes: \$$LLM_MONTH."

python3 -c "
import sqlite3, time
db = sqlite3.connect('/Users/opoclaw1/claudeclaw/store/opoclaw.db')
now = int(time.time())
content = '''$MEMORY_CONTENT'''
chat_id = '$CHAT_ID_DB'
db.execute('INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)',
  (chat_id, content, 'semantic', 4.0, now, now))
db.commit()
print('Memory saved.')
" 2>/dev/null && log "Memory saved to DB" || log "Memory save failed (non-fatal)"

# ── Log to dashboard ──────────────────────────────────────────────────
sqlite3 "$DB" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('jordan-walsh','Jordan','💰','Reporte financiero nocturno generado — Total \$$GRAND_TOTAL USD','success','finance',datetime('now'))" 2>/dev/null || true

# ── Send report to Telegram as document ──────────────────────────────
log "Sending to Telegram as document..."
TG_BOT_TOKEN="$BOT_TOKEN"
TG_CHAT_ID="$CHAT_ID"
TG_CAPTION="Reporte financiero $(date +'%d %b %Y') — Total: \$$GRAND_TOTAL USD"

TG_RESULT=$(curl -s -F "chat_id=$TG_CHAT_ID" \
  -F "document=@$REPORT_FILE" \
  -F "caption=$TG_CAPTION" \
  "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument")

TG_OK=$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print('true' if d.get('ok') else 'false')" "$TG_RESULT" 2>/dev/null || echo "false")

if [[ "$TG_OK" == "true" ]]; then
  log "Document sent to Telegram OK"
else
  log "Telegram document send failed: $TG_RESULT"
  bash "$TG_NOTIFY" "Reporte financiero listo. Total: \$$GRAND_TOTAL USD. (Binance: $BINANCE_STATUS)"
fi

log "=== Report complete — $TODAY ==="
