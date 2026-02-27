// RSI(2) mean reversion backtest: 4h RSI(2) oversold/overbought with daily SMA trend filter.
// Walk-forward: train 240d / test ~125d. 0.29% round-trip costs, 10x leverage.
// Run: npx tsx scripts/tune-rsi2.ts

import { ATR, RSI } from "technicalindicators";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Params {
  rsi2Threshold: number;   // RSI(2) extreme threshold (long < threshold, short > 100-threshold)
  dailySmaPeriod: number;  // daily SMA for uptrend/downtrend context
  rsi14Min: number;        // 4h RSI(14) > this for longs (not in full downtrend)
  stopAtrMult: number;     // ATR stop multiplier (tight -- mean reversion)
  rrRatio: number;         // reward:risk
  stagnationH: number;     // 4h bars stagnation (fast exits)
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

// ─── Daily SMA Precompute ─────────────────────────────────────────────────────

function precomputeDailySma(closes: number[], periods: number[]): Record<number, (number | null)[]> {
  const n = closes.length;
  const result: Record<number, (number | null)[]> = {};
  for (const period of periods) {
    const arr: (number | null)[] = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      const sum = closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0);
      arr[i] = sum / period;
    }
    result[period] = arr;
  }
  return result;
}

// ─── 4h Indicators ────────────────────────────────────────────────────────────

interface H4PreInd {
  atr: (number | null)[];
  rsi2: (number | null)[];
  rsi14: (number | null)[];
}

function precompute4h(candles: Candle[]): H4PreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atrArr[n - atrRaw.length + i] = v; });

  const rsi2Raw = RSI.calculate({ values: closes, period: 2 });
  const rsi2Arr: (number | null)[] = new Array(n).fill(null);
  rsi2Raw.forEach((v, i) => { rsi2Arr[n - rsi2Raw.length + i] = v; });

  const rsi14Raw = RSI.calculate({ values: closes, period: 14 });
  const rsi14Arr: (number | null)[] = new Array(n).fill(null);
  rsi14Raw.forEach((v, i) => { rsi14Arr[n - rsi14Raw.length + i] = v; });

  return { atr: atrArr, rsi2: rsi2Arr, rsi14: rsi14Arr };
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.00045 * 2;
const SLIPPAGE_RATE = 0.001 * 2;
const TOTAL_COST = FEE_RATE + SLIPPAGE_RATE;
const STARTING_BALANCE = 100;

