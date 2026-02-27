// Cross-Sectional Momentum backtest: ranks ALL 8 pairs simultaneously every rebalance bar.
// Long top-2 / short bottom-2 by recent return. Single shared balance.
// Walk-forward: train 240d / test ~125d. 0.29% round-trip costs, 10x leverage.
// Run: npx tsx scripts/tune-csm.ts

import { ATR, ADX } from "technicalindicators";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Params {
  lookbackBars: number;   // 4h bars for return calculation (30=5d, 40=6.7d, 60=10d)
  topN: number;           // how many top/bottom pairs to trade
  adxMin: number;         // minimum ADX on selected pairs
  stopAtrMult: number;    // ATR stop multiplier
  rrRatio: number;        // reward:risk
  stagnationH: number;    // 4h bars stagnation (fixed at 9 = 36h)
  rebalanceBars: number;  // re-rank every N bars (fixed at 6 = 24h)
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

async function fetchCandles(coin: string, interval: string, days: number): Promise<Candle[]> {
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

// ─── 4h Indicators ────────────────────────────────────────────────────────────

interface H4PreInd {
  atr: (number | null)[];
  adx: (number | null)[];
}

function precompute4h(candles: Candle[]): H4PreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atrArr[n - atrRaw.length + i] = v; });

  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });

  return { atr: atrArr, adx: adxArr };
}

// ─── Backtest ─────────────────────────────────────────────────────────────────
// Cross-sectional: single simulation loop over ALL pairs simultaneously.
// At each rebalance bar, rank all pairs by recent return and open positions on top/bottom N.

const LEV = 10;
const FEE_RATE = 0.00045 * 2;
const SLIPPAGE_RATE = 0.001 * 2;
const TOTAL_COST = FEE_RATE + SLIPPAGE_RATE;
const STARTING_BALANCE = 100;

type PairDataArray = {
  candles: Candle[];
  pre: H4PreInd;
};

type OpenPos = {
  pairIdx: number;
  dir: "long" | "short";
  entry: number;
  entryBarIdx: number;  // index in that pair's candle array
  sl: number;
  tp: number;
  peak: number;
  size: number;
};

function runCsmBacktest(
  pairDataArr: PairDataArray[],
  p: Params,
  startIdx = 60,
  endIdx?: number,
): BacktestResult {
  // All pairs must have the same bar count and aligned timestamps (checked by caller)
  const nBars = pairDataArr[0].candles.length;
  const end = endIdx ?? nBars;

  let balance = STARTING_BALANCE;
  let peakBalance = STARTING_BALANCE;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  // Per-pair open positions (at most one per pair)
  const openPositions: (OpenPos | null)[] = new Array(pairDataArr.length).fill(null);

  for (let barIdx = startIdx; barIdx < end; barIdx++) {
    // ── 1. Update/close existing positions ──────────────────────────────────
    for (let pIdx = 0; pIdx < pairDataArr.length; pIdx++) {
      const pos = openPositions[pIdx];
      if (pos === null) continue;

      const c = pairDataArr[pIdx].candles[barIdx];
      if (!c) continue;

      const unrlPct = ((c.close - pos.entry) / pos.entry) * 100 * (pos.dir === "long" ? 1 : -1);
      if (unrlPct > pos.peak) pos.peak = unrlPct;

      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
      const trailHit = pos.peak > 5 && unrlPct <= pos.peak - 2;
      const stagHit = barIdx - pos.entryBarIdx >= p.stagnationH;

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
        openPositions[pIdx] = null;
      }
    }

    // ── 2. Rebalance: rank all pairs and open new positions ─────────────────
    if (barIdx < p.lookbackBars) continue;
    if ((barIdx - startIdx) % p.rebalanceBars !== 0) continue;

    // Compute recent return for each pair
    const returns: { pairIdx: number; ret: number }[] = [];
    for (let pIdx = 0; pIdx < pairDataArr.length; pIdx++) {
      const candles = pairDataArr[pIdx].candles;
      const currClose = candles[barIdx]?.close;
      const prevClose = candles[barIdx - p.lookbackBars]?.close;
      if (currClose == null || prevClose == null || prevClose === 0) continue;
      returns.push({ pairIdx: pIdx, ret: (currClose / prevClose) - 1 });
    }

    // Sort: best performers first
    returns.sort((a, b) => b.ret - a.ret);

    const longCandidates = returns.slice(0, p.topN);
    const shortCandidates = returns.slice(-p.topN);

    // Open longs on top-N (if no position open, ADX filter passes)
    for (const { pairIdx } of longCandidates) {
      if (openPositions[pairIdx] !== null) continue; // already in position

      const pre = pairDataArr[pairIdx].pre;
      const adx = pre.adx[barIdx];
      if (adx === null || adx < p.adxMin) continue;

      const nextBar = pairDataArr[pairIdx].candles[barIdx + 1];
      if (!nextBar || barIdx + 1 >= end) continue;

      const entryPrice = nextBar.open;
      const atr = pre.atr[barIdx] ?? pairDataArr[pairIdx].candles[barIdx].close * 0.02;
      const sl = entryPrice - atr * p.stopAtrMult;
      const tp = entryPrice + atr * p.stopAtrMult * p.rrRatio;

      // Split position size evenly among max open signals
      const maxSignals = p.topN * 2;
      const size = Math.min(balance * 0.95 / LEV / maxSignals, balance * 0.1 / maxSignals);
      if (size < 0.5) continue;

      openPositions[pairIdx] = { pairIdx, dir: "long", entry: entryPrice, entryBarIdx: barIdx + 1, sl, tp, peak: 0, size };
    }

    // Open shorts on bottom-N (if no position open)
    for (const { pairIdx } of shortCandidates) {
      if (openPositions[pairIdx] !== null) continue;

      // Don't double-enter if pair is also a long candidate
      const isAlsoLong = longCandidates.some((lc) => lc.pairIdx === pairIdx);
      if (isAlsoLong) continue;

      const pre = pairDataArr[pairIdx].pre;
      const adx = pre.adx[barIdx];
      if (adx === null || adx < p.adxMin) continue;

      const nextBar = pairDataArr[pairIdx].candles[barIdx + 1];
      if (!nextBar || barIdx + 1 >= end) continue;

      const entryPrice = nextBar.open;
      const atr = pre.atr[barIdx] ?? pairDataArr[pairIdx].candles[barIdx].close * 0.02;
      const sl = entryPrice + atr * p.stopAtrMult;
      const tp = entryPrice - atr * p.stopAtrMult * p.rrRatio;

      const maxSignals = p.topN * 2;
      const size = Math.min(balance * 0.95 / LEV / maxSignals, balance * 0.1 / maxSignals);
      if (size < 0.5) continue;

      openPositions[pairIdx] = { pairIdx, dir: "short", entry: entryPrice, entryBarIdx: barIdx + 1, sl, tp, peak: 0, size };
    }
  }

  const startTs = pairDataArr[0].candles[startIdx]?.timestamp ?? 0;
  const endTs = pairDataArr[0].candles[end - 1]?.timestamp ?? 0;
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

