// Grid search tuner for all 9 remaining quant engines.
// Uses exact same backtest logic as backtest-engines.ts.
// 2-phase: Phase 1 sweeps signal params, Phase 2 sweeps risk params.
// Run: npx tsx scripts/tune-grid-all.ts [engine-name|all]

import { ATR, ADX, MACD, EMA, PSAR } from "technicalindicators";
import * as fs from "node:fs";

// ─── Backtest constants ────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.0009;
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV;

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ARB", "BNB", "OP", "SUI", "INJ", "ATOM", "APT", "WIF", "kPEPE", "kBONK", "kFLOKI", "kSHIB", "NEAR", "RUNE", "FET", "LDO", "CRV", "HBAR", "LTC", "TIA", "SEI", "JUP", "PYTH", "TAO", "ADA", "DOT"];
const DAYS_4H = 730;
const DAYS_DAILY = 750;
const TRAIN_BARS = 2935; // ~67% of 4381 bars (~490 days train, ~124d OOS test)

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestResult {
  trades: number;
  wins: number;
  totalReturn: number;
  maxDrawdown: number;
  tradePnlPcts: number[];
  days: number;
}

interface DailyPre {
  smaMap: Map<number, (number | null)[]>;
  adx: (number | null)[];
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCandlesOnce(coin: string, interval: string, days: number): Promise<Candle[]> {
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

async function fetchCandles(coin: string, interval: string, days: number): Promise<Candle[]> {
  try {
    return await fetchCandlesOnce(coin, interval, days);
  } catch {
    await sleep(1000);
    return await fetchCandlesOnce(coin, interval, days);
  }
}

// ─── Daily precomputation ─────────────────────────────────────────────────────

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPre {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });
  const smaMap = new Map<number, (number | null)[]>();
  for (const period of smaPeriods) {
    const arr: (number | null)[] = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let sum = 0;
      for (let k = i - period + 1; k <= i; k++) sum += closes[k];
      arr[i] = sum / period;
    }
    smaMap.set(period, arr);
  }
  return { smaMap, adx: adxArr };
}

function buildDailyIndex(h4: Candle[], daily: Candle[]): number[] {
  const idxDailyAt: number[] = new Array(h4.length).fill(-1);
  let j = 0;
  for (let i = 0; i < h4.length; i++) {
    while (j < daily.length && daily[j].timestamp <= h4[i].timestamp) j++;
    idxDailyAt[i] = j - 1;
  }
  return idxDailyAt;
}

function precomputeATR(candles: Candle[]): (number | null)[] {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const arr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { arr[n - atrRaw.length + i] = v; });
  return arr;
}

// ─── Indicator computation functions ──────────────────────────────────────────

function computeZLEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const lagOffset = Math.floor((period - 1) / 2);
  const corrected: number[] = [];
  for (let i = lagOffset; i < n; i++) corrected.push(closes[i] + (closes[i] - closes[i - lagOffset]));
  const emaValues = EMA.calculate({ values: corrected, period });
  const result: (number | null)[] = new Array(n).fill(null);
  const emaStartOrigIdx = lagOffset + (period - 1);
  for (let i = 0; i < emaValues.length; i++) {
    const origIdx = emaStartOrigIdx + i;
    if (origIdx < n) result[origIdx] = emaValues[i];
  }
  return result;
}

function computeTRIX(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const ema1 = EMA.calculate({ values: closes, period });
  const ema2 = EMA.calculate({ values: ema1, period });
  const ema3 = EMA.calculate({ values: ema2, period });
  const ema3StartIdx = (period - 1) * 3;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < ema3.length; i++) {
    const origIdx = ema3StartIdx + i;
    if (origIdx < n && ema3[i - 1] !== 0) result[origIdx] = ((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 100;
  }
  return result;
}

function computeTRIXSignal(trixValues: (number | null)[], signalPeriod: number): (number | null)[] {
  const n = trixValues.length;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = signalPeriod - 1; i < n; i++) {
    const slice = trixValues.slice(i - signalPeriod + 1, i + 1);
    const valid = slice.filter((v): v is number => v !== null);
    if (valid.length === signalPeriod) result[i] = valid.reduce((s, v) => s + v, 0) / signalPeriod;
  }
  return result;
}

function precomputeVortex(candles: Candle[], period: number): { vPlus: (number | null)[]; vMinus: (number | null)[] } {
  const n = candles.length;
  const vPlus: (number | null)[] = new Array(n).fill(null);
  const vMinus: (number | null)[] = new Array(n).fill(null);
  for (let endIdx = period; endIdx < n; endIdx++) {
    let vmPlus = 0, vmMinus = 0, trSum = 0;
    for (let i = endIdx - period + 1; i <= endIdx; i++) {
      if (i <= 0) { vmPlus = 0; vmMinus = 0; trSum = 0; break; }
      const prevHigh = candles[i - 1].high, prevLow = candles[i - 1].low, prevClose = candles[i - 1].close;
      vmPlus += Math.abs(candles[i].high - prevLow);
      vmMinus += Math.abs(candles[i].low - prevHigh);
      const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prevClose), Math.abs(candles[i].low - prevClose));
      trSum += tr;
    }
    if (trSum > 0) { vPlus[endIdx] = vmPlus / trSum; vMinus[endIdx] = vmMinus / trSum; }
  }
  return { vPlus, vMinus };
}

function computeLocalEma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(ema);
  for (let i = period; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); result.push(ema); }
  return result;
}

function computeStcFull(closes: number[], fast: number, slow: number, cycle: number): number[] {
  if (closes.length < slow + cycle * 2) return [];
  const fastEma = computeLocalEma(closes, fast);
  const slowEma = computeLocalEma(closes, slow);
  const offset = fastEma.length - slowEma.length;
  const macdLine = slowEma.map((v, i) => fastEma[offset + i] - v);
  if (macdLine.length < cycle) return [];
  const stoch1: number[] = [];
  for (let i = cycle - 1; i < macdLine.length; i++) {
    const window = macdLine.slice(i - cycle + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window), range = hi - lo;
    stoch1.push(range === 0 ? 50 : ((macdLine[i] - lo) / range) * 100);
  }
  if (stoch1.length === 0) return [];
  const smoothed1 = computeLocalEma(stoch1, cycle);
  if (smoothed1.length < cycle) return [];
  const stoch2: number[] = [];
  for (let i = cycle - 1; i < smoothed1.length; i++) {
    const window = smoothed1.slice(i - cycle + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window), range = hi - lo;
    stoch2.push(range === 0 ? 50 : ((smoothed1[i] - lo) / range) * 100);
  }
  if (stoch2.length === 0) return [];
  return computeLocalEma(stoch2, cycle).map((v) => Math.min(100, Math.max(0, v)));
}

