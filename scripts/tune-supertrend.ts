// Supertrend: ATR-based trend-following. Enter long above Supertrend, short below.
// Walk-forward: 240d train / ~125d test. 0.29% round-trip, 10x leverage.
// Run: npx tsx scripts/tune-supertrend.ts

import { ATR, ADX } from "technicalindicators";

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }
interface Params { dailySmaPeriod: number; dailyAdxMin: number; stPeriod: number; stMult: number; stopAtrMult: number; rrRatio: number; stagnationH: number; }
interface BacktestResult { trades: number; wins: number; totalReturn: number; maxDrawdown: number; tradePnlPcts: number[]; days: number; }
interface WalkForwardResult { params: Params; trainReturn: number; testReturn: number; testDays: number; profitPerDay: number; testTrades: number; testWinRate: number; testMaxDrawdown: number; testSharpe: number; }

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function fetchCandles(coin: string, interval: string, days: number, retries = 5): Promise<Candle[]> {
  const endTime = Date.now(), startTime = endTime - days * 86400_000;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
      });
      if (res.status === 429 || res.status === 422) { console.warn(`    rate limited, retry ${attempt + 1}/${retries}...`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
      return raw.map((c) => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) })).sort((a, b) => a.timestamp - b.timestamp);
    } catch (e) { if (attempt === retries - 1) throw e; }
  }
  throw new Error(`Failed after ${retries} retries`);
}

interface DailyPreInd { sma: Record<number, (number | null)[]>; adx: (number | null)[]; }
interface H4PreInd { atr: (number | null)[]; supertrend: Record<string, (number | null)[]>; }

function computeSupertrend(candles: Candle[], period: number, mult: number): (number | null)[] {
  const n = candles.length;
  const atrRaw = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close), period });
  const result: (number | null)[] = new Array(n).fill(null);
  let upperBand = 0, lowerBand = 0, supertrend = 0, trend = 1;
  for (let i = period; i < n; i++) {
    const atrIdx = i - period;
    if (atrIdx >= atrRaw.length) break;
    const atr = atrRaw[atrIdx];
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const newUpper = hl2 + mult * atr;
    const newLower = hl2 - mult * atr;
    upperBand = newUpper < upperBand || candles[i - 1].close > upperBand ? newUpper : upperBand;
    lowerBand = newLower > lowerBand || candles[i - 1].close < lowerBand ? newLower : lowerBand;
    if (supertrend === upperBand) {
      trend = candles[i].close > upperBand ? 1 : -1;
    } else {
      trend = candles[i].close < lowerBand ? -1 : 1;
    }
    supertrend = trend === 1 ? lowerBand : upperBand;
    // +1 = uptrend (lowerBand), -1 = downtrend (upperBand)
    result[i] = trend;
  }
  return result;
}

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPreInd {
  const n = candles.length;
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });
  const sma: Record<number, (number | null)[]> = {};
  for (const p of smaPeriods) {
    const arr: (number | null)[] = new Array(n).fill(null);
    for (let i = p - 1; i < n; i++) arr[i] = closes.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p;
    sma[p] = arr;
  }
  return { sma, adx: adxArr };
}

function precompute4h(candles: Candle[], periods: number[], mults: number[]): H4PreInd {
  const n = candles.length;
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atrArr[n - atrRaw.length + i] = v; });
  const supertrend: Record<string, (number | null)[]> = {};
  for (const p of periods) for (const m of mults) supertrend[`${p}_${m}`] = computeSupertrend(candles, p, m);
  return { atr: atrArr, supertrend };
}

const LEV = 10, FEE_RATE = 0.00045 * 2, SLIPPAGE_RATE = 0.001 * 2, TOTAL_COST = FEE_RATE + SLIPPAGE_RATE, STARTING_BALANCE = 100;

