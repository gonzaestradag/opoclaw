# predict-market-execute

Risk validation and order execution for prediction market trades. Runs all mandatory risk checks before any order. Currently in PAPER TRADING MODE — logs simulated trades only.

## Trigger phrases
- "execute prediction trade"
- "place market order"
- "ejecuta trade de prediccion"
- "run risk checks"
- "ejecuta las ordenes"
- "valida el riesgo y ejecuta"

## CRITICAL: Paper trading mode

**CURRENT STATUS: PAPER TRADING MODE**

No real orders are placed until Gonzalo explicitly provides API keys AND says "activate live trading". Until then, all "orders" are logged to `paper_trades.json` as simulations.

Live trading activation checklist:
- [ ] POLYMARKET_API_KEY in .env
- [ ] KALSHI_API_KEY in .env
- [ ] KALSHI_API_SECRET in .env
- [ ] Gonzalo says "activate live trading" explicitly
- [ ] All risk checks passing for at least 14 paper trades

## What this skill does

1. Reads trade signals from `predictions_log.json` (signals with status "pending")
2. Runs ALL mandatory risk checks via `validate_risk.py`
3. Calculates position size using Kelly Criterion
4. In paper trading: logs simulated order to `paper_trades.json`
5. In live mode: submits order to Polymarket or Kalshi API
6. Logs every execution attempt and result

## Input

Reads pending signals from:
`/Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/predictions_log.json`

Also reads current portfolio state:
`/Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/paper_trades.json`

## MANDATORY risk checks — ALL must pass

Run before every order:

```bash
python3 /Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/validate_risk.py \
  --edge [EDGE_VALUE] \
  --p_model [P_MODEL] \
  --p_market [P_MARKET] \
  --bankroll [CURRENT_BANKROLL] \
  --existing_exposure [TOTAL_OPEN_POSITIONS_USD] \
  --daily_pnl [TODAY_PNL] \
  --drawdown [PEAK_TO_TROUGH_RATIO] \
  --concurrent_positions [OPEN_POSITION_COUNT]
```

If the script exits with code 1 (any check failed), DO NOT proceed. Log the failure and skip the trade.

### Risk rules (hardcoded — never bypass):

| Rule | Limit | Action if breached |
|------|-------|-------------------|
| Minimum edge | > 0.04 | Block trade |
| Max drawdown | < 8% | Block ALL new trades |
| Daily loss limit | < 15% of bankroll | Stop for the day |
| Max per position | 5% of bankroll | Cap position size |
| Max concurrent positions | 15 | Block new trades |
| Max total exposure | 40% of bankroll | Block new trades |
| Max daily AI cost | $50 | Alert Gonzalo, reduce scan frequency |
| 95% VaR | Within daily limit | Warn, reduce size |

### Kelly Criterion position sizing

```bash
python3 /Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/kelly_size.py \
  --p_win [P_MODEL] \
  --payout_odds [PAYOUT_RATIO] \
  --bankroll [BANKROLL] \
  --max_fraction 0.05
```

Where:
- `payout_ratio = (1 / p_market) - 1` (net odds for binary market)
- Position is capped at 5% of bankroll regardless of Kelly result
- Use half-Kelly in practice: `position_size = kelly_result * 0.5` for lower variance

## Paper trading execution

When all checks pass, log to paper_trades.json:

```json
{
  "trade_id": "PT-20260312-001",
  "timestamp": "2026-03-12T17:00:00Z",
  "mode": "paper",
  "source": "polymarket",
  "market_id": "0xabc123...",
  "question": "Will X happen by date Y?",
  "direction": "YES",
  "entry_price": 0.43,
  "contracts": 45,
  "stake_usd": 19.35,
  "kelly_fraction": 0.019,
  "p_model": 0.67,
  "edge": 0.24,
  "target_exit_price": 0.67,
  "stop_loss_price": 0.30,
  "status": "open",
  "exit_price": null,
  "exit_timestamp": null,
  "pnl_usd": null,
  "outcome": null,
  "risk_checks_passed": true
}
```

Track running totals:
- `bankroll`: starting capital (set to $1000 for paper trading)
- `total_exposure`: sum of all open position stakes
- `daily_pnl`: today's realized P&L
- `peak_bankroll`: highest bankroll value (for drawdown calc)

## Live trading execution (when activated)

### Polymarket (CLOB API)
```python
# POST /order to place a buy order
headers = {
    "Authorization": f"Bearer {POLYMARKET_API_KEY}",
    "Content-Type": "application/json"
}
order_payload = {
    "orderType": "GTC",           # Good Till Cancelled
    "tokenID": market_token_id,
    "price": entry_price,
    "size": contracts,
    "side": "BUY"
}
response = requests.post("https://clob.polymarket.com/order", json=order_payload, headers=headers)
```

### Kalshi (REST API)
```python
# POST /portfolio/orders
headers = {
    "Authorization": f"Bearer {KALSHI_API_KEY}",
    "Content-Type": "application/json"
}
order_payload = {
    "ticker": market_ticker,
    "action": "buy",
    "side": "yes",                # or "no"
    "type": "limit",
    "yes_price": int(entry_price * 100),  # Kalshi uses cents
    "count": contracts
}
response = requests.post("https://trading-api.kalshi.com/trade-api/v2/portfolio/orders",
                        json=order_payload, headers=headers)
```

## Stop loss management

Set a soft stop when opening a position:
- Stop loss at: entry_price - (entry_price * 0.30) — exit if price drops 30%
- Take profit at: p_model price (wait for market to converge to your estimate)
- Time stop: if position is open > 5 days with no movement toward target, review and potentially close

Check open positions on each scan cycle. Log any exits to paper_trades.json.

## Execution output

After running, report:

```
Risk validation results:
- [Question 1]: PASS — Position: $19.35 (45 contracts @ 0.43) [PAPER]
- [Question 2]: FAIL — Daily loss limit reached. No new trades today.
- [Question 3]: PASS — Position: $12.00 (17 contracts @ 0.71) [PAPER]

2 paper trades logged. Portfolio: $1000 bankroll, $31.35 exposure (3.1%).
```

## Monitoring open positions

Check and update open paper positions:

```bash
# Check if any markets have resolved
python3 -c "
import json, datetime

with open('/Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/paper_trades.json') as f:
    trades = json.load(f)

open_trades = [t for t in trades if t['status'] == 'open']
print(f'{len(open_trades)} open positions')
for t in open_trades:
    print(f\"  {t['question'][:60]} | {t['direction']} @ {t['entry_price']} | stake: \${t['stake_usd']}\")
"
```

## Next step in pipeline

After trades are placed (paper or live), compound skill processes outcomes.
Trigger: "compound trades" or "analiza resultados trading"
