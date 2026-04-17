/**
 * GARCH Combination Backtest - C4 Series
 * Tests GARCH z=4.5/3.0 with 7 different entry filters.
 * Single engine only (no separate ST engine), $9 margin, 10x, max 7, trail 40/3.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-garch-combos-c4.ts
 */

import * as fs from "fs";
import * as path from "path";

// ---- Types ----

interface C { t: number; o: number; h: number; l: number; c: number; }

// ---- Constants ----

const CD_5M = "/tmp/bt-pair-cache-5m";
const H   = 3_600_000;
const H4  = 4 * H;
const D   = 86_400_000;
const MIN_1 = 60_000;
const FEE   = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const MARGIN = 9;               // $9 margin per position
const NOTIONAL = MARGIN * LEV;  // $90

const TRAIL_ACT  = 40;          // activate trail at +40% leveraged PnL
const TRAIL_DIST = 3;           // trail 3% from peak
const MAX_POS    = 7;
const DO_REENTRY = true;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// GARCH v2 params
const Z1_LONG  =  4.5;
const Z4_LONG  =  3.0;
const Z1_SHORT = -3.0;
const Z4_SHORT = -3.0;
const MOM_LB   = 3;
const VOL_WIN  = 20;
// GARCH TP/SL
const GARCH_SL_PCT = 0.03;
const GARCH_TP_PCT = 0.07;
const GARCH_MH     = 96; // hours

// C7 staged entry thresholds
const Z1_LONG_SCALE  =  5.5;
const Z4_LONG_SCALE  =  4.0;
const Z1_SHORT_SCALE = -4.5;
const Z4_SHORT_SCALE = -4.0;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

// ---- Data Loading ----

function loadJson(pair: string): C[] {
  const fp = path.join(CD_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown[];
  return (raw as (number[] | Record<string, number>)[]).map(b =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a, b) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
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
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ---- Indicators ----

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
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    sma[i] = s / period;
  }
  return sma;
}

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
  }
  return atr;
}

function calcRSI(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(0);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
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
      if (!(l > lb[i-1] || cs[i-1].c < lb[i-1])) l = lb[i-1];
      if (!(u < ub[i-1] || cs[i-1].c > ub[i-1])) u = ub[i-1];
    }
    ub[i] = u;
    lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i-1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return dirs;
}

function computeZScores(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - MOM_LB].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      const r = cs[j].c / cs[j-1].c - 1;
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

function calcVolRatio(cs: C[], i: number, period: number): number {
  // current bar volume vs period avg. No explicit volume in OHLC struct
  // Use |close-open|/close as proxy for relative bar size (activity proxy)
  if (i < period) return 0;
  let sum = 0;
  for (let j = i - period; j < i; j++) {
    sum += Math.abs(cs[j].c - cs[j].o) / cs[j].c;
  }
  const avg = sum / period;
  if (avg === 0) return 0;
  return Math.abs(cs[i].c - cs[i].o) / cs[i].c / avg;
}

// We use OHLC-derived "volume" proxy for 1h bars: body size
function calcOHLCVolSeries(cs: C[]): number[] {
  return cs.map(c => Math.abs(c.c - c.o));
}

function calcAvgVolSeries(vols: number[], period: number): number[] {
  const avg = new Array(vols.length).fill(0);
  for (let i = period - 1; i < vols.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += vols[j];
    avg[i] = s / period;
  }
  return avg;
}

// ---- Binary search ----

