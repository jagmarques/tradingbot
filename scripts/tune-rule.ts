// Rule engine walk-forward tuning. Train 120d / test 60d, 90 combos, 0.29% round-trip.
// Run: npx tsx scripts/tune-rule.ts

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
  stopAtrMult: number;
  rrRatio: number;
  stagnationH: number;
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
  params: RuleParams;
  trainReturn: number;
  testReturn: number;
  testDays: number;
  profitPerDay: number;
  testTrades: number;
  testWinRate: number;
  testMaxDrawdown: number;
  testSharpe: number;
}

// ─── Candle Fetch ─────────────────────────────────────────────────────────────

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
const FEE_RATE = 0.00045 * 2;    // 0.09%
const SLIPPAGE_RATE = 0.001 * 2; // 0.20%
const TOTAL_COST = FEE_RATE + SLIPPAGE_RATE; // 0.29% total
const STARTING_BALANCE = 100;

function runBacktest(
  candles1h: Candle[],
  pre1h: PrecomputedIndicators,
  pre4h: PrecomputedIndicators,
  idx4hAt: number[],
  signalFn: (ind1h: Indicators, ind4h: Indicators, regime: string, price: number) => "long" | "short" | null,
  stagnationH: number,
  stopAtrMult: number,
  rrRatio: number,
  startIdx = 100,
  endIdx?: number,
): BacktestResult {
  const end = endIdx ?? candles1h.length;
  let balance = STARTING_BALANCE;
  let peakBalance = STARTING_BALANCE;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  const stagnationCandles = stagnationH;

  type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peak: number; size: number };
  let pos: Pos | null = null;

  for (let i = startIdx; i < end; i++) {
    const c = candles1h[i];

    if (pos !== null) {
      const unrlPct = ((c.close - pos.entry) / pos.entry) * 100 * (pos.dir === "long" ? 1 : -1);
      pos.peak = Math.max(pos.peak, unrlPct);

      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
      const trailHit = pos.peak > 5 && unrlPct <= pos.peak - 2;
      const stagHit = i - pos.entryIdx >= stagnationCandles;

      let exitPrice: number | null = null;
      if (slHit) exitPrice = pos.sl;
      else if (tpHit) exitPrice = pos.tp;
      else if (trailHit || stagHit) exitPrice = c.close;

      if (exitPrice !== null) {
        const pnl = ((exitPrice - pos.entry) / pos.entry) * pos.size * LEV * (pos.dir === "long" ? 1 : -1);
        const costs = pos.size * LEV * TOTAL_COST;
        const net = pnl - costs;
        const pnlPct = (net / pos.size) * 100;
        balance += net;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);
        trades++;
        if (net > 0) wins++;
        tradePnlPcts.push(pnlPct);
        pos = null;
      }
    } else {
      const ind1h = getAt(pre1h, i);
      const last4h = idx4hAt[i];
      const ind4h = last4h >= 0 ? getAt(pre4h, last4h) : NULL_IND;
      const regime = classifyRegime(ind1h);

      const dir = signalFn(ind1h, ind4h, regime, c.close);
      if (dir !== null && i + 1 < end) {
        const entryPrice = candles1h[i + 1].open;
        const atr = ind1h.atr ?? c.close * 0.01;
        const sl = dir === "long" ? entryPrice - atr * stopAtrMult : entryPrice + atr * stopAtrMult;
        const tp = dir === "long" ? entryPrice + atr * stopAtrMult * rrRatio : entryPrice - atr * stopAtrMult * rrRatio;
        const maxSize = (balance * 0.95) / 10;
        const size = Math.min(maxSize, balance * 0.1);
        if (size >= 1) {
          pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peak: 0, size };
        }
      }
    }
  }

  if (pos !== null) {
    const last = candles1h[end - 1];
    const pnl = ((last.close - pos.entry) / pos.entry) * pos.size * LEV * (pos.dir === "long" ? 1 : -1);
    const costs = pos.size * LEV * TOTAL_COST;
    const net = pnl - costs;
    balance += net;
    trades++;
    if (net > 0) wins++;
    tradePnlPcts.push((net / pos.size) * 100);
  }

  // Approximate days in window
  const startTs = candles1h[startIdx]?.timestamp ?? 0;
  const endTs = candles1h[end - 1]?.timestamp ?? 0;
  const days = (endTs - startTs) / 86400_000;

  return {
    trades,
    wins,
    totalReturn: ((balance - STARTING_BALANCE) / STARTING_BALANCE) * 100,
    maxDrawdown,
    tradePnlPcts,
    days,
  };
}

