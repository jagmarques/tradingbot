// 3-fold expanding walk-forward backtest for all 9 live quant engines.
// Uses TUNED params from grid search (post-quick-276).
// Fetches max available 4h data (~730d) from Hyperliquid.
// Fold structure: train=33%/50%/67%, test=next ~17% each (independent ~90d windows).
// Train window is warmup only -- params are fixed, no per-fold optimization.
//
// Run: npx tsx scripts/backtest-proper.ts

import { ATR, ADX, MACD, EMA, PSAR } from "technicalindicators";
import * as fs from "node:fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.0009; // 0.09% round-trip
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV; // $100 notional

const PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ARB", "BNB", "OP", "SUI", "INJ", "ATOM", "APT", "WIF", "kPEPE", "kBONK", "kFLOKI", "kSHIB", "NEAR", "RUNE", "FET", "LDO", "CRV", "HBAR", "LTC", "TIA", "SEI", "JUP", "PYTH", "TAO", "ADA", "DOT"];
const DAYS_4H = 730; // 2 years max, use whatever Hyperliquid returns
const DAYS_DAILY = 750;

// ─── Tuned params (PSAR min-fold fix + avg-Sharpe best for others) ──────────

const PSAR_STEP_ORIG = 0.02;
const PSAR_MAX_ORIG = 0.1;

const ZLEMA_FAST_ORIG = 4;
const ZLEMA_SLOW_ORIG = 40;

const TRIX_PERIOD_ORIG = 9;
const TRIX_SIGNAL_ORIG = 15;

const ELDER_EMA_PERIOD_ORIG = 25;
const ELDER_MACD_FAST_ORIG = 12;
const ELDER_MACD_SLOW_ORIG = 30;
const ELDER_MACD_SIGNAL_ORIG = 6;


const SCHAFF_STC_FAST_ORIG = 8;
const SCHAFF_STC_SLOW_ORIG = 26;
const SCHAFF_STC_CYCLE_ORIG = 12;
const SCHAFF_STC_THRESHOLD_ORIG = 25;

const DEMA_FAST_ORIG = 5;
const DEMA_SLOW_ORIG = 21;

const HMA_FAST_ORIG = 6;
const HMA_SLOW_ORIG = 34;

const CCI_PERIOD_ORIG = 20;
const CCI_THRESHOLD_ORIG = 85;

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

interface EngineConfig {
  name: string;
  smaPeriod: number;
  adxMin: number;
  stopAtrMult: number;
  rewardRisk: number;
  stagnationBars: number;
  adxNotDecl?: boolean;
  reverseExit?: boolean;
  trailActivation?: number;
  trailDistance?: number;
  checkSignal: (i: number, ctx: SignalContext) => "long" | "short" | null;
}

interface SignalContext {
  candles: Candle[];
  psarValues: (number | null)[];
  zlemaFast: (number | null)[];
  zlemaSlow: (number | null)[];
  trixLine: (number | null)[];
  trixSignal: (number | null)[];
  elderEma: (number | null)[];
  elderHistogram: (number | null)[];
  stcValues: (number | null)[];
  demaFast: (number | null)[];
  demaSlow: (number | null)[];
  hmaFast: (number | null)[];
  hmaSlow: (number | null)[];
  cciValues: (number | null)[];
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
    await sleep(1500);
    return await fetchCandlesOnce(coin, interval, days);
  }
}

// ─── Daily precomputation ─────────────────────────────────────────────────────

interface DailyPre {
  smaMap: Map<number, (number | null)[]>;
  adx: (number | null)[];
}

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
  for (let i = lagOffset; i < n; i++) {
    corrected.push(closes[i] + (closes[i] - closes[i - lagOffset]));
  }
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
    if (origIdx < n && ema3[i - 1] !== 0) {
      result[origIdx] = ((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 100;
    }
  }
  return result;
}

function computeTRIXSignal(trixValues: (number | null)[], signalPeriod: number): (number | null)[] {
  const n = trixValues.length;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = signalPeriod - 1; i < n; i++) {
    const slice = trixValues.slice(i - signalPeriod + 1, i + 1);
    const valid = slice.filter((v): v is number => v !== null);
    if (valid.length === signalPeriod) {
      result[i] = valid.reduce((s, v) => s + v, 0) / signalPeriod;
    }
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
      const prevHigh = candles[i - 1].high;
      const prevLow = candles[i - 1].low;
      const prevClose = candles[i - 1].close;
      vmPlus += Math.abs(candles[i].high - prevLow);
      vmMinus += Math.abs(candles[i].low - prevHigh);
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      );
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
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
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
  for (let i = 0; i < psarRaw.length; i++) { result[startIdx + i] = psarRaw[i]; }
  return result;
}

