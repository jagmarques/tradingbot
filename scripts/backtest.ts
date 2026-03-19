/**
 * Comprehensive Backtesting Engine
 *
 * Mirrors live GARCH-chan engine exactly:
 * - 1h candles for signal generation (bar [0..i-1], entry at bar i open)
 * - 1-min candles for intra-bar SL/TP/trailing fills (no bar-level approximation)
 * - 0.04% half-spread per side (Lighter DEX), per-pair overrides for Hyperliquid
 * - 0.045% taker fee per side (Hyperliquid) or 0% + spread (Lighter)
 * - Walk-forward support (train/test split)
 * - Pluggable engine interface for any strategy
 *
 * Usage:
 *   npx tsx scripts/backtest.ts [--pair BTC] [--engine garch] [--exchange lighter]
 *     [--train-start 2024-01-01] [--train-end 2025-01-01]
 *     [--test-start 2025-01-01] [--test-end 2026-03-17]
 *     [--csv trades.csv]
 */

import * as fs from "fs";
import * as path from "path";
import { ATR } from "technicalindicators";

// ---- Types ---------------------------------------------------------------

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface Signal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

interface Position {
  id: string;
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  entryTime: number;
  size: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  trailActivation: number;
  trailDistance: number;
  maxHoldMs: number;
  peakPnlPct: number;
  trailActive: boolean;
}

interface Trade {
  id: string;
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  reason: string;
  size: number;
  leverage: number;
}

// Engine interface: any strategy implements this
type EngineSignalFn = (
  candles1h: Candle[],
  pair: string,
  barIndex: number,
) => Signal | null;

// ---- Configuration -------------------------------------------------------

const CACHE_1H = "/tmp/bt-pair-cache";
const CACHE_1M = "/tmp/bt-pair-cache-1m";
const CACHE_1S = "/tmp/bt-pair-cache-1s";

const DEFAULT_PAIRS = [
  "OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","AVAXUSDT","TRUMPUSDT","DASHUSDT",
  "DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","SEIUSDT","LINKUSDT","ADAUSDT",
  "WLDUSDT","XRPUSDT","SUIUSDT","TONUSDT","UNIUSDT",
];

// Per-pair half-spread (one side) from live measurement
const SPREAD_MAP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, SUIUSDT: 1.85e-4,
  AVAXUSDT: 2.55e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4,
  TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4, SEIUSDT: 4.4e-4,
  TONUSDT: 4.6e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4,
  ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  DASHUSDT: 7.15e-4,
};

const DEFAULT_SPREAD = 4e-4; // 0.04% half-spread (Lighter DEX)

interface BacktestConfig {
  pairs: string[];
  exchange: "hyperliquid" | "lighter";
  size: number;         // USD per trade
  leverage: number;
  trailActivation: number; // % profit to activate trailing
  trailDistance: number;    // % below peak to trigger trail exit
  maxHoldMs: number;
  slCapPct: number;     // max SL distance from entry (3.5%)
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  csv?: string;
}

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// ---- Data Loading --------------------------------------------------------

// Cache to avoid re-reading same file
const candleCache = new Map<string, Candle[]>();

function loadCandles(pair: string, cache: string): Candle[] {
  const key = `${cache}/${pair}`;
  if (candleCache.has(key)) return candleCache.get(key)!;

  const filePath = path.join(cache, pair + ".json");
  if (!fs.existsSync(filePath)) return [];

  const stat = fs.statSync(filePath);
  const sizeMB = (stat.size / 1e6).toFixed(1);
  process.stdout.write(`  Loading ${pair} (${sizeMB}MB)...`);

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown[];
  const candles = (raw as (number[] | Candle)[]).map(b =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : b as Candle
  );
  process.stdout.write(` ${candles.length} candles\n`);

  candleCache.set(key, candles);
  return candles;
}

function filterByTime(candles: Candle[], start: number, end: number): Candle[] {
  // Binary search for start index (candles are sorted by time)
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < start) lo = mid + 1; else hi = mid;
  }
  const result: Candle[] = [];
  for (let i = lo; i < candles.length && candles[i].t < end; i++) {
    result.push(candles[i]);
  }
  return result;
}

