# predict-market-compound

Post-trade learning and system improvement. Runs post-mortems on resolved trades, classifies failures, tracks calibration, and feeds lessons back into the next scan cycle.

## Trigger phrases
- "compound trades"
- "post-mortem trade"
- "learn from trades"
- "analiza resultados trading"
- "revisa las trades resueltas"
- "qué aprendimos de los trades"
- "calibration report"

## What this skill does

1. Identifies resolved markets (trades where the market has expired and outcome is known)
2. Runs post-mortem on each resolved trade — especially losses
3. Classifies each failure by type
4. Saves lessons to `failure_log.md`
5. Calculates calibration metrics (Brier Score, accuracy by confidence band)
6. Generates performance stats and a calibration report
7. Updates `predictions_log.json` with actual outcomes and Brier Scores
8. Feeds lessons back as context for the next scan cycle

## Input

Reads from:
- `${REPO_DIR}/workspace/prediction-market-bot/paper_trades.json` — trade history
- `${REPO_DIR}/workspace/prediction-market-bot/predictions_log.json` — predictions
- `${REPO_DIR}/workspace/prediction-market-bot/failure_log.md` — existing lessons

## Step 1: Identify resolved trades

Check open trades in `paper_trades.json` against market APIs to see which have resolved:

```bash
# For Polymarket: check market status
# GET https://clob.polymarket.com/markets/{condition_id}
# Look for: "is_resolved": true, "resolution": "YES" or "NO"

# For Kalshi: check market status
# GET https://trading-api.kalshi.com/trade-api/v2/markets/{ticker}
# Look for: "status": "finalized", "result": "yes" or "no"

# In paper trading: manually check if market end_date has passed
# If end_date < now, treat as resolved and ask: what was the actual outcome?
```

For paper trading mode, use web search to find what actually happened:
- Search: "[market question]" + "result" + resolution date
- Determine if outcome was YES or NO
- Update paper_trades.json with the result

## Step 2: Post-mortem on each resolved trade

For every resolved trade, answer these questions:

```
1. Was the prediction correct? (outcome matches signal)
2. What was the actual p_model vs actual outcome (Brier Score)?
3. What evidence did we have at prediction time?
4. Was there any signal we missed?
5. Was the failure in prediction, timing, execution, or was it an external shock?
```

## Failure classification

Classify every loss (and near-misses) into exactly one category:

| Type | Definition | Example |
|------|-----------|---------|
| BAD_PREDICTION | Model estimate was wrong — narrative/evidence misread | Predicted YES at 70%, outcome was NO |
| BAD_TIMING | Model was right but resolved before market moved | Correct but exited early, price moved after |
| BAD_EXECUTION | Entered at wrong price or wrong size | Paid 0.50 when limit should have been 0.44 |
| EXTERNAL_SHOCK | Unforeseeable event changed outcome | Market resolved NO due to unprecedented event no one predicted |
| INFORMATION_ASYMMETRY | Market moved on info we didn't have | Price moved sharply just before resolution |

## Step 3: Update failure_log.md

Append lessons to `${REPO_DIR}/workspace/prediction-market-bot/failure_log.md`:

```markdown
## [DATE] — [MARKET QUESTION SHORT]

**Outcome:** LOSS / WIN
**Type:** BAD_PREDICTION / BAD_TIMING / etc.
**Signal:** [YES/NO] @ p_model=[X] vs p_market=[Y]
**Actual:** [actual outcome]
**Brier Score:** [value]

**What happened:**
[2-3 sentences on what the signal was and why it was wrong]

**What to avoid next time:**
- [Specific lesson 1]
- [Specific lesson 2]

**Pattern:** [Is this failure similar to a previous one? Tag it]
---
```

## Step 4: Calibration tracking

After updating all resolved trades, calculate calibration metrics:

