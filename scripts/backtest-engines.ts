// Unified backtest for all 9 live quant engines using exact production signal logic.
// Walk-forward: train=120d (720 4h bars), test=~60d. 8 pairs.
// Fee model: 0.09% round-trip, 10x leverage, $10 margin per trade.
// Exit model: SL, TP, trailing stop (peak>5%, trail peak-2%), stagnation (per-engine bars).
//
// NOTE: Trailing stop is checked per 4h bar (not per minute like live). This is
// conservative -- wider bars mean less favorable trailing-stop fills than live.
//
// Run: npx tsx scripts/backtest-engines.ts [engine-name|all]
// Output: summary table to stdout + full breakdown to /tmp/backtest-engines.txt

import { ATR, ADX, MACD, EMA, PSAR } from "technicalindicators";
import * as fs from "node:fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0.0009; // 0.09% round-trip
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV; // $100 notional

const PAIRS = ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK", "ARB", "OP"];
const DAYS_4H = 270; // ~180d data + warmup headroom for 120d train + 60d test
const DAYS_DAILY = 200;
const TRAIN_BARS = 720; // 120d * 6 bars/day

// Engine parameters (exact copies from constants.ts)
const PSAR_STEP = 0.008;
const PSAR_MAX = 0.1;

const ZLEMA_FAST = 4;
const ZLEMA_SLOW = 40;

const TRIX_PERIOD = 16;
const TRIX_SIGNAL = 12;

const ELDER_EMA_PERIOD = 25;
const ELDER_MACD_FAST = 8;
const ELDER_MACD_SLOW = 24;
const ELDER_MACD_SIGNAL = 9;

const VORTEX_PERIOD = 25;

const SCHAFF_STC_FAST = 8;
const SCHAFF_STC_SLOW = 20;
const SCHAFF_STC_CYCLE = 12;
const SCHAFF_STC_THRESHOLD = 40;

const DEMA_FAST = 5;
const DEMA_SLOW = 21;

const HMA_FAST = 16;
const HMA_SLOW = 42;

const CCI_PERIOD = 20;
const CCI_THRESHOLD = 85;

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
  checkSignal: (i: number, ctx: SignalContext) => "long" | "short" | null;
}

interface SignalContext {
  candles: Candle[];
  // PSAR
  psarValues: (number | null)[];
  // ZLEMA
  zlemaFast: (number | null)[];
  zlemaSlow: (number | null)[];
  // TRIX
  trixLine: (number | null)[];
  trixSignal: (number | null)[];
  // Elder
  elderEma: (number | null)[];
  elderHistogram: (number | null)[];
  // Vortex
  vortexPlus: (number | null)[];
  vortexMinus: (number | null)[];
  // Schaff
  stcValues: (number | null)[];
  // DEMA
  demaFast: (number | null)[];
  demaSlow: (number | null)[];
  // HMA
  hmaFast: (number | null)[];
  hmaSlow: (number | null)[];
  // CCI
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
    await sleep(1000);
    return await fetchCandlesOnce(coin, interval, days);
  }
}

// ─── Daily precomputation ─────────────────────────────────────────────────────

interface DailyPre {
  smaMap: Map<number, (number | null)[]>; // smaPeriod -> array aligned to daily candles
  adx: (number | null)[];
}

