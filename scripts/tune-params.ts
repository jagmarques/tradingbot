/**
 * Standalone parameter tuning script — no API keys needed.
 * Fetches 180d of 1h candles from Hyperliquid public API, then grid-searches
 * over Rule and VWAP parameters to find the most profitable combination.
 *
 * Run: npx tsx scripts/tune-params.ts
 */

import { RSI, MACD, BollingerBands, ATR, VWAP, ADX } from "technicalindicators";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Indicators {
  rsi: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null } | null;
  bb: { upper: number | null; lower: number | null; middle: number | null; width: number | null } | null;
  atr: number | null;
  vwap: number | null;
  adx: number | null;
}

interface RuleParams {
  rsiOversold: number;
  rsiOverbought: number;
  rsiPullbackLow: number;
  rsiPullbackHigh: number;
  bbProximityPct: number;
  stagnationH: number;
}

interface VwapParams {
  deviationLongPct: number;
  deviationShortPct: number;
  trendConflictPct: number;
  stagnationH: number;
}

interface BacktestResult {
  trades: number;
  wins: number;
  totalReturn: number;
  maxDrawdown: number;
}

// ─── Candle Fetch (public Hyperliquid REST) ───────────────────────────────────

async function fetchCandles(coin: string, intervalMs: number, days: number): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - days * 86400_000;

  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin,
        interval: intervalMs === 3_600_000 ? "1h" : "4h",
        startTime,
        endTime,
      },
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin}`);

  const raw = (await res.json()) as Array<{
    t: number; o: string; h: string; l: string; c: string; v: string;
  }>;

  return raw
    .map((c) => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Indicators ──────────────────────────────────────────────────────────────

interface PrecomputedIndicators {
  rsi: (number | null)[];
  macd: ({ macd: number | null; signal: number | null; histogram: number | null } | null)[];
  bb: ({ upper: number; lower: number; middle: number; width: number | null } | null)[];
  atr: (number | null)[];
  vwap: (number | null)[];
  adx: (number | null)[];
}

function precomputeAllIndicators(candles: Candle[]): PrecomputedIndicators {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const rsiRaw = RSI.calculate({ values: closes, period: 14 });
  const rsiArr: (number | null)[] = new Array(n).fill(null);
  rsiRaw.forEach((v, i) => { rsiArr[n - rsiRaw.length + i] = v; });

  const macdRaw = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const macdArr: PrecomputedIndicators["macd"] = new Array(n).fill(null);
  macdRaw.forEach((v, i) => { macdArr[n - macdRaw.length + i] = { macd: v.MACD ?? null, signal: v.signal ?? null, histogram: v.histogram ?? null }; });

  const bbRaw = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bbArr: PrecomputedIndicators["bb"] = new Array(n).fill(null);
  bbRaw.forEach((v, i) => { bbArr[n - bbRaw.length + i] = { upper: v.upper, lower: v.lower, middle: v.middle, width: v.middle > 0 ? (v.upper - v.lower) / v.middle : null }; });

  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atrArr[n - atrRaw.length + i] = v; });

  const vwapRaw = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });
  const vwapArr: (number | null)[] = new Array(n).fill(null);
  vwapRaw.forEach((v, i) => { vwapArr[n - vwapRaw.length + i] = v; });

  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });

  return { rsi: rsiArr, macd: macdArr, bb: bbArr, atr: atrArr, vwap: vwapArr, adx: adxArr };
}

function getAt(pre: PrecomputedIndicators, i: number): Indicators {
  return { rsi: pre.rsi[i], macd: pre.macd[i], bb: pre.bb[i], atr: pre.atr[i], vwap: pre.vwap[i], adx: pre.adx[i] };
}

const NULL_IND: Indicators = { rsi: null, macd: null, bb: null, atr: null, vwap: null, adx: null };

function classifyRegime(ind: Indicators): "trending" | "ranging" | "volatile" {
  const { adx, bb, atr, vwap } = ind;
  const bbWidth = bb?.width ?? null;
  const atrRatio = atr !== null && vwap !== null && vwap > 0 ? atr / vwap : null;

  if (adx !== null && adx > 25 && bbWidth !== null && bbWidth > 0.03) return "trending";
  if (bbWidth !== null && bbWidth > 0.08 && atrRatio !== null && atrRatio > 0.03) return "volatile";
  if (adx !== null && adx < 20) return "ranging";
  if (bbWidth !== null && bbWidth < 0.03) return "ranging";
  return "ranging";
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.00045 * 2;
const STARTING_BALANCE = 100;
const STOP_ATR_MULT = 1.5;
const RR_RATIO = 2.0;

function runBacktest(
  candles1h: Candle[],
  pre1h: PrecomputedIndicators,
  pre4h: PrecomputedIndicators,
  idx4hAt: number[],
  signalFn: (ind1h: Indicators, ind4h: Indicators, regime: string, price: number) => "long" | "short" | null,
  stagnationH: number,
): BacktestResult {
  let balance = STARTING_BALANCE;
  let peakBalance = STARTING_BALANCE;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;

  const stagnationCandles = stagnationH;

  type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peak: number; size: number };
  let pos: Pos | null = null;

  for (let i = 100; i < candles1h.length; i++) {
    const c = candles1h[i];

    if (pos !== null) {
      const unrlPct = ((c.close - pos.entry) / pos.entry) * 100 * (pos.dir === "long" ? 1 : -1);
      pos.peak = Math.max(pos.peak, unrlPct);

      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
      const trailHit = pos.peak > 2 && unrlPct <= pos.peak - 1;
      const stagHit = i - pos.entryIdx >= stagnationCandles;

      let exitPrice: number | null = null;
      if (slHit) exitPrice = pos.sl;
      else if (tpHit) exitPrice = pos.tp;
      else if (trailHit || stagHit) exitPrice = c.close;

      if (exitPrice !== null) {
        const pnl = ((exitPrice - pos.entry) / pos.entry) * pos.size * LEV * (pos.dir === "long" ? 1 : -1);
        const fees = pos.size * LEV * FEE_RATE;
        const net = pnl - fees;
        balance += net;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);
        trades++;
        if (net > 0) wins++;
        pos = null;
      }
    } else {
      const ind1h = getAt(pre1h, i);
      const last4h = idx4hAt[i];
      const ind4h = last4h >= 0 ? getAt(pre4h, last4h) : NULL_IND;
      const regime = classifyRegime(ind1h);

      const dir = signalFn(ind1h, ind4h, regime, c.close);
      if (dir !== null && i + 1 < candles1h.length) {
        const entryPrice = candles1h[i + 1].open;
        const atr = ind1h.atr ?? c.close * 0.01;
        const sl = dir === "long" ? entryPrice - atr * STOP_ATR_MULT : entryPrice + atr * STOP_ATR_MULT;
        const tp = dir === "long" ? entryPrice + atr * STOP_ATR_MULT * RR_RATIO : entryPrice - atr * STOP_ATR_MULT * RR_RATIO;
        const maxSize = (balance * 0.95) / 10;
        const size = Math.min(maxSize, balance * 0.1);
        if (size >= 1) {
          pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peak: 0, size };
        }
      }
    }
  }

  if (pos !== null) {
    const last = candles1h[candles1h.length - 1];
    const pnl = ((last.close - pos.entry) / pos.entry) * pos.size * LEV * (pos.dir === "long" ? 1 : -1);
    balance += pnl - pos.size * LEV * FEE_RATE;
    trades++;
    if (pnl > 0) wins++;
  }

  return {
    trades,
    wins,
    totalReturn: ((balance - STARTING_BALANCE) / STARTING_BALANCE) * 100,
    maxDrawdown,
  };
}

// ─── Signal functions ─────────────────────────────────────────────────────────

function ruleSignal(p: RuleParams) {
  return (ind: Indicators, _ind4h: Indicators, regime: string, price: number): "long" | "short" | null => {
    if (regime === "volatile") return null;
    const { rsi, macd, bb, adx } = ind;

    if (regime === "trending") {
      if (!rsi || !macd || macd.histogram === null || macd.macd === null || macd.signal === null) return null;
      const longOk = rsi >= p.rsiPullbackLow && rsi < 50 && macd.histogram > 0 && macd.macd > macd.signal;
      const shortOk = rsi > 50 && rsi <= p.rsiPullbackHigh && macd.histogram < 0 && macd.macd < macd.signal;
      if (longOk && !shortOk) return "long";
      if (shortOk && !longOk) return "short";
      return null;
    }

    // ranging
    if (!rsi || !bb || bb.lower === null || bb.upper === null) return null;
    const nearLower = Math.abs(price - bb.lower) / price * 100 <= p.bbProximityPct;
    const nearUpper = Math.abs(price - bb.upper) / price * 100 <= p.bbProximityPct;
    if (rsi < p.rsiOversold && nearLower) return "long";
    if (rsi > p.rsiOverbought && nearUpper) return "short";
    return null;
  };
}

function vwapSignal(p: VwapParams) {
  return (ind1h: Indicators, ind4h: Indicators, regime: string, price: number): "long" | "short" | null => {
    if (regime === "volatile") return null;
    const vwap1h = ind1h.vwap;
    const vwap4h = ind4h.vwap;
    if (!vwap1h) return null;
    const dev1h = ((price - vwap1h) / vwap1h) * 100;
    const dev4h = vwap4h !== null ? ((price - vwap4h) / vwap4h) * 100 : 0;
    if (dev1h > p.deviationLongPct && dev1h < p.deviationShortPct) return null;
    if (dev1h <= p.deviationLongPct) {
      if (dev4h < -p.trendConflictPct) return null;
      return "long";
    }
    if (dev4h > p.trendConflictPct) return null;
    return "short";
  };
}

// ─── Grid search ──────────────────────────────────────────────────────────────

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

// Rule param grid
const RULE_GRID: RuleParams[] = [];
for (const rsiOversold of [25, 30, 35, 40]) {
  for (const rsiOverbought of [60, 65, 70, 75]) {
    for (const bbProximityPct of [0.5, 1.0, 1.5, 2.0, 3.0]) {
      for (const stagnationH of [2, 4, 6, 8, 12]) {
        RULE_GRID.push({
          rsiOversold, rsiOverbought,
          rsiPullbackLow: 40, rsiPullbackHigh: 60,
          bbProximityPct, stagnationH,
        });
      }
    }
  }
}

// VWAP param grid
const VWAP_GRID: VwapParams[] = [];
for (const deviationLongPct of [-1.5, -2.0, -2.5, -3.0, -4.0, -5.0]) {
  for (const deviationShortPct of [1.5, 2.0, 2.5, 3.0, 4.0, 5.0]) {
    for (const stagnationH of [2, 4, 6, 8, 12]) {
      VWAP_GRID.push({ deviationLongPct, deviationShortPct, trendConflictPct: 3.0, stagnationH });
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching 180d candles for all pairs...");
  const candleMap: Record<string, { h1: Candle[]; h4: Candle[]; pre1h: PrecomputedIndicators; pre4h: PrecomputedIndicators; idx4hAt: number[] }> = {};
  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}... `);
    const [h1, h4] = await Promise.all([
      fetchCandles(pair, 3_600_000, 180),
      fetchCandles(pair, 14_400_000, 180),
    ]);
    const pre1h = precomputeAllIndicators(h1);
    const pre4h = precomputeAllIndicators(h4);
    const idx4hAt: number[] = new Array(h1.length).fill(-1);
    let j = 0;
    for (let i = 0; i < h1.length; i++) {
      while (j < h4.length && h4[j].timestamp <= h1[i].timestamp) j++;
      idx4hAt[i] = j - 1;
    }
    candleMap[pair] = { h1, h4, pre1h, pre4h, idx4hAt };
    console.log(`${h1.length} 1h candles, ${h4.length} 4h candles`);
  }

  console.log(`\nRunning Rule grid (${RULE_GRID.length} combos × ${PAIRS.length} pairs)...`);
  const ruleResults: Array<{ params: RuleParams; avgReturn: number; avgTrades: number; avgWinRate: number }> = [];

  for (let ri = 0; ri < RULE_GRID.length; ri++) {
    const params = RULE_GRID[ri];
    if (ri % 50 === 0) process.stdout.write(`  ${ri}/${RULE_GRID.length}...\n`);
    let totalReturn = 0;
    let totalTrades = 0;
    let totalWinRate = 0;
    for (const pair of PAIRS) {
      const { h1, pre1h, pre4h, idx4hAt } = candleMap[pair];
      const r = runBacktest(h1, pre1h, pre4h, idx4hAt, ruleSignal(params), params.stagnationH);
      totalReturn += r.totalReturn;
      totalTrades += r.trades;
      totalWinRate += r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
    }
    ruleResults.push({
      params,
      avgReturn: totalReturn / PAIRS.length,
      avgTrades: totalTrades / PAIRS.length,
      avgWinRate: totalWinRate / PAIRS.length,
    });
  }

  ruleResults.sort((a, b) => b.avgReturn - a.avgReturn);
  console.log("\n=== TOP 10 RULE CONFIGURATIONS ===");
  for (const r of ruleResults.slice(0, 10)) {
    const p = r.params;
    const sign = r.avgReturn >= 0 ? "+" : "";
    console.log(
      `${sign}${r.avgReturn.toFixed(1)}% avg | ${r.avgTrades.toFixed(0)}T | ${r.avgWinRate.toFixed(0)}%W | ` +
      `RSI ${p.rsiOversold}/${p.rsiOverbought} BB ${p.bbProximityPct}% stag ${p.stagnationH}h`,
    );
  }

  console.log(`\nRunning VWAP grid (${VWAP_GRID.length} combos × ${PAIRS.length} pairs)...`);
  const vwapResults: Array<{ params: VwapParams; avgReturn: number; avgTrades: number; avgWinRate: number }> = [];

  for (let vi = 0; vi < VWAP_GRID.length; vi++) {
    const params = VWAP_GRID[vi];
    if (vi % 30 === 0) process.stdout.write(`  ${vi}/${VWAP_GRID.length}...\n`);
    let totalReturn = 0;
    let totalTrades = 0;
    let totalWinRate = 0;
    for (const pair of PAIRS) {
      const { h1, pre1h, pre4h, idx4hAt } = candleMap[pair];
      const r = runBacktest(h1, pre1h, pre4h, idx4hAt, vwapSignal(params), params.stagnationH);
      totalReturn += r.totalReturn;
      totalTrades += r.trades;
      totalWinRate += r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
    }
    vwapResults.push({
      params,
      avgReturn: totalReturn / PAIRS.length,
      avgTrades: totalTrades / PAIRS.length,
      avgWinRate: totalWinRate / PAIRS.length,
    });
  }

  vwapResults.sort((a, b) => b.avgReturn - a.avgReturn);
  console.log("\n=== TOP 10 VWAP CONFIGURATIONS ===");
  for (const r of vwapResults.slice(0, 10)) {
    const p = r.params;
    const sign = r.avgReturn >= 0 ? "+" : "";
    console.log(
      `${sign}${r.avgReturn.toFixed(1)}% avg | ${r.avgTrades.toFixed(0)}T | ${r.avgWinRate.toFixed(0)}%W | ` +
      `dev ${p.deviationLongPct}%/${p.deviationShortPct}% conflict ${p.trendConflictPct}% stag ${p.stagnationH}h`,
    );
  }

  const bestRule = ruleResults[0];
  const bestVwap = vwapResults[0];
  console.log("\n=== RECOMMENDED CONSTANTS ===");
  console.log(`STAGNATION_TIMEOUT_MS = ${bestRule.params.stagnationH} * 60 * 60 * 1000  (Rule)`);
  console.log(`RULE_RSI_OVERSOLD = ${bestRule.params.rsiOversold}`);
  console.log(`RULE_RSI_OVERBOUGHT = ${bestRule.params.rsiOverbought}`);
  console.log(`RULE_BB_PROXIMITY_PCT = ${bestRule.params.bbProximityPct}`);
  console.log(`VWAP_DEVIATION_LONG_PCT = ${bestVwap.params.deviationLongPct}`);
  console.log(`VWAP_DEVIATION_SHORT_PCT = ${bestVwap.params.deviationShortPct}`);
  console.log(`  (VWAP best stagnation: ${bestVwap.params.stagnationH}h)`);
}

main().catch(console.error);