function mapStcToOriginal(closes: number[], fast: number, slow: number, cycle: number): (number | null)[] {
  const n = closes.length;
  const result: (number | null)[] = new Array(n).fill(null);
  const stcRaw = computeStcFull(closes, fast, slow, cycle);
  if (stcRaw.length === 0) return result;
  for (let i = 0; i < stcRaw.length; i++) {
    const origIdx = n - stcRaw.length + i;
    if (origIdx >= 0) result[origIdx] = stcRaw[i];
  }
  return result;
}

function computeDEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const ema1Raw = EMA.calculate({ values: closes, period });
  const ema2Raw = EMA.calculate({ values: ema1Raw, period });
  const result: (number | null)[] = new Array(n).fill(null);
  ema2Raw.forEach((e2, i) => {
    const e1Idx = i + (period - 1);
    const closesIdx = e1Idx + (period - 1);
    if (closesIdx < n) result[closesIdx] = 2 * ema1Raw[e1Idx] - e2;
  });
  return result;
}

function computeWMA(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const result: (number | null)[] = new Array(n).fill(null);
  const weightSum = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - period + 1 + j] * (j + 1);
    result[i] = sum / weightSum;
  }
  return result;
}

function computeHMA(closes: number[], period: number): (number | null)[] {
  const halfPeriod = Math.max(2, Math.floor(period / 2));
  const sqrtPeriod = Math.max(2, Math.round(Math.sqrt(period)));
  const wmaHalf = computeWMA(closes, halfPeriod);
  const wmaFull = computeWMA(closes, period);
  const diffStartIdx = period - 1;
  const diff: number[] = [];
  for (let i = diffStartIdx; i < closes.length; i++) {
    const h = wmaHalf[i], f = wmaFull[i];
    diff.push(h === null || f === null ? 0 : 2 * h - f);
  }
  const hmaOnDiff = computeWMA(diff, sqrtPeriod);
  const result: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < hmaOnDiff.length; i++) {
    const origIdx = diffStartIdx + i;
    if (origIdx < closes.length) result[origIdx] = hmaOnDiff[i];
  }
  return result;
}

function precomputeCCI(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let endIdx = period - 1; endIdx < n; endIdx++) {
    const slice = candles.slice(endIdx - period + 1, endIdx + 1);
    const tps = slice.map((c) => (c.high + c.low + c.close) / 3);
    const smaTp = tps.reduce((s, v) => s + v, 0) / period;
    const meanDev = tps.reduce((s, v) => s + Math.abs(v - smaTp), 0) / period;
    result[endIdx] = meanDev === 0 ? 0 : (tps[tps.length - 1] - smaTp) / (0.015 * meanDev);
  }
  return result;
}

function precomputePSAR(candles: Candle[], step: number, max: number): (number | null)[] {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const psarRaw = PSAR.calculate({ high: highs, low: lows, step, max });
  const result: (number | null)[] = new Array(n).fill(null);
  const startIdx = n - psarRaw.length;
  for (let i = 0; i < psarRaw.length; i++) result[startIdx + i] = psarRaw[i];
  return result;
}

function precomputeElderIndicators(candles: Candle[], emaPeriod: number, macdFast: number, macdSlow: number, macdSignal: number): { ema: (number | null)[]; histogram: (number | null)[] } {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const emaRaw = EMA.calculate({ values: closes, period: emaPeriod });
  const emaStartIdx = n - emaRaw.length;
  const ema: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < emaRaw.length; i++) ema[emaStartIdx + i] = emaRaw[i];
  const macdRaw = MACD.calculate({ values: closes, fastPeriod: macdFast, slowPeriod: macdSlow, signalPeriod: macdSignal, SimpleMAOscillator: false, SimpleMASignal: false });
  const macdStartIdx = n - macdRaw.length;
  const histogram: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < macdRaw.length; i++) histogram[macdStartIdx + i] = macdRaw[i].histogram ?? null;
  return { ema, histogram };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function sharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}

interface EngineRunParams {
  smaPeriod: number;
  adxMin: number;
  adxNotDecl: boolean;
  reverseExit: boolean; // if true, exit when indicator fires opposite direction
  trailActivation: number; // % peak gain needed to activate trailing stop
  trailDistance: number;   // % below peak to trigger exit
  stopAtrMult: number;
  rewardRisk: number;
  stagnationBars: number;
  checkSignal: (i: number) => "long" | "short" | null;
}

interface PairData {
  h4: Candle[];
  atr4h: (number | null)[];
  dailyCandles: Candle[];
  trainEnd: number;
}