function precomputeDaily(candles: Candle[], smaPeriods: number[]): DailyPre {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  // ADX via technicalindicators (proper Wilder smoothing, identical to daily-indicators.ts)
  const adxRaw = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxArr: (number | null)[] = new Array(n).fill(null);
  adxRaw.forEach((v, i) => {
    adxArr[n - adxRaw.length + i] = v?.adx ?? null;
  });

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

// ─── Daily index map: for each 4h bar, index of last completed daily bar ────────

function buildDailyIndex(h4: Candle[], daily: Candle[]): number[] {
  const idxDailyAt: number[] = new Array(h4.length).fill(-1);
  let j = 0;
  for (let i = 0; i < h4.length; i++) {
    while (j < daily.length && daily[j].timestamp <= h4[i].timestamp) j++;
    idxDailyAt[i] = j - 1;
  }
  return idxDailyAt;
}

// ─── 4h ATR ───────────────────────────────────────────────────────────────────

function precomputeATR(candles: Candle[]): (number | null)[] {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const atrRaw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const arr: (number | null)[] = new Array(n).fill(null);
  atrRaw.forEach((v, i) => {
    arr[n - atrRaw.length + i] = v;
  });
  return arr;
}

// ─── Indicator computation functions (exact copies from engine files) ──────────

// ZLEMA: lag-corrected EMA (from zlema-engine.ts)
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

// TRIX (from trix-engine.ts)
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

// Vortex (from vortex-engine.ts) -- precompute per bar
function precomputeVortex(candles: Candle[], period: number): { vPlus: (number | null)[]; vMinus: (number | null)[] } {
  const n = candles.length;
  const vPlus: (number | null)[] = new Array(n).fill(null);
  const vMinus: (number | null)[] = new Array(n).fill(null);
  for (let endIdx = period; endIdx < n; endIdx++) {
    let vmPlus = 0;
    let vmMinus = 0;
    let trSum = 0;
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
    if (trSum > 0) {
      vPlus[endIdx] = vmPlus / trSum;
      vMinus[endIdx] = vmMinus / trSum;
    }
  }
  return { vPlus, vMinus };
}

// Schaff STC (from schaff-engine.ts)
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
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    const range = hi - lo;
    stoch1.push(range === 0 ? 50 : ((macdLine[i] - lo) / range) * 100);
  }
  if (stoch1.length === 0) return [];
  const smoothed1 = computeLocalEma(stoch1, cycle);
  if (smoothed1.length < cycle) return [];
  const stoch2: number[] = [];
  for (let i = cycle - 1; i < smoothed1.length; i++) {
    const window = smoothed1.slice(i - cycle + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    const range = hi - lo;
    stoch2.push(range === 0 ? 50 : ((smoothed1[i] - lo) / range) * 100);
  }
  if (stoch2.length === 0) return [];
  return computeLocalEma(stoch2, cycle).map((v) => Math.min(100, Math.max(0, v)));
}

// Map STC compact array to original index space
function mapStcToOriginal(closes: number[], fast: number, slow: number, cycle: number): (number | null)[] {
  const n = closes.length;
  const result: (number | null)[] = new Array(n).fill(null);
  const stcRaw = computeStcFull(closes, fast, slow, cycle);
  if (stcRaw.length === 0) return result;
  // The compact stcRaw starts at some offset from the end -- backfill from end
  for (let i = 0; i < stcRaw.length; i++) {
    const origIdx = n - stcRaw.length + i;
    if (origIdx >= 0) result[origIdx] = stcRaw[i];
  }
  return result;
}

// DEMA (from dema-engine.ts)
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

// HMA (from hma-engine.ts)
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
    const h = wmaHalf[i];
    const f = wmaFull[i];
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

// CCI (from cci-engine.ts)
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

// PSAR mapped to original index space
function precomputePSAR(candles: Candle[], step: number, max: number): (number | null)[] {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const psarRaw = PSAR.calculate({ high: highs, low: lows, step, max });
  const result: (number | null)[] = new Array(n).fill(null);
  const startIdx = n - psarRaw.length;
  for (let i = 0; i < psarRaw.length; i++) {
    result[startIdx + i] = psarRaw[i];
  }
  return result;
}

