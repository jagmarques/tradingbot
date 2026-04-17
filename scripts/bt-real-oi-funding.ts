/**
 * Real OI/Funding/Liquidation/L-S Ratio Backtest
 * Tests Coinalyze on-chain data as entry filters on the 4-engine ensemble.
 *
 * Filters applied to Donchian (A) + Supertrend (B) entries only.
 * GARCH (C) and Momentum (D) left unfiltered.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-real-oi-funding.ts
 */

import * as fs from "fs";
import * as path from "path";

// --------------- constants ---------------
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

// engine sizes (Kelly-based)
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

// 18 pairs: all 15 trading pairs + ETH, TIA, SOL that have both OHLCV and Coinalyze
const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

// --------------- Coinalyze data types ---------------
interface CaBar { t: number; o?: number; h?: number; l?: number; c?: number; r?: number; s?: number; }

interface CoinalyzeData {
  oi4h: Map<number, number>;       // ts_ms -> close OI value
  oiDaily: Map<number, number>;    // ts_ms -> close OI value
  funding4h: Map<number, number>;  // ts_ms -> funding rate (% e.g. 0.01 = 0.01%)
  liqDaily: Map<number, { l: number; s: number }>;  // ts_ms -> long/short liq volumes
  lsDaily: Map<number, number>;    // ts_ms -> l/s ratio
}

function loadCoinalyze(pair: string): CoinalyzeData {
  const result: CoinalyzeData = {
    oi4h: new Map(), oiDaily: new Map(), funding4h: new Map(),
    liqDaily: new Map(), lsDaily: new Map(),
  };

  const files: [string, string][] = [
    [`${pair}_oi_4hour.json`, "oi4h"],
    [`${pair}_oi_daily.json`, "oiDaily"],
    [`${pair}_funding_4hour.json`, "funding4h"],
    [`${pair}_liq_daily.json`, "liqDaily"],
    [`${pair}_lsratio_daily.json`, "lsDaily"],
  ];

  for (const [fname, key] of files) {
    const fp = path.join(CA_DIR, fname);
    if (!fs.existsSync(fp)) continue;
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    const data = raw.data as any[];
    for (const bar of data) {
      const tsMs = bar.t * 1000; // Coinalyze timestamps are in seconds
      if (key === "oi4h") result.oi4h.set(tsMs, bar.c);
      else if (key === "oiDaily") result.oiDaily.set(tsMs, bar.c);
      else if (key === "funding4h") result.funding4h.set(tsMs, bar.c);
      else if (key === "liqDaily") result.liqDaily.set(tsMs, { l: bar.l, s: bar.s });
      else if (key === "lsDaily") result.lsDaily.set(tsMs, bar.r);
    }
  }
  return result;
}

// --------------- OHLCV data loading ---------------
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