function precomputeElderIndicators(
  candles: Candle[],
  emaPeriod: number,
  macdFast: number,
  macdSlow: number,
  macdSignal: number
): { ema: (number | null)[]; histogram: (number | null)[] } {
  const n = candles.length;
  const closes = candles.map((c) => c.close);

  const emaRaw = EMA.calculate({ values: closes, period: emaPeriod });
  const emaStartIdx = n - emaRaw.length;
  const ema: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < emaRaw.length; i++) ema[emaStartIdx + i] = emaRaw[i];

  const macdRaw = MACD.calculate({
    values: closes,
    fastPeriod: macdFast,
    slowPeriod: macdSlow,
    signalPeriod: macdSignal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdStartIdx = n - macdRaw.length;
  const histogram: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < macdRaw.length; i++) {
    const h = macdRaw[i].histogram;
    histogram[macdStartIdx + i] = h ?? null;
  }

  return { ema, histogram };
}

function precomputeSignalContext(candles: Candle[]): SignalContext {
  const closes = candles.map((c) => c.close);

  const psarValues = precomputePSAR(candles, PSAR_STEP_ORIG, PSAR_MAX_ORIG);
  const zlemaFast = computeZLEMA(closes, ZLEMA_FAST_ORIG);
  const zlemaSlow = computeZLEMA(closes, ZLEMA_SLOW_ORIG);
  const trixLine = computeTRIX(closes, TRIX_PERIOD_ORIG);
  const trixSignal = computeTRIXSignal(trixLine, TRIX_SIGNAL_ORIG);
  const { ema: elderEma, histogram: elderHistogram } = precomputeElderIndicators(
    candles, ELDER_EMA_PERIOD_ORIG, ELDER_MACD_FAST_ORIG, ELDER_MACD_SLOW_ORIG, ELDER_MACD_SIGNAL_ORIG
  );
  const stcValues = mapStcToOriginal(closes, SCHAFF_STC_FAST_ORIG, SCHAFF_STC_SLOW_ORIG, SCHAFF_STC_CYCLE_ORIG);
  const demaFast = computeDEMA(closes, DEMA_FAST_ORIG);
  const demaSlow = computeDEMA(closes, DEMA_SLOW_ORIG);
  const hmaFast = computeHMA(closes, HMA_FAST_ORIG);
  const hmaSlow = computeHMA(closes, HMA_SLOW_ORIG);
  const cciValues = precomputeCCI(candles, CCI_PERIOD_ORIG);

  return {
    candles, psarValues,
    zlemaFast, zlemaSlow,
    trixLine, trixSignal,
    elderEma, elderHistogram,
    stcValues,
    demaFast, demaSlow,
    hmaFast, hmaSlow,
    cciValues,
  };
}

// ─── Engine definitions (tuned params from grid search) ───────────────────────

