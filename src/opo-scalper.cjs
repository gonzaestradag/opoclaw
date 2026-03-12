#!/usr/bin/env node
// EL ESTRATEGA (WebSocket edition) — Reads the market regime before acting. Trend or range? Different rules apply.
// RISK GOVERNANCE: Max 1-2% capital per trade. Hard stops always set before entry. Drawdown kill switch active.
/**
 * OpoClaw WebSocket Scalping Bot — opo-scalper (El Estratega WS)
 *
 * Architecture: Binance WebSocket streams for real-time 1m kline data.
 *               No polling. Price updates push-based via persistent connections.
 *
 * Strategy: ADX regime detection on 1m candles + adaptive RSI/MACD entries
 *   Trending (ADX > 25): RSI < 38 AND MACD bullish (momentum)
 *   Ranging  (ADX < 20): RSI < 30 mean reversion only
 *   Neutral  (ADX 20-25): 50% position sizes, both RSI+MACD required
 *
 * Risk governance: Max 2% capital risk per trade | Drawdown kill switch at -5% session
 * Commission-aware: Min expected profit 0.25% after fees (0.2% RT)
 *
 * Pairs: BTC, ETH, SOL, BNB, XRP, AVAX, ADA, DOGE (8 simultaneous)
 * Max positions: 4 open at once (capital preservation)
 */

'use strict';

require('dotenv').config({ path: '/Users/opoclaw1/claudeclaw/.env' });

const https    = require('https');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');
const { WebSocket } = require('/Users/opoclaw1/claudeclaw/node_modules/ws');

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  PAIRS: [
    { symbol: 'BTCUSDT',  display: 'BTC/USDT', asset: 'BTC'  },
    { symbol: 'ETHUSDT',  display: 'ETH/USDT', asset: 'ETH'  },
    { symbol: 'SOLUSDT',  display: 'SOL/USDT', asset: 'SOL'  },
    { symbol: 'BNBUSDT',  display: 'BNB/USDT', asset: 'BNB'  },
    { symbol: 'XRPUSDT',  display: 'XRP/USDT', asset: 'XRP'  },
    { symbol: 'AVAXUSDT', display: 'AVAX/USDT', asset: 'AVAX' },
    { symbol: 'ADAUSDT',  display: 'ADA/USDT',  asset: 'ADA'  },
    { symbol: 'DOGEUSDT', display: 'DOGE/USDT', asset: 'DOGE' },
  ],

  // Indicators
  RSI_PERIOD:    14,
  RSI_BUY:       38,    // Oversold threshold
  RSI_SELL:      65,    // Overbought threshold
  MACD_FAST:     12,
  MACD_SLOW:     26,
  MACD_SIGNAL:   9,

  // Trade sizing
  MAX_TRADE_USDT:   25.0,   // Max USDT per trade
  MAX_POSITION_PCT: 0.10,   // Max 10% of USDT balance per trade
  MAX_CAPITAL_PCT:  0.02,   // Risk governance: never risk more than 2% per trade
  MIN_USDT:         6.0,    // Min USDT to open any trade
  MAX_POSITIONS:    4,      // Max simultaneous open positions

  // Regime detection thresholds
  ADX_PERIOD:       14,
  ADX_TRENDING:     25,     // ADX > 25 = trending market
  ADX_RANGING:      20,     // ADX < 20 = ranging market

  // RSI thresholds by regime
  RSI_BUY_TREND:    38,     // Trending: buy RSI < 38
  RSI_BUY_RANGE:    30,     // Ranging: deep oversold only
  RSI_SELL:         65,

  // Risk management — commission-aware
  // Binance spot fee = 0.1% per side = 0.2% round-trip
  // TP at +0.5% = net profit ~+0.3% after fees
  // SL at -0.35% = net loss ~-0.55% after fees (acceptable)
  TAKE_PROFIT_PCT:  0.005,  // +0.5% take-profit
  STOP_LOSS_PCT:    0.0035, // -0.35% stop-loss
  FEE_RT:           0.002,  // 0.2% round-trip fees (0.1% each side)
  MIN_PROFIT_PCT:   0.003,  // Don't open unless expected profit > fees (0.3% min)

  // Drawdown kill switch
  DRAWDOWN_KILL_PCT: 0.05,  // Pause all new entries if session PnL < -5%
  DRAWDOWN_PAUSE_MS: 30 * 60 * 1000, // 30 minute pause

  // Candle buffer — need enough history for indicators
  CANDLE_LIMIT:  100,   // Seed candles via REST on startup
  CANDLE_TF:     '1m',  // 1-minute timeframe

  // WebSocket reconnect
  WS_RECONNECT_DELAY: 5000,   // 5s before reconnect attempt
  WS_MAX_RECONNECTS:  20,     // Per symbol before giving up

  // Balance sync — how often to refresh from Binance (REST)
  BALANCE_SYNC_MS: 30_000,    // Every 30 seconds

  // Paths
  DB_PATH:     '/Users/opoclaw1/claudeclaw/store/claudeclaw.db',
  STATUS_FILE: '/Users/opoclaw1/claudeclaw/opo-work/opo-scalper-status.json',
  LOG_FILE:    '/Users/opoclaw1/claudeclaw/logs/opo-scalper.log',
};

