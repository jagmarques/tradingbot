/**
 * Regime Investigation: WHY does regime adaptation hurt?
 *
 * Full regime-adaptive system: -$0.36/day
 * Simple 3-engine no-regime: +$1.62/day
 *
 * This script isolates EXACTLY which component kills performance.
 *
 * Configs tested:
 *   A. Pure 3-engine, NO regime bias, NO size mult
 *   B. 3-engine + regime DIRECTION BIAS only
 *   C. 3-engine + regime SIZE MULT only
 *   D. 3-engine + BOTH direction bias + size mult
 *   E. 3-engine + direction + size + GARCH in RISK-OFF
 *   F. 3-engine + direction + size + Alt Rotation in RISK-ON
 *   G. Full system (all of the above)
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/ (2023-01 to 2026-03)
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const HOUR = 3_600_000;
const H4 = 4 * HOUR;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MAX_POSITIONS = 10;
const SL_SLIPPAGE = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";
type Regime = "RISK-OFF" | "RECOVERY" | "RISK-ON" | "CORRECTION";

interface Trade {
  pair: string; dir: Dir; engine: string;
  ep: number; xp: number; et: number; xt: number;
  pnl: number; reason: string; margin: number;
  regime: Regime;
}

interface Position {
  pair: string; dir: Dir; engine: string;
  ep: number; et: number; sl: number;
  margin: number;
  atrAtEntry: number;
  peakPnlAtr: number;
  trailLevel: number;
  regime: Regime;
}

interface Signal {
  pair: string; dir: Dir; engine: string;
  margin: number; sl: number; atrAtEntry: number;
}

interface ConfigFlags {
  label: string;
  directionBias: boolean;    // RISK-OFF => shorts only
  sizeMultiplier: boolean;   // CORRECTION 0.5x, RECOVERY 0.75x
  garchRiskOff: boolean;     // engine E in RISK-OFF
  altRotRiskOn: boolean;     // engine F in RISK-ON
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: C[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(bars: C[], period: number): number[] {
  const atr = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          bars[j].h - bars[j].l,
          Math.abs(bars[j].h - bars[j - 1].c),
          Math.abs(bars[j].l - bars[j - 1].c),
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcSMA(values: number[], period: number): number[] {
  const r = new Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function calcEMA(values: number[], period: number): number[] {
  const r = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      r[i] = s / period;
      init = true;
    } else {
      r[i] = values[i] * k + r[i - 1] * (1 - k);
    }
  }
  return r;
}

function calcSupertrend(bars: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(bars, atrPeriod);
  const stArr = new Array(bars.length).fill(0);
  const dirs = new Array(bars.length).fill(1);

  for (let i = atrPeriod; i < bars.length; i++) {
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (bars[i - 1].h + bars[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (bars[i - 1].h + bars[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = stArr[i - 1] > 0 && dirs[i - 1] === -1 ? stArr[i - 1] : prevUpper;
      const prevFinalLower = stArr[i - 1] > 0 && dirs[i - 1] === 1 ? stArr[i - 1] : prevLower;

      if (!(lowerBand > prevFinalLower || bars[i - 1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || bars[i - 1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = bars[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = bars[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = bars[i].c > upperBand ? 1 : -1;
      }
    }
    stArr[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st: stArr, dir: dirs };
}

function calcDonchianHigh(highs: number[], period: number): number[] {
  const r = new Array(highs.length).fill(0);
  for (let i = period; i < highs.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, highs[j]);
    r[i] = mx;
  }
  return r;
}

function calcDonchianLow(lows: number[], period: number): number[] {
  const r = new Array(lows.length).fill(0);
  for (let i = period; i < lows.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, lows[j]);
    r[i] = mn;
  }
  return r;
}

function calcRealizedVol(closes: number[], period: number): number[] {
  const r = new Array(closes.length).fill(0);
  for (let i = period; i < closes.length; i++) {
    let sumSq = 0;
    let n = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (closes[j - 1] > 0) {
        const ret = Math.log(closes[j] / closes[j - 1]);
        sumSq += ret * ret;
        n++;
      }
    }
    if (n > 1) {
      r[i] = Math.sqrt(sumSq / n) * Math.sqrt(365) * 100;
    }
  }
  return r;
}

function calcZScores(closes: number[], lookback: number): number[] {
  const z = new Array(closes.length).fill(0);
  for (let i = lookback; i < closes.length; i++) {
    let sum = 0, sumSq = 0;
    for (let j = i - lookback; j < i; j++) {
      sum += closes[j];
      sumSq += closes[j] * closes[j];
    }
    const mean = sum / lookback;
    const variance = sumSq / lookback - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    if (std > 0) z[i] = (closes[i] - mean) / std;
  }
  return z;
}

// ─── PnL Calculation ────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: Dir, isSL: boolean, notional: number): number {
  const spread = sp(pair);
  const entrySlip = ep * spread;
  const exitSlip = xp * spread * (isSL ? SL_SLIPPAGE : 1);
  const fees = notional * FEE * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── ATR Trailing Ladder ────────────────────────────────────────────
function updateATRTrail(pos: Position, currentPrice: number): void {
  if (pos.atrAtEntry <= 0) return;
  const atr = pos.atrAtEntry;
  const pnlAtr = pos.dir === "long"
    ? (currentPrice - pos.ep) / atr
    : (pos.ep - currentPrice) / atr;

  if (pnlAtr > pos.peakPnlAtr) pos.peakPnlAtr = pnlAtr;

  let newTrail = 0;
  if (pos.peakPnlAtr >= 3) {
    newTrail = pos.dir === "long"
      ? pos.ep + (pos.peakPnlAtr - 1.5) * atr
      : pos.ep - (pos.peakPnlAtr - 1.5) * atr;
  } else if (pos.peakPnlAtr >= 2) {
    newTrail = pos.dir === "long"
      ? pos.ep + (pos.peakPnlAtr - 2) * atr
      : pos.ep - (pos.peakPnlAtr - 2) * atr;
  } else if (pos.peakPnlAtr >= 1) {
    newTrail = pos.ep;
  }

  if (newTrail > 0) {
    if (pos.dir === "long") {
      if (newTrail > pos.trailLevel) pos.trailLevel = newTrail;
      if (pos.trailLevel > pos.sl) pos.sl = pos.trailLevel;
    } else {
      if (pos.trailLevel === 0 || newTrail < pos.trailLevel) pos.trailLevel = newTrail;
      if (pos.trailLevel > 0 && pos.trailLevel < pos.sl) pos.sl = pos.trailLevel;
    }
  }
}

// ─── Precomputed Data Structures ────────────────────────────────────
interface PairData {
  h4: C[];
  daily: C[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  h4ATR: number[];
  h4ST: number[];
  h4Vol20: number[];
  dailySMA20: number[];
  dailySMA50: number[];
  dailyATR: number[];
  dailyDonHi15: number[];
  dailyDonLo15: number[];
}

interface BTCData {
  daily: C[];
  dailyMap: Map<number, number>;
  dailyCloses: number[];
  dailyEma20: number[];
  dailyEma50: number[];
  dailyVol30: number[];
  dailyMom20: number[];
  daily7dReturn: number[];
}

interface DayRegime {
  ts: number;
  regime: Regime;
  fearProxy: number;
  btc7dReturn: number;
}

// ─── Regime Classification ──────────────────────────────────────────
function classifyDayRegimes(btcD: BTCData): Map<number, DayRegime> {
  const regimes = new Map<number, DayRegime>();

  for (let i = 30; i < btcD.daily.length; i++) {
    const dayTs = Math.floor(btcD.daily[i].t / DAY) * DAY;

    const vol30 = btcD.dailyVol30[i];
    const mom20 = i >= 20 ? (btcD.dailyCloses[i] / btcD.dailyCloses[i - 20] - 1) * 100 : 0;

    const fgScore = 50 + mom20 * 1.0 - Math.max(0, vol30 - 40) * 0.5;
    const clampedFG = Math.max(0, Math.min(100, fgScore));
    const isFearful = clampedFG < 25;

    const btc7d = i >= 7 ? (btcD.dailyCloses[i] / btcD.dailyCloses[i - 7] - 1) * 100 : 0;
    const isDeclining = btc7d < -3;

    let regime: Regime;
    if (isFearful && isDeclining) regime = "RISK-OFF";
    else if (isFearful && !isDeclining) regime = "RECOVERY";
    else if (!isFearful && !isDeclining) regime = "RISK-ON";
    else regime = "CORRECTION";

    regimes.set(dayTs, { ts: dayTs, regime, fearProxy: clampedFG, btc7dReturn: btc7d });
  }

  return regimes;
}

function getRegime(regimes: Map<number, DayRegime>, t: number): Regime {
  const dayTs = Math.floor(t / DAY) * DAY;
  return regimes.get(dayTs)?.regime ?? "RISK-ON";
}

// ─── Size Multiplier ────────────────────────────────────────────────
function sizeMultiplier(regime: Regime, useMult: boolean): number {
  if (!useMult) return 1.0;
  switch (regime) {
    case "RISK-OFF": return 1.0;
    case "RECOVERY": return 0.75;
    case "RISK-ON": return 1.0;
    case "CORRECTION": return 0.5;
  }
}

function directionAllowed(regime: Regime, dir: Dir, useBias: boolean): boolean {
  if (!useBias) return true;
  if (regime === "RISK-OFF") return dir === "short";
  return true;
}

// ═════════════════════════════════════════════════════════════════════
// Engine Signals - identical to bt-full-regime-system.ts
// but with configurable regime flags
// ═════════════════════════════════════════════════════════════════════

function engineA_signals(
  pairDataMap: Map<string, PairData>,
  btcD: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
  cfg: ConfigFlags,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  const mult = sizeMultiplier(regime, cfg.sizeMultiplier);
  const margin = baseMargin * mult;

  const btcDayTs = Math.floor(barTime / DAY) * DAY;
  let btcDi = btcD.dailyMap.get(btcDayTs);
  if (btcDi === undefined) {
    let best = -1;
    for (let k = 0; k < btcD.daily.length; k++) {
      if (btcD.daily[k].t <= btcDayTs) best = k; else break;
    }
    if (best >= 0) btcDi = best;
  }
  const btcEmaIdx = btcDi !== undefined && btcDi > 0 ? btcDi - 1 : undefined;
  const btcE20 = btcEmaIdx !== undefined ? btcD.dailyEma20[btcEmaIdx] : 0;
  const btcE50 = btcEmaIdx !== undefined ? btcD.dailyEma50[btcEmaIdx] : 0;
  const btcLongsOK = btcE20 > btcE50 && btcE20 > 0 && btcE50 > 0;

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;

    const dayTs = Math.floor(barTime / DAY) * DAY;
    if (barTime !== dayTs) continue;

    let di = pd.dailyMap.get(dayTs);
    if (di === undefined) {
      let bestDi = -1;
      for (let k = 0; k < pd.daily.length; k++) {
        if (pd.daily[k].t <= dayTs) bestDi = k; else break;
      }
      if (bestDi >= 0) di = bestDi;
    }
    if (di === undefined || di < 50) continue;

    const sma20 = pd.dailySMA20[di - 1];
    const sma50 = pd.dailySMA50[di - 1];
    if (!sma20 || !sma50) continue;

    const prevClose = pd.daily[di - 1].c;
    const donHi15 = pd.dailyDonHi15[di - 1];
    const donLo15 = pd.dailyDonLo15[di - 1];
    if (!donHi15 || !donLo15) continue;

    const atr = pd.dailyATR[di - 1];
    if (!atr || atr <= 0) continue;

    const ep = pd.daily[di].o;
    let dir: Dir | null = null;

    if (prevClose > sma20 && sma20 > sma50 && prevClose > donHi15) {
      dir = "long";
    } else if (prevClose < sma20 && sma20 < sma50 && prevClose < donLo15) {
      dir = "short";
    }
    if (!dir) continue;
    if (!directionAllowed(regime, dir, cfg.directionBias)) continue;
    if (dir === "long" && !btcLongsOK) continue;

    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;
    signals.push({ pair, dir, engine: "A-Donchian", margin, sl, atrAtEntry: atr });
  }
  return signals;
}

function engineB_signals(
  pairDataMap: Map<string, PairData>,
  btcD: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
  cfg: ConfigFlags,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  const mult = sizeMultiplier(regime, cfg.sizeMultiplier);
  const margin = baseMargin * mult;

  const btcDayTs = Math.floor(barTime / DAY) * DAY;
  let btcDiB = btcD.dailyMap.get(btcDayTs);
  if (btcDiB === undefined) {
    let best = -1;
    for (let k = 0; k < btcD.daily.length; k++) {
      if (btcD.daily[k].t <= btcDayTs) best = k; else break;
    }
    if (best >= 0) btcDiB = best;
  }
  const btcEmaIdxB = btcDiB !== undefined && btcDiB > 0 ? btcDiB - 1 : undefined;
  const btcE20B = btcEmaIdxB !== undefined ? btcD.dailyEma20[btcEmaIdxB] : 0;
  const btcE50B = btcEmaIdxB !== undefined ? btcD.dailyEma50[btcEmaIdxB] : 0;
  const btcLongsOK = btcE20B > btcE50B && btcE20B > 0 && btcE50B > 0;

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;

    const h4i = pd.h4Map.get(barTime);
    if (h4i === undefined || h4i < 20) continue;

    const stNow = pd.h4ST[h4i - 1];
    const stPrev = h4i >= 2 ? pd.h4ST[h4i - 2] : stNow;
    if (stNow === stPrev) continue;

    const dir: Dir = stNow === 1 ? "long" : "short";
    const curVol = pd.h4[h4i - 1]?.v ?? 0;
    const avgVol = pd.h4Vol20[h4i - 1] || 0;
    if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;

    if (!directionAllowed(regime, dir, cfg.directionBias)) continue;
    if (dir === "long" && !btcLongsOK) continue;

    const ep = pd.h4[h4i].o;
    const atr = pd.h4ATR[h4i - 1];
    if (!atr || atr <= 0) continue;

    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;
    signals.push({ pair, dir, engine: "B-Supertrend", margin, sl, atrAtEntry: atr });
  }
  return signals;
}

function engineD_signals(
  pairDataMap: Map<string, PairData>,
  btcD: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
  cfg: ConfigFlags,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  const mult = sizeMultiplier(regime, cfg.sizeMultiplier);
  const margin = baseMargin * mult;

  const dayTs = Math.floor(barTime / DAY) * DAY;
  if (barTime !== dayTs) return signals;

  const findDi = (pd: PairData): number | undefined => {
    let di = pd.dailyMap.get(dayTs);
    if (di === undefined) {
      let best = -1;
      for (let k = 0; k < pd.daily.length; k++) {
        if (pd.daily[k].t <= dayTs) best = k; else break;
      }
      if (best >= 0) di = best;
    }
    return di;
  };

  const pairReturns: { pair: string; ret5d: number; atr: number; di: number }[] = [];
  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;
    const di = findDi(pd);
    if (di === undefined || di < 10) continue;
    const ret5d = pd.daily[di - 1].c / pd.daily[Math.max(0, di - 6)].c - 1;
    const atr = pd.dailyATR[di - 1];
    if (!atr || atr <= 0) continue;
    pairReturns.push({ pair, ret5d, atr, di });
  }
  if (pairReturns.length < 5) return signals;
  pairReturns.sort((a, b) => Math.abs(b.ret5d) - Math.abs(a.ret5d));

  const top = pairReturns.slice(0, 3);
  for (const { pair, ret5d, atr, di } of top) {
    if (Math.abs(ret5d) < 0.03) continue;
    const dir: Dir = ret5d > 0 ? "long" : "short";
    if (!directionAllowed(regime, dir, cfg.directionBias)) continue;
    const pd = pairDataMap.get(pair)!;
    const ep = pd.daily[di].o;
    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;
    signals.push({ pair, dir, engine: "D-Carry", margin, sl, atrAtEntry: atr });
  }
  return signals;
}

function engineE_signals(
  pairDataMap: Map<string, PairData>,
  btcD: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  h1Data: Map<string, C[]>,
  h1ZScores: Map<string, number[]>,
  h1Maps: Map<string, Map<number, number>>,
  baseMargin: number,
  cfg: ConfigFlags,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  // Engine E only fires in RISK-OFF
  if (regime !== "RISK-OFF") return signals;

  const mult = sizeMultiplier(regime, cfg.sizeMultiplier);
  const margin = baseMargin * mult;

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;
    const h4i = pd.h4Map.get(barTime);
    if (h4i === undefined || h4i < 25) continue;
    const h1Bars = h1Data.get(pair);
    const h1ZS = h1ZScores.get(pair);
    const h1Map = h1Maps.get(pair);
    if (!h1Bars || !h1ZS || !h1Map) continue;
    const h1i = h1Map.get(barTime);
    if (h1i === undefined || h1i < 25) continue;
    const z1h = h1ZS[h1i - 1] || 0;

    const h4Closes = pd.h4.map(b => b.c);
    let z4h = 0;
    if (h4i >= 21) {
      const lookback = 20;
      let sum = 0, sumSq = 0;
      for (let j = h4i - lookback; j < h4i; j++) {
        sum += h4Closes[j];
        sumSq += h4Closes[j] * h4Closes[j];
      }
      const mean = sum / lookback;
      const variance = sumSq / lookback - mean * mean;
      const std = Math.sqrt(Math.max(0, variance));
      if (std > 0) z4h = (h4Closes[h4i - 1] - mean) / std;
    }

    const zAvg = (z1h + z4h) / 2;
    let dir: Dir | null = null;
    if (zAvg > 2.0) dir = "short";
    else if (zAvg < -2.0) dir = "long";
    if (!dir) continue;
    // In RISK-OFF, only shorts (direction bias always active for E since E = RISK-OFF only)
    if (dir !== "short") continue;

    const ep = pd.h4[h4i].o;
    const atr = pd.h4ATR[h4i - 1];
    if (!atr || atr <= 0) continue;
    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;
    signals.push({ pair, dir, engine: "E-GARCH", margin, sl, atrAtEntry: atr });
  }
  return signals;
}

function engineF_signals(
  pairDataMap: Map<string, PairData>,
  btcD: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
  cfg: ConfigFlags,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  if (regime !== "RISK-ON") return signals;

  const mult = sizeMultiplier(regime, cfg.sizeMultiplier);
  const margin = baseMargin * mult;

  const dayTs = Math.floor(barTime / DAY) * DAY;
  if (barTime !== dayTs) return signals;

  const findDi = (pd: PairData): number | undefined => {
    let di = pd.dailyMap.get(dayTs);
    if (di === undefined) {
      let best = -1;
      for (let k = 0; k < pd.daily.length; k++) {
        if (pd.daily[k].t <= dayTs) best = k; else break;
      }
      if (best >= 0) di = best;
    }
    return di;
  };

  const pairReturns: { pair: string; ret3d: number; atr: number; di: number }[] = [];
  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;
    const di = findDi(pd);
    if (di === undefined || di < 10) continue;
    const ret3d = pd.daily[di - 1].c / pd.daily[Math.max(0, di - 4)].c - 1;
    const atr = pd.dailyATR[di - 1];
    if (!atr || atr <= 0) continue;
    pairReturns.push({ pair, ret3d, atr, di });
  }
  pairReturns.sort((a, b) => b.ret3d - a.ret3d);
  const top5 = pairReturns.slice(0, 5).filter(p => p.ret3d > 0.01);

  for (const { pair, atr, di } of top5) {
    const pd = pairDataMap.get(pair)!;
    const ep = pd.daily[di].o;
    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = ep - slDist;
    signals.push({ pair, dir: "long", engine: "F-AltRotation", margin, sl, atrAtEntry: atr });
  }
  return signals;
}

// ═════════════════════════════════════════════════════════════════════
// Main Simulation Runner
// ═════════════════════════════════════════════════════════════════════
function runSim(
  cfg: ConfigFlags,
  pairDataMap: Map<string, PairData>,
  btcD: BTCData,
  regimes: Map<number, DayRegime>,
  h1DataMap: Map<string, C[]>,
  h1ZScoreMap: Map<string, number[]>,
  h1MapMap: Map<string, Map<number, number>>,
  sortedTs: number[],
): Trade[] {
  const positions = new Map<string, Position>();
  const allTrades: Trade[] = [];

  // Track blocked signals for analysis
  const blockedSignals: Signal[] = [];

  for (const t of sortedTs) {
    const regime = getRegime(regimes, t);

    // 1. Manage existing positions
    const toClose: string[] = [];
    for (const [key, pos] of positions) {
      const pd = pairDataMap.get(pos.pair);
      if (!pd) continue;
      const h4i = pd.h4Map.get(t);
      let bar: C | undefined;
      if (h4i !== undefined) bar = pd.h4[h4i];
      if (!bar) continue;

      updateATRTrail(pos, bar.c);

      let xp = 0;
      let reason = "";
      let slHit = false;

      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl; reason = "sl"; slHit = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl; reason = "sl"; slHit = true;
      }

      if (!xp && (t - pos.et) > 48 * HOUR) {
        xp = bar.c; reason = "stagnation";
      }

      if (!xp && pos.engine === "B-Supertrend") {
        const h4idx = pd.h4Map.get(t);
        if (h4idx !== undefined && h4idx >= 2) {
          const stNow = pd.h4ST[h4idx - 1];
          const stPrev = pd.h4ST[h4idx - 2];
          if (stNow !== stPrev) {
            if ((pos.dir === "long" && stNow === -1) || (pos.dir === "short" && stNow === 1)) {
              xp = bar.o; reason = "flip";
            }
          }
        }
      }

      if (!xp && pos.engine === "A-Donchian") {
        const dayTs = Math.floor(t / DAY) * DAY;
        const di = pd.dailyMap.get(dayTs);
        if (di !== undefined && di > 0 && t === dayTs) {
          const donLo = pd.dailyDonLo15[di];
          const donHi = pd.dailyDonHi15[di];
          if (pos.dir === "long" && donLo > 0 && pd.daily[di - 1].c < donLo) {
            xp = bar.o; reason = "don-exit";
          } else if (pos.dir === "short" && donHi > 0 && pd.daily[di - 1].c > donHi) {
            xp = bar.o; reason = "don-exit";
          }
        }
      }

      if (xp > 0) {
        const notional = pos.margin * LEV;
        const pnl = tradePnl(pos.pair, pos.ep, xp, pos.dir, slHit, notional);
        allTrades.push({
          pair: pos.pair, dir: pos.dir, engine: pos.engine,
          ep: pos.ep, xp, et: pos.et, xt: t,
          pnl, reason, margin: pos.margin, regime: pos.regime,
        });
        toClose.push(key);
      }
    }
    for (const key of toClose) positions.delete(key);

    // 2. Generate new signals
    if (positions.size >= MAX_POSITIONS) continue;

    const allSignals: Signal[] = [];
    allSignals.push(...engineA_signals(pairDataMap, btcD, regimes, t, 7, cfg));
    allSignals.push(...engineB_signals(pairDataMap, btcD, regimes, t, 5, cfg));
    allSignals.push(...engineD_signals(pairDataMap, btcD, regimes, t, 7, cfg));

    if (cfg.garchRiskOff) {
      allSignals.push(...engineE_signals(pairDataMap, btcD, regimes, t, h1DataMap, h1ZScoreMap, h1MapMap, 5, cfg));
    }
    if (cfg.altRotRiskOn) {
      allSignals.push(...engineF_signals(pairDataMap, btcD, regimes, t, 5, cfg));
    }

    const filtered = allSignals.filter(s => {
      const key = `${s.engine}:${s.pair}`;
      return !positions.has(key);
    });

    for (const sig of filtered) {
      if (positions.size >= MAX_POSITIONS) break;
      const key = `${sig.engine}:${sig.pair}`;
      const pd = pairDataMap.get(sig.pair);
      if (!pd) continue;

      const h4i = pd.h4Map.get(t);
      let ep: number;
      if (h4i !== undefined) {
        ep = pd.h4[h4i].o;
      } else {
        const dayTs = Math.floor(t / DAY) * DAY;
        const di = pd.dailyMap.get(dayTs);
        if (di === undefined) continue;
        ep = pd.daily[di].o;
      }

      const spread = sp(sig.pair);
      const entryPrice = sig.dir === "long" ? ep * (1 + spread) : ep * (1 - spread);
      const slDist = Math.abs(ep - sig.sl);
      const sl = sig.dir === "long" ? entryPrice - slDist : entryPrice + slDist;

      positions.set(key, {
        pair: sig.pair, dir: sig.dir, engine: sig.engine,
        ep: entryPrice, et: t, sl,
        margin: sig.margin,
        peakPnlAtr: 0, atrAtEntry: sig.atrAtEntry, trailLevel: 0,
        regime,
      });
    }
  }

  // Close remaining
  for (const [, pos] of positions) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd || pd.h4.length === 0) continue;
    const lastBar = pd.h4[pd.h4.length - 1];
    const notional = pos.margin * LEV;
    const pnl = tradePnl(pos.pair, pos.ep, lastBar.c, pos.dir, false, notional);
    allTrades.push({
      pair: pos.pair, dir: pos.dir, engine: pos.engine,
      ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
      pnl, reason: "end", margin: pos.margin, regime: pos.regime,
    });
  }

  allTrades.sort((a, b) => a.xt - b.xt);
  return allTrades;
}

// ═════════════════════════════════════════════════════════════════════
// Stats Calculation
// ═════════════════════════════════════════════════════════════════════
interface Stats {
  n: number;
  total: number;
  perDay: number;
  wr: number;
  pf: number;
  sharpe: number;
  maxDD: number;
}

function calcStats(trades: Trade[]): Stats {
  const days = (FULL_END - FULL_START) / DAY;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const wr = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;

  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const dailyReturns = [...dayPnl.values()];
  const mean = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const std = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    n: trades.length,
    total,
    perDay: days > 0 ? total / days : 0,
    wr,
    pf,
    sharpe,
    maxDD,
  };
}

// ═════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════
console.log("=== REGIME INVESTIGATION: WHY does regime adaptation hurt? ===");
console.log(`Period: 2023-01-01 to 2026-03-26`);
console.log(`Pairs: ${PAIRS.join(", ")}`);
console.log();

// Load data
console.log("Loading data...");
const pairDataMap = new Map<string, PairData>();
const h1DataMap = new Map<string, C[]>();
const h1ZScoreMap = new Map<string, number[]>();
const h1MapMap = new Map<string, Map<number, number>>();

for (const pair of [...PAIRS, "BTC"]) {
  const raw5m = load5m(pair);
  if (raw5m.length < 1000) { console.log(`  SKIP ${pair}: only ${raw5m.length} bars`); continue; }

  const h4 = aggregate(raw5m, H4);
  const daily = aggregate(raw5m, DAY);
  const h1 = aggregate(raw5m, HOUR);

  const h4Map = new Map<number, number>();
  h4.forEach((b, i) => h4Map.set(b.t, i));
  const dailyMap = new Map<number, number>();
  daily.forEach((b, i) => dailyMap.set(b.t, i));
  const h1Map = new Map<number, number>();
  h1.forEach((b, i) => h1Map.set(b.t, i));

  const h4ATR = calcATR(h4, 14);
  const { dir: h4STDirs } = calcSupertrend(h4, 14, 1.75);
  const h4Vols = h4.map(b => b.v);
  const h4Vol20 = calcSMA(h4Vols, 20);

  const dailyCloses = daily.map(b => b.c);
  const dailyHighs = daily.map(b => b.h);
  const dailyLows = daily.map(b => b.l);
  const dailySMA20 = calcSMA(dailyCloses, 20);
  const dailySMA50 = calcSMA(dailyCloses, 50);
  const dailyATR = calcATR(daily, 14);
  const dailyDonHi15 = calcDonchianHigh(dailyHighs, 15);
  const dailyDonLo15 = calcDonchianLow(dailyLows, 15);

  if (pair !== "BTC") {
    pairDataMap.set(pair, {
      h4, daily, h4Map, dailyMap,
      h4ATR, h4ST: h4STDirs, h4Vol20,
      dailySMA20, dailySMA50, dailyATR,
      dailyDonHi15, dailyDonLo15,
    });
    h1DataMap.set(pair, h1);
    h1ZScoreMap.set(pair, calcZScores(h1.map(b => b.c), 20));
    h1MapMap.set(pair, h1Map);
  }
}

// BTC data
const btcRaw = load5m("BTC");
const btcDaily = aggregate(btcRaw, DAY);
const btcDailyMap = new Map<number, number>();
btcDaily.forEach((b, i) => btcDailyMap.set(b.t, i));
const btcCloses = btcDaily.map(b => b.c);

const btcData: BTCData = {
  daily: btcDaily,
  dailyMap: btcDailyMap,
  dailyCloses: btcCloses,
  dailyEma20: calcEMA(btcCloses, 20),
  dailyEma50: calcEMA(btcCloses, 50),
  dailyVol30: calcRealizedVol(btcCloses, 30),
  dailyMom20: btcCloses.map((c, i) => i >= 20 ? (c / btcCloses[i - 20] - 1) * 100 : 0),
  daily7dReturn: btcCloses.map((c, i) => i >= 7 ? (c / btcCloses[i - 7] - 1) * 100 : 0),
};

// Regimes
const regimes = classifyDayRegimes(btcData);
console.log(`  BTC daily bars: ${btcDaily.length}`);
console.log(`  Pairs loaded: ${pairDataMap.size}`);
console.log(`  Regime days: ${regimes.size}`);

// All timestamps
const allTimestamps = new Set<number>();
for (const pd of pairDataMap.values()) {
  for (const b of pd.h4) {
    if (b.t >= FULL_START && b.t < FULL_END) allTimestamps.add(b.t);
  }
  for (const b of pd.daily) {
    if (b.t >= FULL_START && b.t < FULL_END) allTimestamps.add(b.t);
  }
}
const sortedTs = [...allTimestamps].sort((a, b) => a - b);
console.log(`  Time steps: ${sortedTs.length}`);
console.log();

// ═════════════════════════════════════════════════════════════════════
// 1. REGIME PROXY ANALYSIS
// ═════════════════════════════════════════════════════════════════════
console.log("=".repeat(80));
console.log("  SECTION 1: REGIME PROXY ANALYSIS");
console.log("=".repeat(80));

const regDist = new Map<Regime, number>();
const regimeTransitions: { from: Regime; to: Regime; ts: number }[] = [];
let prevRegime: Regime | null = null;
let transitionCount = 0;
const fgValues: number[] = [];

const regimeByDay = [...regimes.entries()].sort((a, b) => a[0] - b[0]);
for (const [ts, rd] of regimeByDay) {
  regDist.set(rd.regime, (regDist.get(rd.regime) ?? 0) + 1);
  fgValues.push(rd.fearProxy);
  if (prevRegime !== null && prevRegime !== rd.regime) {
    transitionCount++;
    regimeTransitions.push({ from: prevRegime, to: rd.regime, ts });
  }
  prevRegime = rd.regime;
}

// Regime durations (consecutive days in same regime)
const stints: { regime: Regime; days: number }[] = [];
let currentRegime: Regime | null = null;
let currentDays = 0;
for (const [, rd] of regimeByDay) {
  if (rd.regime !== currentRegime) {
    if (currentRegime) stints.push({ regime: currentRegime, days: currentDays });
    currentRegime = rd.regime;
    currentDays = 1;
  } else {
    currentDays++;
  }
}
if (currentRegime) stints.push({ regime: currentRegime, days: currentDays });

console.log("\n  Regime distribution:");
const totalDays = [...regDist.values()].reduce((s, n) => s + n, 0);
for (const r of ["RISK-ON", "RECOVERY", "CORRECTION", "RISK-OFF"] as Regime[]) {
  const n = regDist.get(r) ?? 0;
  const pct = (n / totalDays * 100).toFixed(1);
  console.log(`    ${r.padEnd(14)} ${String(n).padStart(4)} days (${pct}%)`);
}

console.log(`\n  Total regime transitions: ${transitionCount}`);
const avgTransPerMonth = transitionCount / (totalDays / 30);
console.log(`  Avg transitions/month: ${avgTransPerMonth.toFixed(1)}`);

// Avg stint duration per regime
const stintsByRegime = new Map<Regime, number[]>();
for (const st of stints) {
  const arr = stintsByRegime.get(st.regime) ?? [];
  arr.push(st.days);
  stintsByRegime.set(st.regime, arr);
}
console.log(`\n  Average stint duration (days):`);
for (const r of ["RISK-ON", "RECOVERY", "CORRECTION", "RISK-OFF"] as Regime[]) {
  const arr = stintsByRegime.get(r) ?? [];
  if (arr.length === 0) { console.log(`    ${r.padEnd(14)} -`); continue; }
  const avg = arr.reduce((s, n) => s + n, 0) / arr.length;
  const mn = Math.min(...arr);
  const mx = Math.max(...arr);
  console.log(`    ${r.padEnd(14)} avg=${avg.toFixed(1)}, min=${mn}, max=${mx}, stints=${arr.length}`);
}

// Whipsaw detection: transitions back within 3 days
let whipsaws = 0;
for (let i = 1; i < regimeTransitions.length; i++) {
  const timeDiff = (regimeTransitions[i].ts - regimeTransitions[i - 1].ts) / DAY;
  if (timeDiff <= 3) whipsaws++;
}
console.log(`\n  Whipsaws (transition back within 3 days): ${whipsaws} / ${transitionCount} (${(whipsaws / transitionCount * 100).toFixed(1)}%)`);

fgValues.sort((a, b) => a - b);
console.log(`\n  Fear proxy distribution:`);
console.log(`    min=${fgValues[0]?.toFixed(1)}, p10=${fgValues[Math.floor(fgValues.length * 0.1)]?.toFixed(1)}, p25=${fgValues[Math.floor(fgValues.length * 0.25)]?.toFixed(1)}, median=${fgValues[Math.floor(fgValues.length * 0.5)]?.toFixed(1)}, p75=${fgValues[Math.floor(fgValues.length * 0.75)]?.toFixed(1)}, p90=${fgValues[Math.floor(fgValues.length * 0.9)]?.toFixed(1)}, max=${fgValues[fgValues.length - 1]?.toFixed(1)}`);

// ═════════════════════════════════════════════════════════════════════
// 2. A-G CONFIG COMPARISON
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 2: ISOLATE THE DAMAGE (Configs A-G)");
console.log("=".repeat(80));

const configs: ConfigFlags[] = [
  { label: "A. Pure 3-engine (baseline)",  directionBias: false, sizeMultiplier: false, garchRiskOff: false, altRotRiskOn: false },
  { label: "B. + Direction bias only",     directionBias: true,  sizeMultiplier: false, garchRiskOff: false, altRotRiskOn: false },
  { label: "C. + Size multiplier only",    directionBias: false, sizeMultiplier: true,  garchRiskOff: false, altRotRiskOn: false },
  { label: "D. + Direction + Size",        directionBias: true,  sizeMultiplier: true,  garchRiskOff: false, altRotRiskOn: false },
  { label: "E. + Dir+Size+GARCH(RISK-OFF)",directionBias: true,  sizeMultiplier: true,  garchRiskOff: true,  altRotRiskOn: false },
  { label: "F. + Dir+Size+AltRot(RISK-ON)",directionBias: true,  sizeMultiplier: true,  garchRiskOff: false, altRotRiskOn: true },
  { label: "G. Full system (all)",         directionBias: true,  sizeMultiplier: true,  garchRiskOff: true,  altRotRiskOn: true },
];

interface ConfigResult {
  label: string;
  stats: Stats;
  trades: Trade[];
}

const results: ConfigResult[] = [];

console.log(`\n  Running ${configs.length} configs...\n`);

for (const cfg of configs) {
  const trades = runSim(cfg, pairDataMap, btcData, regimes, h1DataMap, h1ZScoreMap, h1MapMap, sortedTs);
  const stats = calcStats(trades);
  results.push({ label: cfg.label, stats, trades });
  console.log(`  ${cfg.label}`);
  console.log(`    Trades: ${stats.n} | PF: ${stats.pf.toFixed(2)} | Sharpe: ${stats.sharpe.toFixed(2)} | $/day: $${stats.perDay.toFixed(2)} | MaxDD: $${stats.maxDD.toFixed(0)} | WR: ${stats.wr.toFixed(1)}%`);
}

// Delta analysis: what does each addition cost?
console.log("\n  DELTA IMPACT (change from baseline A):");
console.log("  " + "-".repeat(76));
console.log("  Config                           dTrades   d$/day   dPF      dSharpe  dMaxDD");
console.log("  " + "-".repeat(76));
const baseStats = results[0].stats;
for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const dTrades = r.stats.n - baseStats.n;
  const dPerDay = r.stats.perDay - baseStats.perDay;
  const dPF = r.stats.pf - baseStats.pf;
  const dSharpe = r.stats.sharpe - baseStats.sharpe;
  const dMaxDD = r.stats.maxDD - baseStats.maxDD;
  console.log(`  ${r.label.padEnd(35)} ${(dTrades >= 0 ? "+" : "") + dTrades}${("   ").padStart(7 - String(dTrades).length)}${(dPerDay >= 0 ? "+$" : "-$") + Math.abs(dPerDay).toFixed(2)}${(" ").padStart(8 - Math.abs(dPerDay).toFixed(2).length)}${(dPF >= 0 ? "+" : "") + dPF.toFixed(2)}${(" ").padStart(7 - dPF.toFixed(2).length)}${(dSharpe >= 0 ? "+" : "") + dSharpe.toFixed(2)}${(" ").padStart(7 - dSharpe.toFixed(2).length)}${(dMaxDD >= 0 ? "+$" : "-$") + Math.abs(dMaxDD).toFixed(0)}`);
}

// Incremental deltas (each step vs previous step)
console.log("\n  INCREMENTAL IMPACT (each step vs prior step):");
console.log("  " + "-".repeat(76));
console.log("  Step                                  d$/day  Comment");
console.log("  " + "-".repeat(76));
const labels = ["(base)", "DirBias", "SizeMult", "Dir+Size", "+GARCH", "+AltRot", "Full"];
for (let i = 1; i < results.length; i++) {
  const delta = results[i].stats.perDay - results[i - 1].stats.perDay;
  let comment = "";
  if (delta < -0.5) comment = "<--- MAJOR DAMAGE";
  else if (delta < -0.2) comment = "<--- damage";
  else if (delta > 0.2) comment = "helps";
  else comment = "negligible";
  console.log(`  ${results[i - 1].label.split(".")[0]}-> ${labels[i]}`.padEnd(40) + `${(delta >= 0 ? "+$" : "-$") + Math.abs(delta).toFixed(2).padStart(5)}  ${comment}`);
}

// ═════════════════════════════════════════════════════════════════════
// 3. DIRECTION BIAS DAMAGE ANALYSIS
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 3: DIRECTION BIAS DAMAGE");
console.log("=".repeat(80));

// Run baseline (A) to get all trades including longs
const baselineTrades = results[0].trades;
const dirBiasTrades = results[1].trades;

// Find trades in baseline that are missing from dir-bias (these were blocked)
const dirBiasKeys = new Set(dirBiasTrades.map(t => `${t.engine}:${t.pair}:${t.et}`));
const blockedTrades = baselineTrades.filter(t => !dirBiasKeys.has(`${t.engine}:${t.pair}:${t.et}`));

// What regimes were they in?
const blockedByRegime = new Map<Regime, Trade[]>();
for (const t of blockedTrades) {
  const r = getRegime(regimes, t.et);
  const arr = blockedByRegime.get(r) ?? [];
  arr.push(t);
  blockedByRegime.set(r, arr);
}

console.log(`\n  Trades in baseline (A): ${baselineTrades.length}`);
console.log(`  Trades with dir bias (B): ${dirBiasTrades.length}`);
console.log(`  Trades BLOCKED by dir bias: ${blockedTrades.length}`);

let blockedWins = 0, blockedLosses = 0, blockedWinPnl = 0, blockedLossPnl = 0;
for (const t of blockedTrades) {
  if (t.pnl > 0) { blockedWins++; blockedWinPnl += t.pnl; }
  else { blockedLosses++; blockedLossPnl += t.pnl; }
}

console.log(`\n  Blocked trades breakdown:`);
console.log(`    Winners: ${blockedWins} (total $${blockedWinPnl.toFixed(2)} profit LOST)`);
console.log(`    Losers:  ${blockedLosses} (total $${Math.abs(blockedLossPnl).toFixed(2)} loss SAVED)`);
console.log(`    Net impact: $${(blockedWinPnl + blockedLossPnl).toFixed(2)} (positive = we lost more profit than we saved)`);
console.log(`    Per day: $${((blockedWinPnl + blockedLossPnl) / ((FULL_END - FULL_START) / DAY)).toFixed(3)}`);

console.log(`\n  Blocked by regime:`);
for (const [r, trades] of blockedByRegime) {
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const longs = trades.filter(t => t.dir === "long").length;
  const shorts = trades.filter(t => t.dir === "short").length;
  console.log(`    ${r.padEnd(14)} ${trades.length} blocked (${longs}L/${shorts}S), net PnL=$${pnl.toFixed(2)}`);
}

// Blocked by direction
const blockedLongs = blockedTrades.filter(t => t.dir === "long");
const blockedShorts = blockedTrades.filter(t => t.dir === "short");
console.log(`\n  Blocked LONGS: ${blockedLongs.length} (PnL=$${blockedLongs.reduce((s, t) => s + t.pnl, 0).toFixed(2)})`);
console.log(`  Blocked SHORTS: ${blockedShorts.length} (PnL=$${blockedShorts.reduce((s, t) => s + t.pnl, 0).toFixed(2)})`);

// NEW trades unique to dir-bias config (shouldn't exist unless position cap effects differ)
const baseKeys = new Set(baselineTrades.map(t => `${t.engine}:${t.pair}:${t.et}`));
const newDirBiasOnly = dirBiasTrades.filter(t => !baseKeys.has(`${t.engine}:${t.pair}:${t.et}`));
if (newDirBiasOnly.length > 0) {
  console.log(`\n  Trades UNIQUE to dir bias config (not in baseline): ${newDirBiasOnly.length}`);
  const newPnl = newDirBiasOnly.reduce((s, t) => s + t.pnl, 0);
  console.log(`    Net PnL of new trades: $${newPnl.toFixed(2)}`);
} else {
  console.log(`\n  No new trades unique to dir bias config (all are subsets of baseline)`);
}

// ═════════════════════════════════════════════════════════════════════
// 4. SIZE MULTIPLIER DAMAGE ANALYSIS
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 4: SIZE MULTIPLIER DAMAGE");
console.log("=".repeat(80));

const sizeMultTrades = results[2].trades;

// Compare trade-by-trade: same trades but different margins
let sizeWinProfitLost = 0;
let sizeLossSaved = 0;
let sizeAffectedTrades = 0;

// Build lookup from baseline
const baseTradeMap = new Map<string, Trade>();
for (const t of baselineTrades) {
  baseTradeMap.set(`${t.engine}:${t.pair}:${t.et}`, t);
}

for (const t of sizeMultTrades) {
  const key = `${t.engine}:${t.pair}:${t.et}`;
  const baseTrade = baseTradeMap.get(key);
  if (!baseTrade) continue;
  const delta = t.pnl - baseTrade.pnl;
  if (Math.abs(delta) < 0.001) continue; // same margin
  sizeAffectedTrades++;
  if (baseTrade.pnl > 0) {
    // This was a winner, but size was reduced
    sizeWinProfitLost += delta; // negative: profit lost
  } else {
    // This was a loser, size was reduced
    sizeLossSaved += delta; // positive: loss saved
  }
}

const regimeSizeImpact = new Map<Regime, { winLost: number; lossSaved: number; count: number }>();
for (const t of sizeMultTrades) {
  const key = `${t.engine}:${t.pair}:${t.et}`;
  const baseTrade = baseTradeMap.get(key);
  if (!baseTrade) continue;
  const delta = t.pnl - baseTrade.pnl;
  if (Math.abs(delta) < 0.001) continue;
  const r = getRegime(regimes, t.et);
  const data = regimeSizeImpact.get(r) ?? { winLost: 0, lossSaved: 0, count: 0 };
  data.count++;
  if (baseTrade.pnl > 0) data.winLost += delta;
  else data.lossSaved += delta;
  regimeSizeImpact.set(r, data);
}

console.log(`\n  Trades affected by size mult: ${sizeAffectedTrades} / ${sizeMultTrades.length}`);
console.log(`  Profit LOST on winners (reduced size):    $${sizeWinProfitLost.toFixed(2)}`);
console.log(`  Loss SAVED on losers (reduced size):      $${sizeLossSaved.toFixed(2)}`);
console.log(`  Net size impact: $${(sizeWinProfitLost + sizeLossSaved).toFixed(2)}`);
console.log(`  Per day: $${((sizeWinProfitLost + sizeLossSaved) / ((FULL_END - FULL_START) / DAY)).toFixed(3)}`);

console.log(`\n  Size impact by regime:`);
for (const [r, data] of regimeSizeImpact) {
  const net = data.winLost + data.lossSaved;
  console.log(`    ${r.padEnd(14)} ${data.count} trades, winLost=$${data.winLost.toFixed(2)}, lossSaved=$${data.lossSaved.toFixed(2)}, net=$${net.toFixed(2)}`);
}

// ═════════════════════════════════════════════════════════════════════
// 5. ALT ROTATION DAMAGE
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 5: ALT ROTATION (Engine F) ANALYSIS");
console.log("=".repeat(80));

// Config F has alt rotation. Compare with D (dir+size, no alt rot)
const withAltRot = results[5]; // F
const withoutAltRot = results[3]; // D

const altRotTrades = withAltRot.trades.filter(t => t.engine === "F-AltRotation");
const altRotPnl = altRotTrades.reduce((s, t) => s + t.pnl, 0);
const altRotWins = altRotTrades.filter(t => t.pnl > 0).length;

// How many days is RISK-ON?
const riskOnDays = regDist.get("RISK-ON") ?? 0;
const altRotFreq = altRotTrades.length / (riskOnDays || 1);

console.log(`\n  RISK-ON days: ${riskOnDays} (${(riskOnDays / totalDays * 100).toFixed(1)}% of total)`);
console.log(`  Alt Rotation trades: ${altRotTrades.length}`);
console.log(`  Avg signals per RISK-ON day: ${altRotFreq.toFixed(2)}`);
console.log(`  Alt Rotation PnL: $${altRotPnl.toFixed(2)}`);
console.log(`  Alt Rotation WR: ${altRotTrades.length > 0 ? (altRotWins / altRotTrades.length * 100).toFixed(1) : 0}%`);
console.log(`  Alt Rotation $/day (RISK-ON days): $${riskOnDays > 0 ? (altRotPnl / riskOnDays).toFixed(2) : "N/A"}`);

// Did alt rotation crowd out core engines? Compare core trades in F vs D
const coreFTrades = withAltRot.trades.filter(t => t.engine !== "F-AltRotation");
const coreDTrades = withoutAltRot.trades;
const coreFPnl = coreFTrades.reduce((s, t) => s + t.pnl, 0);
const coreDPnl = coreDTrades.reduce((s, t) => s + t.pnl, 0);

console.log(`\n  Crowding analysis:`);
console.log(`    Core trades WITHOUT alt rot: ${coreDTrades.length} (PnL=$${coreDPnl.toFixed(2)})`);
console.log(`    Core trades WITH alt rot:    ${coreFTrades.length} (PnL=$${coreFPnl.toFixed(2)})`);
console.log(`    Core trades lost to crowding: ${coreDTrades.length - coreFTrades.length}`);
console.log(`    Core PnL impact: $${(coreFPnl - coreDPnl).toFixed(2)}`);

// ═════════════════════════════════════════════════════════════════════
// 6. GARCH ENGINE ANALYSIS
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 6: GARCH ENGINE (Engine E) ANALYSIS");
console.log("=".repeat(80));

const withGarch = results[4]; // E
const withoutGarch = results[3]; // D

const garchTrades = withGarch.trades.filter(t => t.engine === "E-GARCH");
const garchPnl = garchTrades.reduce((s, t) => s + t.pnl, 0);
const garchWins = garchTrades.filter(t => t.pnl > 0).length;
const riskOffDays = regDist.get("RISK-OFF") ?? 0;

console.log(`\n  RISK-OFF days: ${riskOffDays} (${(riskOffDays / totalDays * 100).toFixed(1)}% of total)`);
console.log(`  GARCH trades: ${garchTrades.length}`);
console.log(`  GARCH PnL: $${garchPnl.toFixed(2)}`);
console.log(`  GARCH WR: ${garchTrades.length > 0 ? (garchWins / garchTrades.length * 100).toFixed(1) : 0}%`);
console.log(`  GARCH $/day (RISK-OFF days): $${riskOffDays > 0 ? (garchPnl / riskOffDays).toFixed(2) : "N/A"}`);

// Crowding from GARCH
const coreETrades = withGarch.trades.filter(t => t.engine !== "E-GARCH");
const coreEPnl = coreETrades.reduce((s, t) => s + t.pnl, 0);
console.log(`\n  Core trades without GARCH: ${withoutGarch.trades.length} (PnL=$${withoutGarch.stats.total.toFixed(2)})`);
console.log(`  Core trades with GARCH:    ${coreETrades.length} (PnL=$${coreEPnl.toFixed(2)})`);
console.log(`  Core trades lost to crowding: ${withoutGarch.trades.length - coreETrades.length}`);

// ═════════════════════════════════════════════════════════════════════
// 7. PER-REGIME P&L for each config
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 7: PER-REGIME P&L FOR EACH CONFIG");
console.log("=".repeat(80));

console.log("\n  $/day by regime (trade entry regime):");
console.log("  Config".padEnd(38) + "RISK-ON".padStart(9) + "RECOVERY".padStart(10) + "CORRECTION".padStart(12) + "RISK-OFF".padStart(10));
console.log("  " + "-".repeat(76));

for (const res of results) {
  const regPnl = new Map<Regime, number>();
  for (const t of res.trades) {
    const r = getRegime(regimes, t.et);
    regPnl.set(r, (regPnl.get(r) ?? 0) + t.pnl);
  }
  const parts: string[] = [];
  for (const r of ["RISK-ON", "RECOVERY", "CORRECTION", "RISK-OFF"] as Regime[]) {
    const pnl = regPnl.get(r) ?? 0;
    const days = regDist.get(r) ?? 1;
    const perDay = pnl / days;
    parts.push(("$" + perDay.toFixed(2)).padStart(r === "CORRECTION" ? 12 : r === "RECOVERY" ? 10 : r === "RISK-OFF" ? 10 : 9));
  }
  console.log(`  ${res.label.padEnd(36)} ${parts.join("")}`);
}

// ═════════════════════════════════════════════════════════════════════
// 8. PER-ENGINE breakdown for baseline vs full
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 8: ENGINE COMPARISON (Baseline A vs Full G)");
console.log("=".repeat(80));

for (const [label, idx] of [["Baseline A (no regime)", 0], ["Full system G (all regime)", 6]] as [string, number][]) {
  const trades = results[idx].trades;
  console.log(`\n  ${label}:`);
  console.log("    Engine".padEnd(20) + "Trades".padStart(8) + "WR%".padStart(7) + "PnL".padStart(10) + "$/day".padStart(8) + "Avg".padStart(8) + "PF".padStart(7));
  console.log("    " + "-".repeat(62));

  const byEngine = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = byEngine.get(t.engine) ?? [];
    arr.push(t);
    byEngine.set(t.engine, arr);
  }
  const days = (FULL_END - FULL_START) / DAY;
  for (const [eng, engTrades] of [...byEngine.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pnl = engTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = engTrades.filter(t => t.pnl > 0).length;
    const wr = (wins / engTrades.length * 100).toFixed(1);
    const avg = (pnl / engTrades.length).toFixed(2);
    const gp = engTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(engTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? (gp / gl).toFixed(2) : "Inf";
    console.log(`    ${eng.padEnd(18)} ${String(engTrades.length).padStart(8)} ${wr.padStart(6)}% ${("$" + pnl.toFixed(2)).padStart(10)} ${("$" + (pnl / days).toFixed(2)).padStart(8)} ${("$" + avg).padStart(8)} ${String(pf).padStart(6)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 9. YEARLY BREAKDOWN for A vs G
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 9: YEARLY COMPARISON (A vs G)");
console.log("=".repeat(80));

console.log("\n  Year    Config A $/day    Config G $/day    Delta");
console.log("  " + "-".repeat(55));

for (const year of [2023, 2024, 2025, 2026]) {
  const ys = new Date(`${year}-01-01`).getTime();
  const ye = new Date(`${year + 1}-01-01`).getTime();
  const yEnd = Math.min(ye, FULL_END);
  const yDays = (yEnd - ys) / DAY;

  const aTrades = results[0].trades.filter(t => t.xt >= ys && t.xt < yEnd);
  const gTrades = results[6].trades.filter(t => t.xt >= ys && t.xt < yEnd);
  const aDay = aTrades.reduce((s, t) => s + t.pnl, 0) / yDays;
  const gDay = gTrades.reduce((s, t) => s + t.pnl, 0) / yDays;
  const delta = gDay - aDay;
  console.log(`  ${year}    $${aDay.toFixed(2).padStart(6)}          $${gDay.toFixed(2).padStart(6)}          ${(delta >= 0 ? "+$" : "-$") + Math.abs(delta).toFixed(2)}`);
}

// ═════════════════════════════════════════════════════════════════════
// 10. SUMMARY + VERDICT
// ═════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  SECTION 10: SUMMARY TABLE");
console.log("=".repeat(80));

console.log("\n  Config                            Trades    PF   Sharpe   $/day     MaxDD    WR%");
console.log("  " + "-".repeat(82));
for (const res of results) {
  const s = res.stats;
  console.log(`  ${res.label.padEnd(35)} ${String(s.n).padStart(5)}  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(6)}  ${("$" + s.perDay.toFixed(2)).padStart(7)}  ${("$" + s.maxDD.toFixed(0)).padStart(7)}  ${s.wr.toFixed(1).padStart(5)}%`);
}

console.log("\n" + "=".repeat(80));
console.log("  VERDICT");
console.log("=".repeat(80));

// Find the worst offender
let worstDelta = 0;
let worstLabel = "";
for (let i = 1; i < results.length; i++) {
  const delta = results[i].stats.perDay - results[i - 1].stats.perDay;
  if (delta < worstDelta) {
    worstDelta = delta;
    worstLabel = results[i].label;
  }
}

console.log(`\n  Biggest single damage: "${worstLabel}" -> $${worstDelta.toFixed(2)}/day`);
console.log(`  Baseline (no regime): $${results[0].stats.perDay.toFixed(2)}/day`);
console.log(`  Full regime system:   $${results[6].stats.perDay.toFixed(2)}/day`);
console.log(`  Total cost of regime: $${(results[6].stats.perDay - results[0].stats.perDay).toFixed(2)}/day`);

console.log();