// Load Coinalyze data
console.log("Loading Coinalyze data...");
const caData = new Map<string, CoinalyzeData>();
for (const p of PAIRS) {
  const ca = loadCoinalyze(p);
  caData.set(p, ca);
  console.log(`  ${p}: oi4h=${ca.oi4h.size} funding=${ca.funding4h.size} liq=${ca.liqDaily.size} ls=${ca.lsDaily.size}`);
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

// --------------- pre-compute per-pair indicator arrays ---------------
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

// --------------- Coinalyze filter helpers ---------------
// These functions look up the most recent Coinalyze data point at or before time t.
// All timestamps are in ms. Coinalyze data was loaded with t*1000 conversion.

// Binary search: find the largest key in a sorted array of timestamps <= t
function findLatestTs(sortedTs: number[], t: number): number {
  let lo = 0, hi = sortedTs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTs[mid] <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? sortedTs[best] : -1;
}

// Pre-sort Coinalyze timestamps for binary search
const caSortedTs = new Map<string, {
  oi4hTs: number[];
  oiDailyTs: number[];
  funding4hTs: number[];
  liqDailyTs: number[];
  lsDailyTs: number[];
}>();

for (const p of PAIRS) {
  const ca = caData.get(p)!;
  caSortedTs.set(p, {
    oi4hTs: [...ca.oi4h.keys()].sort((a, b) => a - b),
    oiDailyTs: [...ca.oiDaily.keys()].sort((a, b) => a - b),
    funding4hTs: [...ca.funding4h.keys()].sort((a, b) => a - b),
    liqDailyTs: [...ca.liqDaily.keys()].sort((a, b) => a - b),
    lsDailyTs: [...ca.lsDaily.keys()].sort((a, b) => a - b),
  });
}

// Filter 1: OI Confirmation
// Longs: 4h OI is rising (current > 6 bars ago)
// Shorts: 4h OI rising AND funding positive (crowded longs about to get liquidated)
function filterOI(pair: string, t: number, dir: "long" | "short"): boolean {
  const ca = caData.get(pair)!;
  const ts = caSortedTs.get(pair)!;

  // Find current 4h OI bar and the one 6 bars ago
  const latestIdx = findLatestTsIdx(ts.oi4hTs, t);
  if (latestIdx < 6) return true; // no data = pass through
  const currentOI = ca.oi4h.get(ts.oi4hTs[latestIdx]);
  const pastOI = ca.oi4h.get(ts.oi4hTs[latestIdx - 6]);
  if (currentOI === undefined || pastOI === undefined) return true;

  const oiRising = currentOI > pastOI;

  if (dir === "long") {
    return oiRising;
  } else {
    // Shorts: OI rising + funding positive
    const fundTs = findLatestTs(ts.funding4hTs, t);
    if (fundTs < 0) return true;
    const funding = ca.funding4h.get(fundTs);
    if (funding === undefined) return true;
    return oiRising && funding > 0;
  }
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

// Filter 2: Liquidation Reversal
// After daily liq spike (total > 2x 20-day avg), enter OPPOSITE direction only
// Returns true if the signal direction is allowed, false if blocked
function filterLiqReversal(pair: string, t: number, dir: "long" | "short"): boolean {
  const ca = caData.get(pair)!;
  const ts = caSortedTs.get(pair)!;

  const latestIdx = findLatestTsIdx(ts.liqDailyTs, t);
  if (latestIdx < 20) return true; // not enough data

  // Get last 20 days of total liquidation
  const recentLiqs: number[] = [];
  for (let i = latestIdx - 20; i < latestIdx; i++) {
    const liq = ca.liqDaily.get(ts.liqDailyTs[i]);
    if (liq) recentLiqs.push(liq.l + liq.s);
  }
  if (recentLiqs.length < 15) return true;

  const avg20 = recentLiqs.reduce((s, v) => s + v, 0) / recentLiqs.length;
  const currentLiq = ca.liqDaily.get(ts.liqDailyTs[latestIdx]);
  if (!currentLiq) return true;
  const totalLiq = currentLiq.l + currentLiq.s;

  if (totalLiq > 2 * avg20) {
    // Spike detected -- check which side got liquidated more
    // If more longs liquidated, go long (reversal = exhaustion)
    // If more shorts liquidated, go short (reversal = exhaustion)
    if (currentLiq.l > currentLiq.s) {
      // Mostly long liquidations -> reversal = go long (longs exhausted, bounce)
      return dir === "long";
    } else {
      // Mostly short liquidations -> reversal = go short
      return dir === "short";
    }
  }

  return true; // no spike, pass through
}

// Filter 3: Funding Extreme
// Block longs when funding > 0.01% per 4h (crowded long)
// Block shorts when funding < -0.01% per 4h (crowded short)
function filterFundingExtreme(pair: string, t: number, dir: "long" | "short"): boolean {
  const ca = caData.get(pair)!;
  const ts = caSortedTs.get(pair)!;

  const fundTs = findLatestTs(ts.funding4hTs, t);
  if (fundTs < 0) return true;
  const funding = ca.funding4h.get(fundTs);
  if (funding === undefined) return true;

  if (dir === "long" && funding > 0.01) return false;   // crowded long, block
  if (dir === "short" && funding < -0.01) return false;  // crowded short, block
  return true;
}

// Filter 4: L/S Ratio Contrarian
// Block longs when L/S > 1.5 (too many longs)
// Block shorts when L/S < 0.5 (too many shorts... actually too few longs)
function filterLSRatio(pair: string, t: number, dir: "long" | "short"): boolean {
  const ca = caData.get(pair)!;
  const ts = caSortedTs.get(pair)!;

  const lsTs = findLatestTs(ts.lsDailyTs, t);
  if (lsTs < 0) return true;
  const ratio = ca.lsDaily.get(lsTs);
  if (ratio === undefined) return true;

  if (dir === "long" && ratio > 1.5) return false;   // too many longs
  if (dir === "short" && ratio < 0.5) return false;   // too many shorts
  return true;
}

// --------------- engine signal checkers ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: string;
  size: number;
}

// Engine A: Donchian
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

// Engine B: Supertrend
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

// Engine C: GARCH v2
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

  const i9 = prev;
  const i21 = prev;
  if (i9 < 0 || i21 < 0) return null;
  if (ind.h1Ema9[i9] === 0 || ind.h1Ema21[i21] === 0) return null;
  if (goLong && ind.h1Ema9[i9] <= ind.h1Ema21[i21]) return null;
  if (goShort && ind.h1Ema9[i9] >= ind.h1Ema21[i21]) return null;

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

// --------------- filter type ---------------
type FilterFn = (pair: string, t: number, dir: "long" | "short") => boolean;

// --------------- simulation ---------------
function runSim(
  act: number,
  dist: number,
  doReentry: boolean,
  startTs: number,
  endTs: number,
  filter: FilterFn | null,
): { trades: ClosedTrade[]; reentries: number; blocked: number; filtered: number } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;
  let filteredCount = 0;

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
    if (openPositions.length >= MAX_POS) { blockedCount++; return false; }
    if (hasOpenPos(sig.engine, pair)) { blockedCount++; return false; }

    // Apply Coinalyze filter for engines A and B only
    if (filter && (sig.engine === "A" || sig.engine === "B")) {
      if (!filter(pair, t, sig.dir)) {
        filteredCount++;
        return false;
      }
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

    // 1) SL, TP, trail for open positions
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
        if (currPct <= pos.peakPnlPct - dist) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
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

    // 4) Re-entries
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

  // Close remaining positions
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
  filtered: number;
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

// --------------- run all filter configs ---------------
console.log("Running simulations...\n");

const TRAIL_ACT = 40;
const TRAIL_DIST = 3;
const DO_REENTRY = true;

// Define filter configs
const filterConfigs: { label: string; filter: FilterFn | null }[] = [
  { label: "1-BASELINE", filter: null },
  { label: "2-OI-CONFIRM", filter: filterOI },
  { label: "3-LIQ-REVERSAL", filter: filterLiqReversal },
  { label: "4-FUND-EXTREME", filter: filterFundingExtreme },
  { label: "5-LS-CONTRARIAN", filter: filterLSRatio },
  {
    label: "6-COMBINED",
    filter: (pair, t, dir) => {
      // Combine the best individual filters -- run all, require all pass
      // This will be evaluated after seeing individual results
      // Start with: OI + Funding + LS
      if (!filterOI(pair, t, dir)) return false;
      if (!filterFundingExtreme(pair, t, dir)) return false;
      if (!filterLSRatio(pair, t, dir)) return false;
      return true;
    },
  },
];

const results: Metrics[] = [];
const fullDays = (FULL_END - FULL_START) / D;

for (const cfg of filterConfigs) {
  process.stdout.write(`${cfg.label}...`);

  const full = runSim(TRAIL_ACT, TRAIL_DIST, DO_REENTRY, FULL_START, FULL_END, cfg.filter);
  const fullMetrics = computeMetrics(full.trades, FULL_START, FULL_END);

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
    filtered: full.filtered,
    trailExits: fullMetrics.trailExits,
    oosTotal: oosMetrics.total,
    oosPerDay: oosMetrics.perDay,
    oosPf: oosMetrics.pf,
  });

  console.log(` ${full.trades.length} trades, ${full.filtered} filtered, $${fullMetrics.perDay.toFixed(2)}/day, DD $${fullMetrics.maxDD.toFixed(0)}, PF ${fullMetrics.pf.toFixed(2)}`);
}