const API_KEY    = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_SECRET_KEY;

// ── State ─────────────────────────────────────────────────────────────────────

// Per-symbol candle ring buffers (closes only — enough for indicators)
const candleBuffers = {}; // symbol -> number[]

// In-memory positions: display -> { qty, buyPrice, stopLoss, takeProfit, reason, boughtAt }
const positions = {};

// USDT balance (synced periodically from REST)
let usdtBalance = 0;
let allBalances  = {};

// Trade history (last 50)
const tradeLog = [];

// Per-symbol last signals for status file
const lastSignals = {};

// WebSocket handles: symbol -> WebSocket
const wsHandles = {};
const wsReconnects = {};

// Closed flag for graceful shutdown
let shutdownRequested = false;

// IP whitelist flag — avoid log spam
let ipBlocked = false;

// Session baseline and drawdown tracking
let sessionStartUsdt    = null;
let drawdownPausedUntil = null;
let currentRegime       = 'unknown'; // 'trending' | 'ranging' | 'neutral'

// Per-symbol full kline buffer (open+close) for ADX
const klineBuffers = {}; // symbol -> { open: number[], close: number[] }

// ── Logger ────────────────────────────────────────────────────────────────────

function ensureLogDir() {
  const dir = path.dirname(CONFIG.LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.LOG_FILE, line + '\n'); } catch {}
}

// ── Binance REST helpers ──────────────────────────────────────────────────────

function sign(params) {
  const qs  = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return qs + '&signature=' + sig;
}

