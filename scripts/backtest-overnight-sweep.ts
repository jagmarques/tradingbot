// Overnight sweep: exhaustive strategy space exploration.
// Phase 1: Parameter sweep of all 9 existing engines (~60%)
// Phase 2: New indicators (Keltner, Donchian, Williams %R, Stochastic, ADX-only, Ichimoku) (~25%)
// Phase 3: Hybrid approaches (dual-confirm, inverted, cross-timeframe, adaptive trail) (~15%)
// Output: /tmp/overnight-sweep-results.txt
// Run: npx tsx scripts/backtest-overnight-sweep.ts 2>&1 | tee /tmp/overnight-sweep-results.txt

import { ATR, ADX, MACD, EMA, PSAR } from "technicalindicators";
import * as fs from "node:fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0; // Lighter DEX zero fees
const FUNDING_RATE_PER_8H = 0.0001;
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV;
const MIN_PAIR_BARS = 1500;
const DAYS_LOOKBACK = 730;

// Per-coin slippage (Lighter DEX orderbook, March 2026)
const SLIP_MAP: Record<string, number> = {
  BTC: 0.0001, ETH: 0.0001, SOL: 0.0002, XRP: 0.0002, DOGE: 0.0002,
  AVAX: 0.0003, LINK: 0.0005, ARB: 0.0005, BNB: 0.0002, OP: 0.0006,
  SUI: 0.0003, NEAR: 0.0006, WIF: 0.0005, kPEPE: 0.0003, kBONK: 0.0002,
  kFLOKI: 0.0006, kSHIB: 0.0008, HBAR: 0.0004, LTC: 0.001, TIA: 0.0006,
  SEI: 0.0006, JUP: 0.0009, PYTH: 0.0003, TAO: 0.0015, ADA: 0.0006,
  DOT: 0.0005, CRV: 0.0012, LDO: 0.0008, APT: 0.0007,
};
const DEFAULT_SLIP = 0.001;
function getSlip(pair: string): number { return SLIP_MAP[pair] ?? DEFAULT_SLIP; }

const PAIRS = ["BTC","ETH","SOL","XRP","DOGE","AVAX","LINK","ARB","BNB","OP","SUI","INJ","ATOM","APT","WIF","kPEPE","kBONK","kFLOKI","kSHIB","NEAR","RUNE","FET","LDO","CRV","HBAR","LTC","TIA","SEI","JUP","PYTH","TAO","ADA","DOT"];

// 3-fold walk-forward test windows (train on 0-67%, test on 3 folds)
const FOLD_WINDOWS = [
  { label: "F1", startRatio: 0.67, endRatio: 0.78 },
  { label: "F2", startRatio: 0.78, endRatio: 0.89 },
  { label: "F3", startRatio: 0.89, endRatio: 1.00 },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }
interface DailyPre { smaMap: Map<number, (number | null)[]>; adx: (number | null)[]; }

interface PairData {
  h4: Candle[];
  atr4h: (number | null)[];
  dailyCandles: Candle[];
  slippage: number;
  preDaily: DailyPre;
  idxDailyAt: number[];
}

interface EngineRunParams {
  smaPeriod: number;
  adxMin: number;
  adxNotDecl: boolean;
  reverseExit: boolean;
  trailActivation: number;
  trailDistance: number;
  stopAtrMult: number;
  rewardRisk: number;
  stagnationBars: number;
  checkSignal: (i: number) => "long" | "short" | null;
}

interface SweepResult {
  strategy: string;
  sharpe: number;
  pctPerDay: number;
  trades: number;
  winRate: number;
  maxDD: number;
  phase: number;
  foldSharpes: number[];
}

// ─── Fetch / Sleep ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function fetchCandlesOnce(coin: string, interval: string, days: number): Promise<Candle[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: Date.now() - days * 86400_000, endTime: Date.now() } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin} ${interval}`);
    const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
    return raw.map((c) => ({ timestamp: c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v })).sort((a, b) => a.timestamp - b.timestamp);
  } finally { clearTimeout(timeout); }
}

async function fetchCandles(coin: string, interval: string, days: number): Promise<Candle[]> {
  try { return await fetchCandlesOnce(coin, interval, days); }
  catch { await sleep(1500); return await fetchCandlesOnce(coin, interval, days); }
}

// ─── Indicator Functions ──────────────────────────────────────────────────────

function precomputeATR(candles: Candle[]): (number | null)[] {
  const n = candles.length;
  const atrRaw = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close), period: 14 });
  const arr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => { arr[n - atrRaw.length + i] = v; });
  return arr;
}

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPre {
  const n = candles.length, closes = candles.map(c => c.close);
  const adxRaw = ADX.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => { adxArr[n - adxRaw.length + i] = v?.adx ?? null; });
  const smaMap = new Map<number, (number | null)[]>();
  for (const period of smaPeriods) {
    const arr: (number | null)[] = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) { let sum = 0; for (let k = i - period + 1; k <= i; k++) sum += closes[k]; arr[i] = sum / period; }
    smaMap.set(period, arr);
  }
  return { smaMap, adx: adxArr };
}

function buildDailyIndex(h4: Candle[], daily: Candle[]): number[] {
  const idx: number[] = new Array(h4.length).fill(-1);
  let j = 0;
  for (let i = 0; i < h4.length; i++) { while (j < daily.length && daily[j].timestamp <= h4[i].timestamp) j++; idx[i] = j - 1; }
  return idx;
}

function computeZLEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length, lag = Math.floor((period - 1) / 2);
  const corrected: number[] = [];
  for (let i = lag; i < n; i++) corrected.push(closes[i] + (closes[i] - closes[i - lag]));
  const ema = EMA.calculate({ values: corrected, period });
  const result: (number | null)[] = new Array(n).fill(null);
  const start = lag + (period - 1);
  for (let i = 0; i < ema.length; i++) { if (start + i < n) result[start + i] = ema[i]; }
  return result;
}

function computeLocalEma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result = [ema];
  for (let i = period; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); result.push(ema); }
  return result;
}

function computeStcFull(closes: number[], fast: number, slow: number, cycle: number): number[] {
  if (closes.length < slow + cycle * 2) return [];
  const fE = computeLocalEma(closes, fast), sE = computeLocalEma(closes, slow);
  const off = fE.length - sE.length;
  const macd = sE.map((v, i) => fE[off + i] - v);
  if (macd.length < cycle) return [];
  const s1: number[] = [];
  for (let i = cycle - 1; i < macd.length; i++) { const w = macd.slice(i - cycle + 1, i + 1); const lo = Math.min(...w), hi = Math.max(...w), r = hi - lo; s1.push(r === 0 ? 50 : ((macd[i] - lo) / r) * 100); }
  if (!s1.length) return [];
  const sm1 = computeLocalEma(s1, cycle);
  if (sm1.length < cycle) return [];
  const s2: number[] = [];
  for (let i = cycle - 1; i < sm1.length; i++) { const w = sm1.slice(i - cycle + 1, i + 1); const lo = Math.min(...w), hi = Math.max(...w), r = hi - lo; s2.push(r === 0 ? 50 : ((sm1[i] - lo) / r) * 100); }
  if (!s2.length) return [];
  return computeLocalEma(s2, cycle).map(v => Math.min(100, Math.max(0, v)));
}

function mapStcToOriginal(closes: number[], fast: number, slow: number, cycle: number): (number | null)[] {
  const n = closes.length;
  const result: (number | null)[] = new Array(n).fill(null);
  const stc = computeStcFull(closes, fast, slow, cycle);
  for (let i = 0; i < stc.length; i++) { const j = n - stc.length + i; if (j >= 0) result[j] = stc[i]; }
  return result;
}

function computeDEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const e1 = EMA.calculate({ values: closes, period }), e2 = EMA.calculate({ values: e1, period });
  const result: (number | null)[] = new Array(n).fill(null);
  e2.forEach((v2, i) => { const j = i + (period - 1); const k = j + (period - 1); if (k < n) result[k] = 2 * e1[j] - v2; });
  return result;
}

