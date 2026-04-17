/**
 * INDEPENDENT Trail + Re-entry Backtest
 * True chronological event-driven simulation walking 1m bars.
 * Engine logic lifted from bt-trail-full-ensemble.ts (audited).
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-trail-reentry-independent.ts
 */

import * as fs from "fs";
import * as path from "path";

// --------------- constants ---------------
interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MIN_1 = 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_POS = 20;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// engine sizes
const SIZE_A = 2;
const SIZE_B = 3;
const SIZE_C = 9;
const SIZE_D = 3;

// half-spreads (same as audited file)
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

// --------------- data loading ---------------
function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
    )
    .sort((a: C, b: C) => a.t - b.t);
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

// --------------- indicators ---------------
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
  }
  return atr;
}

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

function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}

function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } {
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
    ub[i] = u;
    lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j - 1].c - 1;
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

// --------------- cost helpers ---------------
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
function calcPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// --------------- load all data ---------------
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); console.log(`  ${p}: ${d.length} 1m bars`); }
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// --------------- BTC filter: 4h EMA(12) > EMA(21) ---------------
const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

// Strict < for incomplete bar exclusion (binary search)
function btcBullish(t: number): boolean {
  // Find last bar with ts < t
  let lo = 0, hi = btcH4.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH4[mid].t < t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

// BTC h1 for GARCH
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21h = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21h[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21h[prev]) return "short";
  return null;
}

console.log("Data loaded.\n");

// --------------- pre-compute per-pair indicator arrays ---------------
// This avoids recomputing on every check interval.

interface PairIndicators {
  // daily
  daily: C[];
  dailyFast: number[];   // SMA 20
  dailySlow: number[];    // SMA 50
  dailyATR: number[];
  dailyTsMap: Map<number, number>;

  // 4h
  h4: C[];
  h4StDir: number[];
  h4ATR: number[];
  h4TsMap: Map<number, number>;

  // 1h
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;

  // 4h z-scores
  h4Z: number[];

  // 1m - reference only (stored in raw1m)
  bars1m: C[];
}

// Binary search for 1m bar at exact timestamp
function bsearch1m(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const pairInd = new Map<string, PairIndicators>();

for (const pair of PAIRS) {
  const daily = dailyData.get(pair) ?? [];
  const closes = daily.map(c => c.c);
  const dailyFast = calcSMA(closes, 20);
  const dailySlow = calcSMA(closes, 50);
  const dailyATR = calcATR(daily, 14);

  const h4 = h4Data.get(pair) ?? [];
  const { dir: h4StDir } = calcSupertrend(h4, 14, 1.75);
  const h4ATR = calcATR(h4, 14);

  const h1 = h1Data.get(pair) ?? [];
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9 = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);

  const h4Z = computeZScores(h4, 3, 20);

  // Build timestamp-to-index maps for O(1) bar lookups
  const dailyTsMap = new Map<number, number>();
  daily.forEach((c, i) => dailyTsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  const bars1m = raw1m.get(pair) ?? [];

  // Momentum Confirm auxiliary data is computed inline

  pairInd.set(pair, {
    daily, dailyFast, dailySlow, dailyATR, dailyTsMap,
    h4, h4StDir, h4ATR, h4TsMap,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap,
    h4Z,
    bars1m,
  });
}

// --------------- engine signal checkers ---------------
// These return whether a fresh entry/re-entry signal is active at time `t`.
// They also return the SL and entry price (the open of the triggering bar).

interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: string;
  size: number;
}

// Engine A: Donchian - check at daily boundaries
function checkDonchian(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  if (cs.length < 65) return null;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined || barIdx < 51) return null;

  const i = barIdx;
  const p = i - 1;
  const pp = i - 2;
  if (pp < 0 || ind.dailyFast[p] === 0 || ind.dailySlow[p] === 0 || ind.dailyFast[pp] === 0 || ind.dailySlow[pp] === 0) return null;

  let dir: "long" | "short" | null = null;
  if (ind.dailyFast[pp] <= ind.dailySlow[pp] && ind.dailyFast[p] > ind.dailySlow[p]) dir = "long";
  else if (ind.dailyFast[pp] >= ind.dailySlow[pp] && ind.dailyFast[p] < ind.dailySlow[p]) dir = "short";
  if (!dir) return null;
  if (dir === "long" && !btcBullish(cs[i].t)) return null;

  const prevATR = ind.dailyATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl, engine: "A", size: SIZE_A };
}

