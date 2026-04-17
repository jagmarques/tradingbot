/**
 * BTC Momentum Filter Optimization for Donchian + Supertrend Ensemble
 *
 * Tests 10 BTC filter variants (7 entry filters, 3 exit filters) on the
 * full Donchian SMA(20/50) $7 + Supertrend(14,1.75) $5 ensemble.
 *
 * 14 pairs, 2023-01 to 2026-03, OOS 2025-09+.
 * SMA-seeded ATR, doubled half-spreads, SL slippage 1.5x, proper look-ahead fix.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-btc-filter-optimize.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
  margin: number;
}

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const MAX_POS = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-23").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// Doubled half-spreads (conservative)
const SP: Record<string, number> = {
  XRP: 2.1e-4, DOGE: 2.7e-4, ARB: 5.2e-4, ENA: 5.1e-4,
  UNI: 5.5e-4, APT: 6.4e-4, LINK: 6.9e-4, TRUMP: 7.3e-4,
  WLD: 8e-4, DOT: 9.9e-4, ADA: 11.1e-4, LDO: 11.6e-4, OP: 12.4e-4,
  BTC: 1.0e-4, SOL: 4.0e-4,
};

const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
];

// Engine sizing
const DON_MARGIN = 7;
const DON_LEV = 10;
const DON_NOT = DON_MARGIN * DON_LEV;
const ST_MARGIN = 5;
const ST_LEV = 10;
const ST_NOT = ST_MARGIN * ST_LEV;

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars5m: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcRSI(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  if (period < closes.length) {
    avgGain /= period;
    avgLoss /= period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Donchian on CLOSES
function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}
function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

// Supertrend
function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      if (lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1]) { /* keep */ } else lowerBand = lb[i - 1];
      if (upperBand < ub[i - 1] || cs[i - 1].c > ub[i - 1]) { /* keep */ } else upperBand = ub[i - 1];
    }

    ub[i] = upperBand;
    lb[i] = lowerBand;

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

// ─── Cost model ─────────────────────────────────────────────────────
function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

function entryPx(pair: string, dir: Dir, raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPx(pair: string, dir: Dir, raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: Dir, ep: number, xp: number, notional: number): number {
  const raw = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return raw - notional * FEE * 2;
}

// ─── Load all data ──────────────────────────────────────────────────
console.log("Loading 5m candle data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) { raw5m.set(p, d); console.log(`  ${p}: ${d.length} bars`); }
  else console.log(`  ${p}: MISSING`);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, DAY, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
}
console.log("Aggregated: daily + 4h candles ready.\n");

// ─── BTC indicator pre-computation ──────────────────────────────────
const btcDaily = dailyData.get("BTC")!;
const btcDC = btcDaily.map(c => c.c);
const btcDailyEma20 = calcEMA(btcDC, 20);
const btcDailyEma50 = calcEMA(btcDC, 50);
const btcDailyEma9 = calcEMA(btcDC, 9);
const btcDailyEma21 = calcEMA(btcDC, 21);
const btcDailySma50 = calcSMA(btcDC, 50);
const btcDailyRsi14 = calcRSI(btcDC, 14);

// BTC 4h for faster EMA filter (config 7)
const btc4h = h4Data.get("BTC")!;
const btc4hC = btc4h.map(c => c.c);
const btc4hEma9 = calcEMA(btc4hC, 9);
const btc4hEma21 = calcEMA(btc4hC, 21);

// Helper: find last BTC daily bar index at or before t
function btcDailyIdx(t: number): number {
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) return i;
  }
  return -1;
}

// Helper: find last BTC 4h bar index at or before t
function btc4hIdx(t: number): number {
  for (let i = btc4h.length - 1; i >= 0; i--) {
    if (btc4h[i].t <= t) return i;
  }
  return -1;
}

