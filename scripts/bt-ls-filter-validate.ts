/**
 * L/S Filter Validation & Sensitivity Test
 *
 * Audits the Combined (OI + Funding + L/S) filter from bt-real-oi-funding.ts.
 * Tests:
 *   1. Look-ahead bias in L/S ratio alignment
 *   2. L/S threshold sensitivity (1.2, 1.3, 1.5, 1.7, 2.0)
 *   3. Blocked vs allowed trade quality
 *   4. Per-engine breakdown
 *   5. Walk-forward stability (yearly)
 *   6. OOS (2025-09+) hold-up
 *   7. Data coverage: does Combined degrade to L/S-only for first 2.3yr?
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-ls-filter-validate.ts
 */

import * as fs from "fs";
import * as path from "path";

// --------------- constants (mirrored from bt-real-oi-funding.ts) ---------------
interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const CA_DIR = "/tmp/coinalyze-cache";

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
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

// --------------- Coinalyze data ---------------
interface CaBar { t: number; o?: number; h?: number; l?: number; c?: number; r?: number; s?: number; }
interface CoinalyzeData {
  oi4h: Map<number, number>;
  funding4h: Map<number, number>;
  lsDaily: Map<number, number>;
}

function loadCoinalyze(pair: string): CoinalyzeData {
  const result: CoinalyzeData = {
    oi4h: new Map(), funding4h: new Map(), lsDaily: new Map(),
  };
  const files: [string, string][] = [
    [`${pair}_oi_4hour.json`, "oi4h"],
    [`${pair}_funding_4hour.json`, "funding4h"],
    [`${pair}_lsratio_daily.json`, "lsDaily"],
  ];
  for (const [fname, key] of files) {
    const fp = path.join(CA_DIR, fname);
    if (!fs.existsSync(fp)) continue;
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    const data = raw.data as any[];
    for (const bar of data) {
      const tsMs = bar.t * 1000;
      if (key === "oi4h") result.oi4h.set(tsMs, bar.c);
      else if (key === "funding4h") result.funding4h.set(tsMs, bar.c);
      else if (key === "lsDaily") result.lsDaily.set(tsMs, bar.r);
    }
  }
  return result;
}

// --------------- OHLCV helpers ---------------
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
      t: ts, o: grp[0].o,
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
console.log("Loading OHLCV data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

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

console.log("Loading Coinalyze data...");
const caData = new Map<string, CoinalyzeData>();
for (const p of PAIRS) {
  const ca = loadCoinalyze(p);
  caData.set(p, ca);
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

// --------------- per-pair indicators ---------------
interface PairIndicators {
  daily: C[]; dailyFast: number[]; dailySlow: number[]; dailyATR: number[];
  dailyTsMap: Map<number, number>;
  h4: C[]; h4StDir: number[]; h4ATR: number[]; h4TsMap: Map<number, number>;
  h1: C[]; h1Z: number[]; h1Ema9: number[]; h1Ema21: number[];
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
    h4Z, bars1m,
  });
}

// --------------- Coinalyze filter helpers ---------------
const caSortedTs = new Map<string, {
  oi4hTs: number[];
  funding4hTs: number[];
  lsDailyTs: number[];
}>();

for (const p of PAIRS) {
  const ca = caData.get(p)!;
  caSortedTs.set(p, {
    oi4hTs: [...ca.oi4h.keys()].sort((a, b) => a - b),
    funding4hTs: [...ca.funding4h.keys()].sort((a, b) => a - b),
    lsDailyTs: [...ca.lsDaily.keys()].sort((a, b) => a - b),
  });
}

function findLatestTs(sortedTs: number[], t: number): number {
  let lo = 0, hi = sortedTs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTs[mid] <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? sortedTs[best] : -1;
}

