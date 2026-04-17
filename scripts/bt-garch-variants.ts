/**
 * GARCH variants backtest - 5 experimental configs vs baseline
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-garch-variants.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; v: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MIN_1 = 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

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
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) },
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
      v: grp.reduce((s, b) => s + b.v, 0),
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

// Daily ATR for adaptive z threshold (Variant 3)
function calcDailyATR(cs: C[], period: number): number[] {
  return calcATR(cs, period);
}

function calcMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
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
function capSL(dir: "long" | "short", ep: number, sl: number): number {
  if (dir === "long") return Math.max(sl, ep * 0.965);
  return Math.min(sl, ep * 1.035);
}

// --------------- load all data ---------------
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// --------------- BTC 4h EMA(12/21) filter ---------------
const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);
const btcH4TsMap = new Map<number, number>();
btcH4.forEach((c, i) => btcH4TsMap.set(c.t, i));

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

// BTC h1 EMA(9/21) for GARCH BTC trend filter
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

console.log("Building per-pair indicators...");

// --------------- per-pair indicators ---------------
interface PairIndicators {
  // h4
  h4: C[];
  h4ATR: number[];
  h4TsMap: Map<number, number>;
  h4Z: number[];
  h4Ema8: number[];   // for EWMAC
  h4Ema32: number[];
  h4Ema16: number[];
  h4Ema64: number[];
  // h1
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h1Vol: number[];    // for EWMAC signal norm (10-day rolling vol on h4 prices mapped per h1)
  h1VolumeAvg20: number[];  // for V5 volume gate
  // daily
  daily: C[];
  dailyATR: number[];
  dailyTsMap: Map<number, number>;
  // 5m for intrabar SL checks
  bars5m: C[];
}

function bsearch(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function bsearchLE(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

const pairInd = new Map<string, PairIndicators>();

for (const pair of PAIRS) {
  const h4 = h4Data.get(pair) ?? [];
  const h4ATR = calcATR(h4, 14);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h4Z = computeZScores(h4, 3, 20);
  const h4Closes = h4.map(c => c.c);
  const h4Ema8  = calcEMA(h4Closes, 8);
  const h4Ema32 = calcEMA(h4Closes, 32);
  const h4Ema16 = calcEMA(h4Closes, 16);
  const h4Ema64 = calcEMA(h4Closes, 64);

  const h1 = h1Data.get(pair) ?? [];
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9  = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  // 10-day rolling vol on h4 closes (for EWMAC signal normalization)
  // 10 days = 60 h4 bars
  const h4Vol60 = new Array(h4Closes.length).fill(0);
  for (let i = 60; i < h4Closes.length; i++) {
    const win = h4Closes.slice(i - 60, i + 1);
    const rets = win.slice(1).map((v, j) => v / win[j] - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    h4Vol60[i] = Math.sqrt(variance) * h4Closes[i]; // in price units
  }

  // Map h4 vol to h1 timeline
  const h1Vol: number[] = new Array(h1.length).fill(0);
  for (let i = 0; i < h1.length; i++) {
    const ts4h = Math.floor(h1[i].t / H4) * H4;
    const i4h = h4TsMap.get(ts4h);
    if (i4h !== undefined) h1Vol[i] = h4Vol60[i4h];
  }

  // 20-bar volume average on h1 for volume gate (Variant 5)
  const h1Volumes = h1.map(c => c.v);
  const h1VolumeAvg20 = new Array(h1.length).fill(0);
  for (let i = 20; i < h1.length; i++) {
    let s = 0;
    for (let j = i - 20; j < i; j++) s += h1Volumes[j];
    h1VolumeAvg20[i] = s / 20;
  }

  const daily = dailyData.get(pair) ?? [];
  const dailyATR = calcDailyATR(daily, 20);
  const dailyTsMap = new Map<number, number>();
  daily.forEach((c, i) => dailyTsMap.set(c.t, i));

  const bars5m = raw5m.get(pair) ?? [];

  pairInd.set(pair, {
    h4, h4ATR, h4TsMap, h4Z, h4Ema8, h4Ema32, h4Ema16, h4Ema64,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap, h1Vol, h1VolumeAvg20,
    daily, dailyATR, dailyTsMap,
    bars5m,
  });
}

console.log("Indicators built.\n");

// --------------- position & trade types ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  variant: string;
  size: number;
  entryPrice: number;
  effectiveEP: number;
  sl: number;
  tp: number;        // 0 = disabled
  entryTime: number;
  maxHoldMs: number;
  peakPnlPct: number;
  isReentry: boolean;
  // for trail re-entry
  origDir: "long" | "short";
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  variant: string;
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  isReentry: boolean;
}

interface PendingReentry {
  pair: string;
  dir: "long" | "short";
  variant: string;
  checkTime: number;
}

// --------------- variant config ---------------
interface VariantConfig {
  label: string;
  note: string;
  size: number;          // $ margin per trade
  maxPos: number;
  slPct: number;         // fixed SL %
  tpPct: number;         // 0 = no TP
  maxHoldH: number;
  trailAct: number;      // 40 = 40% leveraged PnL
  trailDist: number;     // 3 = 3% leveraged PnL pullback
  // entry logic selector
  entryFn: (pair: string, t: number) => { dir: "long" | "short" } | null;
  // exit logic selector (null = use SL/TP/maxHold only)
  exitFn?: (pos: Position, t: number) => { exit: boolean; price: number; reason: string } | null;
  // re-entry check (same as entry but validates direction)
  reentryFn?: (pair: string, t: number, wantDir: "long" | "short") => boolean;
  // interval for entry checks (ms)
  entryInterval: number;
}

// --------------- BASELINE: GARCH v2 z=4.5/3.0, SL 3%, TP 7%, 72h ---------------
function garchV2Entry(pair: string, t: number, z1Thresh: number, z4Thresh: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const prev = barIdx - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong  = z1 > z1Thresh;
  const goShort = z1 < -z1Thresh * (z1Thresh === 4.5 ? (3.0 / 4.5) : 1.0);
  // For baseline: long z>4.5, short z<-3.0
  // We handle asymmetric externally below
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong  && z4 <= z4Thresh)  return null;
  if (goShort && z4 >= -z4Thresh) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  return { dir: goLong ? "long" : "short" };
}

// Baseline entry (z=4.5 long, z=-3.0 short, 4h z>3.0)
function baselineEntry(pair: string, t: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const prev = barIdx - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong  = z1 > 4.5;
  const goShort = z1 < -3.0;
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong  && z4 <= 3.0) return null;
  if (goShort && z4 >= -3.0) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  return { dir: goLong ? "long" : "short" };
}

function baselineExit(pos: Position, t: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pos.pair)!;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined) return null;
  const bar = ind.h1[barIdx];

  if ((bar.t - pos.entryTime) >= pos.maxHoldMs) {
    return { exit: true, price: bar.c, reason: "mh" };
  }
  // TP check on h1 bar
  if (pos.tp > 0) {
    if (pos.dir === "long"  && bar.h >= pos.tp) return { exit: true, price: pos.tp, reason: "tp" };
    if (pos.dir === "short" && bar.l <= pos.tp) return { exit: true, price: pos.tp, reason: "tp" };
  }
  return null;
}

// --------------- VARIANT 1: Lower z + tighter SL ---------------
// z=3.5/2.5, SL 1.5%, TP 5%, 48h, $5, max 7
function v1Entry(pair: string, t: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const prev = barIdx - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong  = z1 > 3.5;
  const goShort = z1 < -3.5;
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong  && z4 <= 2.5) return null;
  if (goShort && z4 >= -2.5) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  return { dir: goLong ? "long" : "short" };
}

// --------------- VARIANT 2: Multi-TF GARCH (1h OR 4h signal) ---------------
// 1h: z>3.5, 4h: z>3.0, enter when EITHER fires, SL 2%
function v2Entry(pair: string, t: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;

  // Check 1h signal
  const h1Bucket = Math.floor(t / H) * H;
  const h1Idx = ind.h1TsMap.get(h1Bucket);
  if (h1Idx !== undefined && h1Idx >= 24) {
    const prev = h1Idx - 1;
    const z1 = ind.h1Z[prev];
    if (!isNaN(z1) && z1 !== 0) {
      const goLong  = z1 > 3.5;
      const goShort = z1 < -3.5;
      if (goLong || goShort) {
        const dir: "long" | "short" = goLong ? "long" : "short";
        if (dir === "long" && !btcBullish(ind.h1[prev].t)) {
          // fall through to 4h check
        } else if (dir === "short" && btcH1Trend(ind.h1[prev].t) !== "short") {
          // fall through to 4h check
        } else {
          if (ind.h1Ema9[prev] !== 0 && ind.h1Ema21[prev] !== 0) {
            if (!(goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) &&
                !(goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev])) {
              return { dir };
            }
          }
        }
      }
    }
  }

  // Check 4h signal
  const h4Bucket = Math.floor(t / H4) * H4;
  const h4Idx = ind.h4TsMap.get(h4Bucket);
  if (h4Idx === undefined || h4Idx < 24) return null;
  const prev4 = h4Idx - 1;
  const z4 = ind.h4Z[prev4];
  if (isNaN(z4) || z4 === 0) return null;
  const goLong4  = z4 > 3.0;
  const goShort4 = z4 < -3.0;
  if (!goLong4 && !goShort4) return null;
  const dir4: "long" | "short" = goLong4 ? "long" : "short";
  if (dir4 === "long" && !btcBullish(ind.h4[prev4].t)) return null;
  if (dir4 === "short" && btcH1Trend(ind.h4[prev4].t) !== "short") return null;
  return { dir: dir4 };
}

// V2 fires on both 1h and 4h boundaries
function is1hOr4hBoundary(t: number): boolean { return t % H === 0; } // 4h is subset of 1h

// --------------- VARIANT 3: Adaptive z threshold ---------------
// High vol (ATR > median): z=3.0/2.5. Low vol: z=5.0/3.5
// ATR computed on daily bars with 20-period window, rolling median over last 60 daily bars
function v3Entry(pair: string, t: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const prev = barIdx - 1;

  // Get current daily ATR and rolling median
  const dayBucket = Math.floor(ind.h1[prev].t / D) * D;
  const dayIdx = ind.dailyTsMap.get(dayBucket);
  let z1Thresh = 4.0;
  let z4Thresh = 3.0;
  if (dayIdx !== undefined && dayIdx >= 20) {
    const currATR = ind.dailyATR[dayIdx];
    // rolling median of last 60 daily ATR values
    const startJ = Math.max(0, dayIdx - 60);
    const window = ind.dailyATR.slice(startJ, dayIdx + 1).filter(v => v > 0);
    const medATR = calcMedian(window);
    if (medATR > 0) {
      if (currATR > medATR) {
        // high vol: lower thresholds
        z1Thresh = 3.0;
        z4Thresh = 2.5;
      } else {
        // low vol: higher thresholds
        z1Thresh = 5.0;
        z4Thresh = 3.5;
      }
    }
  }

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong  = z1 > z1Thresh;
  const goShort = z1 < -z1Thresh;
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(ind.h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong  && z4 <= z4Thresh) return null;
  if (goShort && z4 >= -z4Thresh) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(ind.h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  return { dir: goLong ? "long" : "short" };
}

// --------------- VARIANT 4: EWMAC blend ---------------
// EWMAC(8,32) and EWMAC(16,64) on 4h bars
// Signal = (fastEMA - slowEMA) / (10-day price vol)
// Long when signal > +2, Short when < -2
// Exit when signal crosses zero
function v4GetSignal(pair: string, h4Idx: number): number {
  const ind = pairInd.get(pair)!;
  if (h4Idx < 64) return 0;
  const f1 = ind.h4Ema8[h4Idx]  - ind.h4Ema32[h4Idx];
  const f2 = ind.h4Ema16[h4Idx] - ind.h4Ema64[h4Idx];
  const raw = (f1 + f2) / 2;
  const vol = ind.h4Vol60 !== undefined ? 0 : 0; // fallback below
  // Use h4Vol60 from closure
  const h4 = ind.h4;
  if (h4Idx < 60) return 0;
  // Compute rolling 60-bar vol in price terms
  const h4Closes2 = h4.slice(Math.max(0, h4Idx - 60), h4Idx + 1).map(c => c.c);
  if (h4Closes2.length < 10) return 0;
  const rets = h4Closes2.slice(1).map((v, j) => v / h4Closes2[j] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const stdVol = Math.sqrt(variance);
  if (stdVol < 1e-9) return 0;
  // normalize by price × stdVol (annualized roughly)
  const priceVol = h4Closes2[h4Closes2.length - 1] * stdVol;
  if (priceVol === 0) return 0;
  return raw / priceVol;
}

// Precompute EWMAC signals per pair per h4 bar
const ewmacSignals = new Map<string, number[]>();
for (const pair of PAIRS) {
  const ind = pairInd.get(pair)!;
  const sigs = new Array(ind.h4.length).fill(0);
  for (let i = 64; i < ind.h4.length; i++) {
    sigs[i] = v4GetSignal(pair, i);
  }
  ewmacSignals.set(pair, sigs);
}

function v4Entry(pair: string, t: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;
  const h4Bucket = Math.floor(t / H4) * H4;
  const h4Idx = ind.h4TsMap.get(h4Bucket);
  if (h4Idx === undefined || h4Idx < 65) return null;

  const sigs = ewmacSignals.get(pair)!;
  const prevSig = sigs[h4Idx - 1];
  const prevPrevSig = sigs[h4Idx - 2];

  // Cross above +2 (long entry)
  if (prevSig > 2 && prevPrevSig <= 2) {
    if (!btcBullish(ind.h4[h4Idx - 1].t)) return null;
    return { dir: "long" };
  }
  // Cross below -2 (short entry)
  if (prevSig < -2 && prevPrevSig >= -2) {
    return { dir: "short" };
  }
  return null;
}

function v4Exit(pos: Position, t: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pos.pair)!;
  const h4Bucket = Math.floor(t / H4) * H4;
  const h4Idx = ind.h4TsMap.get(h4Bucket);
  if (h4Idx === undefined || h4Idx < 65) return null;

  const sigs = ewmacSignals.get(pos.pair)!;
  const prevSig = sigs[h4Idx - 1];

  // Exit when signal crosses zero
  if (pos.dir === "long"  && prevSig <= 0) return { exit: true, price: ind.h4[h4Idx].o, reason: "sig" };
  if (pos.dir === "short" && prevSig >= 0) return { exit: true, price: ind.h4[h4Idx].o, reason: "sig" };

  // Max hold
  if ((ind.h4[h4Idx].t - pos.entryTime) >= pos.maxHoldMs) {
    return { exit: true, price: ind.h4[h4Idx].c, reason: "mh" };
  }
  return null;
}

// --------------- VARIANT 5: GARCH + volume gate ---------------
// Same as baseline but also require current 1h volume > 1.5x 20-bar avg
function v5Entry(pair: string, t: number): { dir: "long" | "short" } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const prev = barIdx - 1;
  if (prev < 23) return null;

  // Volume gate: current bar volume > 1.5x 20-bar avg
  const volAvg = ind.h1VolumeAvg20[prev];
  if (volAvg > 0 && h1[prev].v < volAvg * 1.5) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong  = z1 > 4.5;
  const goShort = z1 < -3.0;
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong  && z4 <= 3.0) return null;
  if (goShort && z4 >= -3.0) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  return { dir: goLong ? "long" : "short" };
}

// --------------- simulation ---------------
interface SimConfig {
  label: string;
  note: string;
  size: number;
  maxPos: number;
  slPct: number;
  tpPct: number;
  maxHoldH: number;
  trailAct: number;
  trailDist: number;
  entryFn: (pair: string, t: number) => { dir: "long" | "short" } | null;
  exitFn?: (pos: Position, t: number) => { exit: boolean; price: number; reason: string } | null;
  entryInterval: number; // H or H4
  // For re-entry validation: re-check entry signal for the same direction
  reentryFn?: (pair: string, t: number, wantDir: "long" | "short") => boolean;
}

// Default: re-entry uses same entry fn and checks direction matches
function defaultReentryFn(
  entryFn: (pair: string, t: number) => { dir: "long" | "short" } | null,
): (pair: string, t: number, wantDir: "long" | "short") => boolean {
  return (pair, t, wantDir) => {
    const sig = entryFn(pair, t);
    return sig !== null && sig.dir === wantDir;
  };
}

function runSim(cfg: SimConfig): { trades: ClosedTrade[]; reentries: number; blocked: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;

  const simStart = FULL_START;
  const simEnd   = FULL_END;

  function get5mBar(pair: string, t: number): C | null {
    const ind = pairInd.get(pair);
    if (!ind || ind.bars5m.length === 0) return null;
    const idx = bsearch(ind.bars5m, t);
    if (idx < 0) return null;
    return ind.bars5m[idx];
  }

  function hasOpenPos(pair: string): boolean {
    return openPositions.some(p => p.pair === pair && p.variant === cfg.label);
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = pos.size * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir, variant: pos.variant,
      entryTime: pos.entryTime, exitTime, pnl, reason,
      isReentry: pos.isReentry,
    });

    // Schedule re-entry after trail exit
    if (reason === "trail") {
      const checkTime = (Math.floor(exitTime / cfg.entryInterval) + 1) * cfg.entryInterval;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, variant: pos.variant, checkTime });
    }

    openPositions.splice(idx, 1);
  }

  function tryOpen(pair: string, dir: "long" | "short", t: number, isReentry: boolean): boolean {
    if (openPositions.length >= cfg.maxPos) { blockedCount++; return false; }
    if (hasOpenPos(pair)) { blockedCount++; return false; }

    const ind = pairInd.get(pair)!;

    // Get entry price from h1 or h4 bar open depending on entryInterval
    let entryPrice = 0;
    if (cfg.entryInterval === H) {
      const h1Bucket = Math.floor(t / H) * H;
      const h1Idx = ind.h1TsMap.get(h1Bucket);
      if (h1Idx === undefined) return false;
      entryPrice = ind.h1[h1Idx].o;
    } else {
      const h4Bucket = Math.floor(t / H4) * H4;
      const h4Idx = ind.h4TsMap.get(h4Bucket);
      if (h4Idx === undefined) return false;
      entryPrice = ind.h4[h4Idx].o;
    }
    if (entryPrice <= 0) return false;

    const ep = applyEntryPx(pair, dir, entryPrice);
    let sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
    sl = capSL(dir, ep, sl);
    const tp = cfg.tpPct > 0
      ? (dir === "long" ? ep * (1 + cfg.tpPct) : ep * (1 - cfg.tpPct))
      : 0;

    openPositions.push({
      pair, dir, variant: cfg.label, size: cfg.size,
      entryPrice, effectiveEP: ep, sl, tp,
      entryTime: t, maxHoldMs: cfg.maxHoldH * H,
      peakPnlPct: 0, isReentry,
      origDir: dir,
    });
    if (isReentry) reentryCount++;
    return true;
  }

  function is4hBoundary(t: number): boolean { return t % H4 === 0; }
  function is1hBoundary(t: number): boolean { return t % H === 0; }
  function is5mBoundary(t: number): boolean { return t % (5 * MIN_1) === 0; }

  let lastPct = -1;

  for (let t = simStart; t < simEnd; t += MIN_1) {
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // 1) SL / trail on every 5m bar
    if (is5mBoundary(t)) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const bar = get5mBar(pos.pair, t);
        if (!bar) continue;

        // SL check
        if (pos.dir === "long"  && bar.l <= pos.sl) { closePos(pi, t, pos.sl, "sl", true);  continue; }
        if (pos.dir === "short" && bar.h >= pos.sl) { closePos(pi, t, pos.sl, "sl", true);  continue; }

        // TP check (intrabar)
        if (pos.tp > 0) {
          if (pos.dir === "long"  && bar.h >= pos.tp) { closePos(pi, t, pos.tp, "tp", false); continue; }
          if (pos.dir === "short" && bar.l <= pos.tp) { closePos(pi, t, pos.tp, "tp", false); continue; }
        }

        // Peak tracking for trail
        const bestPct = pos.dir === "long"
          ? (bar.h / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.l - 1) * LEV * 100;
        if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

        // Trail check
        if (cfg.trailAct > 0 && pos.peakPnlPct >= cfg.trailAct) {
          const currPct = pos.dir === "long"
            ? (bar.c / pos.entryPrice - 1) * LEV * 100
            : (pos.entryPrice / bar.c - 1) * LEV * 100;
          if (currPct <= pos.peakPnlPct - cfg.trailDist) {
            closePos(pi, t, bar.c, "trail", false);
            continue;
          }
        }
      }
    }

    // 2) Signal-based exits at entry intervals
    const boundary = cfg.entryInterval === H ? is1hBoundary(t) : is4hBoundary(t);
    if (boundary && cfg.exitFn) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const ex = cfg.exitFn(pos, t);
        if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
      }
    }

    // Check max hold and TP on h1 boundary for 1h-interval strategies
    if (boundary && !cfg.exitFn) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const ind = pairInd.get(pos.pair)!;
        let bar: C | null = null;
        if (cfg.entryInterval === H) {
          const idx = ind.h1TsMap.get(Math.floor(t / H) * H);
          if (idx !== undefined) bar = ind.h1[idx];
        } else {
          const idx = ind.h4TsMap.get(Math.floor(t / H4) * H4);
          if (idx !== undefined) bar = ind.h4[idx];
        }
        if (!bar) continue;
        if ((bar.t - pos.entryTime) >= pos.maxHoldMs) {
          closePos(pi, t, bar.c, "mh", false);
          continue;
        }
        if (pos.tp > 0) {
          if (pos.dir === "long"  && bar.h >= pos.tp) { closePos(pi, t, pos.tp, "tp", false); continue; }
          if (pos.dir === "short" && bar.l <= pos.tp) { closePos(pi, t, pos.tp, "tp", false); continue; }
        }
      }
    }

    // 3) New entries
    const entryBoundary = cfg.entryInterval === H ? is1hBoundary(t) : is4hBoundary(t);
    if (entryBoundary) {
      for (const pair of PAIRS) {
        const sig = cfg.entryFn(pair, t);
        if (sig) tryOpen(pair, sig.dir, t, false);
      }
    }

    // V2 also checks 4h boundaries for 4h signals (entryInterval=H, but 4h signal fires at 4h)
    if (cfg.label === "V2_MTF_GARCH" && is4hBoundary(t) && !is1hBoundary(t) === false) {
      // Already handled above since 4h is subset of 1h boundary check
    }

    // 4) Pending re-entries
    if (pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;
        if (!entryBoundary) continue;

        pendingReentries.splice(ri, 1);

        const rfn = cfg.reentryFn ?? defaultReentryFn(cfg.entryFn);
        if (rfn(re.pair, t, re.dir)) {
          tryOpen(re.pair, re.dir, t, true);
        }
      }
    }
  }

  // Close remaining at end
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars5m.length === 0) continue;
    const lastBar = ind.bars5m[ind.bars5m.length - 1];
    closePos(pi, simEnd, lastBar.c, "eop", false);
  }

  return { trades: closedTrades, reentries: reentryCount, blocked: blockedCount };
}

// --------------- metrics ---------------
function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number) {
  const days = (endTs - startTs) / D;
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
  const trailExits = trades.filter(t => t.reason === "trail").length;
  const tradesPerDay = trades.length / days;

  return {
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0),
    total, perDay: total / days, maxDD, sharpe, trailExits,
    tradesPerDay,
    trades: trades.length,
  };
}

// --------------- define all configs ---------------
const BASELINE_LABEL = "BASELINE";
const BASELINE_TRADES_PER_DAY = 2.5;
const BASELINE_PER_DAY = 2.38;
const BASELINE_MAXDD = 59;

const CONFIGS: SimConfig[] = [
  // Baseline
  {
    label: BASELINE_LABEL,
    note: "GARCH z=4.5/3.0 long, z=-3.0 short | SL 3% TP 7% 72h $9 max7",
    size: 9, maxPos: 7, slPct: 0.03, tpPct: 0.07, maxHoldH: 72,
    trailAct: 40, trailDist: 3,
    entryFn: baselineEntry,
    exitFn: baselineExit,
    entryInterval: H,
  },
  // Variant 1: lower z, tighter SL
  {
    label: "V1_LOW_Z",
    note: "z=3.5/2.5, SL 1.5%, TP 5%, 48h, $5, max7",
    size: 5, maxPos: 7, slPct: 0.015, tpPct: 0.05, maxHoldH: 48,
    trailAct: 40, trailDist: 3,
    entryFn: v1Entry,
    exitFn: (pos, t) => {
      const ind = pairInd.get(pos.pair)!;
      const h1Bucket = Math.floor(t / H) * H;
      const barIdx = ind.h1TsMap.get(h1Bucket);
      if (barIdx === undefined) return null;
      const bar = ind.h1[barIdx];
      if ((bar.t - pos.entryTime) >= pos.maxHoldMs) return { exit: true, price: bar.c, reason: "mh" };
      if (pos.tp > 0) {
        if (pos.dir === "long"  && bar.h >= pos.tp) return { exit: true, price: pos.tp, reason: "tp" };
        if (pos.dir === "short" && bar.l <= pos.tp) return { exit: true, price: pos.tp, reason: "tp" };
      }
      return null;
    },
    entryInterval: H,
  },
  // Variant 2: multi-TF GARCH
  {
    label: "V2_MTF_GARCH",
    note: "1h z>3.5 OR 4h z>3.0 (either fires), SL 2%, $5, max10",
    size: 5, maxPos: 10, slPct: 0.02, tpPct: 0.07, maxHoldH: 72,
    trailAct: 40, trailDist: 3,
    entryFn: v2Entry,
    exitFn: (pos, t) => {
      const ind = pairInd.get(pos.pair)!;
      const h1Bucket = Math.floor(t / H) * H;
      const barIdx = ind.h1TsMap.get(h1Bucket);
      if (barIdx === undefined) return null;
      const bar = ind.h1[barIdx];
      if ((bar.t - pos.entryTime) >= pos.maxHoldMs) return { exit: true, price: bar.c, reason: "mh" };
      if (pos.tp > 0) {
        if (pos.dir === "long"  && bar.h >= pos.tp) return { exit: true, price: pos.tp, reason: "tp" };
        if (pos.dir === "short" && bar.l <= pos.tp) return { exit: true, price: pos.tp, reason: "tp" };
      }
      return null;
    },
    entryInterval: H,
  },
  // Variant 3: adaptive z threshold
  {
    label: "V3_ADAPTIVE_Z",
    note: "High vol: z=3.0/2.5, Low vol: z=5.0/3.5, $9, max7",
    size: 9, maxPos: 7, slPct: 0.03, tpPct: 0.07, maxHoldH: 72,
    trailAct: 40, trailDist: 3,
    entryFn: v3Entry,
    exitFn: baselineExit,
    entryInterval: H,
  },
  // Variant 4: EWMAC blend
  {
    label: "V4_EWMAC",
    note: "EWMAC(8,32)+(16,64) on 4h, sig>2 long, sig<-2 short, ATR*2 SL, $9, max7",
    size: 9, maxPos: 7, slPct: 0.02, tpPct: 0, maxHoldH: 96,
    trailAct: 40, trailDist: 3,
    entryFn: v4Entry,
    exitFn: v4Exit,
    entryInterval: H4,
  },
  // Variant 5: GARCH + volume gate
  {
    label: "V5_VOL_GATE",
    note: "GARCH z=4.5/3.0 + volume >1.5x 20bar avg, $9, max7",
    size: 9, maxPos: 7, slPct: 0.03, tpPct: 0.07, maxHoldH: 72,
    trailAct: 40, trailDist: 3,
    entryFn: v5Entry,
    exitFn: baselineExit,
    entryInterval: H,
  },
];

// --------------- run all configs ---------------
interface ResultRow {
  label: string;
  note: string;
  size: number;
  maxPos: number;
  trades: number;
  tradesPerDay: number;
  reentries: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  blocked: number;
  trailExits: number;
  oosPerDay: number;
  oosPf: number;
  oosWr: number;
  beatsBaseline: string[];
  passes: boolean;
}

console.log("Running variants (trail 40/3 + re-entry | BTC 4h EMA(12/21) | SMA ATR | half-spreads | 23 pairs)");
console.log("Full: 2023-01 to 2026-03 | OOS: 2025-09+\n");

const results: ResultRow[] = [];
const fullDays = (FULL_END - FULL_START) / D;
const oosDays  = (FULL_END - OOS_START)  / D;

for (const cfg of CONFIGS) {
  process.stdout.write(`${cfg.label.padEnd(20)} ($${cfg.size} max${cfg.maxPos})...`);

  const full = runSim(cfg);
  const fm = computeMetrics(full.trades, FULL_START, FULL_END);
  const oosTrades = full.trades.filter(t => t.entryTime >= OOS_START);
  const om = computeMetrics(oosTrades, OOS_START, FULL_END);

  const beatsBaseline: string[] = [];
  if (cfg.label !== BASELINE_LABEL) {
    if (fm.perDay > BASELINE_PER_DAY) beatsBaseline.push("$/day");
    if (fm.maxDD < BASELINE_MAXDD) beatsBaseline.push("MaxDD");
    if (fm.tradesPerDay > BASELINE_TRADES_PER_DAY) beatsBaseline.push("trades/day");
  }

  const passes = cfg.label === BASELINE_LABEL || beatsBaseline.length >= 2;

  results.push({
    label: cfg.label, note: cfg.note, size: cfg.size, maxPos: cfg.maxPos,
    trades: fm.trades, tradesPerDay: fm.tradesPerDay, reentries: full.reentries,
    wr: fm.wr, pf: fm.pf, total: fm.total, perDay: fm.perDay,
    maxDD: fm.maxDD, sharpe: fm.sharpe, blocked: full.blocked, trailExits: fm.trailExits,
    oosPerDay: om.perDay, oosPf: om.pf, oosWr: om.wr,
    beatsBaseline, passes,
  });

  console.log(` done. ${fm.trades} trades, $${fm.perDay.toFixed(2)}/day, DD $${fm.maxDD.toFixed(0)}, OOS $${om.perDay.toFixed(2)}/day | beats: [${beatsBaseline.join(",")}]`);
}

// --------------- summary ---------------
const SEP = "=".repeat(200);
console.log("\n" + SEP);
console.log("GARCH VARIANTS BACKTEST | Trail 40/3 + re-entry | BTC 4h EMA(12/21) | half-spreads | 23 pairs");
console.log(`Baseline: GARCH z=4.5/3.0, SL 3%, TP 7%, 72h, $9, max7 => $${BASELINE_PER_DAY}/day, DD $${BASELINE_MAXDD}, ${BASELINE_TRADES_PER_DAY} trades/day`);
console.log("Hard constraint: variant must beat baseline on >=2 of 3 metrics ($/day, MaxDD, trades/day)");
console.log(SEP);

const hdr = [
  "Label".padEnd(22),
  "$".padStart(4),
  "MP".padStart(4),
  "Trades".padStart(7),
  "Tr/day".padStart(7),
  "WR%".padStart(7),
  "$/day".padStart(8),
  "PF".padStart(6),
  "Sharpe".padStart(7),
  "MaxDD".padStart(8),
  "Trails".padStart(7),
  "OOS$/d".padStart(8),
  "OOSPF".padStart(7),
  "Beats".padStart(24),
  "Pass".padStart(5),
].join(" ");

console.log("\n" + hdr);
console.log("-".repeat(200));

for (const r of results) {
  const passStr = r.label === BASELINE_LABEL ? "BASE" : (r.passes ? " YES" : "  NO");
  const beatStr = r.beatsBaseline.join(",").padEnd(22);
  console.log([
    r.label.padEnd(22),
    String(r.size).padStart(4),
    String(r.maxPos).padStart(4),
    String(r.trades).padStart(7),
    r.tradesPerDay.toFixed(2).padStart(7),
    r.wr.toFixed(1).padStart(6) + "%",
    ("$" + r.perDay.toFixed(2)).padStart(8),
    r.pf.toFixed(2).padStart(6),
    r.sharpe.toFixed(2).padStart(7),
    ("$" + r.maxDD.toFixed(0)).padStart(8),
    String(r.trailExits).padStart(7),
    ("$" + r.oosPerDay.toFixed(2)).padStart(8),
    r.oosPf.toFixed(2).padStart(7),
    beatStr.padStart(24),
    passStr.padStart(5),
  ].join(" "));
}

console.log("\n" + SEP);

// Winners only
const winners = results.filter(r => r.passes && r.label !== BASELINE_LABEL);
console.log(`\nVariants that PASS (beat baseline on >=2 of 3 metrics): ${winners.length}`);
if (winners.length === 0) {
  console.log("  No variants beat baseline on enough metrics.");
} else {
  for (const r of winners) {
    console.log(`  ${r.label.padEnd(22)} $/day: $${r.perDay.toFixed(2)} (base $${BASELINE_PER_DAY}) | MaxDD: $${r.maxDD.toFixed(0)} (base $${BASELINE_MAXDD}) | trades/day: ${r.tradesPerDay.toFixed(2)} (base ${BASELINE_TRADES_PER_DAY}) | beats: [${r.beatsBaseline.join(",")}]`);
    console.log(`    OOS $/day: $${r.oosPerDay.toFixed(2)} | WR: ${r.wr.toFixed(1)}% | PF: ${r.pf.toFixed(2)} | Sharpe: ${r.sharpe.toFixed(2)}`);
    console.log(`    Config: ${r.note}`);
  }
}

// Ranked by OOS $/day among passing variants
if (winners.length > 1) {
  const ranked = [...winners].sort((a, b) => b.oosPerDay - a.oosPerDay);
  console.log("\nPassing variants ranked by OOS $/day:");
  for (const r of ranked) {
    console.log(`  ${r.label.padEnd(22)} OOS $${r.oosPerDay.toFixed(2)}/day | Full $${r.perDay.toFixed(2)}/day | MaxDD $${r.maxDD.toFixed(0)}`);
  }
}

console.log("\nDone.");
