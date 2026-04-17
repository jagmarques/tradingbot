/**
 * Beta-Weighted MR (Engine G) validated against the full 4-engine ensemble.
 *
 * Configs:
 *   1. Baseline 4 engines (A=$2, B=$3, C=$9, D=$3) with 40/3 trail+reentry
 *   2. 4 engines + Beta MR $3 with 40/3 trail+reentry
 *   3. 4 engines + Beta MR $5 with 40/3 trail+reentry
 *   4. Beta MR SOLO $3
 *
 * Engine G (Beta MR):
 *   - Rolling 30-bar (4h) OLS beta of alt vs BTC on returns
 *   - Signal: residual = altReturn - beta*btcReturn; if residual > 2*residualStd -> SHORT (overshot up)
 *             if residual < -2*residualStd -> LONG (overshot down)
 *   - SL: ATR(14)*2 capped 3.5%
 *   - Exit: excess returns to zero (|residual| < 0.5*residualStd) OR 24h max hold OR SL
 *   - Size: $3 or $5 margin, 10x leverage
 *   - BTC 4h EMA(12/21) filter for longs ONLY
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-beta-mr-ensemble.ts
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

// Engine G sizes (varied per config)
const SIZE_G_3 = 3;
const SIZE_G_5 = 5;

// Beta MR params
const BETA_WINDOW = 30;   // 30 bars (4h each = 5-day rolling window)
const BETA_SIGNAL_MULT = 2.0;    // 2 * residualStd threshold
const MR_ATR_MULT = 2.0;
const MR_MAX_SL = 0.035;
const MR_MAX_BARS = 6;           // 24h max hold in 4h bars
const MR_REVERT_MULT = 0.5;      // exit when |residual| < 0.5*residualStd

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

// --------------- load all data ---------------
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); }
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

// --------------- BTC 4h returns for beta calc ---------------
const btcH4TsMap = new Map<number, number>();
btcH4.forEach((c, i) => btcH4TsMap.set(c.t, i));
const btcH4Ret: number[] = btcH4.map((c, i) => i === 0 ? 0 : c.c / btcH4[i - 1].c - 1);

// --------------- per-pair indicators ---------------
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
  h4Ret: number[];             // bar returns for beta calc
  h4BtcRetAligned: number[];   // BTC returns aligned to this pair's h4 bars
  h4RollingBeta: number[];     // rolling OLS beta
  h4RollingResidStd: number[]; // rolling residual std
  h4ResidualNow: number[];     // current residual (altRet - beta*btcRet)

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

// Compute rolling OLS beta + residual std over 4h bars
function calcRollingBetaAndResid(
  altRet: number[],
  btcRetAligned: number[],
  window: number,
): { beta: number[]; residStd: number[]; residual: number[] } {
  const beta = new Array(altRet.length).fill(NaN);
  const residStd = new Array(altRet.length).fill(NaN);
  const residual = new Array(altRet.length).fill(NaN);

  for (let i = window; i < altRet.length; i++) {
    const aSlice = altRet.slice(i - window, i);
    const bSlice = btcRetAligned.slice(i - window, i);
    const n = window;
    let sumB = 0, sumA = 0;
    for (let j = 0; j < n; j++) { sumB += bSlice[j]; sumA += aSlice[j]; }
    const mB = sumB / n, mA = sumA / n;
    let cov = 0, varB = 0;
    for (let j = 0; j < n; j++) {
      cov += (bSlice[j] - mB) * (aSlice[j] - mA);
      varB += (bSlice[j] - mB) ** 2;
    }
    const b = varB > 1e-12 ? cov / varB : 1;
    beta[i] = b;

    // Compute residuals and their std
    let resStdSum = 0;
    for (let j = 0; j < n; j++) {
      const res = aSlice[j] - b * bSlice[j];
      resStdSum += res * res;
    }
    residStd[i] = Math.sqrt(resStdSum / n);

    // Current bar residual (using i-th bar, which is the just-completed bar)
    residual[i] = altRet[i] - b * btcRetAligned[i];
  }

  return { beta, residStd, residual };
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

  // Beta MR: compute returns aligned to BTC
  const h4Ret: number[] = h4.map((c, i) => i === 0 ? 0 : c.c / h4[i - 1].c - 1);
  const h4BtcRetAligned: number[] = h4.map(c => {
    const bIdx = btcH4TsMap.get(c.t);
    return bIdx !== undefined && bIdx > 0 ? btcH4Ret[bIdx] : 0;
  });
  const { beta: h4RollingBeta, residStd: h4RollingResidStd, residual: h4ResidualNow } =
    calcRollingBetaAndResid(h4Ret, h4BtcRetAligned, BETA_WINDOW);

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
    h4, h4StDir, h4ATR, h4TsMap, h4Ret, h4BtcRetAligned, h4RollingBeta, h4RollingResidStd, h4ResidualNow,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap,
    h4Z,
    bars1m,
  });
}

// --------------- engine signal checkers ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: string;
  size: number;
}

// Engine A: Donchian SMA(20/50) cross
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

// Engine B: Supertrend(14, 1.75) flip
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

// Engine C: GARCH v2 multi-TF z-score
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
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

// Engine D: Momentum Confirm
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

function checkMomentumReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const sig = checkMomentumConfirm(pair, t);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

// Engine G: Beta-weighted Mean Reversion
// Uses i-1 bar data (completed bar) to decide entry at bar i open.
// residualNow[i-1] = altRet[i-1] - beta[i-1] * btcRetAligned[i-1]
// Signal fires when |residual| > 2 * residualStd (both computed on closed bar)
function checkBetaMR(pair: string, t: number, gSize: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  // Need at least BETA_WINDOW+2 bars
  if (barIdx === undefined || barIdx < BETA_WINDOW + 2) return null;

  const i = barIdx;
  const prev = i - 1; // last completed bar

  const beta = ind.h4RollingBeta[prev];
  const rStd = ind.h4RollingResidStd[prev];
  const resid = ind.h4ResidualNow[prev];

  if (isNaN(beta) || isNaN(rStd) || isNaN(resid)) return null;
  if (rStd < 1e-8) return null;

  const threshold = BETA_SIGNAL_MULT * rStd;

  // BTC must have moved enough on the prior bar
  const prevBtcRet = Math.abs(ind.h4BtcRetAligned[prev]);
  if (prevBtcRet < 0.003) return null; // BTC moved < 0.3%, too noisy

  let dir: "long" | "short" | null = null;
  if (resid > threshold) dir = "short";      // alt overshot up -> fade short
  else if (resid < -threshold) dir = "long"; // alt overshot down -> fade long

  if (!dir) return null;

  // BTC 4h EMA filter: longs only (shorts always allowed for MR)
  if (dir === "long" && !btcBullish(cs[i].t)) return null;

  const curATR = ind.h4ATR[prev];
  if (curATR <= 0) return null;
  const ep = cs[i].o;
  let slDist = MR_ATR_MULT * curATR;
  if (slDist > ep * MR_MAX_SL) slDist = ep * MR_MAX_SL;
  const sl = dir === "long" ? ep - slDist : ep + slDist;

  return { dir, entryPrice: ep, sl, engine: "G", size: gSize };
}

// --------------- exit condition checkers ---------------
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

// Engine G exit: reversion signal OR 24h max hold
// Reversion = |residual| drops below MR_REVERT_MULT * residualStd on a new 4h bar
function checkBetaMRExit(pair: string, t: number, dir: "long" | "short", entryTime: number, entryBarIdx: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx <= entryBarIdx) return null;
  const bar = cs[barIdx];

  // Max hold: 24h = 6 bars
  const barsHeld = barIdx - entryBarIdx;
  if (barsHeld >= MR_MAX_BARS) {
    return { exit: true, price: bar.c, reason: "mh" };
  }

  // Reversion exit: current residual returned toward zero
  const prevIdx = barIdx - 1;
  if (prevIdx < BETA_WINDOW) return null;
  const resid = ind.h4ResidualNow[prevIdx];
  const rStd = ind.h4RollingResidStd[prevIdx];
  if (isNaN(resid) || isNaN(rStd) || rStd < 1e-8) return null;

  const revThreshold = MR_REVERT_MULT * rStd;
  if (Math.abs(resid) <= revThreshold) {
    return { exit: true, price: bar.o, reason: "rev" };
  }

  return null;
}

// --------------- position type ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  engine: string;
  size: number;
  entryPrice: number;
  effectiveEP: number;
  sl: number;
  entryTime: number;
  entryBarIdx4h: number;  // for Engine G 4h-bar-based max hold
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
  enableEngines: Set<string>,
  gSize: number,
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
      else if (pos.engine === "G") checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      else checkTime = (Math.floor(exitTime / H4) + 1) * H4;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }

    openPositions.splice(idx, 1);
  }

  function tryOpen(sig: SignalResult, pair: string, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= MAX_POS) { blockedCount++; return false; }
    if (hasOpenPos(sig.engine, pair)) { blockedCount++; return false; }

    // Get 4h bar index for Engine G max hold tracking
    let entryBarIdx4h = 0;
    if (sig.engine === "G") {
      const h4Bucket = Math.floor(t / H4) * H4;
      const ind = pairInd.get(pair);
      entryBarIdx4h = ind?.h4TsMap.get(h4Bucket) ?? 0;
    }

    const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
    openPositions.push({
      pair, dir: sig.dir, engine: sig.engine, size: sig.size,
      entryPrice: sig.entryPrice, effectiveEP: ep, sl: sig.sl,
      entryTime: t, entryBarIdx4h, peakPnlPct: 0, isReentry,
    });
    if (isReentry) reentryCount++;
    return true;
  }

  let lastPct = -1;

  for (let t = simStart; t < simEnd; t += MIN_1) {
    const pct = Math.floor(((t - simStart) / (simEnd - simStart)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // --- 1) SL, trail for all open positions (1m resolution) ---
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

    // --- 2) Engine-specific exits at check intervals ---
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
        } else if (pos.engine === "D") {
          const ex = checkMomentumExit(pos.pair, t, pos.dir, pos.entryTime);
          if (ex && ex.exit) closePos(pi, t, ex.price, ex.reason, false);
        } else if (pos.engine === "G") {
          const ex = checkBetaMRExit(pos.pair, t, pos.dir, pos.entryTime, pos.entryBarIdx4h);
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
    if (isDailyBoundary(t) && enableEngines.has("A")) {
      for (const pair of PAIRS) {
        const sig = checkDonchian(pair, t);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    if (is4hBoundary(t)) {
      if (enableEngines.has("B")) {
        for (const pair of PAIRS) {
          const sig = checkSupertrend(pair, t);
          if (sig) tryOpen(sig, pair, t, false);
        }
      }
      if (enableEngines.has("D")) {
        for (const pair of PAIRS) {
          const sig = checkMomentumConfirm(pair, t);
          if (sig) tryOpen(sig, pair, t, false);
        }
      }
      if (enableEngines.has("G")) {
        for (const pair of PAIRS) {
          const sig = checkBetaMR(pair, t, gSize);
          if (sig) tryOpen(sig, pair, t, false);
        }
      }
    }

    if (is1hBoundary(t) && enableEngines.has("C")) {
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
        else if ((re.engine === "D" || re.engine === "G") && is4hBoundary(t)) isBoundary = true;
        if (!isBoundary) continue;

        pendingReentries.splice(ri, 1);

        let sig: SignalResult | null = null;
        if (re.engine === "A") sig = checkDonchianReentry(re.pair, t, re.dir);
        else if (re.engine === "B") sig = checkSupertrendReentry(re.pair, t, re.dir);
        else if (re.engine === "C") sig = checkGarchV2Reentry(re.pair, t, re.dir);
        else if (re.engine === "D") sig = checkMomentumReentry(re.pair, t, re.dir);
        else if (re.engine === "G") sig = checkBetaMR(re.pair, t, gSize); // re-entry if signal still active

        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  // Close remaining at simEnd
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
    total, perDay: total / days, maxDD, sharpe, trailExits,
  };
}

// --------------- config runner ---------------
const ENGINES_4 = new Set(["A", "B", "C", "D"]);
const ENGINES_4G = new Set(["A", "B", "C", "D", "G"]);
const ENGINES_G_SOLO = new Set(["G"]);

interface RunConfig {
  label: string;
  engines: Set<string>;
  gSize: number;
  act: number;
  dist: number;
  reentry: boolean;
}

const configs: RunConfig[] = [
  { label: "Baseline 4-eng (40/3+RE)",  engines: ENGINES_4,      gSize: 0,      act: 40, dist: 3,  reentry: true },
  { label: "4-eng+BetaMR$3 (40/3+RE)",  engines: ENGINES_4G,     gSize: SIZE_G_3, act: 40, dist: 3,  reentry: true },
  { label: "4-eng+BetaMR$5 (40/3+RE)",  engines: ENGINES_4G,     gSize: SIZE_G_5, act: 40, dist: 3,  reentry: true },
  { label: "BetaMR SOLO $3",            engines: ENGINES_G_SOLO, gSize: SIZE_G_3, act: 0,  dist: 0,  reentry: false },
];

console.log("Running chronological simulation...\n");
console.log("Configs: 4 baselines + Beta MR engine G variants");
console.log("Full period: 2023-01 to 2026-03 | OOS: 2025-09+\n");

const results: Metrics[] = [];
const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

for (const cfg of configs) {
  process.stdout.write(`${cfg.label}...`);

  const full = runSim(cfg.act, cfg.dist, cfg.reentry, FULL_START, FULL_END, cfg.engines, cfg.gSize);
  const fm = computeMetrics(full.trades, FULL_START, FULL_END);

  const oosTrades = full.trades.filter(t => t.entryTime >= OOS_START);
  const om = computeMetrics(oosTrades, OOS_START, FULL_END);

  results.push({
    label: cfg.label,
    trades: full.trades.length,
    reentries: full.reentries,
    wr: fm.wr,
    pf: fm.pf,
    total: fm.total,
    perDay: fm.perDay,
    maxDD: fm.maxDD,
    sharpe: fm.sharpe,
    blocked: full.blocked,
    trailExits: fm.trailExits,
    oosTotal: om.total,
    oosPerDay: om.perDay,
    oosPf: om.pf,
    oosWr: om.wr,
  });

  console.log(` ${full.trades.length} trades, $${fm.perDay.toFixed(2)}/day, DD $${fm.maxDD.toFixed(0)}, PF ${fm.pf.toFixed(2)}, OOS $${om.perDay.toFixed(2)}/day`);
}

// --------------- print results ---------------
console.log("\n" + "=".repeat(175));
console.log("BETA-WEIGHTED MR (ENGINE G) vs FULL ENSEMBLE");
console.log("Engines: A=$2 Donchian SMA20/50 | B=$3 ST 14/1.75 | C=$9 GARCHv2 | D=$3 Momentum | G=BetaMR ATR2 24h");
console.log("BTC 4h EMA(12/21) filter for longs | Max 20 positions shared | 40/3 trail+reentry");
console.log("Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("=".repeat(175));

const hdr = [
  "Config".padEnd(30),
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
  "OOS WR%".padStart(8),
].join(" ");
console.log(`\n${hdr}`);
console.log("-".repeat(175));

for (const r of results) {
  console.log([
    r.label.padEnd(30),
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
    r.oosWr.toFixed(1).padStart(7) + "%",
  ].join(" "));
}

// Per-engine breakdown for all configs
console.log("\n" + "=".repeat(175));
console.log("Per-engine breakdown:");
for (const cfg of configs) {
  const full = runSim(cfg.act, cfg.dist, cfg.reentry, FULL_START, FULL_END, cfg.engines, cfg.gSize);
  const engSet = [...cfg.engines];
  const parts: string[] = [];
  for (const eng of engSet) {
    const et = full.trades.filter(t => t.engine === eng);
    if (et.length === 0) continue;
    const wins = et.filter(t => t.pnl > 0);
    const losses = et.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = et.reduce((s, t) => s + t.pnl, 0);
    const pf = gl > 0 ? gp / gl : 99;
    const perDay = total / fullDays;
    const wr = et.length > 0 ? (wins.length / et.length) * 100 : 0;
    parts.push(`${eng}: N=${et.length} $/d=$${perDay.toFixed(2)} PF=${pf.toFixed(2)} WR=${wr.toFixed(0)}%`);
  }
  console.log(`  ${cfg.label}:`);
  for (const p of parts) console.log(`    ${p}`);
}

// Marginal contribution of Engine G
console.log("\n" + "=".repeat(175));
const baseline = results[0]!;
const withG3 = results[1]!;
const withG5 = results[2]!;
const soloG = results[3]!;
console.log("Marginal contribution of Engine G:");
console.log(`  +G$3 vs baseline: $/day ${withG3.perDay >= baseline.perDay ? "+" : ""}$${(withG3.perDay - baseline.perDay).toFixed(2)}, MaxDD ${withG3.maxDD <= baseline.maxDD ? "" : "+"}$${(withG3.maxDD - baseline.maxDD).toFixed(0)}, PF ${withG3.pf.toFixed(2)} vs ${baseline.pf.toFixed(2)}`);
console.log(`  +G$5 vs baseline: $/day ${withG5.perDay >= baseline.perDay ? "+" : ""}$${(withG5.perDay - baseline.perDay).toFixed(2)}, MaxDD ${withG5.maxDD <= baseline.maxDD ? "" : "+"}$${(withG5.maxDD - baseline.maxDD).toFixed(0)}, PF ${withG5.pf.toFixed(2)} vs ${baseline.pf.toFixed(2)}`);
console.log(`  Solo G$3: $/day $${soloG.perDay.toFixed(2)}, MaxDD $${soloG.maxDD.toFixed(0)}, PF ${soloG.pf.toFixed(2)}, WR ${soloG.wr.toFixed(1)}%, OOS $/day $${soloG.oosPerDay.toFixed(2)}`);
console.log(`  OOS G$3 vs baseline OOS: ${withG3.oosPerDay >= baseline.oosPerDay ? "+" : ""}$${(withG3.oosPerDay - baseline.oosPerDay).toFixed(2)}/day`);
console.log(`  OOS G$5 vs baseline OOS: ${withG5.oosPerDay >= baseline.oosPerDay ? "+" : ""}$${(withG5.oosPerDay - baseline.oosPerDay).toFixed(2)}/day`);

console.log("\nDone.");