function bsearchTs(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

// ---- Per-pair indicators struct ----

interface PairInd {
  // 5m raw (for exit SL precision)
  bars5m: C[];
  tsMap5m: Map<number, number>;
  // 1h
  h1:       C[];
  h1TsMap:  Map<number, number>;
  h1Z:      number[];
  h1Ema9:   number[];
  h1Ema21:  number[];
  h1RSI14:  number[];
  h1Vol:    number[];    // OHLC-body proxy
  h1AvgVol: number[];    // 20-bar avg of h1Vol
  // 4h
  h4:       C[];
  h4TsMap:  Map<number, number>;
  h4Z:      number[];
  h4StDir:  number[];    // Supertrend 14/1.75
  h4ATR:    number[];
  h4Ema20:  number[];    // Keltner middle
  // Daily
  daily:    C[];
  dTsMap:   Map<number, number>;
  dSMA20:   number[];
  dSMA50:   number[];
}

// ---- BTC filter ----

let btcH4: C[] = [];
let btcH4Ema12: number[] = [];
let btcH4Ema21: number[] = [];
let btcH1: C[] = [];
let btcH1Ema9: number[] = [];
let btcH1Ema21a: number[] = [];
let btcH1TsMap: Map<number, number> = new Map();

function btcLongFilter(t: number): boolean {
  const idx = bsearchTs(btcH4, t);
  if (idx < 1) return false;
  const i = idx;
  return btcH4Ema12[i] > btcH4Ema21[i];
}

function btcH1TrendLong(t: number): boolean {
  const bucket = Math.floor(t / H) * H;
  const i = btcH1TsMap.get(bucket);
  if (i === undefined || i < 1) return false;
  return btcH1Ema9[i-1] > btcH1Ema21a[i-1];
}

function btcH1TrendShort(t: number): boolean {
  const bucket = Math.floor(t / H) * H;
  const i = btcH1TsMap.get(bucket);
  if (i === undefined || i < 1) return false;
  return btcH1Ema9[i-1] < btcH1Ema21a[i-1];
}

// ---- Cost helpers ----

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

function applyEntryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}

function applyExitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}

function calcPnl(dir: "long" | "short", ep: number, xp: number): number {
  const raw = dir === "long" ? (xp / ep - 1) * NOTIONAL : (ep / xp - 1) * NOTIONAL;
  return raw - NOTIONAL * FEE * 2;
}

// ---- Precompute all indicators ----

console.log("Loading 5m data and computing indicators...");

const pairInd = new Map<string, PairInd>();

const raw5mBtc = loadJson("BTC");
btcH4 = aggregate(raw5mBtc, H4, 40);
btcH1 = aggregate(raw5mBtc, H, 10);

btcH4Ema12 = calcEMA(btcH4.map(c => c.c), 12);
btcH4Ema21 = calcEMA(btcH4.map(c => c.c), 21);
btcH1Ema9  = calcEMA(btcH1.map(c => c.c), 9);
btcH1Ema21a = calcEMA(btcH1.map(c => c.c), 21);
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

for (const pair of PAIRS) {
  const bars5m = loadJson(pair);
  if (bars5m.length < 200) continue;

  const h1    = aggregate(bars5m, H, 10);
  const h4    = aggregate(bars5m, H4, 40);
  const daily = aggregate(bars5m, D, 200);

  const h1Closes = h1.map(c => c.c);
  const h1Z      = computeZScores(h1);
  const h1Ema9   = calcEMA(h1Closes, 9);
  const h1Ema21  = calcEMA(h1Closes, 21);
  const h1RSI14  = calcRSI(h1Closes, 14);
  const h1VolRaw = calcOHLCVolSeries(h1);
  const h1AvgVol = calcAvgVolSeries(h1VolRaw, 20);

  const h4Z     = computeZScores(h4);
  const h4StDir = calcSupertrend(h4, 14, 1.75);
  const h4ATR   = calcATR(h4, 14);
  const h4Ema20 = calcEMA(h4.map(c => c.c), 20);

  const dCloses = daily.map(c => c.c);
  const dSMA20  = calcSMA(dCloses, 20);
  const dSMA50  = calcSMA(dCloses, 50);

  const h1TsMap: Map<number, number> = new Map();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap: Map<number, number> = new Map();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const dTsMap: Map<number, number> = new Map();
  daily.forEach((c, i) => dTsMap.set(c.t, i));
  const tsMap5m: Map<number, number> = new Map();
  bars5m.forEach((c, i) => tsMap5m.set(c.t, i));

  pairInd.set(pair, {
    bars5m, tsMap5m,
    h1, h1TsMap, h1Z, h1Ema9, h1Ema21, h1RSI14, h1Vol: h1VolRaw, h1AvgVol,
    h4, h4TsMap, h4Z, h4StDir, h4ATR, h4Ema20,
    daily, dTsMap, dSMA20, dSMA50,
  });
}

console.log(`Indicators ready for ${pairInd.size} pairs.\n`);

// ---- Core GARCH check (returns direction or null) ----

