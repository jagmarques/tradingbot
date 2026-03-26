/**
 * Deep Sideways Strategy Search
 *
 * 7 creative strategies designed specifically for choppy/sideways crypto markets.
 * Tests on 18 pairs, classifies months by BTC return, reports per-regime performance.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-sideways-deep.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35; // taker 0.035%
const MARGIN = 5;
const LEV = 10;
const NOTIONAL = MARGIN * LEV; // $50

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";
type Regime = "BULL" | "BEAR" | "SIDEWAYS";

interface Trade {
  pair: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
}

interface MonthRegime {
  year: number; month: number;
  start: number; end: number;
  btcReturn: number; regime: Regime;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function sma(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function ema(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i === 0) v = vals[i];
    else v = vals[i] * k + v * (1 - k);
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c),
        );
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

function rsi(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return r;
}

function bollingerBands(closes: number[], period: number, stdMult: number): {
  upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[];
  width: (number | null)[];
} {
  const mid = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  const width: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    if (mid[i] === null) continue;
    let sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum2 += (closes[j] - mid[i]!) ** 2;
    }
    const std = Math.sqrt(sum2 / period);
    upper[i] = mid[i]! + stdMult * std;
    lower[i] = mid[i]! - stdMult * std;
    width[i] = mid[i]! > 0 ? (upper[i]! - lower[i]!) / mid[i]! : null;
  }
  return { upper, middle: mid, lower, width };
}

function adx(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return r;
  const trArr: number[] = [];
  const dmPlusArr: number[] = [];
  const dmMinusArr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      trArr.push(bars[i].h - bars[i].l);
      dmPlusArr.push(0);
      dmMinusArr.push(0);
      continue;
    }
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    const dmPlus = upMove > downMove && upMove > 0 ? upMove : 0;
    const dmMinus = downMove > upMove && downMove > 0 ? downMove : 0;
    trArr.push(tr);
    dmPlusArr.push(dmPlus);
    dmMinusArr.push(dmMinus);
  }
  let smoothTR = 0, smoothDMPlus = 0, smoothDMMinus = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trArr[i];
    smoothDMPlus += dmPlusArr[i];
    smoothDMMinus += dmMinusArr[i];
  }
  const dxArr: number[] = [];
  for (let i = period; i < bars.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trArr[i];
      smoothDMPlus = smoothDMPlus - smoothDMPlus / period + dmPlusArr[i];
      smoothDMMinus = smoothDMMinus - smoothDMMinus / period + dmMinusArr[i];
    }
    const diPlus = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
    const diMinus = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;
    const diSum = diPlus + diMinus;
    const dx = diSum > 0 ? (Math.abs(diPlus - diMinus) / diSum) * 100 : 0;
    dxArr.push(dx);
  }
  let adxVal = 0;
  for (let i = 0; i < dxArr.length; i++) {
    if (i < period) {
      adxVal += dxArr[i];
      if (i === period - 1) {
        adxVal /= period;
        r[i + period] = adxVal;
      }
    } else {
      adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
      r[i + period] = adxVal;
    }
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): (1 | -1 | null)[] {
  const atrVals = atrFn(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;
  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;
    if (i > 0 && atrVals[i - 1] !== null) {
      if (!(lb > lowerBand || bars[i - 1].c < lowerBand)) lb = lowerBand;
      if (!(ub < upperBand || bars[i - 1].c > upperBand)) ub = upperBand;
    }
    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }
    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return trend;
}

// ─── Helpers ────────────────────────────────────────────────────────
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const mA = mean(a.slice(0, n));
  const mB = mean(b.slice(0, n));
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA;
    const db = b[i] - mB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

function tradePnl(pair: string, dir: Dir, entryPrice: number, exitPrice: number, isStop: boolean): number {
  const spread = sp(pair);
  const slipMult = isStop ? 1.5 : 1;
  const ep = dir === "long" ? entryPrice * (1 + spread) : entryPrice * (1 - spread);
  const xp = dir === "long" ? exitPrice * (1 - spread * slipMult) : exitPrice * (1 + spread * slipMult);
  const raw = dir === "long"
    ? (xp / ep - 1) * NOTIONAL
    : (ep / xp - 1) * NOTIONAL;
  const fees = NOTIONAL * FEE * 2;
  return raw - fees;
}

// ─── Regime Classification ──────────────────────────────────────────
function classifyMonths(btcDaily: Bar[]): MonthRegime[] {
  const months: MonthRegime[] = [];
  let y = new Date(FULL_START).getFullYear();
  let m = new Date(FULL_START).getMonth();

  while (true) {
    const mStart = new Date(y, m, 1).getTime();
    const mEnd = new Date(y, m + 1, 1).getTime();
    if (mStart >= FULL_END) break;

    let firstBar: Bar | null = null;
    let lastBar: Bar | null = null;
    for (const b of btcDaily) {
      if (b.t >= mStart && b.t < mEnd) {
        if (!firstBar) firstBar = b;
        lastBar = b;
      }
    }

    if (firstBar && lastBar && firstBar !== lastBar) {
      const ret = lastBar.c / firstBar.o - 1;
      let regime: Regime;
      if (ret > 0.05) regime = "BULL";
      else if (ret < -0.05) regime = "BEAR";
      else regime = "SIDEWAYS";

      months.push({
        year: y, month: m + 1,
        start: mStart, end: mEnd,
        btcReturn: ret, regime,
      });
    }

    m++;
    if (m >= 12) { m = 0; y++; }
    if (new Date(y, m, 1).getTime() > FULL_END) break;
  }
  return months;
}

// ─── Precomputed Pair Data ──────────────────────────────────────────
interface PairData {
  pair: string;
  h4: Bar[];
  daily: Bar[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  h4Closes: number[];
  h4RSI: (number | null)[];
  h4ATR: (number | null)[];
  h4ADX: (number | null)[];
  h4BBupper: (number | null)[];
  h4BBlower: (number | null)[];
  h4BBmid: (number | null)[];
  h4BBwidth: (number | null)[];
  h4ST: (1 | -1 | null)[];
  dailyCloses: number[];
  dailyRSI: (number | null)[];
}

// ─── Strategy Results ───────────────────────────────────────────────
interface RegimeStats {
  regime: Regime;
  trades: number;
  pnl: number;
  wins: number;
  pf: number;
  sharpe: number;
  avgTrade: number;
  months: number;
  pnlPerDay: number;
}

function computeRegimeStats(trades: Trade[], months: MonthRegime[]): { all: RegimeStats; byRegime: Map<Regime, RegimeStats> } {
  const regimeMap = new Map<Regime, { trades: Trade[]; months: number; totalDays: number }>();
  regimeMap.set("BULL", { trades: [], months: 0, totalDays: 0 });
  regimeMap.set("BEAR", { trades: [], months: 0, totalDays: 0 });
  regimeMap.set("SIDEWAYS", { trades: [], months: 0, totalDays: 0 });

  for (const m of months) {
    const rd = regimeMap.get(m.regime)!;
    rd.months++;
    rd.totalDays += (m.end - m.start) / DAY;
    for (const t of trades) {
      if (t.et >= m.start && t.et < m.end) {
        rd.trades.push(t);
      }
    }
  }

  const byRegime = new Map<Regime, RegimeStats>();
  for (const [regime, data] of regimeMap) {
    const trs = data.trades;
    const pnl = trs.reduce((s, t) => s + t.pnl, 0);
    const wins = trs.filter(t => t.pnl > 0).length;
    const gp = trs.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trs.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;

    // Daily PnL for Sharpe
    const dayMap = new Map<number, number>();
    for (const t of trs) {
      const dk = Math.floor(t.xt / DAY) * DAY;
      dayMap.set(dk, (dayMap.get(dk) || 0) + t.pnl);
    }
    const dailyPnls: number[] = [];
    for (const m of months) {
      if (m.regime !== regime) continue;
      for (let d = m.start; d < m.end; d += DAY) {
        const dk = Math.floor(d / DAY) * DAY;
        dailyPnls.push(dayMap.get(dk) || 0);
      }
    }
    const avg = mean(dailyPnls);
    const sd = stdDev(dailyPnls);
    const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(365) : 0;

    byRegime.set(regime, {
      regime,
      trades: trs.length,
      pnl,
      wins,
      pf,
      sharpe,
      avgTrade: trs.length > 0 ? pnl / trs.length : 0,
      months: data.months,
      pnlPerDay: data.totalDays > 0 ? pnl / data.totalDays : 0,
    });
  }

  // All
  const allTrades = trades;
  const allPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const allWins = allTrades.filter(t => t.pnl > 0).length;
  const allGP = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const allGL = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const allPF = allGL > 0 ? allGP / allGL : allGP > 0 ? 99 : 0;
  const totalDays = months.reduce((s, m) => s + (m.end - m.start) / DAY, 0);
  const dayMapAll = new Map<number, number>();
  for (const t of allTrades) {
    const dk = Math.floor(t.xt / DAY) * DAY;
    dayMapAll.set(dk, (dayMapAll.get(dk) || 0) + t.pnl);
  }
  const dailyAll: number[] = [];
  for (const m of months) {
    for (let d = m.start; d < m.end; d += DAY) {
      dailyAll.push(dayMapAll.get(Math.floor(d / DAY) * DAY) || 0);
    }
  }
  const avgAll = mean(dailyAll);
  const sdAll = stdDev(dailyAll);
  const sharpeAll = sdAll > 0 ? (avgAll / sdAll) * Math.sqrt(365) : 0;

  return {
    all: {
      regime: "SIDEWAYS",
      trades: allTrades.length,
      pnl: allPnl,
      wins: allWins,
      pf: allPF,
      sharpe: sharpeAll,
      avgTrade: allTrades.length > 0 ? allPnl / allTrades.length : 0,
      months: months.length,
      pnlPerDay: totalDays > 0 ? allPnl / totalDays : 0,
    },
    byRegime,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 1: Fade the Fade
// When Supertrend flips AND ADX < 20, enter OPPOSITE direction.
// Exit after 4 bars or if ADX > 25. SL: 2%.
// ═══════════════════════════════════════════════════════════════════
function strategy1FadeTheFade(pairDataMap: Map<string, PairData>): Trade[] {
  const trades: Trade[] = [];
  const MAX_HOLD_BARS = 4;

  for (const [pair, pd] of pairDataMap) {
    const positions: { dir: Dir; ep: number; et: number; sl: number; barsHeld: number }[] = [];

    for (let i = 30; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t < FULL_START || bar.t >= FULL_END) continue;

      // Check existing positions
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        pos.barsHeld++;

        // SL check
        const slHit = pos.dir === "long"
          ? bar.l <= pos.sl
          : bar.h >= pos.sl;

        // ADX exit: if ADX rises above 25, trend is back, close
        const adxNow = pd.h4ADX[i];
        const adxExit = adxNow !== null && adxNow > 25;

        // Max hold exit
        const maxHoldExit = pos.barsHeld >= MAX_HOLD_BARS;

        if (slHit || adxExit || maxHoldExit) {
          const exitPrice = slHit ? pos.sl : bar.c;
          const pnl = tradePnl(pair, pos.dir, pos.ep, exitPrice, slHit);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: exitPrice, et: pos.et, xt: bar.t, pnl });
          positions.splice(p, 1);
        }
      }

      // New signal: Supertrend flip AND ADX < 20
      if (positions.length > 0) continue;
      const stNow = pd.h4ST[i - 1];
      const stPrev = pd.h4ST[i - 2];
      if (stNow === null || stPrev === null) continue;
      if (stNow === stPrev) continue; // no flip

      const adxVal = pd.h4ADX[i - 1];
      if (adxVal === null || adxVal >= 20) continue; // only ranging

      // Supertrend flipped to +1 (bullish) -> we FADE -> go short
      // Supertrend flipped to -1 (bearish) -> we FADE -> go long
      const dir: Dir = stNow === 1 ? "short" : "long";
      const ep = bar.o;
      const sl = dir === "long" ? ep * (1 - 0.02) : ep * (1 + 0.02);

      positions.push({ dir, ep, et: bar.t, sl, barsHeld: 0 });
    }
  }
  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 2: Bollinger Bandwidth Scalp
// Enter when BB width < 20th percentile for 3+ bars AND price touches band.
// Fade toward middle band. SL: 1.5%.
// ═══════════════════════════════════════════════════════════════════
function strategy2BBWidthScalp(pairDataMap: Map<string, PairData>): Trade[] {
  const trades: Trade[] = [];
  const SQUEEZE_LOOKBACK = 60; // bars to compute percentile
  const SQUEEZE_BARS = 3; // consecutive bars below threshold
  const SL_PCT = 0.015;

  for (const [pair, pd] of pairDataMap) {
    let position: { dir: Dir; ep: number; et: number; sl: number; tp: number } | null = null;

    for (let i = SQUEEZE_LOOKBACK + SQUEEZE_BARS; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t < FULL_START || bar.t >= FULL_END) continue;

      // Check existing position
      if (position) {
        // SL
        const slHit = position.dir === "long"
          ? bar.l <= position.sl
          : bar.h >= position.sl;
        // TP at middle band
        const tpHit = position.dir === "long"
          ? bar.h >= position.tp
          : bar.l <= position.tp;

        if (slHit || tpHit) {
          const exitPrice = slHit ? position.sl : position.tp;
          const pnl = tradePnl(pair, position.dir, position.ep, exitPrice, slHit);
          trades.push({ pair, dir: position.dir, ep: position.ep, xp: exitPrice, et: position.et, xt: bar.t, pnl });
          position = null;
        }
        continue;
      }

      // Check for squeeze: BB width below 20th percentile for 3+ consecutive bars
      const widths: number[] = [];
      for (let j = i - SQUEEZE_LOOKBACK; j < i; j++) {
        if (pd.h4BBwidth[j] !== null) widths.push(pd.h4BBwidth[j]!);
      }
      if (widths.length < 20) continue;
      widths.sort((a, b) => a - b);
      const pctile20 = widths[Math.floor(widths.length * 0.2)];

      // Check 3 consecutive bars below threshold
      let squeezeBars = 0;
      for (let j = i - SQUEEZE_BARS; j < i; j++) {
        if (pd.h4BBwidth[j] !== null && pd.h4BBwidth[j]! <= pctile20) squeezeBars++;
      }
      if (squeezeBars < SQUEEZE_BARS) continue;

      // Now check if price touches band
      const close = pd.h4Closes[i - 1];
      const upper = pd.h4BBupper[i - 1];
      const lower = pd.h4BBlower[i - 1];
      const mid = pd.h4BBmid[i - 1];
      if (upper === null || lower === null || mid === null) continue;

      const ep = bar.o;
      if (close >= upper) {
        // Price at upper band -> short toward middle
        position = { dir: "short", ep, et: bar.t, sl: ep * (1 + SL_PCT), tp: mid };
      } else if (close <= lower) {
        // Price at lower band -> long toward middle
        position = { dir: "long", ep, et: bar.t, sl: ep * (1 - SL_PCT), tp: mid };
      }
    }
  }
  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 3: Pair Spread Mean Reversion
// Most correlated pairs -> trade spread divergence in sideways.
// Only enter when BTC ADX < 20. Max hold 48h.
// ═══════════════════════════════════════════════════════════════════
function strategy3PairSpreadMR(
  pairDataMap: Map<string, PairData>,
  btcH4: Bar[],
  btcH4ADX: (number | null)[],
  btcH4Map: Map<number, number>,
): Trade[] {
  const trades: Trade[] = [];
  const pairs = [...pairDataMap.keys()];

  // Find top 5 most correlated pairs using first 60% of data
  interface PairCorr { a: string; b: string; corr: number }
  const corrResults: PairCorr[] = [];

  const trainEnd = new Date("2025-06-01").getTime();

  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pairs[i], b = pairs[j];
      const pdA = pairDataMap.get(a)!, pdB = pairDataMap.get(b)!;

      // Compute aligned returns
      const retsA: number[] = [], retsB: number[] = [];
      for (let k = 1; k < pdA.h4.length; k++) {
        const t = pdA.h4[k].t;
        if (t < FULL_START || t >= trainEnd) continue;
        const idxB = pdB.h4Map.get(t);
        if (idxB === undefined || idxB < 1) continue;
        retsA.push(pdA.h4[k].c / pdA.h4[k - 1].c - 1);
        retsB.push(pdB.h4[idxB].c / pdB.h4[idxB - 1].c - 1);
      }
      if (retsA.length < 500) continue;
      const corr = correlation(retsA, retsB);
      corrResults.push({ a, b, corr });
    }
  }

  corrResults.sort((x, y) => y.corr - x.corr);
  const topPairs = corrResults.slice(0, 5);

  console.log("    Top 5 correlated pairs:");
  for (const p of topPairs) {
    console.log(`      ${p.a}/${p.b}: corr = ${p.corr.toFixed(3)}`);
  }

  // Trade each correlated pair
  const WINDOW = 60; // 60 bars rolling window for spread z-score
  const Z_ENTRY = 2;
  const MAX_HOLD = 12; // 48h in 4h bars

  for (const { a, b } of topPairs) {
    const pdA = pairDataMap.get(a)!, pdB = pairDataMap.get(b)!;

    // Build aligned timestamps
    const aligned: { t: number; ia: number; ib: number }[] = [];
    for (let k = 0; k < pdA.h4.length; k++) {
      const t = pdA.h4[k].t;
      const ib = pdB.h4Map.get(t);
      if (ib !== undefined) aligned.push({ t, ia: k, ib });
    }

    let inTrade = false;
    let tradeDir: "long_a_short_b" | "short_a_long_b" = "long_a_short_b";
    let entryA = 0, entryB = 0, entryT = 0, barsHeld = 0;

    for (let k = WINDOW; k < aligned.length; k++) {
      const { t, ia, ib } = aligned[k];
      if (t < FULL_START || t >= FULL_END) continue;

      const prA = pdA.h4[ia].c, prB = pdB.h4[ib].c;

      // Compute rolling spread z-score (ratio-based)
      const ratios: number[] = [];
      for (let w = k - WINDOW; w < k; w++) {
        const wa = pdA.h4[aligned[w].ia].c;
        const wb = pdB.h4[aligned[w].ib].c;
        if (wb > 0) ratios.push(wa / wb);
      }
      if (ratios.length < WINDOW * 0.8) continue;
      const mR = mean(ratios);
      const sR = stdDev(ratios);
      if (sR === 0) continue;
      const z = (prA / prB - mR) / sR;

      if (inTrade) {
        barsHeld++;
        const shouldExit =
          (tradeDir === "short_a_long_b" && z <= 0) ||
          (tradeDir === "long_a_short_b" && z >= 0) ||
          barsHeld >= MAX_HOLD;

        if (shouldExit) {
          const isStop = barsHeld >= MAX_HOLD;
          if (tradeDir === "short_a_long_b") {
            trades.push({ pair: `${a}/${b}`, dir: "short", ep: entryA, xp: prA, et: entryT, xt: t, pnl: tradePnl(a, "short", entryA, prA, isStop) });
            trades.push({ pair: `${b}/${a}`, dir: "long", ep: entryB, xp: prB, et: entryT, xt: t, pnl: tradePnl(b, "long", entryB, prB, isStop) });
          } else {
            trades.push({ pair: `${a}/${b}`, dir: "long", ep: entryA, xp: prA, et: entryT, xt: t, pnl: tradePnl(a, "long", entryA, prA, isStop) });
            trades.push({ pair: `${b}/${a}`, dir: "short", ep: entryB, xp: prB, et: entryT, xt: t, pnl: tradePnl(b, "short", entryB, prB, isStop) });
          }
          inTrade = false;
        }
      }

      if (!inTrade) {
        // BTC ADX filter: only trade when BTC is ranging
        const btcI = btcH4Map.get(t);
        if (btcI === undefined) continue;
        const btcAdx = btcH4ADX[btcI];
        if (btcAdx === null || btcAdx >= 20) continue;

        if (z > Z_ENTRY) {
          tradeDir = "short_a_long_b";
          entryA = prA; entryB = prB; entryT = t; barsHeld = 0;
          inTrade = true;
        } else if (z < -Z_ENTRY) {
          tradeDir = "long_a_short_b";
          entryA = prA; entryB = prB; entryT = t; barsHeld = 0;
          inTrade = true;
        }
      }
    }
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 4: Funding Carry Pure
// In sideways (BTC ADX < 20), short the 3 highest-funding pairs.
// Hold for 7 days. Simulated funding: 0.01% per 8h (average crypto funding).
// No directional signal.
// ═══════════════════════════════════════════════════════════════════
function strategy4FundingCarry(
  pairDataMap: Map<string, PairData>,
  btcDaily: Bar[],
  btcDailyADX: (number | null)[],
  btcDailyMap: Map<number, number>,
): Trade[] {
  const trades: Trade[] = [];
  const HOLD_BARS = 42; // 7 days in 4h bars
  const FUNDING_PER_8H = 0.0001; // 0.01% per 8h (conservative avg)
  const FUNDING_PER_4H = FUNDING_PER_8H / 2; // per 4h bar

  // We simulate funding by selecting pairs with highest recent volatility
  // as a proxy for high funding (high vol = high funding in crypto).
  // Then we short them and collect "funding".
  // Each 4h bar we earn FUNDING_PER_4H * NOTIONAL.

  // Weekly rebalance: every 42 bars (7 days)
  const pairs = [...pairDataMap.keys()];
  const allH4Times: number[] = [];
  const timeSet = new Set<number>();
  for (const [, pd] of pairDataMap) {
    for (const b of pd.h4) {
      if (b.t >= FULL_START && b.t < FULL_END && !timeSet.has(b.t)) {
        timeSet.add(b.t);
        allH4Times.push(b.t);
      }
    }
  }
  allH4Times.sort((a, b) => a - b);

  interface CarryPos { pair: string; ep: number; et: number; barsHeld: number }
  let positions: CarryPos[] = [];
  let lastRebal = 0;

  for (const t of allH4Times) {
    // Update existing positions
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.barsHeld++;

      if (pos.barsHeld >= HOLD_BARS) {
        const pd = pairDataMap.get(pos.pair)!;
        const bi = pd.h4Map.get(t);
        if (bi === undefined) continue;
        const exitPrice = pd.h4[bi].c;

        // PnL = directional + funding earned
        const dirPnl = tradePnl(pos.pair, "short", pos.ep, exitPrice, false);
        const fundingIncome = FUNDING_PER_4H * NOTIONAL * pos.barsHeld;
        trades.push({
          pair: pos.pair, dir: "short",
          ep: pos.ep, xp: exitPrice,
          et: pos.et, xt: t,
          pnl: dirPnl + fundingIncome,
        });
        positions.splice(p, 1);
      }
    }

    // Rebalance weekly (every ~42 bars)
    if (positions.length > 0 || t - lastRebal < HOLD_BARS * H4) continue;

    // BTC sideways filter: ADX < 20 on daily
    const dailyT = Math.floor(t / DAY) * DAY;
    const btcDi = btcDailyMap.get(dailyT);
    if (btcDi === undefined) continue;
    const btcAdx = btcDailyADX[btcDi];
    if (btcAdx === null || btcAdx >= 20) continue;

    // Rank pairs by recent volatility (proxy for high funding)
    const ranked: { pair: string; vol: number }[] = [];
    for (const pair of pairs) {
      const pd = pairDataMap.get(pair)!;
      const bi = pd.h4Map.get(t);
      if (bi === undefined || bi < 42) continue;
      // Compute 7-day ATR / price
      const atr = pd.h4ATR[bi];
      if (atr === null) continue;
      const relVol = atr / pd.h4[bi].c;
      ranked.push({ pair, vol: relVol });
    }
    ranked.sort((a, b) => b.vol - a.vol);

    // Short top 3
    const top3 = ranked.slice(0, 3);
    for (const { pair } of top3) {
      const pd = pairDataMap.get(pair)!;
      const bi = pd.h4Map.get(t);
      if (bi === undefined) continue;
      const ep = pd.h4[bi].o;
      positions.push({ pair, ep, et: t, barsHeld: 0 });
    }
    lastRebal = t;
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 5: Counter-Trend Scalp
// When a pair moves >2% in 24h AND BTC ADX < 20, fade it.
// TP: 1%, SL: 1.5%.
// ═══════════════════════════════════════════════════════════════════
function strategy5CounterTrendScalp(
  pairDataMap: Map<string, PairData>,
  btcH4: Bar[],
  btcH4ADX: (number | null)[],
  btcH4Map: Map<number, number>,
): Trade[] {
  const trades: Trade[] = [];
  const MOVE_THRESHOLD = 0.02; // 2%
  const TP_PCT = 0.01;
  const SL_PCT = 0.015;
  const LOOKBACK = 6; // 6 * 4h = 24h

  for (const [pair, pd] of pairDataMap) {
    let position: { dir: Dir; ep: number; et: number; sl: number; tp: number } | null = null;

    for (let i = LOOKBACK + 30; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t < FULL_START || bar.t >= FULL_END) continue;

      // Check existing position
      if (position) {
        const slHit = position.dir === "long"
          ? bar.l <= position.sl
          : bar.h >= position.sl;
        const tpHit = position.dir === "long"
          ? bar.h >= position.tp
          : bar.l <= position.tp;

        if (slHit || tpHit) {
          const exitPrice = slHit ? position.sl : position.tp;
          const pnl = tradePnl(pair, position.dir, position.ep, exitPrice, slHit);
          trades.push({ pair, dir: position.dir, ep: position.ep, xp: exitPrice, et: position.et, xt: bar.t, pnl });
          position = null;
        }
        continue;
      }

      // BTC ADX filter
      const btcI = btcH4Map.get(bar.t);
      if (btcI === undefined) continue;
      const btcAdx = btcH4ADX[btcI];
      if (btcAdx === null || btcAdx >= 20) continue;

      // Compute 24h move
      const prevClose = pd.h4Closes[i - LOOKBACK];
      const curClose = pd.h4Closes[i - 1];
      const move = (curClose - prevClose) / prevClose;

      const ep = bar.o;
      if (move > MOVE_THRESHOLD) {
        // Pair pumped >2% -> fade short
        position = {
          dir: "short", ep, et: bar.t,
          sl: ep * (1 + SL_PCT),
          tp: ep * (1 - TP_PCT),
        };
      } else if (move < -MOVE_THRESHOLD) {
        // Pair dumped >2% -> fade long
        position = {
          dir: "long", ep, et: bar.t,
          sl: ep * (1 - SL_PCT),
          tp: ep * (1 + TP_PCT),
        };
      }
    }
  }
  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 6: Volatility Contraction Play (Straddle-like)
// When ATR(14) < 20th percentile over 60 bars, open BOTH long and short.
// TP: 2% each. When one hits TP, move the other to breakeven.
// ═══════════════════════════════════════════════════════════════════
function strategy6VolContraction(pairDataMap: Map<string, PairData>): Trade[] {
  const trades: Trade[] = [];
  const ATR_LOOKBACK = 60;
  const TP_PCT = 0.02;
  const MAX_HOLD = 18; // 72h in 4h bars

  for (const [pair, pd] of pairDataMap) {
    interface Straddle {
      longEp: number; shortEp: number; et: number;
      longTP: number; shortTP: number;
      longSL: number; shortSL: number;
      longOpen: boolean; shortOpen: boolean;
      barsHeld: number;
    }
    let straddle: Straddle | null = null;

    for (let i = ATR_LOOKBACK + 30; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t < FULL_START || bar.t >= FULL_END) continue;

      // Manage existing straddle
      if (straddle) {
        straddle.barsHeld++;
        const maxHoldExit = straddle.barsHeld >= MAX_HOLD;

        // Check long leg
        if (straddle.longOpen) {
          if (bar.h >= straddle.longTP) {
            const pnl = tradePnl(pair, "long", straddle.longEp, straddle.longTP, false);
            trades.push({ pair, dir: "long", ep: straddle.longEp, xp: straddle.longTP, et: straddle.et, xt: bar.t, pnl });
            straddle.longOpen = false;
            // Move short to breakeven
            if (straddle.shortOpen) straddle.shortSL = straddle.shortEp;
          } else if (bar.l <= straddle.longSL || maxHoldExit) {
            const exitP = maxHoldExit ? bar.c : straddle.longSL;
            const pnl = tradePnl(pair, "long", straddle.longEp, exitP, !maxHoldExit);
            trades.push({ pair, dir: "long", ep: straddle.longEp, xp: exitP, et: straddle.et, xt: bar.t, pnl });
            straddle.longOpen = false;
          }
        }

        // Check short leg
        if (straddle.shortOpen) {
          if (bar.l <= straddle.shortTP) {
            const pnl = tradePnl(pair, "short", straddle.shortEp, straddle.shortTP, false);
            trades.push({ pair, dir: "short", ep: straddle.shortEp, xp: straddle.shortTP, et: straddle.et, xt: bar.t, pnl });
            straddle.shortOpen = false;
            // Move long to breakeven
            if (straddle.longOpen) straddle.longSL = straddle.longEp;
          } else if (bar.h >= straddle.shortSL || maxHoldExit) {
            const exitP = maxHoldExit ? bar.c : straddle.shortSL;
            const pnl = tradePnl(pair, "short", straddle.shortEp, exitP, !maxHoldExit);
            trades.push({ pair, dir: "short", ep: straddle.shortEp, xp: exitP, et: straddle.et, xt: bar.t, pnl });
            straddle.shortOpen = false;
          }
        }

        if (!straddle.longOpen && !straddle.shortOpen) straddle = null;
        continue;
      }

      // Check for volatility contraction
      const atrVals: number[] = [];
      for (let j = i - ATR_LOOKBACK; j < i; j++) {
        if (pd.h4ATR[j] !== null) atrVals.push(pd.h4ATR[j]!);
      }
      if (atrVals.length < 30) continue;
      atrVals.sort((a, b) => a - b);
      const pctile20 = atrVals[Math.floor(atrVals.length * 0.2)];

      const curATR = pd.h4ATR[i - 1];
      if (curATR === null || curATR > pctile20) continue;

      // Open straddle
      const ep = bar.o;
      straddle = {
        longEp: ep, shortEp: ep, et: bar.t,
        longTP: ep * (1 + TP_PCT), shortTP: ep * (1 - TP_PCT),
        longSL: ep * (1 - 0.03), shortSL: ep * (1 + 0.03), // wide initial SL
        longOpen: true, shortOpen: true,
        barsHeld: 0,
      };
    }
  }
  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 7: Cross-Pair Rotation in Sideways
// Every week during sideways (BTC ADX < 20): long most oversold, short most overbought.
// Hold 3 days.
// ═══════════════════════════════════════════════════════════════════
function strategy7CrossPairRotation(
  pairDataMap: Map<string, PairData>,
  btcDaily: Bar[],
  btcDailyADX: (number | null)[],
  btcDailyMap: Map<number, number>,
): Trade[] {
  const trades: Trade[] = [];
  const HOLD_DAYS = 3;
  const REBAL_DAYS = 7;

  // Get all daily timestamps
  const dailyTimes: number[] = [];
  const seen = new Set<number>();
  for (const [, pd] of pairDataMap) {
    for (const b of pd.daily) {
      const dt = Math.floor(b.t / DAY) * DAY;
      if (dt >= FULL_START && dt < FULL_END && !seen.has(dt)) {
        seen.add(dt);
        dailyTimes.push(dt);
      }
    }
  }
  dailyTimes.sort((a, b) => a - b);

  interface RotPos { pair: string; dir: Dir; ep: number; et: number }
  let positions: RotPos[] = [];
  let lastRebal = 0;

  for (const t of dailyTimes) {
    // Close positions after HOLD_DAYS
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      if (t - pos.et >= HOLD_DAYS * DAY) {
        const pd = pairDataMap.get(pos.pair)!;
        const di = pd.dailyMap.get(t);
        if (di === undefined) continue;
        const exitPrice = pd.daily[di].c;
        const pnl = tradePnl(pos.pair, pos.dir, pos.ep, exitPrice, false);
        trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: exitPrice, et: pos.et, xt: t, pnl });
        positions.splice(p, 1);
      }
    }

    // Rebalance weekly
    if (positions.length > 0 || t - lastRebal < REBAL_DAYS * DAY) continue;

    // BTC ADX filter
    const btcDi = btcDailyMap.get(t);
    if (btcDi === undefined) continue;
    const btcAdx = btcDailyADX[btcDi];
    if (btcAdx === null || btcAdx >= 20) continue;

    // Rank by 7-day RSI (use daily RSI)
    const ranked: { pair: string; rsiVal: number }[] = [];
    const pairs = [...pairDataMap.keys()];
    for (const pair of pairs) {
      const pd = pairDataMap.get(pair)!;
      const di = pd.dailyMap.get(t);
      if (di === undefined || di < 14) continue;
      const r = pd.dailyRSI[di - 1];
      if (r === null) continue;
      ranked.push({ pair, rsiVal: r });
    }
    if (ranked.length < 4) continue;
    ranked.sort((a, b) => a.rsiVal - b.rsiVal);

    // Long most oversold (RSI < 30), short most overbought (RSI > 70)
    const oversold = ranked.filter(r => r.rsiVal < 30);
    const overbought = ranked.filter(r => r.rsiVal > 70);

    // Take top 2 from each side, or the extreme ends if none meet threshold
    const toLong = oversold.length > 0
      ? oversold.slice(0, 2)
      : ranked.slice(0, 1); // most oversold even if RSI > 30
    const toShort = overbought.length > 0
      ? overbought.slice(-2)
      : ranked.slice(-1); // most overbought even if RSI < 70

    for (const { pair } of toLong) {
      const pd = pairDataMap.get(pair)!;
      const di = pd.dailyMap.get(t);
      if (di === undefined) continue;
      const ep = pd.daily[di].o;
      positions.push({ pair, dir: "long", ep, et: t });
    }
    for (const { pair } of toShort) {
      const pd = pairDataMap.get(pair)!;
      const di = pd.dailyMap.get(t);
      if (di === undefined) continue;
      const ep = pd.daily[di].o;
      positions.push({ pair, dir: "short", ep, et: t });
    }
    lastRebal = t;
  }

  trades.sort((a, b) => a.et - b.et);
  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
function main() {
  console.log("=".repeat(95));
  console.log("  DEEP SIDEWAYS STRATEGY SEARCH");
  console.log("  7 creative strategies for choppy/range-bound crypto markets");
  console.log("=".repeat(95));

  // Load BTC
  console.log("\nLoading data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }

  const btcDaily = aggregate(btcRaw, DAY);
  const btcH4 = aggregate(btcRaw, H4);
  const btcDailyMap = new Map(btcDaily.map((b, i) => [b.t, i]));
  const btcH4Map = new Map(btcH4.map((b, i) => [b.t, i]));
  const btcDailyADX = adx(btcDaily, 14);
  const btcH4ADX = adx(btcH4, 14);

  // Classify months
  const months = classifyMonths(btcDaily);
  const bullMonths = months.filter(m => m.regime === "BULL");
  const bearMonths = months.filter(m => m.regime === "BEAR");
  const sideMonths = months.filter(m => m.regime === "SIDEWAYS");

  console.log(`\nBTC monthly returns classified: ${months.length} months total`);
  console.log(`  BULL:     ${bullMonths.length} months`);
  console.log(`  BEAR:     ${bearMonths.length} months`);
  console.log(`  SIDEWAYS: ${sideMonths.length} months`);

  console.log("\n--- Month Classification ---");
  for (const m of months) {
    const tag = m.regime === "BULL" ? "+++" : m.regime === "BEAR" ? "---" : "   ";
    console.log(`  ${m.year}-${String(m.month).padStart(2, "0")}  BTC: ${(m.btcReturn * 100).toFixed(1).padStart(6)}%  ${tag} ${m.regime}`);
  }

  // Load pairs
  const pairDataMap = new Map<string, PairData>();
  let loaded = 0;
  for (const pair of WANTED_PAIRS) {
    const raw = load5m(pair);
    if (raw.length < 500) { console.log(`  Skip ${pair} (insufficient data)`); continue; }

    const h4 = aggregate(raw, H4);
    const daily = aggregate(raw, DAY);
    const h4c = h4.map(b => b.c);
    const dc = daily.map(b => b.c);
    const bb = bollingerBands(h4c, 20, 2);

    pairDataMap.set(pair, {
      pair,
      h4, daily,
      h4Map: new Map(h4.map((b, i) => [b.t, i])),
      dailyMap: new Map(daily.map((b, i) => [b.t, i])),
      h4Closes: h4c,
      h4RSI: rsi(h4c, 14),
      h4ATR: atrFn(h4, 14),
      h4ADX: adx(h4, 14),
      h4BBupper: bb.upper,
      h4BBlower: bb.lower,
      h4BBmid: bb.middle,
      h4BBwidth: bb.width,
      h4ST: supertrend(h4, 14, 1.75),
      dailyCloses: dc,
      dailyRSI: rsi(dc, 14),
    });
    loaded++;
  }
  console.log(`\nLoaded ${loaded} pairs\n`);

  // ─── Run all strategies ───────────────────────────────────────────
  const strategies: { name: string; desc: string; run: () => Trade[] }[] = [
    {
      name: "1. Fade the Fade",
      desc: "Supertrend flips + ADX<20 -> enter OPPOSITE. Exit 4 bars or ADX>25. SL 2%",
      run: () => strategy1FadeTheFade(pairDataMap),
    },
    {
      name: "2. BB Width Scalp",
      desc: "BB width < 20th pctile for 3+ bars -> fade band touch. TP: middle band. SL 1.5%",
      run: () => strategy2BBWidthScalp(pairDataMap),
    },
    {
      name: "3. Pair Spread MR",
      desc: "Top correlated pairs, trade spread z>2 divergence. BTC ADX<20 filter. Max 48h hold",
      run: () => strategy3PairSpreadMR(pairDataMap, btcH4, btcH4ADX, btcH4Map),
    },
    {
      name: "4. Funding Carry",
      desc: "Short top 3 volatile pairs (proxy funding), hold 7d. BTC ADX<20 filter. Pure carry",
      run: () => strategy4FundingCarry(pairDataMap, btcDaily, btcDailyADX, btcDailyMap),
    },
    {
      name: "5. Counter-Trend Scalp",
      desc: "Pair >2% move in 24h + BTC ADX<20 -> fade. TP 1%, SL 1.5%",
      run: () => strategy5CounterTrendScalp(pairDataMap, btcH4, btcH4ADX, btcH4Map),
    },
    {
      name: "6. Vol Contraction",
      desc: "ATR<20th pctile -> open BOTH long+short. TP 2% each. Winner moves loser to BE",
      run: () => strategy6VolContraction(pairDataMap),
    },
    {
      name: "7. Cross-Pair Rotation",
      desc: "Weekly: long oversold (RSI<30), short overbought (RSI>70). BTC ADX<20. Hold 3d",
      run: () => strategy7CrossPairRotation(pairDataMap, btcDaily, btcDailyADX, btcDailyMap),
    },
  ];

  console.log("=".repeat(95));
  console.log("  STRATEGY RESULTS");
  console.log("=".repeat(95));

  const results: { name: string; allStats: RegimeStats; byRegime: Map<Regime, RegimeStats> }[] = [];

  for (const strat of strategies) {
    console.log(`\n${"─".repeat(95)}`);
    console.log(`  ${strat.name}`);
    console.log(`  ${strat.desc}`);
    console.log(`${"─".repeat(95)}`);

    const allTrades = strat.run();
    const { all, byRegime } = computeRegimeStats(allTrades, months);
    results.push({ name: strat.name, allStats: all, byRegime });

    console.log("                     Trades  Wins    WR%       PnL       PF   Sharpe  $/day   Months");
    console.log("  " + "-".repeat(91));

    for (const regime of ["SIDEWAYS", "BULL", "BEAR"] as Regime[]) {
      const s = byRegime.get(regime)!;
      const wr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(1) : "  0.0";
      const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
      const pdStr = s.pnlPerDay >= 0 ? `+$${s.pnlPerDay.toFixed(2)}` : `-$${Math.abs(s.pnlPerDay).toFixed(2)}`;
      const tag = regime === "SIDEWAYS" ? " <-- target" : "";
      console.log(
        `  ${regime.padEnd(12)}  ${String(s.trades).padStart(6)}  ${String(s.wins).padStart(4)}  ${wr.padStart(5)}%  ${pnlStr.padStart(10)}  ${s.pf.toFixed(2).padStart(6)}  ${s.sharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(7)}  ${String(s.months).padStart(5)}${tag}`
      );
    }
    console.log("  " + "-".repeat(91));
    const wr = all.trades > 0 ? (all.wins / all.trades * 100).toFixed(1) : "  0.0";
    const pnlStr = all.pnl >= 0 ? `+$${all.pnl.toFixed(2)}` : `-$${Math.abs(all.pnl).toFixed(2)}`;
    const pdStr = all.pnlPerDay >= 0 ? `+$${all.pnlPerDay.toFixed(2)}` : `-$${Math.abs(all.pnlPerDay).toFixed(2)}`;
    console.log(
      `  ${"ALL".padEnd(12)}  ${String(all.trades).padStart(6)}  ${String(all.wins).padStart(4)}  ${wr.padStart(5)}%  ${pnlStr.padStart(10)}  ${all.pf.toFixed(2).padStart(6)}  ${all.sharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(7)}  ${String(all.months).padStart(5)}`
    );
  }

  // ─── Summary Ranking ─────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(95));
  console.log("  SIDEWAYS SPECIALIST RANKING (by $/day in SIDEWAYS months)");
  console.log("=".repeat(95));

  const ranked = results
    .map(r => ({
      name: r.name,
      side: r.byRegime.get("SIDEWAYS")!,
      all: r.allStats,
      bull: r.byRegime.get("BULL")!,
      bear: r.byRegime.get("BEAR")!,
    }))
    .sort((a, b) => b.side.pnlPerDay - a.side.pnlPerDay);

  console.log("\n  Rank  Strategy                           Side $/day   Side PF  Side Sharpe  All $/day   All PF  Verdict");
  console.log("  " + "-".repeat(110));

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const sidePd = r.side.pnlPerDay >= 0 ? `+$${r.side.pnlPerDay.toFixed(2)}` : `-$${Math.abs(r.side.pnlPerDay).toFixed(2)}`;
    const allPd = r.all.pnlPerDay >= 0 ? `+$${r.all.pnlPerDay.toFixed(2)}` : `-$${Math.abs(r.all.pnlPerDay).toFixed(2)}`;

    let verdict = "UNPROFITABLE";
    if (r.side.pnlPerDay > 0 && r.side.pf > 1.0) {
      if (r.all.pnlPerDay > 0) verdict = "VIABLE (sideways + overall)";
      else if (r.bull.pnl < -r.side.pnl) verdict = "RISKY (bleeds in trending)";
      else verdict = "SIDEWAYS ONLY";
    } else if (r.side.pnlPerDay > 0) {
      verdict = "MARGINAL";
    }

    console.log(
      `  ${String(i + 1).padStart(4)}  ${r.name.padEnd(35)}  ${sidePd.padStart(9)}  ${r.side.pf.toFixed(2).padStart(7)}  ${r.side.sharpe.toFixed(2).padStart(11)}  ${allPd.padStart(9)}  ${r.all.pf.toFixed(2).padStart(6)}  ${verdict}`
    );
  }

  // ─── Final verdict ───────────────────────────────────────────────
  console.log("\n" + "=".repeat(95));
  console.log("  CONCLUSION");
  console.log("=".repeat(95));

  const profitable = ranked.filter(r => r.side.pnlPerDay > 0 && r.side.pf > 1.0);
  if (profitable.length === 0) {
    console.log("\n  NO profitable sideways strategy found.");
    console.log("  All 7 creative approaches failed to generate consistent profit in sideways months.");
    console.log("  Recommendation: stay flat during sideways regimes.\n");
  } else {
    console.log(`\n  ${profitable.length} strategy(ies) show positive sideways performance:`);
    for (const r of profitable) {
      console.log(`    ${r.name}: $/day = ${r.side.pnlPerDay.toFixed(2)}, PF = ${r.side.pf.toFixed(2)}, Sharpe = ${r.side.sharpe.toFixed(2)}`);
    }
    const viable = profitable.filter(r => r.all.pnlPerDay > 0);
    if (viable.length > 0) {
      console.log(`\n  Of those, ${viable.length} also profitable overall (can run all regimes):`);
      for (const r of viable) {
        console.log(`    ${r.name}: ALL $/day = ${r.all.pnlPerDay.toFixed(2)}, ALL PF = ${r.all.pf.toFixed(2)}`);
      }
    } else {
      console.log("\n  HOWEVER, none are profitable overall (they bleed in trending markets).");
      console.log("  Would need regime-gating to use them.\n");
    }
  }
}

main();