function computeWMA(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const result: (number | null)[] = new Array(n).fill(null);
  const ws = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) { let sum = 0; for (let j = 0; j < period; j++) sum += values[i - period + 1 + j] * (j + 1); result[i] = sum / ws; }
  return result;
}

function computeHMA(closes: number[], period: number): (number | null)[] {
  const half = Math.max(2, Math.floor(period / 2)), sqrt = Math.max(2, Math.round(Math.sqrt(period)));
  const wH = computeWMA(closes, half), wF = computeWMA(closes, period);
  const start = period - 1;
  const diff: number[] = [];
  for (let i = start; i < closes.length; i++) { const h = wH[i], f = wF[i]; diff.push(h === null || f === null ? 0 : 2 * h - f); }
  const hma = computeWMA(diff, sqrt);
  const result: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < hma.length; i++) { if (start + i < closes.length) result[start + i] = hma[i]; }
  return result;
}

function precomputeCCI(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const sl = candles.slice(i - period + 1, i + 1);
    const tps = sl.map(c => (c.high + c.low + c.close) / 3);
    const sma = tps.reduce((s, v) => s + v, 0) / period;
    const md = tps.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    result[i] = md === 0 ? 0 : (tps[tps.length - 1] - sma) / (0.015 * md);
  }
  return result;
}

function precomputePSAR(candles: Candle[], step: number, max: number): (number | null)[] {
  const n = candles.length;
  const raw = PSAR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), step, max });
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < raw.length; i++) result[n - raw.length + i] = raw[i];
  return result;
}

function precomputeVortex(candles: Candle[], period: number): { vPlus: (number | null)[]; vMinus: (number | null)[] } {
  const n = candles.length;
  const vPlus: (number | null)[] = new Array(n).fill(null);
  const vMinus: (number | null)[] = new Array(n).fill(null);
  for (let end = period; end < n; end++) {
    let vmP = 0, vmM = 0, trS = 0;
    for (let i = end - period + 1; i <= end; i++) {
      if (i <= 0) { vmP = 0; vmM = 0; trS = 0; break; }
      vmP += Math.abs(candles[i].high - candles[i-1].low);
      vmM += Math.abs(candles[i].low - candles[i-1].high);
      trS += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
    }
    if (trS > 0) { vPlus[end] = vmP / trS; vMinus[end] = vmM / trS; }
  }
  return { vPlus, vMinus };
}

// ─── NEW Indicator Functions (Phase 2) ────────────────────────────────────────

function computeKeltner(candles: Candle[], emaPeriod: number, atrPeriod: number, mult: number): { upper: (number | null)[]; lower: (number | null)[]; mid: (number | null)[] } {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const emaRaw = EMA.calculate({ values: closes, period: emaPeriod });
  const atrRaw = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes, period: atrPeriod });
  const mid: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const emaStart = n - emaRaw.length;
  const atrStart = n - atrRaw.length;
  for (let i = 0; i < n; i++) {
    const ei = i - emaStart;
    const ai = i - atrStart;
    if (ei >= 0 && ei < emaRaw.length && ai >= 0 && ai < atrRaw.length) {
      mid[i] = emaRaw[ei];
      upper[i] = emaRaw[ei] + mult * atrRaw[ai];
      lower[i] = emaRaw[ei] - mult * atrRaw[ai];
    }
  }
  return { upper, lower, mid };
}

function computeDonchian(candles: Candle[], period: number): { upper: (number | null)[]; lower: (number | null)[] } {
  const n = candles.length;
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

function computeWilliamsR(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    const range = hi - lo;
    result[i] = range === 0 ? -50 : ((hi - candles[i].close) / range) * -100;
  }
  return result;
}

function computeStochastic(candles: Candle[], kPeriod: number, dPeriod: number, smooth: number): { k: (number | null)[]; d: (number | null)[] } {
  const n = candles.length;
  // Raw %K
  const rawK: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    const range = hi - lo;
    rawK[i] = range === 0 ? 50 : ((candles[i].close - lo) / range) * 100;
  }
  // Smooth %K (SMA of rawK)
  const k: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1 + smooth - 1; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = i - smooth + 1; j <= i; j++) { if (rawK[j] !== null) { sum += rawK[j]!; cnt++; } }
    if (cnt === smooth) k[i] = sum / cnt;
  }
  // %D (SMA of smoothed %K)
  const d: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < dPeriod - 1) continue;
    let sum = 0, cnt = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) { if (k[j] !== null) { sum += k[j]!; cnt++; } }
    if (cnt === dPeriod) d[i] = sum / cnt;
  }
  return { k, d };
}

function computeADXComponents(candles: Candle[], period: number): { adx: (number | null)[]; plusDI: (number | null)[]; minusDI: (number | null)[] } {
  const n = candles.length;
  const adx: (number | null)[] = new Array(n).fill(null);
  const plusDI: (number | null)[] = new Array(n).fill(null);
  const minusDI: (number | null)[] = new Array(n).fill(null);
  // Manual Wilder smoothed DI/ADX
  if (n < period + 1) return { adx, plusDI, minusDI };
  const trArr: number[] = [];
  const dmPArr: number[] = [];
  const dmMArr: number[] = [];
  for (let i = 1; i < n; i++) {
    const hi = candles[i].high, lo = candles[i].low, pc = candles[i-1].close;
    trArr.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
    const up = hi - candles[i-1].high;
    const dn = candles[i-1].low - lo;
    dmPArr.push(up > dn && up > 0 ? up : 0);
    dmMArr.push(dn > up && dn > 0 ? dn : 0);
  }
  // Initial sums
  let trSum = 0, dmPSum = 0, dmMSum = 0;
  for (let i = 0; i < period; i++) { trSum += trArr[i]; dmPSum += dmPArr[i]; dmMSum += dmMArr[i]; }
  let smoothTR = trSum, smoothDMP = dmPSum, smoothDMM = dmMSum;
  const diPArr: number[] = [];
  const diMArr: number[] = [];
  const dxArr: number[] = [];
  for (let i = period; i < trArr.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trArr[i];
      smoothDMP = smoothDMP - smoothDMP / period + dmPArr[i];
      smoothDMM = smoothDMM - smoothDMM / period + dmMArr[i];
    }
    const diP = smoothTR > 0 ? (smoothDMP / smoothTR) * 100 : 0;
    const diM = smoothTR > 0 ? (smoothDMM / smoothTR) * 100 : 0;
    diPArr.push(diP);
    diMArr.push(diM);
    const diSum = diP + diM;
    dxArr.push(diSum > 0 ? (Math.abs(diP - diM) / diSum) * 100 : 0);
    const origIdx = i + 1; // +1 because trArr starts at candle index 1
    plusDI[origIdx] = diP;
    minusDI[origIdx] = diM;
  }
  // Smoothed ADX
  if (dxArr.length >= period) {
    let adxSmooth = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    adx[period + period] = adxSmooth;
    for (let i = period; i < dxArr.length; i++) {
      adxSmooth = (adxSmooth * (period - 1) + dxArr[i]) / period;
      const origIdx = i + 1 + period; // approximate mapping
      if (origIdx < n) adx[origIdx] = adxSmooth;
    }
  }
  return { adx, plusDI, minusDI };
}