function runBacktest(candles4h: Candle[], pre4h: H4PreInd, dailyCandles: Candle[], preDaily: DailyPreInd, idxDailyAt: number[], p: Params, startIdx = 80, endIdx?: number): BacktestResult {
  const end = endIdx ?? candles4h.length;
  let balance = STARTING_BALANCE, peakBalance = STARTING_BALANCE, maxDrawdown = 0, trades = 0, wins = 0;
  const tradePnlPcts: number[] = [];
  const stArr = pre4h.supertrend[`${p.stPeriod}_${p.stMult}`];
  if (!stArr) return { trades: 0, wins: 0, totalReturn: 0, maxDrawdown: 0, tradePnlPcts: [], days: 0 };
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
        const net = pnl - pos.size * LEV * TOTAL_COST;
        balance += net; peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);
        trades++; if (net > 0) wins++; tradePnlPcts.push((net / pos.size) * 100); pos = null;
      }
    } else {
      const dIdx = idxDailyAt[i];
      if (dIdx < 0) continue;
      const dailySma = preDaily.sma[p.dailySmaPeriod]?.[dIdx] ?? null;
      const dailyAdx = preDaily.adx[dIdx];
      const dailyClose = dailyCandles[dIdx].close;
      if (dailySma === null || dailyAdx === null || dailyAdx < p.dailyAdxMin) continue;
      const currSt = stArr[i], prevSt = stArr[i - 1];
      if (currSt === null || prevSt === null) continue;
      const dailyUptrend = dailyClose > dailySma, dailyDowntrend = dailyClose < dailySma;
      let dir: "long" | "short" | null = null;
      if (dailyUptrend && prevSt === -1 && currSt === 1) dir = "long";   // supertrend flipped up
      if (dailyDowntrend && prevSt === 1 && currSt === -1) dir = "short"; // supertrend flipped down
      if (dir !== null && i + 1 < end) {
        const entryPrice = candles4h[i + 1].open;
        const atr = pre4h.atr[i] ?? c.close * 0.02;
        const sl = dir === "long" ? entryPrice - atr * p.stopAtrMult : entryPrice + atr * p.stopAtrMult;
        const tp = dir === "long" ? entryPrice + atr * p.stopAtrMult * p.rrRatio : entryPrice - atr * p.stopAtrMult * p.rrRatio;
        const size = Math.min(balance * 0.95 / 10, balance * 0.1);
        if (size >= 1) pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peak: 0, size };
      }
    }
  }
  const startTs = candles4h[startIdx]?.timestamp ?? 0, endTs = candles4h[end - 1]?.timestamp ?? 0;
  return { trades, wins, totalReturn: ((balance - STARTING_BALANCE) / STARTING_BALANCE) * 100, maxDrawdown, tradePnlPcts, days: (endTs - startTs) / 86400_000 };
}

function sharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ARB", "BNB", "OP", "SUI", "INJ", "ATOM", "APT", "WIF"];
const DAYS = 365, TRAIN_FRAC = 240 / 365;
const DAILY_SMA_VALS = [50, 70, 100, 150];
const DAILY_ADX_VALS = [14, 18, 22];
const ST_PERIOD_VALS = [7, 10, 14, 20];
const ST_MULT_VALS = [2.0, 2.5, 3.0, 3.5, 4.0];
const STOP_ATR_VALS = [1.5, 2.0, 2.5, 3.0];
const RR_VALS = [2.0, 2.5, 3.0, 3.5, 4.0];
const STAG_VALS = [6, 9, 12, 16];

interface TrainResult { params: Params; trainReturn: number; }
const PHASE1_GRID: Params[] = [];
for (const dailySmaPeriod of DAILY_SMA_VALS)
  for (const dailyAdxMin of DAILY_ADX_VALS)
    for (const stPeriod of ST_PERIOD_VALS)
      for (const stMult of ST_MULT_VALS)
        PHASE1_GRID.push({ dailySmaPeriod, dailyAdxMin, stPeriod, stMult, stopAtrMult: 2.5, rrRatio: 3.0, stagnationH: 12 });