const ENGINES: EngineConfig[] = [
  {
    name: "cci",
    smaPeriod: 50,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 4.0,
    stagnationBars: 10,
    reverseExit: true,
    trailActivation: 3,
    trailDistance: 2,
    checkSignal(i, ctx) {
      const curr = ctx.cciValues[i], prev = ctx.cciValues[i - 1];
      if (curr === null || prev === null) return null;
      if (prev <= CCI_THRESHOLD_ORIG && curr > CCI_THRESHOLD_ORIG) return "long";
      if (prev >= -CCI_THRESHOLD_ORIG && curr < -CCI_THRESHOLD_ORIG) return "short";
      return null;
    },
  },
  {
    name: "elder",
    smaPeriod: 100,
    adxMin: 0,
    stopAtrMult: 3.0,
    rewardRisk: 2.5,
    stagnationBars: 16,
    adxNotDecl: false,
    reverseExit: true,
    trailActivation: 8,
    trailDistance: 3,
    checkSignal(i, ctx) {
      if (i < 3) return null;
      const { elderEma, elderHistogram } = ctx;
      const cE = elderEma[i], pE = elderEma[i - 1], ppE = elderEma[i - 2];
      const cH = elderHistogram[i], pH = elderHistogram[i - 1], ppH = elderHistogram[i - 2];
      if (cE == null || pE == null || ppE == null) return null;
      if (cH == null || pH == null || ppH == null) return null;
      const currGreen = cE > pE && cH > pH;
      const prevGreen = pE > ppE && pH > ppH;
      const currRed = cE < pE && cH < pH;
      const prevRed = pE < ppE && pH < ppH;
      if (currGreen && !prevGreen) return "long";
      if (currRed && !prevRed) return "short";
      return null;
    },
  },
  {
    name: "zlema",
    smaPeriod: 50,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 4.0,
    stagnationBars: 10,
    reverseExit: false,
    trailActivation: 3,
    trailDistance: 2,
    checkSignal(i, ctx) {
      const { zlemaFast, zlemaSlow } = ctx;
      const cf = zlemaFast[i], pf = zlemaFast[i - 1];
      const cs = zlemaSlow[i], ps = zlemaSlow[i - 1];
      if (cf === null || pf === null || cs === null || ps === null) return null;
      if (pf <= ps && cf > cs) return "long";
      if (pf >= ps && cf < cs) return "short";
      return null;
    },
  },
  {
    name: "schaff",
    smaPeriod: 50,
    adxMin: 10,
    stopAtrMult: 3.5,
    rewardRisk: 4.0,
    stagnationBars: 9,
    reverseExit: true,
    trailActivation: 3,
    trailDistance: 1,
    checkSignal(i, ctx) {
      const curr = ctx.stcValues[i], prev = ctx.stcValues[i - 1];
      if (curr === null || prev === null) return null;
      if (prev <= SCHAFF_STC_THRESHOLD_ORIG && curr > SCHAFF_STC_THRESHOLD_ORIG) return "long";
      if (prev >= (100 - SCHAFF_STC_THRESHOLD_ORIG) && curr < (100 - SCHAFF_STC_THRESHOLD_ORIG)) return "short";
      return null;
    },
  },
  {
    name: "psar",
    smaPeriod: 50,
    adxMin: 10,
    stopAtrMult: 3.0,
    rewardRisk: 4.0,
    stagnationBars: 10,
    trailActivation: 3,
    trailDistance: 2,
    checkSignal(i, ctx) {
      const { candles, psarValues } = ctx;
      const currSar = psarValues[i], prevSar = psarValues[i - 1];
      if (currSar === null || prevSar === null) return null;
      const currClose = candles[i].close, prevClose = candles[i - 1].close;
      if (prevSar > prevClose && currSar < currClose) return "long";
      if (prevSar < prevClose && currSar > currClose) return "short";
      return null;
    },
  },
  {
    name: "hma",
    smaPeriod: 50,
    adxMin: 10,
    stopAtrMult: 2.5,
    rewardRisk: 5.0,
    stagnationBars: 4,
    reverseExit: false,
    trailActivation: 8,
    trailDistance: 1,
    checkSignal(i, ctx) {
      const { hmaFast, hmaSlow } = ctx;
      const cf = hmaFast[i], pf = hmaFast[i - 1];
      const cs = hmaSlow[i], ps = hmaSlow[i - 1];
      if (cf === null || pf === null || cs === null || ps === null) return null;
      if (pf <= ps && cf > cs) return "long";
      if (pf >= ps && cf < cs) return "short";
      return null;
    },
  },
  {
    name: "trix",
    smaPeriod: 100,
    adxMin: 14,
    stopAtrMult: 3.5,
    rewardRisk: 4.0,
    stagnationBars: 10,
    trailActivation: 8,
    trailDistance: 2,
    checkSignal(i, ctx) {
      const { trixLine, trixSignal } = ctx;
      const ct = trixLine[i], pt = trixLine[i - 1];
      const cs = trixSignal[i], ps = trixSignal[i - 1];
      if (ct === null || pt === null || cs === null || ps === null) return null;
      if (pt <= ps && ct > cs) return "long";
      if (pt >= ps && ct < cs) return "short";
      return null;
    },
  },
  {
    name: "dema",
    smaPeriod: 50,
    adxMin: 10,
    stopAtrMult: 3.0,
    rewardRisk: 4.0,
    stagnationBars: 16,
    adxNotDecl: false,
    reverseExit: false,
    trailActivation: 5,
    trailDistance: 2,
    checkSignal(i, ctx) {
      const { demaFast, demaSlow } = ctx;
      const cf = demaFast[i], pf = demaFast[i - 1];
      const cs = demaSlow[i], ps = demaSlow[i - 1];
      if (cf === null || pf === null || cs === null || ps === null) return null;
      if (pf <= ps && cf > cs) return "long";
      if (pf >= ps && cf < cs) return "short";
      return null;
    },
  },
];

