/**
 * Bear Market Strategy Optimization
 *
 * Tests 6 bear-specific strategies to beat GARCH v2 MTF baseline (+$9.26/mo in bear).
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-bear-optimize.ts
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
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// GARCH v2 MTF z-score params
const Z_LONG_1H = 4.5;
const Z_SHORT_1H = -3.0;
const Z_LONG_4H = 3.0;
const Z_SHORT_4H = -3.0;
const MOM_LB = 3;
const VOL_WIN = 20;
const SL_SLIP = 1.5;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
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
  return raw.map((b: any) => {
    if (Array.isArray(b)) {
      return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: 0 };
    }
    return { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) };
  }).sort((a: C, b: C) => a.t - b.t);
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
function calcEMA(values: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) v = values[i];
    else v = values[i] * k + v * (1 - k);
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function calcATR(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
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

function calcSupertrend(bars: Bar[], atrPeriod: number, mult: number): (1 | -1 | null)[] {
  const atrVals = calcATR(bars, atrPeriod);
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

function computeZScores(candles: Bar[]): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - MOM_LB].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - VOL_WIN + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

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
      months.push({ year: y, month: m + 1, start: mStart, end: mEnd, btcReturn: ret, regime });
    }

    m++;
    if (m >= 12) { m = 0; y++; }
    if (new Date(y, m, 1).getTime() > FULL_END) break;
  }
  return months;
}

// ─── Precomputed Pair Data ──────────────────────────────────────────
interface PairData {
  h1: Bar[];
  h4: Bar[];
  daily: Bar[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  h4Closes: number[];
  h4ATR: (number | null)[];
  h4ST_14_175: (1 | -1 | null)[];
  dailyCloses: number[];
  dailyHighs: number[];
  dailyATR: (number | null)[];
  h1ZScores: number[];
  h4ZScores: number[];
  h1Ema9: (number | null)[];
  h1Ema21: (number | null)[];
}

interface BTCData {
  daily: Bar[];
  h1: Bar[];
  h4: Bar[];
  dailyMap: Map<number, number>;
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  dailyCloses: number[];
  h1ZScores: number[];
  h1Ema9: (number | null)[];
  h1Ema21: (number | null)[];
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: Dir, notional: number = NOTIONAL): number {
  const spread = sp(pair);
  const entrySlip = ep * spread;
  const exitSlip = xp * spread;
  const fees = notional * FEE * 2;
  const raw = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return raw - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; wins: number; wr: number; pf: number;
  sharpe: number; maxDD: number; total: number; perDay: number;
}

function calcStats(trades: Trade[], startTs: number, endTs: number): Stats {
  if (trades.length === 0) return { trades: 0, wins: 0, wr: 0, pf: 0, sharpe: 0, maxDD: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const std = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;
  return {
    trades: trades.length, wins: wins.length,
    wr: wins.length / trades.length * 100,
    pf, sharpe, maxDD, total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Helper: find nearest BTC daily idx ─────────────────────────────
function btcDailyIdx(btc: BTCData, t: number): number {
  const aligned = Math.floor(t / DAY) * DAY;
  let idx = btc.dailyMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = DAY; dt <= 10 * DAY; dt += DAY) {
    idx = btc.dailyMap.get(aligned - dt);
    if (idx !== undefined) return idx;
  }
  return -1;
}

function btcBearish(btc: BTCData, t: number): boolean {
  const di = btcDailyIdx(btc, t - DAY);
  if (di < 0) return false;
  const e20 = btc.dailyEma20[di];
  const e50 = btc.dailyEma50[di];
  return e20 !== null && e50 !== null && e20 < e50;
}

// ─── Strategy 1: GARCH v2 MTF baseline ─────────────────────────────
// 1h z>4.5 + 4h z>3.0 for longs, 1h z<-3.0 + 4h z<-3.0 for shorts
// SL 3%, TP 7%, 96h max hold
function stratGarchV2MTF(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const SL_PCT = 0.03;
  const TP_PCT = 0.07;
  const MAX_HOLD = 96 * H1;

  // Iterate over all 1h timestamps across pairs
  const allTs = new Set<number>();
  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd) continue;
    for (const b of pd.h1) {
      if (b.t >= startTs && b.t < endTs) allTs.add(b.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  const open = new Map<string, { pair: string; dir: Dir; ep: number; et: number; sl: number; tp: number }>();

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // EXITS
    for (const [p, pos] of open) {
      const pd = pdm.get(p);
      if (!pd) continue;
      const bi = pd.h1Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.h1[bi];
      let xp = 0;

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl * (1 - sp(p) * SL_SLIP);
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl * (1 + sp(p) * SL_SLIP);
      }

      // TP check
      if (!xp) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          xp = pos.tp * (1 - sp(p));
        } else if (pos.dir === "short" && bar.l <= pos.tp) {
          xp = pos.tp * (1 + sp(p));
        }
      }

      // Max hold
      if (!xp && ts - pos.et >= MAX_HOLD) {
        xp = pos.dir === "long" ? bar.c * (1 - sp(p)) : bar.c * (1 + sp(p));
      }

      if (xp) {
        const pnl = tradePnl(p, pos.ep, xp, pos.dir);
        trades.push({ pair: p, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: ts, pnl });
        open.delete(p);
        closedThisBar.add(p);
      }
    }

    // ENTRIES
    for (const pair of pairs) {
      if (open.has(pair) || closedThisBar.has(pair)) continue;
      const pd = pdm.get(pair);
      if (!pd) continue;
      const bi = pd.h1Map.get(ts);
      if (bi === undefined || bi < VOL_WIN + MOM_LB + 1) continue;

      const prev = bi - 1; // anti-look-ahead
      const z1h = pd.h1ZScores[prev];
      if (isNaN(z1h) || z1h === 0) continue;

      const goLong = z1h > Z_LONG_1H;
      const goShort = z1h < Z_SHORT_1H;
      if (!goLong && !goShort) continue;

      // 4h z-score confirmation
      const ts4h = Math.floor(pd.h1[prev].t / H4) * H4;
      const idx4h = pd.h4Map.get(ts4h);
      if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
      const z4h = pd.h4ZScores[idx4h];
      if (goLong && z4h <= Z_LONG_4H) continue;
      if (goShort && z4h >= Z_SHORT_4H) continue;

      // EMA 9/21 filter on 1h
      const e9 = pd.h1Ema9[prev];
      const e21 = pd.h1Ema21[prev];
      if (e9 === null || e21 === null) continue;
      if (goLong && e9 <= e21) continue;
      if (goShort && e9 >= e21) continue;

      // BTC EMA(9) > EMA(21) on 1h for longs, < for shorts
      const btcBi = btc.h1Map.get(pd.h1[prev].t);
      if (btcBi === undefined || btcBi < 1) continue;
      const btcPrev = btcBi - 1;
      const be9 = btc.h1Ema9[btcPrev];
      const be21 = btc.h1Ema21[btcPrev];
      if (be9 === null || be21 === null) continue;
      if (goLong && be9 <= be21) continue;
      if (goShort && be9 >= be21) continue;

      const dir: Dir = goLong ? "long" : "short";
      const bar = pd.h1[bi];
      const ep = dir === "long" ? bar.o * (1 + sp(pair)) : bar.o * (1 - sp(pair));
      const sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
      const tp = dir === "long" ? ep * (1 + TP_PCT) : ep * (1 - TP_PCT);
      open.set(pair, { pair, dir, ep, et: ts, sl, tp });
    }
  }

  return trades;
}

// ─── Strategy 2: Short-Only Supertrend ──────────────────────────────
// Supertrend(14,1.75) + volume filter, ONLY shorts. No longs ever.
function stratShortOnlySupertrend(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd || pd.h4.length < 30) continue;

    const st = pd.h4ST_14_175;
    let pos: { ep: number; et: number } | null = null;

    for (let i = 1; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t > endTs && !pos) continue;

      const stNow = st[i - 1];
      const stPrev = i >= 2 ? st[i - 2] : null;

      // Exit: supertrend flips bullish (cover short)
      if (pos && stNow !== null && stNow === 1) {
        const xp = bar.o;
        const pnl = tradePnl(pair, pos.ep, xp, "short");
        if (pos.et >= startTs && pos.et < endTs) {
          trades.push({ pair, dir: "short", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
        }
        pos = null;
      }

      // Entry: supertrend flips bearish (short only)
      if (!pos && stNow === -1 && stPrev === 1 && bar.t >= startTs && bar.t < endTs) {
        // Volume filter: require above-average volume in last bar
        if (i >= 21) {
          let volSum = 0;
          for (let j = i - 20; j < i; j++) volSum += pd.h4[j].v;
          const avgVol = volSum / 20;
          if (pd.h4[i - 1].v < avgVol * 1.2) continue;
        }

        const ep = bar.o * (1 - sp(pair)); // short entry
        pos = { ep, et: bar.t };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = pd.h4[pd.h4.length - 1];
      const xp = lastBar.c;
      const pnl = tradePnl(pair, pos.ep, xp, "short");
      trades.push({ pair, dir: "short", ep: pos.ep, xp, et: pos.et, xt: lastBar.t, pnl });
    }
  }
  return trades;
}

// ─── Strategy 3: Inverse Alt Rotation ───────────────────────────────
// Every 3 days, SHORT bottom 5 pairs by 3-day return (weakest performers).
function stratInverseAltRotation(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const TOP_N = 5;

  // Collect all daily timestamps across pairs in range
  const dailyTs = new Set<number>();
  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd) continue;
    for (const b of pd.daily) {
      if (b.t >= startTs && b.t < endTs) dailyTs.add(b.t);
    }
  }
  const sortedDays = [...dailyTs].sort((a, b) => a - b);

  // Every 3 days, rank and short bottom 5
  for (let d = 0; d < sortedDays.length; d += 3) {
    const dayT = sortedDays[d];
    if (dayT < startTs || dayT >= endTs) continue;

    const ranked: { pair: string; ret: number }[] = [];
    for (const pair of pairs) {
      const pd = pdm.get(pair);
      if (!pd) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 4) continue;
      const ret3d = pd.dailyCloses[di - 1] / pd.dailyCloses[Math.max(0, di - 4)] - 1;
      ranked.push({ pair, ret: ret3d });
    }
    // Sort ascending: bottom performers first
    ranked.sort((a, b) => a.ret - b.ret);

    // Short bottom 5
    const bottomPairs = ranked.slice(0, TOP_N);
    for (const { pair } of bottomPairs) {
      const pd = pdm.get(pair)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;

      const ep = pd.daily[di].o * (1 - sp(pair)); // short entry
      const exitDi = Math.min(di + 3, pd.daily.length - 1);
      const xp = pd.daily[exitDi].c;
      const pnl = tradePnl(pair, ep, xp, "short");
      trades.push({ pair, dir: "short", ep, xp, et: dayT, xt: pd.daily[exitDi].t, pnl });
    }
  }

  return trades;
}

// ─── Strategy 4: Aggressive Short Momentum ──────────────────────────
// When a pair drops >3% in 24h AND BTC EMA20 < EMA50 daily, short.
// SL: 4%, hold 7 days max.
function stratAggressiveShortMomentum(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const SL_PCT = 0.04;
  const MAX_HOLD = 7 * DAY;
  const DROP_THRESH = -0.03; // >3% drop

  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd || pd.h4.length < 10) continue;

    let pos: { ep: number; et: number; sl: number } | null = null;

    for (let i = 7; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t > endTs && !pos) continue;

      // Manage position
      if (pos) {
        // SL check (short: price goes UP past SL)
        if (bar.h >= pos.sl) {
          const xp = pos.sl * (1 + sp(pair) * SL_SLIP);
          const pnl = tradePnl(pair, pos.ep, xp, "short");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "short", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }

        // Max hold exit
        if (bar.t - pos.et >= MAX_HOLD) {
          const xp = bar.o * (1 + sp(pair));
          const pnl = tradePnl(pair, pos.ep, xp, "short");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "short", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }
      }

      // Entry: 24h drop > 3% AND BTC bearish
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        // 24h return: 6 x 4h bars = 24h
        const ret24h = pd.h4Closes[i - 1] / pd.h4Closes[Math.max(0, i - 7)] - 1;
        if (ret24h > DROP_THRESH) continue; // not enough drop
        if (!btcBearish(btc, bar.t)) continue;

        const ep = bar.o * (1 - sp(pair));
        const sl = ep * (1 + SL_PCT);
        pos = { ep, et: bar.t, sl };
      }
    }

    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = pd.h4[pd.h4.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, "short");
      trades.push({ pair, dir: "short", ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl });
    }
  }
  return trades;
}

// ─── Strategy 5: Correlation Spike Short ────────────────────────────
// When average altcoin-BTC correlation > 0.8 (rolling 20-day, daily returns),
// short highest-beta alts. Concentrated panic selling = continuation.
function stratCorrelationSpikeShort(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const CORR_WINDOW = 20; // 20-day rolling correlation
  const CORR_THRESHOLD = 0.8;
  const TOP_BETA = 5;
  const HOLD_DAYS = 5;

  // Build daily return series for BTC and all pairs
  const btcReturns: Map<number, number> = new Map();
  for (let i = 1; i < btc.daily.length; i++) {
    btcReturns.set(btc.daily[i].t, btc.daily[i].c / btc.daily[i - 1].c - 1);
  }

  const pairReturns = new Map<string, Map<number, number>>();
  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd) continue;
    const ret = new Map<number, number>();
    for (let i = 1; i < pd.daily.length; i++) {
      ret.set(pd.daily[i].t, pd.daily[i].c / pd.daily[i - 1].c - 1);
    }
    pairReturns.set(pair, ret);
  }

  // Iterate daily
  const dailyTs = [...btcReturns.keys()].sort((a, b) => a - b);
  let lastTradeDay = 0;

  for (let d = CORR_WINDOW; d < dailyTs.length; d++) {
    const dayT = dailyTs[d];
    if (dayT < startTs || dayT >= endTs) continue;
    if (dayT - lastTradeDay < HOLD_DAYS * DAY) continue; // cooldown

    // Compute 20-day rolling correlation and beta for each pair vs BTC
    const window = dailyTs.slice(d - CORR_WINDOW, d);
    const btcRets = window.map(t => btcReturns.get(t) ?? 0);

    let corrSum = 0, corrCount = 0;
    const pairBetas: { pair: string; beta: number; corr: number }[] = [];

    for (const pair of pairs) {
      const pRets = pairReturns.get(pair);
      if (!pRets) continue;
      const altRets = window.map(t => pRets.get(t) ?? 0);

      // Pearson correlation
      const n = btcRets.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
      for (let k = 0; k < n; k++) {
        sumX += btcRets[k];
        sumY += altRets[k];
        sumXY += btcRets[k] * altRets[k];
        sumX2 += btcRets[k] * btcRets[k];
        sumY2 += altRets[k] * altRets[k];
      }
      const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      if (denom === 0) continue;
      const corr = (n * sumXY - sumX * sumY) / denom;

      // Beta = covariance / variance of BTC
      const varBTC = (n * sumX2 - sumX * sumX) / (n * n);
      const covXY = (n * sumXY - sumX * sumY) / (n * n);
      const beta = varBTC > 0 ? covXY / varBTC : 1;

      corrSum += corr;
      corrCount++;
      pairBetas.push({ pair, beta, corr });
    }

    if (corrCount === 0) continue;
    const avgCorr = corrSum / corrCount;

    // Only trade when avg correlation > threshold AND BTC is dropping
    if (avgCorr < CORR_THRESHOLD) continue;

    // Check BTC is bearish (EMA20 < EMA50)
    if (!btcBearish(btc, dayT)) continue;

    // Short highest-beta alts
    pairBetas.sort((a, b) => b.beta - a.beta);
    const topBeta = pairBetas.slice(0, TOP_BETA);

    for (const { pair } of topBeta) {
      const pd = pdm.get(pair);
      if (!pd) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;

      const ep = pd.daily[di].o * (1 - sp(pair));
      const exitDi = Math.min(di + HOLD_DAYS, pd.daily.length - 1);
      const xp = pd.daily[exitDi].c;
      const pnl = tradePnl(pair, ep, xp, "short");
      trades.push({ pair, dir: "short", ep, xp, et: dayT, xt: pd.daily[exitDi].t, pnl });
    }

    lastTradeDay = dayT;
  }

  return trades;
}

// ─── Strategy 6: Combined Short-Only ST + GARCH ────────────────────
// Run both simultaneously for more coverage.
function stratCombinedSTGarch(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const st = stratShortOnlySupertrend(pairs, pdm, btc, startTs, endTs);
  const garch = stratGarchV2MTF(pairs, pdm, btc, startTs, endTs);
  return [...st, ...garch];
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(90));
  console.log("  BEAR MARKET STRATEGY OPTIMIZATION");
  console.log("  Goal: beat GARCH v2 MTF baseline +$9.26/mo in bear months");
  console.log("=".repeat(90));

  // Load BTC
  console.log("\nLoading data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }

  const btcDaily = aggregate(btcRaw, DAY);
  const btcH1 = aggregate(btcRaw, H1);
  const btcH4 = aggregate(btcRaw, H4);
  const btcDailyCloses = btcDaily.map(b => b.c);
  const btcH1Closes = btcH1.map(b => b.c);
  const btc: BTCData = {
    daily: btcDaily,
    h1: btcH1,
    h4: btcH4,
    dailyMap: new Map(btcDaily.map((b, i) => [b.t, i])),
    h1Map: new Map(btcH1.map((b, i) => [b.t, i])),
    h4Map: new Map(btcH4.map((b, i) => [b.t, i])),
    dailyEma20: calcEMA(btcDailyCloses, 20),
    dailyEma50: calcEMA(btcDailyCloses, 50),
    dailyCloses: btcDailyCloses,
    h1ZScores: computeZScores(btcH1),
    h1Ema9: calcEMA(btcH1Closes, 9),
    h1Ema21: calcEMA(btcH1Closes, 21),
  };

  // Classify months
  const months = classifyMonths(btcDaily);
  const bullMonths = months.filter(m => m.regime === "BULL");
  const bearMonths = months.filter(m => m.regime === "BEAR");
  const sideMonths = months.filter(m => m.regime === "SIDEWAYS");

  console.log(`\nBTC monthly returns: ${months.length} months total`);
  console.log(`  BULL:     ${bullMonths.length} months`);
  console.log(`  BEAR:     ${bearMonths.length} months`);
  console.log(`  SIDEWAYS: ${sideMonths.length} months`);

  console.log("\n--- Month Classification ---");
  for (const m of months) {
    const tag = m.regime === "BULL" ? "+++" : m.regime === "BEAR" ? "---" : "   ";
    console.log(`  ${m.year}-${String(m.month).padStart(2, "0")}  BTC: ${(m.btcReturn * 100).toFixed(1).padStart(6)}%  ${tag} ${m.regime}`);
  }

  // Load pairs
  const pdm = new Map<string, PairData>();
  let loaded = 0;
  for (const pair of PAIRS) {
    const raw = load5m(pair);
    if (raw.length < 500) { console.log(`  Skip ${pair} (insufficient data)`); continue; }

    const h1 = aggregate(raw, H1);
    const h4 = aggregate(raw, H4);
    const daily = aggregate(raw, DAY);
    const h4c = h4.map(b => b.c);
    const h1c = h1.map(b => b.c);
    const dc = daily.map(b => b.c);
    const dh = daily.map(b => b.h);

    pdm.set(pair, {
      h1, h4, daily,
      h1Map: new Map(h1.map((b, i) => [b.t, i])),
      h4Map: new Map(h4.map((b, i) => [b.t, i])),
      dailyMap: new Map(daily.map((b, i) => [b.t, i])),
      h4Closes: h4c,
      h4ATR: calcATR(h4, 14),
      h4ST_14_175: calcSupertrend(h4, 14, 1.75),
      dailyCloses: dc,
      dailyHighs: dh,
      dailyATR: calcATR(daily, 14),
      h1ZScores: computeZScores(h1),
      h4ZScores: computeZScores(h4),
      h1Ema9: calcEMA(h1c, 9),
      h1Ema21: calcEMA(h1c, 21),
    });
    loaded++;
  }
  console.log(`\nLoaded ${loaded} pairs`);

  // ─── Run all strategies ─────────────────────────────────────────────
  interface StratResult {
    name: string;
    bullTrades: Trade[];
    bearTrades: Trade[];
    sideTrades: Trade[];
    allTrades: Trade[];
  }

  function filterByRegime(trades: Trade[], regimeMonths: MonthRegime[]): Trade[] {
    return trades.filter(t => regimeMonths.some(m => t.et >= m.start && t.et < m.end));
  }

  const strategies: { name: string; run: () => Trade[] }[] = [
    {
      name: "1. GARCH v2 MTF baseline (1h+4h z-score)",
      run: () => stratGarchV2MTF(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "2. Short-Only Supertrend(14,1.75) + vol",
      run: () => stratShortOnlySupertrend(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "3. Inverse Alt Rotation (bottom 5 by 3d ret)",
      run: () => stratInverseAltRotation(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "4. Aggressive Short Momentum (24h drop>3%)",
      run: () => stratAggressiveShortMomentum(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "5. Correlation Spike Short (top-beta)",
      run: () => stratCorrelationSpikeShort(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "6. Combined: Short-Only ST + GARCH",
      run: () => stratCombinedSTGarch(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
  ];

  const results: StratResult[] = [];

  console.log("\n" + "=".repeat(90));
  console.log("  STRATEGY RESULTS (regime breakdown)");
  console.log("=".repeat(90));

  for (const strat of strategies) {
    const allTrades = strat.run();
    const bullTrades = filterByRegime(allTrades, bullMonths);
    const bearTrades = filterByRegime(allTrades, bearMonths);
    const sideTrades = filterByRegime(allTrades, sideMonths);

    results.push({ name: strat.name, bullTrades, bearTrades, sideTrades, allTrades });

    console.log(`\n${"─".repeat(90)}`);
    console.log(`  ${strat.name}`);
    console.log(`${"─".repeat(90)}`);
    console.log("                 Trades  Wins    WR%      PF   Sharpe   $/day    MaxDD    Total");
    console.log("  " + "-".repeat(84));

    for (const [label, trs, regime] of [
      ["BEAR", bearTrades, bearMonths] as const,
      ["BULL", bullTrades, bullMonths] as const,
      ["SIDEWAYS", sideTrades, sideMonths] as const,
    ]) {
      let totalDays = 0;
      for (const m of regime) {
        totalDays += (Math.min(m.end, FULL_END) - m.start) / DAY;
      }
      const stats = calcStats(trs, FULL_START, FULL_END);
      const regimePerDay = totalDays > 0 ? stats.total / totalDays : 0;
      const tag = label === "BEAR" ? " <--" : "";
      const totalStr = stats.total >= 0 ? `+$${stats.total.toFixed(2)}` : `-$${Math.abs(stats.total).toFixed(2)}`;
      const pdStr = regimePerDay >= 0 ? `+$${regimePerDay.toFixed(2)}` : `-$${Math.abs(regimePerDay).toFixed(2)}`;
      console.log(`  ${label.padEnd(12)} ${String(stats.trades).padStart(6)}  ${String(stats.wins).padStart(4)}  ${stats.wr.toFixed(1).padStart(5)}%  ${stats.pf.toFixed(2).padStart(6)}  ${stats.sharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(7)}  $${stats.maxDD.toFixed(0).padStart(5)}  ${totalStr.padStart(10)}${tag}`);
    }

    const allStats = calcStats(allTrades, FULL_START, FULL_END);
    const totalStr = allStats.total >= 0 ? `+$${allStats.total.toFixed(2)}` : `-$${Math.abs(allStats.total).toFixed(2)}`;
    const pdStr = allStats.perDay >= 0 ? `+$${allStats.perDay.toFixed(2)}` : `-$${Math.abs(allStats.perDay).toFixed(2)}`;
    console.log("  " + "-".repeat(84));
    console.log(`  ${"ALL".padEnd(12)} ${String(allStats.trades).padStart(6)}  ${String(allStats.wins).padStart(4)}  ${allStats.wr.toFixed(1).padStart(5)}%  ${allStats.pf.toFixed(2).padStart(6)}  ${allStats.sharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(7)}  $${allStats.maxDD.toFixed(0).padStart(5)}  ${totalStr.padStart(10)}`);
  }

  // ─── Bear-Only Ranking ────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  BEAR MONTH RANKING (sorted by $/day in bear months)");
  console.log("=".repeat(90));

  let totalBearDays = 0;
  for (const m of bearMonths) {
    totalBearDays += (Math.min(m.end, FULL_END) - m.start) / DAY;
  }

  const ranked = results.map(r => {
    const bs = calcStats(r.bearTrades, FULL_START, FULL_END);
    const bullS = calcStats(r.bullTrades, FULL_START, FULL_END);
    const sideS = calcStats(r.sideTrades, FULL_START, FULL_END);
    const bearPerDay = totalBearDays > 0 ? bs.total / totalBearDays : 0;
    const bearPerMonth = bearMonths.length > 0 ? bs.total / bearMonths.length : 0;
    return {
      name: r.name,
      bearTrades: bs.trades,
      bearWR: bs.wr,
      bearPF: bs.pf,
      bearSharpe: bs.sharpe,
      bearPerDay,
      bearPerMonth,
      bearMaxDD: bs.maxDD,
      bearTotal: bs.total,
      bullTotal: bullS.total,
      sideTotal: sideS.total,
    };
  }).sort((a, b) => b.bearPerDay - a.bearPerDay);

  console.log(`\n  Total bear days: ${totalBearDays.toFixed(0)} across ${bearMonths.length} months\n`);
  console.log("  Rank  Strategy                                       Trades   WR%     PF   Sharpe  $/day   $/mo   MaxDD  Bull$  Side$");
  console.log("  " + "-".repeat(108));

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const medal = i === 0 ? " << BEST" : "";
    const pdStr = r.bearPerDay >= 0 ? `+${r.bearPerDay.toFixed(2)}` : `${r.bearPerDay.toFixed(2)}`;
    const pmStr = r.bearPerMonth >= 0 ? `+${r.bearPerMonth.toFixed(1)}` : `${r.bearPerMonth.toFixed(1)}`;
    const bullStr = r.bullTotal >= 0 ? `+${r.bullTotal.toFixed(0)}` : `${r.bullTotal.toFixed(0)}`;
    const sideStr = r.sideTotal >= 0 ? `+${r.sideTotal.toFixed(0)}` : `${r.sideTotal.toFixed(0)}`;
    console.log(`  ${String(i + 1).padStart(4)}  ${r.name.padEnd(47)}  ${String(r.bearTrades).padStart(5)}  ${r.bearWR.toFixed(1).padStart(5)}%  ${r.bearPF.toFixed(2).padStart(5)}  ${r.bearSharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(6)}  ${pmStr.padStart(5)}  $${r.bearMaxDD.toFixed(0).padStart(4)}  ${bullStr.padStart(5)}  ${sideStr.padStart(5)}${medal}`);
  }

  // ─── Per-Pair Breakdown for Top Strategy (in bear months) ─────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  PER-PAIR BREAKDOWN: TOP BEAR STRATEGY");
  console.log("=".repeat(90));

  // Find best strategy by bear $/day
  const bestIdx = results.findIndex(r => r.name === ranked[0].name);
  const bestResult = results[bestIdx];

  console.log(`\n  Strategy: ${bestResult.name}\n`);
  console.log("  Pair       Trades  Wins    WR%      PF    Total    $/trade");
  console.log("  " + "-".repeat(60));

  const pairStats: { pair: string; trades: number; wins: number; wr: number; pf: number; total: number }[] = [];
  for (const pair of PAIRS) {
    const pTrades = bestResult.bearTrades.filter(t => t.pair === pair);
    if (pTrades.length === 0) continue;
    const wins = pTrades.filter(t => t.pnl > 0);
    const grossP = wins.reduce((s, t) => s + t.pnl, 0);
    const grossL = Math.abs(pTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const total = pTrades.reduce((s, t) => s + t.pnl, 0);
    const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? 99 : 0);
    pairStats.push({ pair, trades: pTrades.length, wins: wins.length, wr: wins.length / pTrades.length * 100, pf, total });
  }
  pairStats.sort((a, b) => b.total - a.total);

  for (const ps of pairStats) {
    const totalStr = ps.total >= 0 ? `+$${ps.total.toFixed(2)}` : `-$${Math.abs(ps.total).toFixed(2)}`;
    const perTrade = ps.trades > 0 ? ps.total / ps.trades : 0;
    const ptStr = perTrade >= 0 ? `+$${perTrade.toFixed(2)}` : `-$${Math.abs(perTrade).toFixed(2)}`;
    console.log(`  ${ps.pair.padEnd(10)} ${String(ps.trades).padStart(5)}  ${String(ps.wins).padStart(4)}  ${ps.wr.toFixed(1).padStart(5)}%  ${ps.pf.toFixed(2).padStart(6)}  ${totalStr.padStart(8)}  ${ptStr.padStart(8)}`);
  }

  // ─── Per-Month Breakdown for Top Strategy ─────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  PER-MONTH BREAKDOWN: TOP BEAR STRATEGY (bear months only)");
  console.log("=".repeat(90));
  console.log(`\n  Strategy: ${bestResult.name}\n`);
  console.log("  Month      BTC%   Trades  Wins    WR%    Total");
  console.log("  " + "-".repeat(50));

  for (const m of bearMonths) {
    const mTrades = bestResult.bearTrades.filter(t => t.et >= m.start && t.et < m.end);
    const wins = mTrades.filter(t => t.pnl > 0);
    const total = mTrades.reduce((s, t) => s + t.pnl, 0);
    const totalStr = total >= 0 ? `+$${total.toFixed(2)}` : `-$${Math.abs(total).toFixed(2)}`;
    const wr = mTrades.length > 0 ? (wins.length / mTrades.length * 100).toFixed(1) : "  0.0";
    console.log(`  ${m.year}-${String(m.month).padStart(2, "0")}  ${(m.btcReturn * 100).toFixed(1).padStart(6)}%  ${String(mTrades.length).padStart(5)}  ${String(wins.length).padStart(4)}  ${String(wr).padStart(5)}%  ${totalStr.padStart(8)}`);
  }

  console.log("\n" + "=".repeat(90));
  console.log("  DONE");
  console.log("=".repeat(90));
}

main();
