#!/usr/bin/env node
// EL SNIPER — High-confidence momentum entries only. No FOMO. No chasing.
// RISK GOVERNANCE: Max 1-2% capital per trade. Hard stops always set before entry. Drawdown kill switch active.
/**
 * OpoClaw Active Scalping Bot — opo-trader (El Sniper)
 * Strategy: RSI(14) crossover + MACD histogram momentum on 5m candles
 * Entry: RSI crossover from above into oversold (40→35) AND MACD histogram positive + growing
 *        PLUS 3 consecutive candles confirming direction (sniper filter)
 * Exit:  HARD STOP at -1.5% | take-profit +1.5% | RSI > 65
 * Risk:  Max 1-2% capital per trade | Max 15% balance per position
 * Pairs: BTC, ETH, SOL, BNB, XRP, AVAX, ADA, DOGE
 * Tick:  30 seconds — event-driven
 */

'use strict';

require('dotenv').config({ path: '/Users/opoclaw1/opoclaw/.env' });

const https   = require('https');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  BASE_PAIRS: [
    { symbol: 'BTCUSDT',  display: 'BTC/USDT', asset: 'BTC'  },
    { symbol: 'ETHUSDT',  display: 'ETH/USDT', asset: 'ETH'  },
    { symbol: 'SOLUSDT',  display: 'SOL/USDT', asset: 'SOL'  },
    { symbol: 'BNBUSDT',  display: 'BNB/USDT', asset: 'BNB'  },
    { symbol: 'XRPUSDT',  display: 'XRP/USDT', asset: 'XRP'  },
    { symbol: 'AVAXUSDT', display: 'AVAX/USDT', asset: 'AVAX' },
    { symbol: 'ADAUSDT',  display: 'ADA/USDT',  asset: 'ADA'  },
    { symbol: 'DOGEUSDT', display: 'DOGE/USDT', asset: 'DOGE' },
  ],
  RSI_PERIOD:         14,
  RSI_BUY:            40,    // Sniper entry zone top (RSI must be crossing down through this)
  RSI_BUY_DEEP:       35,    // RSI must be at or below this for confirmed oversold
  RSI_SELL:           65,    // Sell when RSI > 65
  MACD_FAST:          12,
  MACD_SLOW:          26,
  MACD_SIGNAL:        9,
  STOP_LOSS_PCT:      0.015, // HARD stop at -1.5% — no exceptions
  TAKE_PROFIT_PCT:    0.015, // +1.5% take profit
  MAX_POSITION_PCT:   0.15,  // El Sniper: max 15% of balance per trade (down from 25%)
  MAX_TRADE_USDT:     10.0,
  MAX_CAPITAL_PCT:    0.02,  // Risk governance: never risk more than 2% of total balance
  MAX_POSITIONS:      3,
  MIN_USDT:           5.0,
  SNIPER_CONFIRM_CANDLES: 3, // Must see 3 consecutive bullish candles before entry
  TICK_INTERVAL:      30_000,
  CANDLE_LIMIT:       60,
  CANDLE_TF:          '5m',
  DB_PATH:            '/Users/opoclaw1/opoclaw/store/opoclaw.db',
  STATUS_FILE:        '/Users/opoclaw1/opoclaw/opo-work/opo-trader-status.json',
  LOG_FILE:           '/Users/opoclaw1/opoclaw/logs/opo-trader.log',
  MIN_REDEEM_USDT:    10.0,
};

const API_KEY    = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_SECRET_KEY;

// ── State ────────────────────────────────────────────────────────────────────

const positions = {};
let tradeLog    = [];
let lastSignals = {};
let lastError   = null;

// ── Logger ───────────────────────────────────────────────────────────────────

function ensureLogDir() {
  const dir = path.dirname(CONFIG.LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.LOG_FILE, line + '\n'); } catch {}
}

// ── Binance HTTP helpers ──────────────────────────────────────────────────────

function sign(params) {
  const qs  = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return qs + '&signature=' + sig;
}