function garchBaseSignal(pair: string, t: number): "long" | "short" | null {
  const ind = pairInd.get(pair);
  if (!ind) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const i = ind.h1TsMap.get(h1Bucket);
  if (i === undefined || i < 24) return null;
  const prev = i - 1;

  const z1 = ind.h1Z[prev];
  if (!isFinite(z1) || z1 === 0) return null;

  const goLong  = z1 > Z1_LONG;
  const goShort = z1 < Z1_SHORT;
  if (!goLong && !goShort) return null;

  // EMA 9/21 on 1h
  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  // 4h z-score confirmation
  const h4Bucket = Math.floor(ind.h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(h4Bucket);
  if (idx4h === undefined || idx4h < 4) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong  && z4 <= Z4_LONG)  return null;
  if (goShort && z4 >= Z4_SHORT) return null;

  // BTC 1h EMA trend
  if (goLong  && !btcH1TrendLong(ind.h1[prev].t))  return null;
  if (goShort && !btcH1TrendShort(ind.h1[prev].t)) return null;

  return goLong ? "long" : "short";
}

// ---- Filter predicates ----
// Each returns true if the signal is ALLOWED to enter.

type FilterFn = (pair: string, t: number, dir: "long" | "short") => boolean;

// C1: RSI confirmation (1h RSI>60 for longs, <40 for shorts)
function filterRSI(pair: string, t: number, dir: "long" | "short"): boolean {
  const ind = pairInd.get(pair);
  if (!ind) return false;
  const h1Bucket = Math.floor(t / H) * H;
  const i = ind.h1TsMap.get(h1Bucket);
  if (i === undefined || i < 2) return false;
  const rsi = ind.h1RSI14[i - 1];
  if (rsi === 0) return false;
  if (dir === "long"  && rsi > 60) return true;
  if (dir === "short" && rsi < 40) return true;
  return false;
}

// C2: 4h Supertrend alignment
function filterSupertrend(pair: string, t: number, dir: "long" | "short"): boolean {
  const ind = pairInd.get(pair);
  if (!ind) return false;
  const h4Bucket = Math.floor(t / H4) * H4;
  const i = ind.h4TsMap.get(h4Bucket);
  if (i === undefined || i < 2) return false;
  const prev = i - 1;
  if (dir === "long"  && ind.h4StDir[prev] === 1)  return true;
  if (dir === "short" && ind.h4StDir[prev] === -1) return true;
  return false;
}

// C3: 1h volume spike (body proxy > 2x 20-bar avg)
function filterVolSpike(pair: string, t: number, _dir: "long" | "short"): boolean {
  const ind = pairInd.get(pair);
  if (!ind) return false;
  const h1Bucket = Math.floor(t / H) * H;
  const i = ind.h1TsMap.get(h1Bucket);
  if (i === undefined || i < 21) return false;
  const prev = i - 1;
  const avg = ind.h1AvgVol[prev];
  if (avg <= 0) return false;
  return ind.h1Vol[prev] > 2 * avg;
}

// C4: Daily SMA(20) > SMA(50) for longs, < for shorts (pair's own daily trend)
function filterDailyTrend(pair: string, t: number, dir: "long" | "short"): boolean {
  const ind = pairInd.get(pair);
  if (!ind) return false;
  const dayBucket = Math.floor(t / D) * D;
  // Use most recent completed day (yesterday)
  const idx = bsearchTs(ind.daily, dayBucket - D);
  if (idx < 50) return false;
  const sma20 = ind.dSMA20[idx];
  const sma50 = ind.dSMA50[idx];
  if (sma20 === 0 || sma50 === 0) return false;
  if (dir === "long"  && sma20 > sma50) return true;
  if (dir === "short" && sma20 < sma50) return true;
  return false;
}

// C5: Funding proxy — skip longs when 4h_proxy = (close-open)/close > 0.005
function filterFunding(pair: string, t: number, dir: "long" | "short"): boolean {
  const ind = pairInd.get(pair);
  if (!ind) return false;
  if (dir === "short") return true; // only filter longs
  const h4Bucket = Math.floor(t / H4) * H4;
  const i = ind.h4TsMap.get(h4Bucket);
  if (i === undefined || i < 2) return false;
  const prev = i - 1;
  const bar = ind.h4[prev];
  const proxy = (bar.c - bar.o) / bar.c;
  return proxy <= 0.005;
}