// ─── Backtest loop ─────────────────────────────────────────────────────────────

function sharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}

function runBacktest(
  candles4h: Candle[],
  atr4h: (number | null)[],
  dailyCandles: Candle[],
  preDaily: DailyPre,
  idxDailyAt: number[],
  engine: EngineConfig,
  ctx: SignalContext,
  startIdx: number,
  endIdx: number,
): BacktestResult {
  let pnlTotal = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  type Pos = {
    dir: "long" | "short";
    entry: number;
    entryIdx: number;
    sl: number;
    tp: number;
    peakPnlPct: number;
  };
  let pos: Pos | null = null;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles4h[i];

    if (pos !== null) {
      const pricePct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
      const unrealizedPct = pricePct * LEV * 100;
      pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);

      const trailAct = engine.trailActivation ?? 5;
      const trailDist = engine.trailDistance ?? 2;
      const trailingHit = pos.peakPnlPct > trailAct && unrealizedPct <= pos.peakPnlPct - trailDist;
      const stagHit = (i - pos.entryIdx) >= engine.stagnationBars;
      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;

      let exitPrice: number | null = null;

      if (trailingHit) {
        exitPrice = c.close;
      } else if (stagHit) {
        exitPrice = c.close;
      } else if (slHit && tpHit) {
        exitPrice = pos.sl; // conservative: assume SL if both hit
      } else if (slHit) {
        exitPrice = pos.sl;
      } else if (tpHit) {
        exitPrice = pos.tp;
      } else if (engine.reverseExit) {
        const rev = engine.checkSignal(i, ctx);
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

      const dailySma = preDaily.smaMap.get(engine.smaPeriod)?.[dIdx] ?? null;
      const dailyAdx = preDaily.adx[dIdx];
      const dailyClose = dailyCandles[dIdx].close;

      if (dailySma === null || dailyAdx === null) continue;
      if (dailyAdx < engine.adxMin) continue;
      if (engine.adxNotDecl && dIdx >= 2) {
        const adxPrev2 = preDaily.adx[dIdx - 2];
        if (adxPrev2 !== null && dailyAdx < adxPrev2) continue;
      }

      const dailyUptrend = dailyClose > dailySma;
      const dailyDowntrend = dailyClose < dailySma;

      const rawSignal = engine.checkSignal(i, ctx);
      if (rawSignal === null) continue;

      let dir: "long" | "short" | null = null;
      if (rawSignal === "long" && dailyUptrend) dir = "long";
      if (rawSignal === "short" && dailyDowntrend) dir = "short";

      if (dir !== null) {
        const entryPrice = candles4h[i + 1].open;
        const atr = atr4h[i] ?? c.close * 0.02;
        const stopDist = atr * engine.stopAtrMult;
        const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
        const tp = dir === "long" ? entryPrice + stopDist * engine.rewardRisk : entryPrice - stopDist * engine.rewardRisk;
        pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peakPnlPct: 0 };
      }
    }
  }

  const startTs = candles4h[startIdx]?.timestamp ?? 0;
  const endTs = candles4h[endIdx - 1]?.timestamp ?? 0;
  return {
    trades,
    wins,
    totalReturn: pnlTotal,
    maxDrawdown,
    tradePnlPcts,
    days: (endTs - startTs) / 86400_000,
  };
}

// ─── Ensemble backtest ─────────────────────────────────────────────────────────