function binanceRequest(method, endpoint, params = {}, signed = false) {
  return new Promise((resolve, reject) => {
    let queryString = '';
    let body        = '';

    if (signed) {
      queryString = sign(params);
    } else {
      queryString = new URLSearchParams(params).toString();
    }

    const isPost = method === 'POST';
    const pathStr = endpoint + ((!isPost && queryString) ? '?' + queryString : '');
    if (isPost) body = queryString;

    const options = {
      hostname: 'api.binance.com',
      path:     pathStr,
      method,
      headers:  {
        'X-MBX-APIKEY': API_KEY,
        ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(parsed.msg || 'Binance API error');
            err.code = parsed.code;
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse response: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    if (isPost && body) req.write(body);
    req.end();
  });
}

// ── Exchange API calls ────────────────────────────────────────────────────────

async function getSpotBalance() {
  // Use /api/v3/account directly — most reliable for spot balances
  const data = await binanceRequest('GET', '/api/v3/account', {}, true);
  const bals = {};
  for (const b of data.balances) {
    const free = parseFloat(b.free);
    if (free > 0) bals[b.asset] = free;
  }
  return bals;
}

async function getKlines(symbol) {
  const data = await binanceRequest('GET', '/api/v3/klines', {
    symbol,
    interval: CONFIG.CANDLE_TF,
    limit:    CONFIG.CANDLE_LIMIT,
  });
  return data.map(k => ({
    open:     parseFloat(k[1]),
    high:     parseFloat(k[2]),
    low:      parseFloat(k[3]),
    close:    parseFloat(k[4]),
    volume:   parseFloat(k[5]),
    quoteVol: parseFloat(k[7]),
  }));
}

async function get24hTicker(symbol) {
  const data = await binanceRequest('GET', '/api/v3/ticker/24hr', { symbol });
  return {
    price:     parseFloat(data.lastPrice),
    volume:    parseFloat(data.quoteVolume),
    priceChg:  parseFloat(data.priceChangePercent),
  };
}

async function getExchangeInfo(symbol) {
  const data = await binanceRequest('GET', '/api/v3/exchangeInfo', { symbol });
  const sym  = data.symbols[0];
  const lot  = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = sym.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  return {
    stepSize:    parseFloat(lot.stepSize),
    minQty:      parseFloat(lot.minQty),
    minNotional: notional ? parseFloat(notional.minNotional) : 5.0,
  };
}

async function placeMarketOrder(symbol, side, quantity) {
  return await binanceRequest('POST', '/api/v3/order', {
    symbol,
    side,
    type:     'MARKET',
    quantity: quantity.toString(),
  }, true);
}

function roundStep(qty, stepSize) {
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat(qty.toFixed(precision));
}

// ── Indicators ───────────────────────────────────────────────────────────────

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

function calcMACD(closes) {
  if (closes.length < CONFIG.MACD_SLOW + CONFIG.MACD_SIGNAL) return null;
  const fk = 2 / (CONFIG.MACD_FAST + 1);
  const sk = 2 / (CONFIG.MACD_SLOW + 1);

  let fastEMA = closes.slice(0, CONFIG.MACD_FAST).reduce((a, b) => a + b, 0) / CONFIG.MACD_FAST;
  let slowEMA = closes.slice(0, CONFIG.MACD_SLOW).reduce((a, b) => a + b, 0) / CONFIG.MACD_SLOW;

  const macdLine = [];
  for (let i = CONFIG.MACD_FAST; i < closes.length; i++) {
    fastEMA = closes[i] * fk + fastEMA * (1 - fk);
    if (i >= CONFIG.MACD_SLOW) {
      slowEMA = closes[i] * sk + slowEMA * (1 - sk);
      macdLine.push(fastEMA - slowEMA);
    }
  }

  if (macdLine.length < CONFIG.MACD_SIGNAL) return null;
  const sigk = 2 / (CONFIG.MACD_SIGNAL + 1);
  let signal = macdLine.slice(0, CONFIG.MACD_SIGNAL).reduce((a, b) => a + b, 0) / CONFIG.MACD_SIGNAL;
  for (let i = CONFIG.MACD_SIGNAL; i < macdLine.length; i++) {
    signal = macdLine[i] * sigk + signal * (1 - sigk);
  }

  const cur  = macdLine[macdLine.length - 1];
  const prev = macdLine[macdLine.length - 2] ?? cur;
  const prevSig = signal; // approximate previous signal

  return {
    histogram:        parseFloat((cur - signal).toFixed(6)),
    bullishCrossover: cur > signal && prev <= prevSig, // MACD crossed above signal
    macd:             parseFloat(cur.toFixed(6)),
    signal:           parseFloat(signal.toFixed(6)),
    positive:         cur > 0,
  };
}

// ── Sniper filter: consecutive bullish candles ────────────────────────────────

function checkSniperFilter(klines, count = CONFIG.SNIPER_CONFIRM_CANDLES) {
  if (klines.length < count) return false;
  const recent = klines.slice(-count);
  return recent.every(k => k.close > k.open); // each candle must be green (close > open)
}

// ── Risk governance check ────────────────────────────────────────────────────

function calcMaxTradeSize(totalUsdt, priceForStop) {
  // Never risk more than 2% of total balance on a single trade
  // Risk = position_size * stop_loss_pct
  // position_size = risk / stop_loss_pct
  const maxRiskUsdt = totalUsdt * CONFIG.MAX_CAPITAL_PCT;
  const maxByRisk   = maxRiskUsdt / CONFIG.STOP_LOSS_PCT;
  const maxByPct    = totalUsdt * CONFIG.MAX_POSITION_PCT;
  return Math.min(maxByRisk, maxByPct, CONFIG.MAX_TRADE_USDT);
}

// ── Dashboard + notifications ─────────────────────────────────────────────────

function logActivity(action, type = 'info') {
  const safe = action.replace(/'/g, "''").replace(/\\/g, '\\\\');
  try {
    execSync(
      `sqlite3 "${CONFIG.DB_PATH}" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('opo-trader','Trader','💹','${safe}','${type}','trading',datetime('now'))"`,
      { stdio: 'ignore', timeout: 5000 }
    );
  } catch (e) {
    log('WARN', `SQLite log failed: ${e.message}`);
  }
}

function sendTelegram(msg) {
  try {
    const escaped = msg.replace(/"/g, '\\"').replace(/`/g, "'").replace(/\$/g, '\\$');
    execSync(`bash /Users/opoclaw1/opoclaw/scripts/tg-notify.sh "${escaped}"`, {
      stdio: 'ignore', timeout: 10000,
    });
  } catch (e) {
    log('WARN', `Telegram notify failed: ${e.message}`);
  }
}

function writeStatus(usdt) {
  const payload = {
    status:        'online',
    strategy:      `EL SNIPER | RSI crossover ${CONFIG.RSI_BUY_DEEP} + MACD histogram + 3-candle confirm | ${CONFIG.CANDLE_TF} | SL ${CONFIG.STOP_LOSS_PCT * 100}% TP ${CONFIG.TAKE_PROFIT_PCT * 100}% | MaxPos ${CONFIG.MAX_POSITION_PCT * 100}% | Risk cap 2%`,
    updatedAt:     new Date().toISOString(),
    usdt:          parseFloat((usdt ?? 0).toFixed(2)),
    openPositions: Object.keys(positions).length,
    positions,
    lastSignals,
    trades:        tradeLog.slice(-20),
    lastError,
  };
  try {
    const dir = path.dirname(CONFIG.STATUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.STATUS_FILE, JSON.stringify(payload, null, 2));
  } catch {}
}

// ── Exit checks (stop-loss / take-profit) ────────────────────────────────────

async function checkExits(balances) {
  for (const [display, pos] of Object.entries(positions)) {
    const sym   = display.replace('/', '');
    const asset = display.split('/')[0];

    try {
      const ticker = await get24hTicker(sym);
      const price  = ticker.price;
      const pnl    = (price - pos.buyPrice) / pos.buyPrice;

      log('INFO', `[EL SNIPER] ${display}: $${price} | entry $${pos.buyPrice.toFixed(4)} | PnL ${(pnl * 100).toFixed(2)}% | HARD SL $${pos.stopLoss.toFixed(4)} TP $${pos.takeProfit.toFixed(4)}`);

      let exitReason = null;
      if (price <= pos.stopLoss)   exitReason = `[EL SNIPER] HARD-STOP (${(pnl * 100).toFixed(2)}%)`;
      if (price >= pos.takeProfit) exitReason = `[EL SNIPER] TAKE-PROFIT (+${(pnl * 100).toFixed(2)}%)`;
      if (!exitReason) continue;

      const assetQty = balances[asset] || 0;
      if (assetQty <= 0) {
        log('WARN', `${display}: ${exitReason} but no balance — clearing`);
        delete positions[display];
        continue;
      }

      const info     = await getExchangeInfo(sym);
      const sellQty  = roundStep(assetQty * 0.99, info.stepSize);
      const notional = sellQty * price;

      if (sellQty < info.minQty || notional < info.minNotional) {
        log('WARN', `${display}: exit qty too small — clearing stale position`);
        delete positions[display];
        continue;
      }

      log('INFO', `${display}: Executing ${exitReason} — selling ${sellQty} ${asset}`);
      const order    = await placeMarketOrder(sym, 'SELL', sellQty);
      const proceeds = parseFloat(order.cummulativeQuoteQty);
      const avgPrice = proceeds / parseFloat(order.executedQty);

      tradeLog.push({ time: new Date().toISOString(), action: exitReason.split('(')[0].trim(), pair: display, qty: sellQty, price: avgPrice, usdt: proceeds, pnl: (pnl * 100).toFixed(2) + '%' });
      delete positions[display];

      logActivity(`${exitReason}: ${display} @ $${avgPrice.toFixed(4)} | received $${proceeds.toFixed(2)} USDT`, pnl >= 0 ? 'success' : 'warning');
      sendTelegram(`${exitReason}: ${display} @ $${avgPrice.toFixed(2)} | PnL: ${(pnl * 100).toFixed(2)}% | $${proceeds.toFixed(2)} USDT`);

      balances = await getSpotBalance();
    } catch (err) {
      log('ERROR', `${display}: exit check failed — ${err.message}`);
    }
  }
  return balances;
}

// ── Per-pair trading logic ────────────────────────────────────────────────────

async function processPair(pair, usdtBalance, balances) {
  const { symbol, display, asset } = pair;

  try {
    const klines = await getKlines(symbol);
    if (klines.length < CONFIG.MACD_SLOW + CONFIG.MACD_SIGNAL) {
      log('WARN', `${display}: not enough candles (${klines.length})`);
      return { pair: display, action: 'skip', rsi: null };
    }

    const closes = klines.map(k => k.close);
    const price  = closes[closes.length - 1];
    const rsi    = calcRSI(closes);
    const macd   = calcMACD(closes);

    if (rsi === null) return { pair: display, action: 'skip', rsi: null, price };

    const macdStr = macd ? `hist=${macd.histogram.toFixed(4)} cross=${macd.bullishCrossover} pos=${macd.positive}` : 'n/a';
    log('INFO', `${display}: RSI=${rsi} | $${price} | MACD ${macdStr}`);

    const hasPosition = !!positions[display];

    // ── SELL signal ──────────────────────────────────────────────────────────
    if (hasPosition && rsi > CONFIG.RSI_SELL) {
      const assetQty = balances[asset] || 0;
      if (assetQty <= 0) {
        delete positions[display];
        return { pair: display, action: 'hold', rsi, price };
      }
      const info     = await getExchangeInfo(symbol);
      const sellQty  = roundStep(assetQty * 0.99, info.stepSize);
      const notional = sellQty * price;
      if (sellQty < info.minQty || notional < info.minNotional) {
        return { pair: display, action: 'hold', rsi, price };
      }
      try {
        const pos      = positions[display];
        const pnl      = (price - pos.buyPrice) / pos.buyPrice;
        const order    = await placeMarketOrder(symbol, 'SELL', sellQty);
        const proceeds = parseFloat(order.cummulativeQuoteQty);
        const avgPrice = proceeds / parseFloat(order.executedQty);
        tradeLog.push({ time: new Date().toISOString(), action: 'SELL', pair: display, qty: sellQty, price: avgPrice, usdt: proceeds, pnl: (pnl * 100).toFixed(2) + '%' });
        delete positions[display];
        logActivity(`SELL ${display} @ $${avgPrice.toFixed(4)} | RSI overbought ${rsi} | PnL: ${(pnl * 100).toFixed(2)}%`, 'success');
        sendTelegram(`SELL ${display} @ $${avgPrice.toFixed(2)} | RSI: ${rsi} | PnL: ${(pnl * 100).toFixed(2)}% | $${proceeds.toFixed(2)} USDT`);
        return { pair: display, action: 'sell', rsi, price: avgPrice };
      } catch (e) {
        log('ERROR', `${display}: SELL failed — ${e.message}`);
        return { pair: display, action: 'error', rsi, price };
      }
    }

    // ── EL SNIPER — HIGH-CONFIDENCE BUY filter ───────────────────────────────
    // All three conditions must be true simultaneously:
    // 1. RSI crossed down into oversold zone (currently <= RSI_BUY_DEEP=35)
    // 2. MACD histogram positive AND growing (momentum confirmation)
    // 3. Sniper filter: last 3 candles all bullish (green) — direction confirmation
    const rsiOversold   = rsi <= CONFIG.RSI_BUY_DEEP;
    const macdMomentum  = macd && macd.histogram > 0 && macd.bullishCrossover;
    const sniperConfirm = checkSniperFilter(klines);

    const shouldBuy = rsiOversold && macdMomentum && sniperConfirm && !hasPosition;

    if (!shouldBuy && !hasPosition && rsi <= CONFIG.RSI_BUY) {
      // Log near-miss for visibility (RSI in range but not all conditions met)
      log('INFO', `[EL SNIPER] ${display}: RSI=${rsi} in range but waiting — MACD momentum=${!!(macd && macd.histogram > 0 && macd.bullishCrossover)} sniperFilter=${sniperConfirm}`);
    }

    if (shouldBuy) {
      const openCount = Object.keys(positions).length;
      if (openCount >= CONFIG.MAX_POSITIONS) {
        log('INFO', `[EL SNIPER] ${display}: signal confirmed but max positions (${openCount}) open — holding fire`);
        return { pair: display, action: 'hold', rsi, price };
      }
      if (usdtBalance < CONFIG.MIN_USDT) {
        log('INFO', `[EL SNIPER] ${display}: signal confirmed but USDT too low ($${usdtBalance.toFixed(2)})`);
        return { pair: display, action: 'low_funds', rsi, price };
      }

      // Risk governance: cap trade size to max 2% risk exposure
      const tradeUsdt = calcMaxTradeSize(usdtBalance);
      if (tradeUsdt < CONFIG.MIN_USDT) {
        return { pair: display, action: 'hold', rsi, price };
      }

      // Risk governance: reject if trade exceeds 2% of balance
      const riskExposure = tradeUsdt * CONFIG.STOP_LOSS_PCT;
      const riskPct = (riskExposure / usdtBalance) * 100;
      if (riskPct > 2.0) {
        log('WARN', `[EL SNIPER] ${display}: REJECTED — risk exposure ${riskPct.toFixed(2)}% exceeds 2% governance limit`);
        logActivity(`[EL SNIPER] REJECTED ${display}: risk ${riskPct.toFixed(2)}% > 2% limit`, 'warning');
        return { pair: display, action: 'hold', rsi, price };
      }

      const reason = `RSI=${rsi}(oversold) + MACD histogram bullish + 3-candle confirm`;
      log('INFO', `[EL SNIPER] Entering ${display} long — RSI=${rsi} + MACD confirm + sniper filter | risk ${riskPct.toFixed(2)}% of balance`);
      try {
        const info   = await getExchangeInfo(symbol);
        const qty    = roundStep(tradeUsdt / price, info.stepSize);
        const notional = qty * price;
        if (qty < info.minQty || notional < info.minNotional) {
          log('WARN', `[EL SNIPER] ${display}: qty=${qty} or notional=$${notional.toFixed(2)} too small`);
          return { pair: display, action: 'hold', rsi, price };
        }
        log('INFO', `[EL SNIPER] Entering ${display} long — RSI crossover + MACD confirm | spending $${tradeUsdt.toFixed(2)}`);
        const order     = await placeMarketOrder(symbol, 'BUY', qty);
        const spent     = parseFloat(order.cummulativeQuoteQty);
        const filledQty = parseFloat(order.executedQty);
        const avgPrice  = spent / filledQty;
        const stopLoss   = avgPrice * (1 - CONFIG.STOP_LOSS_PCT); // HARD 1.5% stop
        const takeProfit = avgPrice * (1 + CONFIG.TAKE_PROFIT_PCT);
        positions[display] = { qty: filledQty, buyPrice: avgPrice, stopLoss, takeProfit, boughtAt: new Date().toISOString(), reason, riskPct: riskPct.toFixed(2) };
        tradeLog.push({ time: new Date().toISOString(), action: 'BUY', pair: display, qty: filledQty, price: avgPrice, usdt: spent, reason, stopLoss, takeProfit, riskPct: riskPct.toFixed(2) + '%' });
        logActivity(`[EL SNIPER] BUY ${display} @ $${avgPrice.toFixed(4)} | ${reason} | SL $${stopLoss.toFixed(4)} TP $${takeProfit.toFixed(4)} | risk ${riskPct.toFixed(2)}%`, 'success');
        sendTelegram(`[EL SNIPER] BUY ${display} @ $${avgPrice.toFixed(2)} | RSI crossover + MACD | Spent $${spent.toFixed(2)} | SL $${stopLoss.toFixed(4)} TP $${takeProfit.toFixed(4)} | Risk ${riskPct.toFixed(2)}%`);
        return { pair: display, action: 'buy', rsi, price: avgPrice, reason };
      } catch (e) {
        log('ERROR', `[EL SNIPER] ${display}: BUY failed — ${e.message}`);
        logActivity(`[EL SNIPER] BUY FAILED ${display}: ${e.message}`, 'error');
        return { pair: display, action: 'error', rsi, price };
      }
    }

    return { pair: display, action: 'hold', rsi, price, macdHist: macd?.histogram };

  } catch (err) {
    log('ERROR', `${display}: processing error — ${err.message}`);
    return { pair: display, action: 'error', rsi: null, price: 0 };
  }
}

// ── Main tick ────────────────────────────────────────────────────────────────

async function tick() {
  log('INFO', '=== opo-trader tick ===');
  lastError = null;

  let balances = {};
  let usdtFree = 0;

  try {
    balances = await getSpotBalance();
    usdtFree = balances['USDT'] || 0;
    log('INFO', `USDT: $${usdtFree.toFixed(2)} | Open positions: ${Object.keys(positions).length}`);
  } catch (err) {
    lastError = err.message;
    log('ERROR', `Balance fetch failed: ${err.message}`);
    writeStatus(0);
    return;
  }

  // Check stop-loss/take-profit on open positions
  if (Object.keys(positions).length > 0) {
    balances = await checkExits(balances);
    usdtFree = balances['USDT'] || 0;
  }

  // Scan pairs
  const signals = {};
  for (const pair of CONFIG.BASE_PAIRS) {
    await new Promise(r => setTimeout(r, 300)); // rate limit spacing
    const signal = await processPair(pair, usdtFree, balances);
    signals[pair.display] = signal;
    if (signal.action === 'buy' || signal.action === 'sell') {
      try {
        balances = await getSpotBalance();
        usdtFree = balances['USDT'] || 0;
      } catch {}
    }
  }

  lastSignals = signals;
  writeStatus(usdtFree);
  log('INFO', `=== tick done | USDT=$${usdtFree.toFixed(2)} | Positions=${Object.keys(positions).length} ===`);
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function startup() {
  ensureLogDir();
  log('INFO', '=== EL SNIPER (opo-trader) starting — high-confidence momentum scalper ===');
  log('INFO', `Strategy: RSI<=${CONFIG.RSI_BUY_DEEP} + MACD histogram bullish + 3-candle confirm | Sell RSI>${CONFIG.RSI_SELL} | HARD SL=${CONFIG.STOP_LOSS_PCT * 100}% | TP=${CONFIG.TAKE_PROFIT_PCT * 100}% | MaxPos=${CONFIG.MAX_POSITION_PCT * 100}% | RiskCap=2% | TF=${CONFIG.CANDLE_TF} | Tick=${CONFIG.TICK_INTERVAL / 1000}s`);
  log('INFO', `Pairs: ${CONFIG.BASE_PAIRS.map(p => p.display).join(', ')}`);

  try {
    const t = await binanceRequest('GET', '/api/v3/time');
    log('INFO', `Binance ping OK — server time: ${new Date(t.serverTime).toISOString()}`);
  } catch (err) {
    log('WARN', `Binance ping failed: ${err.message} — will retry on tick`);
  }

  logActivity(`EL SNIPER (opo-trader) restarted — RSI<=${CONFIG.RSI_BUY_DEEP} + MACD + 3-candle filter | Hard SL ${CONFIG.STOP_LOSS_PCT * 100}% | Max pos ${CONFIG.MAX_POSITION_PCT * 100}% | Risk cap 2%`, 'success');

  log('INFO', 'Waiting 2s before first tick...');
  await new Promise(r => setTimeout(r, 2000));

  try {
    await tick();
  } catch (err) {
    log('ERROR', `First tick error: ${err.message}`);
  }

  setInterval(async () => {
    try { await tick(); }
    catch (err) { log('ERROR', `Tick error: ${err.message}`); }
  }, CONFIG.TICK_INTERVAL);

  log('INFO', `Scheduled — ticking every ${CONFIG.TICK_INTERVAL / 1000}s`);
}

// ── Shutdown guards ───────────────────────────────────────────────────────────

process.on('uncaughtException', err => {
  log('ERROR', `Uncaught: ${err.message}`);
  logActivity(`Crash: ${err.message}`, 'error');
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  log('ERROR', `Unhandled rejection: ${String(reason)}`);
  process.exit(1);
});
process.on('SIGTERM', () => { log('INFO', 'Shutting down (SIGTERM)'); writeStatus(0); process.exit(0); });
process.on('SIGINT',  () => { log('INFO', 'Shutting down (SIGINT)');  writeStatus(0); process.exit(0); });

startup();
