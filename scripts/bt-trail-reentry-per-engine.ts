/**
 * Trail + Re-entry Per-Engine Breakdown
 * Runs baseline (no trail) vs 40/10+reentry and shows per-engine delta.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-trail-reentry-per-engine.ts
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

const SIZE_A = 2;
const SIZE_B = 3;
const SIZE_C = 9;
const SIZE_D = 3;

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
  if (d.length > 0) { raw1m.set(p, d); process.stdout.write(`.`); }
}
console.log();

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

  pairInd.set(pair, {
    daily, dailyFast, dailySlow, dailyATR, dailyTsMap,
    h4, h4StDir, h4ATR, h4TsMap,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap,
    h4Z,
    bars1m: raw1m.get(pair) ?? [],
  });
}

// --------------- signal checkers ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: string;
  size: number;
}

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

function checkDonchianReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
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
  return { dir: wantDir, entryPrice: ep, sl, engine: "A", size: SIZE_A };
}

function checkSupertrend(pair: string, t: number): SignalResult | null {
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
  return { dir, entryPrice: ep, sl, engine: "B", size: SIZE_B };
}

function checkSupertrendReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
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
  return { dir: wantDir, entryPrice: ep, sl, engine: "B", size: SIZE_B };
}

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
  return { dir, entryPrice: ep, sl, engine: "C", size: SIZE_C };
}

function checkGarchV2Reentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const sig = checkGarchV2(pair, t);
  if (!sig) return null;
  if (sig.dir !== wantDir) return null;
  return sig;
}

function checkMomentumConfirm(pair: string, t: number): SignalResult | null {
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
  const closeArr: number[] = [];
  for (let j = prev - 20; j <= prev; j++) {
    if (j >= 0) closeArr.push(cs[j].c);
  }
  if (closeArr.length < 20) return null;
  const cMean = closeArr.reduce((s, v) => s + v, 0) / closeArr.length;
  const cStd = Math.sqrt(closeArr.reduce((s, v) => s + (v - cMean) ** 2, 0) / closeArr.length);
  const priceZ = cStd > 0 ? (closeArr[closeArr.length - 1] - cMean) / cStd : 0;
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

function checkMomentumReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const sig = checkMomentumConfirm(pair, t);
  if (!sig) return null;
  if (sig.dir !== wantDir) return null;
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

// --------------- simulation ---------------
function runSim(
  act: number,
  dist: number,
  doReentry: boolean,
  startTs: number,
  endTs: number,
  label: string,
): { trades: ClosedTrade[]; reentries: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;

  const simStart = Math.max(startTs, FULL_START);
  const simEnd = Math.min(endTs, FULL_END);

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
    if (reason === "trail" && doReentry) {
      let checkTime: number;
      if (pos.engine === "A") checkTime = (Math.floor(exitTime / D) + 1) * D;
      else if (pos.engine === "B") checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      else if (pos.engine === "C") checkTime = (Math.floor(exitTime / H) + 1) * H;
      else checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }
    openPositions.splice(idx, 1);
  }

  function tryOpen(sig: SignalResult, pair: string, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= MAX_POS) return false;
    if (hasOpenPos(sig.engine, pair)) return false;
    const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
    openPositions.push({
      pair, dir: sig.dir, engine: sig.engine, size: sig.size,
      entryPrice: sig.entryPrice, effectiveEP: ep, sl: sig.sl,
      entryTime: t, peakPnlPct: 0, isReentry,
    });
    if (isReentry) reentryCount++;
    return true;
  }

  let lastPct = -1;
  process.stdout.write(`  ${label}:`);
  for (let t = simStart; t < simEnd; t += MIN_1) {
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(` ${pct}%`); lastPct = pct; }

    // SL, TP, trail checks
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

      if (act > 0 && pos.peakPnlPct >= act) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - dist) { closePos(pi, t, bar.c, "trail", false); continue; }
      }
    }

    // Engine-specific exits
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

    // New entries
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

    // Pending re-entries
    if (doReentry && pendingReentries.length > 0) {
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
        if (re.engine === "A") sig = checkDonchianReentry(re.pair, t, re.dir);
        else if (re.engine === "B") sig = checkSupertrendReentry(re.pair, t, re.dir);
        else if (re.engine === "C") sig = checkGarchV2Reentry(re.pair, t, re.dir);
        else if (re.engine === "D") sig = checkMomentumReentry(re.pair, t, re.dir);
        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  // Close remaining
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars1m.length === 0) continue;
    const lastBar = ind.bars1m[ind.bars1m.length - 1];
    closePos(pi, simEnd, lastBar.c, "eop", false);
  }

  console.log(` done (${closedTrades.length} trades, ${reentryCount} re-entries)`);
  return { trades: closedTrades, reentries: reentryCount };
}

// --------------- per-engine metrics ---------------
interface EngineStats {
  engine: string;
  trades: number;
  wins: number;
  wr: number;
  total: number;
  perDay: number;
  pf: number;
  trailExits: number;
  reentries: number;
}

function engineStats(trades: ClosedTrade[], engine: string, days: number): EngineStats {
  const et = trades.filter(t => t.engine === engine);
  const wins = et.filter(t => t.pnl > 0);
  const losses = et.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = et.reduce((s, t) => s + t.pnl, 0);
  const trailExits = et.filter(t => t.reason === "trail").length;
  const reentries = et.filter(t => t.isReentry).length;
  return {
    engine,
    trades: et.length,
    wins: wins.length,
    wr: et.length > 0 ? (wins.length / et.length) * 100 : 0,
    total,
    perDay: total / days,
    pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0),
    trailExits,
    reentries,
  };
}

// --------------- run ---------------
console.log("Running simulations...\n");

const fullDays = (FULL_END - FULL_START) / D;

const baseline = runSim(0, 0, false, FULL_START, FULL_END, "NO TRAIL (baseline)");
const trail4010 = runSim(40, 10, true, FULL_START, FULL_END, "40/10+RE");

// --------------- print per-engine breakdown ---------------
const ENGINES = [
  { id: "A", name: "Donchian (SMA20/50 daily)" },
  { id: "B", name: "Supertrend (4h 14/1.75)" },
  { id: "C", name: "GARCH v2 (z-score)" },
  { id: "D", name: "Momentum Confirm (4h)" },
];

console.log("\n" + "=".repeat(120));
console.log("PER-ENGINE BREAKDOWN: TRAIL 40/10+REENTRY vs BASELINE");
console.log("Full period: 2023-01 to 2026-03  |  23 pairs  |  Max 20 positions");
console.log("=".repeat(120));

for (const eng of ENGINES) {
  const base = engineStats(baseline.trades, eng.id, fullDays);
  const trail = engineStats(trail4010.trades, eng.id, fullDays);

  const deltaPerDay = trail.perDay - base.perDay;
  const deltaTrades = trail.trades - base.trades;
  const deltaWR = trail.wr - base.wr;
  const deltaPF = trail.pf - base.pf;

  const sign = (v: number) => v >= 0 ? "+" : "";

  console.log(`\nEngine ${eng.id}: ${eng.name}`);
  console.log("-".repeat(90));

  const hdr = [
    "Config".padEnd(16),
    "Trades".padStart(8),
    "WR%".padStart(8),
    "Total $".padStart(10),
    "$/day".padStart(9),
    "PF".padStart(7),
    "Trail exits".padStart(12),
    "Re-entries".padStart(11),
  ].join(" ");
  console.log(hdr);

  const fmtRow = (label: string, s: EngineStats) => [
    label.padEnd(16),
    String(s.trades).padStart(8),
    (s.wr.toFixed(1) + "%").padStart(8),
    ("$" + s.total.toFixed(2)).padStart(10),
    ("$" + s.perDay.toFixed(2)).padStart(9),
    s.pf.toFixed(2).padStart(7),
    String(s.trailExits).padStart(12),
    String(s.reentries).padStart(11),
  ].join(" ");

  console.log(fmtRow("NO TRAIL", base));
  console.log(fmtRow("40/10+RE", trail));

  const deltaRow = [
    "DELTA".padEnd(16),
    (sign(deltaTrades) + deltaTrades).padStart(8),
    (sign(deltaWR) + deltaWR.toFixed(1) + "%").padStart(8),
    (sign(deltaPerDay * fullDays) + "$" + (deltaPerDay * fullDays).toFixed(2)).padStart(10),
    (sign(deltaPerDay) + "$" + deltaPerDay.toFixed(2)).padStart(9),
    (sign(deltaPF) + deltaPF.toFixed(2)).padStart(7),
    "-".padStart(12),
    "-".padStart(11),
  ].join(" ");
  console.log(deltaRow);

  // Verdict
  let verdict: string;
  if (Math.abs(deltaPerDay) < 0.01) {
    verdict = "NEUTRAL - negligible impact";
  } else if (deltaPerDay > 0) {
    verdict = `HELPS +$${deltaPerDay.toFixed(2)}/day (${(deltaPerDay / Math.abs(base.perDay) * 100).toFixed(0)}%)`;
  } else {
    verdict = `HURTS -$${Math.abs(deltaPerDay).toFixed(2)}/day (${(deltaPerDay / Math.abs(base.perDay) * 100).toFixed(0)}%)`;
  }
  console.log(`  Verdict: ${verdict}`);

  // Exit breakdown for trail config
  if (trail.trades > 0) {
    const et = trail4010.trades.filter(t => t.engine === eng.id);
    const reasons = new Map<string, number>();
    for (const t of et) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
    const parts = [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(", ");
    console.log(`  40/10+RE exit breakdown: ${parts}`);

    // Avg PnL per exit type
    const slTrades = et.filter(t => t.reason === "sl");
    const trailTrades = et.filter(t => t.reason === "trail");
    const avgSL = slTrades.length > 0 ? slTrades.reduce((s, t) => s + t.pnl, 0) / slTrades.length : 0;
    const avgTrail = trailTrades.length > 0 ? trailTrades.reduce((s, t) => s + t.pnl, 0) / trailTrades.length : 0;
    if (slTrades.length > 0) console.log(`  Avg SL exit: $${avgSL.toFixed(2)}`);
    if (trailTrades.length > 0) console.log(`  Avg trail exit: $${avgTrail.toFixed(2)}`);

    // Baseline comparison - same exit types
    const etBase = baseline.trades.filter(t => t.engine === eng.id);
    const baseSlTrades = etBase.filter(t => t.reason === "sl");
    const avgBaseSL = baseSlTrades.length > 0 ? baseSlTrades.reduce((s, t) => s + t.pnl, 0) / baseSlTrades.length : 0;
    if (baseSlTrades.length > 0) console.log(`  Baseline avg SL exit: $${avgBaseSL.toFixed(2)}`);
  }
}

// --------------- overall totals ---------------
console.log("\n" + "=".repeat(120));
console.log("OVERALL COMPARISON");
console.log("=".repeat(120));

const baseTotal = baseline.trades.reduce((s, t) => s + t.pnl, 0);
const trailTotal = trail4010.trades.reduce((s, t) => s + t.pnl, 0);
const basePerDay = baseTotal / fullDays;
const trailPerDay = trailTotal / fullDays;

console.log(`\nNO TRAIL:  ${baseline.trades.length} trades, $${baseTotal.toFixed(2)} total, $${basePerDay.toFixed(2)}/day`);
console.log(`40/10+RE:  ${trail4010.trades.length} trades, $${trailTotal.toFixed(2)} total, $${trailPerDay.toFixed(2)}/day  (${trail4010.reentries} re-entries)`);
const overallDelta = trailPerDay - basePerDay;
const sign = overallDelta >= 0 ? "+" : "";
console.log(`OVERALL DELTA: ${sign}$${overallDelta.toFixed(2)}/day`);

// Summary recommendation
console.log("\n" + "=".repeat(120));
console.log("RECOMMENDATION SUMMARY");
console.log("=".repeat(120));
for (const eng of ENGINES) {
  const base = engineStats(baseline.trades, eng.id, fullDays);
  const trail = engineStats(trail4010.trades, eng.id, fullDays);
  const delta = trail.perDay - base.perDay;
  const pct = base.perDay !== 0 ? (delta / Math.abs(base.perDay) * 100).toFixed(0) : "n/a";
  const arrow = delta > 0.01 ? "HELPS" : delta < -0.01 ? "HURTS" : "NEUTRAL";
  console.log(`  Engine ${eng.id}: ${arrow.padEnd(7)} ${(delta >= 0 ? "+" : "")}$${delta.toFixed(2)}/day (${pct}%)  |  base $${base.perDay.toFixed(2)}/day -> trail $${trail.perDay.toFixed(2)}/day`);
}
console.log();
