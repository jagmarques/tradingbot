/**
 * REGIME STRICTNESS BACKTESTER — GARCH long-only loose
 *
 * Tests tighter volatility regime filters on the deployed GARCH long-only engine.
 * Deployed config:
 *   z1h>2, z4h>1.5 LONG ONLY, SL 0.15%, multi-stage trail 3/1 -> 9/0.5 -> 20/0.5
 *   Margin $15, vol regime RV24h/RV168h > 1.5
 *   Block hours 22-23 UTC, max hold 72h
 *
 * Tests:
 *   1) Regime thresholds: 1.0 (off), 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.5, 3.0
 *   2) Four regime definitions:
 *       A) RV24h / RV168h (short vs weekly, deployed fast version)
 *       B) RV24h / rolling_median_30d (current spec)
 *       C) ATR14_1h / ATR14_1h_30d_median
 *       D) sum_range_24h / rolling_mean_30d_range
 *   3) Margin scaling on best strict config: $15 / $20 / $25 / $30
 *
 * Walk-forward: IS 2025-06-01 to 2025-12-01, OOS 2025-12-01 to 2026-03-25
 *
 * Output: .company/backtester/regime-strict.txt
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const SL_SLIP_MULT = 1.5;
const BLOCK = new Set([22, 23]);
const MAX_HOLD_H = 72;

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

// Multi-stage trail: [activation%, distance%]
const TRAIL_STAGES: Array<[number, number]> = [
  [3, 1],
  [9, 0.5],
  [20, 0.5],
];

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[];
  rv168: number[];
  rvMed30: number[];      // rolling median RV24h over 30d (720 hourly bars)
  atr14: number[];
  atrMed30: number[];     // rolling median ATR14 over 30d
  range24: number[];      // sum of 1h ranges over 24h
  range24Mean30: number[]; // rolling mean of range24 over 30d
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

function computeRVFast(cs: C[], window: number): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < window + 2) return out;
  const r2: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const r = cs[i]!.c / cs[i - 1]!.c - 1;
    r2[i] = r * r;
  }
  let sum = 0;
  for (let i = 1; i <= window; i++) sum += r2[i]!;
  out[window] = Math.sqrt(sum / window);
  for (let i = window + 1; i < cs.length; i++) {
    sum += r2[i]! - r2[i - window]!;
    out[i] = Math.sqrt(sum / window);
  }
  return out;
}

function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 2) return out;
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i]!.h, l = cs[i]!.l, pc = cs[i - 1]!.c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let atr = sum / period;
  out[period] = atr;
  for (let i = period + 1; i < cs.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

// Rolling median over prior `window` values (exclusive of current).
// Uses sort on each window — O(N*W log W). For W=720 this is slow per pair.
// We sample every 6 hours and carry-forward to speed it up.
function computeRollingMedian(values: number[], window: number, stride = 6): number[] {
  const out = new Array(values.length).fill(0);
  if (values.length < window + 10) return out;
  let last = 0;
  for (let i = window; i < values.length; i++) {
    if ((i - window) % stride === 0) {
      const slice: number[] = [];
      for (let j = i - window; j < i; j++) {
        const v = values[j]!;
        if (v > 0) slice.push(v);
      }
      if (slice.length < window / 4) { out[i] = last; continue; }
      slice.sort((a, b) => a - b);
      last = slice[Math.floor(slice.length / 2)]!;
    }
    out[i] = last;
  }
  return out;
}

// Rolling mean (exclusive of current)
function computeRollingMean(values: number[], window: number): number[] {
  const out = new Array(values.length).fill(0);
  if (values.length < window + 2) return out;
  let sum = 0;
  for (let i = 0; i < window; i++) sum += values[i]!;
  out[window] = sum / window;
  for (let i = window + 1; i < values.length; i++) {
    sum += values[i - 1]! - values[i - 1 - window]!;
    out[i] = sum / window;
  }
  return out;
}

// Sum of 1h ranges (h-l) over prior 24 bars
function computeRange24(cs: C[]): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < 26) return out;
  let sum = 0;
  for (let i = 1; i <= 24; i++) sum += cs[i]!.h - cs[i]!.l;
  out[24] = sum;
  for (let i = 25; i < cs.length; i++) {
    sum += (cs[i]!.h - cs[i]!.l) - (cs[i - 24]!.h - cs[i - 24]!.l);
    out[i] = sum;
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

type RegimeDef = "A" | "B" | "C" | "D" | "OFF";

interface Cfg {
  margin: number;
  slPct: number;
  zL1: number; zL4: number;
  regimeDef: RegimeDef;
  regimeThr: number;
}

interface OpenPos {
  pair: string;
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface Tr { pair: string; pnl: number; reason: string; exitTs: number; }

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  maxSingleLoss: number; numTrades: number;
}

function regimePasses(p: PD, h1Idx: number, def: RegimeDef, thr: number): boolean {
  if (def === "OFF") return true;
  const i = h1Idx - 1;
  if (def === "A") {
    const a = p.ind.rv24[i] ?? 0, b = p.ind.rv168[i] ?? 0;
    if (a === 0 || b === 0) return false;
    return a / b >= thr;
  }
  if (def === "B") {
    const a = p.ind.rv24[i] ?? 0, b = p.ind.rvMed30[i] ?? 0;
    if (a === 0 || b === 0) return false;
    return a / b >= thr;
  }
  if (def === "C") {
    const a = p.ind.atr14[i] ?? 0, b = p.ind.atrMed30[i] ?? 0;
    if (a === 0 || b === 0) return false;
    return a / b >= thr;
  }
  if (def === "D") {
    const a = p.ind.range24[i] ?? 0, b = p.ind.range24Mean30[i] ?? 0;
    if (a === 0 || b === 0) return false;
    return a / b >= thr;
  }
  return true;
}

// Cached per (startTs,endTs): timepoints array + m5 maps + pair-by-name map
interface SimCache {
  timepoints: number[];
  m5Maps: Map<string, Map<number, number>>;
  pairByName: Map<string, PD>;
}
const simCaches = new Map<string, SimCache>();
function getSimCache(pairs: PD[], startTs: number, endTs: number): SimCache {
  const key = `${startTs}-${endTs}-${pairs.length}`;
  let c = simCaches.get(key);
  if (c) return c;
  const all5mTimes = new Set<number>();
  for (const p of pairs) for (const b of p.ind.m5) if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
  const timepoints = [...all5mTimes].sort((a, b) => a - b);
  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PD>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((cc, i) => m.set(cc.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }
  c = { timepoints, m5Maps, pairByName };
  simCaches.set(key, c);
  return c;
}

function simulate(pairs: PD[], cfg: Cfg, startTs: number, endTs: number, days: number): Res {
  const closed: Tr[] = [];
  const openPositions: OpenPos[] = [];
  const { timepoints, m5Maps, pairByName } = getSimCache(pairs, startTs, endTs);

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair); if (!m5Map) continue;
      const bi = m5Map.get(ts); if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = bar.l <= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      // update peak (long only)
      const best = (bar.h / pos.ep - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = (bar.c / pos.ep - 1) * pos.lev * 100;
        // find active trail stage (highest activation <= peak)
        let actDist = -1;
        for (const [act, dist] of TRAIL_STAGES) {
          if (pos.pk >= act) actDist = dist;
        }
        if (actDist > 0 && cur <= pos.pk - actDist) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP_MULT : pos.sp;
        const ex = xp * (1 - rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (ex / pos.ep - 1) * pos.not - fees;
        closed.push({ pair: pos.pair, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      // LONG ONLY
      if (!(z1 > cfg.zL1 && z4 > cfg.zL4)) continue;

      if (!regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) continue;

      const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
      const slDist = ep * cfg.slPct;
      const sl = ep - slDist;

      openPositions.push({
        pair: p.name, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: cfg.margin * p.lev,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = lb.c * (1 - pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (ex / pos.ep - 1) * pos.not - fees;
    closed.push({ pair: pos.pair, exitTs: lb.t, pnl, reason: "end" });
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
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const LINES: string[] = [];
function log(s = ""): void { console.log(s); LINES.push(s); }

function main() {
  log("=".repeat(140));
  log("  REGIME STRICTNESS — GARCH long-only loose");
  log("  Entry: z1h>2.0, z4h>1.5 LONG ONLY | SL 0.15% | multi-stage trail 3/1 -> 9/0.5 -> 20/0.5");
  log("  Max hold 72h, block 22-23 UTC, SL-slip 1.5x, fee 0.035%/side");
  log("  Baseline OOS (deployed, regime A thr=1.5, margin $15): +$1.17/day, MDD $17, PF 1.89");
  log("=".repeat(140));

  log("\nLoading pairs...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 900 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const rvMed30 = computeRollingMedian(rv24, 720, 6);
    const atr14 = computeATR(h1, 14);
    const atrMed30 = computeRollingMedian(atr14, 720, 6);
    const range24 = computeRange24(h1);
    const range24Mean30 = computeRollingMean(range24, 720);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168, rvMed30, atr14, atrMed30, range24, range24Mean30 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  const baseCfg: Cfg = {
    margin: 15, slPct: 0.0015,
    zL1: 2.0, zL4: 1.5,
    regimeDef: "A", regimeThr: 1.5,
  };

  const thresholds = [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.5, 3.0];
  const defs: Array<[RegimeDef, string]> = [
    ["A", "RV24/RV168  "],
    ["B", "RV24/RVmed30"],
    ["C", "ATR14/ATRmed"],
    ["D", "Rng24/Rngmn30"],
  ];

  interface Rec {
    def: RegimeDef; defLabel: string; thr: number;
    isR: Res; oosR: Res;
  }
  const allRecs: Rec[] = [];

  log("\n" + "=".repeat(140));
  log("PART 1 — REGIME DEFINITION x THRESHOLD SWEEP (margin $15, SL 0.15%)");
  log("=".repeat(140));

  for (const [def, defLabel] of defs) {
    log(`\n--- Regime def ${def}: ${defLabel.trim()} ---`);
    log(`${"thr".padStart(5)} ${"per".padStart(4)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"MaxL".padStart(9)} ${"N".padStart(5)}`);
    log("-".repeat(70));
    for (const thr of thresholds) {
      // thr=1.0 means "off" for ratio-based regimes (equivalent to very loose)
      const cfg: Cfg = { ...baseCfg, regimeDef: def, regimeThr: thr };
      const isR = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oosR = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      allRecs.push({ def, defLabel, thr, isR, oosR });
      log(`${thr.toFixed(2).padStart(5)} ${"IS".padStart(4)} ${fmtD(isR.dollarsPerDay).padStart(9)} ${("$" + isR.maxDD.toFixed(0)).padStart(8)} ${isR.pf.toFixed(2).padStart(6)} ${isR.wr.toFixed(1).padStart(6)} ${fmtD(isR.maxSingleLoss).padStart(9)} ${String(isR.numTrades).padStart(5)}`);
      log(`${"".padStart(5)} ${"OOS".padStart(4)} ${fmtD(oosR.dollarsPerDay).padStart(9)} ${("$" + oosR.maxDD.toFixed(0)).padStart(8)} ${oosR.pf.toFixed(2).padStart(6)} ${oosR.wr.toFixed(1).padStart(6)} ${fmtD(oosR.maxSingleLoss).padStart(9)} ${String(oosR.numTrades).padStart(5)}`);
    }
  }

  // Also test "OFF" once for reference
  log("\n--- Regime OFF (no filter) reference ---");
  const cfgOff: Cfg = { ...baseCfg, regimeDef: "OFF", regimeThr: 0 };
  const isOff = simulate(pairs, cfgOff, IS_S, IS_E, IS_D);
  const oosOff = simulate(pairs, cfgOff, OOS_S, OOS_E, OOS_D);
  log(`${" OFF".padStart(5)} ${"IS".padStart(4)} ${fmtD(isOff.dollarsPerDay).padStart(9)} ${("$" + isOff.maxDD.toFixed(0)).padStart(8)} ${isOff.pf.toFixed(2).padStart(6)} ${isOff.wr.toFixed(1).padStart(6)} ${fmtD(isOff.maxSingleLoss).padStart(9)} ${String(isOff.numTrades).padStart(5)}`);
  log(`${"".padStart(5)} ${"OOS".padStart(4)} ${fmtD(oosOff.dollarsPerDay).padStart(9)} ${("$" + oosOff.maxDD.toFixed(0)).padStart(8)} ${oosOff.pf.toFixed(2).padStart(6)} ${oosOff.wr.toFixed(1).padStart(6)} ${fmtD(oosOff.maxSingleLoss).padStart(9)} ${String(oosOff.numTrades).padStart(5)}`);

  // PART 2 — best strict configs and margin scaling
  log("\n" + "=".repeat(140));
  log("PART 2 — RANKING: configs beating baseline ($1.17/day, MDD $17) on OOS");
  log("=".repeat(140));

  const beatBaseline = allRecs.filter(r =>
    r.oosR.dollarsPerDay > 1.17 && r.oosR.maxDD < 17 && r.oosR.numTrades >= 20
  );
  beatBaseline.sort((a, b) => b.oosR.pf - a.oosR.pf);
  log(`Found ${beatBaseline.length} configs beating baseline on BOTH $/day AND MDD (OOS)`);
  log(`${"def".padStart(4)} ${"thr".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)}`);
  log("-".repeat(50));
  for (const r of beatBaseline.slice(0, 15)) {
    log(`${r.def.padStart(4)} ${r.thr.toFixed(2).padStart(5)} ${fmtD(r.oosR.dollarsPerDay).padStart(9)} ${("$" + r.oosR.maxDD.toFixed(0)).padStart(8)} ${r.oosR.pf.toFixed(2).padStart(6)} ${r.oosR.wr.toFixed(1).padStart(6)} ${String(r.oosR.numTrades).padStart(5)}`);
  }

  // Rank all by OOS PF (robust ones only)
  log("\n--- TOP 10 BY OOS PF (numTrades >= 30, MDD < $25) ---");
  const robust = allRecs.filter(r => r.oosR.numTrades >= 30 && r.oosR.maxDD < 25 && r.oosR.dollarsPerDay > 0);
  robust.sort((a, b) => b.oosR.pf - a.oosR.pf);
  log(`${"def".padStart(4)} ${"thr".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)}`);
  for (const r of robust.slice(0, 10)) {
    log(`${r.def.padStart(4)} ${r.thr.toFixed(2).padStart(5)} ${fmtD(r.oosR.dollarsPerDay).padStart(9)} ${("$" + r.oosR.maxDD.toFixed(0)).padStart(8)} ${r.oosR.pf.toFixed(2).padStart(6)} ${r.oosR.wr.toFixed(1).padStart(6)} ${String(r.oosR.numTrades).padStart(5)}`);
  }

  // PART 3 — margin scaling on best strict configs
  log("\n" + "=".repeat(140));
  log("PART 3 — MARGIN SCALING on top strict configs (can higher margin stay within MDD<$20?)");
  log("=".repeat(140));

  // pick: best by OOS PF where thr >= 1.8 (strict), numTrades >= 30
  const strictCandidates = allRecs.filter(r => r.thr >= 1.8 && r.oosR.numTrades >= 30 && r.oosR.dollarsPerDay > 0);
  strictCandidates.sort((a, b) => b.oosR.pf - a.oosR.pf);
  const topStrict = strictCandidates.slice(0, 4);

  const margins = [15, 20, 25, 30, 40];
  log(`${"def".padStart(4)} ${"thr".padStart(5)} ${"marg".padStart(5)} ${"per".padStart(4)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"MaxL".padStart(9)} ${"N".padStart(5)}`);
  log("-".repeat(80));
  for (const tc of topStrict) {
    for (const m of margins) {
      const cfg: Cfg = { ...baseCfg, regimeDef: tc.def, regimeThr: tc.thr, margin: m };
      const isR = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oosR = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      log(`${tc.def.padStart(4)} ${tc.thr.toFixed(2).padStart(5)} ${("$" + m).padStart(5)} ${"IS".padStart(4)} ${fmtD(isR.dollarsPerDay).padStart(9)} ${("$" + isR.maxDD.toFixed(0)).padStart(8)} ${isR.pf.toFixed(2).padStart(6)} ${isR.wr.toFixed(1).padStart(6)} ${fmtD(isR.maxSingleLoss).padStart(9)} ${String(isR.numTrades).padStart(5)}`);
      log(`${"".padStart(4)} ${"".padStart(5)} ${"".padStart(5)} ${"OOS".padStart(4)} ${fmtD(oosR.dollarsPerDay).padStart(9)} ${("$" + oosR.maxDD.toFixed(0)).padStart(8)} ${oosR.pf.toFixed(2).padStart(6)} ${oosR.wr.toFixed(1).padStart(6)} ${fmtD(oosR.maxSingleLoss).padStart(9)} ${String(oosR.numTrades).padStart(5)}`);
    }
    log("-".repeat(80));
  }

  // PART 4 — deploy-ready winner: build by SCALING margin on existing Part 1 results (PnL and MDD scale linearly)
  log("\n" + "=".repeat(140));
  log("PART 4 — DEPLOY-READY WINNERS (OOS MDD<$20 AND OOS PF>1.89 AND OOS $/day>baseline)");
  log("=".repeat(140));

  // PnL scales linearly with margin (same lev, same notional ratio) — so we can project from $15 base
  // Fees also scale linearly with notional, so pnl AFTER fees scales linearly too. MDD also scales linearly.
  interface Dr { def: RegimeDef; thr: number; margin: number; isR: Res; oosR: Res; }
  const deployable: Dr[] = [];
  for (const r of allRecs) {
    for (const m of [15, 20, 25, 30]) {
      const scale = m / 15;
      const isR: Res = {
        ...r.isR,
        totalPnl: r.isR.totalPnl * scale,
        dollarsPerDay: r.isR.dollarsPerDay * scale,
        maxDD: r.isR.maxDD * scale,
        maxSingleLoss: r.isR.maxSingleLoss * scale,
      };
      const oosR: Res = {
        ...r.oosR,
        totalPnl: r.oosR.totalPnl * scale,
        dollarsPerDay: r.oosR.dollarsPerDay * scale,
        maxDD: r.oosR.maxDD * scale,
        maxSingleLoss: r.oosR.maxSingleLoss * scale,
      };
      if (oosR.maxDD < 20 && oosR.pf > 1.89 && oosR.dollarsPerDay > 1.17 && oosR.numTrades >= 20) {
        deployable.push({ def: r.def, thr: r.thr, margin: m, isR, oosR });
      }
    }
  }
  deployable.sort((a, b) => b.oosR.dollarsPerDay - a.oosR.dollarsPerDay);
  log(`Found ${deployable.length} deploy-ready configs`);
  log(`${"def".padStart(4)} ${"thr".padStart(5)} ${"marg".padStart(5)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)} ${"IS$/d".padStart(9)} ${"ISMDD".padStart(7)}`);
  log("-".repeat(90));
  for (const d of deployable.slice(0, 20)) {
    log(`${d.def.padStart(4)} ${d.thr.toFixed(2).padStart(5)} ${("$" + d.margin).padStart(5)} ${fmtD(d.oosR.dollarsPerDay).padStart(9)} ${("$" + d.oosR.maxDD.toFixed(0)).padStart(8)} ${d.oosR.pf.toFixed(2).padStart(6)} ${d.oosR.wr.toFixed(1).padStart(6)} ${String(d.oosR.numTrades).padStart(5)} ${fmtD(d.isR.dollarsPerDay).padStart(9)} ${("$" + d.isR.maxDD.toFixed(0)).padStart(7)}`);
  }

  log("\n" + "=".repeat(140));
  log("DONE");
  log("=".repeat(140));

  const outPath = ".company/backtester/regime-strict.txt";
  fs.writeFileSync(outPath, LINES.join("\n"));
  console.log(`\nSaved to ${outPath}`);
}

main();