// Build a map of 1-min candles indexed by their containing 1h bar timestamp
function build1mIndex(candles1m: Candle[]): Map<number, Candle[]> {
  const idx = new Map<number, Candle[]>();
  for (const c of candles1m) {
    const hourTs = Math.floor(c.t / HOUR_MS) * HOUR_MS;
    const arr = idx.get(hourTs) || [];
    arr.push(c);
    idx.set(hourTs, arr);
  }
  return idx;
}

// ---- Fee & Spread Model --------------------------------------------------

function getHalfSpread(pair: string, exchange: "hyperliquid" | "lighter"): number {
  if (exchange === "lighter") return DEFAULT_SPREAD;
  return SPREAD_MAP[pair] ?? DEFAULT_SPREAD;
}

function calcFees(size: number, leverage: number, exchange: "hyperliquid" | "lighter"): number {
  if (exchange === "lighter") return 0; // Lighter = no taker fee, spread covers it
  return size * leverage * 0.00045 * 2; // Hyperliquid taker both sides
}

function applySpreadEntry(price: number, direction: "long" | "short", spread: number): number {
  return direction === "long" ? price * (1 + spread) : price * (1 - spread);
}

function applySpreadExit(price: number, direction: "long" | "short", spread: number): number {
  return direction === "long" ? price * (1 - spread) : price * (1 + spread);
}

// ---- Intra-Bar Position Monitor (1-min resolution) -----------------------

/**
 * Simulate position monitoring within one 1h bar using 1-min candles.
 * Returns exit price and reason, or null if position survives the bar.
 *
 * Checks in priority order (matching live position-monitor.ts):
 * 1. Stop-loss
 * 2. Take-profit
 * 3. Trailing stop
 * 4. Max hold time
 */
function checkPositionIntraBar(
  pos: Position,
  candles1m: Candle[],
  spread: number,
): { exitPrice: number; reason: string } | null {
  for (const c1m of candles1m) {
    // Calculate unrealized P&L %
    const priceMid = (c1m.h + c1m.l) / 2;
    const pnlPct = pos.direction === "long"
      ? (priceMid - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - priceMid) / pos.entryPrice * 100;

    // Track peak P&L
    if (pnlPct > pos.peakPnlPct) pos.peakPnlPct = pnlPct;

    // 1. Stop-loss check: did price touch SL within this 1-min bar?
    const slHit = pos.direction === "long"
      ? c1m.l <= pos.stopLoss
      : c1m.h >= pos.stopLoss;

    if (slHit) {
      // Fill at SL price with adverse spread (slippage on hard stop)
      const slFill = applySpreadExit(pos.stopLoss, pos.direction, spread * 1.5);
      return { exitPrice: slFill, reason: "stop-loss" };
    }

    // 2. Take-profit check
    if (pos.takeProfit > 0) {
      const tpHit = pos.direction === "long"
        ? c1m.h >= pos.takeProfit
        : c1m.l <= pos.takeProfit;

      if (tpHit) {
        const tpFill = applySpreadExit(pos.takeProfit, pos.direction, spread);
        return { exitPrice: tpFill, reason: "take-profit" };
      }
    }

    // 3. Trailing stop
    if (pos.trailActivation > 0 && pos.peakPnlPct >= pos.trailActivation) {
      pos.trailActive = true;
      const trailTrigger = pos.peakPnlPct - pos.trailDistance;
      if (pnlPct <= trailTrigger) {
        const exitMid = applySpreadExit(priceMid, pos.direction, spread);
        return { exitPrice: exitMid, reason: "trailing-stop" };
      }
    }

    // 4. Max hold
    if (c1m.t - pos.entryTime >= pos.maxHoldMs) {
      const exitMid = applySpreadExit(c1m.c, pos.direction, spread);
      return { exitPrice: exitMid, reason: "max-hold" };
    }
  }

  return null;
}

// ---- Stop-Loss Capping (matches live capStopLoss) ------------------------

function capStopLoss(entryPrice: number, sl: number, direction: "long" | "short", capPct: number): number {
  if (direction === "long") {
    const minSl = entryPrice * (1 - capPct);
    return Math.max(sl, minSl);
  } else {
    const maxSl = entryPrice * (1 + capPct);
    return Math.min(sl, maxSl);
  }
}

// ---- Chandelier Stop Update (matches live updateChanStops) ---------------