function computeIchimoku(candles: Candle[], tenkan: number, kijun: number, senkou: number): {
  tenkanSen: (number | null)[]; kijunSen: (number | null)[];
  senkouA: (number | null)[]; senkouB: (number | null)[];
} {
  const n = candles.length;
  const tenkanSen: (number | null)[] = new Array(n).fill(null);
  const kijunSen: (number | null)[] = new Array(n).fill(null);
  const senkouA: (number | null)[] = new Array(n).fill(null);
  const senkouB: (number | null)[] = new Array(n).fill(null);

  function midHL(start: number, end: number): number {
    let hi = -Infinity, lo = Infinity;
    for (let i = start; i <= end; i++) { hi = Math.max(hi, candles[i].high); lo = Math.min(lo, candles[i].low); }
    return (hi + lo) / 2;
  }

  for (let i = 0; i < n; i++) {
    if (i >= tenkan - 1) tenkanSen[i] = midHL(i - tenkan + 1, i);
    if (i >= kijun - 1) kijunSen[i] = midHL(i - kijun + 1, i);
    if (tenkanSen[i] !== null && kijunSen[i] !== null) {
      // Senkou A displaced forward by kijun periods (we store at current for signal comparison)
      senkouA[i] = (tenkanSen[i]! + kijunSen[i]!) / 2;
    }
    if (i >= senkou - 1) {
      senkouB[i] = midHL(i - senkou + 1, i);
    }
  }
  return { tenkanSen, kijunSen, senkouA, senkouB };
}

// ─── Sharpe Calculation ───────────────────────────────────────────────────────

function sharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}

// ─── Single-engine Backtest Runner ────────────────────────────────────────────