// For Donchian re-entry: SMA cross must STILL be in effect (fast > slow for long, fast < slow for short)
function checkDonchianReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  if (cs.length < 65) return null;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined || barIdx < 51) return null;

  const i = barIdx;
  const p = i - 1; // last completed bar
  if (p < 0 || ind.dailyFast[p] === 0 || ind.dailySlow[p] === 0) return null;

  // Signal still active = SMA still crossed in the right direction
  if (wantDir === "long" && ind.dailyFast[p] <= ind.dailySlow[p]) return null;
  if (wantDir === "short" && ind.dailyFast[p] >= ind.dailySlow[p]) return null;
  if (wantDir === "long" && !btcBullish(cs[i].t)) return null;

  const prevATR = ind.dailyATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir: wantDir, entryPrice: ep, sl, engine: "A", size: SIZE_A };
}

// Engine B: Supertrend - check at 4h boundaries
function checkSupertrend(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;

  const i = barIdx;
  // Flip = direction changed between bar i-2 and i-1 (completed bars)
  const flip = ind.h4StDir[i - 1] !== ind.h4StDir[i - 2];
  if (!flip) return null;

  const dir: "long" | "short" = ind.h4StDir[i - 1] === 1 ? "long" : "short";
  if (dir === "long" && !btcBullish(cs[i].t)) return null;

  const prevATR = ind.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl, engine: "B", size: SIZE_B };
}

// Supertrend re-entry: ST direction must still match
function checkSupertrendReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;

  const i = barIdx;
  // ST direction on most recent completed bar must match desired direction
  const stActive = ind.h4StDir[i - 1] === (wantDir === "long" ? 1 : -1);
  if (!stActive) return null;
  if (wantDir === "long" && !btcBullish(cs[i].t)) return null;

  const prevATR = ind.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir: wantDir, entryPrice: ep, sl, engine: "B", size: SIZE_B };
}

// Engine C: GARCH v2 - check at 1h boundaries
function checkGarchV2(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;

  const i = barIdx;
  const prev = i - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong = z1 > 4.5;
  const goShort = z1 < -3.0;
  if (!goLong && !goShort) return null;

  // 4h z check
  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong && z4 <= 3.0) return null;
  if (goShort && z4 >= -3.0) return null;

  // EMA filter
  const i9 = prev;
  const i21 = prev;
  if (i9 < 0 || i21 < 0) return null;
  if (ind.h1Ema9[i9] === 0 || ind.h1Ema21[i21] === 0) return null;
  if (goLong && ind.h1Ema9[i9] <= ind.h1Ema21[i21]) return null;
  if (goShort && ind.h1Ema9[i9] >= ind.h1Ema21[i21]) return null;

  // BTC h1 trend
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong && btcT !== "long") return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[i].o;
  let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl, engine: "C", size: SIZE_C };
}

// GARCH re-entry: z-scores must STILL be extreme
function checkGarchV2Reentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  // Same as fresh entry but only for the wanted direction
  const sig = checkGarchV2(pair, t);
  if (!sig) return null;
  if (sig.dir !== wantDir) return null;
  return sig;
}

