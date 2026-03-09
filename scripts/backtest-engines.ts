// Backtest all quant engines. Run: npx tsx scripts/backtest-engines.ts [engine|all]

import { ATR, ADX, MACD, EMA, PSAR } from "technicalindicators";
import * as fs from "node:fs";

// Constants

const LEV = 10;
const FEE_RATE = 0.0009;
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE ?? 0.05) / 100; // 0.05% default entry+exit slippage
const FUNDING_8H = 0.0001; // 0.01% per 8h funding rate on notional
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV;
const SL_CAP_PCT = Number(process.env.SL_CAP ?? 0);
const TRAIL_ACTIVATION = Number(process.env.TRAIL_ACT ?? 20);
const TRAIL_DISTANCE = Number(process.env.TRAIL_DIST ?? 5);
const INVERT_SIGNALS = process.env.INVERT === "1";
const RR_OVERRIDE = process.env.RR ? Number(process.env.RR) : 0;
const SMART_TRAIL = process.env.SMART_TRAIL === "1";
const LIQUIDATION_FEE_PCT = 0.01;
const LIQUIDATION_THRESHOLD_PCT = 4;

const PAIRS = process.env.PAIRS ? process.env.PAIRS.split(",") : ["BTC","ETH","SOL","XRP","DOGE","AVAX","LINK","ARB","BNB","OP","SUI","INJ","ATOM","APT","WIF","kPEPE","kBONK","kFLOKI","kSHIB","NEAR","RUNE","FET","LDO","CRV","HBAR","LTC","TIA","SEI","JUP","PYTH","TAO","ADA","DOT","BCH","AAVE","WLD","TRX","UNI","TON","ONDO","ENA"];
const CANDLE_INTERVAL = process.env.INTERVAL ?? "4h";
const BARS_PER_DAY = CANDLE_INTERVAL === "1h" ? 24 : CANDLE_INTERVAL === "15m" ? 96 : 6;
const DAYS_CANDLE = 780;
const DAYS_DAILY = 780;
const TRAIN_BARS = Math.round(2935 * (BARS_PER_DAY / 6));
const PSAR_STEP = 0.02;
const PSAR_MAX = 0.1;

const ZLEMA_FAST = 10;
const ZLEMA_SLOW = 34;

const TRIX_PERIOD = 9;
const TRIX_SIGNAL = 15;

const ELDER_EMA_PERIOD = 17;
const ELDER_MACD_FAST = 16;
const ELDER_MACD_SLOW = 26;
const ELDER_MACD_SIGNAL = 9;

const VORTEX_PERIOD = 14;

const SCHAFF_STC_FAST = 10;
const SCHAFF_STC_SLOW = 26;
const SCHAFF_STC_CYCLE = 10;
const SCHAFF_STC_THRESHOLD = 30;

const DEMA_FAST = 5;
const DEMA_SLOW = 21;

const HMA_FAST = 12;
const HMA_SLOW = 34;

const CCI_PERIOD = 14;
const CCI_THRESHOLD = 100;

// Types

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
  exitReasons: { sl: number; tp: number; trail: number; stag: number; liq: number };
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

// Fetch

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CACHE_DIR = "/tmp/bt-candle-cache";
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ok */ }
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4h