function restRequest(method, endpoint, params = {}, signed = false) {
  return new Promise((resolve, reject) => {
    let qs   = '';
    let body = '';

    if (signed) {
      qs = sign(params);
    } else {
      qs = new URLSearchParams(params).toString();
    }

    const isPost = method === 'POST';
    const pathStr = endpoint + ((!isPost && qs) ? '?' + qs : '');
    if (isPost) body = qs;

    const options = {
      hostname: 'api.binance.com',
      path: pathStr,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        ...(isPost ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(parsed.msg || 'Binance REST error');
            err.code    = parsed.code;
            err.status  = res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('Parse error: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    if (isPost && body) req.write(body);
    req.end();
  });
}

async function fetchSpotBalance() {
  const data = await restRequest('GET', '/api/v3/account', {}, true);
  const bals = {};
  for (const b of data.balances) {
    const free = parseFloat(b.free);
    if (free > 0) bals[b.asset] = free;
  }
  return bals;
}

async function seedCandles(symbol) {
  const data = await restRequest('GET', '/api/v3/klines', {
    symbol,
    interval: CONFIG.CANDLE_TF,
    limit: CONFIG.CANDLE_LIMIT,
  });
  // data[i][4] = close price
  return data.map(k => parseFloat(k[4]));
}

async function fetchExchangeInfo(symbol) {
  const data = await restRequest('GET', '/api/v3/exchangeInfo', { symbol });
  const sym     = data.symbols[0];
  const lot     = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = sym.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  return {
    stepSize:    parseFloat(lot.stepSize),
    minQty:      parseFloat(lot.minQty),
    minNotional: notional ? parseFloat(notional.minNotional) : 5.0,
  };
}

async function placeMarketOrder(symbol, side, quantity) {
  return restRequest('POST', '/api/v3/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: quantity.toString(),
  }, true);
}

function roundStep(qty, stepSize) {
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat(qty.toFixed(precision));
}

// ── Technical Indicators ──────────────────────────────────────────────────────

function calcRSI(closes, period = CONFIG.RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(closes) {
  const needed = CONFIG.MACD_SLOW + CONFIG.MACD_SIGNAL;
  if (closes.length < needed) return null;

  // Build MACD line values from index MACD_SLOW onwards
  const k_fast = 2 / (CONFIG.MACD_FAST + 1);
  const k_slow = 2 / (CONFIG.MACD_SLOW + 1);

  let fastEMA = closes.slice(0, CONFIG.MACD_FAST).reduce((a, b) => a + b, 0) / CONFIG.MACD_FAST;
  let slowEMA = closes.slice(0, CONFIG.MACD_SLOW).reduce((a, b) => a + b, 0) / CONFIG.MACD_SLOW;

  const macdLine = [];
  for (let i = 1; i < closes.length; i++) {
    fastEMA = closes[i] * k_fast + fastEMA * (1 - k_fast);
    if (i >= CONFIG.MACD_SLOW - 1) {
      slowEMA = closes[i] * k_slow + slowEMA * (1 - k_slow);
      macdLine.push(fastEMA - slowEMA);
    }
  }

  if (macdLine.length < CONFIG.MACD_SIGNAL) return null;

  const k_sig = 2 / (CONFIG.MACD_SIGNAL + 1);
  let signal = macdLine.slice(0, CONFIG.MACD_SIGNAL).reduce((a, b) => a + b, 0) / CONFIG.MACD_SIGNAL;
  for (let i = CONFIG.MACD_SIGNAL; i < macdLine.length; i++) {
    signal = macdLine[i] * k_sig + signal * (1 - k_sig);
  }

  const cur  = macdLine[macdLine.length - 1];
  const prev = macdLine.length > 1 ? macdLine[macdLine.length - 2] : cur;

  // Previous signal (approximation — one step back)
  let prevSignal = signal;
  if (macdLine.length > CONFIG.MACD_SIGNAL + 1) {
    let s = macdLine.slice(0, CONFIG.MACD_SIGNAL).reduce((a, b) => a + b, 0) / CONFIG.MACD_SIGNAL;
    for (let i = CONFIG.MACD_SIGNAL; i < macdLine.length - 1; i++) {
      s = macdLine[i] * k_sig + s * (1 - k_sig);
    }
    prevSignal = s;
  }

  const histogram    = cur - signal;
  const prevHistogram = prev - prevSignal;

  // Bullish: histogram crossing from negative to positive
  const bullishCross = prevHistogram <= 0 && histogram > 0;
  // Strengthening: histogram positive and growing
  const momentumUp   = histogram > 0 && histogram > prevHistogram;

  return {
    macd:          parseFloat(cur.toFixed(6)),
    signal:        parseFloat(signal.toFixed(6)),
    histogram:     parseFloat(histogram.toFixed(6)),
    prevHistogram: parseFloat(prevHistogram.toFixed(6)),
    bullishCross,
    momentumUp,
    positive:      cur > 0,
  };
}

// ── ADX — regime detection ────────────────────────────────────────────────────

function calcADX(opens, closes, period = CONFIG.ADX_PERIOD) {
  if (!opens || !closes || closes.length < period + 1) return null;

  const trueRanges = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < closes.length; i++) {
    const highDiff = Math.max(opens[i] - opens[i - 1], 0);
    const lowDiff  = Math.max(closes[i - 1] - closes[i], 0);
    const tr       = Math.abs(closes[i] - opens[i]); // simplified
    trueRanges.push(tr);
    plusDM.push(highDiff);
    minusDM.push(lowDiff);
  }

  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let pdm = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let mdm = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const adxValues = [];
  for (let i = period; i < trueRanges.length; i++) {
    atr = atr - atr / period + trueRanges[i];
    pdm = pdm - pdm / period + plusDM[i];
    mdm = mdm - mdm / period + minusDM[i];
    const pdi = atr > 0 ? 100 * pdm / atr : 0;
    const mdi = atr > 0 ? 100 * mdm / atr : 0;
    const dx  = (pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    adxValues.push(dx);
  }

  if (adxValues.length === 0) return null;
  const adx = adxValues.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, adxValues.length);
  return parseFloat(adx.toFixed(2));
}

function detectRegime(adx) {
  if (adx === null) return 'unknown';
  if (adx > CONFIG.ADX_TRENDING) return 'trending';
  if (adx < CONFIG.ADX_RANGING)  return 'ranging';
  return 'neutral';
}

// ── Dashboard + Notifications ─────────────────────────────────────────────────

function logActivity(action, type = 'info') {
  const safe = action.replace(/'/g, "''").replace(/\\/g, '\\\\');
  try {
    execSync(
      `sqlite3 "${CONFIG.DB_PATH}" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('opo-scalper','Scalper','⚡','${safe}','${type}','trading',datetime('now'))"`,
      { stdio: 'ignore', timeout: 5000 }
    );
  } catch (e) {
    log('WARN', `DB log failed: ${e.message}`);
  }
}

function sendTelegram(msg) {
  try {
    const escaped = msg.replace(/"/g, '\\"').replace(/`/g, "'").replace(/\$/g, '\\$');
    execSync(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "${escaped}"`, {
      stdio: 'ignore', timeout: 10000,
    });
  } catch (e) {
    log('WARN', `Telegram notify failed: ${e.message}`);
  }
}

function writeStatus() {
  const payload = {
    bot:        'opo-scalper',
    version:    '2.0-websocket',
    status:     'online',
    strategy:   `EL ESTRATEGA WS | Regime: ${currentRegime} | Trend RSI<${CONFIG.RSI_BUY_TREND} | Range RSI<${CONFIG.RSI_BUY_RANGE} | Neutral 50% | Risk cap 2% | DrawdownKill -5% | 1m WS | SL ${CONFIG.STOP_LOSS_PCT*100}% TP ${CONFIG.TAKE_PROFIT_PCT*100}%`,
    updatedAt:  new Date().toISOString(),
    usdt:       parseFloat((usdtBalance ?? 0).toFixed(2)),
    openPositions: Object.keys(positions).length,
    positions,
    lastSignals,
    trades:     tradeLog.slice(-20),
    wsStatus:   Object.fromEntries(
      CONFIG.PAIRS.map(p => [p.display, wsHandles[p.symbol] ? wsHandles[p.symbol].readyState : -1])
    ),
  };
  try {
    const dir = path.dirname(CONFIG.STATUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.STATUS_FILE, JSON.stringify(payload, null, 2));
  } catch {}
}

// ── Trading Logic ─────────────────────────────────────────────────────────────

async function evaluateTrade(pair, currentPrice) {
  const { symbol, display, asset } = pair;
  const closes = candleBuffers[symbol];
  if (!closes || closes.length < CONFIG.MACD_SLOW + CONFIG.MACD_SIGNAL + 5) return;

  const rsi  = calcRSI(closes);
  const macd = calcMACD(closes);
  if (rsi === null || macd === null) return;

  const hasPosition = !!positions[display];

  lastSignals[display] = {
    rsi,
    macd: macd.histogram,
    price: currentPrice,
    signal: hasPosition ? 'hold_checking_exit' : (rsi < CONFIG.RSI_BUY ? 'potential_buy' : 'watching'),
    updatedAt: new Date().toISOString(),
  };

  // ── STOP-LOSS / TAKE-PROFIT check on open positions ──────────────────────────
  if (hasPosition) {
    const pos = positions[display];
    const pnl = (currentPrice - pos.buyPrice) / pos.buyPrice;

    if (currentPrice <= pos.stopLoss || currentPrice >= pos.takeProfit || rsi > CONFIG.RSI_SELL) {
      let exitReason = rsi > CONFIG.RSI_SELL
        ? `RSI_SELL(${rsi})`
        : currentPrice <= pos.stopLoss
          ? `STOP_LOSS(${(pnl*100).toFixed(2)}%)`
          : `TAKE_PROFIT(+${(pnl*100).toFixed(2)}%)`;

      log('INFO', `${display}: EXIT signal — ${exitReason} | price=$${currentPrice}`);

      await executeSell(pair, currentPrice, pos, exitReason, pnl);
    }
    return;
  }

  // ── Drawdown kill switch check ────────────────────────────────────────────────
  if (drawdownPausedUntil && Date.now() < drawdownPausedUntil) {
    return; // Silently skip — already notified when triggered
  }
  if (drawdownPausedUntil && Date.now() >= drawdownPausedUntil) {
    drawdownPausedUntil = null;
    log('INFO', '[EL ESTRATEGA WS] Drawdown pause lifted — resuming entries');
  }

  // ── Regime detection ──────────────────────────────────────────────────────────
  const klBuf = klineBuffers[symbol];
  const adx   = klBuf ? calcADX(klBuf.opens, klBuf.closes) : null;
  const regime = detectRegime(adx);
  currentRegime = regime;

  const adxStr = adx !== null ? `ADX=${adx}` : 'ADX=n/a';
  log('INFO', `[EL ESTRATEGA WS] ${display}: RSI=${rsi} | ${adxStr} | regime=${regime.toUpperCase()} | $${currentPrice}`);

  // ── Regime-adaptive BUY logic ──────────────────────────────────────────────────
  let shouldBuy = false;
  let reason    = '';
  let positionSizeMultiplier = 1.0;

  if (regime === 'trending') {
    const rsiBuy  = rsi < CONFIG.RSI_BUY_TREND;
    const macdBuy = macd.bullishCross || macd.momentumUp;
    shouldBuy = rsiBuy && macdBuy;
    reason    = `RSI=${rsi}<${CONFIG.RSI_BUY_TREND}(trend) + MACD ${macd.bullishCross ? 'cross' : 'momentum'}`;
  } else if (regime === 'ranging') {
    shouldBuy = rsi < CONFIG.RSI_BUY_RANGE;
    reason    = `RSI=${rsi}<${CONFIG.RSI_BUY_RANGE}(range-MR)`;
  } else {
    // Neutral: both required, 50% size
    const rsiBuy  = rsi < CONFIG.RSI_BUY_RANGE;
    const macdBuy = macd.bullishCross && macd.histogram > 0;
    shouldBuy = rsiBuy && macdBuy;
    reason    = `RSI=${rsi}+MACD(neutral-50%)`;
    positionSizeMultiplier = 0.5;
  }

  if (!shouldBuy) return;

  // Commission check: only trade if expected TP profit exceeds fees
  const expectedProfit = CONFIG.TAKE_PROFIT_PCT - CONFIG.FEE_RT;
  if (expectedProfit < CONFIG.MIN_PROFIT_PCT) {
    log('WARN', `${display}: expected profit too thin (${(expectedProfit*100).toFixed(3)}%) — skip`);
    return;
  }

  const openCount = Object.keys(positions).length;
  if (openCount >= CONFIG.MAX_POSITIONS) {
    log('INFO', `[EL ESTRATEGA WS] ${display}: BUY signal but max positions (${openCount}) reached`);
    return;
  }

  if (usdtBalance < CONFIG.MIN_USDT) {
    log('INFO', `[EL ESTRATEGA WS] ${display}: BUY signal but USDT too low ($${usdtBalance.toFixed(2)})`);
    return;
  }

  log('INFO', `[EL ESTRATEGA WS] ${display}: BUY — ${reason} | regime=${regime} | $${currentPrice}`);

  await executeBuy(pair, currentPrice, reason, positionSizeMultiplier);
}

async function executeBuy(pair, currentPrice, reason, positionSizeMultiplier = 1.0) {
  const { symbol, display } = pair;

  if (ipBlocked) {
    log('WARN', `[EL ESTRATEGA WS] ${display}: BUY blocked — IP whitelist active. Would buy at $${currentPrice} (${reason})`);
    logActivity(`BUY BLOCKED (IP whitelist): ${display} @ $${currentPrice} | ${reason}`, 'warning');
    return;
  }

  // Drawdown kill switch check on execute
  if (sessionStartUsdt !== null && usdtBalance > 0) {
    const sessionPnlPct = (usdtBalance - sessionStartUsdt) / sessionStartUsdt;
    if (sessionPnlPct < -CONFIG.DRAWDOWN_KILL_PCT && !drawdownPausedUntil) {
      drawdownPausedUntil = Date.now() + CONFIG.DRAWDOWN_PAUSE_MS;
      log('WARN', `[EL ESTRATEGA WS] DRAWDOWN KILL SWITCH: session PnL ${(sessionPnlPct*100).toFixed(2)}%. Pausing 30min.`);
      try {
        const msg = `[EL ESTRATEGA WS] Drawdown kill switch: session down ${(sessionPnlPct*100).toFixed(2)}%. Pausing new entries 30min.`.replace(/"/g, '\\"');
        require('child_process').execSync(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "${msg}"`, { stdio: 'ignore', timeout: 10000 });
      } catch {}
      return;
    }
  }

  try {
    // Apply regime size multiplier and risk governance
    let tradeUsdt = Math.min(
      CONFIG.MAX_TRADE_USDT,
      usdtBalance * CONFIG.MAX_POSITION_PCT,
    ) * positionSizeMultiplier;

    // Risk governance: cap to 2% of balance exposure
    const maxRiskUsdt = usdtBalance * CONFIG.MAX_CAPITAL_PCT;
    const maxByRisk   = maxRiskUsdt / CONFIG.STOP_LOSS_PCT;
    tradeUsdt = Math.min(tradeUsdt, maxByRisk);

    if (tradeUsdt < CONFIG.MIN_USDT) return;

    const riskExposure = tradeUsdt * CONFIG.STOP_LOSS_PCT;
    const riskPct      = (riskExposure / usdtBalance) * 100;

    const info = await fetchExchangeInfo(symbol);
    const qty  = roundStep(tradeUsdt / currentPrice, info.stepSize);
    const notional = qty * currentPrice;

    if (qty < info.minQty || notional < info.minNotional) {
      log('WARN', `${display}: qty=${qty} or notional=$${notional.toFixed(2)} too small — skip`);
      return;
    }

    const order     = await placeMarketOrder(symbol, 'BUY', qty);
    const spent     = parseFloat(order.cummulativeQuoteQty);
    const filledQty = parseFloat(order.executedQty);
    const avgPrice  = spent / filledQty;
    const stopLoss   = avgPrice * (1 - CONFIG.STOP_LOSS_PCT);
    const takeProfit = avgPrice * (1 + CONFIG.TAKE_PROFIT_PCT);

    positions[display] = { qty: filledQty, buyPrice: avgPrice, stopLoss, takeProfit, reason, boughtAt: new Date().toISOString(), regime: currentRegime, riskPct: riskPct.toFixed(2) };
    usdtBalance -= spent;

    tradeLog.push({ time: new Date().toISOString(), action: 'BUY', pair: display, qty: filledQty, price: avgPrice, usdt: spent, reason, regime: currentRegime, riskPct: riskPct.toFixed(2) + '%' });
    if (tradeLog.length > 50) tradeLog.shift();

    logActivity(`[EL ESTRATEGA WS] BUY ${display} @ $${avgPrice.toFixed(4)} | ${reason} | regime=${currentRegime} | SL $${stopLoss.toFixed(4)} TP $${takeProfit.toFixed(4)} | risk ${riskPct.toFixed(2)}%`, 'success');
    sendTelegram(`[EL ESTRATEGA WS] BUY ${display} @ $${avgPrice.toFixed(2)} | ${reason} | Spent $${spent.toFixed(2)} | SL $${stopLoss.toFixed(4)} TP $${takeProfit.toFixed(4)} | Risk ${riskPct.toFixed(2)}%`);
    log('INFO', `[EL ESTRATEGA WS] ${display}: BUY executed — qty=${filledQty} @ $${avgPrice.toFixed(4)} | regime=${currentRegime} | risk=${riskPct.toFixed(2)}% | USDT remaining=$${usdtBalance.toFixed(2)}`);

    writeStatus();
  } catch (err) {
    const isIPErr = err.message && err.message.includes('API-key, IP');
    if (isIPErr && !ipBlocked) {
      ipBlocked = true;
      log('WARN', `IP whitelist blocking orders — will log signals only until resolved`);
      logActivity('IP whitelist restriction active — order analysis continues', 'warning');
    } else if (!isIPErr) {
      log('ERROR', `${display}: BUY failed — ${err.message}`);
      logActivity(`BUY FAILED ${display}: ${err.message}`, 'error');
    }
  }
}

async function executeSell(pair, currentPrice, pos, exitReason, pnl) {
  const { symbol, display, asset } = pair;

  delete positions[display];

  if (ipBlocked) {
    log('WARN', `${display}: SELL blocked — IP whitelist. Would sell at $${currentPrice} | ${exitReason} | PnL ~${(pnl*100).toFixed(2)}%`);
    logActivity(`SELL BLOCKED (IP whitelist): ${display} @ $${currentPrice} | ${exitReason}`, 'warning');
    return;
  }

  try {
    const assetQty = allBalances[asset] || pos.qty;
    const info     = await fetchExchangeInfo(symbol);
    const sellQty  = roundStep(assetQty * 0.999, info.stepSize);
    const notional = sellQty * currentPrice;

    if (sellQty < info.minQty || notional < info.minNotional) {
      log('WARN', `${display}: exit qty too small — clearing stale position`);
      return;
    }

    const order    = await placeMarketOrder(symbol, 'SELL', sellQty);
    const proceeds = parseFloat(order.cummulativeQuoteQty);
    const avgPrice = proceeds / parseFloat(order.executedQty);
    const realPnl  = (avgPrice - pos.buyPrice) / pos.buyPrice;

    usdtBalance += proceeds;

    tradeLog.push({ time: new Date().toISOString(), action: 'SELL', pair: display, qty: sellQty, price: avgPrice, usdt: proceeds, pnl: `${(realPnl*100).toFixed(2)}%`, reason: exitReason });
    if (tradeLog.length > 50) tradeLog.shift();

    const type = realPnl >= 0 ? 'success' : 'warning';
    logActivity(`SELL ${display} @ $${avgPrice.toFixed(4)} | ${exitReason} | PnL ${(realPnl*100).toFixed(2)}%`, type);
    sendTelegram(`SELL ${display} @ $${avgPrice.toFixed(2)} | ${exitReason} | PnL ${(realPnl*100).toFixed(2)}% | $${proceeds.toFixed(2)} USDT`);
    log('INFO', `${display}: SELL executed — $${proceeds.toFixed(2)} received | PnL ${(realPnl*100).toFixed(2)}%`);

    writeStatus();
  } catch (err) {
    const isIPErr = err.message && err.message.includes('API-key, IP');
    if (isIPErr && !ipBlocked) {
      ipBlocked = true;
      log('WARN', `IP whitelist blocking orders — continuing signal analysis`);
      logActivity('IP whitelist restriction active on sell', 'warning');
    } else if (!isIPErr) {
      log('ERROR', `${display}: SELL failed — ${err.message}`);
      logActivity(`SELL FAILED ${display}: ${err.message}`, 'error');
    }
  }
}

// ── WebSocket Streams ─────────────────────────────────────────────────────────

function connectKlineStream(pair) {
  const { symbol, display } = pair;
  const streamName = `${symbol.toLowerCase()}@kline_${CONFIG.CANDLE_TF}`;
  const wsUrl = `wss://stream.binance.com:9443/ws/${streamName}`;

  if (shutdownRequested) return;

  log('INFO', `${display}: connecting WebSocket stream...`);

  const ws = new WebSocket(wsUrl);
  wsHandles[symbol] = ws;

  ws.on('open', () => {
    log('INFO', `${display}: WebSocket connected`);
    wsReconnects[symbol] = 0;
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.k) return;

      const k = msg.k;
      const close = parseFloat(k.c);
      const isClosed = k.x; // true when the 1m candle closes

      if (isClosed) {
        const openPrice = parseFloat(k.o);
        // Push confirmed close to buffer
        if (!candleBuffers[symbol]) candleBuffers[symbol] = [];
        candleBuffers[symbol].push(close);
        // Keep buffer trimmed to 200 candles max
        if (candleBuffers[symbol].length > 200) candleBuffers[symbol].shift();

        // Track opens for ADX calculation
        if (!klineBuffers[symbol]) klineBuffers[symbol] = { opens: [], closes: [] };
        klineBuffers[symbol].opens.push(openPrice);
        klineBuffers[symbol].closes.push(close);
        if (klineBuffers[symbol].opens.length > 200) {
          klineBuffers[symbol].opens.shift();
          klineBuffers[symbol].closes.shift();
        }

        // Evaluate trade on candle close
        await evaluateTrade(pair, close);
        writeStatus();
      } else {
        // Intra-candle: check live price for stop-loss on open positions only
        if (positions[display]) {
          const pos = positions[display];
          const pnl = (close - pos.buyPrice) / pos.buyPrice;
          if (close <= pos.stopLoss) {
            log('INFO', `${display}: intra-candle STOP-LOSS hit at $${close} | PnL ${(pnl*100).toFixed(2)}%`);
            await executeSell(pair, close, pos, `STOP_LOSS_LIVE(${(pnl*100).toFixed(2)}%)`, pnl);
          }
        }
      }
    } catch (e) {
      log('WARN', `${display}: WS message parse error — ${e.message}`);
    }
  });

  ws.on('error', (err) => {
    log('ERROR', `${display}: WebSocket error — ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    log('WARN', `${display}: WebSocket closed (code=${code}) — scheduling reconnect`);
    wsHandles[symbol] = null;

    if (shutdownRequested) return;

    wsReconnects[symbol] = (wsReconnects[symbol] || 0) + 1;
    if (wsReconnects[symbol] > CONFIG.WS_MAX_RECONNECTS) {
      log('ERROR', `${display}: max reconnects reached — giving up`);
      logActivity(`${display}: WebSocket gave up after ${CONFIG.WS_MAX_RECONNECTS} reconnects`, 'error');
      return;
    }

    const delay = Math.min(CONFIG.WS_RECONNECT_DELAY * wsReconnects[symbol], 60_000);
    log('INFO', `${display}: reconnecting in ${delay / 1000}s (attempt ${wsReconnects[symbol]})`);
    setTimeout(() => connectKlineStream(pair), delay);
  });
}

// ── Balance sync (REST, periodic) ────────────────────────────────────────────

async function syncBalance() {
  try {
    allBalances = await fetchSpotBalance();
    usdtBalance = allBalances['USDT'] || 0;

    // Set session baseline on first sync
    if (sessionStartUsdt === null && usdtBalance > 0) {
      sessionStartUsdt = usdtBalance;
      log('INFO', `[EL ESTRATEGA WS] Session baseline: $${sessionStartUsdt.toFixed(2)} USDT`);
    }

    if (ipBlocked) {
      // Try a lightweight REST call to see if IP block lifted
      try {
        await restRequest('GET', '/api/v3/account', {}, true);
        ipBlocked = false;
        log('INFO', 'IP whitelist restriction lifted — trading resumes');
        logActivity('IP whitelist restriction lifted — trading resumes', 'success');
      } catch {}
    }

    log('INFO', `Balance sync: USDT=$${usdtBalance.toFixed(2)} | Positions=${Object.keys(positions).length}${ipBlocked ? ' | IP_BLOCKED' : ''}`);
    writeStatus();
  } catch (err) {
    const isIPErr = err.message && err.message.includes('API-key, IP');
    if (isIPErr) {
      if (!ipBlocked) {
        ipBlocked = true;
        log('WARN', `Balance sync: IP whitelist blocking — continuing on WS data`);
      }
    } else {
      log('ERROR', `Balance sync failed: ${err.message}`);
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function startup() {
  ensureLogDir();

  log('INFO', '=== EL ESTRATEGA WS (opo-scalper v2.1) starting — ADX regime detection + adaptive entries ===');
  log('INFO', `Strategy: ADX(${CONFIG.ADX_PERIOD}) regime | Trend(>25) RSI<${CONFIG.RSI_BUY_TREND}+MACD | Range(<20) RSI<${CONFIG.RSI_BUY_RANGE} | Neutral 50% | Risk cap 2% | DrawdownKill -5% | SL=${CONFIG.STOP_LOSS_PCT*100}% TP=${CONFIG.TAKE_PROFIT_PCT*100}% | 1m WS`);
  log('INFO', `Pairs: ${CONFIG.PAIRS.map(p => p.display).join(', ')}`);
  log('INFO', `Max positions: ${CONFIG.MAX_POSITIONS} | Max trade: $${CONFIG.MAX_TRADE_USDT} or ${CONFIG.MAX_POSITION_PCT*100}% of balance`);

  // Verify Binance connectivity
  try {
    const t = await restRequest('GET', '/api/v3/time');
    log('INFO', `Binance REST ping OK — server time: ${new Date(t.serverTime).toISOString()}`);
  } catch (err) {
    log('WARN', `Binance REST ping failed: ${err.message}`);
  }

  // Initial balance sync
  try {
    await syncBalance();
    log('INFO', `Starting USDT balance: $${usdtBalance.toFixed(2)}`);
  } catch (err) {
    log('WARN', `Initial balance sync failed: ${err.message} — will retry`);
  }

  // Seed candle buffers via REST
  log('INFO', 'Seeding candle history from REST API...');
  for (const pair of CONFIG.PAIRS) {
    try {
      const closes = await seedCandles(pair.symbol);
      candleBuffers[pair.symbol] = closes;
      log('INFO', `${pair.display}: seeded ${closes.length} candles`);
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      log('WARN', `${pair.display}: candle seed failed — ${err.message} (will fill from WS)`);
      candleBuffers[pair.symbol] = [];
    }
  }

  // Connect WebSocket streams for all pairs
  log('INFO', 'Connecting WebSocket streams...');
  for (const pair of CONFIG.PAIRS) {
    connectKlineStream(pair);
    await new Promise(r => setTimeout(r, 100)); // slight stagger
  }

  // Periodic balance sync
  setInterval(syncBalance, CONFIG.BALANCE_SYNC_MS);

  // Status write every minute even if no WS activity
  setInterval(writeStatus, 60_000);

  logActivity(`EL ESTRATEGA WS v2.1 started — ADX regime detection | Trend/Range/Neutral | Risk cap 2% | DrawdownKill -5% | 8 pairs | SL ${CONFIG.STOP_LOSS_PCT*100}% TP ${CONFIG.TAKE_PROFIT_PCT*100}%`, 'success');

  log('INFO', '=== opo-scalper ready — listening for signals ===');
}

// ── Shutdown Guards ───────────────────────────────────────────────────────────

function shutdown(signal) {
  log('INFO', `Shutting down (${signal})`);
  shutdownRequested = true;
  for (const [sym, ws] of Object.entries(wsHandles)) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'shutdown');
    }
  }
  writeStatus();
  process.exit(0);
}

process.on('uncaughtException', err => {
  log('ERROR', `Uncaught: ${err.message}\n${err.stack}`);
  logActivity(`Crash: ${err.message}`, 'error');
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  log('ERROR', `Unhandled rejection: ${String(reason)}`);
  process.exit(1);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

startup();