// C6: Keltner position — price above 4h EMA(20) for longs, below for shorts
function filterKeltner(pair: string, t: number, dir: "long" | "short"): boolean {
  const ind = pairInd.get(pair);
  if (!ind) return false;
  const h4Bucket = Math.floor(t / H4) * H4;
  const i = ind.h4TsMap.get(h4Bucket);
  if (i === undefined || i < 21) return false;
  const prev = i - 1;
  const ema = ind.h4Ema20[prev];
  if (ema === 0) return false;
  const price = ind.h4[prev].c;
  if (dir === "long"  && price > ema) return true;
  if (dir === "short" && price < ema) return true;
  return false;
}

// No filter (baseline)
function filterNone(_pair: string, _t: number, _dir: "long" | "short"): boolean {
  return true;
}

// ---- Position types ----

interface Position {
  pair:        string;
  dir:         "long" | "short";
  entryPrice:  number;
  effectiveEP: number;
  sl:          number;
  entryTime:   number;
  peakPnlPct:  number;
  isReentry:   boolean;
  // C7 scaling state
  scaled:      boolean;   // already added scale-in position
  baseMargin:  number;    // original margin
  curMargin:   number;    // current margin (may be 6+3 for C7)
}

interface ClosedTrade {
  dir:       "long" | "short";
  entryTime: number;
  exitTime:  number;
  pnl:       number;
  reason:    string;
}

interface PendingReentry {
  pair:     string;
  dir:      "long" | "short";
  checkTime: number;
}

// ---- Main simulation ----

type ComboName = "BASELINE" | "C1_RSI" | "C2_ST" | "C3_VOL" | "C4_DAILY" | "C5_FUND" | "C6_KELT" | "C7_STAGE";

interface SimResult {
  combo:     ComboName;
  trades:    ClosedTrade[];
  reentries: number;
  blocked:   number;
}