async function main() {
  const p2Count = STOP_ATR_VALS.length * RR_VALS.length * STAG_VALS.length;
  console.log(`=== tune-supertrend.ts: ${PAIRS.length} pairs, ${DAYS}d ===`);
  console.log(`Phase 1: ${PHASE1_GRID.length} combos | Phase 2: ${p2Count} combos`);
  let dailyInterval = "1d";
  type PairData = { h4: Candle[]; pre4h: H4PreInd; dailyCandles: Candle[]; preDaily: DailyPreInd; idxDailyAt: number[]; trainEnd: number; };
  const candleMap: Record<string, PairData> = {};
  for (const pair of PAIRS) {
    try {
      process.stdout.write(`  ${pair} (4h)... `);
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre4h = precompute4h(h4, ST_PERIOD_VALS, ST_MULT_VALS);
      process.stdout.write(`${h4.length} candles. Daily... `);
      let dailyCandles: Candle[];
      try { dailyCandles = await fetchCandles(pair, dailyInterval, DAYS); }
      catch { dailyInterval = "24h"; dailyCandles = await fetchCandles(pair, dailyInterval, DAYS); }
      const preDaily = precomputeDaily(dailyCandles, [...new Set(DAILY_SMA_VALS)]);
      const idxDailyAt: number[] = new Array(h4.length).fill(-1);
      let j = 0;
      for (let i = 0; i < h4.length; i++) { while (j < dailyCandles.length && dailyCandles[j].timestamp <= h4[i].timestamp) j++; idxDailyAt[i] = j - 1; }
      candleMap[pair] = { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd: Math.floor(h4.length * TRAIN_FRAC) };
      console.log(`${dailyCandles.length} daily.`);
      await sleep(1000);
    } catch (e) { console.warn(`  ${pair}: failed (${(e as Error).message}), skipping`); await sleep(2000); }
  }
  const pairs = PAIRS.filter(p => candleMap[p]);
  if (pairs.length === 0) { console.error("No pairs loaded"); process.exit(1); }
  const samp = candleMap[pairs[0]];
  const testDays = (samp.h4[samp.h4.length - 1].timestamp - samp.h4[samp.trainEnd].timestamp) / 86400_000;
  console.log(`Walk-forward: ~${((240 / 365) * DAYS).toFixed(0)}d train, ~${testDays.toFixed(0)}d test\n`);

  console.log(`Phase 1 (${PHASE1_GRID.length} combos)...`);
  const phase1: TrainResult[] = [];
  for (const params of PHASE1_GRID) {
    let total = 0;
    for (const pair of pairs) { const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair]; total += runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, 80, trainEnd).totalReturn; }
    phase1.push({ params, trainReturn: total / pairs.length });
  }
  phase1.sort((a, b) => b.trainReturn - a.trainReturn);
  const best1 = phase1[0].params;
  console.log(`  Best: sma=${best1.dailySmaPeriod} adx=${best1.dailyAdxMin} ST(${best1.stPeriod},${best1.stMult}) | train: ${phase1[0].trainReturn.toFixed(2)}%`);

  console.log(`\nPhase 2 (${p2Count} combos)...`);
  const phase2: TrainResult[] = [];
  for (const stopAtrMult of STOP_ATR_VALS)
    for (const rrRatio of RR_VALS)
      for (const stagnationH of STAG_VALS) {
        const params: Params = { ...best1, stopAtrMult, rrRatio, stagnationH };
        let total = 0;
        for (const pair of pairs) { const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair]; total += runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, 80, trainEnd).totalReturn; }
        phase2.push({ params, trainReturn: total / pairs.length });
      }

  const top5 = [...phase1, ...phase2].sort((a, b) => b.trainReturn - a.trainReturn).slice(0, 5);
  console.log(`\nEvaluating top-5 on TEST set...`);
  const results: WalkForwardResult[] = [];
  for (const { params, trainReturn } of top5) {
    let testRet = 0, testTrades = 0, testWins = 0, testDD = 0, tDays = 0;
    const allPnls: number[] = [];
    for (const pair of pairs) {
      const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, trainEnd);
      testRet += r.totalReturn; testTrades += r.trades; testWins += r.wins;
      testDD = Math.max(testDD, r.maxDrawdown); allPnls.push(...r.tradePnlPcts); tDays = Math.max(tDays, r.days);
    }
    results.push({ params, trainReturn, testReturn: testRet / pairs.length, testDays: tDays, profitPerDay: tDays > 0 ? (testRet / pairs.length) / tDays : 0, testTrades, testWinRate: testTrades > 0 ? (testWins / testTrades) * 100 : 0, testMaxDrawdown: testDD, testSharpe: sharpe(allPnls) });
  }
  results.sort((a, b) => b.profitPerDay - a.profitPerDay);
  console.log("\n=== RESULTS ===\n");
  console.log("Rk  %/day   TestRet  Trades  WR    MaxDD   Sharpe  Params");
  console.log("-".repeat(110));
  results.forEach((r, i) => {
    const p = r.params;
    console.log(`${String(i + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%  ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${r.testSharpe >= 0 ? " " : ""}${r.testSharpe.toFixed(2)}   sma=${p.dailySmaPeriod} adx=${p.dailyAdxMin} ST(${p.stPeriod},${p.stMult}) stop=${p.stopAtrMult} rr=${p.rrRatio} stag=${p.stagnationH * 4}h`);
  });
  const best = results[0];
  console.log(`\nBest: ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}%/day Sharpe ${best.testSharpe.toFixed(2)} trades ${best.testTrades}`);
  if (best.testSharpe > 1.0 && best.testTrades > 30) console.log("VIABLE");
  else console.log("NOT VIABLE");
}

main().catch(console.error);