function updateChandelierStop(
  pos: Position,
  candles1h: Candle[],
  barIdx: number,
  atrVals: number[],
  chanMult: number,
  atrPeriod: number,
): void {
  const atrOff = candles1h.length - atrVals.length;
  const atrIdx = barIdx - 1 - atrOff;
  if (atrIdx < 0 || atrIdx >= atrVals.length) return;
  const atr = atrVals[atrIdx];

  const sliceStart = Math.max(0, barIdx - atrPeriod);
  const sliceEnd = barIdx; // Use confirmed bars [0..barIdx-1]

  if (pos.direction === "long") {
    const hh = Math.max(...candles1h.slice(sliceStart, sliceEnd).map(c => c.h));
    const newStop = hh - chanMult * atr;
    if (newStop > pos.stopLoss) pos.stopLoss = newStop;
  } else {
    const ll = Math.min(...candles1h.slice(sliceStart, sliceEnd).map(c => c.l));
    const newStop = ll + chanMult * atr;
    if (newStop < pos.stopLoss) pos.stopLoss = newStop;
  }
}

// ---- GARCH-Chan Engine (mirrors live exactly) ----------------------------

const GARCH_ATR_PERIOD = 14;
const GARCH_CHAN_MULT = 6;
const GARCH_MAX_HOLD_MS = 80 * HOUR_MS;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
const GARCH_THRESHOLD = 0.7;
const GARCH_TRAIL_ACTIVATION = 8;
const GARCH_TRAIL_DISTANCE = 5;

function garchChanSignal(candles1h: Candle[], pair: string, barIndex: number): Signal | null {
  if (barIndex < 30) return null;

  const cs = candles1h.slice(0, barIndex); // Only use bars [0..barIndex-1]
  const last = cs.length - 1;

  const atrVals = ATR.calculate({
    period: GARCH_ATR_PERIOD,
    high: cs.map(c => c.h),
    low: cs.map(c => c.l),
    close: cs.map(c => c.c),
  });
  if (atrVals.length < 2) return null;

  const atrOff = cs.length - atrVals.length;
  const atr = atrVals[last - atrOff];
  if (atr === undefined || atr === 0) return null;

  // Momentum
  if (last - GARCH_LOOKBACK < 0) return null;
  const mom = cs[last].c / cs[last - GARCH_LOOKBACK].c - 1;

  // Rolling volatility
  const returns: number[] = [];
  for (let i = Math.max(1, last - GARCH_VOL_WINDOW + 1); i <= last; i++) {
    returns.push(cs[i].c / cs[i - 1].c - 1);
  }
  if (returns.length < 10) return null;
  const vol = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  if (vol === 0) return null;

  const z = mom / vol;
  const entryPrice = candles1h[barIndex].o; // Enter at current bar's open

  if (z > GARCH_THRESHOLD) {
    const hh = Math.max(...cs.slice(Math.max(0, last - GARCH_ATR_PERIOD), last + 1).map(c => c.h));
    const sl = hh - GARCH_CHAN_MULT * atr;
    if (sl >= entryPrice) return null;
    return { pair, direction: "long", entryPrice, stopLoss: sl, takeProfit: 0 };
  }

  if (z < -GARCH_THRESHOLD) {
    const ll = Math.min(...cs.slice(Math.max(0, last - GARCH_ATR_PERIOD), last + 1).map(c => c.l));
    const sl = ll + GARCH_CHAN_MULT * atr;
    if (sl <= entryPrice) return null;
    return { pair, direction: "short", entryPrice, stopLoss: sl, takeProfit: 0 };
  }

  return null;
}

// ---- ATR computation for stop updates ------------------------------------

function computeAtrArray(candles: Candle[]): number[] {
  return ATR.calculate({
    period: GARCH_ATR_PERIOD,
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
  });
}

// ---- Engine Registry -----------------------------------------------------

const ENGINES: Record<string, { signal: EngineSignalFn; trailA: number; trailD: number; maxHold: number }> = {
  "garch": {
    signal: garchChanSignal,
    trailA: GARCH_TRAIL_ACTIVATION,
    trailD: GARCH_TRAIL_DISTANCE,
    maxHold: GARCH_MAX_HOLD_MS,
  },
};

// ---- Main Simulation Loop ------------------------------------------------

