# predict-market-research

For each market flagged by the scanner, gather intelligence from web sources, run sentiment analysis, and compare narrative consensus vs current market price to find mispricing.

## Trigger phrases
- "research prediction market"
- "investiga mercado de prediccion"
- "gather intel on market"
- "sentiment analysis market"
- "qué dice el mercado sobre"
- "busca info de los mercados escaneados"

## What this skill does

1. Reads flagged markets from `scan_results.json`
2. For each market, searches Twitter/X, Reddit, and news sources for relevant sentiment
3. Runs NLP-style sentiment classification: bullish (YES), bearish (NO), neutral
4. Compares sentiment consensus vs current market price to identify gaps
5. Scores each market on research confidence
6. Saves results to `/Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/research_results.json`

## Input

Reads from: `/Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/scan_results.json`

If file does not exist or is older than 2 hours, tell Gonzalo to run `predict-market-scan` first.

## Data sources to search

For each market question, search all of the following:

### Twitter/X sentiment
- Search for the key terms from the market question
- Look for: recent tweets from accounts with >10k followers, news outlets, verified accounts
- Classify each source: BULLISH_YES / BEARISH_NO / NEUTRAL
- Weight recent tweets (last 6h) higher than older ones

### Reddit
- Relevant subreddits depend on topic:
  - Politics: r/politics, r/PoliticalDiscussion, r/neutralnews
  - Crypto: r/CryptoCurrency, r/Bitcoin, r/ethereum
  - Sports: r/sports, r/nba, r/nfl (topic-specific)
  - Economics: r/Economics, r/finance, r/investing
  - Tech: r/technology, r/singularity
- Look for: top posts in last 48h, comment sentiment in top threads

### News RSS / Web
- Google News search for market question terms
- AP, Reuters, BBC for factual reporting
- Relevant domain-specific outlets (ESPN for sports, Bloomberg for finance, etc.)

### Use Claude's web search tool to:
```
Search: "[market question key terms] latest news"
Search: "[market question key terms] prediction odds"
Search: "[market question key terms] expert opinion"
```

## Sentiment scoring

For each market, calculate:

```
sentiment_score: weighted average from -1.0 (strong NO) to +1.0 (strong YES)
  Twitter weight: 0.4
  Reddit weight: 0.3
  News weight: 0.3

confidence_level: 0.0 to 1.0
  Based on: number of sources found, source quality, recency of data
  Low (<0.4): few sources, old data, conflicting signals
  Medium (0.4-0.7): adequate sources, some recency
  High (>0.7): many quality sources, recent data, consistent signal
```

## Narrative vs market gap detection

This is the core signal. Calculate:

```
implied_probability_from_sentiment = (sentiment_score + 1) / 2  # convert -1..+1 to 0..1
narrative_vs_market_gap = implied_probability_from_sentiment - current_price

Interpretation:
  gap > +0.10: market underpriced — narrative says YES more than market does
  gap < -0.10: market overpriced — narrative says NO more than market does
  |gap| < 0.10: market roughly aligned with narrative — lower opportunity
```

## Output format

Save to `/Users/opoclaw1/claudeclaw/workspace/prediction-market-bot/research_results.json`:

```json
{
  "research_timestamp": "2026-03-12T16:30:00Z",
  "markets_researched": 14,
  "markets": [
    {
      "market_id": "0xabc123...",
      "question": "Will X happen by date Y?",
      "current_price": 0.43,
      "sentiment_score": 0.31,
      "implied_probability": 0.655,
      "narrative_vs_market_gap": 0.225,
      "confidence_level": 0.72,
      "key_sources": [
        {"source": "Reuters", "headline": "...", "sentiment": "BULLISH_YES"},
        {"source": "r/politics", "content": "...", "sentiment": "BULLISH_YES"}
      ],
      "narrative_summary": "Strong consensus forming around YES — 3 major news outlets, Reddit top posts lean bullish. Market at 0.43 appears to undervalue this outcome.",
      "research_signal": "BUY_YES",
      "research_confidence": 0.72
    }
  ]
}
```

## Research signal logic

```
If narrative_vs_market_gap > 0.10 AND confidence >= 0.50: research_signal = "BUY_YES"
If narrative_vs_market_gap < -0.10 AND confidence >= 0.50: research_signal = "BUY_NO"
Otherwise: research_signal = "HOLD"
```

## When to skip a market

Skip and mark as `research_signal: "SKIP"` if:
- Cannot find any relevant sources (topic too obscure)
- Sources are older than 72 hours and market expires in < 5 days
- Conflicting signals with confidence < 0.35

## Running the searches

For each market, use the WebSearch tool available in Claude skills:

```
Search 1: "[key question terms] news site:reuters.com OR site:apnews.com OR site:bbc.com"
Search 2: "[key question terms] reddit discussion 2026"
Search 3: "[key question terms] prediction forecast expert"
```

Synthesize results into the sentiment score and narrative summary.

## Time management

Process markets in priority order (highest opportunity_score first). If there are more than 10 markets, focus on the top 10 by opportunity score. Research quality > quantity.

## Next step in pipeline

After this skill completes, feed results into `predict-market-predict`.
Trigger: "calculate edge" or "evalua edge del mercado"