// Helper: get BTC EMA values at a daily index, offset for array length diff.
// Use i-1 for look-ahead fix (< not <=)
function btcEma20At(dailyIdx: number): number {
  const off = btcDaily.length - btcDailyEma20.length;
  const j = dailyIdx - off;
  return j >= 0 && j < btcDailyEma20.length ? btcDailyEma20[j] : 0;
}
function btcEma50At(dailyIdx: number): number {
  const off = btcDaily.length - btcDailyEma50.length;
  const j = dailyIdx - off;
  return j >= 0 && j < btcDailyEma50.length ? btcDailyEma50[j] : 0;
}
function btcEma9dAt(dailyIdx: number): number {
  const off = btcDaily.length - btcDailyEma9.length;
  const j = dailyIdx - off;
  return j >= 0 && j < btcDailyEma9.length ? btcDailyEma9[j] : 0;
}
function btcEma21dAt(dailyIdx: number): number {
  const off = btcDaily.length - btcDailyEma21.length;
  const j = dailyIdx - off;
  return j >= 0 && j < btcDailyEma21.length ? btcDailyEma21[j] : 0;
}
function btcSma50At(dailyIdx: number): number {
  return dailyIdx >= 49 ? btcDailySma50[dailyIdx] : 0;
}
function btcRsi14At(dailyIdx: number): number {
  return dailyIdx >= 14 ? btcDailyRsi14[dailyIdx] : 50;
}
function btc4hEma9At(idx: number): number {
  const off = btc4h.length - btc4hEma9.length;
  const j = idx - off;
  return j >= 0 && j < btc4hEma9.length ? btc4hEma9[j] : 0;
}
function btc4hEma21At(idx: number): number {
  const off = btc4h.length - btc4hEma21.length;
  const j = idx - off;
  return j >= 0 && j < btc4hEma21.length ? btc4hEma21[j] : 0;
}

// ─── BTC filter configuration ───────────────────────────────────────
// Return: "allow" | "block" for a given direction at time t
// entryFilter returns true if trade is ALLOWED
type EntryFilter = (dir: Dir, t: number) => boolean;
// exitFilter returns true if position should be FORCE-CLOSED
type ExitFilter = (dir: Dir, t: number, entryTime: number) => boolean;

interface FilterConfig {
  name: string;
  entryFilter: EntryFilter;
  exitFilter: ExitFilter;
}

const FILTERS: FilterConfig[] = [
  {
    // 1. Baseline: BTC daily EMA(20) > EMA(50) for longs, shorts always allowed
    name: "1. Baseline EMA20/50",
    entryFilter: (dir, t) => {
      if (dir === "short") return true;
      const idx = btcDailyIdx(t);
      if (idx < 1) return false;
      // look-ahead fix: use i-1 (the COMPLETED bar)
      const e20 = btcEma20At(idx - 1);
      const e50 = btcEma50At(idx - 1);
      if (e20 === 0 || e50 === 0) return false;
      return e20 > e50; // strict >
    },
    exitFilter: () => false,
  },
  {
    // 2. BTC 7-day momentum > 0% for longs only
    name: "2. BTC 7d mom > 0",
    entryFilter: (dir, t) => {
      if (dir === "short") return true;
      const idx = btcDailyIdx(t);
      if (idx < 7) return false;
      const ret7d = btcDC[idx - 1] / btcDC[idx - 8] - 1; // completed bar
      return ret7d > 0;
    },
    exitFilter: () => false,
  },
  {
    // 3. BTC 30-day momentum > 0% for longs only
    name: "3. BTC 30d mom > 0",
    entryFilter: (dir, t) => {
      if (dir === "short") return true;
      const idx = btcDailyIdx(t);
      if (idx < 30) return false;
      const ret30d = btcDC[idx - 1] / btcDC[idx - 31] - 1;
      return ret30d > 0;
    },
    exitFilter: () => false,
  },
  {
    // 4. BTC RSI(14) daily: longs when RSI > 50, shorts when RSI < 50
    name: "4. BTC RSI>50/<50",
    entryFilter: (dir, t) => {
      const idx = btcDailyIdx(t);
      if (idx < 15) return false;
      const rsi = btcRsi14At(idx - 1); // completed bar
      if (dir === "long") return rsi > 50;
      return rsi < 50;
    },
    exitFilter: () => false,
  },
  {
    // 5. BTC above/below 50-day SMA: longs above, shorts below
    name: "5. BTC SMA50 gate",
    entryFilter: (dir, t) => {
      const idx = btcDailyIdx(t);
      if (idx < 50) return false;
      const price = btcDC[idx - 1]; // completed bar close
      const sma = btcSma50At(idx - 1);
      if (sma === 0) return false;
      if (dir === "long") return price > sma;
      return price < sma;
    },
    exitFilter: () => false,
  },
  {
    // 6. BOTH directions filtered: longs EMA20>50, shorts EMA20<50
    name: "6. Both dir EMA20/50",
    entryFilter: (dir, t) => {
      const idx = btcDailyIdx(t);
      if (idx < 1) return false;
      const e20 = btcEma20At(idx - 1);
      const e50 = btcEma50At(idx - 1);
      if (e20 === 0 || e50 === 0) return false;
      if (dir === "long") return e20 > e50;
      return e20 < e50; // shorts only when bearish
    },
    exitFilter: () => false,
  },
  {
    // 7. Stricter: BTC EMA(9) > EMA(21) on 4h for longs, shorts always
    name: "7. BTC 4h EMA9/21",
    entryFilter: (dir, t) => {
      if (dir === "short") return true;
      const idx = btc4hIdx(t);
      if (idx < 1) return false;
      const e9 = btc4hEma9At(idx - 1);
      const e21 = btc4hEma21At(idx - 1);
      if (e9 === 0 || e21 === 0) return false;
      return e9 > e21;
    },
    exitFilter: () => false,
  },
  {
    // 8. EXIT: exit longs on BTC daily EMA(20) death cross
    name: "8. Exit long death-X",
    entryFilter: (dir, t) => {
      // Same as baseline entry filter
      if (dir === "short") return true;
      const idx = btcDailyIdx(t);
      if (idx < 1) return false;
      const e20 = btcEma20At(idx - 1);
      const e50 = btcEma50At(idx - 1);
      if (e20 === 0 || e50 === 0) return false;
      return e20 > e50;
    },
    exitFilter: (dir, t) => {
      if (dir === "short") return false;
      const idx = btcDailyIdx(t);
      if (idx < 2) return false;
      // Death cross: EMA20 was >= EMA50 yesterday, now <
      const e20prev = btcEma20At(idx - 2);
      const e50prev = btcEma50At(idx - 2);
      const e20cur = btcEma20At(idx - 1);
      const e50cur = btcEma50At(idx - 1);
      if (e20prev === 0 || e50prev === 0 || e20cur === 0 || e50cur === 0) return false;
      return e20prev >= e50prev && e20cur < e50cur;
    },
  },
  {
    // 9. EXIT: all positions when BTC drops >5% in 24h
    name: "9. Exit all BTC -5%/24h",
    entryFilter: (dir, t) => {
      // Same as baseline for entry
      if (dir === "short") return true;
      const idx = btcDailyIdx(t);
      if (idx < 1) return false;
      const e20 = btcEma20At(idx - 1);
      const e50 = btcEma50At(idx - 1);
      if (e20 === 0 || e50 === 0) return false;
      return e20 > e50;
    },
    exitFilter: (_dir, t) => {
      const idx = btcDailyIdx(t);
      if (idx < 1) return false;
      // BTC drop >5% from yesterday close
      const ret = btcDC[idx] / btcDC[idx - 1] - 1;
      return ret < -0.05;
    },
  },
  {
    // 10. EXIT: exit longs when BTC 7d return turns negative
    name: "10. Exit long 7d<0",
    entryFilter: (dir, t) => {
      // Same as baseline
      if (dir === "short") return true;
      const idx = btcDailyIdx(t);
      if (idx < 1) return false;
      const e20 = btcEma20At(idx - 1);
      const e50 = btcEma50At(idx - 1);
      if (e20 === 0 || e50 === 0) return false;
      return e20 > e50;
    },
    exitFilter: (dir, t) => {
      if (dir === "short") return false;
      const idx = btcDailyIdx(t);
      if (idx < 8) return false;
      const ret7d = btcDC[idx - 1] / btcDC[idx - 8] - 1;
      return ret7d < 0;
    },
  },
];