```python
import json
import math

with open('${REPO_DIR}/workspace/prediction-market-bot/predictions_log.json') as f:
    predictions = json.load(f)

resolved = [p for p in predictions if p.get('outcome') is not None]

if len(resolved) >= 5:
    # Brier Score (lower = better calibrated, 0 = perfect)
    brier_scores = [(p['p_model'] - p['outcome'])**2 for p in resolved]
    avg_brier = sum(brier_scores) / len(brier_scores)

    # Accuracy
    correct = sum(1 for p in resolved if
                  (p['signal'] == 'YES' and p['outcome'] == 1) or
                  (p['signal'] == 'NO' and p['outcome'] == 0))
    accuracy = correct / len(resolved)

    # Calibration bands (are 70% confidence predictions right 70% of the time?)
    high_conf = [p for p in resolved if p['confidence'] >= 0.70]
    med_conf = [p for p in resolved if 0.60 <= p['confidence'] < 0.70]

    # P&L
    pnl_list = [t.get('pnl_usd', 0) for t in paper_trades if t.get('pnl_usd')]
    total_pnl = sum(pnl_list)
    win_rate = sum(1 for p in pnl_list if p > 0) / len(pnl_list) if pnl_list else 0
```

### Calibration health check

```
WELL_CALIBRATED:   Brier Score < 0.20, accuracy > 55%
ACCEPTABLE:        Brier Score 0.20-0.25, accuracy 50-55%
POORLY_CALIBRATED: Brier Score > 0.25 OR accuracy < 50%
```

If POORLY_CALIBRATED: add a -0.10 confidence penalty to all signals in `predict-market-predict` until Brier Score recovers.

## Step 5: Calibration report output

Generate and print a calibration report:

```
PREDICTION MARKET BOT — CALIBRATION REPORT
As of: [timestamp]

OVERALL PERFORMANCE
  Total predictions: [N]
  Resolved: [N] | Pending: [N]
  Win rate: [X]%
  Total P&L (paper): $[X]

CALIBRATION METRICS
  Avg Brier Score: [X] (target: <0.20)
  Status: [WELL_CALIBRATED / ACCEPTABLE / POORLY_CALIBRATED]

CONFIDENCE BANDS
  High confidence (>0.70): [N] trades, [X]% accuracy
  Medium confidence (0.60-0.70): [N] trades, [X]% accuracy

FAILURE BREAKDOWN
  BAD_PREDICTION: [N]
  BAD_TIMING: [N]
  BAD_EXECUTION: [N]
  EXTERNAL_SHOCK: [N]

TOP LESSONS (from failure_log.md)
  1. [Most recent lesson]
  2. [Second most recent]
  3. [Third most recent]

RECOMMENDATION: [Continue / Reduce position sizes / Review scan filters / Pause trading]
```

## Step 6: Feed lessons back into next cycle

Before each new scan cycle, the predict skills MUST:

```bash
# Read failure log — load lessons into context before generating new signals
cat ${REPO_DIR}/workspace/prediction-market-bot/failure_log.md
```

Instruct the scanner and predictor: "Read failure_log.md before processing any market. Apply the lessons listed there — avoid market types or situations flagged as recurring failure patterns."

## P&L calculation for resolved trades

When a market resolves:

```
If direction = YES and outcome = YES:
  pnl = (1/entry_price - 1) * stake_usd   # payout minus stake cost

If direction = YES and outcome = NO:
  pnl = -stake_usd   # lose the stake

If direction = NO and outcome = NO:
  pnl = (1/(1-entry_price) - 1) * stake_usd

If direction = NO and outcome = YES:
  pnl = -stake_usd
```

Update `paper_trades.json` entry with:
```json
{
  "status": "closed",
  "exit_price": 1.0,  // or 0.0
  "exit_timestamp": "...",
  "pnl_usd": [calculated_pnl],
  "outcome": 1  // or 0
}
```

## Next step in pipeline

After compound runs, feed the updated failure_log.md into the next `predict-market-scan` cycle.
The pipeline loops: scan → research → predict → execute → compound → scan...
