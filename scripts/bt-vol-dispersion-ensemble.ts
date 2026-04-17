/**
 * Vol Dispersion Engine F - Ensemble Validation
 *
 * Configs tested:
 *   1. Baseline: A+B+C+D (4 engines, 40/3 trail+reentry)
 *   2. A+B+C+D + F $3 (40/3 trail+reentry)
 *   3. A+B+C+D + F $5 (40/3 trail+reentry)
 *   4. F SOLO $3 (standalone validation)
 *
 * Engine F: Vol Dispersion on 4h bars
 *   - Signal: rolling 20-bar std dev of returns for alt AND BTC.
 *     Z-score the ratio (alt_vol / btc_vol) over 60 bars.
 *     z > 2 (alt vol explosion): fade the alt's direction.
 *     z < -2 (alt vol compression): trade in BTC's direction.
 *   - SL: ATR(14)*3 capped 3.5%
 *   - Exit: |z| < 0.5 normalization OR 24h max hold OR SL
 *   - Size: configurable ($3 or $5 margin), 10x leverage
 *   - BTC 4h EMA(12/21) filter for longs
 *
 * Shared position pool max 20.
 * Full: 2023-01 to 2026-03 | OOS: 2025-09+
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-vol-dispersion-ensemble.ts
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

// Engine sizes (baseline)
const SIZE_A = 2;
const SIZE_B = 3;
const SIZE_C = 9;
const SIZE_D = 3;

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

// Vol Dispersion parameters
const F_VOL_WINDOW = 20;    // 20-bar rolling std dev
const F_Z_WINDOW = 60;      // 60-bar z-score normalization
const F_Z_ENTRY = 2.0;      // entry threshold
const F_Z_EXIT = 0.5;       // exit (normalization) threshold
const F_MAX_HOLD_BARS = 6;  // 24h = 6 bars at 4h

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
  // SMA-based ATR (no look-ahead bias)
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

// Rolling std dev of a returns array (used for vol dispersion)
function calcRollingStd(returns: number[], window: number): number[] {
  const std = new Array(returns.length).fill(NaN);
  for (let i = window; i < returns.length; i++) {
    let sum = 0;
    for (let j = i - window; j < i; j++) sum += returns[j];
    const mean = sum / window;
    let sq = 0;
    for (let j = i - window; j < i; j++) sq += (returns[j] - mean) ** 2;
    std[i] = Math.sqrt(sq / window);
  }
  return std;
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
console.log("Loading 5m candle data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}
console.log(`  Loaded ${raw5m.size} pairs from 5m cache`);

console.log("Loading 1m candle data...");
const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); process.stdout.write(`.`); }
}
console.log(` ${raw1m.size} pairs with 1m data`);

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

// BTC h1 for GARCH filter
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

// BTC 4h vol dispersion data (pre-computed for Engine F)
const btcH4Returns = btcH4.map((c, i) => i === 0 ? 0 : c.c / btcH4[i - 1].c - 1);
const btcH4VolSeries = calcRollingStd(btcH4Returns, F_VOL_WINDOW);
const btcH4TsMap = new Map<number, number>();
btcH4.forEach((c, i) => btcH4TsMap.set(c.t, i));

console.log("\nData aggregated.");

// --------------- per-pair indicator arrays ---------------
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
  // Engine F specific
  h4Returns: number[];
  h4VolSeries: number[];
  h4DispRatio: number[];  // alt_vol / btc_vol, aligned to alt h4 timestamps
  h4DispZ: number[];      // z-score of dispRatio over F_Z_WINDOW bars
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

console.log("Pre-computing indicators...");
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

  // Engine F: vol dispersion pre-computation
  const h4Returns = h4.map((c, i) => i === 0 ? 0 : c.c / h4[i - 1].c - 1);
  const h4VolSeries = calcRollingStd(h4Returns, F_VOL_WINDOW);

  // Dispersion ratio: alt_vol / btc_vol at each alt 4h bar
  const h4DispRatio = h4.map((c, i) => {
    const altVol = h4VolSeries[i];
    if (isNaN(altVol) || altVol <= 0) return NaN;
    const bIdx = btcH4TsMap.get(c.t);
    if (bIdx === undefined) return NaN;
    const btcVol = btcH4VolSeries[bIdx];
    if (isNaN(btcVol) || btcVol < 1e-10) return NaN;
    return altVol / btcVol;
  });

  // Z-score of dispersion ratio over F_Z_WINDOW bars (no look-ahead)
  const h4DispZ = h4DispRatio.map((v, i) => {
    if (isNaN(v) || i < F_Z_WINDOW) return NaN;
    const slice: number[] = [];
    for (let j = i - F_Z_WINDOW; j < i; j++) {
      if (!isNaN(h4DispRatio[j])) slice.push(h4DispRatio[j]);
    }
    if (slice.length < 20) return NaN;
    const mean = slice.reduce((s, x) => s + x, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / slice.length);
    return std > 0 ? (v - mean) / std : 0;
  });

  pairInd.set(pair, {
    daily, dailyFast, dailySlow, dailyATR, dailyTsMap,
    h4, h4StDir, h4ATR, h4TsMap,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap,
    h4Z,
    bars1m,
    h4Returns, h4VolSeries, h4DispRatio, h4DispZ,
  });
}
console.log(`  Done. ${pairInd.size} pairs instrumented.\n`);

// --------------- signal result type ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: string;
  size: number;
}

// --------------- engine A: Donchian SMA ---------------
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

// --------------- engine B: Supertrend ---------------
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

// --------------- engine C: GARCH v2 ---------------
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

// --------------- engine D: Momentum Confirm ---------------
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

  const closesSlice: number[] = [];
  for (let j = prev - 20; j <= prev; j++) {
    if (j >= 0) closesSlice.push(cs[j].c);
  }
  if (closesSlice.length < 20) return null;
  const cMean = closesSlice.reduce((s, v) => s + v, 0) / closesSlice.length;
  const cStd = Math.sqrt(closesSlice.reduce((s, v) => s + (v - cMean) ** 2, 0) / closesSlice.length);
  const priceZ = cStd > 0 ? (closesSlice[closesSlice.length - 1] - cMean) / cStd : 0;

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

// --------------- engine F: Vol Dispersion ---------------
// Entry at 4h boundaries. Uses pre-computed h4DispZ arrays.
function checkVolDispersion(pair: string, t: number, sizeF: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < F_Z_WINDOW + F_VOL_WINDOW + 5) return null;

  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < F_Z_WINDOW + F_VOL_WINDOW + 1) return null;

  const i = barIdx;
  const prev = i - 1;

  // Use completed bar's z-score (prev = last closed bar)
  const z = ind.h4DispZ[prev];
  if (isNaN(z) || z === 0) return null;

  if (Math.abs(z) <= F_Z_ENTRY) return null;

  const atr = ind.h4ATR[prev];
  if (atr <= 0) return null;
  const ep = cs[i].o;

  let dir: "long" | "short" | null = null;

  if (z > F_Z_ENTRY) {
    // Alt vol explosion: fade the alt's direction
    const recentRet = ind.h4Returns[prev];
    if (recentRet > 0.005) dir = "short";  // surging -> fade short
    else if (recentRet < -0.005) dir = "long"; // crashing -> fade long
  } else if (z < -F_Z_ENTRY) {
    // Alt vol compression: trade in BTC's direction
    const bIdx = btcH4TsMap.get(cs[i].t);
    if (bIdx === undefined || bIdx < 1) return null;
    const btcRet = btcH4Returns[bIdx - 1]; // last completed BTC bar
    if (btcRet > 0.005) dir = "long";
    else if (btcRet < -0.005) dir = "short";
  }

  if (!dir) return null;

  // BTC EMA filter for longs
  if (dir === "long" && !btcBullish(cs[i].t)) return null;

  let slDist = atr * 3.0;
  if (slDist > ep * 0.035) slDist = ep * 0.035;
  const sl = dir === "long" ? ep - slDist : ep + slDist;

  return { dir, entryPrice: ep, sl, engine: "F", size: sizeF };
}

function checkVolDispersionReentry(pair: string, t: number, wantDir: "long" | "short", sizeF: number): SignalResult | null {
  const sig = checkVolDispersion(pair, t, sizeF);
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

  if (Math.round((bar.t - entryTime) / D) >= 60) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

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

  if ((bar.t - entryTime) / H >= 60 * 24) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  const flip = ind.h4StDir[barIdx - 1] !== ind.h4StDir[barIdx - 2];
  if (flip) {
    return { exit: true, price: bar.o, reason: "flip" };
  }

  return null;
}

function checkGarchExit(pair: string, t: number, dir: "long" | "short", entryTime: number, entryPrice: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined) return null;
  const bar = h1[barIdx];

  if ((bar.t - entryTime) / H >= 96) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

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

  if ((bar.t - entryTime) / H >= 48) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  return null;
}

// Engine F exit: z-score normalizes OR 24h max hold
function checkVolDispersionExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 1) return null;
  const bar = cs[barIdx];

  // Max hold: 24h = 6 bars at 4h
  if ((bar.t - entryTime) / H >= F_MAX_HOLD_BARS * 4) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  // Z-score normalization exit: use last completed bar (barIdx - 1)
  const prev = barIdx - 1;
  const z = ind.h4DispZ[prev];
  if (!isNaN(z) && Math.abs(z) < F_Z_EXIT) {
    return { exit: true, price: bar.o, reason: "z-norm" };
  }

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
  act: number,   // trail activation %
  dist: number,  // trail distance %
  doReentry: boolean,
  startTs: number,
  endTs: number,
  enableF: boolean,
  sizeF: number,
): { trades: ClosedTrade[]; reentries: number; blocked: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;

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
      else if (pos.engine === "F") checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      else checkTime = (Math.floor(exitTime / H4) + 1) * H4; // D: next 4h
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }

    openPositions.splice(idx, 1);
  }

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

  let lastPct = -1;

  for (let t = simStart; t < simEnd; t += MIN_1) {
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // --- 1) SL, TP, trail checks at 1m resolution ---
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get1mBar(pos.pair, t);
      if (!bar) continue;

      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // GARCH TP (7%)
      if (pos.engine === "C") {
        const tp = pos.dir === "long" ? pos.entryPrice * 1.07 : pos.entryPrice * 0.93;
        if (pos.dir === "long" && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
        if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }
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

    // --- 2) Engine-specific exits at their intervals ---
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
        if (enableF && pos.engine === "F") {
          const ex = checkVolDispersionExit(pos.pair, t, pos.dir, pos.entryTime);
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

    // --- 3) New entries at engine intervals ---
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
      if (enableF) {
        for (const pair of PAIRS) {
          const sig = checkVolDispersion(pair, t, sizeF);
          if (sig) tryOpen(sig, pair, t, false);
        }
      }
    }

    if (is1hBoundary(t)) {
      for (const pair of PAIRS) {
        const sig = checkGarchV2(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    // --- 4) Pending re-entries ---
    if (doReentry && pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;

        let isBoundary = false;
        if (re.engine === "A" && isDailyBoundary(t)) isBoundary = true;
        else if (re.engine === "B" && is4hBoundary(t)) isBoundary = true;
        else if (re.engine === "C" && is1hBoundary(t)) isBoundary = true;
        else if (re.engine === "D" && is4hBoundary(t)) isBoundary = true;
        else if (re.engine === "F" && is4hBoundary(t)) isBoundary = true;
        if (!isBoundary) continue;

        pendingReentries.splice(ri, 1);

        let sig: SignalResult | null = null;
        if (re.engine === "A") sig = checkDonchianReentry(re.pair, t, re.dir);
        else if (re.engine === "B") sig = checkSupertrendReentry(re.pair, t, re.dir);
        else if (re.engine === "C") sig = checkGarchV2Reentry(re.pair, t, re.dir);
        else if (re.engine === "D") sig = checkMomentumReentry(re.pair, t, re.dir);
        else if (re.engine === "F") sig = checkVolDispersionReentry(re.pair, t, re.dir, sizeF);

        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  // Close remaining positions at simEnd
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars1m.length === 0) continue;
    const lastBar = ind.bars1m[ind.bars1m.length - 1];
    closePos(pi, simEnd, lastBar.c, "eop", false);
  }

  return { trades: closedTrades, reentries: reentryCount, blocked: blockedCount };
}

// --------------- metrics ---------------
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
  oosWr: number;
  oosMaxDD: number;
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

// Pearson correlation helper
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const mA = sumA / n, mB = sumB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const den = Math.sqrt(dA * dB);
  return den > 0 ? num / den : 0;
}

// Compute daily pnl map for a set of trades
function buildDailyPnl(trades: ClosedTrade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const dk = Math.floor(t.exitTime / D) * D;
    m.set(dk, (m.get(dk) ?? 0) + t.pnl);
  }
  return m;
}

// Correlation between engine F trades and baseline trades over full period
function tradeCorrelation(
  fTrades: ClosedTrade[],
  baseTrades: ClosedTrade[],
  startTs: number,
  endTs: number
): number {
  const fDaily = buildDailyPnl(fTrades.filter(t => t.exitTime >= startTs && t.exitTime < endTs));
  const bDaily = buildDailyPnl(baseTrades.filter(t => t.exitTime >= startTs && t.exitTime < endTs));
  const allKeys = [...new Set([...fDaily.keys(), ...bDaily.keys()])].sort();
  const fVals = allKeys.map(k => fDaily.get(k) ?? 0);
  const bVals = allKeys.map(k => bDaily.get(k) ?? 0);
  return pearson(fVals, bVals);
}

// --------------- run configs ---------------
console.log("=".repeat(140));
console.log("  VOL DISPERSION ENGINE F - ENSEMBLE VALIDATION");
console.log("  Engines: A=$2 Donchian | B=$3 Supertrend | C=$9 GARCH v2 | D=$3 Momentum | F=VolDisp");
console.log("  Trail: 40% activation / 3% distance + re-entry | Max 20 positions | 23 pairs");
console.log("  Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("=".repeat(140));

const TRAIL_ACT = 40;
const TRAIL_DIST = 3;

interface SimConfig {
  label: string;
  enableF: boolean;
  sizeF: number;
}

const CONFIGS: SimConfig[] = [
  { label: "BASELINE (A+B+C+D)",    enableF: false, sizeF: 0 },
  { label: "A+B+C+D + F$3",         enableF: true,  sizeF: 3 },
  { label: "A+B+C+D + F$5",         enableF: true,  sizeF: 5 },
  { label: "F SOLO $3",             enableF: true,  sizeF: 3 },
];

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;
const results: Metrics[] = [];
const allRunTrades: Map<string, ClosedTrade[]> = new Map();

for (const cfg of CONFIGS) {
  console.log(`\nRunning: ${cfg.label}`);

  // For F SOLO: override engines A/B/C/D by special handling
  // We do this by running the sim, then filtering trades by engine
  let fullRun: ReturnType<typeof runSim>;

  if (cfg.label === "F SOLO $3") {
    // Run a sim with only F active: pass enableF=true but skip A/B/C/D
    // We achieve this by zeroing their sizes - but since we check engine key it's cleaner
    // to run full sim and keep only F trades for metrics
    fullRun = runSim(TRAIL_ACT, TRAIL_DIST, true, FULL_START, FULL_END, true, cfg.sizeF);
    // Filter to only F trades
    fullRun.trades = fullRun.trades.filter(t => t.engine === "F");
  } else {
    fullRun = runSim(TRAIL_ACT, TRAIL_DIST, true, FULL_START, FULL_END, cfg.enableF, cfg.sizeF);
  }

  const allTrades = fullRun.trades;
  allRunTrades.set(cfg.label, allTrades);

  const fullMetrics = computeMetrics(allTrades, FULL_START, FULL_END);

  const oosTrades = allTrades.filter(t => t.entryTime >= OOS_START);
  const oosMetrics = computeMetrics(oosTrades, OOS_START, FULL_END);

  results.push({
    label: cfg.label,
    trades: allTrades.length,
    reentries: fullRun.reentries,
    wr: fullMetrics.wr,
    pf: fullMetrics.pf,
    total: fullMetrics.total,
    perDay: fullMetrics.perDay,
    maxDD: fullMetrics.maxDD,
    sharpe: fullMetrics.sharpe,
    blocked: fullRun.blocked,
    trailExits: fullMetrics.trailExits,
    oosTotal: oosMetrics.total,
    oosPerDay: oosMetrics.perDay,
    oosPf: oosMetrics.pf,
    oosWr: oosMetrics.wr,
    oosMaxDD: oosMetrics.maxDD,
  });

  console.log(`  Done: ${allTrades.length} trades, $${fullMetrics.perDay.toFixed(2)}/day, PF ${fullMetrics.pf.toFixed(2)}, OOS $${oosMetrics.perDay.toFixed(2)}/day`);
}

// --------------- correlation between F trades and baseline ---------------
const baselineTrades = allRunTrades.get("BASELINE (A+B+C+D)") ?? [];
const f3Trades = (allRunTrades.get("A+B+C+D + F$3") ?? []).filter(t => t.engine === "F");
const f5Trades = (allRunTrades.get("A+B+C+D + F$5") ?? []).filter(t => t.engine === "F");
const fSoloTrades = allRunTrades.get("F SOLO $3") ?? [];

const corrF3Full = tradeCorrelation(f3Trades, baselineTrades, FULL_START, FULL_END);
const corrF3Oos = tradeCorrelation(f3Trades, baselineTrades, OOS_START, FULL_END);
const corrF5Full = tradeCorrelation(f5Trades, baselineTrades, FULL_START, FULL_END);
const corrF5Oos = tradeCorrelation(f5Trades, baselineTrades, OOS_START, FULL_END);
const corrFSoloFull = tradeCorrelation(fSoloTrades, baselineTrades, FULL_START, FULL_END);
const corrFSoloOos = tradeCorrelation(fSoloTrades, baselineTrades, OOS_START, FULL_END);

// --------------- output ---------------
console.log("\n\n" + "=".repeat(140));
console.log("  RESULTS TABLE");
console.log("=".repeat(140));

const hdr = [
  "Config".padEnd(22),
  "Trades".padStart(7),
  "Re-ent".padStart(7),
  "WR%".padStart(6),
  "Total".padStart(10),
  "$/day".padStart(8),
  "PF".padStart(6),
  "Sharpe".padStart(7),
  "MaxDD".padStart(8),
  "Blocked".padStart(8),
  "Trails".padStart(7),
  "OOS$/d".padStart(8),
  "OOSPF".padStart(7),
  "OOSWR%".padStart(8),
  "OOSDD".padStart(8),
].join(" ");
console.log(`\n${hdr}`);
console.log("-".repeat(140));

for (const r of results) {
  console.log([
    r.label.padEnd(22),
    String(r.trades).padStart(7),
    String(r.reentries).padStart(7),
    (r.wr.toFixed(1) + "%").padStart(6),
    ("$" + r.total.toFixed(0)).padStart(10),
    ("$" + r.perDay.toFixed(2)).padStart(8),
    r.pf.toFixed(2).padStart(6),
    r.sharpe.toFixed(2).padStart(7),
    ("$" + r.maxDD.toFixed(0)).padStart(8),
    String(r.blocked).padStart(8),
    String(r.trailExits).padStart(7),
    ("$" + r.oosPerDay.toFixed(2)).padStart(8),
    r.oosPf.toFixed(2).padStart(7),
    (r.oosWr.toFixed(1) + "%").padStart(8),
    ("$" + r.oosMaxDD.toFixed(0)).padStart(8),
  ].join(" "));
}

// Per-engine breakdown
console.log("\n" + "=".repeat(140));
console.log("  PER-ENGINE BREAKDOWN (full period, each config)\n");

for (const [label, trades] of allRunTrades) {
  console.log(`  ${label}:`);
  const engines = label === "F SOLO $3" ? ["F"] : ["A", "B", "C", "D", ...(label.includes("F$") ? ["F"] : [])];
  for (const eng of engines) {
    const et = trades.filter(t => t.engine === eng);
    if (et.length === 0) continue;
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = et.reduce((s, t) => s + t.pnl, 0);
    const pf = gl > 0 ? gp / gl : 99;
    const pd = total / fullDays;
    const wr = et.length > 0 ? (wins.length / et.length * 100).toFixed(1) : "0";
    const oosEt = et.filter(t => t.entryTime >= OOS_START);
    const oosTotal = oosEt.reduce((s, t) => s + t.pnl, 0);
    const oosPd = oosTotal / oosDays;
    console.log(`    Engine ${eng}: ${et.length} trades | $${pd.toFixed(2)}/day | PF ${pf.toFixed(2)} | WR ${wr}% | OOS $${oosPd.toFixed(2)}/day`);
  }
}

// Correlation report
console.log("\n" + "=".repeat(140));
console.log("  ENGINE F CORRELATION vs BASELINE (A+B+C+D) DAILY PNL\n");
console.log(`  F$3 trades vs baseline:  full corr=${corrF3Full.toFixed(3)}  OOS corr=${corrF3Oos.toFixed(3)}`);
console.log(`  F$5 trades vs baseline:  full corr=${corrF5Full.toFixed(3)}  OOS corr=${corrF5Oos.toFixed(3)}`);
console.log(`  F SOLO vs baseline:      full corr=${corrFSoloFull.toFixed(3)}  OOS corr=${corrFSoloOos.toFixed(3)}`);

// Verdict
console.log("\n" + "=".repeat(140));
console.log("  VERDICT\n");

const baseline = results.find(r => r.label === "BASELINE (A+B+C+D)")!;
const withF3 = results.find(r => r.label === "A+B+C+D + F$3")!;
const withF5 = results.find(r => r.label === "A+B+C+D + F$5")!;
const fSolo = results.find(r => r.label === "F SOLO $3")!;

const fSoloVerdict = fSolo.oosPf >= 1.1 && fSolo.oosPerDay > 0 ? "PASS" : fSolo.oosPerDay > 0 ? "MARGINAL" : "FAIL";
const f3Verdict = withF3.oosPerDay > baseline.oosPerDay && withF3.oosMaxDD <= baseline.oosMaxDD * 1.3 ? "PASS" : "MARGINAL";
const f5Verdict = withF5.oosPerDay > baseline.oosPerDay && withF5.oosMaxDD <= baseline.oosMaxDD * 1.3 ? "PASS" : "MARGINAL";

console.log(`  F SOLO standalone: ${fSoloVerdict} (OOS PF=${fSolo.oosPf.toFixed(2)}, OOS $/day=$${fSolo.oosPerDay.toFixed(2)})`);
console.log(`  Ensemble +F$3:     ${f3Verdict} (OOS $/day: $${baseline.oosPerDay.toFixed(2)} -> $${withF3.oosPerDay.toFixed(2)}, MaxDD: $${baseline.oosMaxDD.toFixed(0)} -> $${withF3.oosMaxDD.toFixed(0)})`);
console.log(`  Ensemble +F$5:     ${f5Verdict} (OOS $/day: $${baseline.oosPerDay.toFixed(2)} -> $${withF5.oosPerDay.toFixed(2)}, MaxDD: $${baseline.oosMaxDD.toFixed(0)} -> $${withF5.oosMaxDD.toFixed(0)})`);

const bestF = withF3.oosPerDay >= withF5.oosPerDay ? withF3 : withF5;
const bestLabel = withF3.oosPerDay >= withF5.oosPerDay ? "F$3" : "F$5";
const deltaDay = bestF.oosPerDay - baseline.oosPerDay;
const deltaDD = bestF.oosMaxDD - baseline.oosMaxDD;
const corrBest = bestLabel === "F$3" ? corrF3Oos : corrF5Oos;
console.log(`\n  Best ensemble config: ${bestLabel}`);
console.log(`    OOS $/day delta: ${deltaDay >= 0 ? "+" : ""}$${deltaDay.toFixed(2)}/day`);
console.log(`    OOS MaxDD delta: ${deltaDD >= 0 ? "+" : ""}$${deltaDD.toFixed(0)}`);
console.log(`    Engine F OOS corr vs existing engines: ${corrBest.toFixed(3)}`);

if (Math.abs(corrBest) < 0.1 && fSoloVerdict !== "FAIL") {
  console.log(`\n  RECOMMENDATION: Engine F adds uncorrelated alpha (corr ${corrBest.toFixed(3)}). Consider adding to live ensemble.`);
} else if (fSoloVerdict === "FAIL") {
  console.log(`\n  RECOMMENDATION: Engine F standalone is unprofitable in OOS. Do not add to ensemble.`);
} else {
  console.log(`\n  RECOMMENDATION: Engine F has moderate correlation (${corrBest.toFixed(3)}) with existing engines. Marginal benefit.`);
}

console.log("\nDone.");