function runEnsembleBacktest(
  candles4h: Candle[],
  atr4h: (number | null)[],
  dailyCandles: Candle[],
  preDaily: DailyPre,
  idxDailyAt: number[],
  engines: EngineConfig[],
  ctx: SignalContext,
  startIdx: number,
  endIdx: number,
  minAgreement: number,
): BacktestResult {
  let pnlTotal = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  let trades = 0;
  let wins = 0;
  const tradePnlPcts: number[] = [];

  type Pos = { dir: "long" | "short"; entry: number; entryIdx: number; sl: number; tp: number; peakPnlPct: number; trailAct: number; trailDist: number; stag: number };
  let pos: Pos | null = null;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles4h[i];

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

      const longVoters: EngineConfig[] = [];
      const shortVoters: EngineConfig[] = [];

      for (const engine of engines) {
        const dailySma = preDaily.smaMap.get(engine.smaPeriod)?.[dIdx] ?? null;
        const dailyAdx = preDaily.adx[dIdx];
        const dailyClose = dailyCandles[dIdx].close;
        if (dailySma === null || dailyAdx === null) continue;
        if (dailyAdx < engine.adxMin) continue;
        if (engine.adxNotDecl && dIdx >= 2) {
          const adxPrev2 = preDaily.adx[dIdx - 2];
          if (adxPrev2 !== null && dailyAdx < adxPrev2) continue;
        }
        const dailyUptrend = dailyClose > dailySma;
        const dailyDowntrend = dailyClose < dailySma;
        const sig = engine.checkSignal(i, ctx);
        if (sig === "long" && dailyUptrend) longVoters.push(engine);
        if (sig === "short" && dailyDowntrend) shortVoters.push(engine);
      }

      const voters = longVoters.length >= minAgreement ? longVoters : shortVoters.length >= minAgreement ? shortVoters : null;
      if (!voters) continue;
      const dir: "long" | "short" = longVoters.length >= minAgreement ? "long" : "short";

      const entryPrice = candles4h[i + 1].open;
      const atr = atr4h[i] ?? c.close * 0.02;
      const avgStop = voters.reduce((s, e) => s + e.stopAtrMult, 0) / voters.length;
      const avgRR = voters.reduce((s, e) => s + e.rewardRisk, 0) / voters.length;
      const avgTrailAct = voters.reduce((s, e) => s + (e.trailActivation ?? 5), 0) / voters.length;
      const avgTrailDist = voters.reduce((s, e) => s + (e.trailDistance ?? 2), 0) / voters.length;
      const maxStag = Math.max(...voters.map((e) => e.stagnationBars));

      const stopDist = atr * avgStop;
      const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
      const tp = dir === "long" ? entryPrice + stopDist * avgRR : entryPrice - stopDist * avgRR;
      pos = { dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peakPnlPct: 0, trailAct: avgTrailAct, trailDist: avgTrailDist, stag: maxStag };
    }
  }

  const startTs = candles4h[startIdx]?.timestamp ?? 0;
  const endTs = candles4h[endIdx - 1]?.timestamp ?? 0;
  return { trades, wins, totalReturn: pnlTotal, maxDrawdown, tradePnlPcts, days: (endTs - startTs) / 86400_000 };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

interface FoldResult {
  fold: number;
  trainStartBar: number;
  testStartBar: number;
  testEndBar: number;
  testDays: number;
}

interface EngineWFResult {
  name: string;
  folds: { fold: number; trades: number; wins: number; pnl: number; sharpe: number; pctPerDay: number; days: number }[];
  avgSharpe: number;
  avgPctPerDay: number;
  avgWR: number;
  totalTrades: number;
}

