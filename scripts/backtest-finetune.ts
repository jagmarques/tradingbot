// Fine-tuning backtest: narrow parameter grid around current production configs.
// Tests Aroon, MACD, ZLEMA-v2, Schaff-v2 (new engines) + existing paper engines.
// Run: npx tsx scripts/backtest-finetune.ts 2>&1 | tee /tmp/finetune-results.txt
// Filter: ENGINE=aroon npx tsx scripts/backtest-finetune.ts

import { ATR, ADX, EMA, PSAR } from "technicalindicators";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEV = 10;
const FEE_RATE = 0; // Lighter DEX zero fees
const FUNDING_RATE_PER_8H = 0.0001;
const MARGIN_PER_TRADE = 10;
const NOTIONAL = MARGIN_PER_TRADE * LEV;
const MIN_PAIR_BARS = 1500;
const DAYS_LOOKBACK = 730;

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
}

interface SweepResult {
  strategy: string;
  sharpe: number;
  pctPerDay: number;
  trades: number;
  winRate: number;
  maxDD: number;
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

function computeAroon(candles: Candle[], period: number): { up: (number | null)[]; down: (number | null)[] } {
  const n = candles.length;
  const up: (number | null)[] = new Array(n).fill(null);
  const down: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let hiIdx = i, loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (candles[j].high >= candles[hiIdx].high) hiIdx = j;
      if (candles[j].low <= candles[loIdx].low) loIdx = j;
    }
    up[i] = ((period - (i - hiIdx)) / period) * 100;
    down[i] = ((period - (i - loIdx)) / period) * 100;
  }
  return { up, down };
}

function computeMACD(closes: number[], fast: number, slow: number, signal: number): { macdLine: (number | null)[]; signalLine: (number | null)[] } {
  const n = closes.length;
  const macdLine: (number | null)[] = new Array(n).fill(null);
  const signalLine: (number | null)[] = new Array(n).fill(null);
  const emaFast = EMA.calculate({ values: closes, period: fast });
  const emaSlow = EMA.calculate({ values: closes, period: slow });
  const fOff = n - emaFast.length;
  const sOff = n - emaSlow.length;
  const macdVals: number[] = [];
  for (let i = sOff; i < n; i++) {
    const fi = i - fOff;
    const si = i - sOff;
    if (fi >= 0 && fi < emaFast.length && si >= 0 && si < emaSlow.length) {
      const v = emaFast[fi] - emaSlow[si];
      macdLine[i] = v;
      macdVals.push(v);
    }
  }
  if (macdVals.length >= signal) {
    const sigEma = EMA.calculate({ values: macdVals, period: signal });
    const sigStart = n - sigEma.length;
    for (let i = 0; i < sigEma.length; i++) {
      if (sigStart + i < n) signalLine[sigStart + i] = sigEma[i];
    }
  }
  return { macdLine, signalLine };
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
  params: EngineRunParams,
  buildSignal: (candles: Candle[], closes: number[]) => ((i: number) => "long" | "short" | null),
  startRatio: number,
  endRatio: number,
): { trades: number; wins: number; pnl: number; maxDD: number; days: number; tradePnlPcts: number[] } {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, peakPnl = 0, maxDD = 0, totalDays = 0;
  const allPnlPcts: number[] = [];

  for (const [, pd] of allPairData) {
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
  params: EngineRunParams,
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
    foldSharpes,
  };
}

// ─── Engine Definitions ──────────────────────────────────────────────────────

interface FinetuneEngine {
  name: string;
  currentParams: Record<string, number | boolean>;
  narrowRanges: Record<string, (number | boolean)[]>;
  buildSignal: (candles: Candle[], closes: number[], p: Record<string, number | boolean>) => ((i: number) => "long" | "short" | null);
  buildRunParams: (p: Record<string, number | boolean>) => EngineRunParams;
}