// 81 combos: 3 x 3 x 3 x 3 (topN=2, rebalanceBars=6, stagnationH=9 fixed)
const LOOKBACK_VALS = [30, 40, 60];
const ADX_MIN_VALS = [15, 18, 20];
const STOP_ATR_VALS = [1.5, 2.0, 2.5];
const RR_VALS = [2.0, 2.5, 3.0];

interface TrainResult { params: Params; trainReturn: number }

const GRID: Params[] = [];
for (const lookbackBars of LOOKBACK_VALS) {
  for (const adxMin of ADX_MIN_VALS) {
    for (const stopAtrMult of STOP_ATR_VALS) {
      for (const rrRatio of RR_VALS) {
        GRID.push({ lookbackBars, topN: 2, adxMin, stopAtrMult, rrRatio, stagnationH: 9, rebalanceBars: 6 });
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== tune-csm.ts: Cross-Sectional Momentum, ${PAIRS.length} pairs ranked together, ${DAYS}d data ===`);
  console.log(`Grid: ${GRID.length} combos (lookback[${LOOKBACK_VALS}] x adxMin[${ADX_MIN_VALS}] x stopAtr[${STOP_ATR_VALS}] x rr[${RR_VALS}])`);
  console.log("Fixed: topN=2, rebalanceBars=6 (24h), stagnationH=9 (36h)");
  console.log("Fetching data (4h candles for each pair)...");

  type PairLoadData = {
    data: PairDataArray;
    trainEnd: number;
  };
  const candleMap: Record<string, PairLoadData> = {};

  for (const pair of PAIRS) {
    try {
      process.stdout.write(`  ${pair} (4h)... `);
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre = precompute4h(h4);
      const trainEnd = Math.floor(h4.length * TRAIN_FRAC);
      candleMap[pair] = { data: { candles: h4, pre }, trainEnd };
      const testLen = h4.length - trainEnd;
      console.log(`${h4.length} candles (train: ${trainEnd}, test: ${testLen})`);
    } catch (e) {
      console.warn(`  ${pair}: fetch failed (${(e as Error).message}), skipping`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) { console.error("No pairs loaded"); process.exit(1); }

  // Align all pairs to same bar count (use minimum)
  const minBars = Math.min(...pairs.map((p) => candleMap[p].data.candles.length));
  const alignedData: PairDataArray[] = pairs.map((p) => ({
    candles: candleMap[p].data.candles.slice(-minBars),
    pre: {
      atr: candleMap[p].data.pre.atr.slice(-minBars),
      adx: candleMap[p].data.pre.adx.slice(-minBars),
    },
  }));

  const trainEnd = Math.floor(minBars * TRAIN_FRAC);
  const trainDays = (alignedData[0].candles[trainEnd - 1].timestamp - alignedData[0].candles[60].timestamp) / 86400_000;
  const testDays = (alignedData[0].candles[minBars - 1].timestamp - alignedData[0].candles[trainEnd].timestamp) / 86400_000;
  console.log(`\nAligned to ${minBars} bars. Walk-forward: ~${trainDays.toFixed(0)}d train, ~${testDays.toFixed(0)}d test`);
  console.log(`NOTE: CSM ranks ALL ${pairs.length} pairs simultaneously at each rebalance bar (not independently)`);

  // Train
  console.log(`\nTraining (${GRID.length} combos)...`);
  const trainResults: TrainResult[] = [];
  for (const params of GRID) {
    const r = runCsmBacktest(alignedData, params, 60, trainEnd);
    trainResults.push({ params, trainReturn: r.totalReturn });
  }
  trainResults.sort((a, b) => b.trainReturn - a.trainReturn);
  const best1 = trainResults[0];
  console.log(`  Best train: lookback=${best1.params.lookbackBars} adx=${best1.params.adxMin} stopAtr=${best1.params.stopAtrMult} rr=${best1.params.rrRatio} | return: ${best1.trainReturn.toFixed(2)}%`);

  const top5 = trainResults.slice(0, 5);

  // Evaluate on test set
  console.log(`\nEvaluating top-5 on TEST set (~${testDays.toFixed(0)}d out-of-sample)...`);
  const results: WalkForwardResult[] = [];

  for (const { params, trainReturn } of top5) {
    const r = runCsmBacktest(alignedData, params, trainEnd);
    results.push({
      params,
      trainReturn,
      testReturn: r.totalReturn,
      testDays: r.days,
      profitPerDay: r.days > 0 ? r.totalReturn / r.days : 0,
      testTrades: r.trades,
      testWinRate: r.trades > 0 ? (r.wins / r.trades) * 100 : 0,
      testMaxDrawdown: r.maxDrawdown,
      testSharpe: sharpe(r.tradePnlPcts),
    });
  }

  results.sort((a, b) => b.profitPerDay - a.profitPerDay);

  // Output
  console.log("\n=== RESULTS: Top-5 by out-of-sample %/day ===\n");
  console.log("Rk  %/day   TestRet  TrainRet  Trades  WR    MaxDD   Sharpe  Params");
  console.log("─".repeat(115));
  results.forEach((r, i) => {
    const p = r.params;
    const tag = `lookback=${p.lookbackBars} adx=${p.adxMin} stopAtr=${p.stopAtrMult} rr=${p.rrRatio} topN=${p.topN} rebal=${p.rebalanceBars * 4}h stag=${p.stagnationH * 4}h`;
    console.log(`${String(i + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%    ${r.trainReturn >= 0 ? "+" : ""}${r.trainReturn.toFixed(2)}%   ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${r.testSharpe >= 0 ? " " : ""}${r.testSharpe.toFixed(2)}   ${tag}`);
  });

  const best = results[0];
  const bp = best.params;
  console.log("\n=== RECOMMENDED CONSTANTS ===\n");
  console.log(`CSM_LOOKBACK_BARS          = ${bp.lookbackBars}`);
  console.log(`CSM_TOP_N                  = ${bp.topN}`);
  console.log(`CSM_ADX_MIN                = ${bp.adxMin}`);
  console.log(`CSM_STOP_ATR_MULT          = ${bp.stopAtrMult}`);
  console.log(`CSM_REWARD_RISK_RATIO      = ${bp.rrRatio}`);
  console.log(`CSM_STAGNATION_BARS        = ${bp.stagnationH}`);
  console.log(`CSM_REBALANCE_BARS         = ${bp.rebalanceBars}`);
  console.log(`\nNote: Best %/day = ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}, test Sharpe = ${best.testSharpe.toFixed(2)}, trades = ${best.testTrades}`);

  console.log("\n=== ASSESSMENT ===");
  if (best.testSharpe > 1.0 && best.testTrades > 30) {
    console.log(`VIABLE: Sharpe ${best.testSharpe.toFixed(2)} > 1.0, trades ${best.testTrades} > 30. Implement CSM engine.`);
  } else {
    const reasons: string[] = [];
    if (best.testSharpe <= 1.0) reasons.push(`Sharpe ${best.testSharpe.toFixed(2)} <= 1.0`);
    if (best.testTrades <= 30) reasons.push(`trades ${best.testTrades} <= 30`);
    console.log(`NOT VIABLE: ${reasons.join(", ")}. Do not implement CSM engine.`);
  }
}

main().catch(console.error);
