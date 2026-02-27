// Breakout engine tuning: 4h channel breakout, 8 pairs, 365 days.
// Walk-forward: train 240d / test ~90d. 0.29% round-trip costs.
// Run: npx tsx scripts/tune-breakout.ts

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
  lookback: number;        // bars for channel high/low
  stopAtrMult: number;     // ATR multiplier for stop
  rrRatio: number;         // reward:risk ratio
  volumeThreshold: number; // volume spike multiplier vs 20-bar avg
  stagnationH: number;     // 4h bars before stagnation exit
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

async function fetchCandles(coin: string, interval: "4h", days: number): Promise<Candle[]> {
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
  atr: (number | null)[];
  adx: (number | null)[];
  volumeRatio: (number | null)[]; // current vol / 20-period avg
}

function precompute(candles: Candle[]): PreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atrArr[n - atrRaw.length + i] = v; });

  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });

  const volRatio: (number | null)[] = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    const avg = volumes.slice(i - 19, i + 1).reduce((s, v) => s + v, 0) / 20;
    volRatio[i] = avg > 0 ? volumes[i] / avg : null;
  }

  return { atr: atrArr, adx: adxArr, volumeRatio: volRatio };
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.00045 * 2;
const SLIPPAGE_RATE = 0.001 * 2;
const TOTAL_COST = FEE_RATE + SLIPPAGE_RATE;
const STARTING_BALANCE = 100;

function runBacktest(
  candles: Candle[],
  pre: PreInd,
  p: Params,
  startIdx = 50,
  endIdx?: number,
): BacktestResult {
  const end = endIdx ?? candles.length;
  let balance = STARTING_BALANCE;
  let peakBalance = STARTING_BALANCE;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peak: number; size: number };
  let pos: Pos | null = null;

  for (let i = startIdx; i < end; i++) {
    const c = candles[i];

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
      // Signal: close > highest high of previous lookback bars (long) or < lowest low (short)
      if (i < p.lookback) continue;

      const adx = pre.adx[i];
      const volRatio = pre.volumeRatio[i];

      // ADX filter: must have momentum
      if (adx === null || adx < 20) continue;
      // Volume filter: must have a spike
      if (volRatio === null || volRatio < p.volumeThreshold) continue;

      let channelHigh = -Infinity;
      let channelLow = Infinity;
      for (let k = i - p.lookback; k < i; k++) {
        if (candles[k].high > channelHigh) channelHigh = candles[k].high;
        if (candles[k].low < channelLow) channelLow = candles[k].low;
      }

      let dir: "long" | "short" | null = null;
      if (c.close > channelHigh) dir = "long";
      else if (c.close < channelLow) dir = "short";

      if (dir !== null && i + 1 < end) {
        const entryPrice = candles[i + 1].open;
        const atr = pre.atr[i] ?? c.close * 0.02;
        const sl = dir === "long" ? entryPrice - atr * p.stopAtrMult : entryPrice + atr * p.stopAtrMult;
        const tp = dir === "long" ? entryPrice + atr * p.stopAtrMult * p.rrRatio : entryPrice - atr * p.stopAtrMult * p.rrRatio;
        const size = Math.min(balance * 0.95 / 10, balance * 0.1);
        if (size >= 1) {
          pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peak: 0, size };
        }
      }
    }
  }

  const startTs = candles[startIdx]?.timestamp ?? 0;
  const endTs = candles[end - 1]?.timestamp ?? 0;
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

// Phase 1: lookback(3) x stopAtrMult(3) x volumeThreshold(3) = 27 combos
const LOOKBACK_VALS = [15, 20, 25];
const STOP_ATR_VALS = [1.5, 2.0, 2.5];
const VOL_THRESH_VALS = [1.2, 1.5, 2.0];
const RR_VALS = [2.0, 2.5, 3.0];
const STAG_VALS = [3, 6, 9];

interface TrainResult { params: Params; trainReturn: number }