function buildFinetuneEngines(): FinetuneEngine[] {
  return [
    // ─── New Engines (full grid sweep) ─────────────────────────────────

    // Aroon
    {
      name: "Aroon",
      currentParams: { period: 14, stopAtr: 3.5, rr: 4, trailAct: 25, trailDist: 5, sma: 75, adxMin: 10, stag: 10 },
      narrowRanges: {
        period: [10, 12, 14, 16, 18],
        stopAtr: [3.0, 3.5, 4.0, 4.5],
        rr: [3, 4, 5, 6],
        trailAct: [20, 25, 30],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [8, 10, 12],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, _closes, p) => {
        const aroon = computeAroon(_candles, p.period as number);
        return (i) => {
          const cu = aroon.up[i], pu = aroon.up[i-1], cd = aroon.down[i], pd = aroon.down[i-1];
          if (cu === null || pu === null || cd === null || pd === null) return null;
          if (pu <= pd && cu > cd) return "long";
          if (pu >= pd && cu < cd) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // MACD
    {
      name: "MACD",
      currentParams: { fast: 8, slow: 21, signal: 7, stopAtr: 3.5, rr: 4, trailAct: 25, trailDist: 5, sma: 75, adxMin: 10, stag: 10 },
      narrowRanges: {
        fast: [6, 8, 10],
        slow: [17, 21, 26],
        signal: [5, 7, 9],
        stopAtr: [3.0, 3.5, 4.0],
        rr: [3, 4, 5],
        trailAct: [20, 25, 30],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [8, 10],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, closes, p) => {
        const macd = computeMACD(closes, p.fast as number, p.slow as number, p.signal as number);
        return (i) => {
          const cm = macd.macdLine[i], pm = macd.macdLine[i-1], cs = macd.signalLine[i], ps = macd.signalLine[i-1];
          if (cm === null || pm === null || cs === null || ps === null) return null;
          if (pm <= ps && cm > cs) return "long";
          if (pm >= ps && cm < cs) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // ZLEMA-v2
    {
      name: "ZLEMA-v2",
      currentParams: { fast: 10, slow: 34, stopAtr: 4.0, rr: 4, trailAct: 20, trailDist: 6, sma: 75, adxMin: 10, stag: 10 },
      narrowRanges: {
        fast: [8, 10, 12],
        slow: [26, 30, 34, 38],
        stopAtr: [3.0, 3.5, 4.0, 5.0],
        rr: [3, 4, 5],
        trailAct: [15, 20, 25],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [8, 10],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, closes, p) => {
        const zF = computeZLEMA(closes, p.fast as number);
        const zS = computeZLEMA(closes, p.slow as number);
        return (i) => {
          const cf = zF[i], pf = zF[i-1], cs = zS[i], ps = zS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // Schaff-v2
    {
      name: "Schaff-v2",
      currentParams: { stcFast: 8, stcSlow: 20, cycle: 12, threshold: 40, stopAtr: 3.5, rr: 4, trailAct: 25, trailDist: 5, sma: 75, adxMin: 0, stag: 9 },
      narrowRanges: {
        stcFast: [6, 8, 10],
        stcSlow: [16, 20, 24],
        cycle: [10, 12, 14],
        threshold: [30, 40, 50],
        stopAtr: [3.0, 3.5, 4.0],
        rr: [3, 4, 5],
        trailAct: [20, 25, 30],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [0, 8],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, closes, p) => {
        const stc = mapStcToOriginal(closes, p.stcFast as number, p.stcSlow as number, p.cycle as number);
        const t = p.threshold as number;
        return (i) => {
          const c = stc[i], prev = stc[i-1];
          if (c === null || prev === null) return null;
          if (prev <= t && c > t) return "long";
          if (prev >= (100 - t) && c < (100 - t)) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // ─── Existing Paper Engines (risk-param-only grid) ─────────────────

    // PSAR (signal params fixed: step=0.02, max=0.1)
    {
      name: "PSAR",
      currentParams: { step: 0.02, max: 0.1, stopAtr: 5.0, rr: 6, trailAct: 9, trailDist: 2.5, sma: 50, adxMin: 18, stag: 8 },
      narrowRanges: {
        stopAtr: [4.0, 5.0, 6.0],
        rr: [4, 5, 6, 8],
        trailAct: [6, 9, 12],
        trailDist: [2, 2.5, 3],
        sma: [50, 75],
        adxMin: [14, 18, 22],
        stag: [6, 8, 10],
      },
      buildSignal: (candles, _closes, p) => {
        const psar = precomputePSAR(candles, p.step as number, p.max as number);
        return (i) => {
          const cs = psar[i], ps = psar[i-1];
          if (cs === null || ps === null) return null;
          const cc = candles[i].close, pc = candles[i-1].close;
          if (ps > pc && cs < cc) return "long";
          if (ps < pc && cs > cc) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: true,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // Vortex (signal param fixed: period=14)
    {
      name: "Vortex",
      currentParams: { period: 14, stopAtr: 5.0, rr: 4, trailAct: 6, trailDist: 3, sma: 50, adxMin: 14, stag: 10 },
      narrowRanges: {
        stopAtr: [4.0, 5.0, 6.0],
        rr: [3, 4, 5],
        trailAct: [4, 6, 8],
        trailDist: [2, 3, 4],
        sma: [50, 75],
        adxMin: [10, 14, 18],
        stag: [8, 10, 12],
      },
      buildSignal: (candles, _closes, p) => {
        const v = precomputeVortex(candles, p.period as number);
        return (i) => {
          const cp = v.vPlus[i], cm = v.vMinus[i], pp = v.vPlus[i-1], pm = v.vMinus[i-1];
          if (cp === null || cm === null || pp === null || pm === null) return null;
          if (pp <= pm && cp > cm) return "long";
          if (pp >= pm && cp < cm) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: true, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // CCI (signal params fixed: period=14, threshold=100)
    {
      name: "CCI",
      currentParams: { period: 14, threshold: 100, stopAtr: 3.5, rr: 4, trailAct: 30, trailDist: 4, sma: 50, adxMin: 8, stag: 10 },
      narrowRanges: {
        stopAtr: [3.0, 3.5, 4.0],
        rr: [3, 4, 5],
        trailAct: [25, 30, 35],
        trailDist: [3, 4, 5],
        sma: [50, 75],
        adxMin: [6, 8, 10],
        stag: [8, 10, 12],
      },
      buildSignal: (candles, _closes, p) => {
        const cci = precomputeCCI(candles, p.period as number);
        const t = p.threshold as number;
        return (i) => {
          const c = cci[i], prev = cci[i-1];
          if (c === null || prev === null) return null;
          if (prev <= t && c > t) return "long";
          if (prev >= -t && c < -t) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: true,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // DEMA (signal params fixed: fast=5, slow=21)
    {
      name: "DEMA",
      currentParams: { fast: 5, slow: 21, stopAtr: 3.0, rr: 4, trailAct: 25, trailDist: 5, sma: 50, adxMin: 10, stag: 16 },
      narrowRanges: {
        stopAtr: [2.5, 3.0, 3.5, 4.0],
        rr: [3, 4, 5],
        trailAct: [20, 25, 30],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [8, 10, 12],
        stag: [12, 16, 20],
      },
      buildSignal: (_candles, closes, p) => {
        const dF = computeDEMA(closes, p.fast as number);
        const dS = computeDEMA(closes, p.slow as number);
        return (i) => {
          const cf = dF[i], pf = dF[i-1], cs = dS[i], ps = dS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // HMA (signal params fixed: fast=3, slow=50)
    {
      name: "HMA",
      currentParams: { fast: 3, slow: 50, stopAtr: 3.0, rr: 6, trailAct: 25, trailDist: 5, sma: 50, adxMin: 0, stag: 10 },
      narrowRanges: {
        stopAtr: [2.5, 3.0, 3.5, 4.0],
        rr: [4, 5, 6, 8],
        trailAct: [20, 25, 30],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [0, 8, 10],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, closes, p) => {
        const hF = computeHMA(closes, p.fast as number);
        const hS = computeHMA(closes, p.slow as number);
        return (i) => {
          const cf = hF[i], pf = hF[i-1], cs = hS[i], ps = hS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // ZLEMA (signal params fixed: fast=10, slow=34)
    {
      name: "ZLEMA",
      currentParams: { fast: 10, slow: 34, stopAtr: 4.0, rr: 4, trailAct: 1, trailDist: 2, sma: 75, adxMin: 10, stag: 10 },
      narrowRanges: {
        stopAtr: [3.0, 3.5, 4.0, 5.0],
        rr: [3, 4, 5],
        trailAct: [1, 5, 10, 20],
        trailDist: [2, 3, 5],
        sma: [50, 75],
        adxMin: [8, 10, 12],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, closes, p) => {
        const zF = computeZLEMA(closes, p.fast as number);
        const zS = computeZLEMA(closes, p.slow as number);
        return (i) => {
          const cf = zF[i], pf = zF[i-1], cs = zS[i], ps = zS[i-1];
          if (cf === null || pf === null || cs === null || ps === null) return null;
          if (pf <= ps && cf > cs) return "long";
          if (pf >= ps && cf < cs) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },

    // Schaff (signal params fixed: fast=8, slow=20, cycle=12, threshold=40)
    {
      name: "Schaff",
      currentParams: { stcFast: 8, stcSlow: 20, cycle: 12, threshold: 40, stopAtr: 3.5, rr: 4, trailAct: 25, trailDist: 5, sma: 50, adxMin: 0, stag: 9 },
      narrowRanges: {
        stopAtr: [3.0, 3.5, 4.0],
        rr: [3, 4, 5],
        trailAct: [20, 25, 30],
        trailDist: [4, 5, 6],
        sma: [50, 75],
        adxMin: [0, 8, 10],
        stag: [8, 10, 12],
      },
      buildSignal: (_candles, closes, p) => {
        const stc = mapStcToOriginal(closes, p.stcFast as number, p.stcSlow as number, p.cycle as number);
        const t = p.threshold as number;
        return (i) => {
          const c = stc[i], prev = stc[i-1];
          if (c === null || prev === null) return null;
          if (prev <= t && c > t) return "long";
          if (prev >= (100 - t) && c < (100 - t)) return "short";
          return null;
        };
      },
      buildRunParams: (p) => ({
        smaPeriod: p.sma as number, adxMin: p.adxMin as number, adxNotDecl: false, reverseExit: false,
        trailActivation: p.trailAct as number, trailDistance: p.trailDist as number,
        stopAtrMult: p.stopAtr as number, rewardRisk: p.rr as number, stagnationBars: p.stag as number,
      }),
    },
  ];
}

// ─── Grid Runner ──────────────────────────────────────────────────────────────

function generateCombinations(ranges: Record<string, (number | boolean)[]>): Record<string, number | boolean>[] {
  const keys = Object.keys(ranges);
  const combos: Record<string, number | boolean>[] = [{}];
  for (const key of keys) {
    const newCombos: Record<string, number | boolean>[] = [];
    for (const combo of combos) {
      for (const val of ranges[key]) {
        newCombos.push({ ...combo, [key]: val });
      }
    }
    combos.length = 0;
    combos.push(...newCombos);
  }
  return combos;
}

function runEngineGrid(engine: FinetuneEngine, allPairData: Map<string, PairData>): SweepResult[] {
  const results: SweepResult[] = [];

  // Generate all combinations of narrow ranges merged with fixed params
  const combos = generateCombinations(engine.narrowRanges);
  console.log(`  ${combos.length} combinations to test`);

  for (const combo of combos) {
    const mergedParams = { ...engine.currentParams, ...combo };
    const rp = engine.buildRunParams(mergedParams);
    const result = evaluate3Fold(allPairData, rp, (candles, closes) => engine.buildSignal(candles, closes, mergedParams));
    if (result) {
      const paramStr = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(",");
      result.strategy = `${engine.name}(${paramStr})`;
      results.push(result);
    }
  }

  return results;
}

// ─── Output Formatting ───────────────────────────────────────────────────────

function printTop5(name: string, results: SweepResult[]): void {
  const sorted = results.sort((a, b) => b.sharpe - a.sharpe);
  const top5 = sorted.slice(0, 5);
  console.log(`\n--- ${name}: Top 5 by Sharpe ---`);
  console.log(`${"#".padStart(2)} | ${"Sharpe".padStart(7)} | ${"WinRate".padStart(7)} | ${"Trades".padStart(6)} | ${"MaxDD".padStart(8)} | ${"PctDay".padStart(7)} | F1/F2/F3 | Strategy`);
  for (let i = 0; i < top5.length; i++) {
    const r = top5[i];
    const foldStr = r.foldSharpes.map(f => f.toFixed(1)).join("/");
    console.log(
      `${(i + 1).toString().padStart(2)} | ${r.sharpe.toFixed(2).padStart(7)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.trades.toString().padStart(6)} | $${r.maxDD.toFixed(2).padStart(7)} | ${r.pctPerDay.toFixed(3).padStart(6)}% | ${foldStr} | ${r.strategy}`,
    );
  }
}

function printRecommendations(engines: FinetuneEngine[], allResults: Map<string, SweepResult[]>): void {
  console.log("\n\n========== RECOMMENDED CHANGES ==========\n");

  for (const engine of engines) {
    const results = allResults.get(engine.name);
    if (!results || results.length === 0) continue;

    // Get current baseline
    const currentRp = engine.buildRunParams(engine.currentParams);
    const currentResult = evaluate3FoldWithParams(engine, engine.currentParams);
    const best = results.sort((a, b) => b.sharpe - a.sharpe)[0];

    console.log(`--- ${engine.name} ---`);
    if (currentResult) {
      console.log(`  Current: Sharpe=${currentResult.sharpe.toFixed(2)} WinRate=${currentResult.winRate.toFixed(1)}% Trades=${currentResult.trades} MaxDD=$${currentResult.maxDD.toFixed(2)}`);
    }
    console.log(`  Best:    Sharpe=${best.sharpe.toFixed(2)} WinRate=${best.winRate.toFixed(1)}% Trades=${best.trades} MaxDD=$${best.maxDD.toFixed(2)}`);

    // Parse best params from strategy string
    const paramMatch = best.strategy.match(/\((.+)\)/);
    if (paramMatch) {
      const bestParams: Record<string, number | boolean> = {};
      paramMatch[1].split(",").forEach(kv => {
        const [k, v] = kv.split("=");
        bestParams[k] = v === "true" ? true : v === "false" ? false : Number(v);
      });

      // Compare with current
      const diffs: string[] = [];
      for (const [key, val] of Object.entries(bestParams)) {
        const current = engine.currentParams[key];
        if (current !== undefined && current !== val) {
          diffs.push(`  ${key}: ${current} -> ${val}`);
        }
      }

      if (diffs.length > 0) {
        console.log(`  Changes:`);
        for (const d of diffs) console.log(d);
        const improvement = currentResult ? ((best.sharpe - currentResult.sharpe) / Math.abs(currentResult.sharpe) * 100).toFixed(1) : "N/A";
        console.log(`  Sharpe improvement: ${improvement}%`);
      } else {
        console.log(`  No changes recommended (current params are optimal)`);
      }
    }
    console.log("");
  }
}

// Helper to evaluate current params baseline
let _allPairData: Map<string, PairData> | null = null;

function evaluate3FoldWithParams(engine: FinetuneEngine, params: Record<string, number | boolean>): SweepResult | null {
  if (!_allPairData) return null;
  const rp = engine.buildRunParams(params);
  const result = evaluate3Fold(_allPairData, rp, (candles, closes) => engine.buildSignal(candles, closes, params));
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const engineFilter = process.env.ENGINE?.toLowerCase();

  console.log("=== Fine-Tuning Backtest: Narrow Parameter Grid ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Lookback: ${DAYS_LOOKBACK} days | Pairs: ${PAIRS.length} | Folds: 3 walk-forward`);
  if (engineFilter) console.log(`Filter: ENGINE=${engineFilter}`);
  console.log("");

  // Fetch candle data
  console.log("Fetching candle data...\n");
  const allSma = [50, 75];
  const allPairData = new Map<string, PairData>();

  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}...`);
    try {
      const [h4c, daily] = await Promise.all([
        fetchCandles(pair, "4h", DAYS_LOOKBACK),
        fetchCandles(pair, "1d", DAYS_LOOKBACK),
      ]);
      if (h4c.length < MIN_PAIR_BARS) { console.log(` SKIP (${h4c.length} bars < ${MIN_PAIR_BARS})`); continue; }
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
    await sleep(200);
  }
  console.log(`\nLoaded: ${allPairData.size} pairs\n`);
  _allPairData = allPairData;

  const engines = buildFinetuneEngines().filter(e =>
    !engineFilter || e.name.toLowerCase().includes(engineFilter),
  );

  if (engines.length === 0) {
    console.log(`No engines match filter "${engineFilter}". Available: ${buildFinetuneEngines().map(e => e.name).join(", ")}`);
    return;
  }

  const allResultsByEngine = new Map<string, SweepResult[]>();

  for (let i = 0; i < engines.length; i++) {
    const engine = engines[i];
    console.log(`\nEngine ${i + 1}/${engines.length}: ${engine.name}`);
    const engineStart = Date.now();

    const results = runEngineGrid(engine, allPairData);
    allResultsByEngine.set(engine.name, results);

    const elapsed = ((Date.now() - engineStart) / 1000).toFixed(0);
    console.log(`  ${results.length} valid results in ${elapsed}s`);

    if (results.length > 0) {
      printTop5(engine.name, results);
    }
  }

  // Print recommendations
  printRecommendations(engines, allResultsByEngine);

  const totalElapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
  const totalResults = Array.from(allResultsByEngine.values()).reduce((s, r) => s + r.length, 0);
  console.log(`\nDone! Total runtime: ${totalElapsed} minutes | ${totalResults} strategies tested across ${engines.length} engines`);
}

main().catch(console.error);