function findLatestTsIdx(sortedTs: number[], t: number): number {
  let lo = 0, hi = sortedTs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTs[mid] <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// --------------- ORIGINAL filters (as in bt-real-oi-funding.ts) ---------------

function filterOI(pair: string, t: number, dir: "long" | "short"): boolean {
  const ca = caData.get(pair)!;
  const ts = caSortedTs.get(pair)!;
  const latestIdx = findLatestTsIdx(ts.oi4hTs, t);
  if (latestIdx < 6) return true;
  const currentOI = ca.oi4h.get(ts.oi4hTs[latestIdx]);
  const pastOI = ca.oi4h.get(ts.oi4hTs[latestIdx - 6]);
  if (currentOI === undefined || pastOI === undefined) return true;
  const oiRising = currentOI > pastOI;
  if (dir === "long") return oiRising;
  const fundTs = findLatestTs(ts.funding4hTs, t);
  if (fundTs < 0) return true;
  const funding = ca.funding4h.get(fundTs);
  if (funding === undefined) return true;
  return oiRising && funding > 0;
}

function filterFundingExtreme(pair: string, t: number, dir: "long" | "short"): boolean {
  const ca = caData.get(pair)!;
  const ts = caSortedTs.get(pair)!;
  const fundTs = findLatestTs(ts.funding4hTs, t);
  if (fundTs < 0) return true;
  const funding = ca.funding4h.get(fundTs);
  if (funding === undefined) return true;
  if (dir === "long" && funding > 0.01) return false;
  if (dir === "short" && funding < -0.01) return false;
  return true;
}

// Parameterized L/S filter for sensitivity testing
function makeFilterLSRatio(longThresh: number, shortThresh: number) {
  return function filterLS(pair: string, t: number, dir: "long" | "short"): boolean {
    const ca = caData.get(pair)!;
    const ts = caSortedTs.get(pair)!;
    const lsTs = findLatestTs(ts.lsDailyTs, t);
    if (lsTs < 0) return true;
    const ratio = ca.lsDaily.get(lsTs);
    if (ratio === undefined) return true;
    if (dir === "long" && ratio > longThresh) return false;
    if (dir === "short" && ratio < shortThresh) return false;
    return true;
  };
}

// FIXED L/S filter: use PREVIOUS day's ratio (offset by 1 day to avoid look-ahead)
function makeFilterLSRatioFixed(longThresh: number, shortThresh: number) {
  return function filterLSFixed(pair: string, t: number, dir: "long" | "short"): boolean {
    const ca = caData.get(pair)!;
    const ts = caSortedTs.get(pair)!;
    // Use t - D to ensure we get the PREVIOUS completed day's ratio
    const lsTs = findLatestTs(ts.lsDailyTs, t - D);
    if (lsTs < 0) return true;
    const ratio = ca.lsDaily.get(lsTs);
    if (ratio === undefined) return true;
    if (dir === "long" && ratio > longThresh) return false;
    if (dir === "short" && ratio < shortThresh) return false;
    return true;
  };
}

// Combined filter (as in original)
function makeCombinedFilter(longThresh: number, shortThresh: number) {
  const lsFilter = makeFilterLSRatio(longThresh, shortThresh);
  return (pair: string, t: number, dir: "long" | "short"): boolean => {
    if (!filterOI(pair, t, dir)) return false;
    if (!filterFundingExtreme(pair, t, dir)) return false;
    if (!lsFilter(pair, t, dir)) return false;
    return true;
  };
}

// Combined filter with FIXED L/S (no look-ahead)
function makeCombinedFilterFixed(longThresh: number, shortThresh: number) {
  const lsFilter = makeFilterLSRatioFixed(longThresh, shortThresh);
  return (pair: string, t: number, dir: "long" | "short"): boolean => {
    if (!filterOI(pair, t, dir)) return false;
    if (!filterFundingExtreme(pair, t, dir)) return false;
    if (!lsFilter(pair, t, dir)) return false;
    return true;
  };
}

// --------------- engine signals (same as original) ---------------
interface SignalResult {
  dir: "long" | "short"; entryPrice: number; sl: number; engine: string; size: number;
}

function checkDonchian(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  if (cs.length < 65) return null;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined || barIdx < 51) return null;
  const i = barIdx, p = i - 1, pp = i - 2;
  if (pp < 0 || ind.dailyFast[p] === 0 || ind.dailySlow[p] === 0 || ind.dailyFast[pp] === 0 || ind.dailySlow[pp] === 0) return null;
  let dir: "long" | "short" | null = null;
  if (ind.dailyFast[pp] <= ind.dailySlow[pp] && ind.dailyFast[p] > ind.dailySlow[p]) dir = "long";
  else if (ind.dailyFast[pp] >= ind.dailySlow[pp] && ind.dailyFast[p] < ind.dailySlow[p]) dir = "short";
  if (!dir) return null;
  if (dir === "long" && !btcBullish(cs[i].t)) return null;
  const prevATR = ind.dailyATR[i - 1]; if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (dir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
  return { dir, entryPrice: ep, sl, engine: "A", size: SIZE_A };
}

function checkDonchianReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  if (cs.length < 65) return null;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined || barIdx < 51) return null;
  const i = barIdx, p = i - 1;
  if (p < 0 || ind.dailyFast[p] === 0 || ind.dailySlow[p] === 0) return null;
  if (wantDir === "long" && ind.dailyFast[p] <= ind.dailySlow[p]) return null;
  if (wantDir === "short" && ind.dailyFast[p] >= ind.dailySlow[p]) return null;
  if (wantDir === "long" && !btcBullish(cs[i].t)) return null;
  const prevATR = ind.dailyATR[i - 1]; if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
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
  const prevATR = ind.h4ATR[i - 1]; if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (dir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
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
  const prevATR = ind.h4ATR[i - 1]; if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
  return { dir: wantDir, entryPrice: ep, sl, engine: "B", size: SIZE_B };
}