function runSingleEngine(
  allPairData: Map<string, PairData>,
  params: Omit<EngineRunParams, "checkSignal">,
  buildSignal: (candles: Candle[], closes: number[]) => ((i: number) => "long" | "short" | null),
  startRatio: number,
  endRatio: number,
): { trades: number; wins: number; pnl: number; maxDD: number; days: number; tradePnlPcts: number[] } {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, peakPnl = 0, maxDD = 0, totalDays = 0;
  const allPnlPcts: number[] = [];

  for (const [pair, pd] of allPairData) {
    const { h4, atr4h, preDaily, idxDailyAt, slippage } = pd;
    const n = h4.length;
    const startIdx = Math.floor(n * startRatio);
    const endIdx = Math.floor(n * endRatio);
    if (endIdx - startIdx < 50) continue;

    const closes = h4.map(c => c.close);
    const checkSignal = buildSignal(h4, closes);

    type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peakPnlPct: number; fundingPaid: number };
    let pos: Pos | null = null;

    for (let i = startIdx; i < endIdx; i++) {
      const c = h4[i];
      if (pos !== null) {
        const barsHeld = i - pos.entryIdx;
        if (barsHeld > 0 && barsHeld % 2 === 0) pos.fundingPaid += NOTIONAL * FUNDING_RATE_PER_8H;
        const pricePct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
        const unrealizedPct = pricePct * LEV * 100;
        pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);
        const trailingHit = pos.peakPnlPct > params.trailActivation && unrealizedPct <= pos.peakPnlPct - params.trailDistance;
        const stagHit = barsHeld >= params.stagnationBars;

        let exitPrice: number | null = null;
        if (pos.dir === "long" && c.open < pos.sl) exitPrice = c.open;
        else if (pos.dir === "short" && c.open > pos.sl) exitPrice = c.open;
        else {
          const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
          const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;
          if (trailingHit) exitPrice = c.close;
          else if (stagHit) exitPrice = c.close;
          else if (slHit && tpHit) exitPrice = pos.sl;
          else if (slHit) exitPrice = pos.sl;
          else if (tpHit) exitPrice = pos.tp;
          else if (params.reverseExit) {
            const rev = checkSignal(i);
            if ((pos.dir === "long" && rev === "short") || (pos.dir === "short" && rev === "long")) exitPrice = c.close;
          }
        }

        if (exitPrice !== null) {
          const pp = ((exitPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
          const net = pp * NOTIONAL - NOTIONAL * FEE_RATE - 2 * NOTIONAL * slippage - pos.fundingPaid;
          totalPnl += net;
          peakPnl = Math.max(peakPnl, totalPnl);
          maxDD = Math.max(maxDD, peakPnl - totalPnl);
          totalTrades++;
          if (net > 0) totalWins++;
          allPnlPcts.push((net / MARGIN_PER_TRADE) * 100);
          pos = null;
        }
      }

      if (pos === null && i + 1 < endIdx) {
        const dIdx = idxDailyAt[i];
        if (dIdx < 0) continue;
        const dailySma = preDaily.smaMap.get(params.smaPeriod)?.[dIdx] ?? null;
        const dailyAdx = preDaily.adx[dIdx];
        const dailyClose = pd.dailyCandles[dIdx]?.close;
        if (dailySma === null || dailyAdx === null || dailyClose === undefined) continue;
        if (dailyAdx < params.adxMin) continue;
        if (params.adxNotDecl && dIdx >= 2) {
          const prev = preDaily.adx[dIdx - 2];
          if (prev !== null && dailyAdx < prev) continue;
        }
        const rawSignal = checkSignal(i);
        if (rawSignal === null) continue;
        let dir: "long" | "short" | null = null;
        if (rawSignal === "long" && dailyClose > dailySma) dir = "long";
        if (rawSignal === "short" && dailyClose < dailySma) dir = "short";
        if (dir === null) continue;

        const entryPrice = h4[i + 1].open;
        const atr = atr4h[i] ?? c.close * 0.02;
        const stopDist = atr * params.stopAtrMult;
        const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
        const tp = dir === "long" ? entryPrice + stopDist * params.rewardRisk : entryPrice - stopDist * params.rewardRisk;
        pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peakPnlPct: 0, fundingPaid: 0 };
      }
    }

    // Close open position at end
    if (pos !== null) {
      const endI = Math.min(endIdx - 1, h4.length - 1);
      const pp = ((h4[endI].close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
      const net = pp * NOTIONAL - NOTIONAL * FEE_RATE - 2 * NOTIONAL * slippage - pos.fundingPaid;
      totalPnl += net;
      totalTrades++;
      if (net > 0) totalWins++;
      allPnlPcts.push((net / MARGIN_PER_TRADE) * 100);
    }

    const startTs = h4[startIdx]?.timestamp ?? 0;
    const endTs = h4[Math.min(endIdx - 1, h4.length - 1)]?.timestamp ?? 0;
    totalDays = Math.max(totalDays, (endTs - startTs) / 86400_000);
  }

  return { trades: totalTrades, wins: totalWins, pnl: totalPnl, maxDD, days: totalDays, tradePnlPcts: allPnlPcts };
}

// ─── 3-Fold Walk-Forward Evaluation ──────────────────────────────────────────

function evaluate3Fold(
  allPairData: Map<string, PairData>,
  params: Omit<EngineRunParams, "checkSignal">,
  buildSignal: (candles: Candle[], closes: number[]) => ((i: number) => "long" | "short" | null),
): SweepResult | null {
  const foldSharpes: number[] = [];
  let totalTrades = 0, totalWins = 0, totalPnl = 0, totalDays = 0, worstDD = 0;

  for (const fold of FOLD_WINDOWS) {
    const r = runSingleEngine(allPairData, params, buildSignal, fold.startRatio, fold.endRatio);
    foldSharpes.push(sharpe(r.tradePnlPcts));
    totalTrades += r.trades;
    totalWins += r.wins;
    totalPnl += r.pnl;
    totalDays += r.days;
    worstDD = Math.max(worstDD, r.maxDD);
  }

  if (totalTrades < 10) return null;
  const avgSharpe = foldSharpes.reduce((s, v) => s + v, 0) / foldSharpes.length;
  const pctPerDay = totalDays > 0 ? (totalPnl / (MARGIN_PER_TRADE * allPairData.size)) / totalDays * 100 : 0;
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  return {
    strategy: "",
    sharpe: avgSharpe,
    pctPerDay,
    trades: totalTrades,
    winRate,
    maxDD: worstDD,
    phase: 0,
    foldSharpes,
  };
}

// ─── Phase 1: Parameter Sweeps for Existing Engines ──────────────────────────

interface EngineSweeperConfig {
  name: string;
  currentParams: Record<string, number>;
  paramRanges: Record<string, number[]>;
  buildSignal: (candles: Candle[], closes: number[], p: Record<string, number>) => ((i: number) => "long" | "short" | null);
  riskParams: { stopAtrMult: number; rewardRisk: number; stagnationBars: number; trailActivation: number; trailDistance: number; smaPeriod: number; adxMin: number; adxNotDecl: boolean; reverseExit: boolean };
}

function buildPhase1Engines(): EngineSweeperConfig[] {
  return [
    // HMA-4h
    {
      name: "HMA-4h",
      currentParams: { fast: 3, slow: 50, stopAtr: 3.0, rr: 6.0, stag: 10 },
      paramRanges: { fast: [2, 3, 4, 5], slow: [40, 50, 60], stopAtr: [2.0, 3.0, 4.0], rr: [4, 6, 8], stag: [8, 10, 12] },
      buildSignal: (candles, closes, p) => {
        const hF = computeHMA(closes, p.fast);
        const hS = computeHMA(closes, p.slow);
        return (i) => {
          const cf = hF[i], pf = hF[i-1], cs = hS[i], ps = hS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 3.0, rewardRisk: 6.0, stagnationBars: 10, trailActivation: 5, trailDistance: 2, smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false },
    },
    // ZLEMA-4h
    {
      name: "ZLEMA-4h",
      currentParams: { fast: 4, slow: 40, stopAtr: 2.5, rr: 4.0, stag: 10 },
      paramRanges: { fast: [6, 8, 10, 12], slow: [26, 30, 34, 40], stopAtr: [3.0, 4.0, 5.0], rr: [3, 4, 5], stag: [8, 10, 12] },
      buildSignal: (candles, closes, p) => {
        const zF = computeZLEMA(closes, p.fast);
        const zS = computeZLEMA(closes, p.slow);
        return (i) => {
          const cf = zF[i], pf = zF[i-1], cs = zS[i], ps = zS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 2.5, rewardRisk: 4.0, stagnationBars: 10, trailActivation: 3, trailDistance: 2, smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false },
    },
    // Schaff-4h
    {
      name: "Schaff-4h",
      currentParams: { fast: 8, slow: 20, cycle: 12, thresh: 40, stopAtr: 3.5, rr: 4.0, stag: 9 },
      paramRanges: { fast: [6, 8, 10], slow: [16, 20, 24], cycle: [10, 12, 14], thresh: [30, 40, 50], stopAtr: [2.5, 3.5, 4.5], rr: [3, 4, 5], stag: [8, 10, 12] },
      buildSignal: (candles, closes, p) => {
        const stc = mapStcToOriginal(closes, p.fast, p.slow, p.cycle);
        const t = p.thresh;
        return (i) => {
          const c = stc[i], prev = stc[i-1];
          if (c === null || prev === null) return null;
          if (prev <= t && c > t) return "long";
          if (prev >= (100 - t) && c < (100 - t)) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 3.5, rewardRisk: 4.0, stagnationBars: 9, trailActivation: 5, trailDistance: 2, smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false },
    },
    // DEMA-4h
    {
      name: "DEMA-4h",
      currentParams: { fast: 5, slow: 21, stopAtr: 3.0, rr: 4.0, stag: 16 },
      paramRanges: { fast: [3, 5, 7], slow: [18, 21, 25], stopAtr: [2.0, 3.0, 4.0], rr: [3, 4, 5], stag: [12, 16, 20] },
      buildSignal: (candles, closes, p) => {
        const dF = computeDEMA(closes, p.fast);
        const dS = computeDEMA(closes, p.slow);
        return (i) => {
          const cf = dF[i], pf = dF[i-1], cs = dS[i], ps = dS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 3.0, rewardRisk: 4.0, stagnationBars: 16, trailActivation: 5, trailDistance: 2, smaPeriod: 50, adxMin: 10, adxNotDecl: false, reverseExit: false },
    },
    // PSAR-4h
    {
      name: "PSAR-4h",
      currentParams: { step: 0.008, max: 0.12, stopAtr: 3.0, rr: 4.0, stag: 16 },
      paramRanges: { step: [0.005, 0.008, 0.015, 0.02, 0.03], max: [0.08, 0.1, 0.12, 0.15], stopAtr: [4.0, 5.0, 6.0], rr: [4, 6, 8], stag: [12, 16, 20] },
      buildSignal: (candles, closes, p) => {
        const psar = precomputePSAR(candles, p.step, p.max);
        return (i) => {
          const cs = psar[i], ps = psar[i-1];
          if (cs === null || ps === null) return null;
          const cc = candles[i].close, pc = candles[i-1].close;
          if (ps > pc && cs < cc) return "long";
          if (ps < pc && cs > cc) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 3.0, rewardRisk: 4.0, stagnationBars: 16, trailActivation: 8, trailDistance: 2, smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false },
    },
    // Vortex-4h
    {
      name: "Vortex-4h",
      currentParams: { period: 25, stopAtr: 5.0, rr: 4.0, stag: 10 },
      paramRanges: { period: [10, 14, 20, 25], stopAtr: [4.0, 5.0, 6.0], rr: [3, 4, 5], stag: [8, 10, 14] },
      buildSignal: (candles, closes, p) => {
        const v = precomputeVortex(candles, p.period);
        return (i) => {
          const cp = v.vPlus[i], cm = v.vMinus[i], pp = v.vPlus[i-1], pm = v.vMinus[i-1];
          if (cp === null || cm === null || pp === null || pm === null) return null;
          if (pp <= pm && cp > cm) return "long";
          if (pp >= pm && cp < cm) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 5.0, rewardRisk: 4.0, stagnationBars: 10, trailActivation: 5, trailDistance: 2, smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false },
    },
    // CCI-4h
    {
      name: "CCI-4h",
      currentParams: { period: 20, thresh: 85, stopAtr: 2.5, rr: 4.0, stag: 10 },
      paramRanges: { period: [10, 14, 20], thresh: [80, 100, 120], stopAtr: [2.5, 3.5, 4.5], rr: [3, 4, 5], stag: [8, 10, 14] },
      buildSignal: (candles, closes, p) => {
        const cci = precomputeCCI(candles, p.period);
        const t = p.thresh;
        return (i) => {
          const c = cci[i], prev = cci[i-1];
          if (c === null || prev === null) return null;
          if (prev <= t && c > t) return "long";
          if (prev >= -t && c < -t) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 2.5, rewardRisk: 4.0, stagnationBars: 10, trailActivation: 3, trailDistance: 2, smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: true },
    },
    // HMA-1h (uses 4h data for backtest simplicity, but with 1h-like params)
    {
      name: "HMA-1h-on4h",
      currentParams: { fast: 11, slow: 32, stopAtr: 0.75, rr: 50, stag: 72 },
      paramRanges: { fast: [8, 11, 14], slow: [26, 32, 38], stopAtr: [0.5, 0.75, 1.0], rr: [30, 50, 70], stag: [48, 72, 96] },
      buildSignal: (candles, closes, p) => {
        const hF = computeHMA(closes, p.fast);
        const hS = computeHMA(closes, p.slow);
        return (i) => {
          const cf = hF[i], pf = hF[i-1], cs = hS[i], ps = hS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 0.75, rewardRisk: 50, stagnationBars: 72, trailActivation: 8, trailDistance: 1, smaPeriod: 50, adxMin: 10, adxNotDecl: false, reverseExit: false },
    },
    // ZLEMA-1h (on 4h data with 1h-like params)
    {
      name: "ZLEMA-1h-on4h",
      currentParams: { fast: 10, slow: 21, stopAtr: 0.75, rr: 40, stag: 72 },
      paramRanges: { fast: [8, 10, 12], slow: [18, 21, 26], stopAtr: [0.5, 0.75, 1.0], rr: [25, 40, 55], stag: [48, 72, 96] },
      buildSignal: (candles, closes, p) => {
        const zF = computeZLEMA(closes, p.fast);
        const zS = computeZLEMA(closes, p.slow);
        return (i) => {
          const cf = zF[i], pf = zF[i-1], cs = zS[i], ps = zS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      riskParams: { stopAtrMult: 0.75, rewardRisk: 40, stagnationBars: 72, trailActivation: 8, trailDistance: 2, smaPeriod: 50, adxMin: 10, adxNotDecl: false, reverseExit: true },
    },
  ];
}

function runPhase1OAT(engine: EngineSweeperConfig, allPairData: Map<string, PairData>): SweepResult[] {
  const results: SweepResult[] = [];
  const { currentParams, paramRanges, riskParams } = engine;

  // One-at-a-time: sweep each param while holding others at current
  const bestPerParam: Record<string, number> = { ...currentParams };

  for (const [paramKey, values] of Object.entries(paramRanges)) {
    let bestVal = currentParams[paramKey];
    let bestSharpe = -Infinity;

    for (const val of values) {
      const testParams = { ...bestPerParam, [paramKey]: val };
      const rp = {
        smaPeriod: riskParams.smaPeriod,
        adxMin: riskParams.adxMin,
        adxNotDecl: riskParams.adxNotDecl,
        reverseExit: riskParams.reverseExit,
        trailActivation: testParams.trailAct ?? riskParams.trailActivation,
        trailDistance: testParams.trailDist ?? riskParams.trailDistance,
        stopAtrMult: testParams.stopAtr ?? riskParams.stopAtrMult,
        rewardRisk: testParams.rr ?? riskParams.rewardRisk,
        stagnationBars: testParams.stag ?? riskParams.stagnationBars,
      };

      const result = evaluate3Fold(allPairData, rp, (candles, closes) => engine.buildSignal(candles, closes, testParams));
      if (result) {
        const paramStr = Object.entries(testParams).map(([k, v]) => `${k}=${v}`).join(",");
        result.strategy = `${engine.name}(${paramStr})`;
        result.phase = 1;
        results.push(result);
        if (result.sharpe > bestSharpe) { bestSharpe = result.sharpe; bestVal = val; }
      }
    }
    bestPerParam[paramKey] = bestVal;
  }

  // Test the combined best from OAT
  const combinedRp = {
    smaPeriod: riskParams.smaPeriod,
    adxMin: riskParams.adxMin,
    adxNotDecl: riskParams.adxNotDecl,
    reverseExit: riskParams.reverseExit,
    trailActivation: bestPerParam.trailAct ?? riskParams.trailActivation,
    trailDistance: bestPerParam.trailDist ?? riskParams.trailDistance,
    stopAtrMult: bestPerParam.stopAtr ?? riskParams.stopAtrMult,
    rewardRisk: bestPerParam.rr ?? riskParams.rewardRisk,
    stagnationBars: bestPerParam.stag ?? riskParams.stagnationBars,
  };
  const combinedResult = evaluate3Fold(allPairData, combinedRp, (candles, closes) => engine.buildSignal(candles, closes, bestPerParam));
  if (combinedResult) {
    const paramStr = Object.entries(bestPerParam).map(([k, v]) => `${k}=${v}`).join(",");
    combinedResult.strategy = `${engine.name}-OAT-BEST(${paramStr})`;
    combinedResult.phase = 1;
    results.push(combinedResult);
  }

  // Trail sweep
  for (const tAct of [3, 10, 20, 30, 42]) {
    for (const tDist of [2, 4, 6, 8]) {
      const rp = {
        ...combinedRp,
        trailActivation: tAct,
        trailDistance: tDist,
      };
      const r = evaluate3Fold(allPairData, rp, (candles, closes) => engine.buildSignal(candles, closes, bestPerParam));
      if (r) {
        r.strategy = `${engine.name}-trail(act=${tAct},dist=${tDist})`;
        r.phase = 1;
        results.push(r);
      }
    }
  }

  return results;
}

// ─── Phase 2: New Indicator Strategies ───────────────────────────────────────

interface NewIndicatorConfig {
  name: string;
  paramGrid: Record<string, number[]>;
  buildSignal: (candles: Candle[], closes: number[], p: Record<string, number>) => ((i: number) => "long" | "short" | null);
}

function buildPhase2Indicators(): NewIndicatorConfig[] {
  return [
    // 1. Keltner Channel
    {
      name: "Keltner",
      paramGrid: { emaPeriod: [15, 20, 25], atrPeriod: [10, 14], mult: [1.5, 2.0, 2.5, 3.0] },
      buildSignal: (candles, closes, p) => {
        const kc = computeKeltner(candles, p.emaPeriod, p.atrPeriod, p.mult);
        return (i) => {
          if (kc.upper[i] === null || kc.lower[i] === null) return null;
          if (candles[i].close > kc.upper[i]! && (i === 0 || candles[i-1].close <= (kc.upper[i-1] ?? Infinity))) return "long";
          if (candles[i].close < kc.lower[i]! && (i === 0 || candles[i-1].close >= (kc.lower[i-1] ?? -Infinity))) return "short";
          return null;
        };
      },
    },
    // 2. Donchian Channel Breakout
    {
      name: "Donchian",
      paramGrid: { period: [20, 30, 50, 70] },
      buildSignal: (candles, closes, p) => {
        const dc = computeDonchian(candles, p.period);
        return (i) => {
          if (i < 1 || dc.upper[i-1] === null || dc.lower[i-1] === null) return null;
          // Breakout above previous bar upper channel
          if (candles[i].close > dc.upper[i-1]!) return "long";
          if (candles[i].close < dc.lower[i-1]!) return "short";
          return null;
        };
      },
    },
    // 3. Williams %R
    {
      name: "WilliamsR",
      paramGrid: { period: [10, 14, 21, 28] },
      buildSignal: (candles, closes, p) => {
        const wr = computeWilliamsR(candles, p.period);
        return (i) => {
          if (i < 1 || wr[i] === null || wr[i-1] === null) return null;
          // Cross above -80 from below
          if (wr[i-1]! <= -80 && wr[i]! > -80) return "long";
          // Cross below -20 from above
          if (wr[i-1]! >= -20 && wr[i]! < -20) return "short";
          return null;
        };
      },
    },
    // 4. Stochastic Oscillator
    {
      name: "Stochastic",
      paramGrid: { kPeriod: [9, 14, 21], dPeriod: [3, 5], smooth: [3, 5] },
      buildSignal: (candles, closes, p) => {
        const st = computeStochastic(candles, p.kPeriod, p.dPeriod, p.smooth);
        return (i) => {
          if (i < 1 || st.k[i] === null || st.d[i] === null || st.k[i-1] === null || st.d[i-1] === null) return null;
          // %K crosses above %D below 20
          if (st.k[i-1]! < st.d[i-1]! && st.k[i]! > st.d[i]! && st.k[i]! < 20) return "long";
          // %K crosses below %D above 80
          if (st.k[i-1]! > st.d[i-1]! && st.k[i]! < st.d[i]! && st.k[i]! > 80) return "short";
          return null;
        };
      },
    },
    // 5. ADX Trend Following (pure)
    {
      name: "ADX-Pure",
      paramGrid: { adxThresh: [20, 25, 30], period: [10, 14, 20] },
      buildSignal: (candles, closes, p) => {
        const comp = computeADXComponents(candles, p.period);
        return (i) => {
          if (comp.adx[i] === null || comp.plusDI[i] === null || comp.minusDI[i] === null) return null;
          if (comp.adx[i]! < p.adxThresh) return null;
          // Check for crossover
          if (i < 1 || comp.plusDI[i-1] === null || comp.minusDI[i-1] === null) return null;
          if (comp.plusDI[i-1]! <= comp.minusDI[i-1]! && comp.plusDI[i]! > comp.minusDI[i]!) return "long";
          if (comp.minusDI[i-1]! <= comp.plusDI[i-1]! && comp.minusDI[i]! > comp.plusDI[i]!) return "short";
          return null;
        };
      },
    },
    // 6. Ichimoku Cloud
    {
      name: "Ichimoku",
      paramGrid: { tenkan: [7, 9, 13], kijun: [22, 26, 30], senkou: [44, 52, 60] },
      buildSignal: (candles, closes, p) => {
        const ich = computeIchimoku(candles, p.tenkan, p.kijun, p.senkou);
        return (i) => {
          if (ich.tenkanSen[i] === null || ich.kijunSen[i] === null || ich.senkouA[i] === null || ich.senkouB[i] === null) return null;
          if (i < 1 || ich.tenkanSen[i-1] === null || ich.kijunSen[i-1] === null) return null;
          const cloudTop = Math.max(ich.senkouA[i]!, ich.senkouB[i]!);
          const cloudBot = Math.min(ich.senkouA[i]!, ich.senkouB[i]!);
          const price = candles[i].close;
          // Long: price above cloud + tenkan crosses above kijun
          if (price > cloudTop && ich.tenkanSen[i-1]! <= ich.kijunSen[i-1]! && ich.tenkanSen[i]! > ich.kijunSen[i]!) return "long";
          // Short: price below cloud + tenkan crosses below kijun
          if (price < cloudBot && ich.tenkanSen[i-1]! >= ich.kijunSen[i-1]! && ich.tenkanSen[i]! < ich.kijunSen[i]!) return "short";
          return null;
        };
      },
    },
  ];
}

function runPhase2(indicators: NewIndicatorConfig[], allPairData: Map<string, PairData>): SweepResult[] {
  const results: SweepResult[] = [];
  const riskGrid = [
    { stopAtr: 2.5, rr: 3, stag: 8, trailAct: 20, trailDist: 5 },
    { stopAtr: 3.5, rr: 4, stag: 10, trailAct: 25, trailDist: 5 },
    { stopAtr: 5.0, rr: 6, stag: 14, trailAct: 10, trailDist: 3 },
  ];

  for (let ii = 0; ii < indicators.length; ii++) {
    const ind = indicators[ii];
    const combos = cartesian(ind.paramGrid);
    console.log(`  Phase 2: ${ind.name} (${combos.length} signal combos x ${riskGrid.length} risk = ${combos.length * riskGrid.length} total)`);

    let done = 0;
    for (const combo of combos) {
      for (const risk of riskGrid) {
        const rp = {
          smaPeriod: 50,
          adxMin: 0,
          adxNotDecl: false,
          reverseExit: false,
          trailActivation: risk.trailAct,
          trailDistance: risk.trailDist,
          stopAtrMult: risk.stopAtr,
          rewardRisk: risk.rr,
          stagnationBars: risk.stag,
        };
        const r = evaluate3Fold(allPairData, rp, (candles, closes) => ind.buildSignal(candles, closes, combo));
        if (r) {
          const sigStr = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(",");
          r.strategy = `${ind.name}(${sigStr},atr=${risk.stopAtr},rr=${risk.rr},stag=${risk.stag},t=${risk.trailAct}/${risk.trailDist})`;
          r.phase = 2;
          results.push(r);
        }
        done++;
      }
    }
    console.log(`    -> ${done} tested, ${results.filter(r => r.strategy.startsWith(ind.name)).length} with 10+ trades`);
  }

  return results;
}

// ─── Phase 3: Hybrid Approaches ─────────────────────────────────────────────

function runPhase3(allPairData: Map<string, PairData>, phase1Results: SweepResult[]): SweepResult[] {
  const results: SweepResult[] = [];

  // 3a. Dual-indicator confirmation
  console.log("  Phase 3a: Dual-indicator confirmation...");
  const dualCombos: { name: string; build1: (c: Candle[], cl: number[]) => (i: number) => "long" | "short" | null; build2: (c: Candle[], cl: number[]) => (i: number) => "long" | "short" | null }[] = [
    {
      name: "ZLEMA+CCI",
      build1: (c, cl) => { const f = computeZLEMA(cl, 4), s = computeZLEMA(cl, 40); return (i) => { const cf = f[i], pf = f[i-1], cs = s[i], ps = s[i-1]; if (cf===null||pf===null||cs===null||ps===null) return null; if (pf<=ps&&cf>cs) return "long"; if (pf>=ps&&cf<cs) return "short"; return null; }; },
      build2: (c, cl) => { const cci = precomputeCCI(c, 20); return (i) => { const cv = cci[i], pv = cci[i-1]; if (cv===null||pv===null) return null; if (pv<=85&&cv>85) return "long"; if (pv>=-85&&cv<-85) return "short"; return null; }; },
    },
    {
      name: "HMA+Schaff",
      build1: (c, cl) => { const f = computeHMA(cl, 3), s = computeHMA(cl, 50); return (i) => { const cf = f[i], pf = f[i-1], cs = s[i], ps = s[i-1]; if (cf===null||pf===null||cs===null||ps===null) return null; if (pf<=ps&&cf>cs) return "long"; if (pf>=ps&&cf<cs) return "short"; return null; }; },
      build2: (c, cl) => { const stc = mapStcToOriginal(cl, 8, 20, 12); return (i) => { const cv = stc[i], pv = stc[i-1]; if (cv===null||pv===null) return null; if (pv<=40&&cv>40) return "long"; if (pv>=60&&cv<60) return "short"; return null; }; },
    },
    {
      name: "DEMA+Vortex",
      build1: (c, cl) => { const f = computeDEMA(cl, 5), s = computeDEMA(cl, 21); return (i) => { const cf = f[i], pf = f[i-1], cs = s[i], ps = s[i-1]; if (cf===null||pf===null||cs===null||ps===null) return null; if (pf<=ps&&cf>cs) return "long"; if (pf>=ps&&cf<cs) return "short"; return null; }; },
      build2: (c, cl) => { const v = precomputeVortex(c, 25); return (i) => { const cp = v.vPlus[i], cm = v.vMinus[i]; if (cp===null||cm===null) return null; return cp > cm ? "long" : "short"; }; },
    },
    {
      name: "Keltner+ADX",
      build1: (c, cl) => { const kc = computeKeltner(c, 20, 10, 2.0); return (i) => { if (kc.upper[i]===null||kc.lower[i]===null) return null; if (c[i].close>kc.upper[i]!) return "long"; if (c[i].close<kc.lower[i]!) return "short"; return null; }; },
      build2: (c, cl) => { const comp = computeADXComponents(c, 14); return (i) => { if (comp.adx[i]===null||comp.plusDI[i]===null||comp.minusDI[i]===null) return null; if (comp.adx[i]!<25) return null; return comp.plusDI[i]!>comp.minusDI[i]! ? "long" : "short"; }; },
    },
    {
      name: "Donchian+Stochastic",
      build1: (c, cl) => { const dc = computeDonchian(c, 30); return (i) => { if (i<1||dc.upper[i-1]===null||dc.lower[i-1]===null) return null; if (c[i].close>dc.upper[i-1]!) return "long"; if (c[i].close<dc.lower[i-1]!) return "short"; return null; }; },
      build2: (c, cl) => { const st = computeStochastic(c, 14, 3, 3); return (i) => { if (st.k[i]===null) return null; if (st.k[i]!<30) return "long"; if (st.k[i]!>70) return "short"; return null; }; },
    },
  ];

  for (const dc of dualCombos) {
    for (const riskSet of [{ stopAtr: 3.0, rr: 4, stag: 10, tAct: 20, tDist: 5 }, { stopAtr: 4.0, rr: 5, stag: 12, tAct: 10, tDist: 3 }]) {
      const rp = { smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false, trailActivation: riskSet.tAct, trailDistance: riskSet.tDist, stopAtrMult: riskSet.stopAtr, rewardRisk: riskSet.rr, stagnationBars: riskSet.stag };

      // Both signals must agree within 3-bar window
      const buildSignal = (candles: Candle[], closes: number[]) => {
        const sig1 = dc.build1(candles, closes);
        const sig2 = dc.build2(candles, closes);
        return (i: number) => {
          const s1 = sig1(i);
          if (s1 === null) return null;
          // Check if sig2 agrees within last 3 bars
          for (let k = 0; k <= 2; k++) {
            if (i - k < 0) break;
            const s2 = sig2(i - k);
            if (s2 === s1) return s1;
          }
          return null;
        };
      };

      const r = evaluate3Fold(allPairData, rp, buildSignal);
      if (r) {
        r.strategy = `DUAL:${dc.name}(atr=${riskSet.stopAtr},rr=${riskSet.rr})`;
        r.phase = 3;
        results.push(r);
      }
    }
  }
  console.log(`    -> ${results.length} dual-confirm results`);

  // 3b. Inverted signals (contrarian on worst performers)
  console.log("  Phase 3b: Inverted signals (contrarian)...");
  const negativeSharpe = phase1Results.filter(r => r.sharpe < 0 && r.phase === 1).sort((a, b) => a.sharpe - b.sharpe).slice(0, 5);
  // For simplicity, invert the top-level engine signals
  const invertEngines = buildPhase1Engines();
  for (const neg of negativeSharpe) {
    // Parse engine name from strategy
    const engineName = neg.strategy.split("(")[0].replace("-OAT-BEST", "").replace(/-trail$/, "");
    const eng = invertEngines.find(e => e.name === engineName);
    if (!eng) continue;

    const rp = { smaPeriod: eng.riskParams.smaPeriod, adxMin: eng.riskParams.adxMin, adxNotDecl: eng.riskParams.adxNotDecl, reverseExit: eng.riskParams.reverseExit, trailActivation: eng.riskParams.trailActivation, trailDistance: eng.riskParams.trailDistance, stopAtrMult: eng.riskParams.stopAtrMult, rewardRisk: eng.riskParams.rewardRisk, stagnationBars: eng.riskParams.stagnationBars };
    const buildInverted = (candles: Candle[], closes: number[]) => {
      const orig = eng.buildSignal(candles, closes, eng.currentParams);
      return (i: number) => {
        const s = orig(i);
        if (s === "long") return "short" as const;
        if (s === "short") return "long" as const;
        return null;
      };
    };
    const r = evaluate3Fold(allPairData, rp, buildInverted);
    if (r) {
      r.strategy = `INVERTED:${engineName}`;
      r.phase = 3;
      results.push(r);
    }
  }
  console.log(`    -> ${results.filter(r => r.strategy.startsWith("INVERTED")).length} inverted results`);

  // 3c. Cross-timeframe combos (4h signal + different 4h confirm acting as pseudo-1h)
  console.log("  Phase 3c: Cross-timeframe combos...");
  const crossCombos = [
    { name: "4hHMA+4hZLEMA-confirm", primary: (c: Candle[], cl: number[]) => { const f = computeHMA(cl, 3), s = computeHMA(cl, 50); return (i: number) => { const cf = f[i], pf = f[i-1], cs = s[i], ps = s[i-1]; if (cf===null||pf===null||cs===null||ps===null) return null; if (pf<=ps&&cf>cs) return "long"; if (pf>=ps&&cf<cs) return "short"; return null; }; }, confirm: (c: Candle[], cl: number[]) => { const f = computeZLEMA(cl, 8), s = computeZLEMA(cl, 34); return (i: number) => { if (f[i]===null||s[i]===null) return null; return f[i]! > s[i]! ? "long" as const : "short" as const; }; } },
    { name: "4hSchaff+4hCCI-confirm", primary: (c: Candle[], cl: number[]) => { const stc = mapStcToOriginal(cl, 8, 20, 12); return (i: number) => { const cv = stc[i], pv = stc[i-1]; if (cv===null||pv===null) return null; if (pv<=40&&cv>40) return "long"; if (pv>=60&&cv<60) return "short"; return null; }; }, confirm: (c: Candle[], cl: number[]) => { const cci = precomputeCCI(c, 14); return (i: number) => { if (cci[i]===null) return null; return cci[i]! > 0 ? "long" as const : "short" as const; }; } },
  ];

  for (const cc of crossCombos) {
    for (const riskSet of [{ stopAtr: 3.0, rr: 4, stag: 10, tAct: 15, tDist: 3 }, { stopAtr: 4.0, rr: 6, stag: 12, tAct: 25, tDist: 5 }]) {
      const rp = { smaPeriod: 50, adxMin: 0, adxNotDecl: false, reverseExit: false, trailActivation: riskSet.tAct, trailDistance: riskSet.tDist, stopAtrMult: riskSet.stopAtr, rewardRisk: riskSet.rr, stagnationBars: riskSet.stag };
      const buildSignal = (candles: Candle[], closes: number[]) => {
        const prim = cc.primary(candles, closes);
        const conf = cc.confirm(candles, closes);
        return (i: number) => {
          const s = prim(i);
          if (s === null) return null;
          const c = conf(i);
          return c === s ? s : null;
        };
      };
      const r = evaluate3Fold(allPairData, rp, buildSignal);
      if (r) {
        r.strategy = `CROSS:${cc.name}(atr=${riskSet.stopAtr},rr=${riskSet.rr})`;
        r.phase = 3;
        results.push(r);
      }
    }
  }
  console.log(`    -> ${results.filter(r => r.strategy.startsWith("CROSS")).length} cross-timeframe results`);

  // 3d. Adaptive trailing
  console.log("  Phase 3d: Adaptive trailing...");
  const engines = buildPhase1Engines();
  const adaptiveTrailSets = [
    { label: "aggressive", trailAct: 15, trailDist: 3 },
    { label: "loose", trailAct: 40, trailDist: 8 },
    { label: "tight", trailAct: 5, trailDist: 1 },
    { label: "medium-tight", trailAct: 10, trailDist: 2 },
  ];
  for (const eng of engines.slice(0, 7)) { // 4h engines only
    for (const ts of adaptiveTrailSets) {
      const rp = { ...eng.riskParams, trailActivation: ts.trailAct, trailDistance: ts.trailDist };
      const r = evaluate3Fold(allPairData, rp, (candles, closes) => eng.buildSignal(candles, closes, eng.currentParams));
      if (r) {
        r.strategy = `ADAPTIVE:${eng.name}-${ts.label}(act=${ts.trailAct},dist=${ts.trailDist})`;
        r.phase = 3;
        results.push(r);
      }
    }
  }
  console.log(`    -> ${results.filter(r => r.strategy.startsWith("ADAPTIVE")).length} adaptive trail results`);

  return results;
}

// ─── Cartesian Product Helper ────────────────────────────────────────────────

function cartesian(obj: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(obj);
  let results: Record<string, number>[] = [{}];
  for (const key of keys) {
    const vals = obj[key];
    const expanded: Record<string, number>[] = [];
    for (const combo of results) { for (const v of vals) expanded.push({ ...combo, [key]: v }); }
    results = expanded;
  }
  return results;
}

// ─── Output Formatting ──────────────────────────────────────────────────────

function formatResultLine(rank: number, r: SweepResult): string {
  return `${String(rank).padStart(4)} | ${r.strategy.padEnd(60)} | ${r.sharpe.toFixed(2).padStart(6)} | ${(r.pctPerDay >= 0 ? "+" : "") + r.pctPerDay.toFixed(3).padStart(7)}% | ${String(r.trades).padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | $${r.maxDD.toFixed(0).padStart(6)} | [${r.foldSharpes.map(s => s.toFixed(1)).join(",")}]`;
}

function writeResults(allResults: SweepResult[], startTime: number, currentBaseline: SweepResult | null) {
  const elapsed = Math.round((Date.now() - startTime) / 60_000);
  const date = new Date().toISOString().split("T")[0];

  const lines: string[] = [];
  lines.push(`=== OVERNIGHT SWEEP RESULTS -- ${date} (${elapsed} min) ===\n`);

  const header = `Rank | ${"Strategy".padEnd(60)} | ${"Sharpe".padStart(6)} | ${"  %/day".padStart(8)} | ${"Trades".padStart(6)} | ${"  WR".padStart(6)} | ${"  MaxDD".padStart(7)} | Fold Sharpes`;
  const sep = "-".repeat(header.length + 10);

  // Top 50 by Sharpe
  const bySharpe = [...allResults].sort((a, b) => b.sharpe - a.sharpe).slice(0, 50);
  lines.push("TOP 50 BY SHARPE (3-fold avg):");
  lines.push(header);
  lines.push(sep);
  bySharpe.forEach((r, i) => lines.push(formatResultLine(i + 1, r)));
  lines.push("");

  // Top 50 by profit/day
  const byPctDay = [...allResults].sort((a, b) => b.pctPerDay - a.pctPerDay).slice(0, 50);
  lines.push("TOP 50 BY PROFIT/DAY (3-fold avg):");
  lines.push(header);
  lines.push(sep);
  byPctDay.forEach((r, i) => lines.push(formatResultLine(i + 1, r)));
  lines.push("");

  // Phase breakdown
  for (const phase of [1, 2, 3]) {
    const phaseResults = allResults.filter(r => r.phase === phase).sort((a, b) => b.sharpe - a.sharpe);
    const phaseName = phase === 1 ? "PHASE 1 RESULTS (existing engine sweeps)" : phase === 2 ? "PHASE 2 RESULTS (new indicators)" : "PHASE 3 RESULTS (hybrids)";
    lines.push(`${phaseName}:`);
    lines.push(header);
    lines.push(sep);
    phaseResults.forEach((r, i) => lines.push(formatResultLine(i + 1, r)));
    lines.push("");
  }

  // Current baseline
  if (currentBaseline) {
    lines.push("CURRENT LIVE BASELINE:");
    lines.push(header);
    lines.push(sep);
    lines.push(formatResultLine(1, currentBaseline));
    lines.push("");
  }

  lines.push(`Total strategies tested: ${allResults.length}`);
  lines.push(`Runtime: ${elapsed} minutes`);

  const output = lines.join("\n");
  fs.writeFileSync("/tmp/overnight-sweep-results.txt", output);
  console.log("\n" + output);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log("=== OVERNIGHT BACKTEST SWEEP ===");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Pairs: ${PAIRS.length} | Lookback: ${DAYS_LOOKBACK}d | 3-fold walk-forward | Lighter DEX (zero fees)\n`);

  // ── Fetch Data ──────────────────────────────────────────────────────────
  const allPairData = new Map<string, PairData>();
  const allSma = [50, 75, 100];

  console.log("Fetching candle data...");
  for (let pi = 0; pi < PAIRS.length; pi++) {
    const pair = PAIRS[pi];
    if (pi > 0) await sleep(400);
    try {
      process.stdout.write(`  [${pi + 1}/${PAIRS.length}] ${pair}...`);
      const h4c = await fetchCandles(pair, "4h", DAYS_LOOKBACK);
      await sleep(200);
      let daily: Candle[] | null = null;
      for (const iv of ["1d", "24h"]) {
        try { daily = await fetchCandles(pair, iv, DAYS_LOOKBACK + 20); if (daily.length > 0) break; } catch { /* */ }
        await sleep(300);
      }
      if (!daily?.length) throw new Error("daily failed");
      if (h4c.length < MIN_PAIR_BARS) { console.log(` SKIP (${h4c.length} bars)`); continue; }

      const slip = getSlip(pair);
      const preDaily_d = precomputeDaily(daily, allSma);
      const idxDaily = buildDailyIndex(h4c, daily);

      allPairData.set(pair, {
        h4: h4c,
        atr4h: precomputeATR(h4c),
        dailyCandles: daily,
        slippage: slip,
        preDaily: preDaily_d,
        idxDailyAt: idxDaily,
      });
      console.log(` ${h4c.length} bars, slip=${(slip * 100).toFixed(2)}%`);
    } catch (e) { console.warn(` SKIP (${(e as Error).message})`); }
  }
  console.log(`\nLoaded: ${allPairData.size} pairs\n`);

  const allResults: SweepResult[] = [];

  // ── Current Baseline ────────────────────────────────────────────────────
  console.log("Computing current live baseline (HMA-4h + Schaff-4h + DEMA-4h)...");
  const baselineEngines = buildPhase1Engines();
  const hmaEng = baselineEngines.find(e => e.name === "HMA-4h")!;
  const schaffEng = baselineEngines.find(e => e.name === "Schaff-4h")!;
  const demaEng = baselineEngines.find(e => e.name === "DEMA-4h")!;

  let baselineSweep: SweepResult | null = null;
  // Run each baseline engine individually and average
  const baselineResults: SweepResult[] = [];
  for (const eng of [hmaEng, schaffEng, demaEng]) {
    const rp = { ...eng.riskParams, trailActivation: 25, trailDistance: 5 };
    const r = evaluate3Fold(allPairData, rp, (candles, closes) => eng.buildSignal(candles, closes, eng.currentParams));
    if (r) {
      r.strategy = `BASELINE:${eng.name}`;
      r.phase = 0;
      baselineResults.push(r);
    }
  }
  if (baselineResults.length > 0) {
    baselineSweep = {
      strategy: "BASELINE:HMA+Schaff+DEMA(current)",
      sharpe: baselineResults.reduce((s, r) => s + r.sharpe, 0) / baselineResults.length,
      pctPerDay: baselineResults.reduce((s, r) => s + r.pctPerDay, 0) / baselineResults.length,
      trades: baselineResults.reduce((s, r) => s + r.trades, 0),
      winRate: baselineResults.reduce((s, r) => s + r.winRate * r.trades, 0) / baselineResults.reduce((s, r) => s + r.trades, 0),
      maxDD: Math.max(...baselineResults.map(r => r.maxDD)),
      phase: 0,
      foldSharpes: [0, 1, 2].map(fi => baselineResults.reduce((s, r) => s + r.foldSharpes[fi], 0) / baselineResults.length),
    };
    console.log(`  Baseline Sharpe: ${baselineSweep.sharpe.toFixed(2)} | %/day: ${baselineSweep.pctPerDay.toFixed(3)}%\n`);
  }

  // ── Phase 1: Parameter Sweeps ──────────────────────────────────────────
  console.log("========== PHASE 1: Parameter Sweeps (9 engines) ==========\n");
  const phase1Engines = buildPhase1Engines();

  for (let ei = 0; ei < phase1Engines.length; ei++) {
    const eng = phase1Engines[ei];
    console.log(`Phase 1: Engine ${ei + 1}/${phase1Engines.length} - ${eng.name}`);
    const engineStart = Date.now();
    const engineResults = runPhase1OAT(eng, allPairData);
    allResults.push(...engineResults);
    const bestResult = engineResults.sort((a, b) => b.sharpe - a.sharpe)[0];
    const elapsed = ((Date.now() - engineStart) / 1000).toFixed(0);
    if (bestResult) {
      console.log(`  -> ${engineResults.length} combos tested in ${elapsed}s | Best Sharpe: ${bestResult.sharpe.toFixed(2)} | ${bestResult.strategy}`);
    } else {
      console.log(`  -> ${engineResults.length} combos tested in ${elapsed}s | No results with 10+ trades`);
    }
  }
  console.log(`\nPhase 1 complete: ${allResults.length} total results\n`);

  // ── Phase 2: New Indicators ────────────────────────────────────────────
  console.log("========== PHASE 2: New Indicator Strategies ==========\n");
  const phase2Indicators = buildPhase2Indicators();
  const phase2Results = runPhase2(phase2Indicators, allPairData);
  allResults.push(...phase2Results);
  console.log(`\nPhase 2 complete: ${phase2Results.length} new indicator results\n`);

  // ── Phase 3: Hybrid Approaches ─────────────────────────────────────────
  console.log("========== PHASE 3: Hybrid Approaches ==========\n");
  const phase3Results = runPhase3(allPairData, allResults.filter(r => r.phase === 1));
  allResults.push(...phase3Results);
  console.log(`\nPhase 3 complete: ${phase3Results.length} hybrid results\n`);

  // ── Write Results ──────────────────────────────────────────────────────
  writeResults(allResults, startTime, baselineSweep);

  const totalElapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
  console.log(`\nDone! Total runtime: ${totalElapsed} minutes | ${allResults.length} strategies tested`);
  console.log("Results saved to /tmp/overnight-sweep-results.txt");
}

main().catch(console.error);
