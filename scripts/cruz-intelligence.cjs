#!/usr/bin/env node
/**
 * Cruz Intelligence Agent v2
 * Runs continuously — always researching, loops every 45 minutes.
 *
 * Data sources:
 *   - Binance public klines → RSI(14), EMA(20/50), trend, momentum per pair
 *   - CoinDesk + CoinTelegraph RSS → news headlines per pair
 *   - Reddit r/CryptoCurrency + r/algotrading → crowd sentiment
 *   - Fear & Greed Index → macro mood
 *
 * Output: market_signal.json
 *   - global: sentiment, confidence, risk_level, fear_greed
 *   - pairs: { "BTC/USDT": { signal, confidence, rsi, trend, reason, avoid } }
 *
 * Both Satoshi and Nakamoto read this file to make trade decisions.
 * NO Telegram messages — all trading comms go via 7 PM daily report only.
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const BASE        = '/Users/opoclaw1/opoclaw';
const CC_BASE     = '/Users/opoclaw1/claudeclaw';
const SIGNAL_PATH = path.join(CC_BASE, 'store/market_signal.json');  // unified path in ClaudeClaw store
const DB_PATH     = path.join(CC_BASE, 'store/opoclaw.db');           // ClaudeClaw main DB (agents table lives here)
const LOG_PATH    = path.join(BASE, 'logs/cruz-intelligence.log');
const ENV_PATH    = path.join(CC_BASE, '.env');                        // ClaudeClaw .env has OPENAI_API_KEY

// How long to wait between cycles (milliseconds)
const CYCLE_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes

// Blacklisted pairs — memecoins, stablecoins, wrapped tokens
const BLACKLIST = new Set([
  'BNB/USDT',   // blacklisted in freqtrade config
  'DOGE/USDT', 'SHIB/USDT', 'PEPE/USDT', 'FLOKI/USDT', 'WIF/USDT',
  'BONK/USDT', 'BOME/USDT', 'MEME/USDT', 'COW/USDT',
  'USDC/USDT', 'BUSD/USDT', 'TUSD/USDT', 'USDP/USDT', 'FDUSD/USDT',
  'DAI/USDT',  'USDD/USDT',
  'WBTC/USDT', 'WBETH/USDT', 'STETH/USDT',
]);

// Max pairs to analyze (klines fetching is done in parallel but API has limits)
const MAX_PAIRS = 30;

// Coin keyword map — expanded, used for news matching
const BASE_KEYWORDS = {
  'BTC':   ['bitcoin', 'btc'],
  'ETH':   ['ethereum', 'eth', 'ether'],
  'SOL':   ['solana', 'sol'],
  'XRP':   ['xrp', 'ripple'],
  'BNB':   ['bnb', 'binance coin'],
  'AVAX':  ['avalanche', 'avax'],
  'LINK':  ['chainlink', 'link'],
  'DOT':   ['polkadot', 'dot'],
  'ADA':   ['cardano', 'ada'],
  'LTC':   ['litecoin', 'ltc'],
  'UNI':   ['uniswap', 'uni'],
  'ATOM':  ['cosmos', 'atom'],
  'NEAR':  ['near protocol', 'near'],
  'MATIC': ['polygon', 'matic'],
  'POL':   ['polygon', 'pol'],
  'ARB':   ['arbitrum', 'arb'],
  'OP':    ['optimism', 'op'],
  'SUI':   ['sui'],
  'APT':   ['aptos', 'apt'],
  'INJ':   ['injective', 'inj'],
  'SEI':   ['sei'],
  'TIA':   ['celestia', 'tia'],
  'FET':   ['fetch.ai', 'fet'],
  'WLD':   ['worldcoin', 'wld'],
  'RNDR':  ['render', 'rndr'],
  'AAVE':  ['aave'],
  'MKR':   ['maker', 'mkr'],
  'SNX':   ['synthetix', 'snx'],
  'LDO':   ['lido', 'ldo'],
  'ENA':   ['ethena', 'ena'],
  'JUP':   ['jupiter', 'jup'],
};

// ── Load env ──────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadEnv();

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19).replace('T',' ')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const timeout = options._timeout || 25000;
    delete options._timeout;
    const req = lib.request(url, { timeout, ...options }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Dynamic pair list from Binance ────────────────────────────────────────────
// Patterns that indicate non-tradeable assets (stablecoins, wrapped, commodities)
const SKIP_PATTERNS = [/^USD/, /^DAI/, /^TUSD/, /^PAXG/, /^XAU/, /WBTC/, /WETH/, /^U$/, /^EUR/, /^GBP/, /^TRY/, /^BRL/, /USD1/];

async function getTopPairs() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    const tickers = JSON.parse(r.body);
    const usdtPairs = tickers
      .filter(t => t.symbol.endsWith('USDT'))
      .filter(t => {
        const base = t.symbol.replace('USDT', '');
        const pair = `${base}/USDT`;
        if (BLACKLIST.has(pair)) return false;
        if (SKIP_PATTERNS.some(p => p.test(base))) return false;
        // Minimum $5M daily volume — captures all active coins even in bear markets
        return parseFloat(t.quoteVolume) > 5_000_000;
      })
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, MAX_PAIRS)
      .map(t => `${t.symbol.replace('USDT', '')}/USDT`);
    log(`Dynamic pair list (${usdtPairs.length}): ${usdtPairs.slice(0, 10).join(', ')}...`);
    return usdtPairs;
  } catch (e) {
    log(`Dynamic pairs fetch failed: ${e.message} — using fallback`);
    return [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT',
      'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'ADA/USDT',
      'LTC/USDT', 'UNI/USDT', 'ATOM/USDT', 'NEAR/USDT',
    ];
  }
}

// ── Fear & Greed ──────────────────────────────────────────────────────────────
async function getFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = JSON.parse(r.body);
    return { value: parseInt(d.data[0].value), label: d.data[0].value_classification };
  } catch (e) {
    log(`Fear & Greed fetch failed: ${e.message}`);
    return { value: 50, label: 'Neutral' };
  }
}

// ── RSS News ──────────────────────────────────────────────────────────────────
function parseRSSTitles(xml) {
  const titles = [];
  const re = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (t && t.length > 10 && !t.toLowerCase().includes('feed') && !t.toLowerCase().includes('rss')) {
      titles.push(t);
    }
  }
  return titles.slice(0, 30);
}

async function getNews(pairs) {
  const feeds = [
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cointelegraph.com/rss',
  ];
  const allTitles = [];
  for (const url of feeds) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'CruzIntelligenceBot/2.0' } });
      if (r.status === 200 && r.body.includes('<item>')) {
        allTitles.push(...parseRSSTitles(r.body));
      }
    } catch (e) {
      log(`RSS fetch failed (${url}): ${e.message}`);
    }
  }
  log(`News headlines collected: ${allTitles.length}`);

  // Categorize headlines per pair using BASE_KEYWORDS or fallback to coin symbol
  const newsPerPair = {};
  for (const pair of pairs) {
    const base = pair.split('/')[0];
    const keywords = BASE_KEYWORDS[base] || [base.toLowerCase()];
    newsPerPair[pair] = allTitles.filter(title =>
      keywords.some(kw => title.toLowerCase().includes(kw))
    ).slice(0, 5);
  }
  return { allTitles, newsPerPair };
}

// ── Reddit sentiment ──────────────────────────────────────────────────────────
async function getReddit(sub) {
  try {
    const r = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=10`, {
      headers: { 'User-Agent': 'CruzIntelligenceBot/2.0' },
    });
    const d = JSON.parse(r.body);
    return (d.data?.children || []).map(p => p.data.title);
  } catch (e) {
    log(`Reddit /${sub} failed: ${e.message}`);
    return [];
  }
}

// ── Binance Klines (public, no auth) ─────────────────────────────────────────
async function getKlines(pair, interval = '1h', limit = 60) {
  const symbol = pair.replace('/', '');
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url);
    const data = JSON.parse(r.body);
    if (!Array.isArray(data) || data.length < 20) return null;
    return data.map(c => ({
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (e) {
    log(`Klines fetch failed (${pair}): ${e.message}`);
    return null;
  }
}

// ── Technical Analysis ────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Smooth with prior candles
  for (let i = closes.length - period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 10) / 10;
}

function calcEMA(values, period) {
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return Math.round(ema * 100) / 100;
}

function analyzePair(pair, candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const price   = closes[closes.length - 1];

  const rsi   = calcRSI(closes);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  // Trend: compare current EMA20 vs 5 candles ago
  const ema20_prev = calcEMA(closes.slice(0, -5), 20);
  const trendUp    = ema20 > ema20_prev * 1.002;
  const trendDown  = ema20 < ema20_prev * 0.998;
  const trend      = trendUp ? 'up' : trendDown ? 'down' : 'sideways';

  // Momentum: last 3 candle closes vs opens
  const last3 = candles.slice(-3);
  const bullishCandles = last3.filter(c => c.close > c.open).length;
  const momentum = bullishCandles >= 2 ? 'building' : bullishCandles === 0 ? 'fading' : 'mixed';

  // Volume trend
  const avgVol   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol  = volumes[volumes.length - 1];
  const volSpike = lastVol > avgVol * 1.5;

  // Price vs EMAs
  const priceAboveEMA20 = price > ema20;
  const priceAboveEMA50 = price > ema50;

  return { pair, price, rsi, ema20, ema50, trend, momentum, volSpike, priceAboveEMA20, priceAboveEMA50 };
}

// ── OpenAI synthesis ──────────────────────────────────────────────────────────
async function synthesize(fearGreed, technicals, newsPerPair, redditTitles) {
  // Prioritize pairs with strong TA signals or news for the OpenAI prompt
  // This keeps the prompt focused and within token limits
  const prioritized = technicals
    .sort((a, b) => {
      const scoreA = (a.trend !== 'sideways' ? 2 : 0) + (a.momentum !== 'mixed' ? 1 : 0) + (newsPerPair[a.pair]?.length ? 2 : 0);
      const scoreB = (b.trend !== 'sideways' ? 2 : 0) + (b.momentum !== 'mixed' ? 1 : 0) + (newsPerPair[b.pair]?.length ? 2 : 0);
      return scoreB - scoreA;
    })
    .slice(0, 20); // Top 20 most interesting pairs for OpenAI analysis

  const pairSummaries = prioritized.map(t =>
    `${t.pair}: RSI=${t.rsi}, trend=${t.trend}, momentum=${t.momentum}, ` +
    `aboveEMA20=${t.priceAboveEMA20}, aboveEMA50=${t.priceAboveEMA50}` +
    (newsPerPair[t.pair]?.length ? ` | News: ${newsPerPair[t.pair].join(' | ')}` : '')
  ).join('\n');

  const redditSample = redditTitles.slice(0, 10).map(t => `- ${t}`).join('\n');

  const prompt = `You are Cruz, a crypto market intelligence system for an algorithmic trading bot running on Binance spot.

## Market Data (last 1-hour candles)

### Fear & Greed Index
${fearGreed.value}/100 — ${fearGreed.label}

### Per-Pair Technical Analysis
${pairSummaries}

### Reddit Crowd Sentiment (r/CryptoCurrency hot)
${redditSample || '(unavailable)'}

## Your Task
Analyze ALL data above and return ONLY valid JSON (no markdown, no explanation) with this EXACT structure:

{
  "global_sentiment": "bullish" | "bearish" | "neutral",
  "global_confidence": <integer 0-100>,
  "global_risk": "low" | "medium" | "high",
  "news_summary": "<2 sentences: current market situation>",
  "pairs": {
    "<PAIR>": {
      "signal": "buy" | "hold" | "avoid",
      "confidence": <integer 0-100>,
      "rsi": <float>,
      "trend": "up" | "down" | "sideways",
      "reason": "<one sentence, plain english>",
      "avoid": <true | false>
    }
  }
}

Signal rules per pair:
- "buy": RSI < 50, trend up or momentum building, no strong bearish news → good entry opportunity
- "avoid": RSI > 70 (overbought), trend down, or strong bearish news → skip this pair
- "hold": everything else → no strong signal either way

Global rules:
- global_risk "high" → bots should reduce position sizes
- global_confidence >= 70 → strong signal; < 40 → uncertain, bots should be extra cautious
- Include ALL pairs from the input data in the "pairs" object

Be specific and actionable. Bots trade real money.`;

  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2000,
  });

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    _timeout: 60000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body,
  });

  const d = JSON.parse(r.body);
  if (!d.choices?.[0]?.message?.content) throw new Error(`OpenAI error: ${JSON.stringify(d)}`);
  const raw = d.choices[0].message.content.trim()
    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(raw);
}

// ── Agent status update ───────────────────────────────────────────────────────
function setAgentStatus(status, task) {
  const tmpPy = `/tmp/cruz_status_${Date.now()}.py`;
  const taskVal = task ? JSON.stringify(task) : 'None';
  fs.writeFileSync(tmpPy, `import sqlite3
db = sqlite3.connect(${JSON.stringify(DB_PATH)})
db.execute("UPDATE agents SET status=?, current_task=?, updated_at=unixepoch() WHERE id='cruz-intelligence'",
           (${JSON.stringify(status)}, ${taskVal}))
db.commit()
db.close()
`);
  try {
    execSync(`python3 "${tmpPy}"`, { encoding: 'utf8' });
  } catch (e) {
    log(`Status update failed: ${e.message.split('\n')[0]}`);
  } finally {
    try { fs.unlinkSync(tmpPy); } catch {}
  }
}

// ── SQLite log ────────────────────────────────────────────────────────────────
function logToDB(signal) {
  const tmpJson = `/tmp/cruz_signal_${Date.now()}.json`;
  const tmpPy   = `/tmp/cruz_log_${Date.now()}.py`;
  try {
    fs.writeFileSync(tmpJson, JSON.stringify(signal));
    fs.writeFileSync(tmpPy, `
import sqlite3, json
with open(${JSON.stringify(tmpJson)}) as f:
    d = json.load(f)
db = sqlite3.connect(${JSON.stringify(DB_PATH)})
# Log to trading_intelligence if table exists
try:
    db.execute(
        "INSERT INTO trading_intelligence (sentiment,confidence,risk_level,avoid_pairs,trending_pairs,key_insights,news_summary) VALUES (?,?,?,?,?,?,?)",
        (d['global_sentiment'], d['global_confidence'], d['global_risk'],
         json.dumps([p for p,v in d.get('pairs',{}).items() if v.get('avoid')]),
         json.dumps([p for p,v in d.get('pairs',{}).items() if v.get('signal')=='buy']),
         json.dumps([f"{p}: {v.get('reason','')}" for p,v in d.get('pairs',{}).items() if v.get('signal')=='buy'][:3]),
         d.get('news_summary',''))
    )
except Exception:
    pass
db.execute(
    "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
    ('cruz-intelligence', 'Cruz', '🔍',
     f"Market signal: {d['global_sentiment'].upper()} {d['global_confidence']}% — {d['global_risk']} risk | buy: {[p for p,v in d.get('pairs',{}).items() if v.get('signal')=='buy']}",
     'info', 'trading')
)
db.commit()
db.close()
print('ok')
`);
    const result = execSync(`python3 "${tmpPy}"`, { encoding: 'utf8' }).trim();
    log(`DB logged: ${result}`);
  } catch (e) {
    log(`DB log failed: ${e.message.split('\n')[0]}`);
  } finally {
    try { fs.unlinkSync(tmpJson); } catch {}
    try { fs.unlinkSync(tmpPy);   } catch {}
  }
}

// ── Main analysis cycle ───────────────────────────────────────────────────────
async function runCycle() {
  log('Cruz Intelligence — starting analysis cycle');
  setAgentStatus('researching', 'Analyzing top 30 crypto pairs — RSI, EMA, news, sentiment');

  if (!OPENAI_KEY) {
    log('ERROR: OPENAI_API_KEY not set');
    setAgentStatus('idle');
    return;
  }

  // Get dynamic pair list first
  const PAIRS = await getTopPairs();

  // Fetch all global sources in parallel
  const [fearGreed, { allTitles, newsPerPair }, redditCrypto, redditAlgo] = await Promise.all([
    getFearGreed(),
    getNews(PAIRS),
    getReddit('CryptoCurrency'),
    getReddit('algotrading'),
  ]);

  const redditTitles = [...redditCrypto, ...redditAlgo];
  log(`Global: F&G=${fearGreed.value}, news=${allTitles.length}, reddit=${redditTitles.length}`);

  // Fetch klines for all pairs in parallel
  log(`Fetching klines for ${PAIRS.length} pairs...`);
  const klinesResults = await Promise.all(PAIRS.map(p => getKlines(p)));
  const technicals = [];
  for (let i = 0; i < PAIRS.length; i++) {
    if (klinesResults[i]) {
      const ta = analyzePair(PAIRS[i], klinesResults[i]);
      technicals.push(ta);
      log(`  ${PAIRS[i]}: RSI=${ta.rsi} trend=${ta.trend} momentum=${ta.momentum}`);
    } else {
      log(`  ${PAIRS[i]}: klines unavailable, skipping`);
    }
  }

  // Synthesize with OpenAI
  let signal;
  try {
    signal = await synthesize(fearGreed, technicals, newsPerPair, redditTitles);
    const buyPairs  = Object.entries(signal.pairs || {}).filter(([,v]) => v.signal === 'buy').map(([k]) => k);
    const avoidPairs = Object.entries(signal.pairs || {}).filter(([,v]) => v.avoid).map(([k]) => k);
    log(`Signal: ${signal.global_sentiment} | confidence=${signal.global_confidence} | risk=${signal.global_risk}`);
    log(`Buy signals: ${buyPairs.join(', ') || 'none'}`);
    log(`Avoid: ${avoidPairs.join(', ') || 'none'}`);
  } catch (e) {
    log(`Synthesis failed: ${e.message}`);
    // Fallback: derive basic signals from TA alone
    signal = {
      global_sentiment: 'neutral',
      global_confidence: 30,
      global_risk: 'medium',
      news_summary: 'Intelligence synthesis unavailable — using TA-only defaults.',
      pairs: {},
    };
    for (const t of technicals) {
      const rsiOk = t.rsi < 50;
      const trendOk = t.trend === 'up';
      signal.pairs[t.pair] = {
        signal:     (rsiOk && trendOk) ? 'buy' : t.rsi > 70 ? 'avoid' : 'hold',
        confidence: 40,
        rsi:        t.rsi,
        trend:      t.trend,
        reason:     'TA-only fallback (OpenAI unavailable)',
        avoid:      t.rsi > 70,
      };
    }
  }

  // Add metadata + backward-compat fields for strategies
  signal.fear_greed  = fearGreed;
  signal.updated_at  = new Date().toISOString();
  signal.next_update = new Date(Date.now() + 4 * 3600 * 1000).toISOString();

  // Backward-compat: global fields that old strategy code reads
  signal.sentiment    = signal.global_sentiment;
  signal.confidence   = signal.global_confidence;
  signal.risk_level   = signal.global_risk;
  signal.avoid_pairs  = Object.entries(signal.pairs || {}).filter(([,v]) => v.avoid).map(([k]) => k);
  signal.trending_pairs = Object.entries(signal.pairs || {}).filter(([,v]) => v.signal === 'buy').map(([k]) => k);

  // Write signal file (both bots read this)
  fs.writeFileSync(SIGNAL_PATH, JSON.stringify(signal, null, 2));
  log(`Signal written to ${SIGNAL_PATH}`);

  logToDB(signal);

  log('Cruz Intelligence — cycle complete. Per-pair signals live.');
  setAgentStatus('idle');
}

// ── Continuous loop ───────────────────────────────────────────────────────────
async function loop() {
  log('Cruz Intelligence — starting continuous research mode');
  // Ensure signal dir exists
  try { fs.mkdirSync(path.dirname(SIGNAL_PATH), { recursive: true }); } catch {}

  while (true) {
    try {
      await runCycle();
    } catch (e) {
      log(`Cycle error: ${e.message}`);
      setAgentStatus('idle');
    }

    log(`Next cycle in ${CYCLE_INTERVAL_MS / 60000} minutes...`);
    await new Promise(r => setTimeout(r, CYCLE_INTERVAL_MS));
  }
}

loop().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