function runBacktest(
  config: BacktestConfig,
  engineName: string,
  startTs: number,
  endTs: number,
): Trade[] {
  const engine = ENGINES[engineName];
  if (!engine) throw new Error(`Unknown engine: ${engineName}`);

  const allTrades: Trade[] = [];

  for (const pair of config.pairs) {
    const candles1h = filterByTime(loadCandles(pair, CACHE_1H), startTs - 100 * HOUR_MS, endTs);
    if (candles1h.length < 40) { console.log(`  ${pair}: insufficient 1h data`); continue; }

    // Load intra-bar candles: prefer 1s > 1m > bar-level fallback
    const raw1s = loadCandles(pair, CACHE_1S);
    const candles1s = filterByTime(raw1s, startTs, endTs);
    const has1s = candles1s.length > 0;

    const raw1m = has1s ? [] : loadCandles(pair, CACHE_1M);
    const candles1m = has1s ? [] : filterByTime(raw1m, startTs, endTs);
    const has1m = candles1m.length > 0;

    // Index sub-bar candles by their containing 1h bar
    const intraIndex = has1s ? build1mIndex(candles1s) : build1mIndex(candles1m);
    const hasIntra = has1s || has1m;
    const intraLabel = has1s ? "1s" : has1m ? "1m" : "bar";

    const spread = getHalfSpread(pair, config.exchange);
    let position: Position | null = null;
    let tradeCount = 0;

    // Pre-compute ATR for chandelier updates
    const atrVals = computeAtrArray(candles1h);

    // Find first bar at or after startTs
    const firstBar = candles1h.findIndex(c => c.t >= startTs);
    if (firstBar < 30) continue;

    for (let i = firstBar; i < candles1h.length; i++) {
      const bar = candles1h[i];
      if (bar.t >= endTs) break;

      // Check existing position against 1-min candles within this 1h bar
      if (position) {
        // Update chandelier stop from confirmed bars
        updateChandelierStop(position, candles1h, i, atrVals, GARCH_CHAN_MULT, GARCH_ATR_PERIOD);

        let exit: { exitPrice: number; reason: string } | null = null;

        if (hasIntra) {
          const subCandles = intraIndex.get(Math.floor(bar.t / HOUR_MS) * HOUR_MS) || [];
          if (subCandles.length > 0) {
            exit = checkPositionIntraBar(position, subCandles, spread);
          }
        }

        // Fallback: bar-level check if no intra-bar data
        if (!exit && !hasIntra) {
          // SL check at bar level
          const slHit = position.direction === "long"
            ? bar.l <= position.stopLoss
            : bar.h >= position.stopLoss;

          if (slHit) {
            const slFill = applySpreadExit(position.stopLoss, position.direction, spread * 1.5);
            exit = { exitPrice: slFill, reason: "stop-loss" };
          }

          // Trail check at bar level
          if (!exit) {
            const pnlPct = position.direction === "long"
              ? (bar.c - position.entryPrice) / position.entryPrice * 100
              : (position.entryPrice - bar.c) / position.entryPrice * 100;
            if (pnlPct > position.peakPnlPct) position.peakPnlPct = pnlPct;

            if (position.trailActivation > 0 && position.peakPnlPct >= position.trailActivation) {
              position.trailActive = true;
              if (pnlPct <= position.peakPnlPct - position.trailDistance) {
                exit = { exitPrice: applySpreadExit(bar.c, position.direction, spread), reason: "trailing-stop" };
              }
            }
          }

          // Max hold
          if (!exit && bar.t - position.entryTime >= position.maxHoldMs) {
            exit = { exitPrice: applySpreadExit(bar.c, position.direction, spread), reason: "max-hold" };
          }
        }

        if (exit) {
          const fees = calcFees(position.size, position.leverage, config.exchange);
          const rawPnl = position.direction === "long"
            ? (exit.exitPrice / position.entryPrice - 1) * position.size * position.leverage
            : (position.entryPrice / exit.exitPrice - 1) * position.size * position.leverage;

          allTrades.push({
            id: `${pair}_${tradeCount}`,
            pair,
            direction: position.direction,
            entryPrice: position.entryPrice,
            exitPrice: exit.exitPrice,
            entryTime: position.entryTime,
            exitTime: bar.t,
            pnl: rawPnl - fees,
            pnlPct: (rawPnl - fees) / position.size * 100,
            fees,
            reason: exit.reason,
            size: position.size,
            leverage: position.leverage,
          });
          tradeCount++;
          position = null;
        }
      }

      // Generate signal (no open position)
      if (!position) {
        const signal = engine.signal(candles1h, pair, i);
        if (signal) {
          const entryWithSpread = applySpreadEntry(signal.entryPrice, signal.direction, spread);
          const cappedSl = capStopLoss(entryWithSpread, signal.stopLoss, signal.direction, config.slCapPct / 100);

          position = {
            id: `${pair}_${tradeCount}`,
            pair,
            direction: signal.direction,
            entryPrice: entryWithSpread,
            entryTime: bar.t,
            size: config.size,
            leverage: config.leverage,
            stopLoss: cappedSl,
            takeProfit: signal.takeProfit,
            trailActivation: config.trailActivation,
            trailDistance: config.trailDistance,
            maxHoldMs: engine.maxHold,
            peakPnlPct: 0,
            trailActive: false,
          };
        }
      }
    }
  }

  return allTrades;
}