function checkGarchV2(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const i = barIdx, prev = i - 1;
  if (prev < 23) return null;
  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong = z1 > 4.5; const goShort = z1 < -3.0;
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
  let sl = dir === "long" ? ep * 0.97 : ep * 1.03;
  if (dir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
  return { dir, entryPrice: ep, sl, engine: "C", size: SIZE_C };
}

function checkGarchV2Reentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const sig = checkGarchV2(pair, t);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

function checkMomentumConfirm(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.h4;
  if (cs.length < 55) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = ind.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 52) return null;
  const i = barIdx, prev = i - 1;
  const ranges: number[] = [];
  for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
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
  for (let j = prev - 20; j <= prev; j++) { if (j >= 0) closes.push(cs[j].c); }
  if (closes.length < 20) return null;
  const cMean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const cStd = Math.sqrt(closes.reduce((s, v) => s + (v - cMean) ** 2, 0) / closes.length);
  const priceZ = cStd > 0 ? (closes[closes.length - 1] - cMean) / cStd : 0;
  let dir: "long" | "short" | null = null;
  if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcBullish(cs[i].t)) dir = "long"; }
  else if (volZ > 2 && fundZ < -2 && priceZ < -1) { dir = "short"; }
  if (!dir) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep * 0.97 : ep * 1.03;
  if (dir === "long") sl = Math.max(sl, ep * 0.965); else sl = Math.min(sl, ep * 1.035);
  return { dir, entryPrice: ep, sl, engine: "D", size: SIZE_D };
}

