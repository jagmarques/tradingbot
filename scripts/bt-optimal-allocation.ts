/**
 * Optimal Engine Allocation Backtest
 * Systematic phase-by-phase search for best $/day with MaxDD < $100.
 *
 * Phase 1: GARCH-only at various sizes and max positions
 * Phase 2: Best GARCH + Supertrend
 * Phase 3: Phase 2 winners + Donchian / Momentum
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-optimal-allocation.ts
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

// Trail config fixed per task spec
const TRAIL_ACT = 40;
const TRAIL_DIST = 3;
const DO_REENTRY = true;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// half-spreads
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

// --------------- load all data once ---------------
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) raw1m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// --------------- BTC filter ---------------
const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

function btcBullish(t: number): boolean {
  let lo = 0, hi = btcH4.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH4[mid].t < t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

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

// --------------- pre-compute per-pair indicators ---------------
interface PairIndicators {
  daily: C[];
  dailyFast: number[];
  dailySlow: number[];
  dailyATR: number[];
  dailyTsMap: Map<number, number>;
  h4: C[];
  h4StDir: number[];
  h4ATR: number[];
  h4TsMap: Map<number, number>;
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4Z: number[];
  bars1m: C[];
}

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

  const dailyTsMap = new Map<number, number>();
  daily.forEach((c, i) => dailyTsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  const bars1m = raw1m.get(pair) ?? [];

  pairInd.set(pair, {
    daily, dailyFast, dailySlow, dailyATR, dailyTsMap,
    h4, h4StDir, h4ATR, h4TsMap,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap,
    h4Z,
    bars1m,
  });
}

// --------------- engine sizes (per-run config) ---------------
interface EngineConfig {
  sizeA: number;  // Donchian
  sizeB: number;  // Supertrend
  sizeC: number;  // GARCH
  sizeD: number;  // Momentum
  maxPos: number;
}

// --------------- signal checkers ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: string;
  size: number;
}

function checkDonchian(pair: string, t: number, size: number): SignalResult | null {
  if (size <= 0) return null;
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
  return { dir, entryPrice: ep, sl, engine: "A", size };
}

function checkDonchianReentry(pair: string, t: number, wantDir: "long" | "short", size: number): SignalResult | null {
  if (size <= 0) return null;
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  if (cs.length < 65) return null;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined || barIdx < 51) return null;
  const i = barIdx;
  const p = i - 1;
  if (p < 0 || ind.dailyFast[p] === 0 || ind.dailySlow[p] === 0) return null;
  if (wantDir === "long" && ind.dailyFast[p] <= ind.dailySlow[p]) return null;
  if (wantDir === "short" && ind.dailyFast[p] >= ind.dailySlow[p]) return null;
  if (wantDir === "long" && !btcBullish(cs[i].t)) return null;
  const prevATR = ind.dailyATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);
  return { dir: wantDir, entryPrice: ep, sl, engine: "A", size };
}

function checkSupertrend(pair: string, t: number, size: number): SignalResult | null {
  if (size <= 0) return null;
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const i = barIdx;
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
  return { dir, entryPrice: ep, sl, engine: "B", size };
}

function checkSupertrendReentry(pair: string, t: number, wantDir: "long" | "short", size: number): SignalResult | null {
  if (size <= 0) return null;
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const i = barIdx;
  const stActive = ind.h4StDir[i - 1] === (wantDir === "long" ? 1 : -1);
  if (!stActive) return null;
  if (wantDir === "long" && !btcBullish(cs[i].t)) return null;
  const prevATR = ind.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);
  return { dir: wantDir, entryPrice: ep, sl, engine: "B", size };
}

function checkGarchV2(pair: string, t: number, size: number): SignalResult | null {
  if (size <= 0) return null;
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
  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong && z4 <= 3.0) return null;
  if (goShort && z4 >= -3.0) return null;
  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong && btcT !== "long") return null;
  if (goShort && btcT !== "short") return null;
  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[i].o;
  let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);
  return { dir, entryPrice: ep, sl, engine: "C", size };
}

function checkGarchV2Reentry(pair: string, t: number, wantDir: "long" | "short", size: number): SignalResult | null {
  const sig = checkGarchV2(pair, t, size);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

function checkMomentumConfirm(pair: string, t: number, size: number): SignalResult | null {
  if (size <= 0) return null;
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 55) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 52) return null;
  const i = barIdx;
  const prev = i - 1;
  const ranges: number[] = [];
  for (let j = prev - 20; j <= prev; j++) {
    if (j >= 0) ranges.push(cs[j].h - cs[j].l);
  }
  if (ranges.length < 20) return null;
  const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
  const rStd = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
  const volZ = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;
  const fp: number[] = [];
  for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
  if (fp.length < 20) return null;
  const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
  const fpStd = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
  const fundZ = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;
  const clArr: number[] = [];
  for (let j = prev - 20; j <= prev; j++) {
    if (j >= 0) clArr.push(cs[j].c);
  }
  if (clArr.length < 20) return null;
  const cMean = clArr.reduce((s, v) => s + v, 0) / clArr.length;
  const cStd = Math.sqrt(clArr.reduce((s, v) => s + (v - cMean) ** 2, 0) / clArr.length);
  const priceZ = cStd > 0 ? (clArr[clArr.length - 1] - cMean) / cStd : 0;
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
  return { dir, entryPrice: ep, sl, engine: "D", size };
}

function checkMomentumReentry(pair: string, t: number, wantDir: "long" | "short", size: number): SignalResult | null {
  const sig = checkMomentumConfirm(pair, t, size);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

// --------------- exit checkers ---------------
function checkDonchianExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined) return null;
  const bar = cs[barIdx];
  if (Math.round((bar.t - entryTime) / D) >= 60) return { exit: true, price: bar.c, reason: "mh" };
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

function checkSupertrendExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const bar = cs[barIdx];
  if ((bar.t - entryTime) / H >= 60 * 24) return { exit: true, price: bar.c, reason: "mh" };
  const flip = ind.h4StDir[barIdx - 1] !== ind.h4StDir[barIdx - 2];
  if (flip) return { exit: true, price: bar.o, reason: "flip" };
  return null;
}

function checkGarchExit(pair: string, t: number, dir: "long" | "short", entryTime: number, entryPrice: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined) return null;
  const bar = h1[barIdx];
  if ((bar.t - entryTime) / H >= 96) return { exit: true, price: bar.c, reason: "mh" };
  const tp = dir === "long" ? entryPrice * 1.07 : entryPrice * 0.93;
  if (dir === "long" && bar.h >= tp) return { exit: true, price: tp, reason: "tp" };
  if (dir === "short" && bar.l <= tp) return { exit: true, price: tp, reason: "tp" };
  return null;
}

function checkMomentumExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined) return null;
  const bar = cs[barIdx];
  if ((bar.t - entryTime) / H >= 48) return { exit: true, price: bar.c, reason: "mh" };
  return null;
}

// --------------- position types ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  engine: string;
  size: number;
  entryPrice: number;
  effectiveEP: number;
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
  checkTime: number;
}

// --------------- simulation engine ---------------
function runSim(cfg: EngineConfig): ClosedTrade[] {
  const { sizeA, sizeB, sizeC, sizeD, maxPos } = cfg;
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];

  function get1mBar(pair: string, t: number): C | null {
    const ind = pairInd.get(pair);
    if (!ind || ind.bars1m.length === 0) return null;
    const idx = bsearch1m(ind.bars1m, t);
    if (idx < 0) return null;
    return ind.bars1m[idx];
  }

  function hasOpenPos(engine: string, pair: string): boolean {
    return openPositions.some(p => p.engine === engine && p.pair === pair);
  }

  function isDailyBoundary(t: number): boolean { return t % D === 0; }
  function is4hBoundary(t: number): boolean { return t % H4 === 0; }
  function is1hBoundary(t: number): boolean { return t % H === 0; }

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
    if (reason === "trail" && DO_REENTRY) {
      let checkTime: number;
      if (pos.engine === "A") checkTime = (Math.floor(exitTime / D) + 1) * D;
      else if (pos.engine === "B") checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      else if (pos.engine === "C") checkTime = (Math.floor(exitTime / H) + 1) * H;
      else checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }
    openPositions.splice(idx, 1);
  }

  function tryOpen(sig: SignalResult, pair: string, t: number, isReentry: boolean): void {
    if (openPositions.length >= maxPos) return;
    if (hasOpenPos(sig.engine, pair)) return;
    const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
    openPositions.push({
      pair, dir: sig.dir, engine: sig.engine, size: sig.size,
      entryPrice: sig.entryPrice, effectiveEP: ep, sl: sig.sl,
      entryTime: t, peakPnlPct: 0, isReentry,
    });
  }

  for (let t = FULL_START; t < FULL_END; t += MIN_1) {
    // 1) SL, trail, TP checks
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get1mBar(pos.pair, t);
      if (!bar) continue;

      if (pos.dir === "long" && bar.l <= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }
      if (pos.dir === "short" && bar.h >= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }

      if (pos.engine === "C") {
        const tp = pos.dir === "long" ? pos.entryPrice * 1.07 : pos.entryPrice * 0.93;
        if (pos.dir === "long" && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
        if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }
      }

      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      if (TRAIL_ACT > 0 && pos.peakPnlPct >= TRAIL_ACT) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - TRAIL_DIST) { closePos(pi, t, bar.c, "trail", false); continue; }
      }
    }

    // 2) Engine-specific exits
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

    // 3) New entries
    if (isDailyBoundary(t) && sizeA > 0) {
      for (const pair of PAIRS) {
        const sig = checkDonchian(pair, t, sizeA);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }
    if (is4hBoundary(t)) {
      if (sizeB > 0) {
        for (const pair of PAIRS) {
          const sig = checkSupertrend(pair, t, sizeB);
          if (sig) tryOpen(sig, pair, t, false);
        }
      }
      if (sizeD > 0) {
        for (const pair of PAIRS) {
          const sig = checkMomentumConfirm(pair, t, sizeD);
          if (sig) tryOpen(sig, pair, t, false);
        }
      }
    }
    if (is1hBoundary(t) && sizeC > 0) {
      for (const pair of PAIRS) {
        const sig = checkGarchV2(pair, t, sizeC);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    // 4) Re-entries
    if (DO_REENTRY && pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;
        let isBoundary = false;
        if (re.engine === "A" && isDailyBoundary(t)) isBoundary = true;
        else if (re.engine === "B" && is4hBoundary(t)) isBoundary = true;
        else if (re.engine === "C" && is1hBoundary(t)) isBoundary = true;
        else if (re.engine === "D" && is4hBoundary(t)) isBoundary = true;
        if (!isBoundary) continue;
        pendingReentries.splice(ri, 1);
        let sig: SignalResult | null = null;
        if (re.engine === "A") sig = checkDonchianReentry(re.pair, t, re.dir, sizeA);
        else if (re.engine === "B") sig = checkSupertrendReentry(re.pair, t, re.dir, sizeB);
        else if (re.engine === "C") sig = checkGarchV2Reentry(re.pair, t, re.dir, sizeC);
        else if (re.engine === "D") sig = checkMomentumReentry(re.pair, t, re.dir, sizeD);
        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  // Close remaining at end
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars1m.length === 0) continue;
    const lastBar = ind.bars1m[ind.bars1m.length - 1];
    closePos(pi, FULL_END, lastBar.c, "eop", false);
  }

  return closedTrades;
}

// --------------- metrics ---------------
interface RunMetrics {
  trades: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  oosPerDay: number;
  oosPf: number;
}

const FULL_DAYS = (FULL_END - FULL_START) / D;
const OOS_DAYS = (FULL_END - OOS_START) / D;

function computeMetrics(trades: ClosedTrade[]): RunMetrics {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);
  const oosWins = oosTrades.filter(t => t.pnl > 0);
  const oosLosses = oosTrades.filter(t => t.pnl <= 0);
  const oosGp = oosWins.reduce((s, t) => s + t.pnl, 0);
  const oosGl = Math.abs(oosLosses.reduce((s, t) => s + t.pnl, 0));
  const oosTotal = oosTrades.reduce((s, t) => s + t.pnl, 0);

  return {
    trades: trades.length,
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / FULL_DAYS,
    maxDD,
    sharpe,
    oosPerDay: oosTotal / OOS_DAYS,
    oosPf: oosGl > 0 ? oosGp / oosGl : 99,
  };
}

// --------------- config sweep ---------------
interface SweepEntry {
  label: string;
  phase: number;
  sizeA: number;
  sizeB: number;
  sizeC: number;
  sizeD: number;
  maxPos: number;
  metrics: RunMetrics;
}

const allResults: SweepEntry[] = [];
let configNum = 0;

function runConfig(label: string, phase: number, sizeA: number, sizeB: number, sizeC: number, sizeD: number, maxPos: number): SweepEntry {
  configNum++;
  process.stdout.write(`[${configNum}] ${label}...`);
  const trades = runSim({ sizeA, sizeB, sizeC, sizeD, maxPos });
  const metrics = computeMetrics(trades);
  const entry: SweepEntry = { label, phase, sizeA, sizeB, sizeC, sizeD, maxPos, metrics };
  allResults.push(entry);
  const ddFlag = metrics.maxDD >= 100 ? " [DD>100]" : "";
  console.log(` ${metrics.trades}tr  $${metrics.perDay.toFixed(2)}/d  DD$${metrics.maxDD.toFixed(0)}  Sharpe${metrics.sharpe.toFixed(2)}  PF${metrics.pf.toFixed(2)}  OOS$${metrics.oosPerDay.toFixed(2)}/d${ddFlag}`);
  return entry;
}

// ===========================================================
// PHASE 1: GARCH-only
// ===========================================================
console.log("\n" + "=".repeat(80));
console.log("PHASE 1: GARCH-only sweep");
console.log("=".repeat(80));

const garchSizes = [9, 12, 15, 18, 21, 25];
const maxPosCandidates = [8, 10, 12, 15, 20];

for (const sC of garchSizes) {
  for (const mp of maxPosCandidates) {
    runConfig(`C$${sC}_mp${mp}`, 1, 0, 0, sC, 0, mp);
  }
}

const phase1Good = allResults
  .filter(r => r.phase === 1 && r.metrics.maxDD < 100)
  .sort((a, b) => b.metrics.perDay - a.metrics.perDay);

console.log(`\nPhase 1: ${phase1Good.length} configs with MaxDD < $100`);
const topP1 = phase1Good.slice(0, 6);
console.log("Top Phase 1 configs:");
for (const r of topP1) {
  console.log(`  ${r.label}: $${r.metrics.perDay.toFixed(2)}/d  DD$${r.metrics.maxDD.toFixed(0)}  PF${r.metrics.pf.toFixed(2)}`);
}

// ===========================================================
// PHASE 2: Best GARCH + Supertrend
// ===========================================================
console.log("\n" + "=".repeat(80));
console.log("PHASE 2: Best GARCH + Supertrend");
console.log("=".repeat(80));

const stSizes = [2, 3, 5];
const p1Seeds = topP1.map(r => ({ sC: r.sizeC, mp: r.maxPos }));

for (const seed of p1Seeds) {
  for (const sB of stSizes) {
    const label = `C$${seed.sC}_B$${sB}_mp${seed.mp}`;
    runConfig(label, 2, 0, sB, seed.sC, 0, seed.mp);
  }
}

const phase2Good = allResults
  .filter(r => r.phase === 2 && r.metrics.maxDD < 100)
  .sort((a, b) => b.metrics.perDay - a.metrics.perDay);

console.log(`\nPhase 2: ${phase2Good.length} configs with MaxDD < $100`);
const topP2 = phase2Good.slice(0, 6);
console.log("Top Phase 2 configs:");
for (const r of topP2) {
  console.log(`  ${r.label}: $${r.metrics.perDay.toFixed(2)}/d  DD$${r.metrics.maxDD.toFixed(0)}  PF${r.metrics.pf.toFixed(2)}`);
}

// ===========================================================
// PHASE 3: Add Donchian and/or Momentum to Phase 2 winners
// ===========================================================
console.log("\n" + "=".repeat(80));
console.log("PHASE 3: Phase 2 winners + Donchian / Momentum");
console.log("=".repeat(80));

const donchSizes = [1, 2];
const momSizes = [1, 3];
const p2Seeds = topP2.map(r => ({ sB: r.sizeB, sC: r.sizeC, mp: r.maxPos }));

// 3a: + Donchian only
for (const seed of p2Seeds) {
  for (const sA of donchSizes) {
    runConfig(`A$${sA}_C$${seed.sC}_B$${seed.sB}_mp${seed.mp}`, 3, sA, seed.sB, seed.sC, 0, seed.mp);
  }
}

// 3b: + Momentum only
for (const seed of p2Seeds) {
  for (const sD of momSizes) {
    runConfig(`C$${seed.sC}_B$${seed.sB}_D$${sD}_mp${seed.mp}`, 3, 0, seed.sB, seed.sC, sD, seed.mp);
  }
}

// 3c: + both (top 3 seeds only to keep runtime manageable)
for (const seed of p2Seeds.slice(0, 3)) {
  for (const sA of donchSizes) {
    for (const sD of momSizes) {
      runConfig(`A$${sA}_C$${seed.sC}_B$${seed.sB}_D$${sD}_mp${seed.mp}`, 3, sA, seed.sB, seed.sC, sD, seed.mp);
    }
  }
}

// ===========================================================
// FINAL RESULTS TABLE
// ===========================================================
console.log("\n\n" + "=".repeat(145));
console.log("OPTIMAL ALLOCATION - TOP 10 BY $/DAY (MaxDD < $100) | Trail 40/3 + Reentry | BTC 4h EMA(12>21) | 2023-01 to 2026-03 | OOS 2025-09+");
console.log("=".repeat(145));

const allGood = allResults
  .filter(r => r.metrics.maxDD < 100)
  .sort((a, b) => b.metrics.perDay - a.metrics.perDay);

const top10 = allGood.slice(0, 10);

const hdr = [
  "Rank".padEnd(4),
  "Label".padEnd(38),
  "Ph".padStart(3),
  "A$".padStart(4),
  "B$".padStart(4),
  "C$".padStart(4),
  "D$".padStart(4),
  "MP".padStart(4),
  "Trades".padStart(7),
  "WR%".padStart(6),
  "$/day".padStart(8),
  "Total$".padStart(9),
  "MaxDD".padStart(7),
  "Sharpe".padStart(8),
  "PF".padStart(6),
  "OOS$/d".padStart(8),
  "OOSPF".padStart(7),
].join(" ");
console.log("\n" + hdr);
console.log("-".repeat(145));

let rank = 1;
for (const r of top10) {
  const m = r.metrics;
  console.log([
    String(rank++).padEnd(4),
    r.label.padEnd(38),
    String(r.phase).padStart(3),
    String(r.sizeA).padStart(4),
    String(r.sizeB).padStart(4),
    String(r.sizeC).padStart(4),
    String(r.sizeD).padStart(4),
    String(r.maxPos).padStart(4),
    String(m.trades).padStart(7),
    m.wr.toFixed(1).padStart(5) + "%",
    ("$" + m.perDay.toFixed(2)).padStart(8),
    ("$" + m.total.toFixed(0)).padStart(9),
    ("$" + m.maxDD.toFixed(0)).padStart(7),
    m.sharpe.toFixed(2).padStart(8),
    m.pf.toFixed(2).padStart(6),
    ("$" + m.oosPerDay.toFixed(2)).padStart(8),
    m.oosPf.toFixed(2).padStart(7),
  ].join(" "));
}

// Phase 1 reference table
console.log("\n\n" + "=".repeat(100));
console.log("ALL PHASE 1 (GARCH-only) RESULTS - sorted by $/day");
console.log("=".repeat(100));
const phase1All = allResults.filter(r => r.phase === 1).sort((a, b) => b.metrics.perDay - a.metrics.perDay);
for (const r of phase1All) {
  const m = r.metrics;
  const ddMark = m.maxDD >= 100 ? " [DD>100]" : "";
  console.log(`  ${r.label.padEnd(16)} $${m.perDay.toFixed(2).padStart(5)}/d  DD$${m.maxDD.toFixed(0).padStart(4)}  PF${m.pf.toFixed(2)}  WR${m.wr.toFixed(1)}%  OOS$${m.oosPerDay.toFixed(2)}/d${ddMark}`);
}

console.log("\n\nDone. Total configs run:", configNum);