// ─── Engine A: Daily Donchian SMA(20/50) ─────────────────────────────
interface Signal {
  pair: string; engine: string; dir: Dir; ep: number; et: number;
  sl: number; maxHold: number; margin: number; notional: number;
  // Donchian-specific exit state
  donchExit?: { dailyCs: C[]; exitLb: number };
  // Supertrend-specific exit state
  stExit?: { h4Cs: C[]; stDir: number[]; entryBarIdx: number };
}

function generateSignalsA(startTs: number, endTs: number, entryFilter: EntryFilter): Signal[] {
  const signals: Signal[] = [];
  const SMA_FAST = 20, SMA_SLOW = 50, EXIT_LB = 15;
  const ATR_MULT = 3, ATR_PER = 14, MAX_HOLD = 60 * DAY;

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < SMA_SLOW + ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, SMA_FAST);
    const slow = calcSMA(closes, SMA_SLOW);
    const atrArr = calcATR(cs, ATR_PER);
    const warmup = SMA_SLOW + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < startTs || bar.t >= endTs) continue;

      // Look-ahead fix: use i-2 and i-1 for cross detection (completed bars)
      const prev2 = i - 2;
      const prev1 = i - 1;
      if (prev2 < 0) continue;
      const prevFast = fast[prev2];
      const prevSlow = slow[prev2];
      const curFast = fast[prev1];
      const curSlow = slow[prev1];
      if (prevFast === 0 || prevSlow === 0 || curFast === 0 || curSlow === 0) continue;

      let dir: Dir | null = null;
      if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
      else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
      if (!dir) continue;

      // BTC entry filter
      if (!entryFilter(dir, bar.t)) continue;

      const prevATR = atrArr[i - 1];
      if (prevATR <= 0) continue;

      const ep = entryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
      // Cap at 3.5%
      if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
      else sl = Math.min(sl, ep * (1 + 0.035));

      signals.push({
        pair, engine: "A", dir, ep, et: bar.t, sl,
        maxHold: MAX_HOLD, margin: DON_MARGIN, notional: DON_NOT,
        donchExit: { dailyCs: cs, exitLb: EXIT_LB },
      });
    }
  }
  return signals;
}