function runSim(
  combo: ComboName,
  filter: FilterFn,
  startTs: number,
  endTs: number,
): SimResult {
  const isC7 = combo === "C7_STAGE";

  const open: Position[] = [];
  const closed: ClosedTrade[] = [];
  const pending: PendingReentry[] = [];
  let reentries = 0, blocked = 0;

  const simStart = Math.max(startTs, FULL_START);
  const simEnd   = Math.min(endTs, FULL_END);

  function get5mBar(pair: string, t: number): C | null {
    const ind = pairInd.get(pair);
    if (!ind || ind.bars5m.length === 0) return null;
    // exact match
    const i = ind.tsMap5m.get(t);
    if (i !== undefined) return ind.bars5m[i];
    // nearest past
    const ni = bsearchTs(ind.bars5m, t);
    if (ni < 0 || ind.bars5m[ni].t < t - MIN_1 * 5) return null;
    return ind.bars5m[ni];
  }

  function closePos(pi: number, exitTime: number, rawExit: number, reason: string, isSL: boolean): void {
    const pos = open[pi];
    const curNotional = pos.curMargin * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExit, isSL);
    const raw = pos.dir === "long" ? (xp / pos.effectiveEP - 1) * curNotional : (pos.effectiveEP / xp - 1) * curNotional;
    const pnl = raw - curNotional * FEE * 2;
    closed.push({ dir: pos.dir, entryTime: pos.entryTime, exitTime, pnl, reason });

    if (reason === "trail" && DO_REENTRY) {
      const nextH = (Math.floor(exitTime / H) + 1) * H;
      pending.push({ pair: pos.pair, dir: pos.dir, checkTime: nextH });
    }
    open.splice(pi, 1);
  }

  function tryOpen(pair: string, dir: "long" | "short", t: number, isReentry: boolean, margin: number): boolean {
    if (open.length >= MAX_POS) { blocked++; return false; }
    if (open.some(p => p.pair === pair)) { blocked++; return false; }

    const ind = pairInd.get(pair);
    if (!ind) return false;
    const h1Bucket = Math.floor(t / H) * H;
    const i = ind.h1TsMap.get(h1Bucket);
    if (i === undefined) return false;
    const bar = ind.h1[i];

    const rawEP = bar.o;
    const ep = applyEntryPx(pair, dir, rawEP);
    let sl = dir === "long" ? rawEP * (1 - GARCH_SL_PCT) : rawEP * (1 + GARCH_SL_PCT);
    // cap SL at 3.5%
    if (dir === "long") sl = Math.max(sl, rawEP * 0.965);
    else                sl = Math.min(sl, rawEP * 1.035);

    open.push({
      pair, dir,
      entryPrice: rawEP, effectiveEP: ep, sl,
      entryTime: t, peakPnlPct: 0,
      isReentry, scaled: false,
      baseMargin: margin, curMargin: margin,
    });
    if (isReentry) reentries++;
    return true;
  }

  let lastPct = -1;

  for (let t = simStart; t < simEnd; t += MIN_1) {
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    const isH1 = t % H === 0;
    const isH4 = t % H4 === 0;

    // 1) SL + trail via 5m bars
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const pos = open[pi];
      const bar = get5mBar(pos.pair, t);
      if (!bar) continue;

      // SL hit
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // TP at 7%
      const tp = pos.dir === "long" ? pos.entryPrice * (1 + GARCH_TP_PCT) : pos.entryPrice * (1 - GARCH_TP_PCT);
      if (pos.dir === "long" && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
      if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }

      // Peak tracking
      const best = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (best > pos.peakPnlPct) pos.peakPnlPct = best;

      // Trail 40/3
      if (pos.peakPnlPct >= TRAIL_ACT) {
        const curr = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (curr <= pos.peakPnlPct - TRAIL_DIST) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
      }

      // C7: scale-in when z reaches second threshold
      if (isC7 && isH1 && !pos.scaled) {
        const ind = pairInd.get(pos.pair);
        if (ind) {
          const h1Bucket = Math.floor(t / H) * H;
          const idx = ind.h1TsMap.get(h1Bucket);
          if (idx !== undefined && idx >= 1) {
            const prev = idx - 1;
            const z1 = ind.h1Z[prev];
            const scaleOk = pos.dir === "long"
              ? z1 > Z1_LONG_SCALE
              : z1 < Z1_SHORT_SCALE;
            if (scaleOk) {
              const h4Bucket = Math.floor(ind.h1[prev].t / H4) * H4;
              const idx4 = ind.h4TsMap.get(h4Bucket);
              const z4 = idx4 !== undefined ? ind.h4Z[idx4] : 0;
              const z4Ok = pos.dir === "long" ? z4 > Z4_LONG_SCALE : z4 < Z4_SHORT_SCALE;
              if (z4Ok && open.length < MAX_POS) {
                // Add $3 more to this position
                pos.curMargin += 3;
                pos.scaled = true;
              }
            }
          }
        }
      }
    }

    // 2) Max hold exit at 1h boundaries
    if (isH1) {
      for (let pi = open.length - 1; pi >= 0; pi--) {
        const pos = open[pi];
        const elapsed = (t - pos.entryTime) / H;
        if (elapsed >= GARCH_MH) {
          const ind = pairInd.get(pos.pair);
          if (!ind) continue;
          const h1Bucket = Math.floor(t / H) * H;
          const idx = ind.h1TsMap.get(h1Bucket);
          if (idx === undefined) continue;
          closePos(pi, t, ind.h1[idx].c, "mh", false);
        }
      }
    }

    // 3) New entries at 1h boundaries
    if (isH1) {
      for (const pair of PAIRS) {
        if (open.some(p => p.pair === pair)) continue;

        const dir = garchBaseSignal(pair, t);
        if (!dir) continue;
        if (!filter(pair, t, dir)) continue;

        const margin = isC7 ? 6 : MARGIN;
        tryOpen(pair, dir, t, false, margin);
      }
    }

    // 4) Re-entries
    if (DO_REENTRY && isH1 && pending.length > 0) {
      for (let ri = pending.length - 1; ri >= 0; ri--) {
        const re = pending[ri];
        if (t < re.checkTime) continue;
        pending.splice(ri, 1);

        if (open.some(p => p.pair === re.pair)) continue;

        // Check GARCH signal still active in same direction + filter
        const dir = garchBaseSignal(re.pair, t);
        if (dir !== re.dir) continue;
        if (!filter(re.pair, t, dir)) continue;

        tryOpen(re.pair, dir, t, true, isC7 ? 6 : MARGIN);
      }
    }
  }

  // Close remaining at end
  for (let pi = open.length - 1; pi >= 0; pi--) {
    const pos = open[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.h1.length === 0) continue;
    const last = ind.h1[ind.h1.length - 1];
    closePos(pi, simEnd, last.c, "eop", false);
  }

  return { combo, trades: closed, reentries, blocked };
}