function runBacktest(
  candles4h: Candle[],
  pre4h: H4PreInd,
  dailyCandles: Candle[],
  dailySma: Record<number, (number | null)[]>,
  idxDailyAt: number[],
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
      const dIdx = idxDailyAt[i];
      if (dIdx < 0) continue;

      const smaArr = dailySma[p.dailySmaPeriod];
      const dailyClose = dailyCandles[dIdx].close;
      const smaVal = smaArr?.[dIdx] ?? null;
      if (smaVal === null) continue;

      const dailyUptrend = dailyClose > smaVal;
      const dailyDowntrend = dailyClose < smaVal;

      const rsi2 = pre4h.rsi2[i];
      const rsi14 = pre4h.rsi14[i];
      if (rsi2 === null || rsi14 === null) continue;

      let dir: "long" | "short" | null = null;

      // Long: 4h RSI(2) deeply oversold + daily uptrend + 4h RSI(14) not in downtrend
      if (dailyUptrend && rsi2 < p.rsi2Threshold && rsi14 > p.rsi14Min) {
        dir = "long";
      }

      // Short: 4h RSI(2) deeply overbought + daily downtrend + 4h RSI(14) not in uptrend
      if (dailyDowntrend && rsi2 > (100 - p.rsi2Threshold) && rsi14 < (100 - p.rsi14Min)) {
        dir = "short";
      }

      if (dir !== null && i + 1 < end) {
        const entryPrice = candles4h[i + 1].open;
        const atr = pre4h.atr[i] ?? c.close * 0.02;
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

// 108 combos: 3 x 2 x 3 x 3 x 2
const RSI2_THRESHOLD_VALS = [3, 5, 8];
const DAILY_SMA_VALS = [40, 50];
const STOP_ATR_VALS = [0.8, 1.0, 1.2];
const RR_VALS = [1.5, 2.0, 2.5];
const STAG_VALS = [2, 3]; // 8h, 12h

const ALL_SMA_PERIODS = [...new Set(DAILY_SMA_VALS)];

interface TrainResult { params: Params; trainReturn: number }

const GRID: Params[] = [];
for (const rsi2Threshold of RSI2_THRESHOLD_VALS) {
  for (const dailySmaPeriod of DAILY_SMA_VALS) {
    for (const stopAtrMult of STOP_ATR_VALS) {
      for (const rrRatio of RR_VALS) {
        for (const stagnationH of STAG_VALS) {
          GRID.push({ rsi2Threshold, dailySmaPeriod, rsi14Min: 30, stopAtrMult, rrRatio, stagnationH });
        }
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== tune-rsi2.ts: RSI(2) Mean Reversion, ${PAIRS.length} pairs, ${DAYS}d data ===`);
  console.log(`Grid: ${GRID.length} combos (rsi2Threshold[${RSI2_THRESHOLD_VALS}] x dailySma[${DAILY_SMA_VALS}] x stopAtr[${STOP_ATR_VALS}] x rr[${RR_VALS}] x stag[${STAG_VALS}])`);
  console.log("Fetching data (4h + daily candles for each pair)...");

  let dailyInterval = "1d";

  type PairData = {
    h4: Candle[];
    pre4h: H4PreInd;
    dailyCandles: Candle[];
    dailySma: Record<number, (number | null)[]>;
    idxDailyAt: number[];
    trainEnd: number;
  };
  const candleMap: Record<string, PairData> = {};

  for (const pair of PAIRS) {
    try {
      process.stdout.write(`  ${pair} (4h)... `);
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre4h = precompute4h(h4);

      process.stdout.write(`${h4.length} candles. Daily (${dailyInterval})... `);
      let dailyCandles: Candle[];
      try {
        dailyCandles = await fetchCandles(pair, dailyInterval, DAYS);
      } catch (e) {
        if (dailyInterval === "1d") {
          console.log(`(${dailyInterval} failed, trying 24h)`);
          dailyInterval = "24h";
          dailyCandles = await fetchCandles(pair, dailyInterval, DAYS);
        } else {
          throw e;
        }
      }

      const dailySma = precomputeDailySma(dailyCandles.map((c) => c.close), ALL_SMA_PERIODS);

      const idxDailyAt: number[] = new Array(h4.length).fill(-1);
      let j = 0;
      for (let i = 0; i < h4.length; i++) {
        while (j < dailyCandles.length && dailyCandles[j].timestamp <= h4[i].timestamp) j++;
        idxDailyAt[i] = j - 1;
      }

      const trainEnd = Math.floor(h4.length * TRAIN_FRAC);
      candleMap[pair] = { h4, pre4h, dailyCandles, dailySma, idxDailyAt, trainEnd };
      console.log(`${dailyCandles.length} daily candles. Train end: ${trainEnd}`);
    } catch (e) {
      console.warn(`  ${pair}: fetch failed (${(e as Error).message}), skipping`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) { console.error("No pairs loaded"); process.exit(1); }

  const samp = candleMap[pairs[0]];
  const trainDays = (samp.h4[samp.trainEnd - 1].timestamp - samp.h4[50].timestamp) / 86400_000;
  const testDays = (samp.h4[samp.h4.length - 1].timestamp - samp.h4[samp.trainEnd].timestamp) / 86400_000;
  console.log(`Walk-forward: ~${trainDays.toFixed(0)}d train, ~${testDays.toFixed(0)}d test`);

  // Train
  console.log(`\nTraining (${GRID.length} combos x ${pairs.length} pairs)...`);
  const trainResults: TrainResult[] = [];
  for (const params of GRID) {
    let total = 0;
    for (const pair of pairs) {
      const { h4, pre4h, dailyCandles, dailySma, idxDailyAt, trainEnd } = candleMap[pair];
      total += runBacktest(h4, pre4h, dailyCandles, dailySma, idxDailyAt, params, 50, trainEnd).totalReturn;
    }
    trainResults.push({ params, trainReturn: total / pairs.length });
  }
  trainResults.sort((a, b) => b.trainReturn - a.trainReturn);

  const top5 = trainResults.slice(0, 5);

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
      const { h4, pre4h, dailyCandles, dailySma, idxDailyAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, pre4h, dailyCandles, dailySma, idxDailyAt, params, trainEnd);
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
  console.log("─".repeat(120));
  results.forEach((r, i) => {
    const p = r.params;
    const tag = `rsi2Thr=${p.rsi2Threshold} dailySma=${p.dailySmaPeriod} stopAtr=${p.stopAtrMult} rr=${p.rrRatio} stag=${p.stagnationH * 4}h`;
    console.log(`${String(i + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%    ${r.trainReturn >= 0 ? "+" : ""}${r.trainReturn.toFixed(2)}%   ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${r.testSharpe >= 0 ? " " : ""}${r.testSharpe.toFixed(2)}   ${tag}`);
  });

  const best = results[0];
  const bp = best.params;
  console.log("\n=== RECOMMENDED CONSTANTS ===\n");
  console.log(`RSI2_THRESHOLD             = ${bp.rsi2Threshold}`);
  console.log(`RSI2_DAILY_SMA_PERIOD      = ${bp.dailySmaPeriod}`);
  console.log(`RSI2_RSI14_MIN             = ${bp.rsi14Min}`);
  console.log(`RSI2_STOP_ATR_MULT         = ${bp.stopAtrMult}`);
  console.log(`RSI2_REWARD_RISK_RATIO     = ${bp.rrRatio}`);
  console.log(`RSI2_STAGNATION_BARS       = ${bp.stagnationH}`);
  console.log(`\nNote: Best %/day = ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}, test Sharpe = ${best.testSharpe.toFixed(2)}, trades = ${best.testTrades}`);
  console.log(`Current VWAP: +0.015%/day, Sharpe 0.32`);

  console.log("\n=== ASSESSMENT ===");
  if (best.testSharpe > 1.0 && best.testTrades > 30) {
    console.log(`VIABLE: Sharpe ${best.testSharpe.toFixed(2)} > 1.0, trades ${best.testTrades} > 30.`);
    if (best.profitPerDay > 0.015) {
      console.log(`BEATS VWAP: +${best.profitPerDay.toFixed(4)}%/day vs +0.015%/day. REPLACE VWAP with RSI2 engine.`);
    } else {
      console.log(`Does NOT beat VWAP (+0.015%/day). Do not deploy.`);
    }
  } else {
    const reasons: string[] = [];
    if (best.testSharpe <= 1.0) reasons.push(`Sharpe ${best.testSharpe.toFixed(2)} <= 1.0`);
    if (best.testTrades <= 30) reasons.push(`trades ${best.testTrades} <= 30`);
    console.log(`NOT VIABLE: ${reasons.join(", ")}. Do not implement RSI2 engine.`);
  }
}

main().catch(console.error);