// ─── Engine B: 4h Supertrend(14,1.75) ────────────────────────────────
function generateSignalsB(startTs: number, endTs: number, entryFilter: EntryFilter): Signal[] {
  const signals: Signal[] = [];
  const ST_PER = 14, ST_MULT = 1.75;
  const ATR_MULT = 3, MAX_HOLD = 60 * DAY;

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_PER + 30) continue;

    const { dir: stDir } = calcSupertrend(cs, ST_PER, ST_MULT);
    const atrArr = calcATR(cs, ST_PER);

    for (let i = ST_PER + 2; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < startTs || bar.t >= endTs) continue;

      // Detect flip on completed bar: stDir[i-1] != stDir[i-2]
      const prevDir = stDir[i - 1];
      const prevPrevDir = stDir[i - 2];
      if (prevDir === prevPrevDir) continue;

      const dir: Dir = prevDir === 1 ? "long" : "short";

      // BTC entry filter
      if (!entryFilter(dir, bar.t)) continue;

      const prevATR = atrArr[i - 1];
      if (prevATR <= 0) continue;

      const ep = entryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
      if (dir === "long") sl = Math.max(sl, ep * (1 - 0.035));
      else sl = Math.min(sl, ep * (1 + 0.035));

      signals.push({
        pair, engine: "B", dir, ep, et: bar.t, sl,
        maxHold: MAX_HOLD, margin: ST_MARGIN, notional: ST_NOT,
        stExit: { h4Cs: cs, stDir, entryBarIdx: i },
      });
    }
  }
  return signals;
}

// ─── Ensemble simulation with exit filters ──────────────────────────
interface SimResult {
  trades: Trade[];
  blocked: number;
  exitForced: number;
}

