// tune-overnight.ts — Extended overnight tuning for all 9 engines.
// Phases: (1) wide signal search, (2) risk grid (same as tune-grid-all), (3) fine-tune neighborhood.
// After tuning: inline 3-fold walk-forward validation per engine.
// Runtime: ~10-14 hours. Output: /tmp/overnight-results.txt
// Run: npx tsx scripts/tune-overnight.ts 2>&1 | tee /tmp/overnight-results.txt

import { ATR, ADX, MACD, EMA, PSAR } from "technicalindicators";
import * as fs from "node:fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.0009;
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV;

const PAIRS = ["BTC","ETH","SOL","XRP","DOGE","AVAX","LINK","ARB","BNB","OP","SUI","INJ","ATOM","APT","WIF","kPEPE","kBONK","kFLOKI","kSHIB","NEAR","RUNE","FET","LDO","CRV","HBAR","LTC","TIA","SEI","JUP","PYTH","TAO","ADA","DOT"];
const DAYS_4H = 730;
const DAYS_DAILY = 750;
const TRAIN_BARS = 2935; // ~67% of 4381
const TOTAL_BARS = 4381; // total expected 4h bars over 730d

// 3-fold test windows (each ~124d / ~745 bars)
const FOLD_TEST_WINDOWS = [
  { label: "F1", start: Math.floor(TOTAL_BARS * 0.33), end: Math.floor(TOTAL_BARS * 0.50) },
  { label: "F2", start: Math.floor(TOTAL_BARS * 0.50), end: Math.floor(TOTAL_BARS * 0.67) },
  { label: "F3", start: Math.floor(TOTAL_BARS * 0.67), end: Math.floor(TOTAL_BARS * 0.84) },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }
interface BacktestResult { trades: number; wins: number; totalReturn: number; maxDrawdown: number; tradePnlPcts: number[]; days: number; }
interface DailyPre { smaMap: Map<number, (number | null)[]>; adx: (number | null)[]; }
interface PairData { h4: Candle[]; atr4h: (number | null)[]; dailyCandles: Candle[]; trainEnd: number; }
interface EngineRunParams {
  smaPeriod: number; adxMin: number; adxNotDecl: boolean; reverseExit: boolean;
  trailActivation: number; trailDistance: number; stopAtrMult: number;
  rewardRisk: number; stagnationBars: number;
  checkSignal: (i: number) => "long" | "short" | null;
}
type ComboResult = { params: Record<string, number>; sharpe: number; pctPerDay: number; trades: number };
interface EngineTuner {
  name: string;
  currentParams: Record<string, number>;
  phase1Grid: Record<string, number[]>;
  phase2Grid: Record<string, number[]>;
  buildCheckSignal: (candles: Candle[], params: Record<string, number>) => (i: number) => "long" | "short" | null;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function fetchCandlesOnce(coin: string, interval: string, days: number): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - days * 86400_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin} ${interval}`);
    const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
    return raw.map((c) => ({ timestamp: c.t, open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v) })).sort((a, b) => a.timestamp - b.timestamp);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCandles(coin: string, interval: string, days: number): Promise<Candle[]> {
  try { return await fetchCandlesOnce(coin, interval, days); } catch { await sleep(1000); return await fetchCandlesOnce(coin, interval, days); }
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

// ─── Indicator functions ──────────────────────────────────────────────────────

function computeZLEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const lagOffset = Math.floor((period - 1) / 2);
  const corrected: number[] = [];
  for (let i = lagOffset; i < n; i++) corrected.push(closes[i] + (closes[i] - closes[i - lagOffset]));
  const emaValues = EMA.calculate({ values: corrected, period });
  const result: (number | null)[] = new Array(n).fill(null);
  const emaStartOrigIdx = lagOffset + (period - 1);
  for (let i = 0; i < emaValues.length; i++) { const origIdx = emaStartOrigIdx + i; if (origIdx < n) result[origIdx] = emaValues[i]; }
  return result;
}

function computeTRIX(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const ema1 = EMA.calculate({ values: closes, period });
  const ema2 = EMA.calculate({ values: ema1, period });
  const ema3 = EMA.calculate({ values: ema2, period });
  const ema3StartIdx = (period - 1) * 3;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < ema3.length; i++) { const origIdx = ema3StartIdx + i; if (origIdx < n && ema3[i - 1] !== 0) result[origIdx] = ((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 100; }
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
  for (let i = 0; i < stcRaw.length; i++) { const origIdx = n - stcRaw.length + i; if (origIdx >= 0) result[origIdx] = stcRaw[i]; }
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
  for (let i = 0; i < hmaOnDiff.length; i++) { const origIdx = diffStartIdx + i; if (origIdx < closes.length) result[origIdx] = hmaOnDiff[i]; }
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

function runBacktestEngine(
  pairData: PairData,
  preDaily: DailyPre,
  idxDailyAt: number[],
  params: EngineRunParams,
  startIdx: number,
  endIdx: number,
): BacktestResult {
  const { h4, atr4h } = pairData;
  let pnlTotal = 0, peakPnl = 0, maxDrawdown = 0, trades = 0, wins = 0;
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

// ─── Grid helpers ─────────────────────────────────────────────────────────────

function cartesian(obj: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(obj);
  const results: Record<string, number>[] = [{}];
  for (const key of keys) {
    const vals = obj[key];
    const expanded: Record<string, number>[] = [];
    for (const combo of results) { for (const v of vals) expanded.push({ ...combo, [key]: v }); }
    results.length = 0;
    results.push(...expanded);
  }
  return results;
}

function topN(results: ComboResult[], n: number, minTrades: number): ComboResult[] {
  return results.filter((r) => r.trades >= minTrades).sort((a, b) => b.sharpe - a.sharpe).slice(0, n);
}

// ─── Scoring (2-fold min-Sharpe, optimized for consistency) ───────────────────

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
  let totalPnl = 0, totalDays = 0, totalTrades = 0;
  const adxNotDeclKey = Object.keys(p).find((k) => k.endsWith("_ADX_NOT_DECL"));
  const reverseExitKey = Object.keys(p).find((k) => k.endsWith("_REVERSE_EXIT"));
  const trailActKey = Object.keys(p).find((k) => k.endsWith("_TRAIL_ACTIVATION"));
  const trailDistKey = Object.keys(p).find((k) => k.endsWith("_TRAIL_DISTANCE"));
  for (const pair of pairs) {
    const { pairData, preDaily, idxDailyAt } = allPairData[pair];
    const checkSignal = tuner.buildCheckSignal(pairData.h4, p);
    const trainHalf = Math.floor(pairData.trainEnd / 2);
    const ep: EngineRunParams = {
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

// ─── Phase 3: fine-tune neighborhood search around Phase 2 best ───────────────

function buildNeighborGrid(
  bestParams: Record<string, number>,
  adxMinKey: string,
  stopAtrKey: string,
  rrKey: string,
  stagKey: string,
): Record<string, number[]> {
  const g: Record<string, number[]> = {};

  // ADX_MIN: ±3 (integer steps of 1)
  const adx = bestParams[adxMinKey];
  g[adxMinKey] = unique([Math.max(0, adx - 3), Math.max(0, adx - 2), Math.max(0, adx - 1), adx, adx + 1, adx + 2, adx + 3].map(Math.round));

  // STOP_ATR_MULT: ±0.75 (steps of 0.25)
  const stop = bestParams[stopAtrKey];
  g[stopAtrKey] = unique([stop - 0.75, stop - 0.5, stop - 0.25, stop, stop + 0.25, stop + 0.5, stop + 0.75].map((v) => Math.max(1.0, round2(v))));

  // REWARD_RISK: ±0.75 (steps of 0.25)
  const rr = bestParams[rrKey];
  g[rrKey] = unique([rr - 0.75, rr - 0.5, rr - 0.25, rr, rr + 0.25, rr + 0.5, rr + 0.75].map((v) => Math.max(1.0, round2(v))));

  // STAGNATION_BARS: ±4 (integer steps of 2)
  const stag = bestParams[stagKey];
  g[stagKey] = unique([Math.max(2, stag - 4), Math.max(2, stag - 2), stag, stag + 2, stag + 4].map(Math.round));

  // TRAIL_ACTIVATION (optional)
  const tActKey = Object.keys(bestParams).find((k) => k.endsWith("_TRAIL_ACTIVATION"));
  if (tActKey) {
    const ta = bestParams[tActKey];
    g[tActKey] = unique([Math.max(1, ta - 2), Math.max(1, ta - 1), ta, ta + 1, ta + 2].map(Math.round));
  }

  // TRAIL_DISTANCE (optional)
  const tDistKey = Object.keys(bestParams).find((k) => k.endsWith("_TRAIL_DISTANCE"));
  if (tDistKey) {
    const td = bestParams[tDistKey];
    g[tDistKey] = unique([Math.max(0.5, td - 1), Math.max(0.5, td - 0.5), td, td + 0.5, td + 1].map((v) => round2(v)));
  }

  return g;
}

function unique(arr: number[]): number[] { return [...new Set(arr)]; }
function round2(v: number): number { return Math.round(v * 100) / 100; }

// ─── Ensemble subset testing ───────────────────────────────────────────────────

interface TunedEngineState {
  tuner: EngineTuner;
  finalParams: Record<string, number>;
  smaPeriodKey: string;
  adxMinKey: string;
  stopAtrKey: string;
  rrKey: string;
  stagKey: string;
  adxNDKey: string | undefined;
  revExKey: string | undefined;
  trailActKey: string | undefined;
  trailDistKey: string | undefined;
  oosSharpe: number;
  oosPctPerDay: number;
}

function runEnsembleFold(
  loadedPairs: string[],
  allPairData: Record<string, { pairData: PairData; preDaily: DailyPre; idxDailyAt: number[] }>,
  engines: TunedEngineState[],
  foldStart: number,
  foldEnd: number,   // use Number.MAX_SAFE_INTEGER for "to end of data"
  minAgreement: number,
): { trades: number; wins: number; pnlPcts: number[]; totalPnl: number; maxDays: number } {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, maxDays = 0;
  const allPnlPcts: number[] = [];

  for (const pair of loadedPairs) {
    const { pairData, preDaily, idxDailyAt } = allPairData[pair];
    const endIdx = Math.min(foldEnd, pairData.h4.length);
    const safeStart = Math.min(foldStart, pairData.h4.length);
    if (safeStart >= endIdx) continue;

    const engineStates = engines.map((e) => ({
      checkSignal: e.tuner.buildCheckSignal(pairData.h4, e.finalParams),
      smaPeriod: e.finalParams[e.smaPeriodKey] ?? 100,
      adxMin: e.finalParams[e.adxMinKey] ?? 18,
      adxNotDecl: e.adxNDKey ? e.finalParams[e.adxNDKey] === 1 : false,
      stopAtrMult: e.finalParams[e.stopAtrKey] ?? 3.0,
      rewardRisk: e.finalParams[e.rrKey] ?? 5.0,
      stagnationBars: e.finalParams[e.stagKey] ?? 12,
      trailActivation: e.trailActKey ? e.finalParams[e.trailActKey] : 5,
      trailDistance: e.trailDistKey ? e.finalParams[e.trailDistKey] : 2,
    }));

    type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peakPnlPct: number; trailAct: number; trailDist: number; stag: number };
    let pos: Pos | null = null;

    for (let i = safeStart; i < endIdx; i++) {
      const c = pairData.h4[i];
      const atr = pairData.atr4h[i] ?? c.close * 0.02;

      if (pos !== null) {
        const pricePct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
        const unrealizedPct = pricePct * LEV * 100;
        pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);
        const trailingHit = pos.peakPnlPct > pos.trailAct && unrealizedPct <= pos.peakPnlPct - pos.trailDist;
        const stagHit = (i - pos.entryIdx) >= pos.stag;
        const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
        const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
        let exitPrice: number | null = null;
        if (trailingHit) exitPrice = c.close;
        else if (stagHit) exitPrice = c.close;
        else if (slHit && tpHit) exitPrice = pos.sl;
        else if (slHit) exitPrice = pos.sl;
        else if (tpHit) exitPrice = pos.tp;
        if (exitPrice !== null) {
          const pp = ((exitPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
          const net = pp * NOTIONAL - NOTIONAL * FEE_RATE;
          totalPnl += net;
          totalTrades++;
          if (net > 0) totalWins++;
          allPnlPcts.push((net / MARGIN_PER_TRADE) * 100);
          pos = null;
        }
      }

      if (pos === null && i + 1 < endIdx) {
        const dIdx = idxDailyAt[i];
        if (dIdx < 0) continue;
        const dailyAdx = preDaily.adx[dIdx];
        const dailyClose = pairData.dailyCandles[dIdx].close;
        const longVoters: typeof engineStates = [];
        const shortVoters: typeof engineStates = [];
        for (const es of engineStates) {
          const dailySma = preDaily.smaMap.get(es.smaPeriod)?.[dIdx] ?? null;
          if (dailySma === null || dailyAdx === null) continue;
          if (dailyAdx < es.adxMin) continue;
          if (es.adxNotDecl && dIdx >= 2) {
            const adxPrev2 = preDaily.adx[dIdx - 2];
            if (adxPrev2 !== null && dailyAdx < adxPrev2) continue;
          }
          const sig = es.checkSignal(i);
          if (sig === "long" && dailyClose > dailySma) longVoters.push(es);
          if (sig === "short" && dailyClose < dailySma) shortVoters.push(es);
        }
        const voters = longVoters.length >= minAgreement ? longVoters : shortVoters.length >= minAgreement ? shortVoters : null;
        if (!voters) continue;
        const dir: "long" | "short" = longVoters.length >= minAgreement ? "long" : "short";
        const entryPrice = pairData.h4[i + 1].open;
        const avgStop = voters.reduce((s, e) => s + e.stopAtrMult, 0) / voters.length;
        const avgRR = voters.reduce((s, e) => s + e.rewardRisk, 0) / voters.length;
        const avgTrailAct = voters.reduce((s, e) => s + e.trailActivation, 0) / voters.length;
        const avgTrailDist = voters.reduce((s, e) => s + e.trailDistance, 0) / voters.length;
        const maxStag = Math.max(...voters.map((e) => e.stagnationBars));
        const stopDist = atr * avgStop;
        const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
        const tp = dir === "long" ? entryPrice + stopDist * avgRR : entryPrice - stopDist * avgRR;
        pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peakPnlPct: 0, trailAct: avgTrailAct, trailDist: avgTrailDist, stag: maxStag };
      }
    }

    const startTs = pairData.h4[safeStart]?.timestamp ?? 0;
    const endTs = pairData.h4[endIdx - 1]?.timestamp ?? 0;
    maxDays = Math.max(maxDays, (endTs - startTs) / 86400_000);
  }

  return { trades: totalTrades, wins: totalWins, pnlPcts: allPnlPcts, totalPnl, maxDays };
}

// ─── Inline 3-fold walk-forward validation ────────────────────────────────────

function run3FoldValidation(
  loadedPairs: string[],
  allPairData: Record<string, { pairData: PairData; preDaily: DailyPre; idxDailyAt: number[] }>,
  engineName: string,
  bestParams: Record<string, number>,
  tuner: EngineTuner,
  smaPeriodKey: string,
  adxMinKey: string,
  stopAtrKey: string,
  rrKey: string,
  stagKey: string,
): { avgSharpe: number; avgPctPerDay: number; avgWR: number; totalTrades: number; foldSharpes: number[] } {
  const adxNDKey = Object.keys(bestParams).find((k) => k.endsWith("_ADX_NOT_DECL"));
  const revExKey = Object.keys(bestParams).find((k) => k.endsWith("_REVERSE_EXIT"));
  const tActKey = Object.keys(bestParams).find((k) => k.endsWith("_TRAIL_ACTIVATION"));
  const tDistKey = Object.keys(bestParams).find((k) => k.endsWith("_TRAIL_DISTANCE"));

  const foldResults: { sharpe: number; pctPerDay: number; wr: number; trades: number; pnl: number }[] = [];

  for (const fold of FOLD_TEST_WINDOWS) {
    let totalPnl = 0, maxDays = 0, totalTrades = 0, totalWins = 0;
    const allPnlPcts: number[] = [];

    for (const pair of loadedPairs) {
      const { pairData, preDaily, idxDailyAt } = allPairData[pair];
      const safeEnd = Math.min(fold.end, pairData.h4.length);
      if (fold.start >= pairData.h4.length || safeEnd <= fold.start) continue;
      const checkSignal = tuner.buildCheckSignal(pairData.h4, bestParams);
      const r = runBacktestEngine(pairData, preDaily, idxDailyAt, {
        smaPeriod: bestParams[smaPeriodKey] ?? 100,
        adxMin: bestParams[adxMinKey] ?? 18,
        adxNotDecl: adxNDKey ? bestParams[adxNDKey] === 1 : false,
        reverseExit: revExKey ? bestParams[revExKey] === 1 : false,
        trailActivation: tActKey ? bestParams[tActKey] : 5,
        trailDistance: tDistKey ? bestParams[tDistKey] : 2,
        stopAtrMult: bestParams[stopAtrKey] ?? 3.0,
        rewardRisk: bestParams[rrKey] ?? 5.0,
        stagnationBars: bestParams[stagKey] ?? 12,
        checkSignal,
      }, fold.start, safeEnd);
      totalPnl += r.totalReturn;
      totalTrades += r.trades;
      totalWins += r.wins;
      maxDays = Math.max(maxDays, r.days);
      allPnlPcts.push(...r.tradePnlPcts);
    }

    const pctPerDay = maxDays > 0 ? (totalPnl / (MARGIN_PER_TRADE * loadedPairs.length)) / maxDays * 100 : 0;
    const wr = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    foldResults.push({ sharpe: sharpe(allPnlPcts), pctPerDay, wr, trades: totalTrades, pnl: totalPnl });
  }

  const avgSharpe = foldResults.reduce((s, f) => s + f.sharpe, 0) / foldResults.length;
  const avgPctPerDay = foldResults.reduce((s, f) => s + f.pctPerDay, 0) / foldResults.length;
  const avgWR = foldResults.reduce((s, f) => s + f.wr, 0) / foldResults.length;
  const totalTrades = foldResults.reduce((s, f) => s + f.trades, 0);

  console.log(`\n[3-FOLD VALIDATION] ${engineName.toUpperCase()}`);
  foldResults.forEach((f, i) => {
    const sign = f.pctPerDay >= 0 ? "+" : "";
    console.log(`  ${FOLD_TEST_WINDOWS[i].label}: T=${f.trades}  WR=${f.wr.toFixed(1)}%  PnL=$${f.pnl.toFixed(2)}  %/d=${sign}${f.pctPerDay.toFixed(3)}%  Sharpe=${f.sharpe.toFixed(2)}`);
  });
  const avgSign = avgPctPerDay >= 0 ? "+" : "";
  console.log(`  AVG: Sharpe=${avgSharpe.toFixed(2)}  %/d=${avgSign}${avgPctPerDay.toFixed(3)}%  WR=${avgWR.toFixed(1)}%  T=${totalTrades}`);

  return { avgSharpe, avgPctPerDay, avgWR, totalTrades, foldSharpes: foldResults.map((f) => f.sharpe) };
}

// ─── Engine definitions (expanded Phase 1 grids, same Phase 2) ────────────────

const ENGINE_TUNERS: EngineTuner[] = [
  // ─── CCI ──────────────────────────────────────────────────────────────────
  {
    name: "cci",
    currentParams: { CCI_PERIOD: 8, CCI_THRESHOLD: 100, CCI_DAILY_SMA_PERIOD: 50, CCI_DAILY_ADX_MIN: 8, CCI_STOP_ATR_MULT: 2.5, CCI_REWARD_RISK: 4.0, CCI_STAGNATION_BARS: 16 },
    phase1Grid: {
      CCI_PERIOD: [6, 7, 8, 9, 10, 11, 12, 14, 16, 20],       // was [8,10,12,14] — wider range
      CCI_THRESHOLD: [75, 85, 95, 100, 110, 115, 120, 130, 140, 150], // was [100,110,120,130,140]
    },
    phase2Grid: {
      CCI_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      CCI_DAILY_ADX_MIN: [0, 8, 10, 14],
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
    currentParams: { ELDER_EMA_PERIOD: 13, ELDER_MACD_FAST: 8, ELDER_MACD_SLOW: 21, ELDER_MACD_SIGNAL: 9, ELDER_DAILY_SMA_PERIOD: 100, ELDER_DAILY_ADX_MIN: 14, ELDER_STOP_ATR_MULT: 3.0, ELDER_REWARD_RISK: 2.5, ELDER_STAGNATION_BARS: 12 },
    phase1Grid: {
      ELDER_EMA_PERIOD: [9, 11, 13, 15, 17, 19, 21, 25],        // was [13,17,21,26]
      ELDER_MACD_FAST: [6, 8, 10, 12, 16],                      // was [8,12,16]
      ELDER_MACD_SLOW: [17, 21, 24, 26, 30, 34],                 // was [21,26,30]
      ELDER_MACD_SIGNAL: [6, 7, 9, 11, 14],                      // was [7,9,12]
    },
    phase2Grid: {
      ELDER_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      ELDER_DAILY_ADX_MIN: [0, 8, 10, 14],
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
        if (cE == null || pE == null || ppE == null || cH == null || pH == null || ppH == null) return null;
        if (cE > pE && cH > pH && !(pE > ppE && pH > ppH)) return "long";
        if (cE < pE && cH < pH && !(pE < ppE && pH < ppH)) return "short";
        return null;
      };
    },
  },
  // ─── ZLEMA ────────────────────────────────────────────────────────────────
  {
    name: "zlema",
    currentParams: { ZLEMA_FAST: 8, ZLEMA_SLOW: 34, ZLEMA_DAILY_SMA_PERIOD: 50, ZLEMA_DAILY_ADX_MIN: 10, ZLEMA_STOP_ATR_MULT: 2.5, ZLEMA_REWARD_RISK: 3.0, ZLEMA_STAGNATION_BARS: 8 },
    phase1Grid: {
      ZLEMA_FAST: [4, 5, 6, 7, 8, 9, 10, 12, 14, 16],            // was [6,8,10,12,16] — capped at 16 (SLOW min is 22)
      ZLEMA_SLOW: [22, 24, 26, 30, 34, 40, 50, 60],              // was [20,26,30,34,40,50] — min 22 to ensure SLOW > FAST
    },
    phase2Grid: {
      ZLEMA_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      ZLEMA_DAILY_ADX_MIN: [0, 10, 14, 18, 22, 26],
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
    currentParams: { VORTEX_VORTEX_PERIOD: 25, VORTEX_DAILY_SMA_PERIOD: 100, VORTEX_DAILY_ADX_MIN: 14, VORTEX_STOP_ATR_MULT: 5.0, VORTEX_REWARD_RISK: 4.0, VORTEX_STAGNATION_BARS: 16 },
    phase1Grid: {
      VORTEX_VORTEX_PERIOD: [5, 7, 9, 11, 14, 18, 21, 25, 30, 35, 40], // was [7,10,14,18,21,25]
    },
    phase2Grid: {
      VORTEX_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      VORTEX_DAILY_ADX_MIN: [0, 10, 14, 18, 22, 26, 30],
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
    currentParams: { SCHAFF_STC_FAST: 8, SCHAFF_STC_SLOW: 26, SCHAFF_STC_CYCLE: 12, SCHAFF_STC_THRESHOLD: 25, SCHAFF_DAILY_SMA_PERIOD: 50, SCHAFF_DAILY_ADX_MIN: 10, SCHAFF_STOP_ATR_MULT: 3.5, SCHAFF_REWARD_RISK: 4.0, SCHAFF_STAGNATION_BARS: 9 },
    phase1Grid: {
      SCHAFF_STC_FAST: [4, 5, 6, 8, 10, 12, 14],               // was [6,8,10,12]
      SCHAFF_STC_SLOW: [17, 20, 23, 26, 30, 34, 38],             // was [20,23,26,30]
      SCHAFF_STC_CYCLE: [7, 8, 10, 12, 14, 16],                  // was [8,10,12]
      SCHAFF_STC_THRESHOLD: [15, 20, 25, 30, 35, 40],             // was [20,25,30]
    },
    phase2Grid: {
      SCHAFF_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      SCHAFF_DAILY_ADX_MIN: [0, 10, 14, 18, 22],
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
    currentParams: { PSAR_STEP: 0.02, PSAR_MAX: 0.1, PSAR_DAILY_SMA_PERIOD: 50, PSAR_DAILY_ADX_MIN: 10, PSAR_STOP_ATR_MULT: 3.0, PSAR_REWARD_RISK: 4.0, PSAR_STAGNATION_BARS: 10 },
    phase1Grid: {
      PSAR_STEP: [0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05], // was [0.01,0.02,0.025,0.03,0.04]
      PSAR_MAX: [0.05, 0.07, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3],               // was [0.08,0.1,0.15,0.2]
    },
    phase2Grid: {
      PSAR_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      PSAR_DAILY_ADX_MIN: [0, 10, 14, 18, 22, 26],
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
    currentParams: { HMA_FAST: 6, HMA_SLOW: 34, HMA_DAILY_SMA_PERIOD: 50, HMA_DAILY_ADX_MIN: 10, HMA_STOP_ATR_MULT: 2.5, HMA_REWARD_RISK: 5.0, HMA_STAGNATION_BARS: 4 },
    phase1Grid: {
      HMA_FAST: [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16],          // was [6,8,10,12]
      HMA_SLOW: [18, 22, 26, 28, 30, 34, 38, 42, 50, 60],        // was [26,30,34,40]
    },
    phase2Grid: {
      HMA_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      HMA_DAILY_ADX_MIN: [0, 8, 10, 14, 18],
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
    currentParams: { TRIX_PERIOD: 9, TRIX_SIGNAL: 15, TRIX_DAILY_SMA_PERIOD: 100, TRIX_DAILY_ADX_MIN: 14, TRIX_STOP_ATR_MULT: 3.5, TRIX_REWARD_RISK: 4.0, TRIX_STAGNATION_BARS: 10 },
    phase1Grid: {
      TRIX_PERIOD: [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16],       // was [3,5,7,9]
      TRIX_SIGNAL: [5, 6, 7, 8, 9, 10, 12, 15, 18, 20, 25],      // was [8,10,12,15]
    },
    phase2Grid: {
      TRIX_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      TRIX_DAILY_ADX_MIN: [0, 10, 14, 18, 22],
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
    currentParams: { DEMA_FAST: 5, DEMA_SLOW: 21, DEMA_DAILY_SMA_PERIOD: 50, DEMA_DAILY_ADX_MIN: 18, DEMA_STOP_ATR_MULT: 5.0, DEMA_REWARD_RISK: 4.0, DEMA_STAGNATION_BARS: 16 },
    phase1Grid: {
      DEMA_FAST: [3, 4, 5, 6, 7, 8, 9, 10, 12, 13],             // was [3,5,8,10]
      DEMA_SLOW: [15, 17, 19, 21, 24, 26, 28, 30, 34],           // was [17,21,26,30] — removed 13 (FAST max is 13, SLOW=13 gives no crossover)
    },
    phase2Grid: {
      DEMA_DAILY_SMA_PERIOD: [50, 75, 100, 150],
      DEMA_DAILY_ADX_MIN: [0, 10, 14, 18, 22],
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`=== tune-overnight.ts: Expanded 3-Phase Grid Search + 3-Fold Validation ===`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Engines: ${ENGINE_TUNERS.map((e) => e.name).join(", ")}`);
  console.log(`Phase 1: EXPANDED signal grids (3-10x wider coverage)`);
  console.log(`Phase 2: Same risk grids (~5.5h for all 9 engines)`);
  console.log(`Phase 3: Neighborhood fine-tune around Phase 2 best (~4h for all 9 engines)`);
  console.log(`After: Inline 3-fold walk-forward validation per engine`);
  console.log(`Output: /tmp/overnight-results.txt`);
  console.log(`\nFetching candle data (2s delay between pairs to avoid rate limits)...`);

  const allPairData: Record<string, { pairData: PairData; preDaily: DailyPre; idxDailyAt: number[] }> = {};

  for (let pi = 0; pi < PAIRS.length; pi++) {
    const pair = PAIRS[pi];
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
      const preDaily = precomputeDaily(dailyCandles, [50, 75, 100, 150]);
      const idxDailyAt = buildDailyIndex(h4, dailyCandles);
      const trainEnd = Math.min(TRAIN_BARS, Math.floor(h4.length * 0.67));
      allPairData[pair] = { pairData: { h4, atr4h, dailyCandles, trainEnd }, preDaily, idxDailyAt };
      console.log(` ${dailyCandles.length}daily. trainEnd=${trainEnd}`);
    } catch (e) {
      console.warn(`  ${pair}: SKIP (${(e as Error).message})`);
    }
  }

  const loadedPairs = Object.keys(allPairData);
  if (loadedPairs.length === 0) { console.error("No pairs loaded."); process.exit(1); }
  console.log(`\nLoaded ${loadedPairs.length} pairs.\n`);

  const constantsUpdates: string[] = [];
  const validationSummary: { name: string; avgSharpe: number; avgPctPerDay: number; avgWR: number; totalTrades: number; foldSharpes: number[]; oosSharpe: number; oosPctPerDay: number }[] = [];
  const allTunedEngines: TunedEngineState[] = [];

  for (const tuner of ENGINE_TUNERS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Engine: ${tuner.name.toUpperCase()}`);
    console.log(`${"=".repeat(60)}`);

    const smaPeriodKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_DAILY_SMA_PERIOD")) ?? "";
    const adxMinKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_DAILY_ADX_MIN")) ?? "";
    const stopAtrKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_STOP_ATR_MULT")) ?? "";
    const rrKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_REWARD_RISK")) ?? "";
    const stagKey = Object.keys(tuner.currentParams).find((k) => k.endsWith("_STAGNATION_BARS")) ?? "";

    // Baseline
    const baseScore = computeMinFoldScore(loadedPairs, allPairData, tuner, tuner.currentParams, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
    console.log(`Baseline [min-fold]: ${baseScore.pctPerDay.toFixed(3)}%/day  minSharpe=${baseScore.minSharpe.toFixed(2)}  Trades=${baseScore.trades}`);
    console.log(`Current params: ${Object.entries(tuner.currentParams).map(([k, v]) => `${k}=${v}`).join(", ")}`);

    // ── Phase 1: Wide signal search ──────────────────────────────────────────
    const phase1Combos = cartesian(tuner.phase1Grid);
    console.log(`\nPhase 1: ${phase1Combos.length} signal combos (expanded)...`);

    const phase1Results: ComboResult[] = [];
    for (const signalCombo of phase1Combos) {
      const p = { ...tuner.currentParams, ...signalCombo };
      const score = computeMinFoldScore(loadedPairs, allPairData, tuner, p, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
      phase1Results.push({ params: signalCombo, sharpe: score.minSharpe, pctPerDay: score.pctPerDay, trades: score.trades });
    }

    const top3Signal = topN(phase1Results, 3, 30);
    if (top3Signal.length === 0) {
      console.log(`  No valid signal combos with >=30 trades. Using current signal params.`);
      top3Signal.push({ params: Object.fromEntries(Object.keys(tuner.phase1Grid).map((k) => [k, tuner.currentParams[k]])), sharpe: baseScore.minSharpe, pctPerDay: baseScore.pctPerDay, trades: baseScore.trades });
    }
    top3Signal.forEach((r, i) => {
      console.log(`  Top${i + 1}: ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")} -> minSharpe=${r.sharpe.toFixed(2)} ${r.pctPerDay.toFixed(3)}%/day T=${r.trades}`);
    });

    // ── Phase 2: Risk param sweep ─────────────────────────────────────────────
    const phase2Combos = cartesian(tuner.phase2Grid);
    console.log(`\nPhase 2: ${phase2Combos.length} risk combos x ${top3Signal.length} signal winners = ${phase2Combos.length * top3Signal.length} total`);

    let phase2Best: { params: Record<string, number>; sharpe: number; pctPerDay: number; trades: number } | null = null;

    for (const winner of top3Signal) {
      for (const riskCombo of phase2Combos) {
        const p = { ...tuner.currentParams, ...winner.params, ...riskCombo };
        const score = computeMinFoldScore(loadedPairs, allPairData, tuner, p, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
        if (score.trades < 30) continue;
        if (phase2Best === null || score.minSharpe > phase2Best.sharpe) {
          phase2Best = { params: { ...winner.params, ...riskCombo }, sharpe: score.minSharpe, pctPerDay: score.pctPerDay, trades: score.trades };
        }
      }
    }

    if (phase2Best === null) {
      console.log(`  No valid Phase 2 result. Keeping current params.`);
      continue;
    }

    const phase2BestFull = { ...tuner.currentParams, ...phase2Best.params };
    console.log(`\nPhase 2 best: minSharpe=${phase2Best.sharpe.toFixed(2)} ${phase2Best.pctPerDay.toFixed(3)}%/day T=${phase2Best.trades}`);
    console.log(`  Params: ${Object.entries(phase2Best.params).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(`  Delta vs baseline: ${phase2Best.sharpe >= baseScore.minSharpe ? "+" : ""}${(phase2Best.sharpe - baseScore.minSharpe).toFixed(2)} Sharpe`);

    // ── Phase 3: Neighborhood fine-tune ──────────────────────────────────────
    const neighborGrid = buildNeighborGrid(phase2BestFull, adxMinKey, stopAtrKey, rrKey, stagKey);
    const phase3Combos = cartesian(neighborGrid);
    console.log(`\nPhase 3: ${phase3Combos.length} neighborhood combos (fine-tune around Phase 2 best)...`);

    let phase3Best = { params: phase2BestFull, sharpe: phase2Best.sharpe, pctPerDay: phase2Best.pctPerDay, trades: phase2Best.trades };

    for (const combo of phase3Combos) {
      const p = { ...phase2BestFull, ...combo };
      const score = computeMinFoldScore(loadedPairs, allPairData, tuner, p, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
      if (score.trades >= 30 && score.minSharpe > phase3Best.sharpe) {
        phase3Best = { params: p, sharpe: score.minSharpe, pctPerDay: score.pctPerDay, trades: score.trades };
      }
    }

    const phase3Improved = phase3Best.sharpe > phase2Best.sharpe;
    if (phase3Improved) {
      console.log(`  Phase 3 improved: minSharpe ${phase2Best.sharpe.toFixed(2)} -> ${phase3Best.sharpe.toFixed(2)} (+${(phase3Best.sharpe - phase2Best.sharpe).toFixed(2)})`);
    } else {
      console.log(`  Phase 3: no improvement found. Keeping Phase 2 best.`);
    }

    const finalParams = phase3Best.params;

    // ── OOS Test Window ───────────────────────────────────────────────────────
    {
      let oosPnl = 0, oosMaxDays = 0, oosTrades = 0;
      const oosPnlPcts: number[] = [];
      const adxNDKey = Object.keys(finalParams).find((k) => k.endsWith("_ADX_NOT_DECL"));
      const revExKey = Object.keys(finalParams).find((k) => k.endsWith("_REVERSE_EXIT"));
      const tActKey = Object.keys(finalParams).find((k) => k.endsWith("_TRAIL_ACTIVATION"));
      const tDistKey = Object.keys(finalParams).find((k) => k.endsWith("_TRAIL_DISTANCE"));
      for (const pair of loadedPairs) {
        const { pairData, preDaily, idxDailyAt } = allPairData[pair];
        const checkSignal = tuner.buildCheckSignal(pairData.h4, finalParams);
        const r = runBacktestEngine(pairData, preDaily, idxDailyAt, {
          smaPeriod: finalParams[smaPeriodKey] ?? 100,
          adxMin: finalParams[adxMinKey] ?? 18,
          adxNotDecl: adxNDKey ? finalParams[adxNDKey] === 1 : false,
          reverseExit: revExKey ? finalParams[revExKey] === 1 : false,
          trailActivation: tActKey ? finalParams[tActKey] : 5,
          trailDistance: tDistKey ? finalParams[tDistKey] : 2,
          stopAtrMult: finalParams[stopAtrKey] ?? 3.0,
          rewardRisk: finalParams[rrKey] ?? 5.0,
          stagnationBars: finalParams[stagKey] ?? 12,
          checkSignal,
        }, pairData.trainEnd, pairData.h4.length);
        oosPnl += r.totalReturn;
        oosTrades += r.trades;
        oosMaxDays = Math.max(oosMaxDays, r.days);
        oosPnlPcts.push(...r.tradePnlPcts);
      }
      const oosPctPerDay = oosMaxDays > 0 ? (oosPnl / (MARGIN_PER_TRADE * loadedPairs.length)) / oosMaxDays * 100 : 0;
      const oosSharpe = sharpe(oosPnlPcts);
      console.log(`OOS [TEST]: Sharpe=${oosSharpe.toFixed(2)} ${oosPctPerDay.toFixed(3)}%/day T=${oosTrades} PnL=$${oosPnl.toFixed(2)}`);

      const enginePrefix = tuner.name.toUpperCase();
      const constBlock = Object.entries(finalParams).map(([k, v]) => {
        const isBool = k.endsWith("_ADX_NOT_DECL") || k.endsWith("_REVERSE_EXIT");
        const val = Number.isInteger(v) && !isBool ? v.toFixed(1) : String(v);
        return `export const ${k} = ${val};`;
      }).join("\n");
      constantsUpdates.push(`// ${enginePrefix} Engine -- TRAIN minSharpe=${phase3Best.sharpe.toFixed(2)} OOS Sharpe=${oosSharpe.toFixed(2)} OOS %/day=${oosPctPerDay.toFixed(3)}\n${constBlock}`);

      // ── Inline 3-fold walk-forward validation ─────────────────────────────
      const v = run3FoldValidation(loadedPairs, allPairData, tuner.name, finalParams, tuner, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey);
      validationSummary.push({ name: tuner.name, ...v, oosSharpe, oosPctPerDay });

      // Collect for ensemble subset testing
      allTunedEngines.push({
        tuner, finalParams, smaPeriodKey, adxMinKey, stopAtrKey, rrKey, stagKey,
        adxNDKey: Object.keys(finalParams).find((k) => k.endsWith("_ADX_NOT_DECL")),
        revExKey: Object.keys(finalParams).find((k) => k.endsWith("_REVERSE_EXIT")),
        trailActKey: Object.keys(finalParams).find((k) => k.endsWith("_TRAIL_ACTIVATION")),
        trailDistKey: Object.keys(finalParams).find((k) => k.endsWith("_TRAIL_DISTANCE")),
        oosSharpe, oosPctPerDay,
      });
    }
  }

  // ─── Ensemble Subset Tests ────────────────────────────────────────────────

  const ensembleSummaryRows: string[] = [];

  if (allTunedEngines.length >= 2) {
    console.log(`\n\n${"=".repeat(60)}`);
    console.log(`=== ENSEMBLE SUBSET TESTS (using overnight tuned params) ===`);
    console.log(`${"=".repeat(60)}`);

    // Sort by OOS Sharpe descending — best engines first
    const sortedByOOS = [...allTunedEngines].sort((a, b) => b.oosSharpe - a.oosSharpe);
    const n = sortedByOOS.length;

    const subsets: { label: string; engines: TunedEngineState[] }[] = [
      { label: `all-${n}`, engines: sortedByOOS },
    ];
    for (const topN of [7, 6, 5]) {
      if (topN < n) subsets.push({ label: `top-${topN}`, engines: sortedByOOS.slice(0, topN) });
    }

    const ensembleResults: { label: string; t: number; f1s: number; f2s: number; f3s: number; avgSharpe: number; avgPct: number; avgWR: number; oosSharpe: number; oosPct: number; oosT: number }[] = [];
    const trainEnd = allPairData[loadedPairs[0]].pairData.trainEnd;

    for (const subset of subsets) {
      for (const t of [2, 3]) {
        if (t > subset.engines.length) continue;
        console.log(`\n[${subset.label} t=${t}]  (${subset.engines.map((e) => e.tuner.name).join(", ")})`);

        const foldSharpes: number[] = [];
        const foldPcts: number[] = [];
        const foldWRs: number[] = [];

        for (const fold of FOLD_TEST_WINDOWS) {
          const r = runEnsembleFold(loadedPairs, allPairData, subset.engines, fold.start, fold.end, t);
          const s = sharpe(r.pnlPcts);
          const pct = r.maxDays > 0 ? (r.totalPnl / (MARGIN_PER_TRADE * loadedPairs.length)) / r.maxDays * 100 : 0;
          const wr = r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
          foldSharpes.push(s);
          foldPcts.push(pct);
          foldWRs.push(wr);
          console.log(`  ${fold.label}: T=${r.trades} WR=${wr.toFixed(1)}% Sharpe=${s.toFixed(2)} %/d=${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`);
        }

        const oosR = runEnsembleFold(loadedPairs, allPairData, subset.engines, trainEnd, Number.MAX_SAFE_INTEGER, t);
        const oosSharpe = sharpe(oosR.pnlPcts);
        const oosPct = oosR.maxDays > 0 ? (oosR.totalPnl / (MARGIN_PER_TRADE * loadedPairs.length)) / oosR.maxDays * 100 : 0;
        console.log(`  OOS: T=${oosR.trades} WR=${oosR.trades > 0 ? ((oosR.wins / oosR.trades) * 100).toFixed(1) : "n/a"}% Sharpe=${oosSharpe.toFixed(2)} %/d=${oosPct >= 0 ? "+" : ""}${oosPct.toFixed(3)}%`);

        ensembleResults.push({
          label: subset.label, t,
          f1s: foldSharpes[0], f2s: foldSharpes[1], f3s: foldSharpes[2],
          avgSharpe: foldSharpes.reduce((s, v) => s + v, 0) / foldSharpes.length,
          avgPct: foldPcts.reduce((s, v) => s + v, 0) / foldPcts.length,
          avgWR: foldWRs.reduce((s, v) => s + v, 0) / foldWRs.length,
          oosSharpe, oosPct, oosT: oosR.trades,
        });
      }
    }

    console.log(`\nENSEMBLE SUMMARY (sorted by AVG Sharpe):`);
    console.log(`Subset   | T | F1 Sharpe | F2 Sharpe | F3 Sharpe | AVG Sharpe | OOS Sharpe | OOS %/day`);
    console.log(`─────────────────────────────────────────────────────────────────────────────────────`);
    const sortedEnsemble = [...ensembleResults].sort((a, b) => b.avgSharpe - a.avgSharpe);
    for (const r of sortedEnsemble) {
      const sign = r.oosPct >= 0 ? "+" : "";
      const row = `${r.label.padEnd(8)} | ${r.t} | ${r.f1s.toFixed(2).padStart(9)} | ${r.f2s.toFixed(2).padStart(9)} | ${r.f3s.toFixed(2).padStart(9)} | ${r.avgSharpe.toFixed(2).padStart(10)} | ${r.oosSharpe.toFixed(2).padStart(10)} | ${(sign + r.oosPct.toFixed(3) + "%").padStart(9)}`;
      console.log(row);
      ensembleSummaryRows.push(row);
    }
  }

  // ─── Final Summary ────────────────────────────────────────────────────────

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`=== OVERNIGHT RESULTS SUMMARY ===`);
  console.log(`Completed: ${new Date().toISOString()}  (${elapsed} min)`);
  console.log(`${"=".repeat(60)}`);

  const sorted = [...validationSummary].sort((a, b) => b.oosSharpe - a.oosSharpe);
  const fmtRow = (v: typeof sorted[0]) => {
    const fs = v.foldSharpes;
    const sign = v.oosPctPerDay >= 0 ? "+" : "";
    return `${v.name.padEnd(8)} | ${fs[0].toFixed(2).padStart(9)} | ${fs[1].toFixed(2).padStart(9)} | ${(fs[2] ?? 0).toFixed(2).padStart(9)} | ${v.avgSharpe.toFixed(2).padStart(10)} | ${v.oosSharpe.toFixed(2).padStart(9)} | ${(sign + v.oosPctPerDay.toFixed(3) + "%").padStart(9)}`;
  };

  console.log(`\n3-FOLD WALK-FORWARD + OOS RESULTS (sorted by OOS Sharpe):`);
  console.log(`Engine   | F1 Sharpe | F2 Sharpe | F3 Sharpe | AVG Sharpe | OOS Sharpe | OOS %/day`);
  console.log(`─────────────────────────────────────────────────────────────────────────────────`);
  sorted.forEach((v) => console.log(fmtRow(v)));

  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`=== CONSTANTS UPDATE (copy into src/config/constants.ts) ===`);
  console.log(`${"=".repeat(60)}`);
  console.log(constantsUpdates.join("\n\n"));

  const output = [
    `=== tune-overnight.ts results — ${new Date().toISOString()} (${elapsed} min) ===\n`,
    `3-FOLD WALK-FORWARD + OOS (sorted by OOS Sharpe):\n`,
    `Engine   | F1 Sharpe | F2 Sharpe | F3 Sharpe | AVG Sharpe | OOS Sharpe | OOS %/day`,
    `─────────────────────────────────────────────────────────────────────────────────`,
    ...sorted.map(fmtRow),
    ensembleSummaryRows.length > 0 ? `\n\nENSEMBLE SUBSET RESULTS (sorted by AVG Sharpe):\nSubset   | T | F1 Sharpe | F2 Sharpe | F3 Sharpe | AVG Sharpe | OOS Sharpe | OOS %/day\n─────────────────────────────────────────────────────────────────────────────────────` : "",
    ...ensembleSummaryRows,
    `\n\nCONSTANTS UPDATE:\n`,
    constantsUpdates.join("\n\n"),
    `\n`,
  ].join("\n");

  fs.writeFileSync("/tmp/overnight-results.txt", output);
  console.log(`\nFull results saved to /tmp/overnight-results.txt`);
}

main().catch(console.error);