// ---- Statistics ----------------------------------------------------------

function computeStats(trades: Trade[], periodDays: number) {
  if (trades.length === 0) return null;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);

  // Daily returns for Sharpe
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.exitTime / DAY_MS);
    dailyPnl.set(day, (dailyPnl.get(day) || 0) + t.pnl);
  }
  const dailyReturns = Array.from(dailyPnl.values());
  const avgDaily = dailyReturns.reduce((s, r) => s + r, 0) / Math.max(dailyReturns.length, 1);
  const stdDaily = Math.sqrt(
    dailyReturns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / Math.max(dailyReturns.length - 1, 1)
  );
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = 0, dd = 0, maxDd = 0;
  let equity = 0;
  for (const t of trades.sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // Per-pair breakdown
  const pairStats = new Map<string, { trades: number; pnl: number; wr: number }>();
  const byPair = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = byPair.get(t.pair) || [];
    arr.push(t);
    byPair.set(t.pair, arr);
  }
  for (const [pair, pts] of byPair) {
    const pWins = pts.filter(t => t.pnl > 0).length;
    pairStats.set(pair, {
      trades: pts.length,
      pnl: pts.reduce((s, t) => s + t.pnl, 0),
      wr: pts.length > 0 ? (pWins / pts.length) * 100 : 0,
    });
  }

  // Avg hold duration
  const avgHoldMs = trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length * 100),
    totalPnl,
    totalFees,
    netPnl: totalPnl,
    avgPnl: totalPnl / trades.length,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    sharpe,
    maxDrawdown: maxDd,
    profitPerDay: totalPnl / Math.max(periodDays, 1),
    avgHoldHours: avgHoldMs / HOUR_MS,
    pairStats,
  };
}

function writeCsv(trades: Trade[], filepath: string): void {
  const header = "id,pair,direction,entryPrice,exitPrice,entryTime,exitTime,pnl,pnlPct,fees,reason,size,leverage\n";
  const rows = trades.map(t =>
    `${t.id},${t.pair},${t.direction},${t.entryPrice.toFixed(6)},${t.exitPrice.toFixed(6)},` +
    `${new Date(t.entryTime).toISOString()},${new Date(t.exitTime).toISOString()},` +
    `${t.pnl.toFixed(4)},${t.pnlPct.toFixed(2)},${t.fees.toFixed(4)},${t.reason},${t.size},${t.leverage}`
  ).join("\n");
  fs.writeFileSync(filepath, header + rows);
  console.log(`CSV written: ${filepath}`);
}

// ---- CLI -----------------------------------------------------------------

function parseArgs(): BacktestConfig & { engine: string } {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  const pairArg = get("--pair", "");
  const pairs = pairArg
    ? pairArg.split(",").map(p => p.toUpperCase().endsWith("USDT") ? p.toUpperCase() : p.toUpperCase() + "USDT")
    : DEFAULT_PAIRS;

  return {
    pairs,
    engine: get("--engine", "garch"),
    exchange: get("--exchange", "lighter") as "hyperliquid" | "lighter",
    size: parseFloat(get("--size", "10")),
    leverage: parseInt(get("--leverage", "10")),
    trailActivation: parseFloat(get("--trail-a", "8")),
    trailDistance: parseFloat(get("--trail-d", "5")),
    maxHoldMs: parseFloat(get("--max-hold", "80")) * HOUR_MS,
    slCapPct: parseFloat(get("--sl-cap", "3.5")),
    trainStart: new Date(get("--train-start", "2024-01-01")).getTime(),
    trainEnd: new Date(get("--train-end", "2025-06-01")).getTime(),
    testStart: new Date(get("--test-start", "2025-06-01")).getTime(),
    testEnd: new Date(get("--test-end", "2026-03-18")).getTime(),
    csv: get("--csv", ""),
  };
}