function simulateEnsemble(
  startTs: number, endTs: number,
  filter: FilterConfig,
): SimResult {
  const sigA = generateSignalsA(startTs, endTs, filter.entryFilter);
  const sigB = generateSignalsB(startTs, endTs, filter.entryFilter);

  // For each signal, we need to simulate its lifetime (entry -> exit)
  // to produce trades, then merge with position cap and exit filter.
  // Actually, we need a more careful approach: simulate pair-by-pair
  // for each engine (since each pair can only have 1 position at a time
  // per engine), then apply position cap and exit filter on the merged timeline.

  // Step 1: For each engine, simulate exits independently per pair.
  function resolveSignals(signals: Signal[]): Trade[] {
    const trades: Trade[] = [];

    // Group by pair+engine
    const grouped = new Map<string, Signal[]>();
    for (const sig of signals) {
      const key = `${sig.engine}:${sig.pair}`;
      let arr = grouped.get(key);
      if (!arr) { arr = []; grouped.set(key, arr); }
      arr.push(sig);
    }

    for (const [, sigs] of grouped) {
      sigs.sort((a, b) => a.et - b.et);
      let posEnd = 0; // time the current position ends

      for (const sig of sigs) {
        if (sig.et < posEnd) continue; // skip overlapping

        // Find exit
        let xp = 0, xt = 0, isSL = false;

        if (sig.donchExit) {
          // Engine A: daily bars
          const cs = sig.donchExit.dailyCs;
          const exitLb = sig.donchExit.exitLb;
          // Find bar index of entry
          let entryIdx = -1;
          for (let i = 0; i < cs.length; i++) {
            if (cs[i].t === sig.et) { entryIdx = i; break; }
          }
          if (entryIdx < 0) continue;

          for (let i = entryIdx + 1; i < cs.length; i++) {
            const bar = cs[i];

            // SL
            if (sig.dir === "long" && bar.l <= sig.sl) {
              xp = sig.sl; xt = bar.t; isSL = true; break;
            }
            if (sig.dir === "short" && bar.h >= sig.sl) {
              xp = sig.sl; xt = bar.t; isSL = true; break;
            }

            // Donchian channel exit
            if (i >= exitLb + 1) {
              if (sig.dir === "long") {
                const chanLow = donchCloseLow(cs, i, exitLb);
                if (bar.c < chanLow) { xp = bar.c; xt = bar.t; break; }
              } else {
                const chanHigh = donchCloseHigh(cs, i, exitLb);
                if (bar.c > chanHigh) { xp = bar.c; xt = bar.t; break; }
              }
            }

            // Max hold
            if (bar.t - sig.et >= sig.maxHold) {
              xp = bar.c; xt = bar.t; break;
            }
          }
        } else if (sig.stExit) {
          // Engine B: 4h bars
          const cs = sig.stExit.h4Cs;
          const stDir = sig.stExit.stDir;
          const entryIdx = sig.stExit.entryBarIdx;

          for (let i = entryIdx + 1; i < cs.length; i++) {
            const bar = cs[i];

            // SL
            if (sig.dir === "long" && bar.l <= sig.sl) {
              xp = sig.sl; xt = bar.t; isSL = true; break;
            }
            if (sig.dir === "short" && bar.h >= sig.sl) {
              xp = sig.sl; xt = bar.t; isSL = true; break;
            }

            // Supertrend flip exit
            if (stDir[i - 1] !== stDir[i - 2]) {
              xp = bar.o; xt = bar.t; break;
            }

            // Max hold
            if (bar.t - sig.et >= sig.maxHold) {
              xp = bar.c; xt = bar.t; break;
            }
          }
        }

        if (xp > 0 && xt > 0) {
          const xpAdj = exitPx(sig.pair, sig.dir, xp, isSL);
          const pnl = calcPnl(sig.dir, sig.ep, xpAdj, sig.notional);
          trades.push({
            pair: sig.pair, engine: sig.engine, dir: sig.dir,
            ep: sig.ep, xp: xpAdj, et: sig.et, xt,
            pnl, margin: sig.margin,
          });
          posEnd = xt;
        }
      }
    }
    return trades;
  }

  const rawA = resolveSignals(sigA);
  const rawB = resolveSignals(sigB);

  // Step 2: Merge with position cap + exit filter
  interface Event {
    t: number;
    type: "entry" | "exit";
    trade: Trade;
  }

  const events: Event[] = [];
  for (const tr of [...rawA, ...rawB]) {
    events.push({ t: tr.et, type: "entry", trade: tr });
    events.push({ t: tr.xt, type: "exit", trade: tr });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPositions = new Map<string, Trade>();
  const accepted: Trade[] = [];
  let blocked = 0;
  let exitForced = 0;

  // Track unique daily timestamps for exit filter checks
  // We need to check exit filter on each timestamp
  for (const evt of events) {
    // Check exit filter on all open positions at this time
    const toClose: string[] = [];
    for (const [key, pos] of openPositions) {
      if (filter.exitFilter(pos.dir, evt.t, pos.et)) {
        toClose.push(key);
      }
    }
    for (const key of toClose) {
      const pos = openPositions.get(key)!;
      // Force close at current time - find the closing price
      // We already have the trade with its natural exit, but we need to
      // modify it. Since the trade was already accepted, we need to
      // adjust its exit. Actually, the exit filter should truncate the trade.
      // For simplicity: we mark it as force-closed and it gets removed from
      // open positions. The natural exit event will be ignored.
      openPositions.delete(key);
      exitForced++;
    }

    if (evt.type === "exit") {
      const key = `${evt.trade.engine}:${evt.trade.pair}`;
      if (openPositions.has(key)) {
        openPositions.delete(key);
      }
    } else {
      const key = `${evt.trade.engine}:${evt.trade.pair}`;
      if (openPositions.has(key)) continue;
      if (openPositions.size >= MAX_POS) {
        blocked++;
        continue;
      }
      // Also check if exit filter would immediately trigger
      if (filter.exitFilter(evt.trade.dir, evt.t, evt.trade.et)) {
        blocked++;
        continue;
      }
      openPositions.set(key, evt.trade);
      accepted.push(evt.trade);
    }
  }

  return { trades: accepted, blocked, exitForced };
}

// For exit-filter configs (8,9,10), we need a different approach:
// actually simulate the trades and check if exit filter triggers DURING the trade,
// which would cause early exit. Let me rebuild with a proper per-bar simulation.

function simulateWithExitFilter(
  startTs: number, endTs: number,
  filter: FilterConfig,
): SimResult {
  const sigA = generateSignalsA(startTs, endTs, filter.entryFilter);
  const sigB = generateSignalsB(startTs, endTs, filter.entryFilter);

  // Collect all unique daily timestamps for exit filter checking
  const allDailyTs = btcDaily.filter(c => c.t >= startTs && c.t <= endTs).map(c => c.t);

  // We'll use a timeline approach: for each entry signal, check at each daily bar
  // if the exit filter triggers, and if so, close early.

  function resolveWithExitFilter(signals: Signal[]): Trade[] {
    const trades: Trade[] = [];
    const grouped = new Map<string, Signal[]>();
    for (const sig of signals) {
      const key = `${sig.engine}:${sig.pair}`;
      let arr = grouped.get(key);
      if (!arr) { arr = []; grouped.set(key, arr); }
      arr.push(sig);
    }

    for (const [, sigs] of grouped) {
      sigs.sort((a, b) => a.et - b.et);
      let posEnd = 0;

      for (const sig of sigs) {
        if (sig.et < posEnd) continue;

        let xp = 0, xt = 0, isSL = false;

        if (sig.donchExit) {
          const cs = sig.donchExit.dailyCs;
          const exitLb = sig.donchExit.exitLb;
          let entryIdx = -1;
          for (let i = 0; i < cs.length; i++) {
            if (cs[i].t === sig.et) { entryIdx = i; break; }
          }
          if (entryIdx < 0) continue;

          for (let i = entryIdx + 1; i < cs.length; i++) {
            const bar = cs[i];

            // Check exit filter BEFORE normal exits (it fires at start of day)
            if (filter.exitFilter(sig.dir, bar.t, sig.et)) {
              xp = bar.o; xt = bar.t; break; // Exit at open
            }

            if (sig.dir === "long" && bar.l <= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }
            if (sig.dir === "short" && bar.h >= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }

            if (i >= exitLb + 1) {
              if (sig.dir === "long") {
                const chanLow = donchCloseLow(cs, i, exitLb);
                if (bar.c < chanLow) { xp = bar.c; xt = bar.t; break; }
              } else {
                const chanHigh = donchCloseHigh(cs, i, exitLb);
                if (bar.c > chanHigh) { xp = bar.c; xt = bar.t; break; }
              }
            }

            if (bar.t - sig.et >= sig.maxHold) { xp = bar.c; xt = bar.t; break; }
          }
        } else if (sig.stExit) {
          const cs = sig.stExit.h4Cs;
          const stDir = sig.stExit.stDir;
          const entryIdx = sig.stExit.entryBarIdx;

          for (let i = entryIdx + 1; i < cs.length; i++) {
            const bar = cs[i];

            // Check exit filter
            if (filter.exitFilter(sig.dir, bar.t, sig.et)) {
              xp = bar.o; xt = bar.t; break;
            }

            if (sig.dir === "long" && bar.l <= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }
            if (sig.dir === "short" && bar.h >= sig.sl) { xp = sig.sl; xt = bar.t; isSL = true; break; }

            if (i >= 2 && stDir[i - 1] !== stDir[i - 2]) { xp = bar.o; xt = bar.t; break; }

            if (bar.t - sig.et >= sig.maxHold) { xp = bar.c; xt = bar.t; break; }
          }
        }

        if (xp > 0 && xt > 0) {
          const xpAdj = exitPx(sig.pair, sig.dir, xp, isSL);
          const pnl = calcPnl(sig.dir, sig.ep, xpAdj, sig.notional);
          trades.push({
            pair: sig.pair, engine: sig.engine, dir: sig.dir,
            ep: sig.ep, xp: xpAdj, et: sig.et, xt,
            pnl, margin: sig.margin,
          });
          posEnd = xt;
        }
      }
    }
    return trades;
  }

  const rawA = resolveWithExitFilter(sigA);
  const rawB = resolveWithExitFilter(sigB);

  // Apply position cap
  interface Event {
    t: number;
    type: "entry" | "exit";
    trade: Trade;
  }

  const events: Event[] = [];
  for (const tr of [...rawA, ...rawB]) {
    events.push({ t: tr.et, type: "entry", trade: tr });
    events.push({ t: tr.xt, type: "exit", trade: tr });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPositions = new Map<string, Trade>();
  const accepted: Trade[] = [];
  let blocked = 0;
  let exitForced = 0;

  for (const evt of events) {
    if (evt.type === "exit") {
      const key = `${evt.trade.engine}:${evt.trade.pair}`;
      if (openPositions.has(key)) openPositions.delete(key);
    } else {
      const key = `${evt.trade.engine}:${evt.trade.pair}`;
      if (openPositions.has(key)) continue;
      if (openPositions.size >= MAX_POS) { blocked++; continue; }
      openPositions.set(key, evt.trade);
      accepted.push(evt.trade);
    }
  }

  return { trades: accepted, blocked, exitForced };
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

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
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = Math.max((endTs - startTs) / DAY, 1);

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe, dd: maxDD, total,
    perDay: total / days,
  };
}

// ─── RUN ALL CONFIGS ────────────────────────────────────────────────
console.log("=" .repeat(130));
console.log("BTC MOMENTUM FILTER OPTIMIZATION - Donchian SMA(20/50) $7 + Supertrend(14,1.75) $5");
console.log("14 pairs | 2023-01 to 2026-03 | OOS 2025-09+ | Doubled spreads, 0.035% fee, 1.5x SL slip");
console.log("SMA ATR, i-1/i-2 look-ahead fix, BTC filter uses strict > (not >=)");
console.log("=".repeat(130));

interface Result {
  name: string;
  fullM: Metrics;
  oosM: Metrics;
  blocked: number;
  exitForced: number;
  longsF: number;
  shortsF: number;
  longsOOS: number;
  shortsOOS: number;
}

const results: Result[] = [];

for (const filter of FILTERS) {
  process.stdout.write(`  Running: ${filter.name}...`);

  // Full period
  const fullSim = simulateWithExitFilter(FULL_START, FULL_END, filter);
  const fullM = calcMetrics(fullSim.trades, FULL_START, FULL_END);

  // OOS only
  const oosSim = simulateWithExitFilter(OOS_START, FULL_END, filter);
  const oosM = calcMetrics(oosSim.trades, OOS_START, FULL_END);

  const longsF = fullSim.trades.filter(t => t.dir === "long").length;
  const shortsF = fullSim.trades.filter(t => t.dir === "short").length;
  const longsOOS = oosSim.trades.filter(t => t.dir === "long").length;
  const shortsOOS = oosSim.trades.filter(t => t.dir === "short").length;

  results.push({
    name: filter.name,
    fullM, oosM,
    blocked: fullSim.blocked, exitForced: fullSim.exitForced,
    longsF, shortsF, longsOOS, shortsOOS,
  });

  console.log(` ${fullM.n} trades, $${fullM.perDay.toFixed(2)}/day`);
}

// ─── Print comparison table sorted by $/day ─────────────────────────
console.log("\n" + "=".repeat(145));
console.log("COMPARISON TABLE (sorted by full-period $/day)");
console.log("=".repeat(145));

function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }

console.log(
  `${"Filter".padEnd(28)} ${"N".padStart(5)}  ${"$/day".padStart(8)}  ${"MaxDD".padStart(8)}  ` +
  `${"WR%".padStart(6)}  ${"PF".padStart(6)}  ${"Sharpe".padStart(7)}  ` +
  `${"L/S".padStart(8)}  ${"Blckd".padStart(6)}  ` +
  `${"OOS$/d".padStart(8)}  ${"OOS-N".padStart(6)}  ${"OOS-WR".padStart(7)}  ${"OOS-PF".padStart(7)}  ${"OOS-L/S".padStart(8)}`
);
console.log("-".repeat(145));

results.sort((a, b) => b.fullM.perDay - a.fullM.perDay);

for (const r of results) {
  console.log(
    `${r.name.padEnd(28)} ` +
    `${String(r.fullM.n).padStart(5)}  ` +
    `${fmtPnl(r.fullM.perDay).padStart(8)}  ` +
    `$${r.fullM.dd.toFixed(0).padStart(7)}  ` +
    `${r.fullM.wr.toFixed(1).padStart(6)}  ` +
    `${r.fullM.pf.toFixed(2).padStart(6)}  ` +
    `${r.fullM.sharpe.toFixed(2).padStart(7)}  ` +
    `${(r.longsF + "/" + r.shortsF).padStart(8)}  ` +
    `${String(r.blocked).padStart(6)}  ` +
    `${fmtPnl(r.oosM.perDay).padStart(8)}  ` +
    `${String(r.oosM.n).padStart(6)}  ` +
    `${r.oosM.wr.toFixed(1).padStart(7)}  ` +
    `${r.oosM.pf.toFixed(2).padStart(7)}  ` +
    `${(r.longsOOS + "/" + r.shortsOOS).padStart(8)}`
  );
}

