// Enhanced Rule engine tuning: 4h signals, 8 pairs, 365 days, ADX + volume filters.
// Walk-forward: train 240d / test 90d. 0.29% round-trip costs.
// Run: npx tsx scripts/tune-enhanced.ts

import { RSI, MACD, BollingerBands, ATR, ADX } from "technicalindicators";

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
  bb: { upper: number; lower: number; middle: number; width: number | null } | null;
  atr: number | null;
  adx: number | null;
  volumeRatio: number | null; // current vol / 20-period avg
}

interface Params {
  rsiOversold: number;
  rsiOverbought: number;
  bbProximityPct: number;
  stopAtrMult: number;
  rrRatio: number;
  stagnationH: number; // in 4h bars
  adxFilter: boolean;
  volumeFilter: boolean;
}

interface BacktestResult {
  trades: number;
  wins: number;
  totalReturn: number;
  maxDrawdown: number;
  tradePnlPcts: number[];
  days: number;
}

interface WalkForwardResult {
  params: Params;
  trainReturn: number;
  testReturn: number;
  testDays: number;
  profitPerDay: number;
  testTrades: number;
  testWinRate: number;
  testMaxDrawdown: number;
  testSharpe: number;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(coin: string, interval: "1h" | "4h", days: number): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - days * 86400_000;
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin} ${interval}`);
  const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  return raw
    .map((c) => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

interface PreInd {
  rsi: (number | null)[];
  macd: ({ macd: number | null; signal: number | null; histogram: number | null } | null)[];
  bb: ({ upper: number; lower: number; middle: number; width: number | null } | null)[];
  atr: (number | null)[];
  adx: (number | null)[];
  volumeRatio: (number | null)[];
}

function precompute(candles: Candle[]): PreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const fill = <T>(raw: T[], nullVal: T | null = null): (T | null)[] => {
    const arr: (T | null)[] = new Array(n).fill(nullVal);
    raw.forEach((v, i) => { arr[n - raw.length + i] = v; });
    return arr;
  };

  const rsiRaw = RSI.calculate({ values: closes, period: 14 });
  const macdRaw = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const bbRaw = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

  // 20-period volume ratio
  const volRatio: (number | null)[] = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    const avg = volumes.slice(i - 19, i + 1).reduce((s, v) => s + v, 0) / 20;
    volRatio[i] = avg > 0 ? volumes[i] / avg : null;
  }

  const macdArr: PreInd["macd"] = new Array(n).fill(null);
  macdRaw.forEach((v, i) => { macdArr[n - macdRaw.length + i] = { macd: v.MACD ?? null, signal: v.signal ?? null, histogram: v.histogram ?? null }; });

  const bbArr: PreInd["bb"] = new Array(n).fill(null);
  bbRaw.forEach((v, i) => { bbArr[n - bbRaw.length + i] = { upper: v.upper, lower: v.lower, middle: v.middle, width: v.middle > 0 ? (v.upper - v.lower) / v.middle : null }; });

  return {
    rsi: fill(rsiRaw),
    macd: macdArr,
    bb: bbArr,
    atr: fill(atrRaw),
    adx: fill(adxRaw.map((v) => v?.adx ?? null)),
    volumeRatio: volRatio,
  };
}

function getAt(pre: PreInd, i: number): Indicators {
  return { rsi: pre.rsi[i], macd: pre.macd[i], bb: pre.bb[i], atr: pre.atr[i], adx: pre.adx[i], volumeRatio: pre.volumeRatio[i] };
}

const NULL_IND: Indicators = { rsi: null, macd: null, bb: null, atr: null, adx: null, volumeRatio: null };

function classifyRegime(ind: Indicators): "trending" | "ranging" | "volatile" {
  const { adx, bb, atr } = ind;
  const bbWidth = bb?.width ?? null;
  const atrPct = atr !== null && ind.bb?.middle && ind.bb.middle > 0 ? atr / ind.bb.middle : null;
  if (adx !== null && adx > 25 && bbWidth !== null && bbWidth > 0.03) return "trending";
  if (bbWidth !== null && bbWidth > 0.08 && atrPct !== null && atrPct > 0.03) return "volatile";
  return "ranging";
}

// ─── Signal ───────────────────────────────────────────────────────────────────

// 4h-based signal: RSI+MACD for trending, RSI+BB for ranging
// ADX filter requires adx > 20 for any entry
// Volume filter requires volumeRatio > 1.2
function signal4h(p: Params, ind4h: Indicators, regime: string, price: number): "long" | "short" | null {
  if (regime === "volatile") return null;
  if (p.adxFilter && (ind4h.adx === null || ind4h.adx < 20)) return null;
  if (p.volumeFilter && (ind4h.volumeRatio === null || ind4h.volumeRatio < 1.2)) return null;

  if (regime === "trending") {
    const { rsi, macd } = ind4h;
    if (!rsi || !macd || macd.histogram === null || macd.macd === null || macd.signal === null) return null;
    const longOk = rsi >= 35 && rsi < 50 && macd.histogram > 0 && macd.macd > macd.signal;
    const shortOk = rsi > 50 && rsi <= 65 && macd.histogram < 0 && macd.macd < macd.signal;
    if (longOk && !shortOk) return "long";
    if (shortOk && !longOk) return "short";
    return null;
  }

  // ranging: RSI extremes + BB proximity
  const { rsi, bb } = ind4h;
  if (!rsi || !bb || bb.lower === null || bb.upper === null) return null;
  const nearLower = Math.abs(price - bb.lower) / price * 100 <= p.bbProximityPct;
  const nearUpper = Math.abs(price - bb.upper) / price * 100 <= p.bbProximityPct;
  if (rsi < p.rsiOversold && nearLower) return "long";
  if (rsi > p.rsiOverbought && nearUpper) return "short";
  return null;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.00045 * 2;    // 0.09%
const SLIPPAGE_RATE = 0.001 * 2; // 0.20%
const TOTAL_COST = FEE_RATE + SLIPPAGE_RATE; // 0.29% total
const STARTING_BALANCE = 100;

// Runs on 4h candles. Entry at next 4h open after signal.
function runBacktest4h(
  candles4h: Candle[],
  pre4h: PreInd,
  p: Params,
  startIdx = 50,
  endIdx?: number,
): BacktestResult {
  const end = endIdx ?? candles4h.length;
  let balance = STARTING_BALANCE;
  let peakBalance = STARTING_BALANCE;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peak: number; size: number };
  let pos: Pos | null = null;

  for (let i = startIdx; i < end; i++) {
    const c = candles4h[i];

    if (pos !== null) {
      const unrlPct = ((c.close - pos.entry) / pos.entry) * 100 * (pos.dir === "long" ? 1 : -1);
      pos.peak = Math.max(pos.peak, unrlPct);

      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
      const trailHit = pos.peak > 5 && unrlPct <= pos.peak - 2;
      const stagHit = i - pos.entryIdx >= p.stagnationH;

      let exitPrice: number | null = null;
      if (slHit) exitPrice = pos.sl;
      else if (tpHit) exitPrice = pos.tp;
      else if (trailHit || stagHit) exitPrice = c.close;

      if (exitPrice !== null) {
        const pnl = ((exitPrice - pos.entry) / pos.entry) * pos.size * LEV * (pos.dir === "long" ? 1 : -1);
        const costs = pos.size * LEV * TOTAL_COST;
        const net = pnl - costs;
        balance += net;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);
        trades++;
        if (net > 0) wins++;
        tradePnlPcts.push((net / pos.size) * 100);
        pos = null;
      }
    } else {
      const ind = getAt(pre4h, i);
      const regime = classifyRegime(ind);
      const dir = signal4h(p, ind, regime, c.close);
      if (dir !== null && i + 1 < end) {
        const entryPrice = candles4h[i + 1].open;
        const atr = ind.atr ?? c.close * 0.02;
        const sl = dir === "long" ? entryPrice - atr * p.stopAtrMult : entryPrice + atr * p.stopAtrMult;
        const tp = dir === "long" ? entryPrice + atr * p.stopAtrMult * p.rrRatio : entryPrice - atr * p.stopAtrMult * p.rrRatio;
        const size = Math.min(balance * 0.95 / 10, balance * 0.1);
        if (size >= 1) {
          pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peak: 0, size };
        }
      }
    }
  }

  const startTs = candles4h[startIdx]?.timestamp ?? 0;
  const endTs = candles4h[end - 1]?.timestamp ?? 0;
  return {
    trades,
    wins,
    totalReturn: ((balance - STARTING_BALANCE) / STARTING_BALANCE) * 100,
    maxDrawdown,
    tradePnlPcts,
    days: (endTs - startTs) / 86400_000,
  };
}

function sharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ARB"];
const DAYS = 365;
const TRAIN_FRAC = 240 / 365;

// Phase 1: 3x3x3 = 27 combos x 4 filter combos = 108
const RSI_OVERSOLD_VALS = [25, 30, 35];
const RSI_OVERBOUGHT_VALS = [65, 70, 75];
const BB_PROX_VALS = [1.0, 1.5, 2.0];
const STOP_ATR_VALS = [1.5, 2.0, 2.5];
const ADX_OPTS = [false, true];
const VOL_OPTS = [false, true];

const PHASE1_GRID: Params[] = [];
for (const rsiOversold of RSI_OVERSOLD_VALS) {
  for (const rsiOverbought of RSI_OVERBOUGHT_VALS) {
    for (const bbProximityPct of BB_PROX_VALS) {
      for (const stopAtrMult of STOP_ATR_VALS) {
        for (const adxFilter of ADX_OPTS) {
          for (const volumeFilter of VOL_OPTS) {
            PHASE1_GRID.push({ rsiOversold, rsiOverbought, bbProximityPct, stopAtrMult, rrRatio: 2.0, stagnationH: 6, adxFilter, volumeFilter });
          }
        }
      }
    }
  }
}

// Phase 2: best x rr x stag = 9
const RR_VALS = [2.0, 2.5, 3.0];
const STAG_VALS = [3, 6, 9]; // in 4h bars = 12h, 24h, 36h

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== tune-enhanced.ts: 4h Signals, ${PAIRS.length} pairs, ${DAYS}d data ===`);
  console.log(`Phase 1: ${PHASE1_GRID.length} combos (RSI x BB x stop x ADX x vol filters)`);
  console.log(`Phase 2: best combo x ${RR_VALS.length} RR x ${STAG_VALS.length} stag = ${RR_VALS.length * STAG_VALS.length} combos`);
  console.log("Fetching data...");

  type PairData = { h4: Candle[]; pre4h: PreInd; trainEnd: number };
  const candleMap: Record<string, PairData> = {};

  for (const pair of PAIRS) {
    try {
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre4h = precompute(h4);
      const trainEnd = Math.floor(h4.length * TRAIN_FRAC);
      candleMap[pair] = { h4, pre4h, trainEnd };
      const testLen = h4.length - trainEnd;
      console.log(`  ${pair}: ${h4.length} 4h candles (train: ${trainEnd}, test: ${testLen})`);
    } catch (e) {
      console.warn(`  ${pair}: fetch failed (${(e as Error).message}), skipping`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) { console.error("No pairs loaded"); process.exit(1); }

  const samp = candleMap[pairs[0]];
  const trainDays = (samp.h4[samp.trainEnd - 1].timestamp - samp.h4[50].timestamp) / 86400_000;
  const testDays = (samp.h4[samp.h4.length - 1].timestamp - samp.h4[samp.trainEnd].timestamp) / 86400_000;
  console.log(`\nWalk-forward: ~${trainDays.toFixed(0)}d train, ~${testDays.toFixed(0)}d test`);

  // Phase 1: train
  console.log(`\nPhase 1 training (${PHASE1_GRID.length} combos x ${pairs.length} pairs)...`);
  type TR = { params: Params; trainReturn: number };
  const phase1: TR[] = [];
  for (const params of PHASE1_GRID) {
    let total = 0;
    for (const pair of pairs) {
      const { h4, pre4h, trainEnd } = candleMap[pair];
      total += runBacktest4h(h4, pre4h, params, 50, trainEnd).totalReturn;
    }
    phase1.push({ params, trainReturn: total / pairs.length });
  }
  phase1.sort((a, b) => b.trainReturn - a.trainReturn);
  const best1 = phase1[0].params;
  console.log(`  Best Phase 1 (train): RSI ${best1.rsiOversold}/${best1.rsiOverbought} BB ${best1.bbProximityPct}% stop ${best1.stopAtrMult}x adx:${best1.adxFilter} vol:${best1.volumeFilter} | return: ${phase1[0].trainReturn.toFixed(2)}%`);

  // Phase 2: sweep rr + stag on train set
  console.log(`\nPhase 2 training (${RR_VALS.length * STAG_VALS.length} combos)...`);
  const phase2: TR[] = [];
  for (const rrRatio of RR_VALS) {
    for (const stagnationH of STAG_VALS) {
      const params: Params = { ...best1, rrRatio, stagnationH };
      let total = 0;
      for (const pair of pairs) {
        const { h4, pre4h, trainEnd } = candleMap[pair];
        total += runBacktest4h(h4, pre4h, params, 50, trainEnd).totalReturn;
      }
      phase2.push({ params, trainReturn: total / pairs.length });
    }
  }
  phase2.sort((a, b) => b.trainReturn - a.trainReturn);

  // Top-5 by training
  const allTrain = [...phase1, ...phase2].sort((a, b) => b.trainReturn - a.trainReturn);
  const top5 = allTrain.slice(0, 5);

  // Evaluate on test set
  console.log(`\nEvaluating top-5 on TEST set (~${testDays.toFixed(0)}d out-of-sample)...`);
  const results: WalkForwardResult[] = [];

  for (const { params, trainReturn } of top5) {
    let testRet = 0;
    let testTrades = 0;
    let testWins = 0;
    let testDD = 0;
    const allPnls: number[] = [];
    let tDays = 0;

    for (const pair of pairs) {
      const { h4, pre4h, trainEnd } = candleMap[pair];
      const r = runBacktest4h(h4, pre4h, params, trainEnd);
      testRet += r.totalReturn;
      testTrades += r.trades;
      testWins += r.wins;
      testDD = Math.max(testDD, r.maxDrawdown);
      allPnls.push(...r.tradePnlPcts);
      tDays = Math.max(tDays, r.days);
    }

    results.push({
      params,
      trainReturn,
      testReturn: testRet / pairs.length,
      testDays: tDays,
      profitPerDay: tDays > 0 ? (testRet / pairs.length) / tDays : 0,
      testTrades,
      testWinRate: testTrades > 0 ? (testWins / testTrades) * 100 : 0,
      testMaxDrawdown: testDD,
      testSharpe: sharpe(allPnls),
    });
  }

  results.sort((a, b) => b.profitPerDay - a.profitPerDay);

  // Output
  console.log("\n=== RESULTS: Top-5 by out-of-sample %/day ===\n");
  console.log("Rk  %/day   TestRet  TrainRet  Trades  WR    MaxDD   Sharpe  Params");
  console.log("─".repeat(95));
  results.forEach((r, i) => {
    const p = r.params;
    const tag = `RSI ${p.rsiOversold}/${p.rsiOverbought} BB ${p.bbProximityPct}% stp ${p.stopAtrMult}x rr ${p.rrRatio} stag ${p.stagnationH * 4}h adx:${p.adxFilter ? "Y" : "N"} vol:${p.volumeFilter ? "Y" : "N"}`;
    console.log(`${String(i + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%    ${r.trainReturn >= 0 ? "+" : ""}${r.trainReturn.toFixed(2)}%   ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${r.testSharpe >= 0 ? " " : ""}${r.testSharpe.toFixed(2)}   ${tag}`);
  });

  const best = results[0];
  const bp = best.params;
  console.log("\n=== BEST COMBO: Apply to constants.ts ===\n");
  console.log(`RULE_RSI_OVERSOLD         = ${bp.rsiOversold}`);
  console.log(`RULE_RSI_OVERBOUGHT       = ${bp.rsiOverbought}`);
  console.log(`RULE_BB_PROXIMITY_PCT     = ${bp.bbProximityPct}`);
  console.log(`RULE_STOP_ATR_MULTIPLIER  = ${bp.stopAtrMult}`);
  console.log(`RULE_REWARD_RISK_RATIO    = ${bp.rrRatio}`);
  console.log(`STAGNATION_TIMEOUT_MS     = ${bp.stagnationH * 4}h`);
  console.log(`RULE_ADX_FILTER           = ${bp.adxFilter}`);
  console.log(`RULE_VOLUME_FILTER        = ${bp.volumeFilter}`);
  console.log(`\nNote: Best %/day = ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}, test Sharpe = ${best.testSharpe.toFixed(2)}, trades = ${best.testTrades}`);
}

main().catch(console.error);
