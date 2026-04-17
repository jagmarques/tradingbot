/**
 * FRESH ANGLES — 5 new signal families from research agent:
 *   1. Time-of-day edge (hour-bucket return seasonality)
 *   2. Vol regime filter (overlay on GARCH)
 *   3. NR7 volatility contraction breakout
 *   4. BTC-dispersion (correlation breakdown)
 *   5. Consecutive bar fade (5+ same-direction bars → fade)
 *
 * Walk-forward from day 1. IS: Jun-Dec 2025, OOS: Dec 2025-Mar 2026.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-fresh-angles.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const CD_H = 1;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);
const MAX_HOLD_H = 24;
const MARGIN = 10;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

const ALL_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
  "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
  "FIL", "ALGO", "BCH", "JTO", "SAND", "BLUR", "TAO", "RENDER", "TRX", "AAVE",
  "JUP", "POL", "CRV", "PYTH", "IMX", "BNB", "ONDO", "XLM", "DYDX", "ICP", "LTC", "MKR",
  "PENDLE", "PNUT", "ATOM", "TON", "SEI", "STX",
  "DYM", "CFX", "ALT", "BIO", "OMNI", "ORDI", "XAI", "SUSHI", "ME", "ZEN",
  "TNSR", "CATI", "TURBO", "MOVE", "GALA", "STRK", "SAGA", "ILV", "GMX", "OM",
  "CYBER", "NTRN", "BOME", "MEME", "ANIME", "BANANA", "ETC", "USUAL", "UMA", "USTC",
  "MAV", "REZ", "NOT", "PENGU", "BIGTIME", "WCT", "EIGEN", "MANTA", "POLYX", "W",
  "FXS", "GMT", "RSR", "PEOPLE", "YGG", "TRB", "ETHFI", "ENS", "OGN", "AXS",
  "MINA", "LISTA", "NEO", "AI", "SCR", "APE", "KAITO", "AR", "BNT", "PIXEL",
  "LAYER", "ZRO", "CELO", "ACE", "COMP", "RDNT", "ZK", "MET", "STG", "REQ",
  "CAKE", "SUPER", "FTT", "STRAX",
];

const IS_S = new Date("2025-06-01").getTime();
const IS_E = new Date("2025-12-01").getTime();
const OOS_S = new Date("2025-12-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const IS_D = (IS_E - IS_S) / D;
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  atr14_h1: number[];
  ret1h: number[];
  stdevRet1h_24h: number[]; // rolling std of 1h returns over 24 bars
  rangeMA20_h1: number[]; // MA of 1h range over 20 bars
}
interface PD { name: string; ind: PI; sp: number; lev: number; }

function load(s: string): C[] {
  const f = path.join(CACHE_5M, `${s}.json`);
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as unknown[])
    .map((b: unknown) => {
      if (Array.isArray(b)) return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      const o = b as Record<string, number>;
      return { t: +o.t, o: +o.o, h: +o.h, l: +o.l, c: +o.c };
    })
    .sort((a, b) => a.t - b.t);
}

function aggregate(bars: C[], period: number, minBars: number): C[] {
  const g = new Map<number, C[]>();
  for (const c of bars) {
    const k = Math.floor(c.t / period) * period;
    let arr = g.get(k);
    if (!arr) { arr = []; g.set(k, arr); }
    arr.push(c);
  }
  const r: C[] = [];
  for (const [t, grp] of g) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    r.push({ t, o: grp[0]!.o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1]!.c });
  }
  return r.sort((a, b) => a.t - b.t);
}

function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = 22; i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - 3]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - 20); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += r * r; c++;
    }
    if (c < 10) continue;
    const v = Math.sqrt(ss / c);
    if (v === 0) continue;
    z[i] = m / v;
  }
  return z;
}

function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const hi = cs[i]!.h, lo = cs[i]!.l, pc = cs[i - 1]!.c;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    out[i + 1] = atr;
  }
  return out;
}

function computeReturns(cs: C[]): number[] {
  const out = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) out[i] = cs[i]!.c / cs[i - 1]!.c - 1;
  return out;
}

function computeRollingStdev(arr: number[], win: number): number[] {
  const out = new Array(arr.length).fill(0);
  for (let i = win; i < arr.length; i++) {
    let sum = 0, sum2 = 0;
    for (let j = i - win + 1; j <= i; j++) { sum += arr[j]!; sum2 += arr[j]! * arr[j]!; }
    const mean = sum / win;
    out[i] = Math.sqrt(Math.max(0, sum2 / win - mean * mean));
  }
  return out;
}

function computeRollingMean(arr: number[], win: number): number[] {
  const out = new Array(arr.length).fill(0);
  for (let i = win; i < arr.length; i++) {
    let sum = 0;
    for (let j = i - win + 1; j <= i; j++) sum += arr[j]!;
    out[i] = sum / win;
  }
  return out;
}

function get4hZ(z4: number[], h4: C[], h4Map: Map<number, number>, t: number): number {
  const b = Math.floor(t / H4) * H4;
  const i = h4Map.get(b);
  if (i !== undefined && i > 0) return z4[i - 1]!;
  let lo = 0, hi = h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h4[m]!.t < t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? z4[best]! : 0;
}

type SignalFn = (p: PD, h1Idx: number, ts: number, ctx: { btcIdx?: number; btcPair?: PD; hourBuckets?: Map<string, number> }) => "long" | "short" | null;

interface Cfg {
  label: string;
  signal: SignalFn;
  slPct: number;
  trailAct: number; trailDist: number;
  maxHoldH: number;
  beAt?: number;
  tpPct?: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  beActivated: boolean;
  maxHoldH: number;
  trailAct: number; trailDist: number;
  beAt?: number;
  tpPct?: number;
}

interface SimResult { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

function simulate(pairs: PD[], cfg: Cfg, startTs: number, endTs: number, days: number, hourBuckets?: Map<string, number>): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of pairs) {
    for (const b of p.ind.m5) {
      if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
    }
  }
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PD>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // EXITS
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;

      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = pos.beActivated ? "be" : "sl"; isSL = true; }
      }

      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp && pos.beAt !== undefined && !pos.beActivated && pos.pk >= pos.beAt) {
        pos.sl = pos.ep;
        pos.beActivated = true;
      }

      // TP
      if (!xp && pos.tpPct !== undefined) {
        const tpPrice = pos.dir === "long"
          ? pos.ep * (1 + pos.tpPct / 100 / pos.lev)
          : pos.ep * (1 - pos.tpPct / 100 / pos.lev);
        const tpHit = pos.dir === "long" ? bar.h >= tpPrice : bar.l <= tpPrice;
        if (tpHit) { xp = tpPrice; reason = "tp"; }
      }

      if (!xp && pos.trailAct < 999) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= pos.trailAct && cur <= pos.pk - pos.trailDist) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (!isH1Boundary) continue;
    if (BLOCK.has(hourOfDay)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 30) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const dir = cfg.signal(p, h1Idx, ts, { hourBuckets });
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: MARGIN * p.lev,
        beActivated: false,
        maxHoldH: cfg.maxHoldH,
        trailAct: cfg.trailAct, trailDist: cfg.trailDist,
        beAt: cfg.beAt,
        tpPct: cfg.tpPct,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end" });
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / days,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
  };
}

// ─── SIGNAL DEFINITIONS ───

// 1. Time-of-day (IS-fitted bucket, uses hourBuckets map: "pair:hour" -> +1/-1)
function signalToD(): SignalFn {
  return (p, h1Idx, ts, ctx) => {
    if (!ctx.hourBuckets) return null;
    const hour = new Date(ts).getUTCHours();
    const key = `${p.name}:${hour}`;
    const dir = ctx.hourBuckets.get(key);
    if (dir === 1) return "long";
    if (dir === -1) return "short";
    return null;
  };
}

// 2. GARCH with vol regime filter (only trade in high vol regime)
function signalGarchHighVol(regime: "high" | "low" | "any"): SignalFn {
  return (p, h1Idx, ts) => {
    const z1 = p.ind.z1[h1Idx - 1]!;
    const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
    if (!(z1 > 4 && z4 > 2) && !(z1 < -6 && z4 < -2)) return null;
    // Vol regime: stdev of 1h returns over 24h vs stdev over 168h
    const shortVol = p.ind.stdevRet1h_24h[h1Idx - 1] ?? 0;
    if (shortVol === 0) return null;
    // Need longer baseline for comparison
    const rangeAvg = p.ind.rangeMA20_h1[h1Idx - 1] ?? 0;
    const curRange = p.ind.h1[h1Idx - 1]!.h - p.ind.h1[h1Idx - 1]!.l;
    if (rangeAvg === 0) return null;
    const volRatio = curRange / rangeAvg;
    if (regime === "high" && volRatio < 1.5) return null;
    if (regime === "low" && volRatio > 0.7) return null;
    if (z1 > 4 && z4 > 2) return "long";
    if (z1 < -6 && z4 < -2) return "short";
    return null;
  };
}

// 3. NR7 breakout (narrow range of 7 bars, breakout on next)
function signalNR7(): SignalFn {
  return (p, h1Idx) => {
    if (h1Idx < 9) return null;
    const curBar = p.ind.h1[h1Idx - 1]!; // last completed bar
    const curRange = curBar.h - curBar.l;
    // Check that bar n-1 was NR7 and we broke out
    const nr7Bar = p.ind.h1[h1Idx - 2]!;
    const nr7Range = nr7Bar.h - nr7Bar.l;
    let isNR7 = true;
    for (let i = h1Idx - 8; i < h1Idx - 2; i++) {
      const b = p.ind.h1[i]!;
      if (b.h - b.l <= nr7Range) { isNR7 = false; break; }
    }
    if (!isNR7) return null;
    // Breakout: current bar closed beyond NR7 range
    if (curBar.c > nr7Bar.h) return "long";
    if (curBar.c < nr7Bar.l) return "short";
    return null;
  };
}

// 4. Consecutive bar fade (5+ same-direction 1h bars → fade next)
function signalConsecFade(n: number): SignalFn {
  return (p, h1Idx) => {
    if (h1Idx < n + 2) return null;
    const bars = [];
    for (let i = h1Idx - n; i < h1Idx; i++) bars.push(p.ind.h1[i]!);
    const allUp = bars.every((b, i) => i === 0 || b.c > bars[i - 1]!.c);
    const allDown = bars.every((b, i) => i === 0 || b.c < bars[i - 1]!.c);
    if (!allUp && !allDown) return null;
    // Require magnitude: cumulative move > 1.5 × ATR
    const atr = p.ind.atr14_h1[h1Idx - 1] ?? 0;
    if (atr === 0) return null;
    const cumMove = Math.abs(bars[bars.length - 1]!.c - bars[0]!.c);
    if (cumMove < 1.5 * atr) return null;
    if (allUp) return "short"; // fade the up streak
    if (allDown) return "long"; // fade the down streak
    return null;
  };
}

// Pre-fit hour buckets from in-sample data
function fitHourBuckets(pairs: PD[], startTs: number, endTs: number): Map<string, number> {
  // For each (pair, hour), compute mean 1h return and stderr
  const stats = new Map<string, { sum: number; sum2: number; n: number }>();
  for (const p of pairs) {
    for (let i = 1; i < p.ind.h1.length; i++) {
      const bar = p.ind.h1[i]!;
      if (bar.t < startTs || bar.t >= endTs) continue;
      const hour = new Date(bar.t).getUTCHours();
      const ret = p.ind.ret1h[i]!;
      const key = `${p.name}:${hour}`;
      let s = stats.get(key);
      if (!s) { s = { sum: 0, sum2: 0, n: 0 }; stats.set(key, s); }
      s.sum += ret; s.sum2 += ret * ret; s.n++;
    }
  }
  const buckets = new Map<string, number>();
  for (const [key, s] of stats) {
    if (s.n < 10) continue;
    const mean = s.sum / s.n;
    const stdev = Math.sqrt(Math.max(0, s.sum2 / s.n - mean * mean));
    const stderr = stdev / Math.sqrt(s.n);
    if (stderr === 0) continue;
    const tStat = mean / stderr;
    // Require strong evidence (t > 3 approx, conservative for multiple testing)
    if (tStat > 3) buckets.set(key, 1);
    if (tStat < -3) buckets.set(key, -1);
  }
  return buckets;
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(140));
  console.log("  FRESH ANGLES — time-of-day, vol regime, NR7, consec fade");
  console.log(`  IS: Jun-Dec 2025 (${IS_D.toFixed(0)}d), OOS: Dec-Mar 2026 (${OOS_D.toFixed(0)}d)`);
  console.log("=".repeat(140));

  console.log("\nLoading...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const atr14_h1 = computeATR(h1, 14);
    const ret1h = computeReturns(h1);
    const stdevRet1h_24h = computeRollingStdev(ret1h, 24);
    const rangeArr = h1.map(b => b.h - b.l);
    const rangeMA20_h1 = computeRollingMean(rangeArr, 20);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, atr14_h1, ret1h, stdevRet1h_24h, rangeMA20_h1 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  console.log(`${pairs.length} pairs loaded`);

  // Fit time-of-day buckets on IS
  const isBuckets = fitHourBuckets(pairs, IS_S, IS_E);
  console.log(`\nIS hour buckets passed t>3: ${isBuckets.size}`);
  for (const [k, v] of [...isBuckets].slice(0, 15)) {
    console.log(`  ${k} ${v > 0 ? "LONG" : "SHORT"}`);
  }

  // Define signals
  const configs: Cfg[] = [
    {
      label: "ToD (IS-fit buckets, exit 1h)",
      signal: signalToD(),
      slPct: 0.003, trailAct: 999, trailDist: 999, maxHoldH: 1,
    },
    {
      label: "ToD (buckets, SL 0.08%, trail 9/0.5)",
      signal: signalToD(),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 4, beAt: 7,
    },
    {
      label: "GARCH + high-vol regime",
      signal: signalGarchHighVol("high"),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 72, beAt: 7,
    },
    {
      label: "GARCH + low-vol regime",
      signal: signalGarchHighVol("low"),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 72, beAt: 7,
    },
    {
      label: "GARCH any regime (baseline)",
      signal: signalGarchHighVol("any"),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 72, beAt: 7,
    },
    {
      label: "NR7 breakout",
      signal: signalNR7(),
      slPct: 0.003, trailAct: 9, trailDist: 0.5, maxHoldH: 6, beAt: 5,
    },
    {
      label: "NR7 with tight SL",
      signal: signalNR7(),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 6, beAt: 5,
    },
    {
      label: "Consec fade (5 bars)",
      signal: signalConsecFade(5),
      slPct: 0.003, trailAct: 9, trailDist: 0.5, maxHoldH: 4,
    },
    {
      label: "Consec fade (5 bars) tight SL",
      signal: signalConsecFade(5),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 4,
    },
    {
      label: "Consec fade (6 bars) tight SL",
      signal: signalConsecFade(6),
      slPct: 0.0008, trailAct: 9, trailDist: 0.5, maxHoldH: 4,
    },
  ];

  console.log(`\n${"Config".padEnd(40)} ${"Period".padEnd(6)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`);
  console.log("-".repeat(140));

  for (const cfg of configs) {
    const isRes = simulate(pairs, cfg, IS_S, IS_E, IS_D, isBuckets);
    const oosRes = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D, isBuckets);
    console.log(`${cfg.label.padEnd(40).slice(0, 40)} ${"IS".padEnd(6)} ${fmtD(isRes.dollarsPerDay).padStart(9)} ${("$" + isRes.maxDD.toFixed(0)).padStart(7)} ${isRes.pf.toFixed(2).padStart(5)} ${isRes.wr.toFixed(1).padStart(6)} ${fmtD(isRes.maxSingleLoss).padStart(8)} ${String(isRes.numTrades).padStart(6)}`);
    console.log(`${"".padEnd(40)} ${"OOS".padEnd(6)} ${fmtD(oosRes.dollarsPerDay).padStart(9)} ${("$" + oosRes.maxDD.toFixed(0)).padStart(7)} ${oosRes.pf.toFixed(2).padStart(5)} ${oosRes.wr.toFixed(1).padStart(6)} ${fmtD(oosRes.maxSingleLoss).padStart(8)} ${String(oosRes.numTrades).padStart(6)}`);
  }

  // Results summary
  console.log("\n" + "=".repeat(140));
  console.log("OOS PROFITABLE (honest forward view)");
  console.log("=".repeat(140));
}

main();