// ---- Metrics ----

interface Metrics {
  n:        number;
  wr:       number;
  pf:       number;
  total:    number;
  perDay:   number;
  maxDD:    number;
  sharpe:   number;
  trails:   number;
  reentries: number;
  blocked:  number;
  oosN:     number;
  oosPerDay: number;
  oosPf:    number;
  oosWr:    number;
  tradesDayFull: number;
  tradesDayOOS:  number;
}

function computeMetrics(
  result: SimResult,
  startTs: number,
  endTs: number,
): Metrics {
  const { trades, reentries, blocked } = result;
  const fullDays = (endTs - startTs) / D;
  const oosDays  = (endTs - OOS_START) / D;

  function stats(trs: ClosedTrade[], days: number) {
    if (trs.length === 0) return { n: 0, wr: 0, pf: 0, total: 0, perDay: 0, maxDD: 0, sharpe: 0, trails: 0 };
    const wins   = trs.filter(t => t.pnl > 0);
    const losses = trs.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = trs.reduce((s, t) => s + t.pnl, 0);

    const sorted = [...trs].sort((a, b) => a.exitTime - b.exitTime);
    let cum = 0, peak = 0, maxDD = 0;
    for (const t of sorted) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDD) maxDD = peak - cum;
    }

    const dayPnl = new Map<number, number>();
    for (const t of trs) {
      const d = Math.floor(t.exitTime / D);
      dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
    }
    const rets = [...dayPnl.values()];
    const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
    const std  = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    const trails = trs.filter(t => t.reason === "trail").length;

    return { n: trs.length, wr: (wins.length / trs.length) * 100, pf: gl > 0 ? gp / gl : 99, total, perDay: total / days, maxDD, sharpe, trails };
  }

  const fm = stats(trades, fullDays);
  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);
  const om = stats(oosTrades, oosDays);

  return {
    n:        fm.n,
    wr:       fm.wr,
    pf:       fm.pf,
    total:    fm.total,
    perDay:   fm.perDay,
    maxDD:    fm.maxDD,
    sharpe:   fm.sharpe,
    trails:   fm.trails,
    reentries,
    blocked,
    oosN:        om.n,
    oosPerDay:   om.perDay,
    oosPf:       om.pf,
    oosWr:       om.wr,
    tradesDayFull: fm.n / fullDays,
    tradesDayOOS:  om.n / oosDays,
  };
}

// ---- Run all combos ----

const CONFIGS: Array<{ combo: ComboName; filter: FilterFn; desc: string }> = [
  { combo: "BASELINE",  filter: filterNone,       desc: "GARCH only, no extra filter" },
  { combo: "C1_RSI",    filter: filterRSI,        desc: "1h RSI>60 longs / <40 shorts" },
  { combo: "C2_ST",     filter: filterSupertrend, desc: "4h Supertrend alignment" },
  { combo: "C3_VOL",    filter: filterVolSpike,   desc: "1h body-vol > 2x 20-bar avg" },
  { combo: "C4_DAILY",  filter: filterDailyTrend, desc: "Daily SMA(20)>SMA(50) alignment" },
  { combo: "C5_FUND",   filter: filterFunding,    desc: "Skip longs if 4h proxy>0.5%" },
  { combo: "C6_KELT",   filter: filterKeltner,    desc: "Price vs 4h EMA(20) position" },
  { combo: "C7_STAGE",  filter: filterNone,       desc: "Staged $6+$3 at extreme z" },
];

console.log("Running GARCH combination backtests ($9 margin, 10x, max 7, trail 40/3)...\n");

const allResults: Array<{ cfg: typeof CONFIGS[0]; m: Metrics }> = [];