function runBacktestEngine(
  pairData: PairData,
  preDaily: DailyPre,
  idxDailyAt: number[],
  params: EngineRunParams,
  startIdx: number,
  endIdx: number,
): BacktestResult {
  const { h4, atr4h } = pairData;

  let pnlTotal = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peakPnlPct: number };
  let pos: Pos | null = null;

  for (let i = startIdx; i < endIdx; i++) {
    const c = h4[i];
    if (pos !== null) {
      const pricePct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
      const unrealizedPct = pricePct * LEV * 100;
      pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);
      const trailingHit = pos.peakPnlPct > params.trailActivation && unrealizedPct <= pos.peakPnlPct - params.trailDistance;
      const stagHit = (i - pos.entryIdx) >= params.stagnationBars;
      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
      let exitPrice: number | null = null;
      if (trailingHit) exitPrice = c.close;
      else if (stagHit) exitPrice = c.close;
      else if (slHit && tpHit) exitPrice = pos.sl;
      else if (slHit) exitPrice = pos.sl;
      else if (tpHit) exitPrice = pos.tp;
      else if (params.reverseExit) {
        const rev = params.checkSignal(i);
        if ((pos.dir === "long" && rev === "short") || (pos.dir === "short" && rev === "long")) exitPrice = c.close;
      }
      if (exitPrice !== null) {
        const pp = ((exitPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
        const grossPnl = pp * NOTIONAL;
        const fees = NOTIONAL * FEE_RATE;
        const net = grossPnl - fees;
        pnlTotal += net;
        peakPnl = Math.max(peakPnl, pnlTotal);
        maxDrawdown = Math.max(maxDrawdown, peakPnl - pnlTotal);
        trades++;
        if (net > 0) wins++;
        tradePnlPcts.push((net / MARGIN_PER_TRADE) * 100);
        pos = null;
      }
    }
    if (pos === null && i + 1 < endIdx) {
      const dIdx = idxDailyAt[i];
      if (dIdx < 0) continue;
      const dailySma = preDaily.smaMap.get(params.smaPeriod)?.[dIdx] ?? null;
      const dailyAdx = preDaily.adx[dIdx];
      const dailyClose = pairData.dailyCandles[dIdx].close;
      if (dailySma === null || dailyAdx === null) continue;
      if (dailyAdx < params.adxMin) continue;
      if (params.adxNotDecl && dIdx >= 2) {
        const adxPrev2 = preDaily.adx[dIdx - 2];
        if (adxPrev2 !== null && dailyAdx < adxPrev2) continue;
      }
      const dailyUptrend = dailyClose > dailySma;
      const dailyDowntrend = dailyClose < dailySma;
      const rawSignal = params.checkSignal(i);
      if (rawSignal === null) continue;
      let dir: "long" | "short" | null = null;
      if (rawSignal === "long" && dailyUptrend) dir = "long";
      if (rawSignal === "short" && dailyDowntrend) dir = "short";
      if (dir !== null) {
        const entryPrice = h4[i + 1].open;
        const atr = atr4h[i] ?? c.close * 0.02;
        const stopDist = atr * params.stopAtrMult;
        const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
        const tp = dir === "long" ? entryPrice + stopDist * params.rewardRisk : entryPrice - stopDist * params.rewardRisk;
        pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peakPnlPct: 0 };
      }
    }
  }

  const startTs = h4[startIdx]?.timestamp ?? 0;
  const endTs = h4[endIdx - 1]?.timestamp ?? 0;
  return { trades, wins, totalReturn: pnlTotal, maxDrawdown, tradePnlPcts, days: (endTs - startTs) / 86400_000 };
}

interface RunAllResult {
  sharpe: number;
  pctPerDay: number;
  trades: number;
  totalPnl: number;
  days: number;
}

function runAllPairs(
  allPairData: Record<string, { pairData: PairData; preDaily: DailyPre; idxDailyAt: number[] }>,
  params: EngineRunParams,
  window: "train" | "test",
): RunAllResult {
  let totalPnl = 0;
  let maxDays = 0;
  let totalTrades = 0;
  const allPnlPcts: number[] = [];
  const pairs = Object.keys(allPairData);

  for (const pair of pairs) {
    const { pairData, preDaily, idxDailyAt } = allPairData[pair];
    const startIdx = window === "train" ? 0 : pairData.trainEnd;
    const endIdx = window === "train" ? pairData.trainEnd : pairData.h4.length;
    const r = runBacktestEngine(pairData, preDaily, idxDailyAt, params, startIdx, endIdx);
    totalPnl += r.totalReturn;
    totalTrades += r.trades;
    maxDays = Math.max(maxDays, r.days);
    allPnlPcts.push(...r.tradePnlPcts);
  }

  const pctPerDay = maxDays > 0 ? (totalPnl / (MARGIN_PER_TRADE * pairs.length)) / maxDays * 100 : 0;
  return { sharpe: sharpe(allPnlPcts), pctPerDay, trades: totalTrades, totalPnl, days: maxDays };
}

// ─── Grid search helpers ───────────────────────────────────────────────────────

type ComboResult = { params: Record<string, number>; sharpe: number; pctPerDay: number; trades: number };

function cartesian(obj: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(obj);
  const results: Record<string, number>[] = [{}];
  for (const key of keys) {
    const vals = obj[key];
    const expanded: Record<string, number>[] = [];
    for (const combo of results) {
      for (const v of vals) expanded.push({ ...combo, [key]: v });
    }
    results.length = 0;
    results.push(...expanded);
  }
  return results;
}

function topN(results: ComboResult[], n: number, minTrades: number): ComboResult[] {
  return results
    .filter((r) => r.trades >= minTrades)
    .sort((a, b) => b.sharpe - a.sharpe)
    .slice(0, n);
}

// Scores by min(sharpe_half1, sharpe_half2) -- rewards consistency across regimes.
function computeMinFoldScore(
  pairs: string[],
  allPairData: Record<string, { pairData: PairData; preDaily: DailyPre; idxDailyAt: number[] }>,
  tuner: EngineTuner,
  p: Record<string, number>,
  smaPeriodKey: string,
  adxMinKey: string,
  stopAtrKey: string,
  rrKey: string,
  stagKey: string,
): { minSharpe: number; pctPerDay: number; trades: number } {
  const fold1Pnls: number[] = [];
  const fold2Pnls: number[] = [];
  let totalPnl = 0;
  let totalDays = 0;
  let totalTrades = 0;
  for (const pair of pairs) {
    const { pairData, preDaily, idxDailyAt } = allPairData[pair];
    const checkSignal = tuner.buildCheckSignal(pairData.h4, p);
    const trainHalf = Math.floor(pairData.trainEnd / 2);
    const adxNotDeclKey = Object.keys(p).find((k) => k.endsWith("_ADX_NOT_DECL"));
    const reverseExitKey = Object.keys(p).find((k) => k.endsWith("_REVERSE_EXIT"));
    const trailActKey = Object.keys(p).find((k) => k.endsWith("_TRAIL_ACTIVATION"));
    const trailDistKey = Object.keys(p).find((k) => k.endsWith("_TRAIL_DISTANCE"));
    const ep = {
      smaPeriod: p[smaPeriodKey] ?? 100,
      adxMin: p[adxMinKey] ?? 18,
      adxNotDecl: adxNotDeclKey !== undefined ? p[adxNotDeclKey] === 1 : false,
      reverseExit: reverseExitKey !== undefined ? p[reverseExitKey] === 1 : false,
      trailActivation: trailActKey !== undefined ? p[trailActKey] : 5,
      trailDistance: trailDistKey !== undefined ? p[trailDistKey] : 2,
      stopAtrMult: p[stopAtrKey] ?? 3.0,
      rewardRisk: p[rrKey] ?? 5.0,
      stagnationBars: p[stagKey] ?? 12,
      checkSignal,
    };
    const r1 = runBacktestEngine(pairData, preDaily, idxDailyAt, ep, 0, trainHalf);
    const r2 = runBacktestEngine(pairData, preDaily, idxDailyAt, ep, trainHalf, pairData.trainEnd);
    fold1Pnls.push(...r1.tradePnlPcts);
    fold2Pnls.push(...r2.tradePnlPcts);
    totalPnl += r1.totalReturn + r2.totalReturn;
    totalDays = Math.max(totalDays, r1.days + r2.days);
    totalTrades += r1.trades + r2.trades;
  }
  const s1 = sharpe(fold1Pnls);
  const s2 = sharpe(fold2Pnls);
  const pctPerDay = totalDays > 0 ? (totalPnl / (MARGIN_PER_TRADE * pairs.length)) / totalDays * 100 : 0;
  return { minSharpe: Math.min(s1, s2), pctPerDay, trades: totalTrades };
}