// ─── Detailed view: entry vs exit filters ───────────────────────────
console.log("\n" + "=".repeat(100));
console.log("ENTRY FILTERS (1-7) vs EXIT FILTERS (8-10) DETAIL");
console.log("=".repeat(100));

console.log("\n--- ENTRY FILTERS (modify which trades are taken) ---\n");
const entryResults = results.filter(r => r.name.match(/^[1-7]/));
entryResults.sort((a, b) => b.fullM.perDay - a.fullM.perDay);
for (const r of entryResults) {
  const baseline = results.find(x => x.name.startsWith("1."))!;
  const deltaPd = r.fullM.perDay - baseline.fullM.perDay;
  const deltaDD = r.fullM.dd - baseline.fullM.dd;
  const deltaN = r.fullM.n - baseline.fullM.n;
  console.log(
    `${r.name.padEnd(28)} $/day=${fmtPnl(r.fullM.perDay).padStart(8)} ` +
    `DD=$${r.fullM.dd.toFixed(0).padStart(5)} PF=${r.fullM.pf.toFixed(2)} ` +
    `WR=${r.fullM.wr.toFixed(1)}% Sharpe=${r.fullM.sharpe.toFixed(2)} ` +
    `N=${r.fullM.n} ` +
    `[vs base: ${deltaPd >= 0 ? "+" : ""}$${deltaPd.toFixed(2)}/day, ` +
    `${deltaDD >= 0 ? "+" : ""}$${deltaDD.toFixed(0)} DD, ` +
    `${deltaN >= 0 ? "+" : ""}${deltaN} trades]`
  );
}