// Engine D: Momentum Confirm - check at 4h boundaries
function checkMomentumConfirm(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 55) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 52) return null;

  const i = barIdx;
  const prev = i - 1;

  // Volume z-score (range proxy)
  const ranges: number[] = [];
  for (let j = prev - 20; j <= prev; j++) {
    if (j >= 0) ranges.push(cs[j].h - cs[j].l);
  }
  if (ranges.length < 20) return null;
  const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
  const rStd = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
  const volZ = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;

  // Funding proxy z-score
  const fp: number[] = [];
  for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
  if (fp.length < 20) return null;
  const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
  const fpStd = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
  const fundZ = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;

  // Price extension z-score
  const closes: number[] = [];
  for (let j = prev - 20; j <= prev; j++) {
    if (j >= 0) closes.push(cs[j].c);
  }
  if (closes.length < 20) return null;
  const cMean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const cStd = Math.sqrt(closes.reduce((s, v) => s + (v - cMean) ** 2, 0) / closes.length);
  const priceZ = cStd > 0 ? (closes[closes.length - 1] - cMean) / cStd : 0;

  let dir: "long" | "short" | null = null;
  if (volZ > 2 && fundZ > 2 && priceZ > 1) {
    if (btcBullish(cs[i].t)) dir = "long";
  } else if (volZ > 2 && fundZ < -2 && priceZ < -1) {
    dir = "short";
  }
  if (!dir) return null;

  const ep = cs[i].o;
  let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl, engine: "D", size: SIZE_D };
}

// Momentum re-entry: all 3 z-scores must still be extreme
function checkMomentumReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const sig = checkMomentumConfirm(pair, t);
  if (!sig) return null;
  if (sig.dir !== wantDir) return null;
  return sig;
}

// --------------- exit condition checkers ---------------
// Donchian: check on daily bar - Donchian channel exit or max hold
function checkDonchianExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined) return null;
  const bar = cs[barIdx];

  // Max hold 60d
  if (Math.round((bar.t - entryTime) / D) >= 60) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  // Donchian channel exit (15-bar lookback on closes)
  if (barIdx >= 16) {
    if (dir === "long") {
      const lo = donchCloseLow(cs, barIdx, 15);
      if (bar.c < lo) return { exit: true, price: bar.c, reason: "ch" };
    } else {
      const hi = donchCloseHigh(cs, barIdx, 15);
      if (bar.c > hi) return { exit: true, price: bar.c, reason: "ch" };
    }
  }

  return null;
}

// Supertrend: flip on 4h bar or max hold
function checkSupertrendExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const bar = cs[barIdx];

  // Max hold 60d (1440h)
  if ((bar.t - entryTime) / H >= 60 * 24) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  // Flip
  const flip = ind.h4StDir[barIdx - 1] !== ind.h4StDir[barIdx - 2];
  if (flip) {
    return { exit: true, price: bar.o, reason: "flip" };
  }

  return null;
}

// GARCH: max hold 96h, TP 7%
function checkGarchExit(pair: string, t: number, dir: "long" | "short", entryTime: number, entryPrice: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined) return null;
  const bar = h1[barIdx];

  // Max hold 96h
  if ((bar.t - entryTime) / H >= 96) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  // TP 7%
  const tp = dir === "long" ? entryPrice * 1.07 : entryPrice * 0.93;
  if (dir === "long" && bar.h >= tp) return { exit: true, price: tp, reason: "tp" };
  if (dir === "short" && bar.l <= tp) return { exit: true, price: tp, reason: "tp" };

  return null;
}

// Momentum: max hold 48h
function checkMomentumExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined) return null;
  const bar = cs[barIdx];

  if ((bar.t - entryTime) / H >= 48) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  return null;
}

// --------------- position type ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  engine: string;
  size: number;
  entryPrice: number;    // raw price (before spread)
  effectiveEP: number;   // after spread
  sl: number;
  entryTime: number;
  peakPnlPct: number;
  isReentry: boolean;
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  engine: string;
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  isReentry: boolean;
}

interface PendingReentry {
  pair: string;
  dir: "long" | "short";
  engine: string;
  checkTime: number;  // when to check for re-entry
}

