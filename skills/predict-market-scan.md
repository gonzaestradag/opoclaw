# predict-market-scan

Scan Polymarket and Kalshi for prediction markets worth trading. Filters 300+ active markets, flags anomalies, and outputs a ranked list of opportunities.

## Trigger phrases
- "scan prediction markets"
- "busca mercados de prediccion"
- "find trading opportunities"
- "scan kalshi polymarket"
- "qué mercados hay en polymarket"

## What this skill does

1. Fetches active markets from Polymarket CLOB API and Kalshi REST API
2. Applies filters: volume > 200 contracts, time to expiry < 30 days, minimum liquidity present
3. Flags anomalies: price moves > 10% in last 24h, bid-ask spread > 5 cents, volume spikes > 2x average
4. Ranks markets by opportunity score (liquidity + anomaly weight)
5. Saves results to `${REPO_DIR}/workspace/prediction-market-bot/scan_results.json`
6. Outputs a summary and passes data to the research step

## API connections

### Polymarket CLOB API
- Docs: https://docs.polymarket.com
- Base URL: `https://clob.polymarket.com`
- Key endpoint: `GET /markets` — returns active markets with prices and volume
- Auth: POLYMARKET_API_KEY in env (paper trading: no key needed for reads)
- Key fields: `condition_id`, `question`, `tokens[].price`, `volume`, `end_date_iso`

### Kalshi REST API
- Docs: https://trading-api.readme.io
- Base URL: `https://trading-api.kalshi.com/trade-api/v2`
- Key endpoint: `GET /markets` — returns active markets
- Auth: Bearer token using KALSHI_API_KEY in env
- Key fields: `ticker`, `title`, `yes_bid`, `yes_ask`, `volume`, `close_time`

## Filtering logic

Apply ALL of the following filters before flagging a market:

```
volume >= 200 contracts (Polymarket) OR volume >= 200 trades (Kalshi)
days_to_expiry <= 30
bid_ask_spread <= 0.20 (20 cents max — above this, too illiquid)
current_price between 0.05 and 0.95 (avoid near-resolved markets)
```

## Anomaly flags (flag if any apply)

```
PRICE_MOVE   — price changed > 10% in last 24 hours
WIDE_SPREAD  — bid-ask spread > 5 cents
VOLUME_SPIKE — current volume > 2x 7-day average volume
LOW_PRICE    — price < 0.15 (contrarian opportunity check)
HIGH_PRICE   — price > 0.85 (contrarian opportunity check)
```

## Output format

Save to `${REPO_DIR}/workspace/prediction-market-bot/scan_results.json`:

```json
{
  "scan_timestamp": "2026-03-12T16:00:00Z",
  "total_scanned": 312,
  "flagged_count": 14,
  "markets": [
    {
      "source": "polymarket",
      "market_id": "0xabc123...",
      "question": "Will X happen by date Y?",
      "current_price": 0.43,
      "bid": 0.42,
      "ask": 0.44,
      "spread": 0.02,
      "volume_24h": 850,
      "volume_7d_avg": 340,
      "days_to_expiry": 12,
      "end_date": "2026-03-24",
      "anomaly_flags": ["VOLUME_SPIKE"],
      "opportunity_score": 7.2
    }
  ]
}
```

## Opportunity scoring

Score each market 0-10:
- Base: 5.0
- +1.0 per anomaly flag (max +3.0)
- +0.5 if volume > 500
- +1.0 if volume > 2000
- +0.5 if days_to_expiry between 7 and 21 (sweet spot)
- -1.0 if spread > 0.10

Only include markets with score >= 4.0 in output.

## Paper trading note

In paper trading mode (current default), this skill reads market data only — no authentication needed for Polymarket reads. Kalshi requires an API key even for reads. If KALSHI_API_KEY is not in env, skip Kalshi and note it in output.

## How to run

When triggered, execute this sequence:

1. Check if `scan_results.json` exists and is < 30 minutes old. If yes, use cached results and note it.
2. Fetch Polymarket markets:
```bash
curl -s "https://clob.polymarket.com/markets?limit=500&active=true" | python3 -c "
import sys, json
data = json.load(sys.stdin)
markets = data.get('data', [])
print(f'Fetched {len(markets)} Polymarket markets')
"
```
3. Fetch Kalshi markets (if KALSHI_API_KEY available):
```bash
KALSHI_KEY=$(grep KALSHI_API_KEY ${REPO_DIR}/.env 2>/dev/null | cut -d= -f2)
if [ -n "$KALSHI_KEY" ]; then
  curl -s -H "Authorization: Bearer $KALSHI_KEY" "https://trading-api.kalshi.com/trade-api/v2/markets?limit=200&status=open"
fi
```
4. Apply filters and anomaly detection
5. Score and rank markets
6. Save results to JSON
7. Return summary: "Found N markets worth researching. Top opportunity: [question] at [price] with [flags]."
8. Suggest next step: "Run predict-market-research to gather intel on these markets."

## Next step in pipeline

After this skill completes, the output feeds into `predict-market-research`.
Trigger: "research prediction market" or "investiga mercado de prediccion"