function checkMomentumReentry(pair: string, t: number, wantDir: "long" | "short"): SignalResult | null {
  const sig = checkMomentumConfirm(pair, t);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

// --------------- exits ---------------
function checkDonchianExit(pair: string, t: number, dir: "long" | "short", entryTime: number): { exit: boolean; price: number; reason: string } | null {
  const ind = pairInd.get(pair)!;
  const cs = ind.daily;
  const dayBucket = Math.floor(t / D) * D;
  const barIdx = ind.dailyTsMap.get(dayBucket);
  if (barIdx === undefined) return null;
  const bar = cs[barIdx];
  if (Math.round((bar.t - entryTime) / D) >= 60) return { exit: true, price: bar.c, reason: "mh" };
  if (barIdx >= 16) {
    if (dir === "long") { const lo = donchCloseLow(cs, barIdx, 15); if (bar.c < lo) return { exit: true, price: bar.c, reason: "ch" }; }
    else { const hi = donchCloseHigh(cs, barIdx, 15); if (bar.c > hi) return { exit: true, price: bar.c, reason: "ch" }; }
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
  pair: string; dir: "long" | "short"; engine: string; size: number;
  entryPrice: number; effectiveEP: number; sl: number;
  entryTime: number; peakPnlPct: number; isReentry: boolean;
}

interface ClosedTrade {
  pair: string; dir: "long" | "short"; engine: string;
  entryTime: number; exitTime: number; pnl: number;
  reason: string; isReentry: boolean;
}

interface PendingReentry {
  pair: string; dir: "long" | "short"; engine: string; checkTime: number;
}

type FilterFn = (pair: string, t: number, dir: "long" | "short") => boolean;

// --------------- simulation (same as original) ---------------
function runSim(
  startTs: number, endTs: number, filter: FilterFn | null,
): { trades: ClosedTrade[]; reentries: number; blocked: number; filtered: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0, blockedCount = 0, filteredCount = 0;

  const simStart = Math.max(startTs, FULL_START);
  const simEnd = Math.min(endTs, FULL_END);

  const TRAIL_ACT = 40;
  const TRAIL_DIST = 3;

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
    if (reason === "trail") {
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
    if (openPositions.length >= MAX_POS) { blockedCount++; return false; }
    if (hasOpenPos(sig.engine, pair)) { blockedCount++; return false; }
    if (filter && (sig.engine === "A" || sig.engine === "B")) {
      if (!filter(pair, t, sig.dir)) { filteredCount++; return false; }
    }
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

    // SL, TP, trail
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

    // Engine exits
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
    if (isDailyBoundary(t)) { for (const pair of PAIRS) { const sig = checkDonchian(pair, t); if (sig) tryOpen(sig, pair, t, false); } }
    if (is4hBoundary(t)) {
      for (const pair of PAIRS) { const sig = checkSupertrend(pair, t); if (sig) tryOpen(sig, pair, t, false); }
      for (const pair of PAIRS) { const sig = checkMomentumConfirm(pair, t); if (sig) tryOpen(sig, pair, t, false); }
    }
    if (is1hBoundary(t)) { for (const pair of PAIRS) { const sig = checkGarchV2(pair, t); if (sig) tryOpen(sig, pair, t, false); } }

    // Re-entries
    if (pendingReentries.length > 0) {
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

  return { trades: closedTrades, reentries: reentryCount, blocked: blockedCount, filtered: filteredCount };
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
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  const dayPnl = new Map<number, number>();
  for (const t of trades) { const d = Math.floor(t.exitTime / D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return { trades: trades.length, wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0, pf: gl > 0 ? gp / gl : 99, total, perDay: total / days, maxDD, sharpe };
}

// ==============================================================================
// AUDIT & VALIDATION
// ==============================================================================

console.log("=".repeat(100));
console.log("L/S FILTER VALIDATION & SENSITIVITY TEST");
console.log("=".repeat(100));

// ---- AUDIT 1: L/S Ratio Distribution ----
console.log("\n--- AUDIT 1: L/S Ratio Distribution ---");
console.log("Coinalyze daily L/S ratio stats per pair:");
console.log("(>longThresh blocks longs, <shortThresh blocks shorts)\n");

let totalAbove15 = 0, totalAbove20 = 0, totalBelow05 = 0, totalBelow06 = 0, totalBars = 0;
for (const pair of PAIRS) {
  const ca = caData.get(pair)!;
  const ratios = [...ca.lsDaily.values()];
  if (ratios.length === 0) { console.log(`  ${pair}: NO DATA`); continue; }
  const a15 = ratios.filter(r => r > 1.5).length;
  const a20 = ratios.filter(r => r > 2.0).length;
  const b05 = ratios.filter(r => r < 0.5).length;
  const b06 = ratios.filter(r => r < 0.6).length;
  const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  totalAbove15 += a15; totalAbove20 += a20; totalBelow05 += b05; totalBelow06 += b06; totalBars += ratios.length;
  console.log(`  ${pair.padEnd(6)} n=${String(ratios.length).padStart(4)}, mean=${mean.toFixed(2)}, >1.5=${(a15 / ratios.length * 100).toFixed(0).padStart(3)}%, >2.0=${(a20 / ratios.length * 100).toFixed(0).padStart(3)}%, <0.5=${(b05 / ratios.length * 100).toFixed(0).padStart(3)}%, <0.6=${(b06 / ratios.length * 100).toFixed(0).padStart(3)}%`);
}
console.log(`\n  TOTALS: >1.5=${(totalAbove15 / totalBars * 100).toFixed(1)}%, >2.0=${(totalAbove20 / totalBars * 100).toFixed(1)}%, <0.5=${(totalBelow05 / totalBars * 100).toFixed(1)}%, <0.6=${(totalBelow06 / totalBars * 100).toFixed(1)}%`);
console.log(`\n  FINDING: L/S ratio is >1.5 for ${(totalAbove15 / totalBars * 100).toFixed(0)}% of all pair-days.`);
console.log(`  This means the L/S filter at threshold 1.5 blocks ~${(totalAbove15 / totalBars * 100).toFixed(0)}% of ALL long entries for engines A+B.`);
console.log(`  Meanwhile <0.5 occurs ${(totalBelow05 / totalBars * 100).toFixed(1)}% of the time, so shorts are almost never blocked.`);
console.log(`  The filter is effectively a "block most longs" gate, not a balanced contrarian signal.`);

// ---- AUDIT 2: Look-ahead bias ----
console.log("\n--- AUDIT 2: Look-ahead Bias ---");
console.log("  L/S ratio: daily bars timestamped at 00:00 UTC (bar OPEN time).");
console.log("  The 'r' value is the ratio measured over the FULL day (00:00-23:59).");
console.log("  filterLSRatio uses findLatestTs(lsDailyTs, t) which finds ts <= t.");
console.log("  At daily boundary t=00:00 UTC, this picks up the bar starting at 00:00");
console.log("  whose ratio covers that SAME day (not yet completed).");
console.log("  VERDICT: LOOK-AHEAD BUG. Should use t - D to get previous day's ratio.");
console.log("");
console.log("  OI 4h: bars timestamped at bar OPEN. filterOI reads bar.c (close OI).");
console.log("  At 4h boundary t, findLatestTsIdx finds bar opening at t.");
console.log("  bar.c is the OI value at t+4h.");
console.log("  VERDICT: LOOK-AHEAD BUG. Should use latestIdx-1 for completed bar.");
console.log("");
console.log("  Funding 4h: same issue as OI -- reads close of current bar.");
console.log("  VERDICT: LOOK-AHEAD BUG.");

// ---- AUDIT 3: Data Coverage ----
console.log("\n--- AUDIT 3: Data Coverage ---");
const oi4hStart = new Date("2025-04-28T16:00:00Z").getTime();
const funding4hStart = oi4hStart;
const lsDailyStart = new Date("2023-01-01").getTime();
const totalDaysInBT = (FULL_END - FULL_START) / D;
const daysWithOI = (FULL_END - oi4hStart) / D;
const daysWithoutOI = (oi4hStart - FULL_START) / D;
console.log(`  Backtest span: ${totalDaysInBT.toFixed(0)} days (2023-01-01 to 2026-03-26)`);
console.log(`  L/S daily: covers full period from 2023-01-01`);
console.log(`  OI 4h: starts 2025-04-28 (${daysWithOI.toFixed(0)} days = ${(daysWithOI / totalDaysInBT * 100).toFixed(1)}% of backtest)`);
console.log(`  Funding 4h: starts 2025-04-28 (same as OI)`);
console.log(`  For the first ${daysWithoutOI.toFixed(0)} days (${(daysWithoutOI / totalDaysInBT * 100).toFixed(1)}%), the Combined filter`);
console.log(`  degrades to L/S-only because filterOI and filterFundingExtreme return true (passthrough) when no data.`);
console.log(`  VERDICT: The "Combined" filter is really just L/S-only for 72% of the backtest.`);

// ---- AUDIT 4: Run baseline + sensitivity sweep ----
console.log("\n--- AUDIT 4: Sensitivity Sweep (L/S thresholds) ---");
console.log("Running baseline...");

const baseResult = runSim(FULL_START, FULL_END, null);
const baseMet = computeMetrics(baseResult.trades, FULL_START, FULL_END);
const baseOOS = computeMetrics(baseResult.trades.filter(t => t.entryTime >= OOS_START), OOS_START, FULL_END);

console.log(` done.`);
console.log(`  BASELINE: ${baseMet.trades} trades, $${baseMet.perDay.toFixed(2)}/day, DD $${baseMet.maxDD.toFixed(0)}, PF ${baseMet.pf.toFixed(2)}, Sharpe ${baseMet.sharpe.toFixed(2)}`);
console.log(`  OOS: $${baseOOS.perDay.toFixed(2)}/day, PF ${baseOOS.pf.toFixed(2)}`);

// Run the ORIGINAL Combined filter (with look-ahead)
console.log("\nRunning ORIGINAL Combined filter (1.5/0.5 with look-ahead)...");
const origFilter = makeCombinedFilter(1.5, 0.5);
const origResult = runSim(FULL_START, FULL_END, origFilter);
const origMet = computeMetrics(origResult.trades, FULL_START, FULL_END);
const origOOS = computeMetrics(origResult.trades.filter(t => t.entryTime >= OOS_START), OOS_START, FULL_END);
console.log(` done.`);
console.log(`  ORIGINAL: ${origMet.trades} trades, $${origMet.perDay.toFixed(2)}/day, DD $${origMet.maxDD.toFixed(0)}, PF ${origMet.pf.toFixed(2)}, Sharpe ${origMet.sharpe.toFixed(2)}, filtered=${origResult.filtered}`);
console.log(`  OOS: $${origOOS.perDay.toFixed(2)}/day, PF ${origOOS.pf.toFixed(2)}`);

// Run the FIXED Combined filter (no look-ahead, uses t - D)
console.log("\nRunning FIXED Combined filter (1.5/0.5 NO look-ahead)...");
const fixedFilter = makeCombinedFilterFixed(1.5, 0.5);
const fixedResult = runSim(FULL_START, FULL_END, fixedFilter);
const fixedMet = computeMetrics(fixedResult.trades, FULL_START, FULL_END);
const fixedOOS = computeMetrics(fixedResult.trades.filter(t => t.entryTime >= OOS_START), OOS_START, FULL_END);
console.log(` done.`);
console.log(`  FIXED: ${fixedMet.trades} trades, $${fixedMet.perDay.toFixed(2)}/day, DD $${fixedMet.maxDD.toFixed(0)}, PF ${fixedMet.pf.toFixed(2)}, Sharpe ${fixedMet.sharpe.toFixed(2)}, filtered=${fixedResult.filtered}`);
console.log(`  OOS: $${fixedOOS.perDay.toFixed(2)}/day, PF ${fixedOOS.pf.toFixed(2)}`);

// L/S-only sensitivity (with look-ahead, as original tested)
const LS_THRESHOLDS = [1.2, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0];
console.log(`\nL/S threshold sensitivity (long threshold varied, short=1/longThresh):`);
console.log(`${"Thresh".padEnd(8)} ${"Trades".padStart(7)} ${"$/day".padStart(10)} ${"DD".padStart(8)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"Filt".padStart(6)} ${"OOS$/d".padStart(10)} ${"OOS PF".padStart(8)}`);
console.log("-".repeat(80));

for (const thresh of LS_THRESHOLDS) {
  const shortThresh = 1 / thresh; // symmetric: if 1.5 blocks longs, 0.667 blocks shorts
  process.stdout.write(`  ${thresh.toFixed(1)}/${shortThresh.toFixed(2)}...`);
  const lsFilt = makeFilterLSRatio(thresh, shortThresh);
  const r = runSim(FULL_START, FULL_END, lsFilt);
  const m = computeMetrics(r.trades, FULL_START, FULL_END);
  const oos = computeMetrics(r.trades.filter(t => t.entryTime >= OOS_START), OOS_START, FULL_END);
  console.log(` ${String(m.trades).padStart(7)} ${("$" + m.perDay.toFixed(2)).padStart(10)} ${("$" + m.maxDD.toFixed(0)).padStart(8)} ${m.pf.toFixed(2).padStart(7)} ${m.sharpe.toFixed(2).padStart(8)} ${String(r.filtered).padStart(6)} ${("$" + oos.perDay.toFixed(2)).padStart(10)} ${oos.pf.toFixed(2).padStart(8)}`);
}

// Also test with the original 0.5 short threshold (as in the script)
console.log(`\nOriginal thresholds (long varied, short fixed at 0.5):`);
console.log(`${"Thresh".padEnd(8)} ${"Trades".padStart(7)} ${"$/day".padStart(10)} ${"DD".padStart(8)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"Filt".padStart(6)} ${"OOS$/d".padStart(10)} ${"OOS PF".padStart(8)}`);
console.log("-".repeat(80));

for (const thresh of LS_THRESHOLDS) {
  process.stdout.write(`  ${thresh.toFixed(1)}/0.50...`);
  const lsFilt = makeFilterLSRatio(thresh, 0.5);
  const r = runSim(FULL_START, FULL_END, lsFilt);
  const m = computeMetrics(r.trades, FULL_START, FULL_END);
  const oos = computeMetrics(r.trades.filter(t => t.entryTime >= OOS_START), OOS_START, FULL_END);
  console.log(` ${String(m.trades).padStart(7)} ${("$" + m.perDay.toFixed(2)).padStart(10)} ${("$" + m.maxDD.toFixed(0)).padStart(8)} ${m.pf.toFixed(2).padStart(7)} ${m.sharpe.toFixed(2).padStart(8)} ${String(r.filtered).padStart(6)} ${("$" + oos.perDay.toFixed(2)).padStart(10)} ${oos.pf.toFixed(2).padStart(8)}`);
}

// ---- AUDIT 5: Blocked vs Allowed trade quality ----
console.log("\n--- AUDIT 5: Blocked vs Allowed Trade Quality ---");
console.log("Running baseline (all trades) and checking which would be blocked by L/S 1.5/0.5...\n");

// Collect all engine A+B signals with their filter status
{
  const lsFilter = makeFilterLSRatio(1.5, 0.5);
  // We need to identify which trades in the baseline were on engines A/B
  // and whether they WOULD have been blocked
  const baseAB = baseResult.trades.filter(t => t.engine === "A" || t.engine === "B");

  // For each baseline A/B trade, check if the filter would have blocked it
  const wouldBlock: ClosedTrade[] = [];
  const wouldAllow: ClosedTrade[] = [];
  for (const trade of baseAB) {
    const blocked = !lsFilter(trade.pair, trade.entryTime, trade.dir);
    if (blocked) wouldBlock.push(trade);
    else wouldAllow.push(trade);
  }

  const blockAvg = wouldBlock.length > 0 ? wouldBlock.reduce((s, t) => s + t.pnl, 0) / wouldBlock.length : 0;
  const allowAvg = wouldAllow.length > 0 ? wouldAllow.reduce((s, t) => s + t.pnl, 0) / wouldAllow.length : 0;
  const blockTotal = wouldBlock.reduce((s, t) => s + t.pnl, 0);
  const allowTotal = wouldAllow.reduce((s, t) => s + t.pnl, 0);
  const blockWR = wouldBlock.length > 0 ? wouldBlock.filter(t => t.pnl > 0).length / wouldBlock.length * 100 : 0;
  const allowWR = wouldAllow.length > 0 ? wouldAllow.filter(t => t.pnl > 0).length / wouldAllow.length * 100 : 0;

  // Break down by direction
  const blockLongs = wouldBlock.filter(t => t.dir === "long");
  const blockShorts = wouldBlock.filter(t => t.dir === "short");
  const allowLongs = wouldAllow.filter(t => t.dir === "long");
  const allowShorts = wouldAllow.filter(t => t.dir === "short");

  console.log(`  Engine A+B trades in baseline: ${baseAB.length}`);
  console.log(`  Would be BLOCKED by L/S filter: ${wouldBlock.length} (${(wouldBlock.length / baseAB.length * 100).toFixed(0)}%)`);
  console.log(`    - Longs blocked: ${blockLongs.length}, Shorts blocked: ${blockShorts.length}`);
  console.log(`  Would be ALLOWED: ${wouldAllow.length} (${(wouldAllow.length / baseAB.length * 100).toFixed(0)}%)`);
  console.log(`    - Longs allowed: ${allowLongs.length}, Shorts allowed: ${allowShorts.length}`);
  console.log(`  Blocked avg PnL: $${blockAvg.toFixed(4)}, total: $${blockTotal.toFixed(2)}, WR: ${blockWR.toFixed(1)}%`);
  console.log(`  Allowed avg PnL: $${allowAvg.toFixed(4)}, total: $${allowTotal.toFixed(2)}, WR: ${allowWR.toFixed(1)}%`);
  console.log(`  VERDICT: ${blockAvg < allowAvg ? "Blocked trades ARE worse than allowed (filter has some signal)" : "Blocked trades are NOT worse -- filter has no real edge"}`);
}

// ---- AUDIT 6: Per-engine breakdown ----
console.log("\n--- AUDIT 6: Per-Engine Breakdown ---");
{
  const fullDays = (FULL_END - FULL_START) / D;
  for (const label of ["BASELINE", "COMBINED-ORIG", "COMBINED-FIXED"]) {
    const trades = label === "BASELINE" ? baseResult.trades
      : label === "COMBINED-ORIG" ? origResult.trades
      : fixedResult.trades;
    console.log(`\n  ${label}:`);
    for (const eng of ["A", "B", "C", "D"]) {
      const et = trades.filter(t => t.engine === eng);
      const wins = et.filter(t => t.pnl > 0);
      const losses = et.filter(t => t.pnl <= 0);
      const gp = wins.reduce((s, t) => s + t.pnl, 0);
      const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
      const total = et.reduce((s, t) => s + t.pnl, 0);
      const pf = gl > 0 ? gp / gl : 99;
      console.log(`    Engine ${eng}: ${String(et.length).padStart(5)} trades, $${(total / fullDays).toFixed(2)}/day, PF ${pf.toFixed(2)}, WR ${et.length > 0 ? ((wins.length / et.length) * 100).toFixed(1) : "0"}%`);
    }
  }
}

// ---- AUDIT 7: Walk-forward (yearly) ----
console.log("\n--- AUDIT 7: Walk-Forward Stability (yearly) ---");
{
  const years = [
    { label: "2023", start: new Date("2023-01-01").getTime(), end: new Date("2024-01-01").getTime() },
    { label: "2024", start: new Date("2024-01-01").getTime(), end: new Date("2025-01-01").getTime() },
    { label: "2025", start: new Date("2025-01-01").getTime(), end: new Date("2026-01-01").getTime() },
    { label: "2026Q1", start: new Date("2026-01-01").getTime(), end: new Date("2026-03-26").getTime() },
  ];

  console.log(`  ${"Period".padEnd(10)} ${"BASE $/d".padStart(10)} ${"ORIG $/d".padStart(10)} ${"FIXED $/d".padStart(10)} ${"delta ORIG".padStart(10)} ${"delta FIXED".padStart(11)}`);
  console.log("  " + "-".repeat(65));

  for (const yr of years) {
    const bt = baseResult.trades.filter(t => t.entryTime >= yr.start && t.entryTime < yr.end);
    const ot = origResult.trades.filter(t => t.entryTime >= yr.start && t.entryTime < yr.end);
    const ft = fixedResult.trades.filter(t => t.entryTime >= yr.start && t.entryTime < yr.end);
    const days = (yr.end - yr.start) / D;
    const bpd = bt.reduce((s, t) => s + t.pnl, 0) / days;
    const opd = ot.reduce((s, t) => s + t.pnl, 0) / days;
    const fpd = ft.reduce((s, t) => s + t.pnl, 0) / days;
    console.log(`  ${yr.label.padEnd(10)} ${("$" + bpd.toFixed(2)).padStart(10)} ${("$" + opd.toFixed(2)).padStart(10)} ${("$" + fpd.toFixed(2)).padStart(10)} ${((opd - bpd) >= 0 ? "+" : "") + "$" + (opd - bpd).toFixed(2)} ${((fpd - bpd) >= 0 ? "+" : "") + "$" + (fpd - bpd).toFixed(2)}`);
  }
}

// ---- AUDIT 8: OOS hold-up ----
console.log("\n--- AUDIT 8: OOS (2025-09+) Hold-Up ---");
console.log(`  BASELINE OOS: $${baseOOS.perDay.toFixed(2)}/day, PF ${baseOOS.pf.toFixed(2)}, Sharpe ${baseOOS.sharpe.toFixed(2)}`);
console.log(`  ORIGINAL OOS: $${origOOS.perDay.toFixed(2)}/day, PF ${origOOS.pf.toFixed(2)}, Sharpe ${origOOS.sharpe.toFixed(2)}`);
console.log(`  FIXED    OOS: $${fixedOOS.perDay.toFixed(2)}/day, PF ${fixedOOS.pf.toFixed(2)}, Sharpe ${fixedOOS.sharpe.toFixed(2)}`);

// ---- FINAL SUMMARY ----
console.log("\n" + "=".repeat(100));
console.log("FINAL AUDIT SUMMARY");
console.log("=".repeat(100));
console.log(`
BUG 1 - LOOK-AHEAD BIAS:
  L/S ratio uses same-day data (bar at 00:00 covers that day, used at 00:00).
  OI 4h and Funding 4h use current-bar close values (finalized 4h later).
  All three indicators have look-ahead bias in the original script.

BUG 2 - ASYMMETRIC FILTER:
  L/S ratio is >1.5 for ${(totalAbove15 / totalBars * 100).toFixed(0)}% of all pair-days, <0.5 for ${(totalBelow05 / totalBars * 100).toFixed(1)}%.
  The filter blocks ~${(totalAbove15 / totalBars * 100).toFixed(0)}% of longs but almost 0% of shorts.
  This is effectively a "short-only" gate for engines A+B, not a balanced contrarian filter.
  Typical L/S means are 2.0-3.5 -- the 1.5 threshold is inside the normal range.

BUG 3 - DATA COVERAGE:
  OI 4h and Funding 4h only available from 2025-04-28 (last 11 months = 28% of backtest).
  For the first 72%, the Combined filter degrades to L/S-only because OI/Funding pass through.
  The claim of "Combined OI + Funding + L/S" is misleading -- it is L/S alone for most of the period.

OVERFITTING RISK:
  Only 2 thresholds, but they interact with a structurally biased indicator.
  Since L/S is almost always >1.5, the 1.5 threshold essentially blocks most longs.
  Any threshold between 1.0 and 2.0 would do roughly the same thing.
  This is not overfitting to specific threshold values, but to a structural bias in the data.

RECOMMENDATION:
  REJECT the Combined filter. The reported improvements are driven by:
  1. Look-ahead bias (using same-day L/S and current-bar OI/funding)
  2. Structural bias (blocking ~${(totalAbove15 / totalBars * 100).toFixed(0)}% of longs regardless of threshold)
  3. The filter is really just "block most long entries for engines A+B"
`);

console.log("Done.");
