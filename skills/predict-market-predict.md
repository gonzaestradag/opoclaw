# predict-market-predict

Calculate model probability, edge vs market price, and generate trade signals. Uses an ensemble approach with Claude as the primary estimator. Only signals when confidence >= 0.65 and edge > 0.04.

## Trigger phrases
- "calculate edge"
- "predict market outcome"
- "generate trade signal"
- "evalua edge del mercado"
- "calcula el edge"
- "qué señal tienes para los mercados"

## What this skill does

1. Reads research results from `research_results.json`
2. For each market with a BUY signal, estimates p_model using Claude reasoning
3. Calculates edge: p_model - p_market
4. Calculates Expected Value
5. Filters signals below confidence threshold (0.65) or edge threshold (0.04)
6. Logs predictions to `predictions_log.json` for calibration tracking
7. Outputs final trade signals

## Input

Reads from: `${REPO_DIR}/workspace/prediction-market-bot/research_results.json`

Only processes markets with `research_signal` of "BUY_YES" or "BUY_NO".

## Core formulas

### Edge calculation
```
edge = p_model - p_market

Rule: Only generate signal when edge > 0.04 (4 cents minimum)
Rationale: Below 4 cents, transaction costs + variance eat the edge
```

### Expected Value
```
EV = (p_model * payout_if_win) - ((1 - p_model) * stake)

For binary markets where payout = 1/price:
  payout_ratio = 1 / p_market
  EV_per_dollar = p_model * (payout_ratio - 1) - (1 - p_model)

Positive EV required. Minimum EV = 0.02 per dollar staked.
```

### Brier Score (calibration tracking)
```
Brier Score = (p_model - actual_outcome)^2
Lower is better. Track per prediction, calculate rolling average.
Target: Brier Score < 0.20 (well-calibrated model)
```

## Probability estimation method

### Primary: Claude ensemble estimation

For each market, reason through the probability systematically:

```
Step 1: BASE RATE
  What is the historical base rate for this type of event?
  e.g., "Incumbents win re-election 68% of the time historically"

Step 2: CURRENT EVIDENCE ADJUSTMENT
  What does current evidence suggest vs the base rate?
  List 3-5 specific factors, each with a direction (+/-) and magnitude

Step 3: SENTIMENT WEIGHT
  Incorporate the sentiment score from research: {sentiment_score}
  Weight: 25% of final estimate

Step 4: FINAL ESTIMATE
  Combine base rate + evidence adjustments + sentiment weight
  State as: p_model = X.XX (e.g., 0.67)
  State confidence: how certain are you? 0.0 to 1.0

Step 5: SANITY CHECK
  Does p_model = 0.50 feel right as a "no edge" baseline here?
  Is there a strong asymmetric signal pushing it off center?
```

### Ensemble note (when additional keys are available)

The ideal system runs 3 independent estimates and aggregates them:
- Claude (primary, always available)
- GPT-4 (requires OPENAI_API_KEY — not yet configured)
- Gemini (requires GOOGLE_API_KEY — check .env)

When GOOGLE_API_KEY is available, optionally cross-validate with Gemini:
```bash
GEMINI_KEY=$(grep GOOGLE_API_KEY ${REPO_DIR}/.env 2>/dev/null | cut -d= -f2)
# If present, make a Gemini API call with the same market question for a second opinion
```

Ensemble aggregation: simple average of available estimates. Wider disagreement between models = lower confidence.

## Confidence threshold

Minimum confidence to generate any signal: **0.65**

Confidence is reduced by:
- Sparse research data (confidence_level < 0.50 in research): -0.15
- Market expiry < 5 days: -0.10 (harder to predict, less time for correction)
- High volume spike anomaly (might indicate information asymmetry): -0.10
- First time predicting this market type (no calibration history): -0.05

Confidence is increased by:
- Strong narrative consensus (|narrative_vs_market_gap| > 0.20): +0.10
- High research confidence (> 0.70): +0.10
- Similar past predictions were correct (check predictions_log.json): +0.10

## Output: trade signals

For each market, output:

```json
{
  "market_id": "0xabc123...",
  "question": "Will X happen by date Y?",
  "signal": "YES",          // YES / NO / HOLD
  "p_model": 0.67,
  "p_market": 0.43,
  "edge": 0.24,
  "ev_per_dollar": 0.18,
  "confidence": 0.71,
  "reasoning": "Base rate 55%. Strong narrative consensus (+0.12 gap). 3 quality sources. Adjusting up for recent momentum. Final: 0.67.",
  "recommended_action": "BUY YES at 0.43",
  "timestamp": "2026-03-12T16:45:00Z",
  "outcome": null,          // filled in post-resolution by compound skill
  "brier_score": null       // filled in post-resolution
}
```

Save all signals (including HOLD decisions) to:
`${REPO_DIR}/workspace/prediction-market-bot/predictions_log.json`

Append — do not overwrite. This file is the calibration history.

## Calibration check

Before generating new signals, read the last 50 entries from predictions_log.json and calculate:

```python
resolved = [p for p in predictions if p['outcome'] is not None]
if len(resolved) >= 10:
    correct = sum(1 for p in resolved if
                  (p['signal'] == 'YES' and p['outcome'] == 1) or
                  (p['signal'] == 'NO' and p['outcome'] == 0))
    accuracy = correct / len(resolved)
    avg_brier = sum(p['brier_score'] for p in resolved) / len(resolved)
    # If accuracy < 0.55, add -0.10 confidence penalty to all new signals
    # If avg_brier > 0.25, flag system as poorly calibrated
```

If poorly calibrated (accuracy < 55% over last 20 trades), add a warning to output and suggest running `predict-market-compound` to review failure patterns.

## Signal decision table

```
edge > 0.04 AND confidence >= 0.65 AND EV > 0.02  -> SIGNAL (YES or NO)
edge > 0.04 AND confidence < 0.65                  -> HOLD (not enough confidence)
edge <= 0.04 AND confidence >= 0.65                -> HOLD (not enough edge)
edge < 0                                           -> SKIP (market priced correctly or against us)
```

## Output summary to user

After processing all markets:

```
Trade signals generated:
- [Question 1]: BUY YES at 0.43 | edge: +0.24 | confidence: 71%
- [Question 2]: BUY NO at 0.71 | edge: +0.12 | confidence: 67%
- [Question 3]: HOLD — insufficient confidence (0.58)

2 actionable signals. Run predict-market-execute to validate risk and place orders.
```

## Next step in pipeline

After this skill completes, feed signals into `predict-market-execute`.
Trigger: "execute prediction trade" or "run risk checks"