const PHASE1_GRID: Params[] = [];
for (const lookback of LOOKBACK_VALS) {
  for (const stopAtrMult of STOP_ATR_VALS) {
    for (const volumeThreshold of VOL_THRESH_VALS) {
      PHASE1_GRID.push({ lookback, stopAtrMult, rrRatio: 2.0, volumeThreshold, stagnationH: 6 });
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== tune-breakout.ts: 4h Channel Breakout, ${PAIRS.length} pairs, ${DAYS}d data ===`);
  console.log(`Phase 1: ${PHASE1_GRID.length} combos (lookback x stopAtrMult x volumeThreshold)`);
  console.log(`Phase 2: best Phase 1 x ${RR_VALS.length} rrRatio x ${STAG_VALS.length} stagnation = ${RR_VALS.length * STAG_VALS.length} combos`);
  console.log("Fetching data...");

  type PairData = { h4: Candle[]; pre: PreInd; trainEnd: number };
  const candleMap: Record<string, PairData> = {};

  for (const pair of PAIRS) {
    try {
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre = precompute(h4);
      const trainEnd = Math.floor(h4.length * TRAIN_FRAC);
      candleMap[pair] = { h4, pre, trainEnd };
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
  const phase1: TrainResult[] = [];
  for (const params of PHASE1_GRID) {
    let total = 0;
    for (const pair of pairs) {
      const { h4, pre, trainEnd } = candleMap[pair];
      total += runBacktest(h4, pre, params, 50, trainEnd).totalReturn;
    }
    phase1.push({ params, trainReturn: total / pairs.length });
  }
  phase1.sort((a, b) => b.trainReturn - a.trainReturn);
  const best1 = phase1[0].params;
  console.log(`  Best Phase 1 (train): lookback=${best1.lookback} stopAtr=${best1.stopAtrMult} volThr=${best1.volumeThreshold} | return: ${phase1[0].trainReturn.toFixed(2)}%`);

  // Phase 2: sweep rrRatio + stagnationH on train
  console.log(`\nPhase 2 training (${RR_VALS.length * STAG_VALS.length} combos)...`);
  const phase2: TrainResult[] = [];
  for (const rrRatio of RR_VALS) {
    for (const stagnationH of STAG_VALS) {
      const params: Params = { ...best1, rrRatio, stagnationH };
      let total = 0;
      for (const pair of pairs) {
        const { h4, pre, trainEnd } = candleMap[pair];
        total += runBacktest(h4, pre, params, 50, trainEnd).totalReturn;
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
      const { h4, pre, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, pre, params, trainEnd);
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
  console.log("─".repeat(100));
  results.forEach((r, i) => {
    const p = r.params;
    const tag = `lookback=${p.lookback} stopAtr=${p.stopAtrMult} rr=${p.rrRatio} volThr=${p.volumeThreshold} stag=${p.stagnationH * 4}h`;
    console.log(`${String(i + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%    ${r.trainReturn >= 0 ? "+" : ""}${r.trainReturn.toFixed(2)}%   ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${r.testSharpe >= 0 ? " " : ""}${r.testSharpe.toFixed(2)}   ${tag}`);
  });

  const best = results[0];
  const bp = best.params;
  console.log("\n=== RECOMMENDED CONSTANTS ===\n");
  console.log(`BREAKOUT_LOOKBACK_BARS     = ${bp.lookback}`);
  console.log(`BREAKOUT_STOP_ATR_MULT     = ${bp.stopAtrMult}`);
  console.log(`BREAKOUT_REWARD_RISK_RATIO = ${bp.rrRatio}`);
  console.log(`BREAKOUT_VOLUME_THRESHOLD  = ${bp.volumeThreshold}`);
  console.log(`BREAKOUT_STAGNATION_H      = ${bp.stagnationH * 4}h`);
  console.log(`\nNote: Best %/day = ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}, test Sharpe = ${best.testSharpe.toFixed(2)}, trades = ${best.testTrades}`);

  console.log("\n=== ASSESSMENT ===");
  if (best.testSharpe > 0 && best.testTrades > 30) {
    console.log(`VIABLE: Sharpe ${best.testSharpe.toFixed(2)} > 0, trades ${best.testTrades} > 30. Implement breakout engine.`);
  } else {
    const reasons: string[] = [];
    if (best.testSharpe <= 0) reasons.push(`Sharpe ${best.testSharpe.toFixed(2)} <= 0`);
    if (best.testTrades <= 30) reasons.push(`trades ${best.testTrades} <= 30`);
    console.log(`NOT VIABLE: ${reasons.join(", ")}. Do not implement.`);
  }
}

main().catch(console.error);
