/**
 * Full Regime-Adaptive System Backtest
 *
 * The definitive "what do we expect per day" test.
 * Runs all 5 engines with regime classification, direction bias,
 * size multiplier, and position cap.
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/ (2023-01 to 2026-03)
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const H4 = 4 * HOUR;
const FEE = 0.000_35;
const LEV = 10;
const MAX_POSITIONS = 10;

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
}

interface Position {
  pair: string; dir: Dir; engine: string;
  ep: number; et: number; sl: number;
  margin: number;
  // ATR trailing ladder state
  peakPnlAtr: number; // peak PnL in ATR units
  atrAtEntry: number;
  trailLevel: number; // current trail SL price (0 = not active)
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
  const st = new Array(bars.length).fill(0);
  const dirs = new Array(bars.length).fill(1);

  for (let i = atrPeriod; i < bars.length; i++) {
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (bars[i - 1].h + bars[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (bars[i - 1].h + bars[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = st[i - 1] > 0 && dirs[i - 1] === -1 ? st[i - 1] : prevUpper;
      const prevFinalLower = st[i - 1] > 0 && dirs[i - 1] === 1 ? st[i - 1] : prevLower;

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
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
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
  // Annualized realized volatility from daily returns
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
      r[i] = Math.sqrt(sumSq / n) * Math.sqrt(365) * 100; // annualized %
    }
  }
  return r;
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

function tradePnl(pair: string, ep: number, xp: number, dir: Dir, isSL: boolean, notional: number): number {
  const spread = sp(pair);
  const entrySlip = ep * spread;
  const exitSlip = xp * spread * (isSL ? 1.5 : 1);
  const fees = notional * FEE * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

function tradePnlConservative(pair: string, ep: number, xp: number, dir: Dir, isSL: boolean, notional: number): number {
  const spread = sp(pair) * 2; // 2x spreads
  const entrySlip = ep * spread;
  const exitSlip = xp * spread * (isSL ? 1.5 : 1);
  const fees = notional * FEE * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Precomputed Data ───────────────────────────────────────────────
interface PairData {
  h4: C[];
  daily: C[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  h4ATR: number[];
  h4ST: number[];  // supertrend direction array
  h4Vol20: number[]; // 20-bar volume SMA
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
  dailyVol30: number[]; // 30-day realized vol
  dailyMom20: number[]; // 20-day momentum (return)
  daily7dReturn: number[];
}

// ─── Regime Classification ──────────────────────────────────────────
interface DayRegime {
  ts: number;
  regime: Regime;
  fearProxy: number;
  btc7dReturn: number;
}

function classifyDayRegimes(btc: BTCData): Map<number, DayRegime> {
  const regimes = new Map<number, DayRegime>();

  for (let i = 30; i < btc.daily.length; i++) {
    const dayTs = Math.floor(btc.daily[i].t / DAY) * DAY;

    // Fear & Greed proxy from BTC 30d volatility + 20d momentum
    // BTC 30d realized vol (annualized %)
    const vol30 = btc.dailyVol30[i]; // typically 30-120%
    // BTC 20d momentum (% return)
    const mom20 = i >= 20 ? (btc.dailyCloses[i] / btc.dailyCloses[i - 20] - 1) * 100 : 0;

    // Fear proxy (0-100 scale, like Fear & Greed Index):
    // High vol + negative momentum = low score (fearful)
    // Low vol + positive momentum = high score (greedy)
    // Base 50, momentum adds/subtracts, vol penalizes when high
    // mom20 typically -30 to +30, vol30 typically 30-120
    const fgScore = 50
      + mom20 * 1.0                   // strong momentum effect
      - Math.max(0, vol30 - 40) * 0.5; // vol penalty above 40%
    const clampedFG = Math.max(0, Math.min(100, fgScore));

    // Fear proxy < 25 = "fearful" (bear conditions)
    // Fear proxy >= 25 = "not fearful"
    const isFearful = clampedFG < 25;

    // BTC 7-day return
    const btc7d = i >= 7 ? (btc.dailyCloses[i] / btc.dailyCloses[i - 7] - 1) * 100 : 0;
    const isDeclining = btc7d < -3;

    let regime: Regime;
    if (isFearful && isDeclining) regime = "RISK-OFF";
    else if (isFearful && !isDeclining) regime = "RECOVERY";
    else if (!isFearful && !isDeclining) regime = "RISK-ON";
    else regime = "CORRECTION"; // not fearful + declining

    regimes.set(dayTs, {
      ts: dayTs,
      regime,
      fearProxy: clampedFG,
      btc7dReturn: btc7d,
    });
  }

  return regimes;
}

function getRegime(regimes: Map<number, DayRegime>, t: number): Regime {
  const dayTs = Math.floor(t / DAY) * DAY;
  return regimes.get(dayTs)?.regime ?? "RISK-ON";
}

function getRegimeData(regimes: Map<number, DayRegime>, t: number): DayRegime | undefined {
  const dayTs = Math.floor(t / DAY) * DAY;
  return regimes.get(dayTs);
}

// ─── Size Multiplier per Regime ─────────────────────────────────────
function sizeMultiplier(regime: Regime): number {
  switch (regime) {
    case "RISK-OFF": return 1.0;
    case "RECOVERY": return 0.75;
    case "RISK-ON": return 1.0;
    case "CORRECTION": return 0.5;
  }
}

// ─── Direction Filter per Regime ────────────────────────────────────
function directionAllowed(regime: Regime, dir: Dir): boolean {
  if (regime === "RISK-OFF") return dir === "short";
  return true; // RECOVERY, RISK-ON, CORRECTION: both
}

// ─── ATR Trailing Ladder ────────────────────────────────────────────
function updateATRTrail(pos: Position, currentPrice: number): void {
  if (pos.atrAtEntry <= 0) return;
  const atr = pos.atrAtEntry;

  // PnL in ATR units
  const pnlAtr = pos.dir === "long"
    ? (currentPrice - pos.ep) / atr
    : (pos.ep - currentPrice) / atr;

  if (pnlAtr > pos.peakPnlAtr) pos.peakPnlAtr = pnlAtr;

  // Ladder: breakeven at 1xATR, 2xATR trail at 2x, 3xATR trail at 1.5x
  let newTrail = 0;
  if (pos.peakPnlAtr >= 3) {
    // Trail at 1.5xATR from peak
    newTrail = pos.dir === "long"
      ? pos.ep + (pos.peakPnlAtr - 1.5) * atr
      : pos.ep - (pos.peakPnlAtr - 1.5) * atr;
  } else if (pos.peakPnlAtr >= 2) {
    // Trail at 2xATR from peak
    newTrail = pos.dir === "long"
      ? pos.ep + (pos.peakPnlAtr - 2) * atr
      : pos.ep - (pos.peakPnlAtr - 2) * atr;
  } else if (pos.peakPnlAtr >= 1) {
    // Breakeven
    newTrail = pos.ep;
  }

  // Trail only moves in favorable direction
  if (newTrail > 0) {
    if (pos.dir === "long") {
      if (newTrail > pos.trailLevel) pos.trailLevel = newTrail;
      // Trail must be at least as good as initial SL
      if (pos.trailLevel > pos.sl) pos.sl = pos.trailLevel;
    } else {
      if (pos.trailLevel === 0 || newTrail < pos.trailLevel) pos.trailLevel = newTrail;
      if (pos.trailLevel > 0 && pos.trailLevel < pos.sl) pos.sl = pos.trailLevel;
    }
  }
}

// ─── Engine Signal Interfaces ───────────────────────────────────────
interface Signal {
  pair: string;
  dir: Dir;
  engine: string;
  margin: number;
  sl: number;
  atrAtEntry: number;
}

// ─── Engine A: Daily Donchian ───────────────────────────────────────
// SMA 20/50 trend filter, 15-day exit channel, ATR×3 SL, $7 margin
function engineA_signals(
  pairDataMap: Map<string, PairData>,
  btcData: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  const mult = sizeMultiplier(regime);
  const margin = baseMargin * mult;

  // BTC EMA filter for longs
  const btcDayTs = Math.floor(barTime / DAY) * DAY;
  let btcDi = btcData.dailyMap.get(btcDayTs);
  if (btcDi === undefined) {
    // Find closest prior BTC daily bar
    let best = -1;
    for (let k = 0; k < btcData.daily.length; k++) {
      if (btcData.daily[k].t <= btcDayTs) best = k; else break;
    }
    if (best >= 0) btcDi = best;
  }
  // Use previous day's EMA values (no look-ahead)
  const btcEmaIdx = btcDi !== undefined && btcDi > 0 ? btcDi - 1 : undefined;
  const btcE20 = btcEmaIdx !== undefined ? btcData.dailyEma20[btcEmaIdx] : 0;
  const btcE50 = btcEmaIdx !== undefined ? btcData.dailyEma50[btcEmaIdx] : 0;
  const btcLongsOK = btcE20 > btcE50 && btcE20 > 0 && btcE50 > 0;

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;

    // Get daily bar for this timestamp
    const dayTs = Math.floor(barTime / DAY) * DAY;

    // Only fire once per day: first 4h bar of the day (00:00 UTC)
    if (barTime !== dayTs) continue;

    // Find the most recent daily bar at or before this day
    let di = pd.dailyMap.get(dayTs);
    if (di === undefined) {
      // Try finding closest prior daily bar
      let bestDi = -1;
      for (let k = 0; k < pd.daily.length; k++) {
        if (pd.daily[k].t <= dayTs) bestDi = k;
        else break;
      }
      if (bestDi >= 0) di = bestDi;
    }
    if (di === undefined || di < 50) continue;

    const sma20 = pd.dailySMA20[di - 1];
    const sma50 = pd.dailySMA50[di - 1];
    if (!sma20 || !sma50) continue;

    const prevClose = pd.daily[di - 1].c;
    // Channel high/low: lookback ending before yesterday's bar
    const donHi15 = pd.dailyDonHi15[di - 1]; // max of highs di-16..di-2
    const donLo15 = pd.dailyDonLo15[di - 1]; // min of lows di-16..di-2
    if (!donHi15 || !donLo15) continue;

    const atr = pd.dailyATR[di - 1];
    if (!atr || atr <= 0) continue;

    const ep = pd.daily[di].o;
    let dir: Dir | null = null;

    // Long: prev close > SMA20 > SMA50, prev close broke above 15d channel high
    if (prevClose > sma20 && sma20 > sma50 && prevClose > donHi15) {
      dir = "long";
    }
    // Short: prev close < SMA20 < SMA50, prev close broke below 15d channel low
    else if (prevClose < sma20 && sma20 < sma50 && prevClose < donLo15) {
      dir = "short";
    }

    if (!dir) continue;
    if (!directionAllowed(regime, dir)) continue;
    if (dir === "long" && !btcLongsOK) continue;

    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;

    signals.push({ pair, dir, engine: "A-Donchian", margin, sl, atrAtEntry: atr });
  }

  return signals;
}

// ─── Engine B: 4h Supertrend + Volume Filter ────────────────────────
// Supertrend(14, 1.75), volume > 1.5x 20-bar avg, $5 margin
function engineB_signals(
  pairDataMap: Map<string, PairData>,
  btcData: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  const mult = sizeMultiplier(regime);
  const margin = baseMargin * mult;

  // BTC EMA filter for longs (use prior day to avoid look-ahead)
  const btcDayTs = Math.floor(barTime / DAY) * DAY;
  let btcDiB = btcData.dailyMap.get(btcDayTs);
  if (btcDiB === undefined) {
    let best = -1;
    for (let k = 0; k < btcData.daily.length; k++) {
      if (btcData.daily[k].t <= btcDayTs) best = k; else break;
    }
    if (best >= 0) btcDiB = best;
  }
  const btcEmaIdxB = btcDiB !== undefined && btcDiB > 0 ? btcDiB - 1 : undefined;
  const btcE20B = btcEmaIdxB !== undefined ? btcData.dailyEma20[btcEmaIdxB] : 0;
  const btcE50B = btcEmaIdxB !== undefined ? btcData.dailyEma50[btcEmaIdxB] : 0;
  const btcLongsOK = btcE20B > btcE50B && btcE20B > 0 && btcE50B > 0;

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;

    // Need a 4h bar at this time
    const h4i = pd.h4Map.get(barTime);
    if (h4i === undefined || h4i < 20) continue;

    // Check for supertrend flip
    const stNow = pd.h4ST[h4i - 1];
    const stPrev = h4i >= 2 ? pd.h4ST[h4i - 2] : stNow;
    if (stNow === stPrev) continue; // no flip

    const dir: Dir = stNow === 1 ? "long" : "short";

    // Volume filter: prev bar vol > 1.5x 20-bar avg
    const curVol = pd.h4[h4i - 1]?.v ?? 0;
    const avgVol = pd.h4Vol20[h4i - 1] || 0;
    if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;

    if (!directionAllowed(regime, dir)) continue;
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

// ─── Engine D: Carry Momentum ───────────────────────────────────────
// Simulated funding from price: 5-day lookback, $7 margin
// Uses price changes as proxy for funding direction
function engineD_signals(
  pairDataMap: Map<string, PairData>,
  btcData: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  const mult = sizeMultiplier(regime);
  const margin = baseMargin * mult;

  // Only fire once per day
  const dayTs = Math.floor(barTime / DAY) * DAY;
  if (barTime !== dayTs) return signals;

  // Helper to find daily bar index
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

  // Compute 5-day returns for all pairs to rank them
  const pairReturns: { pair: string; ret5d: number; atr: number; di: number }[] = [];

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;
    const di = findDi(pd);
    if (di === undefined || di < 10) continue;

    // 5-day price change as funding proxy
    const ret5d = pd.daily[di - 1].c / pd.daily[Math.max(0, di - 6)].c - 1;
    const atr = pd.dailyATR[di - 1];
    if (!atr || atr <= 0) continue;

    pairReturns.push({ pair, ret5d, atr, di });
  }

  if (pairReturns.length < 5) return signals;

  // Sort by absolute 5d return (strongest momentum)
  pairReturns.sort((a, b) => Math.abs(b.ret5d) - Math.abs(a.ret5d));

  // Take top 3 signals: trade in the direction of momentum
  const top = pairReturns.slice(0, 3);
  for (const { pair, ret5d, atr, di } of top) {
    // Threshold: need at least 3% move in 5 days
    if (Math.abs(ret5d) < 0.03) continue;

    const dir: Dir = ret5d > 0 ? "long" : "short";
    if (!directionAllowed(regime, dir)) continue;

    const pd = pairDataMap.get(pair)!;
    const ep = pd.daily[di].o;
    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;

    signals.push({ pair, dir, engine: "D-Carry", margin, sl, atrAtEntry: atr });
  }

  return signals;
}

// ─── Engine E: GARCH v2 MTF (RISK-OFF only) ────────────────────────
// 1h + 4h z-score mean reversion, $5 margin
function engineE_signals(
  pairDataMap: Map<string, PairData>,
  btcData: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  h1Data: Map<string, C[]>,
  h1ZScores: Map<string, number[]>,
  h1Maps: Map<string, Map<number, number>>,
  baseMargin: number,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  if (regime !== "RISK-OFF") return signals;

  const mult = sizeMultiplier(regime);
  const margin = baseMargin * mult;

  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;

    // 4h bar
    const h4i = pd.h4Map.get(barTime);
    if (h4i === undefined || h4i < 25) continue;

    // 1h z-score
    const h1Bars = h1Data.get(pair);
    const h1ZS = h1ZScores.get(pair);
    const h1Map = h1Maps.get(pair);
    if (!h1Bars || !h1ZS || !h1Map) continue;

    // Find closest 1h bar
    const h1i = h1Map.get(barTime);
    if (h1i === undefined || h1i < 25) continue;

    const z1h = h1ZS[h1i - 1] || 0;

    // 4h z-score: compute inline
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

    // Combined z-score: average of 1h and 4h
    const zAvg = (z1h + z4h) / 2;

    let dir: Dir | null = null;
    // Mean reversion: high z = overbought -> short, low z = oversold -> long
    if (zAvg > 2.0) dir = "short";
    else if (zAvg < -2.0) dir = "long";
    if (!dir) continue;

    // In RISK-OFF, only shorts allowed
    if (!directionAllowed(regime, dir)) continue;

    const ep = pd.h4[h4i].o;
    const atr = pd.h4ATR[h4i - 1];
    if (!atr || atr <= 0) continue;

    const slDist = Math.min(atr * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;

    signals.push({ pair, dir, engine: "E-GARCH", margin, sl, atrAtEntry: atr });
  }

  return signals;
}

// ─── Engine F: Alt Rotation (RISK-ON only) ──────────────────────────
// Top 5 by 3-day return, long-only, $5 margin
function engineF_signals(
  pairDataMap: Map<string, PairData>,
  btcData: BTCData,
  regimes: Map<number, DayRegime>,
  barTime: number,
  baseMargin: number,
): Signal[] {
  const signals: Signal[] = [];
  const regime = getRegime(regimes, barTime);
  if (regime !== "RISK-ON") return signals;

  const mult = sizeMultiplier(regime);
  const margin = baseMargin * mult;

  // Only fire once per day
  const dayTs = Math.floor(barTime / DAY) * DAY;
  if (barTime !== dayTs) return signals;

  // Helper to find daily bar index
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

  // Compute 3-day returns for all pairs
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

  // Sort by 3d return descending (best performers)
  pairReturns.sort((a, b) => b.ret3d - a.ret3d);

  // Take top 5, long-only, need positive return
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

// ─── Z-Score for 1h bars ────────────────────────────────────────────
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

// ─── Main Simulation ────────────────────────────────────────────────
console.log("=== FULL REGIME-ADAPTIVE SYSTEM BACKTEST ===");
console.log(`Pairs: ${PAIRS.join(", ")}`);
console.log(`Period: 2023-01 to 2026-03`);
console.log(`Engines: A-Donchian($7), B-Supertrend($5), D-Carry($7), E-GARCH($5, RISK-OFF), F-AltRotation($5, RISK-ON)`);
console.log(`Max positions: ${MAX_POSITIONS} | Leverage: ${LEV}x | Fee: ${FEE * 100}%`);
console.log();

// Load data
console.log("Loading 5m candles...");
const pairDataMap = new Map<string, PairData>();
const h1DataMap = new Map<string, C[]>();
const h1ZScoreMap = new Map<string, number[]>();
const h1MapMap = new Map<string, Map<number, number>>();

for (const pair of [...PAIRS, "BTC"]) {
  const raw5m = load5m(pair);
  if (raw5m.length < 1000) { console.log(`  SKIP ${pair}: only ${raw5m.length} 5m bars`); continue; }

  const h4 = aggregate(raw5m, H4);
  const daily = aggregate(raw5m, DAY);
  const h1 = aggregate(raw5m, HOUR);

  const h4Map = new Map<number, number>();
  h4.forEach((b, i) => h4Map.set(b.t, i));
  const dailyMap = new Map<number, number>();
  daily.forEach((b, i) => dailyMap.set(b.t, i));
  const h1Map = new Map<number, number>();
  h1.forEach((b, i) => h1Map.set(b.t, i));

  // 4h indicators
  const h4ATR = calcATR(h4, 14);
  const { dir: h4STDirs } = calcSupertrend(h4, 14, 1.75);

  // 4h volume SMA 20
  const h4Vols = h4.map(b => b.v);
  const h4Vol20 = calcSMA(h4Vols, 20);

  // Daily indicators
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

    // 1h data for GARCH engine
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

console.log(`  BTC daily bars: ${btcDaily.length}`);
console.log(`  Loaded ${pairDataMap.size} pairs`);

// Classify regimes
const regimes = classifyDayRegimes(btcData);
console.log(`  Regime days classified: ${regimes.size}`);

// Debug: regime distribution
const regDist = new Map<Regime, number>();
const fgValues: number[] = [];
for (const [, rd] of regimes) {
  regDist.set(rd.regime, (regDist.get(rd.regime) ?? 0) + 1);
  fgValues.push(rd.fearProxy);
}
fgValues.sort((a, b) => a - b);
console.log(`  Regime distribution: ${[...regDist.entries()].map(([r, n]) => `${r}:${n}`).join(", ")}`);
console.log(`  FG proxy: min=${fgValues[0]?.toFixed(1)}, p10=${fgValues[Math.floor(fgValues.length * 0.1)]?.toFixed(1)}, median=${fgValues[Math.floor(fgValues.length * 0.5)]?.toFixed(1)}, p90=${fgValues[Math.floor(fgValues.length * 0.9)]?.toFixed(1)}, max=${fgValues[fgValues.length - 1]?.toFixed(1)}`);
console.log();

// ─── Run the simulation ─────────────────────────────────────────────
// Collect all 4h timestamps across all pairs + daily timestamps
const allTimestamps = new Set<number>();
for (const pd of pairDataMap.values()) {
  for (const b of pd.h4) {
    if (b.t >= FULL_START && b.t < FULL_END) allTimestamps.add(b.t);
  }
  // Ensure daily bar timestamps (00:00 UTC) are included for daily engines
  for (const b of pd.daily) {
    if (b.t >= FULL_START && b.t < FULL_END) allTimestamps.add(b.t);
  }
}
const sortedTs = [...allTimestamps].sort((a, b) => a - b);
console.log(`Simulating ${sortedTs.length} time steps...`);

const positions = new Map<string, Position>(); // key = "engine:pair"
const allTrades: Trade[] = [];
const conservativeTrades: Trade[] = [];

for (const t of sortedTs) {
  const regime = getRegime(regimes, t);

  // ─── 1. Manage existing positions ─────────────────────────────
  const toClose: string[] = [];

  for (const [key, pos] of positions) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd) continue;

    // Find current price from nearest timeframe
    const h4i = pd.h4Map.get(t);
    let bar: C | undefined;
    if (h4i !== undefined) bar = pd.h4[h4i];
    if (!bar) continue;

    // Update ATR trail
    updateATRTrail(pos, bar.c);

    let xp = 0;
    let reason = "";
    const isSL = false;
    let slHit = false;

    // SL check (including trail-updated SL)
    if (pos.dir === "long" && bar.l <= pos.sl) {
      xp = pos.sl;
      reason = "sl";
      slHit = true;
    } else if (pos.dir === "short" && bar.h >= pos.sl) {
      xp = pos.sl;
      reason = "sl";
      slHit = true;
    }

    // 48h stagnation exit
    if (!xp && (t - pos.et) > 48 * HOUR) {
      xp = bar.c;
      reason = "stagnation";
    }

    // Supertrend flip exit for Engine B
    if (!xp && pos.engine === "B-Supertrend") {
      const h4idx = pd.h4Map.get(t);
      if (h4idx !== undefined && h4idx >= 2) {
        const stNow = pd.h4ST[h4idx - 1];
        const stPrev = pd.h4ST[h4idx - 2];
        if (stNow !== stPrev) {
          // Flip happened
          if ((pos.dir === "long" && stNow === -1) || (pos.dir === "short" && stNow === 1)) {
            xp = bar.o;
            reason = "flip";
          }
        }
      }
    }

    // Donchian exit for Engine A: close below 15d low (long) or above 15d high (short)
    if (!xp && pos.engine === "A-Donchian") {
      const dayTs = Math.floor(t / DAY) * DAY;
      const di = pd.dailyMap.get(dayTs);
      if (di !== undefined && di > 0 && t === dayTs) {
        const donLo = pd.dailyDonLo15[di];
        const donHi = pd.dailyDonHi15[di];
        if (pos.dir === "long" && donLo > 0 && pd.daily[di - 1].c < donLo) {
          xp = bar.o;
          reason = "don-exit";
        } else if (pos.dir === "short" && donHi > 0 && pd.daily[di - 1].c > donHi) {
          xp = bar.o;
          reason = "don-exit";
        }
      }
    }

    if (xp > 0) {
      const notional = pos.margin * LEV;
      const pnl = tradePnl(pos.pair, pos.ep, xp, pos.dir, slHit, notional);
      const pnlCons = tradePnlConservative(pos.pair, pos.ep, xp, pos.dir, slHit, notional);

      allTrades.push({
        pair: pos.pair, dir: pos.dir, engine: pos.engine,
        ep: pos.ep, xp, et: pos.et, xt: t,
        pnl, reason, margin: pos.margin,
      });
      conservativeTrades.push({
        pair: pos.pair, dir: pos.dir, engine: pos.engine,
        ep: pos.ep, xp, et: pos.et, xt: t,
        pnl: pnlCons, reason, margin: pos.margin,
      });
      toClose.push(key);
    }
  }

  for (const key of toClose) positions.delete(key);

  // ─── 2. Generate new signals from all engines ─────────────────
  if (positions.size >= MAX_POSITIONS) continue;

  const allSignals: Signal[] = [];

  // Engine A: Daily Donchian ($7)
  allSignals.push(...engineA_signals(pairDataMap, btcData, regimes, t, 7));

  // Engine B: Supertrend ($5)
  allSignals.push(...engineB_signals(pairDataMap, btcData, regimes, t, 5));

  // Engine D: Carry Momentum ($7)
  allSignals.push(...engineD_signals(pairDataMap, btcData, regimes, t, 7));

  // Engine E: GARCH (RISK-OFF only, $5)
  allSignals.push(...engineE_signals(pairDataMap, btcData, regimes, t, h1DataMap, h1ZScoreMap, h1MapMap, 5));

  // Engine F: Alt Rotation (RISK-ON only, $5)
  allSignals.push(...engineF_signals(pairDataMap, btcData, regimes, t, 5));

  // Filter out signals for pairs with existing positions from same engine
  const filtered = allSignals.filter(s => {
    const key = `${s.engine}:${s.pair}`;
    return !positions.has(key);
  });

  // Open positions up to MAX_POSITIONS
  for (const sig of filtered) {
    if (positions.size >= MAX_POSITIONS) break;

    const key = `${sig.engine}:${sig.pair}`;
    const pd = pairDataMap.get(sig.pair);
    if (!pd) continue;

    // Get entry price from 4h bar
    const h4i = pd.h4Map.get(t);
    let ep: number;
    if (h4i !== undefined) {
      ep = pd.h4[h4i].o;
    } else {
      // For daily-only signals, use daily open
      const dayTs = Math.floor(t / DAY) * DAY;
      const di = pd.dailyMap.get(dayTs);
      if (di === undefined) continue;
      ep = pd.daily[di].o;
    }

    // Apply spread to entry
    const spread = sp(sig.pair);
    const entryPrice = sig.dir === "long" ? ep * (1 + spread) : ep * (1 - spread);

    // Adjust SL relative to actual entry price
    const slDist = Math.abs(ep - sig.sl);
    const sl = sig.dir === "long" ? entryPrice - slDist : entryPrice + slDist;

    positions.set(key, {
      pair: sig.pair,
      dir: sig.dir,
      engine: sig.engine,
      ep: entryPrice,
      et: t,
      sl,
      margin: sig.margin,
      peakPnlAtr: 0,
      atrAtEntry: sig.atrAtEntry,
      trailLevel: 0,
    });
  }
}

// Close remaining positions at end
for (const [key, pos] of positions) {
  const pd = pairDataMap.get(pos.pair);
  if (!pd || pd.h4.length === 0) continue;
  const lastBar = pd.h4[pd.h4.length - 1];
  const notional = pos.margin * LEV;
  const pnl = tradePnl(pos.pair, pos.ep, lastBar.c, pos.dir, false, notional);
  const pnlCons = tradePnlConservative(pos.pair, pos.ep, lastBar.c, pos.dir, false, notional);
  allTrades.push({
    pair: pos.pair, dir: pos.dir, engine: pos.engine,
    ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
    pnl, reason: "end", margin: pos.margin,
  });
  conservativeTrades.push({
    pair: pos.pair, dir: pos.dir, engine: pos.engine,
    ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
    pnl: pnlCons, reason: "end", margin: pos.margin,
  });
}

// Sort all trades by exit time
allTrades.sort((a, b) => a.xt - b.xt);
conservativeTrades.sort((a, b) => a.xt - b.xt);

console.log(`\nSimulation complete: ${allTrades.length} trades\n`);

// ─── Report Functions ───────────────────────────────────────────────
function calcStats(trades: Trade[], startTs: number, endTs: number) {
  const days = (endTs - startTs) / DAY;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const wr = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;

  // Max drawdown and duration
  let cum = 0, peak = 0, maxDD = 0;
  let ddStartTime = startTs, maxDDStartTime = startTs, maxDDEndTime = startTs;
  let inDD = false;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) {
      peak = cum;
      inDD = false;
    }
    if (peak - cum > maxDD) {
      maxDD = peak - cum;
      maxDDEndTime = t.xt;
      if (!inDD) { ddStartTime = t.xt; inDD = true; }
      maxDDStartTime = ddStartTime;
    }
  }
  const ddDurationDays = (maxDDEndTime - maxDDStartTime) / DAY;

  // Recovery: time from maxDD trough to new peak
  let recoveryDays = 0;
  let afterTrough = false;
  let troughCum = cum;
  let recoveredAt = 0;
  cum = 0; peak = 0; let troughTime = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum >= maxDD * 0.99 && !afterTrough) {
      afterTrough = true;
      troughCum = cum;
      troughTime = t.xt;
    }
    if (afterTrough && cum >= troughCum + maxDD) {
      recoveredAt = t.xt;
      break;
    }
  }
  recoveryDays = recoveredAt > 0 ? (recoveredAt - troughTime) / DAY : -1;

  // Sharpe from daily PnL
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
    ddDuration: ddDurationDays,
    recoveryDays,
    days,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. FULL PERIOD SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  1. FULL PERIOD SUMMARY");
console.log("═".repeat(80));
const fullStats = calcStats(allTrades, FULL_START, FULL_END);
console.log(`  Total trades:     ${fullStats.n}`);
console.log(`  Total PnL:        $${fullStats.total.toFixed(2)}`);
console.log(`  $/day:            $${fullStats.perDay.toFixed(2)}`);
console.log(`  Win rate:         ${fullStats.wr.toFixed(1)}%`);
console.log(`  Profit factor:    ${fullStats.pf.toFixed(2)}`);
console.log(`  Sharpe:           ${fullStats.sharpe.toFixed(2)}`);
console.log(`  Max drawdown:     $${fullStats.maxDD.toFixed(2)}`);
console.log(`  DD duration:      ${fullStats.ddDuration.toFixed(0)} days`);
console.log(`  Recovery:         ${fullStats.recoveryDays >= 0 ? fullStats.recoveryDays.toFixed(0) + " days" : "not recovered"}`);
console.log(`  Period:           ${fullStats.days.toFixed(0)} days`);
console.log();

// ═══════════════════════════════════════════════════════════════════
// 2. PER-YEAR BREAKDOWN
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  2. PER-YEAR BREAKDOWN");
console.log("═".repeat(80));
console.log("  Year      Trades   Total PnL    $/day    WR%      PF    Sharpe   MaxDD");
console.log("  " + "-".repeat(76));

for (const year of [2023, 2024, 2025, 2026]) {
  const ys = new Date(`${year}-01-01`).getTime();
  const ye = new Date(`${year + 1}-01-01`).getTime();
  const yTrades = allTrades.filter(t => t.xt >= ys && t.xt < ye);
  if (yTrades.length === 0) { console.log(`  ${year}       0        -          -       -        -       -        -`); continue; }
  const yEnd = Math.min(ye, FULL_END);
  const s = calcStats(yTrades, ys, yEnd);
  console.log(`  ${year}   ${String(s.n).padStart(7)}  ${("$" + s.total.toFixed(0)).padStart(10)}  ${("$" + s.perDay.toFixed(2)).padStart(8)}  ${s.wr.toFixed(1).padStart(5)}%  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(7)}  ${("$" + s.maxDD.toFixed(0)).padStart(6)}`);
}
console.log();

// ═══════════════════════════════════════════════════════════════════
// 3. PER-REGIME BREAKDOWN
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  3. PER-REGIME BREAKDOWN");
console.log("═".repeat(80));

const regimeCounts = new Map<Regime, number>();
const regimePnl = new Map<Regime, number>();
const regimeTrades = new Map<Regime, number>();
const regimeEngines = new Map<Regime, Map<string, number>>();

for (const [, rd] of regimes) {
  regimeCounts.set(rd.regime, (regimeCounts.get(rd.regime) ?? 0) + 1);
}

for (const t of allTrades) {
  const r = getRegime(regimes, t.et);
  regimePnl.set(r, (regimePnl.get(r) ?? 0) + t.pnl);
  regimeTrades.set(r, (regimeTrades.get(r) ?? 0) + 1);
  if (!regimeEngines.has(r)) regimeEngines.set(r, new Map());
  const eMap = regimeEngines.get(r)!;
  eMap.set(t.engine, (eMap.get(t.engine) ?? 0) + 1);
}

console.log("  Regime        Days   Trades   Total PnL    $/day   Engines");
console.log("  " + "-".repeat(76));
for (const r of ["RISK-OFF", "RECOVERY", "RISK-ON", "CORRECTION"] as Regime[]) {
  const days = regimeCounts.get(r) ?? 0;
  const trades = regimeTrades.get(r) ?? 0;
  const pnl = regimePnl.get(r) ?? 0;
  const perDay = days > 0 ? pnl / days : 0;
  const engines = regimeEngines.get(r) ?? new Map();
  const engineStr = [...engines.entries()].map(([e, n]) => `${e}:${n}`).join(", ");
  console.log(`  ${r.padEnd(14)} ${String(days).padStart(4)}   ${String(trades).padStart(6)}   ${("$" + pnl.toFixed(0)).padStart(10)}  ${("$" + perDay.toFixed(2)).padStart(7)}   ${engineStr}`);
}
console.log();

// ═══════════════════════════════════════════════════════════════════
// 4. PER-MONTH P&L
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  4. PER-MONTH P&L");
console.log("═".repeat(80));
console.log("  Month      Trades     PnL       Cum PnL");
console.log("  " + "-".repeat(50));

const monthlyPnl = new Map<string, { trades: number; pnl: number }>();
for (const t of allTrades) {
  const m = new Date(t.xt).toISOString().slice(0, 7);
  const d = monthlyPnl.get(m) ?? { trades: 0, pnl: 0 };
  d.trades++;
  d.pnl += t.pnl;
  monthlyPnl.set(m, d);
}

let cumPnl = 0;
let losingMonths = 0;
const monthlyPnlValues: number[] = [];
for (const [m, d] of [...monthlyPnl.entries()].sort()) {
  cumPnl += d.pnl;
  if (d.pnl < 0) losingMonths++;
  monthlyPnlValues.push(d.pnl);
  const pnlStr = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
  const cumStr = cumPnl >= 0 ? `+$${cumPnl.toFixed(2)}` : `-$${Math.abs(cumPnl).toFixed(2)}`;
  console.log(`  ${m}   ${String(d.trades).padStart(6)}   ${pnlStr.padStart(10)}   ${cumStr.padStart(10)}`);
}
console.log();
console.log(`  Total months: ${monthlyPnl.size} | Losing months: ${losingMonths} (${(losingMonths / monthlyPnl.size * 100).toFixed(0)}%)`);
console.log();

// ═══════════════════════════════════════════════════════════════════
// 5. PER-ENGINE CONTRIBUTION
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  5. PER-ENGINE CONTRIBUTION");
console.log("═".repeat(80));
console.log("  Engine            Trades   WR%      Total PnL    $/day    PF     Sharpe");
console.log("  " + "-".repeat(74));

const engines = new Set(allTrades.map(t => t.engine));
for (const eng of [...engines].sort()) {
  const eTrades = allTrades.filter(t => t.engine === eng);
  const s = calcStats(eTrades, FULL_START, FULL_END);
  console.log(`  ${eng.padEnd(18)} ${String(s.n).padStart(6)}  ${s.wr.toFixed(1).padStart(5)}%  ${("$" + s.total.toFixed(0)).padStart(11)}  ${("$" + s.perDay.toFixed(2)).padStart(8)}  ${s.pf.toFixed(2).padStart(5)}  ${s.sharpe.toFixed(2).padStart(7)}`);
}
console.log();

// ═══════════════════════════════════════════════════════════════════
// 6. DIRECTION SPLIT
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  6. DIRECTION SPLIT");
console.log("═".repeat(80));

const longs = allTrades.filter(t => t.dir === "long");
const shorts = allTrades.filter(t => t.dir === "short");
const ls = calcStats(longs, FULL_START, FULL_END);
const ss = calcStats(shorts, FULL_START, FULL_END);

console.log(`  Direction   Trades   WR%     Total PnL    $/day    PF     Sharpe   MaxDD`);
console.log("  " + "-".repeat(74));
console.log(`  LONG     ${String(ls.n).padStart(8)}  ${ls.wr.toFixed(1).padStart(5)}%  ${("$" + ls.total.toFixed(0)).padStart(10)}  ${("$" + ls.perDay.toFixed(2)).padStart(8)}  ${ls.pf.toFixed(2).padStart(5)}  ${ls.sharpe.toFixed(2).padStart(7)}  ${("$" + ls.maxDD.toFixed(0)).padStart(6)}`);
console.log(`  SHORT    ${String(ss.n).padStart(8)}  ${ss.wr.toFixed(1).padStart(5)}%  ${("$" + ss.total.toFixed(0)).padStart(10)}  ${("$" + ss.perDay.toFixed(2)).padStart(8)}  ${ss.pf.toFixed(2).padStart(5)}  ${ss.sharpe.toFixed(2).padStart(7)}  ${("$" + ss.maxDD.toFixed(0)).padStart(6)}`);
console.log();

// ═══════════════════════════════════════════════════════════════════
// 7. CONSERVATIVE (2x SPREADS)
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  7. CONSERVATIVE (2x SPREADS)");
console.log("═".repeat(80));
const consStats = calcStats(conservativeTrades, FULL_START, FULL_END);
console.log(`  Total PnL:     $${consStats.total.toFixed(2)}`);
console.log(`  $/day:         $${consStats.perDay.toFixed(2)}`);
console.log(`  Win rate:      ${consStats.wr.toFixed(1)}%`);
console.log(`  Profit factor: ${consStats.pf.toFixed(2)}`);
console.log(`  Sharpe:        ${consStats.sharpe.toFixed(2)}`);
console.log(`  Max drawdown:  $${consStats.maxDD.toFixed(2)}`);
console.log();

// ═══════════════════════════════════════════════════════════════════
// 8. MONTHLY RETURN DISTRIBUTION
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  8. MONTHLY RETURN DISTRIBUTION");
console.log("═".repeat(80));

if (monthlyPnlValues.length > 0) {
  const sorted = [...monthlyPnlValues].sort((a, b) => a - b);
  const meanM = monthlyPnlValues.reduce((s, v) => s + v, 0) / monthlyPnlValues.length;
  const medianM = sorted[Math.floor(sorted.length / 2)];
  const worstM = sorted[0];
  const bestM = sorted[sorted.length - 1];
  const stdM = Math.sqrt(monthlyPnlValues.reduce((s, v) => s + (v - meanM) ** 2, 0) / Math.max(monthlyPnlValues.length - 1, 1));

  console.log(`  Mean:    $${meanM.toFixed(2)}`);
  console.log(`  Median:  $${medianM.toFixed(2)}`);
  console.log(`  Worst:   $${worstM.toFixed(2)}`);
  console.log(`  Best:    $${bestM.toFixed(2)}`);
  console.log(`  StdDev:  $${stdM.toFixed(2)}`);
}
console.log();

// ═══════════════════════════════════════════════════════════════════
// CLEAN SUMMARY TABLE
// ═══════════════════════════════════════════════════════════════════
console.log("═".repeat(80));
console.log("  CLEAN SUMMARY");
console.log("═".repeat(80));
console.log();
console.log("  ┌───────────────────────┬────────────────────────────┐");
console.log(`  │ Total Trades          │ ${String(fullStats.n).padStart(26)} │`);
console.log(`  │ Total PnL             │ ${("$" + fullStats.total.toFixed(2)).padStart(26)} │`);
console.log(`  │ $/day                 │ ${("$" + fullStats.perDay.toFixed(2)).padStart(26)} │`);
console.log(`  │ Win Rate              │ ${(fullStats.wr.toFixed(1) + "%").padStart(26)} │`);
console.log(`  │ Profit Factor         │ ${fullStats.pf.toFixed(2).padStart(26)} │`);
console.log(`  │ Sharpe                │ ${fullStats.sharpe.toFixed(2).padStart(26)} │`);
console.log(`  │ Max Drawdown          │ ${("$" + fullStats.maxDD.toFixed(2)).padStart(26)} │`);
console.log(`  │ DD Duration           │ ${(fullStats.ddDuration.toFixed(0) + " days").padStart(26)} │`);
console.log(`  │ Recovery              │ ${(fullStats.recoveryDays >= 0 ? fullStats.recoveryDays.toFixed(0) + " days" : "not recovered").padStart(26)} │`);
console.log(`  │ Losing Months         │ ${(losingMonths + "/" + monthlyPnl.size + " (" + (losingMonths / monthlyPnl.size * 100).toFixed(0) + "%)").padStart(26)} │`);
console.log(`  │ Conservative $/day    │ ${("$" + consStats.perDay.toFixed(2)).padStart(26)} │`);
console.log("  ├───────────────────────┼────────────────────────────┤");
console.log(`  │ 2023 $/day            │ ${(() => { const t = allTrades.filter(t => t.xt >= new Date("2023-01-01").getTime() && t.xt < new Date("2024-01-01").getTime()); const s = calcStats(t, new Date("2023-01-01").getTime(), new Date("2024-01-01").getTime()); return ("$" + s.perDay.toFixed(2)).padStart(26); })()} │`);
console.log(`  │ 2024 $/day            │ ${(() => { const t = allTrades.filter(t => t.xt >= new Date("2024-01-01").getTime() && t.xt < new Date("2025-01-01").getTime()); const s = calcStats(t, new Date("2024-01-01").getTime(), new Date("2025-01-01").getTime()); return ("$" + s.perDay.toFixed(2)).padStart(26); })()} │`);
console.log(`  │ 2025 $/day            │ ${(() => { const t = allTrades.filter(t => t.xt >= new Date("2025-01-01").getTime() && t.xt < new Date("2026-01-01").getTime()); const s = calcStats(t, new Date("2025-01-01").getTime(), new Date("2026-01-01").getTime()); return ("$" + s.perDay.toFixed(2)).padStart(26); })()} │`);
console.log(`  │ 2026 $/day            │ ${(() => { const t = allTrades.filter(t => t.xt >= new Date("2026-01-01").getTime() && t.xt < new Date("2027-01-01").getTime()); const s = calcStats(t, new Date("2026-01-01").getTime(), Math.min(new Date("2027-01-01").getTime(), FULL_END)); return ("$" + s.perDay.toFixed(2)).padStart(26); })()} │`);
console.log("  ├───────────────────────┼────────────────────────────┤");
for (const eng of [...engines].sort()) {
  const eTrades = allTrades.filter(t => t.engine === eng);
  const s = calcStats(eTrades, FULL_START, FULL_END);
  console.log(`  │ ${eng.padEnd(21)} │ ${("$" + s.perDay.toFixed(2) + "/day, PF " + s.pf.toFixed(2)).padStart(26)} │`);
}
console.log("  ├───────────────────────┼────────────────────────────┤");
console.log(`  │ Longs PnL             │ ${("$" + ls.total.toFixed(0) + " (" + ls.n + " trades)").padStart(26)} │`);
console.log(`  │ Shorts PnL            │ ${("$" + ss.total.toFixed(0) + " (" + ss.n + " trades)").padStart(26)} │`);
console.log("  └───────────────────────┴────────────────────────────┘");
console.log();