// ─── Engine tuner definitions ──────────────────────────────────────────────────

interface EngineTuner {
  name: string;
  currentParams: Record<string, number>;
  phase1Grid: Record<string, number[]>; // signal params
  phase2Grid: Record<string, number[]>; // risk params (smaPeriod, adxMin, stopAtrMult, rewardRisk, stagnation)
  buildCheckSignal: (candles: Candle[], params: Record<string, number>) => (i: number) => "long" | "short" | null;
}

const ENGINE_TUNERS: EngineTuner[] = [
  // ─── CCI ──────────────────────────────────────────────────────────────────
  {
    name: "cci",
    currentParams: { CCI_PERIOD: 10, CCI_THRESHOLD: 120, CCI_DAILY_SMA_PERIOD: 50, CCI_DAILY_ADX_MIN: 10, CCI_STOP_ATR_MULT: 3.0, CCI_REWARD_RISK: 5.0, CCI_STAGNATION_BARS: 12 },
    phase1Grid: {
      CCI_PERIOD: [8, 10, 12, 14],
      CCI_THRESHOLD: [100, 110, 120, 130, 140],
    },
    phase2Grid: {
      CCI_DAILY_SMA_PERIOD: [50, 75, 100],
      CCI_DAILY_ADX_MIN: [8, 10, 14],
      CCI_ADX_NOT_DECL: [0, 1],
      CCI_REVERSE_EXIT: [0, 1],
      CCI_TRAIL_ACTIVATION: [3, 5, 8],
      CCI_TRAIL_DISTANCE: [1, 2, 3],
      CCI_STOP_ATR_MULT: [2.5, 3.0, 3.5],
      CCI_REWARD_RISK: [4.0, 5.0, 6.0],
      CCI_STAGNATION_BARS: [10, 12, 16],
    },
    buildCheckSignal(candles, params) {
      const cciValues = precomputeCCI(candles, params.CCI_PERIOD);
      const threshold = params.CCI_THRESHOLD;
      return (i) => {
        const curr = cciValues[i], prev = cciValues[i - 1];
        if (curr === null || prev === null) return null;
        if (prev <= threshold && curr > threshold) return "long";
        if (prev >= -threshold && curr < -threshold) return "short";
        return null;
      };
    },
  },
  // ─── Elder ────────────────────────────────────────────────────────────────
  {
    name: "elder",
    currentParams: { ELDER_EMA_PERIOD: 21, ELDER_MACD_FAST: 12, ELDER_MACD_SLOW: 26, ELDER_MACD_SIGNAL: 9, ELDER_DAILY_SMA_PERIOD: 50, ELDER_DAILY_ADX_MIN: 10, ELDER_STOP_ATR_MULT: 2.5, ELDER_REWARD_RISK: 2.5, ELDER_STAGNATION_BARS: 12 },
    phase1Grid: {
      ELDER_EMA_PERIOD: [13, 17, 21, 26],
      ELDER_MACD_FAST: [8, 12, 16],
      ELDER_MACD_SLOW: [21, 26, 30],
      ELDER_MACD_SIGNAL: [7, 9, 12],
    },
    phase2Grid: {
      ELDER_DAILY_SMA_PERIOD: [50, 75, 100],
      ELDER_DAILY_ADX_MIN: [8, 10, 14],
      ELDER_ADX_NOT_DECL: [0, 1],
      ELDER_REVERSE_EXIT: [0, 1],
      ELDER_TRAIL_ACTIVATION: [3, 5, 8],
      ELDER_TRAIL_DISTANCE: [1, 2, 3],
      ELDER_STOP_ATR_MULT: [2.0, 2.5, 3.0, 3.5],
      ELDER_REWARD_RISK: [2.5, 3.5, 5.0],
      ELDER_STAGNATION_BARS: [8, 12, 16],
    },
    buildCheckSignal(candles, params) {
      const { ema: elderEma, histogram: elderHistogram } = precomputeElderIndicators(candles, params.ELDER_EMA_PERIOD, params.ELDER_MACD_FAST, params.ELDER_MACD_SLOW, params.ELDER_MACD_SIGNAL);
      return (i) => {
        if (i < 3) return null;
        const cE = elderEma[i], pE = elderEma[i - 1], ppE = elderEma[i - 2];
        const cH = elderHistogram[i], pH = elderHistogram[i - 1], ppH = elderHistogram[i - 2];
        if (cE == null || pE == null || ppE == null) return null;
        if (cH == null || pH == null || ppH == null) return null;
        const currBarGreen = cE > pE && cH > pH;
        const prevBarGreen = pE > ppE && pH > ppH;
        const currBarRed = cE < pE && cH < pH;
        const prevBarRed = pE < ppE && pH < ppH;
        if (currBarGreen && !prevBarGreen) return "long";
        if (currBarRed && !prevBarRed) return "short";
        return null;
      };
    },
  },
  // ─── ZLEMA ────────────────────────────────────────────────────────────────
  {
    name: "zlema",
    currentParams: { ZLEMA_FAST: 10, ZLEMA_SLOW: 34, ZLEMA_DAILY_SMA_PERIOD: 100, ZLEMA_DAILY_ADX_MIN: 18, ZLEMA_STOP_ATR_MULT: 3.0, ZLEMA_REWARD_RISK: 4.0, ZLEMA_STAGNATION_BARS: 6 },
    phase1Grid: {
      ZLEMA_FAST: [6, 8, 10, 12, 16],
      ZLEMA_SLOW: [20, 26, 30, 34, 40, 50],
    },
    phase2Grid: {
      ZLEMA_DAILY_SMA_PERIOD: [50, 75, 100],
      ZLEMA_DAILY_ADX_MIN: [10, 14, 18, 22, 26],
      ZLEMA_ADX_NOT_DECL: [0, 1],
      ZLEMA_REVERSE_EXIT: [0, 1],
      ZLEMA_TRAIL_ACTIVATION: [3, 5, 8],
      ZLEMA_TRAIL_DISTANCE: [1, 2, 3],
      ZLEMA_STOP_ATR_MULT: [2.5, 3.0, 3.5, 4.0],
      ZLEMA_REWARD_RISK: [3.0, 4.0, 5.0],
      ZLEMA_STAGNATION_BARS: [4, 6, 8, 10],
    },
    buildCheckSignal(candles, params) {
      const closes = candles.map((c) => c.close);
      const zlemaFast = computeZLEMA(closes, params.ZLEMA_FAST);
      const zlemaSlow = computeZLEMA(closes, params.ZLEMA_SLOW);
      return (i) => {
        const cf = zlemaFast[i], pf = zlemaFast[i - 1];
        const cs = zlemaSlow[i], ps = zlemaSlow[i - 1];
        if (cf === null || pf === null || cs === null || ps === null) return null;
        if (pf <= ps && cf > cs) return "long";
        if (pf >= ps && cf < cs) return "short";
        return null;
      };
    },
  },
  // ─── Vortex ───────────────────────────────────────────────────────────────
  {
    name: "vortex",
    currentParams: { VORTEX_VORTEX_PERIOD: 14, VORTEX_DAILY_SMA_PERIOD: 100, VORTEX_DAILY_ADX_MIN: 22, VORTEX_STOP_ATR_MULT: 4.0, VORTEX_REWARD_RISK: 5.0, VORTEX_STAGNATION_BARS: 12 },
    phase1Grid: {
      VORTEX_VORTEX_PERIOD: [7, 10, 14, 18, 21, 25],
    },
    phase2Grid: {
      VORTEX_DAILY_SMA_PERIOD: [50, 75, 100],
      VORTEX_DAILY_ADX_MIN: [14, 18, 22, 26, 30],
      VORTEX_ADX_NOT_DECL: [0, 1],
      VORTEX_REVERSE_EXIT: [0, 1],
      VORTEX_TRAIL_ACTIVATION: [3, 5, 8],
      VORTEX_TRAIL_DISTANCE: [1, 2, 3],
      VORTEX_STOP_ATR_MULT: [3.0, 3.5, 4.0, 5.0],
      VORTEX_REWARD_RISK: [4.0, 5.0, 6.0],
      VORTEX_STAGNATION_BARS: [8, 10, 12, 16],
    },
    buildCheckSignal(candles, params) {
      const { vPlus: vortexPlus, vMinus: vortexMinus } = precomputeVortex(candles, params.VORTEX_VORTEX_PERIOD);
      return (i) => {
        const cvp = vortexPlus[i], pvp = vortexPlus[i - 1];
        const cvm = vortexMinus[i], pvm = vortexMinus[i - 1];
        if (cvp === null || pvp === null || cvm === null || pvm === null) return null;
        if (pvp <= pvm && cvp > cvm) return "long";
        if (pvm <= pvp && cvm > cvp) return "short";
        return null;
      };
    },
  },
  // ─── Schaff ───────────────────────────────────────────────────────────────
  {
    name: "schaff",
    currentParams: { SCHAFF_STC_FAST: 8, SCHAFF_STC_SLOW: 26, SCHAFF_STC_CYCLE: 10, SCHAFF_STC_THRESHOLD: 25, SCHAFF_DAILY_SMA_PERIOD: 100, SCHAFF_DAILY_ADX_MIN: 18, SCHAFF_STOP_ATR_MULT: 2.5, SCHAFF_REWARD_RISK: 5.0, SCHAFF_STAGNATION_BARS: 9 },
    phase1Grid: {
      SCHAFF_STC_FAST: [6, 8, 10, 12],
      SCHAFF_STC_SLOW: [20, 23, 26, 30],
      SCHAFF_STC_CYCLE: [8, 10, 12],
      SCHAFF_STC_THRESHOLD: [20, 25, 30],
    },
    phase2Grid: {
      SCHAFF_DAILY_SMA_PERIOD: [50, 75, 100],
      SCHAFF_DAILY_ADX_MIN: [10, 14, 18, 22],
      SCHAFF_ADX_NOT_DECL: [0, 1],
      SCHAFF_REVERSE_EXIT: [0, 1],
      SCHAFF_TRAIL_ACTIVATION: [3, 5, 8],
      SCHAFF_TRAIL_DISTANCE: [1, 2, 3],
      SCHAFF_STOP_ATR_MULT: [2.0, 2.5, 3.0, 3.5],
      SCHAFF_REWARD_RISK: [4.0, 5.0, 6.0],
      SCHAFF_STAGNATION_BARS: [6, 9, 12],
    },
    buildCheckSignal(candles, params) {
      const closes = candles.map((c) => c.close);
      const stcValues = mapStcToOriginal(closes, params.SCHAFF_STC_FAST, params.SCHAFF_STC_SLOW, params.SCHAFF_STC_CYCLE);
      const threshold = params.SCHAFF_STC_THRESHOLD;
      return (i) => {
        const curr = stcValues[i], prev = stcValues[i - 1];
        if (curr === null || prev === null) return null;
        if (prev <= threshold && curr > threshold) return "long";
        if (prev >= (100 - threshold) && curr < (100 - threshold)) return "short";
        return null;
      };
    },
  },
  // ─── PSAR ─────────────────────────────────────────────────────────────────
  {
    name: "psar",
    currentParams: { PSAR_STEP: 0.03, PSAR_MAX: 0.1, PSAR_DAILY_SMA_PERIOD: 100, PSAR_DAILY_ADX_MIN: 18, PSAR_STOP_ATR_MULT: 4.0, PSAR_REWARD_RISK: 5.0, PSAR_STAGNATION_BARS: 12 },
    phase1Grid: {
      PSAR_STEP: [0.01, 0.02, 0.025, 0.03, 0.04],
      PSAR_MAX: [0.08, 0.1, 0.15, 0.2],
    },
    phase2Grid: {
      PSAR_DAILY_SMA_PERIOD: [50, 75, 100],
      PSAR_DAILY_ADX_MIN: [10, 14, 18, 22, 26],
      PSAR_ADX_NOT_DECL: [0, 1],
      PSAR_REVERSE_EXIT: [0, 1],
      PSAR_TRAIL_ACTIVATION: [3, 5, 8],
      PSAR_TRAIL_DISTANCE: [1, 2, 3],
      PSAR_STOP_ATR_MULT: [3.0, 3.5, 4.0, 5.0],
      PSAR_REWARD_RISK: [4.0, 5.0, 6.0],
      PSAR_STAGNATION_BARS: [8, 10, 12, 16],
    },
    buildCheckSignal(candles, params) {
      const psarValues = precomputePSAR(candles, params.PSAR_STEP, params.PSAR_MAX);
      return (i) => {
        const currSar = psarValues[i], prevSar = psarValues[i - 1];
        if (currSar === null || prevSar === null) return null;
        const currClose = candles[i].close, prevClose = candles[i - 1].close;
        if (prevSar > prevClose && currSar < currClose) return "long";
        if (prevSar < prevClose && currSar > currClose) return "short";
        return null;
      };
    },
  },
  // ─── HMA ──────────────────────────────────────────────────────────────────
  {
    name: "hma",
    currentParams: { HMA_FAST: 8, HMA_SLOW: 34, HMA_DAILY_SMA_PERIOD: 100, HMA_DAILY_ADX_MIN: 10, HMA_STOP_ATR_MULT: 3.0, HMA_REWARD_RISK: 5.0, HMA_STAGNATION_BARS: 6 },
    phase1Grid: {
      HMA_FAST: [6, 8, 10, 12],
      HMA_SLOW: [26, 30, 34, 40],
    },
    phase2Grid: {
      HMA_DAILY_SMA_PERIOD: [50, 75, 100],
      HMA_DAILY_ADX_MIN: [8, 10, 14, 18],
      HMA_ADX_NOT_DECL: [0, 1],
      HMA_REVERSE_EXIT: [0, 1],
      HMA_TRAIL_ACTIVATION: [3, 5, 8],
      HMA_TRAIL_DISTANCE: [1, 2, 3],
      HMA_STOP_ATR_MULT: [2.5, 3.0, 3.5, 4.0],
      HMA_REWARD_RISK: [4.0, 5.0, 6.0],
      HMA_STAGNATION_BARS: [4, 6, 8, 10],
    },
    buildCheckSignal(candles, params) {
      const closes = candles.map((c) => c.close);
      const hmaFast = computeHMA(closes, params.HMA_FAST);
      const hmaSlow = computeHMA(closes, params.HMA_SLOW);
      return (i) => {
        const cf = hmaFast[i], pf = hmaFast[i - 1];
        const cs = hmaSlow[i], ps = hmaSlow[i - 1];
        if (cf === null || pf === null || cs === null || ps === null) return null;
        if (pf <= ps && cf > cs) return "long";
        if (pf >= ps && cf < cs) return "short";
        return null;
      };
    },
  },
  // ─── TRIX ─────────────────────────────────────────────────────────────────
  {
    name: "trix",
    currentParams: { TRIX_PERIOD: 5, TRIX_SIGNAL: 12, TRIX_DAILY_SMA_PERIOD: 100, TRIX_DAILY_ADX_MIN: 18, TRIX_STOP_ATR_MULT: 2.5, TRIX_REWARD_RISK: 5.0, TRIX_STAGNATION_BARS: 16 },
    phase1Grid: {
      TRIX_PERIOD: [3, 5, 7, 9],
      TRIX_SIGNAL: [8, 10, 12, 15],
    },
    phase2Grid: {
      TRIX_DAILY_SMA_PERIOD: [50, 75, 100],
      TRIX_DAILY_ADX_MIN: [10, 14, 18, 22],
      TRIX_ADX_NOT_DECL: [0, 1],
      TRIX_REVERSE_EXIT: [0, 1],
      TRIX_TRAIL_ACTIVATION: [3, 5, 8],
      TRIX_TRAIL_DISTANCE: [1, 2, 3],
      TRIX_STOP_ATR_MULT: [2.0, 2.5, 3.0, 3.5],
      TRIX_REWARD_RISK: [4.0, 5.0, 6.0],
      TRIX_STAGNATION_BARS: [10, 12, 16, 20],
    },
    buildCheckSignal(candles, params) {
      const closes = candles.map((c) => c.close);
      const trixLine = computeTRIX(closes, params.TRIX_PERIOD);
      const trixSignal = computeTRIXSignal(trixLine, params.TRIX_SIGNAL);
      return (i) => {
        const ct = trixLine[i], pt = trixLine[i - 1];
        const cs = trixSignal[i], ps = trixSignal[i - 1];
        if (ct === null || pt === null || cs === null || ps === null) return null;
        if (pt <= ps && ct > cs) return "long";
        if (pt >= ps && ct < cs) return "short";
        return null;
      };
    },
  },
  // ─── DEMA ─────────────────────────────────────────────────────────────────
  {
    name: "dema",
    currentParams: { DEMA_FAST: 5, DEMA_SLOW: 21, DEMA_DAILY_SMA_PERIOD: 100, DEMA_DAILY_ADX_MIN: 18, DEMA_STOP_ATR_MULT: 4.0, DEMA_REWARD_RISK: 5.0, DEMA_STAGNATION_BARS: 12 },
    phase1Grid: {
      DEMA_FAST: [3, 5, 8, 10],
      DEMA_SLOW: [17, 21, 26, 30],
    },
    phase2Grid: {
      DEMA_DAILY_SMA_PERIOD: [50, 75, 100],
      DEMA_DAILY_ADX_MIN: [10, 14, 18, 22],
      DEMA_ADX_NOT_DECL: [0, 1],
      DEMA_REVERSE_EXIT: [0, 1],
      DEMA_TRAIL_ACTIVATION: [3, 5, 8],
      DEMA_TRAIL_DISTANCE: [1, 2, 3],
      DEMA_STOP_ATR_MULT: [3.0, 3.5, 4.0, 5.0],
      DEMA_REWARD_RISK: [4.0, 5.0, 6.0],
      DEMA_STAGNATION_BARS: [8, 10, 12, 16],
    },
    buildCheckSignal(candles, params) {
      const closes = candles.map((c) => c.close);
      const demaFast = computeDEMA(closes, params.DEMA_FAST);
      const demaSlow = computeDEMA(closes, params.DEMA_SLOW);
      return (i) => {
        const cf = demaFast[i], pf = demaFast[i - 1];
        const cs = demaSlow[i], ps = demaSlow[i - 1];
        if (cf === null || pf === null || cs === null || ps === null) return null;
        if (pf <= ps && cf > cs) return "long";
        if (pf >= ps && cf < cs) return "short";
        return null;
      };
    },
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const filterArg = process.argv[2]?.toLowerCase() ?? "all";
  const pairArg = process.argv.find((a) => a.startsWith("--pair="))?.split("=")[1]?.toUpperCase();

  const tunersFiltered = filterArg === "all"
    ? ENGINE_TUNERS
    : ENGINE_TUNERS.filter((e) => e.name === filterArg);

  if (tunersFiltered.length === 0) {
    console.error(`Unknown engine: ${filterArg}. Valid: ${ENGINE_TUNERS.map((e) => e.name).join(", ")}, all`);
    process.exit(1);
  }

  // If --pair=COIN specified, restrict to that single pair
  const pairsToLoad = pairArg ? [pairArg] : PAIRS;

  // Compute all needed SMA periods upfront
  const allSmaPeriods = [...new Set(
    tunersFiltered.flatMap((t) => [...(t.phase1Grid["CCI_DAILY_SMA_PERIOD"] ?? []), ...(t.phase2Grid[Object.keys(t.phase2Grid).find((k) => k.endsWith("_DAILY_SMA_PERIOD")) ?? ""] ?? [50, 75, 100])])
  ), 50, 75, 100];

  console.log(`=== tune-grid-all.ts: 2-Phase Grid Search ===`);
  console.log(`Pairs: ${pairsToLoad.join(", ")}`);
  console.log(`Engines: ${tunersFiltered.map((e) => e.name).join(", ")}`);
  console.log(`Walk-forward: train=${TRAIN_BARS} 4h bars, test=remainder`);
  console.log(`\nFetching candle data...`);

  // Fetch all candle data
  const allPairData: Record<string, { pairData: PairData; preDaily: DailyPre; idxDailyAt: number[] }> = {};

  for (let pi = 0; pi < pairsToLoad.length; pi++) {
    const pair = pairsToLoad[pi];
    if (pi > 0) await sleep(2000);
    try {
      process.stdout.write(`  ${pair} 4h...`);
      const h4 = await fetchCandles(pair, "4h", DAYS_4H);
      process.stdout.write(` ${h4.length}bars. daily...`);
      let dailyCandles: Candle[] | null = null;
      for (const interval of ["1d", "24h"]) {
        try { dailyCandles = await fetchCandles(pair, interval, DAYS_DAILY); break; } catch {}
        await sleep(300);
      }
      if (!dailyCandles || dailyCandles.length === 0) throw new Error("daily fetch failed");
      const atr4h = precomputeATR(h4);
      const preDaily = precomputeDaily(dailyCandles, [50, 75, 100]);
      const idxDailyAt = buildDailyIndex(h4, dailyCandles);
      const trainEnd = Math.min(TRAIN_BARS, Math.floor(h4.length * 0.67));
      allPairData[pair] = {
        pairData: { h4, atr4h, dailyCandles, trainEnd },
        preDaily,
        idxDailyAt,
      };
      console.log(` ${dailyCandles.length}daily. trainEnd=${trainEnd}`);
    } catch (e) {
      console.warn(`  ${pair}: SKIP (${(e as Error).message})`);
    }
  }

  const loadedPairs = Object.keys(allPairData);
  if (loadedPairs.length === 0) { console.error("No pairs loaded."); process.exit(1); }
  console.log(`\nLoaded ${loadedPairs.length} pairs.\n`);

  const constantsUpdates: string[] = [];

  for (const tuner of tunersFiltered) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Engine: ${tuner.name.toUpperCase()}`);
    console.log(`${"=".repeat(60)}`);

    // Build baseline result
    const baselineSignalKeys = Object.keys(tuner.phase1Grid);
    const baselineRiskKeys = Object.keys(tuner.phase2Grid);

    // Extract current smaPeriod from currentParams
    const smaPeriodKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_DAILY_SMA_PERIOD")) ?? "";
    const adxMinKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_DAILY_ADX_MIN")) ?? "";
    const stopAtrKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_STOP_ATR_MULT")) ?? "";
    const rrKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_REWARD_RISK")) ?? "";
    const stagKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_STAGNATION_BARS")) ?? "";

    // Compute baseline using min-fold score (same metric as optimization target)
    const baseScore = computeMinFoldScore(loadedPairs, allPairData, tuner, tuner.currentParams, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
    let baselineSharpe = baseScore.minSharpe;
    let baselinePctPerDay = baseScore.pctPerDay;
    let baselineTrades = baseScore.trades;
    console.log(`Baseline [min-fold]: ${baselinePctPerDay.toFixed(3)}%/day  minSharpe=${baselineSharpe.toFixed(2)}  Trades=${baselineTrades}`);
    console.log(`Current params: ${Object.entries(tuner.currentParams).map(([k, v]) => `${k}=${v}`).join(", ")}`);

    // Phase 1: Sweep signal params (use current risk params)
    const phase1Combos = cartesian(tuner.phase1Grid);
    console.log(`\nPhase 1: ${phase1Combos.length} signal combos...`);

    const phase1Results: ComboResult[] = [];
    for (const signalCombo of phase1Combos) {
      const p = { ...tuner.currentParams, ...signalCombo };
      const score = computeMinFoldScore(loadedPairs, allPairData, tuner, p, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
      phase1Results.push({ params: signalCombo, sharpe: score.minSharpe, pctPerDay: score.pctPerDay, trades: score.trades });
    }

    const top3Signal = topN(phase1Results, 3, 30);
    if (top3Signal.length === 0) {
      console.log(`  No signal combos with >=30 trades. Using current signal params.`);
      top3Signal.push({ params: Object.fromEntries(Object.keys(tuner.phase1Grid).map((k) => [k, tuner.currentParams[k]])), sharpe: baselineSharpe, pctPerDay: baselinePctPerDay, trades: baselineTrades });
    }
    top3Signal.forEach((r, i) => {
      console.log(`  Top${i + 1} [min-fold]: ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")} -> minSharpe=${r.sharpe.toFixed(2)} ${r.pctPerDay.toFixed(3)}%/day T=${r.trades}`);
    });

    // Phase 2: For each top-3 signal combo, sweep risk params
    console.log(`\nPhase 2: risk param sweep for top ${top3Signal.length} signal combos...`);
    const phase2Combos = cartesian(tuner.phase2Grid);
    console.log(`  ${phase2Combos.length} risk combos x ${top3Signal.length} winners = ${phase2Combos.length * top3Signal.length} total`);

    let bestOverall: { params: Record<string, number>; sharpe: number; pctPerDay: number; trades: number } | null = null;

    for (const winner of top3Signal) {
      for (const riskCombo of phase2Combos) {
        const p = { ...tuner.currentParams, ...winner.params, ...riskCombo };
        const score = computeMinFoldScore(loadedPairs, allPairData, tuner, p, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
        if (score.trades < 30) continue;
        if (bestOverall === null || score.minSharpe > bestOverall.sharpe) {
          bestOverall = { params: { ...winner.params, ...riskCombo }, sharpe: score.minSharpe, pctPerDay: score.pctPerDay, trades: score.trades };
        }
      }
    }

    if (bestOverall === null) {
      console.log(`  No valid result with >=30 trades. Keeping current params.`);
      continue;
    }

    const bestParams = { ...tuner.currentParams, ...bestOverall.params };
    console.log(`\nBest [min-fold]: minSharpe=${bestOverall.sharpe.toFixed(2)} ${bestOverall.pctPerDay.toFixed(3)}%/day T=${bestOverall.trades}`);
    console.log(`Best params: ${Object.entries(bestOverall.params).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(`Delta [min-fold]: ${bestOverall.sharpe >= baselineSharpe ? "+" : ""}${(bestOverall.sharpe - baselineSharpe).toFixed(2)} Sharpe  ${bestOverall.pctPerDay >= baselinePctPerDay ? "+" : ""}${(bestOverall.pctPerDay - baselinePctPerDay).toFixed(3)}%/day`);

    // Evaluate best params on OOS (test) window -- bars trainEnd..end
    {
      let oosPnl = 0;
      let oosMaxDays = 0;
      let oosTrades = 0;
      const oosPnlPcts: number[] = [];
      const p = bestParams;
      for (const pair of loadedPairs) {
        const { pairData, preDaily, idxDailyAt } = allPairData[pair];
        const checkSignal = tuner.buildCheckSignal(pairData.h4, p);
        const startIdx = pairData.trainEnd;
        const endIdx = pairData.h4.length;
        const adxNDKey = Object.keys(p).find((k) => k.endsWith("_ADX_NOT_DECL"));
        const revExKey = Object.keys(p).find((k) => k.endsWith("_REVERSE_EXIT"));
        const tActKey = Object.keys(p).find((k) => k.endsWith("_TRAIL_ACTIVATION"));
        const tDistKey = Object.keys(p).find((k) => k.endsWith("_TRAIL_DISTANCE"));
        const r = runBacktestEngine(pairData, preDaily, idxDailyAt, {
          smaPeriod: p[smaPeriodKey] ?? 100,
          adxMin: p[adxMinKey] ?? 18,
          adxNotDecl: adxNDKey !== undefined ? p[adxNDKey] === 1 : false,
          reverseExit: revExKey !== undefined ? p[revExKey] === 1 : false,
          trailActivation: tActKey !== undefined ? p[tActKey] : 5,
          trailDistance: tDistKey !== undefined ? p[tDistKey] : 2,
          stopAtrMult: p[stopAtrKey] ?? 3.0,
          rewardRisk: p[rrKey] ?? 5.0,
          stagnationBars: p[stagKey] ?? 12,
          checkSignal,
        }, startIdx, endIdx);
        oosPnl += r.totalReturn;
        oosTrades += r.trades;
        oosMaxDays = Math.max(oosMaxDays, r.days);
        oosPnlPcts.push(...r.tradePnlPcts);
      }
      const oosPctPerDay = oosMaxDays > 0 ? (oosPnl / (MARGIN_PER_TRADE * loadedPairs.length)) / oosMaxDays * 100 : 0;
      const oosSharpe = sharpe(oosPnlPcts);
      console.log(`OOS [TEST]:   Sharpe=${oosSharpe.toFixed(2)} ${oosPctPerDay.toFixed(3)}%/day T=${oosTrades} PnL=$${oosPnl.toFixed(2)}`);
      // Store OOS metrics in constants comment
      const enginePrefix = tuner.name.toUpperCase();
      const constBlock = Object.entries(bestParams)
        .map(([k, v]) => `export const ${k} = ${v};`)
        .join("\n");
      constantsUpdates.push(`// ${enginePrefix} Engine -- TRAIN Sharpe=${bestOverall.sharpe.toFixed(2)} OOS Sharpe=${oosSharpe.toFixed(2)} OOS %/day=${oosPctPerDay.toFixed(3)}\n${constBlock}`);
    }
  }

  // Print full constants update block
  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`=== CONSTANTS UPDATE ===`);
  console.log(`${"=".repeat(60)}`);
  console.log(constantsUpdates.join("\n\n"));

  // Save to file
  const output = constantsUpdates.join("\n\n");
  fs.writeFileSync("/tmp/tune-grid-all-results.txt", output + "\n");
  console.log(`\nFull constants update saved to /tmp/tune-grid-all-results.txt`);
}

main().catch(console.error);