// --------------- print results ---------------
console.log("\n" + "=".repeat(170));
console.log("REAL OI / FUNDING / LIQUIDATION / L-S RATIO BACKTEST");
console.log("Engines: A=$2 Donchian SMA20/50 | B=$3 Supertrend 14/1.75 | C=$9 GARCH v2 | D=$3 Momentum");
console.log("BTC 4h EMA(12)>EMA(21) | 40/3 trail+reentry | Max 20 pool | 18 pairs | Kelly sizing");
console.log("Coinalyze filters applied to engines A+B only (C+D unfiltered)");
console.log("Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("=".repeat(170));

const hdr = [
  "Filter".padEnd(16),
  "Trades".padStart(7),
  "WR%".padStart(7),
  "Total".padStart(12),
  "$/day".padStart(10),
  "PF".padStart(7),
  "Sharpe".padStart(8),
  "MaxDD".padStart(10),
  "Blocked".padStart(8),
  "Filtered".padStart(9),
  "OOS$/day".padStart(10),
  "OOS PF".padStart(8),
].join(" ");
console.log(`\n${hdr}`);
console.log("-".repeat(170));

for (const r of results) {
  const isBest = r.label === "1-BASELINE" ? " <<<" : "";
  console.log([
    r.label.padEnd(16),
    String(r.trades).padStart(7),
    r.wr.toFixed(1).padStart(6) + "%",
    ("$" + r.total.toFixed(2)).padStart(12),
    ("$" + r.perDay.toFixed(2)).padStart(10),
    r.pf.toFixed(2).padStart(7),
    r.sharpe.toFixed(2).padStart(8),
    ("$" + r.maxDD.toFixed(0)).padStart(10),
    String(r.blocked).padStart(8),
    String(r.filtered).padStart(9),
    ("$" + r.oosPerDay.toFixed(2)).padStart(10),
    r.oosPf.toFixed(2).padStart(8),
  ].join(" ") + isBest);
}

// Summary: compare each filter to baseline
console.log("\n" + "=".repeat(170));
console.log("COMPARISON TO BASELINE:");
const baseline = results.find(r => r.label === "1-BASELINE")!;
for (const r of results) {
  if (r.label === "1-BASELINE") continue;
  const diff = r.perDay - baseline.perDay;
  const pctDiff = baseline.perDay !== 0 ? ((diff / Math.abs(baseline.perDay)) * 100) : 0;
  const ddDiff = r.maxDD - baseline.maxDD;
  const oosDiff = r.oosPerDay - baseline.oosPerDay;
  const marker = diff > 0 ? "BETTER" : diff < 0 ? "WORSE" : "SAME";
  console.log(
    `  ${r.label.padEnd(16)} $/day: ${diff >= 0 ? "+" : ""}$${diff.toFixed(2)} (${pctDiff >= 0 ? "+" : ""}${pctDiff.toFixed(0)}%) | ` +
    `DD: ${ddDiff >= 0 ? "+" : ""}$${ddDiff.toFixed(0)} | ` +
    `OOS: ${oosDiff >= 0 ? "+" : ""}$${oosDiff.toFixed(2)}/day | ` +
    `Filtered: ${r.filtered} trades | ${marker}`
  );
}

// Per-engine breakdown for baseline
console.log("\nPer-engine breakdown (BASELINE):");
const baseRun = runSim(TRAIL_ACT, TRAIL_DIST, DO_REENTRY, FULL_START, FULL_END, null);
for (const eng of ["A", "B", "C", "D"]) {
  const et = baseRun.trades.filter(t => t.engine === eng);
  const wins = et.filter(t => t.pnl > 0);
  const losses = et.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = et.reduce((s, t) => s + t.pnl, 0);
  const pf = gl > 0 ? gp / gl : 99;
  const perDay = total / fullDays;
  console.log(`  Engine ${eng}: ${et.length} trades, $${perDay.toFixed(2)}/day, PF ${pf.toFixed(2)}, WR ${et.length > 0 ? ((wins.length / et.length) * 100).toFixed(1) : "0"}%`);
}

// Data coverage note
console.log("\nNOTE: 4h OI and Funding data starts 2025-04-28. Daily OI/Liq/LS covers full 2023-01+.");
console.log("Filters using 4h OI/funding pass through (no-op) before data availability.");

console.log("\nDone.");
