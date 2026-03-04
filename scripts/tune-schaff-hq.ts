// Schaff Trend Cycle HQ: picks top winner per ADX level (14-25), Phase 2 for each.
// Run: npx tsx scripts/tune-schaff-hq.ts

import { EMA, ATR, ADX } from "technicalindicators";

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }
interface Params { dailySmaPeriod: number; dailyAdxMin: number; stcFast: number; stcSlow: number; stcCycle: number; stcThreshold: number; stopAtrMult: number; rrRatio: number; stagnationH: number; }
interface BacktestResult { trades: number; wins: number; totalReturn: number; maxDrawdown: number; tradePnlPcts: number[]; days: number; }
interface WalkForwardResult { params: Params; trainReturn: number; testReturn: number; testDays: number; profitPerDay: number; testTrades: number; testWinRate: number; testMaxDrawdown: number; testSharpe: number; }
interface DailyPreInd { sma: Record<number, (number | null)[]>; adx: (number | null)[]; }
interface H4PreInd { atr: (number | null)[]; stc: Record<string, (number | null)[]>; }

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function fetchCandles(coin: string, interval: string, days: number, retries = 5): Promise<Candle[]> {
  const endTime = Date.now(), startTime = endTime - days * 86400_000;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }) });
      if (res.status === 429 || res.status === 422) { console.warn(`    rate limited, retry ${attempt + 1}/${retries}...`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
      return raw.map((c) => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) })).sort((a, b) => a.timestamp - b.timestamp);
    } catch (e) { if (attempt === retries - 1) throw e; }
  }
  throw new Error(`Failed after ${retries} retries`);
}

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPreInd {
  const n = candles.length, closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });
  const sma: Record<number, (number | null)[]> = {};
  for (const p of smaPeriods) { const arr: (number | null)[] = new Array(n).fill(null); for (let i = p - 1; i < n; i++) arr[i] = closes.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p; sma[p] = arr; }
  return { sma, adx: adxArr };
}

function computeStochOfSeries(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window);
    result.push(hi === lo ? 50 : ((data[i] - lo) / (hi - lo)) * 100);
  }
  return result;
}

function smoothSeries(data: number[], period: number): number[] {
  if (data.length < period) return [];
  return EMA.calculate({ values: data, period });
}

const STC_SMOOTH = 3;
function computeSTC(closes: number[], fast: number, slow: number, cycle: number, smooth: number): (number | null)[] {
  const n = closes.length;
  const ema1 = EMA.calculate({ values: closes, period: fast });
  const ema2 = EMA.calculate({ values: closes, period: slow });
  const macdLine: number[] = [];
  const offset = slow - fast;
  for (let i = 0; i < ema2.length; i++) macdLine.push(ema1[i + offset] - ema2[i]);
  const stoch1 = computeStochOfSeries(macdLine, cycle);
  const d1 = smoothSeries(stoch1, smooth);
  const stoch2 = computeStochOfSeries(d1, cycle);
  const stc = smoothSeries(stoch2, smooth);
  const result: (number | null)[] = new Array(n).fill(null);
  const warmup = n - stc.length;
  stc.forEach((v, i) => { result[warmup + i] = v; });
  return result;
}

function precompute4h(candles: Candle[], fastVals: number[], slowVals: number[], cycleVals: number[]): H4PreInd {
  const n = candles.length, highs = candles.map(c => c.high), lows = candles.map(c => c.low), closes = candles.map(c => c.close);
  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { atr[n - atrRaw.length + i] = v; });
  const stc: Record<string, (number | null)[]> = {};
  const seen = new Set<string>();
  for (const fast of fastVals) for (const slow of slowVals) for (const cycle of cycleVals) {
    if (fast >= slow) continue;
    const key = `${fast}_${slow}_${cycle}`;
    if (!seen.has(key)) { seen.add(key); stc[key] = computeSTC(closes, fast, slow, cycle, STC_SMOOTH); }
  }
  return { atr, stc };
}

const LEV = 10, FEE_RATE = 0.00045 * 2, SLIPPAGE_RATE = 0.001 * 2, TOTAL_COST = FEE_RATE + SLIPPAGE_RATE, STARTING_BALANCE = 100;