function computeSharpe(tradePnlPcts: number[]): number {
  if (tradePnlPcts.length < 2) return 0;
  const mean = tradePnlPcts.reduce((s, v) => s + v, 0) / tradePnlPcts.length;
  const variance = tradePnlPcts.reduce((s, v) => s + (v - mean) ** 2, 0) / tradePnlPcts.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  return (mean / stddev) * Math.sqrt(tradePnlPcts.length);
}

// ─── Signal function ──────────────────────────────────────────────────────────

function ruleSignal(p: RuleParams) {
  return (ind: Indicators, _ind4h: Indicators, regime: string, price: number): "long" | "short" | null => {
    if (regime === "volatile") return null;
    const { rsi, macd, bb } = ind;

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

// ─── Grid ─────────────────────────────────────────────────────────────────────

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

// Phase 1: 3^4 = 81 combos (fixed rrRatio=2.0, stagnationH=12, pullback=40/60)
const RSI_OVERSOLD = [25, 30, 35];
const RSI_OVERBOUGHT = [65, 70, 75];
const BB_PROXIMITY = [1.0, 1.5, 2.0];
const STOP_ATR_MULTS = [1.25, 1.5, 2.0];

const PHASE1_GRID: RuleParams[] = [];
for (const rsiOversold of RSI_OVERSOLD) {
  for (const rsiOverbought of RSI_OVERBOUGHT) {
    for (const bbProximityPct of BB_PROXIMITY) {
      for (const stopAtrMult of STOP_ATR_MULTS) {
        PHASE1_GRID.push({
          rsiOversold, rsiOverbought,
          rsiPullbackLow: 40, rsiPullbackHigh: 60,
          bbProximityPct, stopAtrMult,
          rrRatio: 2.0, stagnationH: 12,
        });
      }
    }
  }
}

// Phase 2: best Phase 1 x rrRatio(3) x stagnationH(3) = 9 combos
const RR_RATIOS_P2 = [2.0, 2.5, 3.0];
const STAGNATION_H_P2 = [8, 12, 16];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== tune-rule.ts: Walk-Forward Rule Engine Parameter Search ===");
  console.log(`Phase 1: ${PHASE1_GRID.length} combos x ${PAIRS.length} pairs (grid: RSI x BB x stop)`);
  console.log(`Phase 2: best Phase 1 x ${RR_RATIOS_P2.length}x${STAGNATION_H_P2.length} = ${RR_RATIOS_P2.length * STAGNATION_H_P2.length} combos`);
  console.log(`Total cost: ${(TOTAL_COST * 100).toFixed(2)}% round-trip (fee ${(FEE_RATE * 100).toFixed(2)}% + slippage ${(SLIPPAGE_RATE * 100).toFixed(2)}%)`);
  console.log("Fetching 180d candles for all pairs...");

  const candleMap: Record<string, {
    h1: Candle[];
    h4: Candle[];
    pre1h: PrecomputedIndicators;
    pre4h: PrecomputedIndicators;
    idx4hAt: number[];
    trainEnd: number;
  }> = {};

  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}... `);
    const [h1, h4] = await Promise.all([
      fetchCandles(pair, 3_600_000, 180),
      fetchCandles(pair, 14_400_000, 180),
    ]);
    const pre1h = precomputeAllIndicators(h1);
    const pre4h = precomputeAllIndicators(h4);

    const trainEnd = Math.floor(h1.length * (120 / 180));

    // Pre-compute 4h index pointer
    const idx4hAt: number[] = new Array(h1.length).fill(-1);
    let j = 0;
    for (let i = 0; i < h1.length; i++) {
      while (j < h4.length && h4[j].timestamp <= h1[i].timestamp) j++;
      idx4hAt[i] = j - 1;
    }

    candleMap[pair] = { h1, h4, pre1h, pre4h, idx4hAt, trainEnd };
    console.log(`${h1.length} 1h candles (train: ${trainEnd}, test: ${h1.length - trainEnd})`);
  }

  const samplePair = candleMap[PAIRS[0]];
  const trainDays = samplePair.trainEnd > 0
    ? (samplePair.h1[samplePair.trainEnd - 1].timestamp - samplePair.h1[100].timestamp) / 86400_000
    : 0;
  const testDays = (samplePair.h1[samplePair.h1.length - 1].timestamp - samplePair.h1[samplePair.trainEnd].timestamp) / 86400_000;
  console.log(`\nWalk-forward: ~${trainDays.toFixed(0)}d training, ~${testDays.toFixed(0)}d test`);

  console.log(`\nRunning Phase 1 on TRAINING set (${PHASE1_GRID.length} combos x ${PAIRS.length} pairs)...`);
  type TrainResult = { params: RuleParams; avgTrainReturn: number };
  const phase1Train: TrainResult[] = [];

  for (const params of PHASE1_GRID) {
    let totalReturn = 0;
    for (const pair of PAIRS) {
      const { h1, pre1h, pre4h, idx4hAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h1, pre1h, pre4h, idx4hAt, ruleSignal(params), params.stagnationH, params.stopAtrMult, params.rrRatio, 100, trainEnd);
      totalReturn += r.totalReturn;
    }
    phase1Train.push({ params, avgTrainReturn: totalReturn / PAIRS.length });
  }

  phase1Train.sort((a, b) => b.avgTrainReturn - a.avgTrainReturn);
  const bestPhase1 = phase1Train[0].params;
  console.log(`  Best Phase 1 (train): RSI ${bestPhase1.rsiOversold}/${bestPhase1.rsiOverbought} BB ${bestPhase1.bbProximityPct}% stop ${bestPhase1.stopAtrMult}x | train return: ${phase1Train[0].avgTrainReturn.toFixed(2)}%`);

  console.log(`\nRunning Phase 2 on TRAINING set (${RR_RATIOS_P2.length * STAGNATION_H_P2.length} combos)...`);
  const phase2Train: TrainResult[] = [];
  for (const rrRatio of RR_RATIOS_P2) {
    for (const stagnationH of STAGNATION_H_P2) {
      const params: RuleParams = { ...bestPhase1, rrRatio, stagnationH };
      let totalReturn = 0;
      for (const pair of PAIRS) {
        const { h1, pre1h, pre4h, idx4hAt, trainEnd } = candleMap[pair];
        const r = runBacktest(h1, pre1h, pre4h, idx4hAt, ruleSignal(params), params.stagnationH, params.stopAtrMult, params.rrRatio, 100, trainEnd);
        totalReturn += r.totalReturn;
      }
      phase2Train.push({ params, avgTrainReturn: totalReturn / PAIRS.length });
    }
  }
  phase2Train.sort((a, b) => b.avgTrainReturn - a.avgTrainReturn);

  const allTrainCombined: { params: RuleParams; trainReturn: number }[] = [
    ...phase1Train.map((r) => ({ params: r.params, trainReturn: r.avgTrainReturn })),
    ...phase2Train.map((r) => ({ params: r.params, trainReturn: r.avgTrainReturn })),
  ];
  allTrainCombined.sort((a, b) => b.trainReturn - a.trainReturn);
  const top5Train = allTrainCombined.slice(0, 5);

  console.log(`\nEvaluating top-5 training configs on TEST set (final 60 days)...`);
  const walkForwardResults: WalkForwardResult[] = [];

  for (const { params, trainReturn } of top5Train) {
    let testTotalReturn = 0;
    let testTotalTrades = 0;
    let testTotalWins = 0;
    let testMaxDD = 0;
    let combinedPnlPcts: number[] = [];
    let testDays = 0;

    for (const pair of PAIRS) {
      const { h1, pre1h, pre4h, idx4hAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h1, pre1h, pre4h, idx4hAt, ruleSignal(params), params.stagnationH, params.stopAtrMult, params.rrRatio, trainEnd, h1.length);
      testTotalReturn += r.totalReturn;
      testTotalTrades += r.trades;
      testTotalWins += r.wins;
      testMaxDD = Math.max(testMaxDD, r.maxDrawdown);
      combinedPnlPcts = combinedPnlPcts.concat(r.tradePnlPcts);
      testDays = Math.max(testDays, r.days);
    }

    const avgTestReturn = testTotalReturn / PAIRS.length;
    const profitPerDay = testDays > 0 ? avgTestReturn / testDays : 0;

    walkForwardResults.push({
      params,
      trainReturn,
      testReturn: avgTestReturn,
      testDays,
      profitPerDay,
      testTrades: testTotalTrades,
      testWinRate: testTotalTrades > 0 ? (testTotalWins / testTotalTrades) * 100 : 0,
      testMaxDrawdown: testMaxDD,
      testSharpe: computeSharpe(combinedPnlPcts),
    });
  }

  walkForwardResults.sort((a, b) => b.profitPerDay - a.profitPerDay);

  // ── Output ────────────────────────────────────────────────────────────────

  console.log("\n=== TOP 5 OUT-OF-SAMPLE RESULTS (Rule Engine) ===");
  console.log("Rank | %/day | Test Return | Train Return | Trades | WR  | MaxDD | Sharpe | Params");
  console.log("-----|-------|-------------|--------------|--------|-----|-------|--------|-------");

  for (let rank = 0; rank < walkForwardResults.length; rank++) {
    const r = walkForwardResults[rank];
    const p = r.params;
    const sign = r.testReturn >= 0 ? "+" : "";
    const trainSign = r.trainReturn >= 0 ? "+" : "";
    const daySign = r.profitPerDay >= 0 ? "+" : "";
    const params = `RSI ${p.rsiOversold}/${p.rsiOverbought} BB ${p.bbProximityPct}% stop ${p.stopAtrMult}x rr ${p.rrRatio} stag ${p.stagnationH}h`;
    console.log(
      `  ${rank + 1}  | ${daySign}${r.profitPerDay.toFixed(3)} | ${sign}${r.testReturn.toFixed(2)}%       | ${trainSign}${r.trainReturn.toFixed(2)}%        | ${r.testTrades.toString().padStart(6)} | ${r.testWinRate.toFixed(0).padStart(3)}%| ${r.testMaxDrawdown.toFixed(1).padStart(5)}%| ${r.testSharpe.toFixed(2).padStart(6)} | ${params}`,
    );
  }

  const best = walkForwardResults[0];

  console.log("\n=== ASSESSMENT ===");
  if (best.profitPerDay > 0) {
    console.log(`Best out-of-sample: ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(3)}%/day (${best.testReturn >= 0 ? "+" : ""}${best.testReturn.toFixed(2)}% over ${best.testDays.toFixed(0)}d test)`);
    console.log("Result: Some combos profitable after realistic costs (fee + slippage).");
  } else {
    console.log(`Best out-of-sample: ${best.profitPerDay.toFixed(3)}%/day - NO PROFITABLE COMBOS after realistic costs.`);
  }

  const profitable = walkForwardResults.filter((r) => r.profitPerDay > 0);
  console.log(`Profitable combos: ${profitable.length}/${walkForwardResults.length}`);

  console.log("\n=== RECOMMENDED CONSTANTS ===");
  const bp = best.params;
  console.log(`RULE_RSI_OVERSOLD = ${bp.rsiOversold}`);
  console.log(`RULE_RSI_OVERBOUGHT = ${bp.rsiOverbought}`);
  console.log(`RULE_BB_PROXIMITY_PCT = ${bp.bbProximityPct}`);
  console.log(`RULE_STOP_ATR_MULTIPLIER = ${bp.stopAtrMult}`);
  console.log(`RULE_REWARD_RISK_RATIO = ${bp.rrRatio}`);
  console.log(`RULE_RSI_PULLBACK_LOW = ${bp.rsiPullbackLow}`);
  console.log(`RULE_RSI_PULLBACK_HIGH = ${bp.rsiPullbackHigh}`);
  console.log(`STAGNATION_TIMEOUT_MS = ${bp.stagnationH} * 60 * 60 * 1000  // ${bp.stagnationH}h`);
  console.log(`\nBest test %/day: ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}`);
  console.log(`Best test return: ${best.testReturn >= 0 ? "+" : ""}${best.testReturn.toFixed(2)}% over ~${best.testDays.toFixed(0)} days`);
  console.log(`Best train return: ${best.trainReturn >= 0 ? "+" : ""}${best.trainReturn.toFixed(2)}%`);
}

main().catch(console.error);