async function fetchCandlesOnce(coin: string, interval: string, days: number): Promise<Candle[]> {
  // Disk cache
  const cacheFile = `${CACHE_DIR}/${coin}_${interval}_${days}.json`;
  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    }
  } catch { /* miss */ }

  const endTime = Date.now();
  const startTime = endTime - days * 86400_000;
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin} ${interval}`);
  const raw = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  const candles = raw
    .map((c) => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  try { fs.writeFileSync(cacheFile, JSON.stringify(candles)); } catch { /* ok */ }
  return candles;
}

async function fetchCandles(coin: string, interval: string, days: number): Promise<Candle[]> {
  try {
    return await fetchCandlesOnce(coin, interval, days);
  } catch {
    await sleep(1000);
    return await fetchCandlesOnce(coin, interval, days);
  }
}

// Daily precomputation

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

// Daily index map

function buildDailyIndex(h4: Candle[], daily: Candle[]): number[] {
  const idxDailyAt: number[] = new Array(h4.length).fill(-1);
  let j = 0;
  for (let i = 0; i < h4.length; i++) {
    while (j < daily.length && daily[j].timestamp <= h4[i].timestamp) j++;
    idxDailyAt[i] = j - 1;
  }
  return idxDailyAt;
}

// 4h ATR

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

// Indicators

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

// Precompute all indicators

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

// Engine definitions

// Scale stagnation for candle interval
const STAG_SCALE = BARS_PER_DAY / 6;

const ENGINES: EngineConfig[] = [
  {
    name: "psar",
    smaPeriod: 50,
    adxMin: 18,
    stopAtrMult: 5.0,
    rewardRisk: 6.0,
    stagnationBars: Math.round(8 * STAG_SCALE),
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
    adxMin: 10,
    stopAtrMult: 4.0,
    rewardRisk: 4.0,
    stagnationBars: Math.round(10 * STAG_SCALE),
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
    name: "elder",
    smaPeriod: 75,
    adxMin: 8,
    stopAtrMult: 2.5,
    rewardRisk: 2.5,
    stagnationBars: Math.round(12 * STAG_SCALE),
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
    adxMin: 14,
    stopAtrMult: 5.0,
    rewardRisk: 4.0,
    stagnationBars: Math.round(10 * STAG_SCALE),
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
    adxMin: 22,
    stopAtrMult: 3.0,
    rewardRisk: 4.0,
    stagnationBars: Math.round(12 * STAG_SCALE),
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
    stopAtrMult: 3.5,
    rewardRisk: 4.0,
    stagnationBars: Math.round(16 * STAG_SCALE),
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
    adxMin: 8,
    stopAtrMult: 4.0,
    rewardRisk: 4.0,
    stagnationBars: Math.round(10 * STAG_SCALE),
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
    adxMin: 8,
    stopAtrMult: 3.5,
    rewardRisk: 4.0,
    stagnationBars: Math.round(10 * STAG_SCALE),
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
  const exitReasons = { sl: 0, tp: 0, trail: 0, stag: 0, liq: 0 };

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
      // Liquidation check (skipped if SL is tighter than liq level)
      const liqPrice = pos.dir === "long"
        ? pos.entry * (1 - LIQUIDATION_THRESHOLD_PCT / 100)
        : pos.entry * (1 + LIQUIDATION_THRESHOLD_PCT / 100);
      const liqHit = pos.dir === "long" ? c.low <= liqPrice : c.high >= liqPrice;
      const slDistPct = Math.abs(pos.sl - pos.entry) / pos.entry * 100;

      if (liqHit && slDistPct > LIQUIDATION_THRESHOLD_PCT) {
        const liqFee = NOTIONAL * LIQUIDATION_FEE_PCT;
        const pp = ((liqPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
        const grossPnl = pp * NOTIONAL;
        const fees = NOTIONAL * FEE_RATE + liqFee;
        const net = grossPnl - fees;
        pnlTotal += net;
        peakPnl = Math.max(peakPnl, pnlTotal);
        maxDrawdown = Math.max(maxDrawdown, peakPnl - pnlTotal);
        trades++;
        tradePnlPcts.push((net / MARGIN_PER_TRADE) * 100);
        exitReasons.liq++;
        pos = null;
        continue;
      }

      // Current unrealized P&L %
      const pricePct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
      const unrealizedPct = pricePct * LEV * 100;
      pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);

      // Check trailing stop
      let trailingHit = pos.peakPnlPct > TRAIL_ACTIVATION && unrealizedPct <= pos.peakPnlPct - TRAIL_DISTANCE;

      // Smart trail: skip close if signal still agrees with position direction
      if (trailingHit && SMART_TRAIL) {
        const currentSignal = engine.checkSignal(i, ctx);
        if (currentSignal === pos.dir) {
          pos.peakPnlPct = unrealizedPct; // reset peak
          trailingHit = false;
        }
      }

      // Check stagnation
      const stagHit = (i - pos.entryIdx) >= engine.stagnationBars;

      // Check SL/TP
      const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
      const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;

      let exitPrice: number | null = null;
      let exitReason = "";

      // Trailing/stagnation checked before SL/TP (live monitor runs more frequently)
      if (trailingHit) {
        exitPrice = c.close;
        exitReason = "trail";
      } else if (stagHit) {
        exitPrice = c.close;
        exitReason = "stag";
      } else if (slHit && tpHit) {
        exitPrice = pos.sl;
        exitReason = "sl";
      } else if (slHit) {
        exitPrice = pos.sl;
        exitReason = "sl";
      } else if (tpHit) {
        exitPrice = pos.tp;
        exitReason = "tp";
      }

      if (exitPrice !== null) {
        // Apply exit slippage (worse fill)
        exitPrice = pos.dir === "long" ? exitPrice * (1 - SLIPPAGE_PCT) : exitPrice * (1 + SLIPPAGE_PCT);
        const barsHeld = i - pos.entryIdx;
        const fundingCost = NOTIONAL * FUNDING_8H * (barsHeld * (CANDLE_INTERVAL === "4h" ? 0.5 : CANDLE_INTERVAL === "1h" ? 0.125 : 0.03125));
        const pp = ((exitPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
        const grossPnl = pp * NOTIONAL;
        const fees = NOTIONAL * FEE_RATE + fundingCost;
        const net = grossPnl - fees;
        pnlTotal += net;
        peakPnl = Math.max(peakPnl, pnlTotal);
        maxDrawdown = Math.max(maxDrawdown, peakPnl - pnlTotal);
        trades++;
        if (net > 0) wins++;
        tradePnlPcts.push((net / MARGIN_PER_TRADE) * 100);
        if (exitReason === "sl") exitReasons.sl++;
        else if (exitReason === "tp") exitReasons.tp++;
        else if (exitReason === "trail") exitReasons.trail++;
        else if (exitReason === "stag") exitReasons.stag++;
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

      // Invert: flip signal AND ignore daily trend filter
      const signal = INVERT_SIGNALS ? (rawSignal === "long" ? "short" : "long") : rawSignal;

      let dir: "long" | "short" | null = null;
      if (INVERT_SIGNALS) {
        dir = signal; // skip trend filter for inverted signals
      } else {
        if (signal === "long" && dailyUptrend) dir = "long";
        if (signal === "short" && dailyDowntrend) dir = "short";
      }

      if (dir !== null) {
        const rawEntry = candles4h[i + 1].open;
        // Apply entry slippage (worse fill)
        const entryPrice = dir === "long" ? rawEntry * (1 + SLIPPAGE_PCT) : rawEntry * (1 - SLIPPAGE_PCT);
        const atr = atr4h[i] ?? c.close * 0.02;
        let stopDist = atr * engine.stopAtrMult;
        if (SL_CAP_PCT > 0) stopDist = Math.min(stopDist, entryPrice * SL_CAP_PCT / 100);
        const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
        const rr = RR_OVERRIDE > 0 ? RR_OVERRIDE : engine.rewardRisk;
        const tp = dir === "long" ? entryPrice + stopDist * rr : entryPrice - stopDist * rr;
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
    exitReasons,
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
  exitReasons: { sl: number; tp: number; trail: number; stag: number; liq: number };
}

async function main() {
  const filterArg = process.argv[2]?.toLowerCase() ?? "all";
  const enginesFiltered = filterArg === "all" ? ENGINES : ENGINES.filter((e) => e.name === filterArg);

  if (enginesFiltered.length === 0) {
    console.error(`Unknown engine: ${filterArg}. Valid: ${ENGINES.map((e) => e.name).join(", ")}, all`);
    process.exit(1);
  }

  const allSmaPeriods = [...new Set([...enginesFiltered.map((e) => e.smaPeriod), 30, 50, 75])];

  console.log(`=== backtest-engines.ts: ${INVERT_SIGNALS ? "INVERTED" : "NORMAL"} Walk-Forward Backtest ===`);
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Engines: ${enginesFiltered.map((e) => e.name).join(", ")}`);
  console.log(`Walk-forward: train first ${TRAIN_BARS} 4h bars (~120d), test remainder (~150d)`);
  console.log(`Fee: ${(FEE_RATE * 100).toFixed(3)}% RT | Leverage: ${LEV}x | Margin: $${MARGIN_PER_TRADE}/trade`);
  console.log(`Exit: SL/TP + trailing(peak>${TRAIL_ACTIVATION}%,trail peak-${TRAIL_DISTANCE}%) + stagnation(per-engine)`);
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
      process.stdout.write(`  ${pair} ${CANDLE_INTERVAL}...`);
      const h4 = await fetchCandles(pair, CANDLE_INTERVAL, DAYS_CANDLE);

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
    const exitReasons = { sl: 0, tp: 0, trail: 0, stag: 0, liq: 0 };

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
      exitReasons.sl += r.exitReasons.sl;
      exitReasons.tp += r.exitReasons.tp;
      exitReasons.trail += r.exitReasons.trail;
      exitReasons.stag += r.exitReasons.stag;
      exitReasons.liq += r.exitReasons.liq;
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
      exitReasons,
    });
  }

  // ── Format results ───────────────────────────────────────────────────────────

  const header = `Engine       | Trades  WinRate   PnL($)  %/day   Sharpe  MaxDD($)`;
  const sep = "─".repeat(header.length);

  const fullLines: string[] = [
    `=== backtest-engines.ts: 9 Engine Backtest Results ===`,
    `Test window: ~${testDaysRef.toFixed(0)}d | ${pairs.length} pairs | fees=${(FEE_RATE * 100).toFixed(3)}%RT | leverage=${LEV}x | margin=$${MARGIN_PER_TRADE}`,
    `Exit: SL/TP + trailing(peak>${TRAIL_ACTIVATION}%,trail peak-${TRAIL_DISTANCE}%) + stagnation(per-engine)`,
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

  // Exit reasons
  console.log("\n=== Exit Reasons ===");
  console.log(`${"Engine".padEnd(12)} | SL      TP      Trail   Stag    Liq`);
  console.log("─".repeat(65));
  for (const r of engineResults) {
    const { sl, tp, trail, stag, liq } = r.exitReasons;
    const total = sl + tp + trail + stag + liq;
    const pct = (v: number) => total > 0 ? `${v}(${(v/total*100).toFixed(0)}%)` : "0";
    console.log(`${r.name.padEnd(12)} | ${pct(sl).padEnd(8)}${pct(tp).padEnd(8)}${pct(trail).padEnd(8)}${pct(stag).padEnd(8)}${pct(liq)}`);
  }

  // Gross profit/loss breakdown
  console.log("\n=== Gross Profit / Loss / Max Single Loss ===");
  console.log(`${"Engine".padEnd(12)} | Wins  Losses  GrossProfit   GrossLoss  MaxSingleLoss  TotalPnL`);
  console.log("─".repeat(82));
  for (const r of engineResults) {
    const grossProfit = r.allPnlPcts.filter(p => p > 0).reduce((s, p) => s + p * MARGIN_PER_TRADE / 100, 0);
    const grossLoss = r.allPnlPcts.filter(p => p < 0).reduce((s, p) => s + Math.abs(p) * MARGIN_PER_TRADE / 100, 0);
    const maxSingleLoss = r.allPnlPcts.length > 0 ? Math.min(...r.allPnlPcts) * MARGIN_PER_TRADE / 100 : 0;
    const losses = r.trades - r.wins;
    const pnlSign = r.totalPnl >= 0 ? "+" : "";
    console.log(
      `${r.name.padEnd(12)} | ` +
      `${String(r.wins).padStart(4)}  ${String(losses).padStart(6)}  ` +
      `+$${grossProfit.toFixed(2).padStart(10)}  ` +
      `-$${grossLoss.toFixed(2).padStart(10)}  ` +
      `${maxSingleLoss.toFixed(2).padStart(13)}  ` +
      `${pnlSign}$${r.totalPnl.toFixed(2)}`
    );
  }

  // Save full results
  fs.writeFileSync("/tmp/backtest-engines.txt", fullLines.join("\n") + "\n");
  console.log(`\nFull results saved to /tmp/backtest-engines.txt`);

  // ── Portfolio Simulation (multi-engine, bar-by-bar) ──────────────────────────
  if (process.env.PORTFOLIO === "1") {
    const MAX_POS = Number(process.env.MAX_POS ?? 0); // 0 = unlimited
    const MAX_PER_PAIR = Number(process.env.MAX_PER_PAIR ?? 0); // 0 = unlimited
    const MAX_PER_DIR = Number(process.env.MAX_PER_DIR ?? 0); // 0 = unlimited
    const DYNAMIC_LIMIT = process.env.DYNAMIC === "1";
    const REQUIRE_DISAGREE = process.env.REQUIRE_DISAGREE === "1";
    const VOL_FILTER = Number(process.env.VOL_FILTER ?? 0); // e.g. 1.5 = skip entry when ATR > 1.5x its 20-bar avg
    const EQUITY_BREAKER = Number(process.env.EQUITY_BREAKER ?? 0); // e.g. 20 = pause entries if rolling 20-bar PnL < 0
    const DECORRELATE = process.env.DECORRELATE === "1"; // use different SMA per engine
    const liveEngineNames = (process.env.LIVE_ENGINES ?? "schaff,dema,hma").split(",");
    const liveEngines = ENGINES.filter(e => liveEngineNames.includes(e.name));

    // Decorrelated SMA overrides: spread engines across different trend timeframes
    const decorrelatedSma: Record<string, number> = { schaff: 30, dema: 50, hma: 75 };

    const ATR_TRAIL = Number(process.env.ATR_TRAIL ?? 0); // e.g. 2.5 = trail at 2.5*ATR from peak price
    interface PortPos {
      engine: string; pair: string; dir: "long" | "short";
      entry: number; entryIdx: number; sl: number; tp: number; peakPnlPct: number;
      peakPrice: number; // for ATR-based trailing
    }

    const COMPOUND = process.env.COMPOUND === "1";
    const START_EQUITY = Number(process.env.START_EQUITY ?? 400);
    const SIZE_PCT = Number(process.env.SIZE_PCT ?? 2.5) / 100; // % of equity per trade
    const MIN_SIZE = 5; // minimum position margin

    interface PortPosExt extends PortPos { margin: number; notional: number; }
    const positions: PortPosExt[] = [];
    let totalPnl = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let peakEquity = 0;
    let maxDD = 0;
    const exitReasons = { sl: 0, tp: 0, trail: 0, stag: 0, liq: 0 };
    let worstBar = 0;
    let bestBar = 0;
    let maxConcurrent = 0;
    const recentBarPnl: number[] = []; // rolling bar PnL for equity curve breaker
    let skippedByVol = 0;
    let skippedByEquity = 0;

    const refPair = pairs[0];
    const refData = candleMap[refPair];
    const startIdx = refData.trainEnd;
    const endIdx = refData.h4.length;

    for (let i = startIdx; i < endIdx; i++) {
      let dayPnl = 0;

      // Check exits for all open positions
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const pd = candleMap[pos.pair];
        if (!pd || i >= pd.h4.length) continue;
        const c = pd.h4[i];

        // Liquidation check
        const liqPrice = pos.dir === "long"
          ? pos.entry * (1 - LIQUIDATION_THRESHOLD_PCT / 100)
          : pos.entry * (1 + LIQUIDATION_THRESHOLD_PCT / 100);
        const liqHit = pos.dir === "long" ? c.low <= liqPrice : c.high >= liqPrice;
        const slDistPct = Math.abs(pos.sl - pos.entry) / pos.entry * 100;
        if (liqHit && slDistPct > LIQUIDATION_THRESHOLD_PCT) {
          const posNotional = pos.notional;
          const liqFee = posNotional * LIQUIDATION_FEE_PCT;
          const pp = ((liqPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
          const net = pp * posNotional - posNotional * FEE_RATE - liqFee;
          totalPnl += net; dayPnl += net; totalTrades++;
          exitReasons.liq++;
          positions.splice(p, 1);
          continue;
        }

        const unrealizedPct = ((c.close - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1) * LEV * 100;
        pos.peakPnlPct = Math.max(pos.peakPnlPct, unrealizedPct);
        pos.peakPrice = pos.dir === "long" ? Math.max(pos.peakPrice, c.high) : Math.min(pos.peakPrice, c.low);

        const slHit = pos.dir === "long" ? c.low <= pos.sl : c.high >= pos.sl;
        const tpHit = pos.dir === "long" ? c.high >= pos.tp : c.low <= pos.tp;

        let trailingHit: boolean;
        if (ATR_TRAIL > 0) {
          // ATR-based trail: trail at N*ATR from peak price, only after activation
          const atrNow = pd.atr4h[i] ?? c.close * 0.02;
          const trailDist = ATR_TRAIL * atrNow;
          if (pos.dir === "long") {
            const trailStop = pos.peakPrice - trailDist;
            trailingHit = trailStop > pos.entry && c.low <= trailStop;
          } else {
            const trailStop = pos.peakPrice + trailDist;
            trailingHit = trailStop < pos.entry && c.high >= trailStop;
          }
        } else {
          trailingHit = pos.peakPnlPct > TRAIL_ACTIVATION && unrealizedPct <= pos.peakPnlPct - TRAIL_DISTANCE;
        }
        const eng = liveEngines.find(e => e.name === pos.engine);
        const barsHeld = i - pos.entryIdx;
        const stagHit = eng ? barsHeld >= eng.stagnationBars : false;

        let exitPrice: number | null = null;
        let reason = "";
        if (trailingHit) { exitPrice = c.close; reason = "trail"; }
        else if (stagHit) { exitPrice = c.close; reason = "stag"; }
        else if (slHit) { exitPrice = pos.sl; reason = "sl"; }
        else if (tpHit) { exitPrice = pos.tp; reason = "tp"; }

        if (exitPrice !== null) {
          exitPrice = pos.dir === "long" ? exitPrice * (1 - SLIPPAGE_PCT) : exitPrice * (1 + SLIPPAGE_PCT);
          const posNotional = pos.notional;
          const fundingCost = posNotional * FUNDING_8H * (barsHeld * (CANDLE_INTERVAL === "4h" ? 0.5 : CANDLE_INTERVAL === "1h" ? 0.125 : 0.03125));
          const pp = ((exitPrice - pos.entry) / pos.entry) * (pos.dir === "long" ? 1 : -1);
          const net = pp * posNotional - posNotional * FEE_RATE - fundingCost;
          totalPnl += net;
          dayPnl += net;
          totalTrades++;
          if (net > 0) totalWins++;
          if (reason === "sl") exitReasons.sl++;
          else if (reason === "tp") exitReasons.tp++;
          else if (reason === "trail") exitReasons.trail++;
          else if (reason === "stag") exitReasons.stag++;
          positions.splice(p, 1);
        }
      }

      // Try entries for each engine x pair
      if (i + 1 < endIdx) {
        for (const engine of liveEngines) {
          for (const pair of pairs) {
            const pd = candleMap[pair];
            if (!pd || i >= pd.h4.length || i + 1 >= pd.h4.length) continue;

            // Skip if already have position for this engine+pair
            if (positions.find(p => p.engine === engine.name && p.pair === pair)) continue;

            // Limits
            if (MAX_POS > 0 && positions.length >= MAX_POS) continue;
            if (MAX_PER_PAIR > 0 && positions.filter(p => p.pair === pair).length >= MAX_PER_PAIR) continue;

            const dIdx = pd.idxDailyAt[i];
            if (dIdx < 0) continue;

            // Volatility filter: skip when ATR is spiking (reversal risk)
            if (VOL_FILTER > 0) {
              const atrNow = pd.atr4h[i];
              const atrWindow = 20;
              if (atrNow !== null && i >= atrWindow) {
                let atrSum = 0, atrCount = 0;
                for (let k = i - atrWindow; k < i; k++) {
                  if (pd.atr4h[k] !== null) { atrSum += pd.atr4h[k]!; atrCount++; }
                }
                if (atrCount > 0 && atrNow > (atrSum / atrCount) * VOL_FILTER) { skippedByVol++; continue; }
              }
            }

            // Equity curve breaker: pause entries if recent bars are net negative
            if (EQUITY_BREAKER > 0 && recentBarPnl.length >= EQUITY_BREAKER) {
              const rollingPnl = recentBarPnl.slice(-EQUITY_BREAKER).reduce((s, v) => s + v, 0);
              if (rollingPnl < 0) { skippedByEquity++; continue; }
            }

            // Decorrelated SMA: each engine uses different trend period
            const smaPeriod = DECORRELATE ? (decorrelatedSma[engine.name] ?? engine.smaPeriod) : engine.smaPeriod;
            const dailySma = pd.preDaily.smaMap.get(smaPeriod)?.[dIdx] ?? null;
            const dailyAdx = pd.preDaily.adx[dIdx];
            const dailyClose = pd.dailyCandles[dIdx].close;
            if (dailySma === null || dailyAdx === null || dailyAdx < engine.adxMin) continue;

            const dailyUptrend = dailyClose > dailySma;
            const dailyDowntrend = dailyClose < dailySma;

            const rawSignal = engine.checkSignal(i, pd.ctx);
            if (rawSignal === null) continue;

            let dir: "long" | "short" | null = null;
            if (rawSignal === "long" && dailyUptrend) dir = "long";
            if (rawSignal === "short" && dailyDowntrend) dir = "short";
            if (dir === null) continue;

            // Direction limit (dynamic: profitable positions -> allow more, losing -> tighten)
            if (MAX_PER_DIR > 0) {
              let effectiveLimit = MAX_PER_DIR;
              if (DYNAMIC_LIMIT) {
                const dirPositions = positions.filter(p => p.dir === dir);
                const dirUnrealizedPnl = dirPositions.reduce((sum, p) => {
                  const pd2 = candleMap[p.pair];
                  if (!pd2 || i >= pd2.h4.length) return sum;
                  const pp = ((pd2.h4[i].close - p.entry) / p.entry) * (p.dir === "long" ? 1 : -1);
                  return sum + pp * NOTIONAL;
                }, 0);
                const EXPAND_MULT = Number(process.env.EXPAND_MULT ?? 3);
                if (dirUnrealizedPnl > 0) effectiveLimit = Math.floor(MAX_PER_DIR * EXPAND_MULT);
                else if (dirUnrealizedPnl < -MARGIN_PER_TRADE * 3) effectiveLimit = Math.max(5, Math.floor(MAX_PER_DIR / 2));
              }
              if (positions.filter(p => p.dir === dir).length >= effectiveLimit) continue;
            }

            // Require disagreement: at least 1 other engine must NOT signal same direction for same pair
            if (REQUIRE_DISAGREE) {
              const otherEngines = liveEngines.filter(e => e.name !== engine.name);
              const allAgree = otherEngines.every(other => {
                const otherSma = pd.preDaily.smaMap.get(other.smaPeriod)?.[dIdx] ?? null;
                const otherAdx = pd.preDaily.adx[dIdx];
                if (otherSma === null || otherAdx === null || otherAdx < other.adxMin) return false;
                const otherSignal = other.checkSignal(i, pd.ctx);
                if (otherSignal === null) return false;
                if (dir === "long") return otherSignal === "long" && dailyClose > otherSma;
                return otherSignal === "short" && dailyClose < otherSma;
              });
              if (allAgree) continue; // Skip when ALL engines agree (likely to be correlated loss)
            }

            const rawEntry = pd.h4[i + 1].open;
            const entryPrice = dir === "long" ? rawEntry * (1 + SLIPPAGE_PCT) : rawEntry * (1 - SLIPPAGE_PCT);
            const atr = pd.atr4h[i] ?? pd.h4[i].close * 0.02;
            let stopDist = atr * engine.stopAtrMult;
            if (SL_CAP_PCT > 0) stopDist = Math.min(stopDist, entryPrice * SL_CAP_PCT / 100);
            const sl = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
            const rr = RR_OVERRIDE > 0 ? RR_OVERRIDE : engine.rewardRisk;
            const tp = dir === "long" ? entryPrice + stopDist * rr : entryPrice - stopDist * rr;

            const equity = COMPOUND ? START_EQUITY + totalPnl : START_EQUITY;
            const margin = COMPOUND ? Math.max(MIN_SIZE, Math.floor(equity * SIZE_PCT)) : MARGIN_PER_TRADE;
            const notional = margin * LEV;
            positions.push({ engine: engine.name, pair, dir, entry: entryPrice, entryIdx: i + 1, sl, tp, peakPnlPct: 0, peakPrice: entryPrice, margin, notional });
          }
        }
      }

      recentBarPnl.push(dayPnl);
      maxConcurrent = Math.max(maxConcurrent, positions.length);
      peakEquity = Math.max(peakEquity, totalPnl);
      maxDD = Math.max(maxDD, peakEquity - totalPnl);
      worstBar = Math.min(worstBar, dayPnl);
      bestBar = Math.max(bestBar, dayPnl);
    }

    const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : "0";
    const { sl, tp, trail, stag, liq } = exitReasons;
    const total = sl + tp + trail + stag + liq;
    const pct = (v: number) => total > 0 ? `${v}(${(v/total*100).toFixed(0)}%)` : "0";

    console.log(`\n=== PORTFOLIO SIMULATION ===`);
    console.log(`Engines: ${liveEngineNames.join(", ")} | Pairs: ${pairs.length}`);
    console.log(`Limits: maxPerPair=${MAX_PER_PAIR||"none"} maxPerDir=${MAX_PER_DIR||"none"} volFilter=${VOL_FILTER||"off"} equityBreaker=${EQUITY_BREAKER||"off"} decorrelate=${DECORRELATE}`);
    console.log(`Trades: ${totalTrades} | WinRate: ${winRate}% | PnL: $${totalPnl.toFixed(2)}${COMPOUND ? ` | FinalEquity: $${(START_EQUITY + totalPnl).toFixed(2)} (${((totalPnl / START_EQUITY) * 100).toFixed(0)}%)` : ""}`);
    console.log(`MaxDD: $${maxDD.toFixed(2)} | MaxConcurrent: ${maxConcurrent} | WorstBar: $${worstBar.toFixed(2)} | BestBar: $${bestBar.toFixed(2)}`);
    console.log(`Exits: SL=${pct(sl)} TP=${pct(tp)} Trail=${pct(trail)} Stag=${pct(stag)} Liq=${pct(liq)}`);
    if (skippedByVol > 0 || skippedByEquity > 0) console.log(`Filtered: vol=${skippedByVol} equity=${skippedByEquity}`);
    console.log(`---PORTFOLIO done---`);
  }
}

main().catch(console.error);
