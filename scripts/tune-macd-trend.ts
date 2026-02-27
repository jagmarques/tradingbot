// MACD Histogram Crossover strategy backtest: daily SMA+ADX trend filter + 4h MACD histogram entry.
// Walk-forward: train 240d / test ~125d. 0.29% round-trip costs, 10x leverage.
// Run: npx tsx scripts/tune-macd-trend.ts

import { MACD, ATR, ADX } from "technicalindicators";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Params {
  dailySmaPeriod: number;
  dailyAdxMin: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
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

interface DailyPreInd {
  sma: Record<number, (number | null)[]>;
  adx: (number | null)[];
}

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });

  const sma: Record<number, (number | null)[]> = {};
  for (const period of smaPeriods) {
    const arr: (number | null)[] = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      const sum = closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0);
      arr[i] = sum / period;
    }
    sma[period] = arr;
  }

  return { sma, adx: adxArr };
}

// MACD combo key for precomputed cache
function macdKey(fast: number, slow: number, signal: number): string {
  return `${fast}_${slow}_${signal}`;
}

interface MacdBar {
  macdLine: number | null;
  histogram: number | null;
}

interface H4PreInd {
  atr: (number | null)[];
  macd: Record<string, MacdBar[]>;
}

function precompute4h(
  candles: Candle[],
  macdCombos: Array<{ fast: number; slow: number; signal: number }>,
): H4PreInd {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atrArr[n - atrRaw.length + i] = v; });

  const macd: Record<string, MacdBar[]> = {};
  for (const { fast, slow, signal } of macdCombos) {
    const key = macdKey(fast, slow, signal);
    const raw = MACD.calculate({
      values: closes,
      fastPeriod: fast,
      slowPeriod: slow,
      signalPeriod: signal,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const arr: MacdBar[] = new Array(n).fill(null).map(() => ({ macdLine: null, histogram: null }));
    raw.forEach((v, i) => {
      arr[n - raw.length + i] = {
        macdLine: v.MACD ?? null,
        histogram: v.histogram ?? null,
      };
    });
    macd[key] = arr;
  }

  return { atr: atrArr, macd };
}

const LEV = 10;
const FEE_RATE = 0.00045 * 2;
const SLIPPAGE_RATE = 0.001 * 2;
const TOTAL_COST = FEE_RATE + SLIPPAGE_RATE;
const STARTING_BALANCE = 100;

function runBacktest(
  candles4h: Candle[],
  pre4h: H4PreInd,
  dailyCandles: Candle[],
  preDaily: DailyPreInd,
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

  const key = macdKey(p.macdFast, p.macdSlow, p.macdSignal);
  const macdBars = pre4h.macd[key];
  if (!macdBars) return { trades: 0, wins: 0, totalReturn: 0, maxDrawdown: 0, tradePnlPcts: [], days: 0 };

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
      if (i < 1) continue;
      const dIdx = idxDailyAt[i];
      if (dIdx < 0) continue;

      const dailySma = preDaily.sma[p.dailySmaPeriod]?.[dIdx] ?? null;
      const dailyAdx = preDaily.adx[dIdx];
      const dailyClose = dailyCandles[dIdx].close;

      if (dailySma === null || dailyAdx === null) continue;
      if (dailyAdx < p.dailyAdxMin) continue;

      const dailyUptrend = dailyClose > dailySma;
      const dailyDowntrend = dailyClose < dailySma;

      const curr = macdBars[i];
      const prev = macdBars[i - 1];
      if (!curr || !prev) continue;
      if (curr.histogram === null || prev.histogram === null || curr.macdLine === null) continue;

      let dir: "long" | "short" | null = null;

      // Long: histogram crosses from negative to positive AND MACD line still below zero (oversold bounce)
      if (dailyUptrend && prev.histogram < 0 && curr.histogram >= 0 && curr.macdLine < 0) {
        dir = "long";
      }

      // Short: histogram crosses from positive to negative AND MACD line still above zero (overbought rejection)
      if (dailyDowntrend && prev.histogram > 0 && curr.histogram <= 0 && curr.macdLine > 0) {
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

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ARB", "BNB", "OP", "SUI", "INJ", "NEAR", "ATOM", "APT", "WIF"];
const DAYS = 365;
const TRAIN_FRAC = 240 / 365;

// Phase 1: signal params (fix risk at stopAtr=2.0, rr=2.5, stag=6)
const DAILY_SMA_VALS = [50, 70, 100];
const DAILY_ADX_VALS = [15, 20, 25];
const MACD_FAST_VALS = [8, 12];
const MACD_SLOW_VALS = [21, 26];
const MACD_SIGNAL_VALS = [7, 9];

// Phase 2: risk params on best Phase 1
const STOP_ATR_VALS = [1.5, 2.0, 2.5];
const RR_VALS = [2.0, 2.5, 3.0, 3.5];
const STAG_VALS = [6, 9, 12];

const ALL_SMA_PERIODS = [...new Set(DAILY_SMA_VALS)];
const MACD_COMBOS = MACD_FAST_VALS.flatMap((fast) =>
  MACD_SLOW_VALS.flatMap((slow) =>
    MACD_SIGNAL_VALS.map((signal) => ({ fast, slow, signal }))
  )
).filter((c) => c.fast < c.slow);

interface TrainResult { params: Params; trainReturn: number }

const PHASE1_GRID: Params[] = [];
for (const dailySmaPeriod of DAILY_SMA_VALS) {
  for (const dailyAdxMin of DAILY_ADX_VALS) {
    for (const { fast: macdFast, slow: macdSlow, signal: macdSignal } of MACD_COMBOS) {
      PHASE1_GRID.push({
        dailySmaPeriod, dailyAdxMin, macdFast, macdSlow, macdSignal,
        stopAtrMult: 2.0, rrRatio: 2.5, stagnationH: 6,
      });
    }
  }
}

async function main() {
  console.log(`=== tune-macd-trend.ts: MACD Histogram Crossover Strategy, ${PAIRS.length} pairs, ${DAYS}d data ===`);
  console.log(`Phase 1: ${PHASE1_GRID.length} combos (dailySma[${DAILY_SMA_VALS}] x dailyAdx[${DAILY_ADX_VALS}] x macdCombos[${MACD_COMBOS.length}])`);
  console.log(`Phase 2: best Phase 1 x ${STOP_ATR_VALS.length} stopAtrMult x ${RR_VALS.length} rrRatio x ${STAG_VALS.length} stag = ${STOP_ATR_VALS.length * RR_VALS.length * STAG_VALS.length} combos`);
  console.log("Fetching data (4h + daily candles for each pair)...");

  let dailyInterval = "1d";

  type PairData = {
    h4: Candle[];
    pre4h: H4PreInd;
    dailyCandles: Candle[];
    preDaily: DailyPreInd;
    idxDailyAt: number[];
    trainEnd: number;
  };
  const candleMap: Record<string, PairData> = {};

  for (const pair of PAIRS) {
    try {
      process.stdout.write(`  ${pair} (4h)... `);
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre4h = precompute4h(h4, MACD_COMBOS);

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

      const preDaily = precomputeDaily(dailyCandles, ALL_SMA_PERIODS);

      const idxDailyAt: number[] = new Array(h4.length).fill(-1);
      let j = 0;
      for (let i = 0; i < h4.length; i++) {
        while (j < dailyCandles.length && dailyCandles[j].timestamp <= h4[i].timestamp) j++;
        idxDailyAt[i] = j - 1;
      }

      const trainEnd = Math.floor(h4.length * TRAIN_FRAC);
      candleMap[pair] = { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd };
      console.log(`${dailyCandles.length} daily candles. Train end: ${trainEnd}`);
    } catch (e) {
      console.warn(`  ${pair}: fetch failed (${(e as Error).message}), skipping`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) { console.error("No pairs loaded"); process.exit(1); }
  console.log(`\nDaily interval used: "${dailyInterval}"`);

  const samp = candleMap[pairs[0]];
  const trainDays = (samp.h4[samp.trainEnd - 1].timestamp - samp.h4[50].timestamp) / 86400_000;
  const testDays = (samp.h4[samp.h4.length - 1].timestamp - samp.h4[samp.trainEnd].timestamp) / 86400_000;
  console.log(`Walk-forward: ~${trainDays.toFixed(0)}d train, ~${testDays.toFixed(0)}d test`);

  console.log(`\nPhase 1 training (${PHASE1_GRID.length} combos x ${pairs.length} pairs)...`);
  const phase1: TrainResult[] = [];
  for (const params of PHASE1_GRID) {
    let total = 0;
    for (const pair of pairs) {
      const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
      total += runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, 50, trainEnd).totalReturn;
    }
    phase1.push({ params, trainReturn: total / pairs.length });
  }
  phase1.sort((a, b) => b.trainReturn - a.trainReturn);
  const best1 = phase1[0].params;
  console.log(`  Best Phase 1 (train): dailySma=${best1.dailySmaPeriod} dailyAdx=${best1.dailyAdxMin} macd=${best1.macdFast}/${best1.macdSlow}/${best1.macdSignal} | return: ${phase1[0].trainReturn.toFixed(2)}%`);

  console.log(`\nPhase 2 training (${STOP_ATR_VALS.length * RR_VALS.length * STAG_VALS.length} combos)...`);
  const phase2: TrainResult[] = [];
  for (const stopAtrMult of STOP_ATR_VALS) {
    for (const rrRatio of RR_VALS) {
      for (const stagnationH of STAG_VALS) {
        const params: Params = { ...best1, stopAtrMult, rrRatio, stagnationH };
        let total = 0;
        for (const pair of pairs) {
          const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
          total += runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, 50, trainEnd).totalReturn;
        }
        phase2.push({ params, trainReturn: total / pairs.length });
      }
    }
  }
  phase2.sort((a, b) => b.trainReturn - a.trainReturn);

  const allTrain = [...phase1, ...phase2].sort((a, b) => b.trainReturn - a.trainReturn);
  const top5 = allTrain.slice(0, 5);

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
      const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, trainEnd);
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

  console.log("\n=== RESULTS: Top-5 by out-of-sample %/day ===\n");
  console.log("Rk  %/day   TestRet  TrainRet  Trades  WR    MaxDD   Sharpe  Params");
  console.log("-".repeat(140));
  results.forEach((r, i) => {
    const p = r.params;
    const tag = `dailySma=${p.dailySmaPeriod} dailyAdx=${p.dailyAdxMin} macd=${p.macdFast}/${p.macdSlow}/${p.macdSignal} stopAtr=${p.stopAtrMult} rr=${p.rrRatio} stag=${p.stagnationH * 4}h`;
    console.log(`${String(i + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%    ${r.trainReturn >= 0 ? "+" : ""}${r.trainReturn.toFixed(2)}%   ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${r.testSharpe >= 0 ? " " : ""}${r.testSharpe.toFixed(2)}   ${tag}`);
  });

  const best = results[0];
  const bp = best.params;
  console.log("\n=== RECOMMENDED CONSTANTS ===\n");
  console.log(`MACD_TREND_DAILY_SMA_PERIOD  = ${bp.dailySmaPeriod}`);
  console.log(`MACD_TREND_DAILY_ADX_MIN     = ${bp.dailyAdxMin}`);
  console.log(`MACD_TREND_FAST              = ${bp.macdFast}`);
  console.log(`MACD_TREND_SLOW              = ${bp.macdSlow}`);
  console.log(`MACD_TREND_SIGNAL            = ${bp.macdSignal}`);
  console.log(`MACD_TREND_STOP_ATR_MULT     = ${bp.stopAtrMult}`);
  console.log(`MACD_TREND_REWARD_RISK       = ${bp.rrRatio}`);
  console.log(`MACD_TREND_STAGNATION_H      = ${bp.stagnationH * 4}h`);
  console.log(`\nNote: Best %/day = ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}, test Sharpe = ${best.testSharpe.toFixed(2)}, trades = ${best.testTrades}`);

  const MTF_BEST_PER_DAY = 0.196;
  const MTF_BEST_SHARPE = 3.20;
  const beatsExisting = best.profitPerDay > MTF_BEST_PER_DAY && best.testSharpe > MTF_BEST_SHARPE;

  console.log("\n=== ASSESSMENT ===");
  console.log(`Current MTF best: +${MTF_BEST_PER_DAY}%/day, Sharpe ${MTF_BEST_SHARPE}`);
  if (best.testSharpe > 1.0 && best.testTrades > 30) {
    console.log(`VIABLE: Sharpe ${best.testSharpe.toFixed(2)} > 1.0, trades ${best.testTrades} > 30.`);
    if (beatsExisting) {
      console.log(`BEATS MTF: +${best.profitPerDay.toFixed(4)}%/day vs +${MTF_BEST_PER_DAY}%/day. CREATE LIVE ENGINE recommended.`);
    } else {
      console.log(`Does NOT beat MTF (+${MTF_BEST_PER_DAY}%/day, Sharpe ${MTF_BEST_SHARPE}). Viable but not superior - do not implement live engine.`);
    }
  } else {
    const reasons: string[] = [];
    if (best.testSharpe <= 1.0) reasons.push(`Sharpe ${best.testSharpe.toFixed(2)} <= 1.0`);
    if (best.testTrades <= 30) reasons.push(`trades ${best.testTrades} <= 30`);
    console.log(`NOT VIABLE: ${reasons.join(", ")}. Do not implement.`);
  }
}

main().catch(console.error);