// Elder EMA and MACD histogram mapped to original index space
function precomputeElderIndicators(candles: Candle[]): { ema: (number | null)[]; histogram: (number | null)[] } {
  const n = candles.length;
  const closes = candles.map((c) => c.close);

  const emaRaw = EMA.calculate({ values: closes, period: ELDER_EMA_PERIOD });
  const emaStartIdx = n - emaRaw.length;
  const ema: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < emaRaw.length; i++) ema[emaStartIdx + i] = emaRaw[i];

  const macdRaw = MACD.calculate({
    values: closes,
    fastPeriod: ELDER_MACD_FAST,
    slowPeriod: ELDER_MACD_SLOW,
    signalPeriod: ELDER_MACD_SIGNAL,
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

// ─── Precompute all indicators for a pair ────────────────────────────────────

function precomputeSignalContext(candles: Candle[]): SignalContext {
  const closes = candles.map((c) => c.close);

  const psarValues = precomputePSAR(candles, PSAR_STEP, PSAR_MAX);
  const zlemaFast = computeZLEMA(closes, ZLEMA_FAST);
  const zlemaSlow = computeZLEMA(closes, ZLEMA_SLOW);
  const trixLine = computeTRIX(closes, TRIX_PERIOD);
  const trixSignal = computeTRIXSignal(trixLine, TRIX_SIGNAL);
  const { ema: elderEma, histogram: elderHistogram } = precomputeElderIndicators(candles);
  const { vPlus: vortexPlus, vMinus: vortexMinus } = precomputeVortex(candles, VORTEX_PERIOD);
  const stcValues = mapStcToOriginal(closes, SCHAFF_STC_FAST, SCHAFF_STC_SLOW, SCHAFF_STC_CYCLE);
  const demaFast = computeDEMA(closes, DEMA_FAST);
  const demaSlow = computeDEMA(closes, DEMA_SLOW);
  const hmaFast = computeHMA(closes, HMA_FAST);
  const hmaSlow = computeHMA(closes, HMA_SLOW);
  const cciValues = precomputeCCI(candles, CCI_PERIOD);

  return {
    candles,
    psarValues,
    zlemaFast, zlemaSlow,
    trixLine, trixSignal,
    elderEma, elderHistogram,
    vortexPlus, vortexMinus,
    stcValues,
    demaFast, demaSlow,
    hmaFast, hmaSlow,
    cciValues,
  };
}

// ─── Engine definitions ───────────────────────────────────────────────────────

const ENGINES: EngineConfig[] = [
  {
    name: "psar",
    smaPeriod: 50,
    adxMin: 0,
    stopAtrMult: 3.0,
    rewardRisk: 4.0,
    stagnationBars: 16,
    checkSignal(i, ctx) {
      const { candles, psarValues } = ctx;
      const currSar = psarValues[i];
      const prevSar = psarValues[i - 1];
      if (currSar === null || prevSar === null) return null;
      const currClose = candles[i].close;
      const prevClose = candles[i - 1].close;
      // SAR flip: prevSar above prevClose AND currSar below currClose -> long
      if (prevSar > prevClose && currSar < currClose) return "long";
      if (prevSar < prevClose && currSar > currClose) return "short";
      return null;
    },
  },
  {
    name: "zlema",
    smaPeriod: 75,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 3.0,
    stagnationBars: 10,
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
    name: "trix",
    smaPeriod: 75,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 4.0,
    stagnationBars: 20,
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
    name: "elder",
    smaPeriod: 75,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 2.5,
    stagnationBars: 8,
    checkSignal(i, ctx) {
      const { elderEma, elderHistogram } = ctx;
      // Need 4 bars: i-3, i-2, i-1, i (prev-prev-prev, prev-prev, prev, curr)
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
    },
  },
  {
    name: "vortex",
    smaPeriod: 75,
    adxMin: 0,
    stopAtrMult: 5.0,
    rewardRisk: 4.0,
    stagnationBars: 16,
    checkSignal(i, ctx) {
      const { vortexPlus, vortexMinus } = ctx;
      const cvp = vortexPlus[i], pvp = vortexPlus[i - 1];
      const cvm = vortexMinus[i], pvm = vortexMinus[i - 1];
      if (cvp === null || pvp === null || cvm === null || pvm === null) return null;
      if (pvp <= pvm && cvp > cvm) return "long";
      if (pvm <= pvp && cvm > cvp) return "short";
      return null;
    },
  },
  {
    name: "schaff",
    smaPeriod: 50,
    adxMin: 0,
    stopAtrMult: 3.5,
    rewardRisk: 4.0,
    stagnationBars: 9,
    checkSignal(i, ctx) {
      const { stcValues } = ctx;
      const curr = stcValues[i], prev = stcValues[i - 1];
      if (curr === null || prev === null) return null;
      if (prev <= SCHAFF_STC_THRESHOLD && curr > SCHAFF_STC_THRESHOLD) return "long";
      if (prev >= (100 - SCHAFF_STC_THRESHOLD) && curr < (100 - SCHAFF_STC_THRESHOLD)) return "short";
      return null;
    },
  },
  {
    name: "dema",
    smaPeriod: 75,
    adxMin: 10,
    stopAtrMult: 3.0,
    rewardRisk: 4.0,
    stagnationBars: 16,
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
  {
    name: "hma",
    smaPeriod: 75,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 4.0,
    stagnationBars: 8,
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
    name: "cci",
    smaPeriod: 50,
    adxMin: 0,
    stopAtrMult: 2.5,
    rewardRisk: 4.0,
    stagnationBars: 10,
    checkSignal(i, ctx) {
      const { cciValues } = ctx;
      const curr = cciValues[i], prev = cciValues[i - 1];
      if (curr === null || prev === null) return null;
      if (prev <= CCI_THRESHOLD && curr > CCI_THRESHOLD) return "long";
      if (prev >= -CCI_THRESHOLD && curr < -CCI_THRESHOLD) return "short";
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
    peakPnlPct: number; // for trailing stop
  };
  let pos: Pos | null = null;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles4h[i];

    if (pos !== null) {
      // Current unrealized P&L %
      const pricePct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
      const unrealizedPct = pricePct * LEV * 100;
      pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);

      // Check trailing stop (peak > 5%, trail = peak - 2%)
      const trailingHit = pos.peakPnlPct > 5 && unrealizedPct <= pos.peakPnlPct - 2;

      // Check stagnation
      const stagHit = (i - pos.entryIdx) >= engine.stagnationBars;

      // Check SL/TP
      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;

      let exitPrice: number | null = null;

      // Trailing/stagnation checked before SL/TP (live monitor runs more frequently)
      if (trailingHit) {
        exitPrice = c.close;
      } else if (stagHit) {
        exitPrice = c.close;
      } else if (slHit && tpHit) {
        // Both hit same bar: conservative, assume SL
        exitPrice = pos.sl;
      } else if (slHit) {
        exitPrice = pos.sl;
      } else if (tpHit) {
        exitPrice = pos.tp;
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

// ─── Main ──────────────────────────────────────────────────────────────────────

interface EngineResult {
  name: string;
  trades: number;
  wins: number;
  totalPnl: number;
  days: number;
  allPnlPcts: number[];
  maxDrawdown: number;
  pairBreakdown: { pair: string; trades: number; pnl: number }[];
}

async function main() {
  const filterArg = process.argv[2]?.toLowerCase() ?? "all";
  const enginesFiltered = filterArg === "all" ? ENGINES : ENGINES.filter((e) => e.name === filterArg);

  if (enginesFiltered.length === 0) {
    console.error(`Unknown engine: ${filterArg}. Valid: ${ENGINES.map((e) => e.name).join(", ")}, all`);
    process.exit(1);
  }

  const allSmaPeriods = [...new Set(enginesFiltered.map((e) => e.smaPeriod))];

  console.log(`=== backtest-engines.ts: 9 Engine Walk-Forward Backtest ===`);
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Engines: ${enginesFiltered.map((e) => e.name).join(", ")}`);
  console.log(`Walk-forward: train first ${TRAIN_BARS} 4h bars (~120d), test remainder (~150d)`);
  console.log(`Fee: ${(FEE_RATE * 100).toFixed(3)}% RT | Leverage: ${LEV}x | Margin: $${MARGIN_PER_TRADE}/trade`);
  console.log(`Exit: SL/TP + trailing(peak>5%,trail peak-2%) + stagnation(per-engine)`);
  console.log(`NOTE: params were tuned on test window in quick-276 (data leakage). Re-tuning on train yields 0 trades.`);
  console.log(`These results reflect overfit params -- treat Sharpe > 4 as inflated.\n`);
  console.log("Fetching candle data...");

  type PairData = {
    h4: Candle[];
    atr4h: (number | null)[];
    ctx: SignalContext;
    dailyCandles: Candle[];
    preDaily: DailyPre;
    idxDailyAt: number[];
    trainEnd: number;
  };

  const candleMap: Record<string, PairData> = {};

  for (let pi = 0; pi < PAIRS.length; pi++) {
    const pair = PAIRS[pi];
    if (pi > 0) await sleep(300);
    try {
      process.stdout.write(`  ${pair} 4h...`);
      const h4 = await fetchCandles(pair, "4h", DAYS_4H);

      process.stdout.write(` ${h4.length}bars. daily...`);
      let dailyCandles: Candle[] | null = null;
      for (const interval of ["1d", "24h"]) {
        try {
          dailyCandles = await fetchCandles(pair, interval, DAYS_DAILY);
          break;
        } catch {
          // try next interval
        }
        await sleep(300);
      }
      if (!dailyCandles || dailyCandles.length === 0) throw new Error("daily fetch failed");

      const atr4h = precomputeATR(h4);
      const ctx = precomputeSignalContext(h4);
      const preDaily = precomputeDaily(dailyCandles, allSmaPeriods);
      const idxDailyAt = buildDailyIndex(h4, dailyCandles);

      // train = first TRAIN_BARS bars, must have enough data
      const trainEnd = Math.min(TRAIN_BARS, Math.floor(h4.length * 0.67));
      candleMap[pair] = { h4, atr4h, ctx, dailyCandles, preDaily, idxDailyAt, trainEnd };

      const testBars = h4.length - trainEnd;
      const testDays = (h4[h4.length - 1].timestamp - h4[trainEnd].timestamp) / 86400_000;
      console.log(` ${dailyCandles.length}daily. trainEnd=${trainEnd} testBars=${testBars} testDays=${testDays.toFixed(0)}`);
    } catch (e) {
      console.warn(`  ${pair}: SKIP (${(e as Error).message})`);
    }
  }

  const pairs = PAIRS.filter((p) => candleMap[p]);
  if (pairs.length === 0) {
    console.error("No pairs loaded. Exiting.");
    process.exit(1);
  }

  const samp = candleMap[pairs[0]];
  const testDaysRef = (samp.h4[samp.h4.length - 1].timestamp - samp.h4[samp.trainEnd].timestamp) / 86400_000;
  console.log(`\nLoaded ${pairs.length} pairs. Test window: ~${testDaysRef.toFixed(0)} days\n`);

  // ── Run each engine ──────────────────────────────────────────────────────────
  console.log(`Running ${enginesFiltered.length} engine(s) across ${pairs.length} pairs...\n`);

  const engineResults: EngineResult[] = [];

  for (const engine of enginesFiltered) {
    let totalPnl = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let maxDD = 0;
    let maxDays = 0;
    const allPnlPcts: number[] = [];
    const pairBreakdown: { pair: string; trades: number; pnl: number }[] = [];

    for (const pair of pairs) {
      const { h4, atr4h, ctx, dailyCandles, preDaily, idxDailyAt, trainEnd } = candleMap[pair];
      const r = runBacktest(h4, atr4h, dailyCandles, preDaily, idxDailyAt, engine, ctx, trainEnd, h4.length);
      totalPnl += r.totalReturn;
      totalTrades += r.trades;
      totalWins += r.wins;
      maxDD = Math.max(maxDD, r.maxDrawdown);
      allPnlPcts.push(...r.tradePnlPcts);
      maxDays = Math.max(maxDays, r.days);
      pairBreakdown.push({ pair, trades: r.trades, pnl: r.totalReturn });
    }

    engineResults.push({
      name: engine.name,
      trades: totalTrades,
      wins: totalWins,
      totalPnl,
      days: maxDays,
      allPnlPcts,
      maxDrawdown: maxDD,
      pairBreakdown,
    });
  }

  // ── Format results ───────────────────────────────────────────────────────────

  const header = `Engine       | Trades  WinRate   PnL($)  %/day   Sharpe  MaxDD($)`;
  const sep = "─".repeat(header.length);

  const fullLines: string[] = [
    `=== backtest-engines.ts: 9 Engine Backtest Results ===`,
    `Test window: ~${testDaysRef.toFixed(0)}d | ${pairs.length} pairs | fees=${(FEE_RATE * 100).toFixed(3)}%RT | leverage=${LEV}x | margin=$${MARGIN_PER_TRADE}`,
    `Exit: SL/TP + trailing(peak>5%,trail peak-2%) + stagnation(per-engine)`,
    "",
    header,
    sep,
  ];

  // Sort by %/day descending
  engineResults.sort((a, b) => {
    const aRate = a.days > 0 ? (a.totalPnl / (MARGIN_PER_TRADE * pairs.length)) / a.days * 100 : 0;
    const bRate = b.days > 0 ? (b.totalPnl / (MARGIN_PER_TRADE * pairs.length)) / b.days * 100 : 0;
    return bRate - aRate;
  });

  for (const r of engineResults) {
    const winRate = r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
    const pctPerDay = r.days > 0 ? (r.totalPnl / (MARGIN_PER_TRADE * pairs.length)) / r.days * 100 : 0;
    const sh = sharpe(r.allPnlPcts);
    const sign = pctPerDay >= 0 ? "+" : "";
    const pnlSign = r.totalPnl >= 0 ? "+" : "";
    const line = `${r.name.padEnd(12)} | ${String(r.trades).padStart(5)}  ${winRate.toFixed(1).padStart(5)}%  ${(pnlSign + r.totalPnl.toFixed(2)).padStart(8)}  ${(sign + pctPerDay.toFixed(3) + "%").padStart(7)}  ${sh.toFixed(2).padStart(6)}  $${r.maxDrawdown.toFixed(2)}`;
    fullLines.push(line);
  }

  fullLines.push("");
  fullLines.push("=== Per-Pair Breakdown ===");
  for (const r of engineResults) {
    fullLines.push(`\n${r.name}:`);
    for (const pb of r.pairBreakdown) {
      const sign = pb.pnl >= 0 ? "+" : "";
      fullLines.push(`  ${pb.pair.padEnd(6)}: ${pb.trades}T  ${sign}$${pb.pnl.toFixed(2)}`);
    }
  }

  // Print main table to stdout
  console.log(header);
  console.log(sep);
  for (const r of engineResults) {
    const winRate = r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
    const pctPerDay = r.days > 0 ? (r.totalPnl / (MARGIN_PER_TRADE * pairs.length)) / r.days * 100 : 0;
    const sh = sharpe(r.allPnlPcts);
    const sign = pctPerDay >= 0 ? "+" : "";
    const pnlSign = r.totalPnl >= 0 ? "+" : "";
    const line = `${r.name.padEnd(12)} | ${String(r.trades).padStart(5)}  ${winRate.toFixed(1).padStart(5)}%  ${(pnlSign + r.totalPnl.toFixed(2)).padStart(8)}  ${(sign + pctPerDay.toFixed(3) + "%").padStart(7)}  ${sh.toFixed(2).padStart(6)}  $${r.maxDrawdown.toFixed(2)}`;
    console.log(line);
  }

  console.log(`\nTest window: ~${testDaysRef.toFixed(0)}d | ${pairs.length} pairs | walk-forward (train 120d / test ~60d)`);

  // Top 5 by %/day
  console.log("\n=== TOP 5 by %/day ===");
  engineResults.slice(0, 5).forEach((r, rank) => {
    const pctPerDay = r.days > 0 ? (r.totalPnl / (MARGIN_PER_TRADE * pairs.length)) / r.days * 100 : 0;
    const winRate = r.trades > 0 ? (r.wins / r.trades) * 100 : 0;
    const sh = sharpe(r.allPnlPcts);
    const sign = pctPerDay >= 0 ? "+" : "";
    console.log(`${rank + 1}. ${r.name.padEnd(12)} ${sign}${pctPerDay.toFixed(3)}%/d  ${r.trades}T  ${winRate.toFixed(0)}%wr  Sharpe=${sh.toFixed(2)}`);
  });

  // Save full results
  fs.writeFileSync("/tmp/backtest-engines.txt", fullLines.join("\n") + "\n");
  console.log(`\nFull results saved to /tmp/backtest-engines.txt`);
}

main().catch(console.error);