for (const cfg of CONFIGS) {
  process.stdout.write(`${cfg.combo.padEnd(10)} ...`);
  const result = runSim(cfg.combo, cfg.filter, FULL_START, FULL_END);
  const m = computeMetrics(result, FULL_START, FULL_END);
  allResults.push({ cfg, m });
  console.log(` ${m.n} trades | $${m.perDay.toFixed(2)}/day | PF ${m.pf.toFixed(2)} | OOS $${m.oosPerDay.toFixed(2)}/day | DD $${m.maxDD.toFixed(0)}`);
}

// ---- Print summary table ----

const SEP = "=".repeat(160);
console.log("\n" + SEP);
console.log("GARCH COMBINATION FILTERS | $9 margin 10x | max 7 | trail 40/3 + re-entry | BTC 4h EMA(12/21)");
console.log("Full: 2023-01-01 to 2026-03-26 | OOS: 2025-09-01+");
console.log(SEP);

const BASE = allResults.find(r => r.cfg.combo === "BASELINE")!.m;

const hdr = [
  "Combo".padEnd(11),
  "Trades".padStart(7),
  "Td/day".padStart(7),
  "WR%".padStart(7),
  "$/day".padStart(8),
  "PF".padStart(6),
  "Sharpe".padStart(7),
  "MaxDD".padStart(8),
  "Trails".padStart(7),
  "ReEnt".padStart(7),
  "OOS-N".padStart(7),
  "OOS$/d".padStart(8),
  "OOSPF".padStart(7),
  "OOWR%".padStart(7),
  "vsBASE$/d".padStart(11),
  "vsOOS$/d".padStart(10),
  "Description".padStart(12),
].join(" ");

console.log("\n" + hdr);
console.log("-".repeat(160));

for (const { cfg, m } of allResults) {
  const deltaPD  = m.perDay - BASE.perDay;
  const deltaOOS = m.oosPerDay - BASE.oosPerDay;
  const sign = (v: number) => v >= 0 ? "+" : "";
  console.log([
    cfg.combo.padEnd(11),
    String(m.n).padStart(7),
    m.tradesDayFull.toFixed(2).padStart(7),
    m.wr.toFixed(1).padStart(6) + "%",
    ("$" + m.perDay.toFixed(2)).padStart(8),
    m.pf.toFixed(2).padStart(6),
    m.sharpe.toFixed(2).padStart(7),
    ("$" + m.maxDD.toFixed(0)).padStart(8),
    String(m.trails).padStart(7),
    String(m.reentries).padStart(7),
    String(m.oosN).padStart(7),
    ("$" + m.oosPerDay.toFixed(2)).padStart(8),
    m.oosPf.toFixed(2).padStart(7),
    m.oosWr.toFixed(1).padStart(6) + "%",
    (sign(deltaPD) + "$" + deltaPD.toFixed(2)).padStart(11),
    (sign(deltaOOS) + "$" + deltaOOS.toFixed(2)).padStart(10),
    ("  " + cfg.desc),
  ].join(" "));
}

console.log("\n" + SEP);
console.log("Notes:");
console.log("  BASELINE = GARCH z=4.5/3.0 + 4h z=3.0/3.0, 1h EMA 9/21, BTC 1h EMA 9/21, no extra filter");
console.log("  C3_VOL uses OHLC body size as volume proxy (no tick-volume in 5m OHLC data)");
console.log("  C7_STAGE: initial $6 at z=4.5/3.0, adds $3 more if z continues to 5.5/4.0 (same position)");
console.log("  vsBASE$/d = difference in $/day vs BASELINE (+ means better)");
console.log("  vsOOS$/d  = difference in OOS $/day vs BASELINE");
console.log(SEP);

// Rank by OOS $/day
const ranked = [...allResults].sort((a, b) => b.m.oosPerDay - a.m.oosPerDay);
console.log("\nRanked by OOS $/day:");
for (const { cfg, m } of ranked) {
  const deltaOOS = m.oosPerDay - BASE.oosPerDay;
  const sign = deltaOOS >= 0 ? "+" : "";
  console.log(
    `  ${cfg.combo.padEnd(11)}  OOS $${m.oosPerDay.toFixed(2)}/day (${sign}$${deltaOOS.toFixed(2)} vs baseline)` +
    `  |  Full $${m.perDay.toFixed(2)}/day  |  PF ${m.pf.toFixed(2)}  |  DD $${m.maxDD.toFixed(0)}` +
    `  |  ${cfg.desc}`,
  );
}

console.log("\nDone.");