function printStats(label: string, stats: ReturnType<typeof computeStats>): void {
  if (!stats) { console.log(`\n${label}: No trades\n`); return; }
  console.log(`\n=== ${label} ===`);
  console.log(`Trades: ${stats.trades} (W:${stats.wins} L:${stats.losses} WR:${stats.winRate.toFixed(1)}%)`);
  console.log(`P&L: $${stats.netPnl.toFixed(2)} (fees: $${stats.totalFees.toFixed(2)})`);
  console.log(`Avg: $${stats.avgPnl.toFixed(2)}/trade, W:$${stats.avgWin.toFixed(2)} L:$${stats.avgLoss.toFixed(2)}`);
  console.log(`Sharpe: ${stats.sharpe.toFixed(2)}, MaxDD: $${stats.maxDrawdown.toFixed(2)}`);
  console.log(`$/day: $${stats.profitPerDay.toFixed(2)}, AvgHold: ${stats.avgHoldHours.toFixed(1)}h`);
  console.log(`\nPer-pair:`);
  for (const [pair, ps] of stats.pairStats) {
    if (ps.trades === 0) continue;
    const tag = ps.pnl >= 0 ? "+" : "";
    console.log(`  ${pair.padEnd(12)} ${ps.trades} trades  WR:${ps.wr.toFixed(0)}%  ${tag}$${ps.pnl.toFixed(2)}`);
  }
}

// ---- Entry Point ---------------------------------------------------------

function main(): void {
  const config = parseArgs();
  const { engine: engineName, ...btConfig } = config;

  console.log(`Backtest: engine=${engineName} exchange=${btConfig.exchange} pairs=${btConfig.pairs.length}`);
  console.log(`Size: $${btConfig.size} x ${btConfig.leverage}x, SL cap: ${btConfig.slCapPct}%`);
  console.log(`Train: ${new Date(btConfig.trainStart).toISOString().slice(0, 10)} -> ${new Date(btConfig.trainEnd).toISOString().slice(0, 10)}`);
  console.log(`Test:  ${new Date(btConfig.testStart).toISOString().slice(0, 10)} -> ${new Date(btConfig.testEnd).toISOString().slice(0, 10)}`);

  // Check data availability
  const has1h = fs.existsSync(CACHE_1H) && fs.readdirSync(CACHE_1H).length > 0;
  const has1s = fs.existsSync(CACHE_1S) && fs.readdirSync(CACHE_1S).length > 0;
  const has1mGlobal = fs.existsSync(CACHE_1M) && fs.readdirSync(CACHE_1M).length > 0;
  const intra = has1s ? "1s (best)" : has1mGlobal ? "1m" : "bar-level fallback";
  console.log(`Data: 1h=${has1h ? "YES" : "NO"} intra=${intra}`);

  if (!has1h) { console.error("No 1h candle data. Populate /tmp/bt-pair-cache/"); process.exit(1); }

  // Train period
  const trainDays = (btConfig.trainEnd - btConfig.trainStart) / DAY_MS;
  console.log(`\nRunning train period (${trainDays.toFixed(0)} days)...`);
  const trainTrades = runBacktest(btConfig, engineName, btConfig.trainStart, btConfig.trainEnd);
  printStats(`TRAIN (${trainDays.toFixed(0)}d)`, computeStats(trainTrades, trainDays));

  // Test period
  const testDays = (btConfig.testEnd - btConfig.testStart) / DAY_MS;
  console.log(`\nRunning test period (${testDays.toFixed(0)} days)...`);
  const testTrades = runBacktest(btConfig, engineName, btConfig.testStart, btConfig.testEnd);
  printStats(`TEST (${testDays.toFixed(0)}d)`, computeStats(testTrades, testDays));

  // Combined
  const allTrades = [...trainTrades, ...testTrades];
  const totalDays = (btConfig.testEnd - btConfig.trainStart) / DAY_MS;
  printStats(`COMBINED (${totalDays.toFixed(0)}d)`, computeStats(allTrades, totalDays));

  // CSV export
  if (btConfig.csv) {
    writeCsv(allTrades, btConfig.csv);
  }
}

main();
