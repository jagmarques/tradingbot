/**
 * Multi-timeframe confluence backtest.
 * Four strategies, each requiring daily + 4h + 1h alignment.
 * 5m cache aggregated to daily/4h/1h. Full period 2023-01 to 2026-03.
 *
 * Run: npx tsx scripts/bt-confluence-engine.ts
 */

import * as fs from "fs";
import * as path from "path";

// --------------- types ---------------

interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Pos {
  pair: string;
  engine: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  pk: number; // peak leveraged pnl% for trailing
}
interface Trade {
  engine: string;
  pair: string;
  dir: "long" | "short";
  pnl: number;
  et: number;
  xt: number;
}

// --------------- constants ---------------

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const SIZE = 5 * LEV; // $5 margin × 10x = $50 notional
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-28").getTime();
const OOS_START  = new Date("2025-07-01").getTime();
const DAYS = (FULL_END - FULL_START) / D;
const OOS_DAYS = (FULL_END - OOS_START) / D;

// ATR stop params
const ATR_MULT = 2.0;
const MAX_SL_PCT = 0.035;

// 14 target pairs (all present in 5m cache)
const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI",
];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4,
  OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};

// --------------- data loading ---------------

function loadJson(pair: string): C[] {
  const fp = path.join(CD_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: b[5] ? +b[5] : 0 }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) }
    )
    .sort((a, b) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((s, b) => s + b.v, 0),
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// --------------- indicators ---------------

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c)
    );
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
  }
  return atr;
}

function calcRSI(cs: C[], period: number): number[] {
  const rsi = new Array(cs.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const chg = cs[i].c - cs[i - 1].c;
    if (chg > 0) avgGain += chg;
    else avgLoss += -chg;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < cs.length; i++) {
    const chg = cs[i].c - cs[i - 1].c;
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcSupertrend(cs: C[], p: number, m: number): number[] {
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i];
    let l = hl2 - m * atr[i];
    if (i > p) {
      if (!(l > lb[i - 1] || cs[i - 1].c < lb[i - 1])) l = lb[i - 1];
      if (!(u < ub[i - 1] || cs[i - 1].c > ub[i - 1])) u = ub[i - 1];
    }
    ub[i] = u; lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return dirs;
}

function donchHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}

function donchLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

// --------------- binary search helpers ---------------

function bsearchLE(arr: C[], t: number): number {
  let lo = 0, hi = arr.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

// Find index of bar whose bucket matches floor(t/period)*period
function bucketIdx(arr: C[], tsMap: Map<number, number>, t: number, periodMs: number): number {
  const bucket = Math.floor(t / periodMs) * periodMs;
  const idx = tsMap.get(bucket);
  return idx !== undefined ? idx : -1;
}

// --------------- cost helpers ---------------

function sp(pair: string): number { return SP[pair] ?? 8e-4; }

function entryPx(pair: string, dir: "long" | "short", raw: number): number {
  return dir === "long" ? raw * (1 + sp(pair)) : raw * (1 - sp(pair));
}

function exitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const slip = isSL ? sp(pair) * SL_SLIP : sp(pair);
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}

function pnl(dir: "long" | "short", ep: number, xp: number): number {
  const gross = dir === "long" ? (xp / ep - 1) * SIZE : (ep / xp - 1) * SIZE;
  return gross - SIZE * FEE * 2;
}

function capSL(dir: "long" | "short", ep: number, sl: number): number {
  if (dir === "long") return Math.max(sl, ep * (1 - MAX_SL_PCT));
  return Math.min(sl, ep * (1 + MAX_SL_PCT));
}

// --------------- pre-compute indicators ---------------