function runBacktest(candles4h: Candle[], pre4h: H4PreInd, dailyCandles: Candle[], preDaily: DailyPreInd, idxDailyAt: number[], p: Params, startIdx = 80, endIdx?: number): BacktestResult {
  const end = endIdx ?? candles4h.length;
  let balance = STARTING_BALANCE, peakBalance = STARTING_BALANCE, maxDrawdown = 0, trades = 0, wins = 0;
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
      if (slHit) exitPrice = pos.sl; else if (tpHit) exitPrice = pos.tp; else if (trailHit || stagHit) exitPrice = c.close;
      if (exitPrice !== null) {
        const net = ((exitPrice - pos.entry) / pos.entry) * pos.size * LEV * (pos.dir === "long" ? 1 : -1) - pos.size * LEV * TOTAL_COST;
        balance += net; peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);
        trades++; if (net > 0) wins++; tradePnlPcts.push((net / pos.size) * 100); pos = null;
      }
    } else {
      const dIdx = idxDailyAt[i]; if (dIdx < 0) continue;
      const dailySma = preDaily.sma[p.dailySmaPeriod]?.[dIdx] ?? null, dailyAdx = preDaily.adx[dIdx], dailyClose = dailyCandles[dIdx].close;
      if (dailySma === null || dailyAdx === null || dailyAdx < p.dailyAdxMin) continue;
      const key = `${p.stcFast}_${p.stcSlow}_${p.stcCycle}`, stcArr = pre4h.stc[key];
      if (!stcArr) continue;
      const curr = stcArr[i], prev = stcArr[i - 1]; if (curr === null || prev === null) continue;
      const dailyUptrend = dailyClose > dailySma, dailyDowntrend = dailyClose < dailySma;
      let dir: "long" | "short" | null = null;
      if (dailyUptrend && prev <= p.stcThreshold && curr > p.stcThreshold) dir = "long";
      if (dailyDowntrend && prev >= (100 - p.stcThreshold) && curr < (100 - p.stcThreshold)) dir = "short";
      if (dir !== null && i + 1 < end) {
        const entryPrice = candles4h[i + 1].open, atr = pre4h.atr[i] ?? c.close * 0.02;
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
const DAILY_SMA_VALS = [50, 70, 100];
const DAILY_ADX_VALS = [14, 18, 22, 25];
const STC_FAST_VALS = [12, 23];
const STC_SLOW_VALS = [26, 50];
const STC_CYCLE_VALS = [10, 14, 20];
const STC_THRESHOLD_VALS = [25, 50];
const STOP_ATR_VALS = [0.5, 1.5, 2.0, 2.5, 3.0, 4.0];
const RR_VALS = [2.5, 3.0, 3.5, 4.0, 5.0];
const STAG_VALS = [6, 9, 12, 16, 24];

interface TrainResult { params: Params; trainReturn: number; }
const PHASE1_GRID: Params[] = [];
for (const dailySmaPeriod of DAILY_SMA_VALS)
  for (const dailyAdxMin of DAILY_ADX_VALS)
    for (const stcFast of STC_FAST_VALS)
      for (const stcSlow of STC_SLOW_VALS)
        for (const stcCycle of STC_CYCLE_VALS)
          for (const stcThreshold of STC_THRESHOLD_VALS)
            if (stcFast < stcSlow)
              PHASE1_GRID.push({ dailySmaPeriod, dailyAdxMin, stcFast, stcSlow, stcCycle, stcThreshold, stopAtrMult: 2.5, rrRatio: 3.0, stagnationH: 12 });

async function main() {
  const p2Count = STOP_ATR_VALS.length * RR_VALS.length * STAG_VALS.length;
  console.log(`=== tune-schaff-hq.ts: Schaff HQ (ADX 14-25), ${PAIRS.length} pairs, ${DAYS}d ===`);
  console.log(`Phase 1: ${PHASE1_GRID.length} combos | Phase 2: ${p2Count} combos per ADX level`);
  let dailyInterval = "1d";
  type PairData = { h4: Candle[]; pre4h: H4PreInd; dailyCandles: Candle[]; preDaily: DailyPreInd; idxDailyAt: number[]; trainEnd: number; };
  const candleMap: Record<string, PairData> = {};
  for (const pair of PAIRS) {
    try {
      process.stdout.write(`  ${pair} (4h)... `);
      const h4 = await fetchCandles(pair, "4h", DAYS);
      const pre4h = precompute4h(h4, STC_FAST_VALS, STC_SLOW_VALS, STC_CYCLE_VALS);
      process.stdout.write(`${h4.length} candles. Daily... `);
      let dailyCandles: Candle[];
      try { dailyCandles = await fetchCandles(pair, dailyInterval, DAYS); } catch { dailyInterval = "24h"; dailyCandles = await fetchCandles(pair, dailyInterval, DAYS); }
      const preDaily = precomputeDaily(dailyCandles, [...new Set(DAILY_SMA_VALS)]);
      const idxDailyAt: number[] = new Array(h4.length).fill(-1); let j = 0;
      for (let i = 0; i < h4.length; i++) { while (j < dailyCandles.length && dailyCandles[j].timestamp <= h4[i].timestamp) j++; idxDailyAt[i] = j - 1; }
      candleMap[pair] = { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd: Math.floor(h4.length * TRAIN_FRAC) };
      console.log(`${dailyCandles.length} daily.`); await sleep(1000);
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
  const byAdx = new Map<number, TrainResult[]>();
  for (const r of phase1) { if (!byAdx.has(r.params.dailyAdxMin)) byAdx.set(r.params.dailyAdxMin, []); byAdx.get(r.params.dailyAdxMin)!.push(r); }
  const phase1Winners: TrainResult[] = [];
  for (const [adx, results] of byAdx) {
    results.sort((a, b) => b.trainReturn - a.trainReturn);
    const w = results[0]; phase1Winners.push(w);
    console.log(`  ADX=${adx} best: sma=${w.params.dailySmaPeriod} STC(${w.params.stcFast},${w.params.stcSlow},c=${w.params.stcCycle},thr=${w.params.stcThreshold}) | train: ${w.trainReturn.toFixed(2)}%`);
  }

  console.log(`\nPhase 2: testing ${phase1Winners.length} ADX winners × ${p2Count} stop/rr/stag combos...`);
  const allPhase2: TrainResult[] = [];
  for (const { params: best1 } of phase1Winners)
    for (const stopAtrMult of STOP_ATR_VALS)
      for (const rrRatio of RR_VALS)
        for (const stagnationH of STAG_VALS) {
          const params: Params = { ...best1, stopAtrMult, rrRatio, stagnationH };
          let total = 0;
          for (const pair of pairs) { const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair]; total += runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, 80, trainEnd).totalReturn; }
          allPhase2.push({ params, trainReturn: total / pairs.length });
        }

  const top10 = allPhase2.sort((a, b) => b.trainReturn - a.trainReturn).slice(0, 10);
  console.log(`\nEvaluating top-10 on TEST set...`);
  const results: WalkForwardResult[] = [];
  for (const { params, trainReturn } of top10) {
    let testRet = 0, testTrades = 0, testWins = 0, testDD = 0, tDays = 0; const allPnls: number[] = [];
    for (const pair of pairs) {
      const { h4, pre4h, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, pre4h, dailyCandles, preDaily, idxDailyAt, params, trainEnd);
      testRet += r.totalReturn; testTrades += r.trades; testWins += r.wins; testDD = Math.max(testDD, r.maxDrawdown); allPnls.push(...r.tradePnlPcts); tDays = Math.max(tDays, r.days);
    }
    results.push({ params, trainReturn, testReturn: testRet / pairs.length, testDays: tDays, profitPerDay: tDays > 0 ? (testRet / pairs.length) / tDays : 0, testTrades, testWinRate: testTrades > 0 ? (testWins / testTrades) * 100 : 0, testMaxDrawdown: testDD, testSharpe: sharpe(allPnls) });
  }
  results.sort((a, b) => (b.profitPerDay / (b.testMaxDrawdown || 1)) - (a.profitPerDay / (a.testMaxDrawdown || 1)));
  console.log("\n=== RESULTS ===\n");
  console.log("Rk  %/day   TestRet  Trades  WR    MaxDD   Calmar  Sharpe  Params");
  console.log("-".repeat(120));
  results.forEach((r, idx) => {
    const calmar = r.profitPerDay / (r.testMaxDrawdown || 1);
    console.log(`${String(idx + 1).padStart(2)}  ${r.profitPerDay >= 0 ? "+" : ""}${r.profitPerDay.toFixed(3)}  ${r.testReturn >= 0 ? "+" : ""}${r.testReturn.toFixed(2)}%  ${String(r.testTrades).padStart(6)}  ${r.testWinRate.toFixed(0)}%  ${r.testMaxDrawdown.toFixed(1)}%  ${calmar.toFixed(2)}   ${r.testSharpe.toFixed(2)}   sma=${r.params.dailySmaPeriod} adx=${r.params.dailyAdxMin} STC(${r.params.stcFast},${r.params.stcSlow},c=${r.params.stcCycle},thr=${r.params.stcThreshold}) stop=${r.params.stopAtrMult} rr=${r.params.rrRatio} stag=${r.params.stagnationH * 4}h`);
  });
  const best = results[0];
  console.log(`\nBest: ${best.profitPerDay >= 0 ? "+" : ""}${best.profitPerDay.toFixed(4)}%/day MaxDD ${best.testMaxDrawdown.toFixed(1)}% Calmar ${(best.profitPerDay / (best.testMaxDrawdown || 1)).toFixed(2)} Sharpe ${best.testSharpe.toFixed(2)} trades ${best.testTrades}`);
  console.log(best.profitPerDay >= 0.30 ? "VIABLE" : "NOT VIABLE");
}
main().catch(console.error);