console.log("\n--- EXIT FILTERS (force-close positions on BTC signal) ---\n");
const exitResults = results.filter(r => r.name.match(/^(8|9|10)/));
exitResults.sort((a, b) => b.fullM.perDay - a.fullM.perDay);
for (const r of exitResults) {
  const baseline = results.find(x => x.name.startsWith("1."))!;
  const deltaPd = r.fullM.perDay - baseline.fullM.perDay;
  const deltaDD = r.fullM.dd - baseline.fullM.dd;
  console.log(
    `${r.name.padEnd(28)} $/day=${fmtPnl(r.fullM.perDay).padStart(8)} ` +
    `DD=$${r.fullM.dd.toFixed(0).padStart(5)} PF=${r.fullM.pf.toFixed(2)} ` +
    `WR=${r.fullM.wr.toFixed(1)}% Sharpe=${r.fullM.sharpe.toFixed(2)} ` +
    `ExitForced=${r.exitForced} ` +
    `[vs base: ${deltaPd >= 0 ? "+" : ""}$${deltaPd.toFixed(2)}/day, ` +
    `${deltaDD >= 0 ? "+" : ""}$${deltaDD.toFixed(0)} DD]`
  );
}

// ─── OOS stability check ────────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("OOS STABILITY (2025-09 to 2026-03) - sorted by OOS $/day");
console.log("=".repeat(100));

results.sort((a, b) => b.oosM.perDay - a.oosM.perDay);
console.log(
  `${"Filter".padEnd(28)} ${"OOS $/day".padStart(10)}  ${"OOS DD".padStart(8)}  ` +
  `${"OOS WR%".padStart(8)}  ${"OOS PF".padStart(7)}  ${"OOS N".padStart(6)}  ` +
  `${"Full $/day".padStart(11)}`
);
console.log("-".repeat(90));
for (const r of results) {
  console.log(
    `${r.name.padEnd(28)} ` +
    `${fmtPnl(r.oosM.perDay).padStart(10)}  ` +
    `$${r.oosM.dd.toFixed(0).padStart(7)}  ` +
    `${r.oosM.wr.toFixed(1).padStart(8)}  ` +
    `${r.oosM.pf.toFixed(2).padStart(7)}  ` +
    `${String(r.oosM.n).padStart(6)}  ` +
    `${fmtPnl(r.fullM.perDay).padStart(11)}`
  );
}

// ─── Per-engine breakdown for top configs ───────────────────────────
console.log("\n" + "=".repeat(100));
console.log("PER-ENGINE BREAKDOWN (full period)");
console.log("=".repeat(100));

for (const r of results.slice(0, 5)) {
  const fullSim = simulateWithExitFilter(FULL_START, FULL_END, FILTERS.find(f => f.name === r.name)!);
  const engA = fullSim.trades.filter(t => t.engine === "A");
  const engB = fullSim.trades.filter(t => t.engine === "B");
  const mA = calcMetrics(engA, FULL_START, FULL_END);
  const mB = calcMetrics(engB, FULL_START, FULL_END);
  console.log(
    `\n${r.name}:` +
    `\n  Engine A (Donchian): N=${mA.n} $/day=${fmtPnl(mA.perDay)} WR=${mA.wr.toFixed(1)}% PF=${mA.pf.toFixed(2)} DD=$${mA.dd.toFixed(0)}` +
    `\n  Engine B (Supertrd): N=${mB.n} $/day=${fmtPnl(mB.perDay)} WR=${mB.wr.toFixed(1)}% PF=${mB.pf.toFixed(2)} DD=$${mB.dd.toFixed(0)}`
  );
}

console.log("\nDone.");
