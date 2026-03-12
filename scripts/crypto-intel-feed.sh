#!/bin/bash
# EL VIGILANTE — Crypto Intel Feed
# Generates a daily crypto intel brief that trading bots can read
# Output: /tmp/crypto-intel-brief.txt
# Run every 4 hours via scheduled task

OUTPUT="/tmp/crypto-intel-brief.txt"

echo "=== CRYPTO INTEL BRIEF $(date) ===" > "$OUTPUT"

# Fear & Greed Index
FG_RAW=$(curl -s --max-time 8 'https://api.alternative.me/fng/?limit=1' 2>/dev/null)
if [ -n "$FG_RAW" ]; then
  FG_VALUE=$(echo "$FG_RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['value'])" 2>/dev/null)
  FG_CLASS=$(echo "$FG_RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['value_classification'])" 2>/dev/null)
  echo "Fear & Greed: ${FG_VALUE} (${FG_CLASS})" >> "$OUTPUT"
else
  echo "Fear & Greed: unavailable" >> "$OUTPUT"
fi

# BTC 24h price change from Binance
BTC_RAW=$(curl -s --max-time 8 'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT' 2>/dev/null)
if [ -n "$BTC_RAW" ]; then
  BTC_PRICE=$(echo "$BTC_RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"\${float(d['lastPrice']):.2f}\")" 2>/dev/null)
  BTC_CHG=$(echo "$BTC_RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"\${float(d['priceChangePercent']):.2f}%\")" 2>/dev/null)
  echo "BTC: \$${BTC_PRICE} (24h: ${BTC_CHG})" >> "$OUTPUT"
fi

# ETH 24h price change
ETH_RAW=$(curl -s --max-time 8 'https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT' 2>/dev/null)
if [ -n "$ETH_RAW" ]; then
  ETH_PRICE=$(echo "$ETH_RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"\${float(d['lastPrice']):.2f}\")" 2>/dev/null)
  ETH_CHG=$(echo "$ETH_RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"\${float(d['priceChangePercent']):.2f}%\")" 2>/dev/null)
  echo "ETH: \$${ETH_PRICE} (24h: ${ETH_CHG})" >> "$OUTPUT"
fi

# News sentiment check (top headlines from CryptoNews RSS)
NEWS_RAW=$(curl -s --max-time 10 -A "OpoClaw-IntelFeed/1.0" 'https://cryptonews.com/news/feed/' 2>/dev/null)
NEGATIVE_KEYWORDS="crash|ban|hack|fraud|collapse|seized|arrest|scam|ponzi|rug|exploit|breach|liquidat"
if [ -n "$NEWS_RAW" ]; then
  NEG_COUNT=$(echo "$NEWS_RAW" | grep -oiE "<title>[^<]{0,200}</title>" | head -10 | grep -ciE "$NEGATIVE_KEYWORDS" 2>/dev/null || echo "0")
  if [ "$NEG_COUNT" -gt 0 ] 2>/dev/null; then
    echo "News Sentiment: NEGATIVE (${NEG_COUNT} negative headlines detected)" >> "$OUTPUT"
  else
    echo "News Sentiment: NEUTRAL/POSITIVE" >> "$OUTPUT"
  fi
else
  echo "News Sentiment: unavailable" >> "$OUTPUT"
fi

echo "Generated at: $(date)" >> "$OUTPUT"
echo "===" >> "$OUTPUT"

# Log to activity feed
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('opo-binance-bot','El Vigilante','🤖','Intel feed updated: Fear&Greed=${FG_VALUE}(${FG_CLASS})','info','trading',datetime('now'))" 2>/dev/null

echo "Intel feed written to $OUTPUT"
cat "$OUTPUT"