// --------------- simulation ---------------
function runSim(
  act: number,  // trail activation %
  dist: number, // trail distance %
  doReentry: boolean,
  startTs: number,
  endTs: number,
): { trades: ClosedTrade[]; reentries: number; blocked: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;

  // Build a sorted list of all 1m timestamps across all pairs + BTC
  // to define the timeline. For memory efficiency, use the global min/max
  // and step by 1 minute.
  const simStart = Math.max(startTs, FULL_START);
  const simEnd = Math.min(endTs, FULL_END);

  // Helper: get 1m bar at time t for pair (binary search)
  function get1mBar(pair: string, t: number): C | null {
    const ind = pairInd.get(pair);
    if (!ind || ind.bars1m.length === 0) return null;
    const idx = bsearch1m(ind.bars1m, t);
    if (idx < 0) return null;
    return ind.bars1m[idx];
  }

  // Track which engine:pair combos are open
  function posKey(engine: string, pair: string): string { return `${engine}:${pair}`; }
  function hasOpenPos(engine: string, pair: string): boolean {
    return openPositions.some(p => p.engine === engine && p.pair === pair);
  }

  // Engine check intervals
  function isDailyBoundary(t: number): boolean { return t % D === 0; }
  function is4hBoundary(t: number): boolean { return t % H4 === 0; }
  function is1hBoundary(t: number): boolean { return t % H === 0; }

  // Close a position
  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = pos.size * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir, engine: pos.engine,
      entryTime: pos.entryTime, exitTime, pnl, reason,
      isReentry: pos.isReentry,
    });

    // Schedule re-entry if trail exit and reentry enabled
    if (reason === "trail" && doReentry) {
      let checkTime: number;
      if (pos.engine === "A") checkTime = (Math.floor(exitTime / D) + 1) * D;       // next daily
      else if (pos.engine === "B") checkTime = (Math.floor(exitTime / H4) + 1) * H4; // next 4h
      else if (pos.engine === "C") checkTime = (Math.floor(exitTime / H) + 1) * H;   // next 1h
      else checkTime = (Math.floor(exitTime / H4) + 1) * H4;                         // D: next 4h
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }

    openPositions.splice(idx, 1);
  }

  // Try to open a position
  function tryOpen(sig: SignalResult, pair: string, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= MAX_POS) { blockedCount++; return false; }
    if (hasOpenPos(sig.engine, pair)) { blockedCount++; return false; }
    const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
    openPositions.push({
      pair, dir: sig.dir, engine: sig.engine, size: sig.size,
      entryPrice: sig.entryPrice, effectiveEP: ep, sl: sig.sl,
      entryTime: t, peakPnlPct: 0, isReentry,
    });
    if (isReentry) reentryCount++;
    return true;
  }

  // Main simulation loop
  // Step through time at 1-minute resolution
  // For efficiency: only iterate minutes where we have data (skip gaps)
  // But we NEED to check engine boundaries even without 1m bars for all pairs.
  // So we step every minute in range.

  // Progress tracking
  const totalMinutes = (simEnd - simStart) / MIN_1;
  let lastPct = -1;

  for (let t = simStart; t < simEnd; t += MIN_1) {
    // Progress every 5%
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // --- 1) Check SL, TP, trail for all open positions ---
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get1mBar(pos.pair, t);
      if (!bar) continue;

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // GARCH TP check (7%)
      if (pos.engine === "C") {
        const tp = pos.dir === "long" ? pos.entryPrice * 1.07 : pos.entryPrice * 0.93;
        if (pos.dir === "long" && bar.h >= tp) {
          closePos(pi, t, tp, "tp", false);
          continue;
        }
        if (pos.dir === "short" && bar.l <= tp) {
          closePos(pi, t, tp, "tp", false);
          continue;
        }
      }

      // Peak tracking
      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      // Trail check
      if (act > 0 && pos.peakPnlPct >= act) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - dist) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
      }
    }

    // --- 2) Engine-specific exits at their check intervals ---
    if (isDailyBoundary(t)) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine !== "A") continue;
        const ex = checkDonchianExit(pos.pair, t, pos.dir, pos.entryTime);
        if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
      }
    }

    if (is4hBoundary(t)) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine === "B") {
          const ex = checkSupertrendExit(pos.pair, t, pos.dir, pos.entryTime);
          if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
        }
        if (pos.engine === "D") {
          const ex = checkMomentumExit(pos.pair, t, pos.dir, pos.entryTime);
          if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
        }
      }
    }

    if (is1hBoundary(t)) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine !== "C") continue;
        const ex = checkGarchExit(pos.pair, t, pos.dir, pos.entryTime, pos.entryPrice);
        if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
      }
    }

    // --- 3) Check for new entries at engine intervals ---
    if (isDailyBoundary(t)) {
      for (const pair of PAIRS) {
        const sig = checkDonchian(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    if (is4hBoundary(t)) {
      for (const pair of PAIRS) {
        const sig = checkSupertrend(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
      for (const pair of PAIRS) {
        const sig = checkMomentumConfirm(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    if (is1hBoundary(t)) {
      for (const pair of PAIRS) {
        const sig = checkGarchV2(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    // --- 4) Check pending re-entries ---
    if (doReentry && pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;

        // Check if this is the right engine boundary
        let isBoundary = false;
        if (re.engine === "A" && isDailyBoundary(t)) isBoundary = true;
        else if (re.engine === "B" && is4hBoundary(t)) isBoundary = true;
        else if (re.engine === "C" && is1hBoundary(t)) isBoundary = true;
        else if (re.engine === "D" && is4hBoundary(t)) isBoundary = true;
        if (!isBoundary) continue;

        // Remove from pending
        pendingReentries.splice(ri, 1);

        // Check re-entry signal
        let sig: SignalResult | null = null;
        if (re.engine === "A") sig = checkDonchianReentry(re.pair, t, re.dir);
        else if (re.engine === "B") sig = checkSupertrendReentry(re.pair, t, re.dir);
        else if (re.engine === "C") sig = checkGarchV2Reentry(re.pair, t, re.dir);
        else if (re.engine === "D") sig = checkMomentumReentry(re.pair, t, re.dir);

        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  // Close any remaining open positions at simEnd
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    // Get last known price
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars1m.length === 0) continue;
    const lastBar = ind.bars1m[ind.bars1m.length - 1];
    closePos(pi, simEnd, lastBar.c, "eop", false);
  }

  return { trades: closedTrades, reentries: reentryCount, blocked: blockedCount };
}

// --------------- metrics computation ---------------
interface Metrics {
  label: string;
  trades: number;
  reentries: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  blocked: number;
  trailExits: number;
  oosTotal: number;
  oosPerDay: number;
  oosPf: number;
}

function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number): {
  wr: number; pf: number; total: number; perDay: number; maxDD: number; sharpe: number; trailExits: number;
} {
  const days = (endTs - startTs) / D;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // MaxDD on chronological cumulative equity
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Daily Sharpe
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const trailExits = trades.filter(t => t.reason === "trail").length;

  return {
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits,
  };
}

// --------------- run configs ---------------
console.log("Running chronological simulation...\n");

const configs: { label: string; act: number; dist: number; reentry: boolean }[] = [
  { label: "NO TRAIL",         act: 0,  dist: 0,  reentry: false },
  { label: "20/5+RE",          act: 20, dist: 5,  reentry: true },
  { label: "30/7+RE",          act: 30, dist: 7,  reentry: true },
  { label: "40/10+RE",         act: 40, dist: 10, reentry: true },
];

const results: Metrics[] = [];
const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

for (const cfg of configs) {
  process.stdout.write(`${cfg.label}...`);

  // Full period
  const full = runSim(cfg.act, cfg.dist, cfg.reentry, FULL_START, FULL_END);
  const fullMetrics = computeMetrics(full.trades, FULL_START, FULL_END);

  // OOS period (filter trades by entry time)
  const oosTrades = full.trades.filter(t => t.entryTime >= OOS_START);
  const oosMetrics = computeMetrics(oosTrades, OOS_START, FULL_END);

  results.push({
    label: cfg.label,
    trades: full.trades.length,
    reentries: full.reentries,
    wr: fullMetrics.wr,
    pf: fullMetrics.pf,
    total: fullMetrics.total,
    perDay: fullMetrics.perDay,
    maxDD: fullMetrics.maxDD,
    sharpe: fullMetrics.sharpe,
    blocked: full.blocked,
    trailExits: fullMetrics.trailExits,
    oosTotal: oosMetrics.total,
    oosPerDay: oosMetrics.perDay,
    oosPf: oosMetrics.pf,
  });

  console.log(` ${full.trades.length} trades (${full.reentries} re-entries), $${fullMetrics.perDay.toFixed(2)}/day, DD $${fullMetrics.maxDD.toFixed(0)}, PF ${fullMetrics.pf.toFixed(2)}`);
}

// --------------- print results ---------------
console.log("\n" + "=".repeat(160));
console.log("INDEPENDENT TRAIL + RE-ENTRY BACKTEST (Chronological 1m Event-Driven)");
console.log("Engines: A=$2 Donchian SMA20/50 | B=$3 Supertrend 14/1.75 | C=$9 GARCH v2 | D=$3 Momentum | BTC 4h EMA(12)>EMA(21) | 23 pairs | Max 20 pos");
console.log("Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("=".repeat(160));

const hdr = [
  "Config".padEnd(14),
  "Trades".padStart(7),
  "Re-ent".padStart(7),
  "WR%".padStart(7),
  "Total".padStart(12),
  "$/day".padStart(10),
  "PF".padStart(7),
  "Sharpe".padStart(8),
  "MaxDD".padStart(10),
  "Blocked".padStart(8),
  "Trails".padStart(7),
  "OOS$/day".padStart(10),
  "OOS PF".padStart(8),
].join(" ");
console.log(`\n${hdr}`);
console.log("-".repeat(160));

for (const r of results) {
  const mark = r.label === "NO TRAIL" ? " <<<" : "";
  console.log([
    r.label.padEnd(14),
    String(r.trades).padStart(7),
    String(r.reentries).padStart(7),
    r.wr.toFixed(1).padStart(6) + "%",
    ("$" + r.total.toFixed(2)).padStart(12),
    ("$" + r.perDay.toFixed(2)).padStart(10),
    r.pf.toFixed(2).padStart(7),
    r.sharpe.toFixed(2).padStart(8),
    ("$" + r.maxDD.toFixed(0)).padStart(10),
    String(r.blocked).padStart(8),
    String(r.trailExits).padStart(7),
    ("$" + r.oosPerDay.toFixed(2)).padStart(10),
    r.oosPf.toFixed(2).padStart(8),
  ].join(" ") + mark);
}

// Summary
console.log("\n" + "=".repeat(160));
const noTrail = results.find(r => r.label === "NO TRAIL")!;
const bestTrail = results.filter(r => r.label !== "NO TRAIL").sort((a, b) => b.perDay - a.perDay)[0];
console.log(`NO TRAIL:    $${noTrail.perDay.toFixed(2)}/day, MaxDD $${noTrail.maxDD.toFixed(0)}, Sharpe ${noTrail.sharpe.toFixed(2)}, OOS $${noTrail.oosPerDay.toFixed(2)}/day`);
if (bestTrail) {
  console.log(`BEST TRAIL:  ${bestTrail.label}: $${bestTrail.perDay.toFixed(2)}/day (${bestTrail.reentries} re-entries), MaxDD $${bestTrail.maxDD.toFixed(0)}, Sharpe ${bestTrail.sharpe.toFixed(2)}, OOS $${bestTrail.oosPerDay.toFixed(2)}/day`);
  const diff = bestTrail.perDay - noTrail.perDay;
  const pctDiff = noTrail.perDay !== 0 ? ((diff / Math.abs(noTrail.perDay)) * 100) : 0;
  console.log(`TRAIL DIFF:  ${diff >= 0 ? "+" : ""}$${diff.toFixed(2)}/day (${pctDiff >= 0 ? "+" : ""}${pctDiff.toFixed(0)}% vs no-trail)`);
}

// Per-engine breakdown for no-trail
console.log("\nPer-engine breakdown (NO TRAIL, full period):");
const noTrailTrades = results[0]; // first config is NO TRAIL
// Rerun to get trades detail - use the full run data
const fullRun = runSim(0, 0, false, FULL_START, FULL_END);
for (const eng of ["A", "B", "C", "D"]) {
  const et = fullRun.trades.filter(t => t.engine === eng);
  const wins = et.filter(t => t.pnl > 0);
  const losses = et.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = et.reduce((s, t) => s + t.pnl, 0);
  const pf = gl > 0 ? gp / gl : 99;
  const perDay = total / fullDays;
  console.log(`  Engine ${eng}: ${et.length} trades, $${perDay.toFixed(2)}/day, PF ${pf.toFixed(2)}, WR ${et.length > 0 ? ((wins.length / et.length) * 100).toFixed(1) : "0"}%`);
}

console.log("\nDone.");