interface PairData {
  // daily
  daily: C[];
  dailyMap: Map<number, number>;
  dailyEma9: number[];
  dailyEma21: number[];
  dailySma20: number[];
  dailySma50: number[];
  dailySt: number[]; // supertrend dir
  dailyATR: number[];
  // 4h
  h4: C[];
  h4Map: Map<number, number>;
  h4Ema9: number[];
  h4Ema21: number[];
  h4RSI: number[];
  h4St: number[]; // supertrend dir
  h4ATR: number[];
  // 1h
  h1: C[];
  h1Map: Map<number, number>;
  h1Ema9: number[];
  h1Ema21: number[];
  h1St: number[];
  h1VolSma: number[]; // SMA(20) of volume
  h1ATR: number[];
}

console.log("Loading and aggregating 5m data...");

const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(p);
  if (d.length > 0) raw5m.set(p, d);
}

// BTC 4h EMA filter
const btcH4 = aggregate(raw5m.get("BTC")!, H4);
const btcH4Map = new Map<number, number>();
btcH4.forEach((c, i) => btcH4Map.set(c.t, i));
const btcH4Ema12 = calcEMA(btcH4.map(c => c.c), 12);
const btcH4Ema21 = calcEMA(btcH4.map(c => c.c), 21);

function btcBullish(t: number): boolean {
  const idx = bsearchLE(btcH4, Math.floor(t / H4) * H4);
  if (idx < 1) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

const pairData = new Map<string, PairData>();

for (const pair of PAIRS) {
  const bars5m = raw5m.get(pair);
  if (!bars5m) { console.log(`  MISSING: ${pair}`); continue; }

  const daily = aggregate(bars5m, D);
  const h4    = aggregate(bars5m, H4);
  const h1    = aggregate(bars5m, H);

  const dCloses = daily.map(c => c.c);
  const h4Closes = h4.map(c => c.c);
  const h1Closes = h1.map(c => c.c);
  const h1Volumes = h1.map(c => c.v);

  const dailyMap = new Map<number, number>();
  daily.forEach((c, i) => dailyMap.set(c.t, i));
  const h4Map = new Map<number, number>();
  h4.forEach((c, i) => h4Map.set(c.t, i));
  const h1Map = new Map<number, number>();
  h1.forEach((c, i) => h1Map.set(c.t, i));

  pairData.set(pair, {
    daily, dailyMap,
    dailyEma9:  calcEMA(dCloses, 9),
    dailyEma21: calcEMA(dCloses, 21),
    dailySma20: calcSMA(dCloses, 20),
    dailySma50: calcSMA(dCloses, 50),
    dailySt:    calcSupertrend(daily, 14, 2),
    dailyATR:   calcATR(daily, 14),
    h4, h4Map,
    h4Ema9:  calcEMA(h4Closes, 9),
    h4Ema21: calcEMA(h4Closes, 21),
    h4RSI:   calcRSI(h4, 14),
    h4St:    calcSupertrend(h4, 14, 2),
    h4ATR:   calcATR(h4, 14),
    h1, h1Map,
    h1Ema9:   calcEMA(h1Closes, 9),
    h1Ema21:  calcEMA(h1Closes, 21),
    h1St:     calcSupertrend(h1, 14, 2),
    h1VolSma: calcSMA(h1Volumes, 20),
    h1ATR:    calcATR(h1, 14),
  });
}

console.log(`Loaded ${pairData.size} pairs.\n`);

// --------------- get prev-bar index helpers ---------------

function prevDayIdx(pd: PairData, t: number): number {
  const bucket = Math.floor(t / D) * D;
  const idx = pd.dailyMap.get(bucket);
  if (idx === undefined || idx < 1) return -1;
  return idx - 1; // previous completed daily bar
}

function prevH4Idx(pd: PairData, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  const idx = pd.h4Map.get(bucket);
  if (idx === undefined || idx < 1) return -1;
  return idx - 1;
}

function prevH1Idx(pd: PairData, t: number): number {
  const bucket = Math.floor(t / H) * H;
  const idx = pd.h1Map.get(bucket);
  if (idx === undefined || idx < 1) return -1;
  return idx - 1;
}

// --------------- strategy signal functions ---------------

// S1: Triple EMA alignment - daily EMA9>EMA21 AND 4h EMA9>EMA21 AND 1h EMA9>EMA21
// Enter on 1h. Exit when any TF flips.
function s1Signal(pair: string, t: number): "long" | "short" | null {
  const pd = pairData.get(pair)!;
  const di = prevDayIdx(pd, t);
  const h4i = prevH4Idx(pd, t);
  const h1i = prevH1Idx(pd, t);
  if (di < 5 || h4i < 5 || h1i < 5) return null;

  const dBull = pd.dailyEma9[di] > pd.dailyEma21[di];
  const dBear = pd.dailyEma9[di] < pd.dailyEma21[di];
  const h4Bull = pd.h4Ema9[h4i] > pd.h4Ema21[h4i];
  const h4Bear = pd.h4Ema9[h4i] < pd.h4Ema21[h4i];
  const h1Bull = pd.h1Ema9[h1i] > pd.h1Ema21[h1i];
  const h1Bear = pd.h1Ema9[h1i] < pd.h1Ema21[h1i];

  // 1h must have just flipped bullish (trigger bar)
  const h1iPrev = h1i - 1;
  if (h1iPrev < 0) return null;
  const h1PrevBull = pd.h1Ema9[h1iPrev] > pd.h1Ema21[h1iPrev];
  const h1PrevBear = pd.h1Ema9[h1iPrev] < pd.h1Ema21[h1iPrev];

  if (dBull && h4Bull && h1Bull && !h1PrevBull) return "long";
  if (dBear && h4Bear && h1Bear && !h1PrevBear) return "short";
  return null;
}

function s1ExitSignal(pair: string, t: number, dir: "long" | "short"): boolean {
  const pd = pairData.get(pair)!;
  const di = prevDayIdx(pd, t);
  const h4i = prevH4Idx(pd, t);
  const h1i = prevH1Idx(pd, t);
  if (di < 1 || h4i < 1 || h1i < 1) return false;

  if (dir === "long") {
    // exit when any TF turns bearish
    if (pd.dailyEma9[di] < pd.dailyEma21[di]) return true;
    if (pd.h4Ema9[h4i] < pd.h4Ema21[h4i]) return true;
    if (pd.h1Ema9[h1i] < pd.h1Ema21[h1i]) return true;
  } else {
    if (pd.dailyEma9[di] > pd.dailyEma21[di]) return true;
    if (pd.h4Ema9[h4i] > pd.h4Ema21[h4i]) return true;
    if (pd.h1Ema9[h1i] > pd.h1Ema21[h1i]) return true;
  }
  return false;
}

// S2: Trend + momentum + volume
// Daily SMA20>SMA50 AND 4h RSI>60 AND 1h volume > 2x average. Exit when 4h RSI<40.
function s2Signal(pair: string, t: number): "long" | "short" | null {
  const pd = pairData.get(pair)!;
  const di = prevDayIdx(pd, t);
  const h4i = prevH4Idx(pd, t);
  const h1i = prevH1Idx(pd, t);
  if (di < 50 || h4i < 15 || h1i < 20) return null;

  const dailyBull = pd.dailySma20[di] > pd.dailySma50[di];
  const dailyBear = pd.dailySma20[di] < pd.dailySma50[di];
  const h4RSI = pd.h4RSI[h4i];
  const h1Vol = pd.h1[h1i].v;
  const h1VolAvg = pd.h1VolSma[h1i];

  if (h1VolAvg <= 0) return null;
  const volSpike = h1Vol > 2 * h1VolAvg;

  if (dailyBull && h4RSI > 60 && volSpike) return "long";
  // shorts: daily bearish AND RSI oversold AND volume spike
  if (dailyBear && h4RSI < 40 && volSpike) return "short";
  return null;
}

function s2ExitSignal(pair: string, t: number, dir: "long" | "short"): boolean {
  const pd = pairData.get(pair)!;
  const h4i = prevH4Idx(pd, t);
  if (h4i < 1) return false;
  const rsi = pd.h4RSI[h4i];
  if (dir === "long" && rsi < 40) return true;
  if (dir === "short" && rsi > 60) return true;
  return false;
}

// S3: Supertrend cascade
// Daily ST bullish AND 4h ST bullish AND 1h ST flips bullish (trigger). Exit on 4h ST flip.
function s3Signal(pair: string, t: number): "long" | "short" | null {
  const pd = pairData.get(pair)!;
  const di = prevDayIdx(pd, t);
  const h4i = prevH4Idx(pd, t);
  const h1i = prevH1Idx(pd, t);
  if (di < 15 || h4i < 15 || h1i < 15) return null;

  const dailyBull = pd.dailySt[di] === 1;
  const dailyBear = pd.dailySt[di] === -1;
  const h4Bull = pd.h4St[h4i] === 1;
  const h4Bear = pd.h4St[h4i] === -1;

  // 1h just flipped
  const h1Curr = pd.h1St[h1i];
  const h1Prev = pd.h1St[h1i - 1];
  const h1FlipBull = h1Curr === 1 && h1Prev === -1;
  const h1FlipBear = h1Curr === -1 && h1Prev === 1;

  if (dailyBull && h4Bull && h1FlipBull) return "long";
  if (dailyBear && h4Bear && h1FlipBear) return "short";
  return null;
}

function s3ExitSignal(pair: string, t: number, dir: "long" | "short"): boolean {
  const pd = pairData.get(pair)!;
  const h4i = prevH4Idx(pd, t);
  if (h4i < 1) return false;
  const curr = pd.h4St[h4i];
  const prev = pd.h4St[h4i - 1];
  if (dir === "long" && curr === -1 && prev === 1) return true;
  if (dir === "short" && curr === 1 && prev === -1) return true;
  return false;
}

// S4: Donchian breakout + 4h Supertrend bullish + 1h above EMA21
// Daily: new 20-period close high (breakout). 4h ST bullish. 1h close > EMA21.
// Exit on 4h ST flip.
function s4Signal(pair: string, t: number): "long" | "short" | null {
  const pd = pairData.get(pair)!;
  const di = prevDayIdx(pd, t);
  const h4i = prevH4Idx(pd, t);
  const h1i = prevH1Idx(pd, t);
  if (di < 22 || h4i < 15 || h1i < 22) return null;

  const h4Bull = pd.h4St[h4i] === 1;
  const h4Bear = pd.h4St[h4i] === -1;

  const h1Close = pd.h1[h1i].c;
  const h1Ema21 = pd.h1Ema21[h1i];
  if (h1Ema21 === 0) return null;
  const h1AboveEma = h1Close > h1Ema21;
  const h1BelowEma = h1Close < h1Ema21;

  // Daily Donchian: close breaks 20-period high/low
  const dClose = pd.daily[di].c;
  const dHigh20 = donchHigh(pd.daily, di, 20);
  const dLow20 = donchLow(pd.daily, di, 20);

  const longBreak = dClose >= dHigh20 && h4Bull && h1AboveEma;
  const shortBreak = dClose <= dLow20 && h4Bear && h1BelowEma;

  if (longBreak) return "long";
  if (shortBreak) return "short";
  return null;
}

function s4ExitSignal(pair: string, t: number, dir: "long" | "short"): boolean {
  return s3ExitSignal(pair, t, dir); // same: 4h ST flip
}

// --------------- simulation ---------------

interface EngineSpec {
  name: string;
  signal: (pair: string, t: number) => "long" | "short" | null;
  exit: (pair: string, t: number, dir: "long" | "short") => boolean;
  maxHoldMs: number;
}

const ENGINES: EngineSpec[] = [
  { name: "S1-TripleEMA",    signal: s1Signal, exit: s1ExitSignal, maxHoldMs: 60 * D },
  { name: "S2-TrendMomVol",  signal: s2Signal, exit: s2ExitSignal, maxHoldMs: 30 * D },
  { name: "S3-STCascade",    signal: s3Signal, exit: s3ExitSignal, maxHoldMs: 60 * D },
  { name: "S4-DonchSTEMA",   signal: s4Signal, exit: s4ExitSignal, maxHoldMs: 60 * D },
];

// Build unified timeline from 1h bars (entry/exit checks at 1h resolution)
const allTs = new Set<number>();
for (const pd of pairData.values()) {
  for (const b of pd.h1) {
    if (b.t >= FULL_START && b.t < FULL_END) allTs.add(b.t);
  }
}
const timeline = [...allTs].sort((a, b) => a - b);

function runEngine(eng: EngineSpec, s: number, e: number): Trade[] {
  const trades: Trade[] = [];
  const pos = new Map<string, Pos>(); // key = `${engine}-${pair}`

  for (const t of timeline) {
    if (t < s || t >= e) continue;

    // Process exits first
    const toClose: string[] = [];
    for (const [key, p] of pos) {
      const pd = pairData.get(p.pair)!;
      const h1i = prevH1Idx(pd, t);
      if (h1i < 0) continue;
      const bar = pd.h1[h1i + 1]; // current bar (the one we're "in")
      // use h1i+1 as current candle if it exists, else h1i
      const curBar = (h1i + 1 < pd.h1.length && pd.h1[h1i + 1].t === t) ? pd.h1[h1i + 1] : null;
      if (!curBar) continue;

      let xp = 0;
      let isSL = false;

      // SL check (intra-bar)
      if (p.dir === "long" && curBar.l <= p.sl) {
        xp = exitPx(p.pair, p.dir, p.sl, true);
        isSL = true;
      } else if (p.dir === "short" && curBar.h >= p.sl) {
        xp = exitPx(p.pair, p.dir, p.sl, true);
        isSL = true;
      }

      // Signal exit
      if (!xp && eng.exit(p.pair, t, p.dir)) {
        xp = exitPx(p.pair, p.dir, curBar.o, false);
      }

      // Max hold
      if (!xp && t - p.et >= eng.maxHoldMs) {
        xp = exitPx(p.pair, p.dir, curBar.o, false);
      }

      if (xp > 0) {
        trades.push({ engine: eng.name, pair: p.pair, dir: p.dir, pnl: pnl(p.dir, p.ep, xp), et: p.et, xt: t });
        toClose.push(key);
      }
    }
    for (const k of toClose) pos.delete(k);

    // Process entries
    for (const pair of PAIRS) {
      const key = `${eng.name}-${pair}`;
      if (pos.has(key)) continue;

      const dir = eng.signal(pair, t);
      if (!dir) continue;

      // BTC filter for longs
      if (dir === "long" && !btcBullish(t)) continue;

      const pd = pairData.get(pair)!;
      const h1i = prevH1Idx(pd, t);
      if (h1i < 0) continue;

      // Use ATR from 1h for stop
      const atr = pd.h1ATR[h1i];
      if (atr <= 0) continue;

      const curBar = pd.h1.find(b => b.t === t);
      if (!curBar) continue;

      const ep = entryPx(pair, dir, curBar.o);
      let sl = dir === "long" ? ep - ATR_MULT * atr : ep + ATR_MULT * atr;
      sl = capSL(dir, ep, sl);

      pos.set(key, { pair, engine: eng.name, dir, ep, et: t, sl, pk: 0 });
    }
  }

  // Force-close any still-open positions at last bar
  for (const [, p] of pos) {
    const pd = pairData.get(p.pair)!;
    if (pd.h1.length === 0) continue;
    const lastBar = pd.h1[pd.h1.length - 1];
    const xp = exitPx(p.pair, p.dir, lastBar.c, false);
    trades.push({ engine: p.engine, pair: p.pair, dir: p.dir, pnl: pnl(p.dir, p.ep, xp), et: p.et, xt: lastBar.t });
  }

  return trades;
}

// --------------- stats helpers ---------------

function stats(trades: Trade[], days: number) {
  if (trades.length === 0) return { n: 0, wr: 0, pnlD: 0, pf: 0, maxDD: 0, sharpe: 0, totalPnl: 0 };
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const wr = wins.length / trades.length * 100;
  const pnlD = totalPnl / days;

  // Max drawdown
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Daily Sharpe
  const dp = new Map<number, number>();
  for (const t of sorted) {
    const day = Math.floor(t.xt / D);
    dp.set(day, (dp.get(day) ?? 0) + t.pnl);
  }
  const dr = [...dp.values()];
  const avg = dr.reduce((s, v) => s + v, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, v) => s + (v - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  return { n: trades.length, wr, pnlD, pf, maxDD, sharpe, totalPnl };
}

// Pearson correlation between two daily P&L series
function correlation(tradesA: Trade[], tradesB: Trade[]): number {
  const daysSet = new Set<number>();
  [...tradesA, ...tradesB].forEach(t => daysSet.add(Math.floor(t.xt / D)));
  const days = [...daysSet].sort((a, b) => a - b);
  if (days.length < 5) return 0;

  const mapA = new Map<number, number>();
  const mapB = new Map<number, number>();
  for (const t of tradesA) mapA.set(Math.floor(t.xt / D), (mapA.get(Math.floor(t.xt / D)) ?? 0) + t.pnl);
  for (const t of tradesB) mapB.set(Math.floor(t.xt / D), (mapB.get(Math.floor(t.xt / D)) ?? 0) + t.pnl);

  const aVals = days.map(d => mapA.get(d) ?? 0);
  const bVals = days.map(d => mapB.get(d) ?? 0);
  const avgA = aVals.reduce((s, v) => s + v, 0) / days.length;
  const avgB = bVals.reduce((s, v) => s + v, 0) / days.length;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < days.length; i++) {
    cov += (aVals[i] - avgA) * (bVals[i] - avgB);
    varA += (aVals[i] - avgA) ** 2;
    varB += (bVals[i] - avgB) ** 2;
  }
  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
}

// --------------- run all engines ---------------

console.log("Running simulations...\n");

const allResults: { eng: EngineSpec; trades: Trade[]; oos: Trade[] }[] = [];

for (const eng of ENGINES) {
  const trades = runEngine(eng, FULL_START, FULL_END);
  const oos = trades.filter(t => t.xt >= OOS_START);
  allResults.push({ eng, trades, oos });
}

// Supertrend engine (S3) trades for correlation
const s3Res = allResults.find(r => r.eng.name === "S3-STCascade")!;

// --------------- print results ---------------

console.log("=== CONFLUENCE ENGINE RESULTS ===");
console.log(`Period: 2023-01-01 to 2026-03-28 (${DAYS.toFixed(0)} days)`);
console.log(`OOS:    2025-07-01 to 2026-03-28 (${OOS_DAYS.toFixed(0)} days)`);
console.log(`$5 margin / 10x leverage / ATR×2 SL capped 3.5% / BTC 4h EMA(12/21) filter for longs`);
console.log(`14 pairs: ${PAIRS.join(", ")}\n`);

console.log("Strategy         Trades  T/day  WR%    $/day   PF     MaxDD    Sharpe  | OOS Trades  OOS $/day  OOS WR%  | Corr vs S3");
console.log("-".repeat(130));

for (const { eng, trades, oos } of allResults) {
  const s = stats(trades, DAYS);
  const so = stats(oos, OOS_DAYS);
  const corr = eng.name === "S3-STCascade" ? 1.0 : correlation(trades, s3Res.trades);
  const tpd = (trades.length / DAYS).toFixed(2);
  const pnlStr = s.pnlD >= 0 ? `+$${s.pnlD.toFixed(2)}` : `-$${Math.abs(s.pnlD).toFixed(2)}`;
  const oosPnlStr = so.pnlD >= 0 ? `+$${so.pnlD.toFixed(2)}` : `-$${Math.abs(so.pnlD).toFixed(2)}`;
  console.log(
    `${eng.name.padEnd(16)} ${String(s.n).padStart(6)}  ${tpd.padStart(5)}  ${s.wr.toFixed(1).padStart(5)}  ${pnlStr.padStart(7)}  ${s.pf.toFixed(2).padStart(5)}  $${s.maxDD.toFixed(0).padStart(6)}  ${s.sharpe.toFixed(2).padStart(6)}  | ${String(so.n).padStart(5)}        ${oosPnlStr.padStart(9)}    ${so.wr.toFixed(1).padStart(5)}  | ${corr.toFixed(3)}`
  );
}

// Per-engine per-pair breakdown
for (const { eng, trades } of allResults) {
  console.log(`\n--- ${eng.name} per-pair breakdown ---`);
  const byPair = new Map<string, Trade[]>();
  for (const t of trades) {
    let arr = byPair.get(t.pair);
    if (!arr) { arr = []; byPair.set(t.pair, arr); }
    arr.push(t);
  }
  const rows = [...byPair.entries()].sort((a, b) => {
    const pa = a[1].reduce((s, t) => s + t.pnl, 0);
    const pb = b[1].reduce((s, t) => s + t.pnl, 0);
    return pb - pa;
  });
  console.log("Pair     Trades  WR%    PnL        Longs  Shorts");
  console.log("-".repeat(55));
  for (const [pair, ts] of rows) {
    const w = ts.filter(t => t.pnl > 0).length;
    const p = ts.reduce((s, t) => s + t.pnl, 0);
    const longs = ts.filter(t => t.dir === "long").length;
    const shorts = ts.filter(t => t.dir === "short").length;
    console.log(`${pair.padEnd(8)} ${String(ts.length).padStart(6)}  ${(w / ts.length * 100).toFixed(1).padStart(5)}  ${(p >= 0 ? "+" : "")}$${p.toFixed(1).padStart(7)}  ${String(longs).padStart(5)}  ${String(shorts).padStart(6)}`);
  }
}

// Monthly breakdown for best engine (by total PnL)
const best = [...allResults].sort((a, b) => {
  const pa = a.trades.reduce((s, t) => s + t.pnl, 0);
  const pb = b.trades.reduce((s, t) => s + t.pnl, 0);
  return pb - pa;
})[0];

console.log(`\n=== MONTHLY BREAKDOWN: ${best.eng.name} ===`);
console.log("Month     Trades  WR%    PnL       $/day");
console.log("-".repeat(50));
const byMonth = new Map<string, Trade[]>();
for (const t of best.trades) {
  const m = new Date(t.xt).toISOString().slice(0, 7);
  let arr = byMonth.get(m);
  if (!arr) { arr = []; byMonth.set(m, arr); }
  arr.push(t);
}
for (const [m, ts] of [...byMonth.entries()].sort()) {
  const p = ts.reduce((s, t) => s + t.pnl, 0);
  const w = ts.filter(t => t.pnl > 0).length;
  const daysInMonth = m === "2026-03" ? 28 : new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
  console.log(`${m}   ${String(ts.length).padStart(6)}  ${(w / ts.length * 100).toFixed(1).padStart(5)}  ${(p >= 0 ? "+" : "")}$${p.toFixed(1).padStart(7)}  $${(p / daysInMonth).toFixed(2).padStart(6)}`);
}

// Summary note
console.log("\n=== SUMMARY ===");
for (const { eng, trades } of allResults) {
  const s = stats(trades, DAYS);
  const verdict = s.pnlD > 0.5 && s.pf > 1.2 && s.wr > 45 ? "INTERESTING" : s.pnlD > 0 ? "marginal" : "negative";
  console.log(`${eng.name.padEnd(16)}  $/day=${s.pnlD >= 0 ? "+" : ""}$${s.pnlD.toFixed(2)}  PF=${s.pf.toFixed(2)}  WR=${s.wr.toFixed(1)}%  DD=$${s.maxDD.toFixed(0)}  -> ${verdict}`);
}