async function main() {
  const ensembleArg = process.argv.find((a) => a.startsWith("--ensemble="));
  const ensembleMin = ensembleArg ? parseInt(ensembleArg.split("=")[1]) : 0;
  const isEnsemble = ensembleMin >= 2;

  const allSmaPeriods = [...new Set(ENGINES.map((e) => e.smaPeriod))];

  console.log("=== backtest-proper.ts: 3-fold walk-forward backtest (tuned params) ===");
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Params: TUNED post-quick-276 grid search results`);
  console.log(`Data: up to 730d of 4h candles from Hyperliquid`);
  console.log(`Folds: train=33%/50%/67%, test=next ~17% each (~90d per fold)`);
  console.log(`Fee: ${(FEE_RATE * 100).toFixed(3)}% RT | Leverage: ${LEV}x | Margin: $${MARGIN_PER_TRADE}/trade`);
  console.log(`Exit: SL/TP + trailing(peak>5%,trail peak-2%) + stagnation(per-engine)\n`);
  console.log("Fetching candle data...");

  type PairData = {
    h4: Candle[];
    atr4h: (number | null)[];
    ctx: SignalContext;
    dailyCandles: Candle[];
    preDaily: DailyPre;
    idxDailyAt: number[];
    totalBars: number;
  };

  const candleMap: Record<string, PairData> = {};

  for (let pi = 0; pi < PAIRS.length; pi++) {
    const pair = PAIRS[pi];
    if (pi > 0) await sleep(400);
    try {
      process.stdout.write(`  ${pair} 4h...`);
      const h4 = await fetchCandles(pair, "4h", DAYS_4H);
      process.stdout.write(` ${h4.length}bars. daily...`);

      let dailyCandles: Candle[] | null = null;
      for (const interval of ["1d", "24h"]) {
        try {
          dailyCandles = await fetchCandles(pair, interval, DAYS_DAILY);
          if (dailyCandles.length > 0) break;
        } catch {
          // try next
        }
        await sleep(300);
      }
      if (!dailyCandles || dailyCandles.length === 0) throw new Error("daily fetch failed");

      const atr4h = precomputeATR(h4);
      const ctx = precomputeSignalContext(h4);
      const preDaily = precomputeDaily(dailyCandles, allSmaPeriods);
      const idxDailyAt = buildDailyIndex(h4, dailyCandles);

      candleMap[pair] = { h4, atr4h, ctx, dailyCandles, preDaily, idxDailyAt, totalBars: h4.length };
      console.log(` ${dailyCandles.length}daily. total4h=${h4.length}`);
    } catch (e) {
      console.warn(`  ${pair}: SKIP (${(e as Error).message})`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) { console.error("No pairs loaded."); process.exit(1); }

  // Determine fold boundaries using minimum bar count across pairs for consistency
  const minBars = Math.min(...pairs.map((p) => candleMap[p].totalBars));
  console.log(`\nLoaded ${pairs.length} pairs. Min bars across pairs: ${minBars} (~${(minBars / 6).toFixed(0)}d)`);

  // 3-fold expanding walk-forward
  // Each test slice is ~17% of total, placed consecutively
  // Fold 1: train=[0, 33%), test=[33%, 50%)
  // Fold 2: train=[0, 50%), test=[50%, 67%)
  // Fold 3: train=[0, 67%), test=[67%, 84%)  -- leave last 16% unused (recent unanchored data)
  const trainRatios = [0.33, 0.50, 0.67];
  const testRatios  = [0.50, 0.67, 0.84];

  const foldDefs: FoldResult[] = trainRatios.map((tr, fi) => {
    const testStart = Math.floor(minBars * tr);
    const testEnd   = Math.floor(minBars * testRatios[fi]);
    const samplePair = candleMap[pairs[0]];
    const testStartTs = samplePair.h4[testStart]?.timestamp ?? 0;
    const testEndTs   = samplePair.h4[testEnd - 1]?.timestamp ?? 0;
    return {
      fold: fi + 1,
      trainStartBar: 0,
      testStartBar: testStart,
      testEndBar: testEnd,
      testDays: (testEndTs - testStartTs) / 86400_000,
    };
  });

  console.log("\nFold definitions (based on min bars across pairs):");
  for (const f of foldDefs) {
    console.log(`  Fold ${f.fold}: train=[0,${f.testStartBar}) test=[${f.testStartBar},${f.testEndBar}) ~${f.testDays.toFixed(0)}d`);
  }

  if (isEnsemble) {
    console.log(`\n=== ENSEMBLE MODE (min ${ensembleMin} engines must agree) ===\n`);
    const ensembleFoldAgg: EngineWFResult["folds"] = [];
    for (const fold of foldDefs) {
      let totalPnl = 0; let totalTrades = 0; let totalWins = 0; let maxTestDays = 0;
      const allPnlPcts: number[] = [];
      for (const pair of pairs) {
        const { h4, atr4h, ctx, dailyCandles, preDaily, idxDailyAt } = candleMap[pair];
        const testEnd = Math.min(fold.testEndBar, h4.length);
        if (fold.testStartBar >= testEnd) continue;
        const r = runEnsembleBacktest(h4, atr4h, dailyCandles, preDaily, idxDailyAt, ENGINES, ctx, fold.testStartBar, testEnd, ensembleMin);
        totalPnl += r.totalReturn; totalTrades += r.trades; totalWins += r.wins;
        maxTestDays = Math.max(maxTestDays, r.days); allPnlPcts.push(...r.tradePnlPcts);
      }
      const pctPerDay = maxTestDays > 0 ? (totalPnl / (MARGIN_PER_TRADE * pairs.length)) / maxTestDays * 100 : 0;
      ensembleFoldAgg.push({ fold: fold.fold, trades: totalTrades, wins: totalWins, pnl: totalPnl, sharpe: sharpe(allPnlPcts), pctPerDay, days: maxTestDays });
    }
    console.log(`[ENSEMBLE-${ensembleMin}]`);
    const header2 = `  Fold | Trades | WinRate |   PnL($) | %/day  | Sharpe | Days`;
    console.log(header2);
    for (const f of ensembleFoldAgg) {
      const wr = f.trades > 0 ? (f.wins / f.trades) * 100 : 0;
      console.log(`  F${f.fold}   | ${String(f.trades).padStart(6)} | ${(wr.toFixed(1) + "%").padStart(7)} | ${(f.pnl >= 0 ? "+" : "") + f.pnl.toFixed(2).padStart(7)} | ${(f.pctPerDay >= 0 ? "+" : "") + f.pctPerDay.toFixed(3) + "%"} | ${f.sharpe.toFixed(2).padStart(6)} | ${f.days.toFixed(0)}`);
    }
    const avg = { sharpe: ensembleFoldAgg.reduce((s, f) => s + f.sharpe, 0) / 3, pct: ensembleFoldAgg.reduce((s, f) => s + f.pctPerDay, 0) / 3, wr: ensembleFoldAgg.reduce((s, f) => s + (f.trades > 0 ? f.wins / f.trades : 0), 0) / 3 * 100 };
    console.log(`  AVG  |        | ${(avg.wr.toFixed(1) + "%").padStart(7)} |          | ${(avg.pct >= 0 ? "+" : "") + avg.pct.toFixed(3) + "%"} | ${avg.sharpe.toFixed(2).padStart(6)} |`);
    console.log(`\nData: ${minBars} bars (~${(minBars / 6).toFixed(0)}d) | ${pairs.length} pairs | fees=${(FEE_RATE * 100).toFixed(3)}%RT | ${LEV}x leverage`);
    return;
  }

  console.log(`\nRunning ${ENGINES.length} engines x 3 folds x ${pairs.length} pairs...\n`);

  const engineResults: EngineWFResult[] = [];

  for (const engine of ENGINES) {
    const foldAgg: EngineWFResult["folds"] = [];

    for (const fold of foldDefs) {
      let totalPnl = 0;
      let totalTrades = 0;
      let totalWins = 0;
      let maxTestDays = 0;
      const allPnlPcts: number[] = [];

      for (const pair of pairs) {
        const { h4, atr4h, ctx, dailyCandles, preDaily, idxDailyAt } = candleMap[pair];
        // Clamp test end to this pair's actual bar count
        const testEnd = Math.min(fold.testEndBar, h4.length);
        if (fold.testStartBar >= testEnd) continue;

        const r = runBacktest(
          h4, atr4h, dailyCandles, preDaily, idxDailyAt,
          engine, ctx,
          fold.testStartBar, testEnd
        );
        totalPnl += r.totalReturn;
        totalTrades += r.trades;
        totalWins += r.wins;
        maxTestDays = Math.max(maxTestDays, r.days);
        allPnlPcts.push(...r.tradePnlPcts);
      }

      const pctPerDay = maxTestDays > 0
        ? (totalPnl / (MARGIN_PER_TRADE * pairs.length)) / maxTestDays * 100
        : 0;
      const sh = sharpe(allPnlPcts);

      foldAgg.push({
        fold: fold.fold,
        trades: totalTrades,
        wins: totalWins,
        pnl: totalPnl,
        sharpe: sh,
        pctPerDay,
        days: maxTestDays,
      });
    }

    const avgSharpe = foldAgg.reduce((s, f) => s + f.sharpe, 0) / foldAgg.length;
    const avgPctPerDay = foldAgg.reduce((s, f) => s + f.pctPerDay, 0) / foldAgg.length;
    const totalWins = foldAgg.reduce((s, f) => s + f.wins, 0);
    const totalTrades = foldAgg.reduce((s, f) => s + f.trades, 0);
    const avgWR = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    engineResults.push({
      name: engine.name,
      folds: foldAgg,
      avgSharpe,
      avgPctPerDay,
      avgWR,
      totalTrades,
    });
  }

  // ─── Print results ─────────────────────────────────────────────────────────

  console.log("=== 3-Fold Walk-Forward Results (tuned params) ===\n");

  // Per-fold detail
  for (const r of engineResults) {
    const header2 = `  Fold | Trades | WinRate |   PnL($) | %/day  | Sharpe | Days`;
    console.log(`\n[${r.name.toUpperCase()}]`);
    console.log(header2);
    console.log("  " + "-".repeat(header2.length - 2));
    for (const f of r.folds) {
      const wr = f.trades > 0 ? (f.wins / f.trades) * 100 : 0;
      const sign = f.pctPerDay >= 0 ? "+" : "";
      const pnlSign = f.pnl >= 0 ? "+" : "";
      console.log(
        `  F${f.fold}   | ${String(f.trades).padStart(6)} | ${(wr.toFixed(1) + "%").padStart(7)} | ${(pnlSign + f.pnl.toFixed(2)).padStart(8)} | ${(sign + f.pctPerDay.toFixed(3) + "%").padStart(6)} | ${f.sharpe.toFixed(2).padStart(6)} | ${f.days.toFixed(0)}`
      );
    }
    const sign = r.avgPctPerDay >= 0 ? "+" : "";
    console.log(
      `  AVG  | ${String(r.totalTrades).padStart(6)} | ${(r.avgWR.toFixed(1) + "%").padStart(7)} |          | ${(sign + r.avgPctPerDay.toFixed(3) + "%").padStart(6)} | ${r.avgSharpe.toFixed(2).padStart(6)} |`
    );
  }

  // Summary table
  console.log("\n\n=== SUMMARY TABLE ===\n");
  const summaryHeader = `Engine   | F1 Sharpe | F2 Sharpe | F3 Sharpe | AVG Sharpe | AVG %/day | AVG WR | Total Trades`;
  const summarySep = "─".repeat(summaryHeader.length);
  console.log(summaryHeader);
  console.log(summarySep);

  // Sort by avg sharpe descending
  engineResults.sort((a, b) => b.avgSharpe - a.avgSharpe);

  const summaryLines: string[] = [summaryHeader, summarySep];
  for (const r of engineResults) {
    const f1 = r.folds[0], f2 = r.folds[1], f3 = r.folds[2];
    const sign = r.avgPctPerDay >= 0 ? "+" : "";
    const line = `${r.name.padEnd(8)} | ${f1.sharpe.toFixed(2).padStart(9)} | ${f2.sharpe.toFixed(2).padStart(9)} | ${f3.sharpe.toFixed(2).padStart(9)} | ${r.avgSharpe.toFixed(2).padStart(10)} | ${(sign + r.avgPctPerDay.toFixed(3) + "%").padStart(9)} | ${(r.avgWR.toFixed(1) + "%").padStart(6)} | ${r.totalTrades}`;
    console.log(line);
    summaryLines.push(line);
  }

  console.log(`\nData: ${minBars} bars (~${(minBars / 6).toFixed(0)}d) | ${pairs.length} pairs | fees=${(FEE_RATE * 100).toFixed(3)}%RT | ${LEV}x leverage`);
  console.log("NOTE: Sharpe 0.5-2.5 and %/day 0.05-0.4% expected for honest working strategy.");
  console.log("      Sharpe > 3.0 should be treated with suspicion (possible look-ahead or overfitting).");

  // Save to file
  const outputLines: string[] = [
    "=== backtest-proper.ts: 3-fold walk-forward backtest ===",
    `Params: TUNED post-quick-276 grid search`,
    `Data: up to 730d 4h candles | ${pairs.length} pairs: ${pairs.join(", ")}`,
    `Folds: train=33%/50%/67%, test=next ~17% each (~90d per fold)`,
    `Fee: ${(FEE_RATE * 100).toFixed(3)}%RT | ${LEV}x leverage | $${MARGIN_PER_TRADE}/trade`,
    "",
    ...summaryLines,
    "",
    "Per-fold details:",
  ];

  for (const r of engineResults) {
    outputLines.push(`\n[${r.name.toUpperCase()}]`);
    for (const f of r.folds) {
      const wr = f.trades > 0 ? (f.wins / f.trades) * 100 : 0;
      const sign = f.pctPerDay >= 0 ? "+" : "";
      outputLines.push(`  Fold ${f.fold}: ${f.trades}T  WR=${wr.toFixed(1)}%  PnL=${f.pnl.toFixed(2)}  %/d=${sign}${f.pctPerDay.toFixed(3)}%  Sharpe=${f.sharpe.toFixed(2)}`);
    }
    const sign = r.avgPctPerDay >= 0 ? "+" : "";
    outputLines.push(`  AVG: Sharpe=${r.avgSharpe.toFixed(2)}  %/d=${sign}${r.avgPctPerDay.toFixed(3)}%  WR=${r.avgWR.toFixed(1)}%  Trades=${r.totalTrades}`);
  }

  fs.writeFileSync("/tmp/backtest-proper.txt", outputLines.join("\n") + "\n");
  console.log("\nFull results saved to /tmp/backtest-proper.txt");

  // Return summary lines for external use
  return { summaryLines, engineResults, minBars, pairs };
}

main().catch(console.error);
