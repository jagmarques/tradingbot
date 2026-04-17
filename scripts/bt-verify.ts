/**
 * RIGOROUS VERIFICATION of 3 deployment candidate findings.
 *
 * FINDING 1: ATR regime beats RV regime
 *   Claim: GARCH long-only with ATR14_1h / ATR14_30d_median > 1.6 at m$15
 *          gives +$1.58/day, MDD $5-6 vs deployed RV regime +$1.17/day MDD $17.
 *          Linear claim: m$30 gives ~2x m$15.
 *
 * FINDING 2: Compounding scales $60 -> $3000+
 *   Claim: 20%+20% with cap $80/engine grows 50x over IS+OOS, MDD% < 33%.
 *
 * FINDING 3: Multi-stage trail hurts REX
 *   Claim: REX standalone multi-stage 3/1 -> 9/0.5 -> 20/0.5 = +$1.10/day MDD $13
 *          vs single-stage 9/0.5 = +$1.24/day MDD $12.
 *
 * All tests: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03-25.
 * Pairs loaded from /tmp/bt-pair-cache-5m. FEE 0.00035, SL_SLIP 1.5 baseline.
 * Stress: repeat at SL_SLIP 2.5.
 *
 * Output: .company/backtester/verify.txt
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const BLOCK = new Set([22, 23]);

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
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[]; rv168: number[];
  atr14: number[]; atrMed30: number[];
  rexSig20: Int8Array;
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

// Strided rolling median (sample every stride bars, carry-forward)
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

function computeRangeExpansion(h1: C[], atr1: number[], mult: number): Int8Array {
  const out = new Int8Array(h1.length);
  for (let i = 14; i < h1.length; i++) {
    const bar = h1[i]!;
    const a = atr1[i];
    if (!a || a <= 0) continue;
    const range = bar.h - bar.l;
    if (range < mult * a) continue;
    if (range <= 0) continue;
    const upper75 = bar.l + range * 0.75;
    const lower25 = bar.l + range * 0.25;
    if (bar.c >= upper75) out[i] = 1;
    else if (bar.c <= lower25) out[i] = -1;
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

// ============================================================================
// UNIFIED SIMULATOR
// ============================================================================

type Engine = "garch" | "rex";
type RegimeDef = "RV" | "ATR" | "OFF";
type TrailMode = "multi" | "single";

interface Cfg {
  label: string;
  // engines enabled
  runGarch: boolean;
  runRex: boolean;
  marginGarch: number;
  marginRex: number;
  // shared
  slPct: number;
  slSlipMult: number;
  // trail
  trailMode: TrailMode;
  trailSingleAct: number;   // for single
  trailSingleDist: number;
  trailStages: Array<[number, number]>;   // for multi
  // garch entry
  zL1: number; zL4: number;
  garchMaxHoldH: number;
  // rex entry
  rexMult: number;
  rexMaxHoldH: number;
  // regime filter
  regimeDef: RegimeDef;
  regimeThr: number;
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  margin: number;
  maxHoldH: number;
}

interface Tr { engine: Engine; pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  maxSingleLoss: number; numTrades: number;
  byEngine: Record<Engine, { pnl: number; n: number; wins: number; losses: number; maxLoss: number; }>;
  trades: Tr[];
}

function regimePasses(p: PD, h1Idx: number, def: RegimeDef, thr: number): boolean {
  if (def === "OFF") return true;
  const i = h1Idx - 1;
  if (def === "RV") {
    const a = p.ind.rv24[i] ?? 0, b = p.ind.rv168[i] ?? 0;
    if (a === 0 || b === 0) return false;
    return a / b >= thr;
  }
  if (def === "ATR") {
    const a = p.ind.atr14[i] ?? 0, b = p.ind.atrMed30[i] ?? 0;
    if (a === 0 || b === 0) return false;
    return a / b >= thr;
  }
  return true;
}

// Cached per (startTs,endTs)
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

  const notG = (lev: number) => cfg.marginGarch * lev;
  const notR = (lev: number) => cfg.marginRex * lev;

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    // Exits
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair); if (!m5Map) continue;
      const bi = m5Map.get(ts); if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      // update peak
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (cfg.trailMode === "multi") {
          let actDist = -1;
          for (const [act, dist] of cfg.trailStages) {
            if (pos.pk >= act) actDist = dist;
          }
          if (actDist > 0 && cur <= pos.pk - actDist) { xp = bar.c; reason = "trail"; }
        } else {
          if (pos.pk >= cfg.trailSingleAct && cur <= pos.pk - cfg.trailSingleDist) {
            xp = bar.c; reason = "trail";
          }
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // GARCH long-only
      if (cfg.runGarch && !openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) {
          if (regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) {
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            openPositions.push({
              engine: "garch", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notG(p.lev), margin: cfg.marginGarch,
              maxHoldH: cfg.garchMaxHoldH,
            });
          }
        }
      }

      // REX
      if (cfg.runRex && !openPositions.some(o => o.pair === p.name && o.engine === "rex")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          if (regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "rex", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notR(p.lev), margin: cfg.marginRex,
              maxHoldH: cfg.rexMaxHoldH,
            });
          }
        }
      }
    }
  }

  // Close any still-open
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end" });
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

  const byEngine: Record<Engine, { pnl: number; n: number; wins: number; losses: number; maxLoss: number; }> = {
    garch: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
    rex: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
  };
  for (const t of closed) {
    const e = byEngine[t.engine];
    e.pnl += t.pnl; e.n += 1;
    if (t.pnl > 0) e.wins += 1; else { e.losses += 1; if (t.pnl < e.maxLoss) e.maxLoss = t.pnl; }
  }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
    trades: closed,
  };
}

// ============================================================================
// COMPOUNDING SIMULATOR (separate because equity changes trade-by-trade)
// ============================================================================

interface CompCfg {
  label: string;
  startEquity: number;
  minMargin: number;
  maxMargin: number;
  pctGarch: number;
  pctRex: number;
  slPct: number;
  slSlipMult: number;
  trailStages: Array<[number, number]>;
  zL1: number; zL4: number;
  regimeDef: RegimeDef;
  regimeThr: number;
  garchMaxHoldH: number;
  rexMaxHoldH: number;
}

interface CompState {
  equity: number;
  peakEquity: number;
  minEquity: number;
  maxDDDollar: number;
  maxDDPctRunning: number;
  engPnl: Record<Engine, number>;
  engTrades: Record<Engine, number>;
  sumMarginG: number; nMarginG: number;
  sumMarginR: number; nMarginR: number;
  timesAtCapG: number; timesAtCapR: number;
  totalEntries: number;
  totalPnl: number;
  equityHistory: number[];   // per trade
  marginHistory: Array<{ ts: number; mG: number; mR: number; atCapG: boolean; atCapR: boolean; eq: number; }>;
}

function newCompState(start: number): CompState {
  return {
    equity: start, peakEquity: start, minEquity: start,
    maxDDDollar: 0, maxDDPctRunning: 0,
    engPnl: { garch: 0, rex: 0 },
    engTrades: { garch: 0, rex: 0 },
    sumMarginG: 0, nMarginG: 0,
    sumMarginR: 0, nMarginR: 0,
    timesAtCapG: 0, timesAtCapR: 0,
    totalEntries: 0, totalPnl: 0,
    equityHistory: [],
    marginHistory: [],
  };
}

function clampMargin(raw: number, minM: number, maxM: number): { m: number; capped: boolean; } {
  if (raw < minM) return { m: minM, capped: false };
  if (raw > maxM) return { m: maxM, capped: true };
  return { m: raw, capped: false };
}

function runCompound(
  pairs: PD[],
  cfg: CompCfg,
  state: CompState,
  startTs: number,
  endTs: number,
): void {
  const openPositions: OpenPos[] = [];
  const { timepoints, m5Maps, pairByName } = getSimCache(pairs, startTs, endTs);

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    // Exits
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair); if (!m5Map) continue;
      const bi = m5Map.get(ts); if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        let actDist = -1;
        for (const [act, dist] of cfg.trailStages) {
          if (pos.pk >= act) actDist = dist;
        }
        if (actDist > 0 && cur <= pos.pk - actDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        void reason;
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;

        state.equity += pnl;
        state.totalPnl += pnl;
        state.engPnl[pos.engine] += pnl;
        state.engTrades[pos.engine] += 1;
        if (state.equity > state.peakEquity) state.peakEquity = state.equity;
        if (state.equity < state.minEquity) state.minEquity = state.equity;
        const ddAbs = state.peakEquity - state.equity;
        if (ddAbs > state.maxDDDollar) state.maxDDDollar = ddAbs;
        const ddPct = state.peakEquity > 0 ? (ddAbs / state.peakEquity) * 100 : 0;
        if (ddPct > state.maxDDPctRunning) state.maxDDPctRunning = ddPct;
        state.equityHistory.push(state.equity);
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    const rawG = state.equity * cfg.pctGarch;
    const rawR = state.equity * cfg.pctRex;
    const { m: mG, capped: capG } = clampMargin(rawG, cfg.minMargin, cfg.maxMargin);
    const { m: mR, capped: capR } = clampMargin(rawR, cfg.minMargin, cfg.maxMargin);
    state.marginHistory.push({ ts, mG, mR, atCapG: capG, atCapR: capR, eq: state.equity });

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // GARCH
      if (!openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) {
          if (regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) {
            const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
            if (inUse + mG <= state.equity * 0.95) {
              const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
              const sl = ep * (1 - cfg.slPct);
              openPositions.push({
                engine: "garch", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: mG * p.lev, margin: mG,
                maxHoldH: cfg.garchMaxHoldH,
              });
              state.sumMarginG += mG; state.nMarginG++;
              if (capG) state.timesAtCapG++;
              state.totalEntries++;
            }
          }
        }
      }

      // REX
      if (!openPositions.some(o => o.pair === p.name && o.engine === "rex")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          if (regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) {
            const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
            if (inUse + mR <= state.equity * 0.95) {
              const dir: "long" | "short" = sig > 0 ? "long" : "short";
              const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
              const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
              openPositions.push({
                engine: "rex", pair: p.name, dir, ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: mR * p.lev, margin: mR,
                maxHoldH: cfg.rexMaxHoldH,
              });
              state.sumMarginR += mR; state.nMarginR++;
              if (capR) state.timesAtCapR++;
              state.totalEntries++;
            }
          }
        }
      }
    }
  }

  // Close any still-open
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const bars = pd.ind.m5;
    let lb: C | null = null;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i]!.t < endTs) { lb = bars[i]!; break; } }
    if (!lb) continue;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    state.equity += pnl;
    state.totalPnl += pnl;
    state.engPnl[pos.engine] += pnl;
    state.engTrades[pos.engine] += 1;
    if (state.equity > state.peakEquity) state.peakEquity = state.equity;
    if (state.equity < state.minEquity) state.minEquity = state.equity;
    const ddAbs = state.peakEquity - state.equity;
    if (ddAbs > state.maxDDDollar) state.maxDDDollar = ddAbs;
    const ddPct = state.peakEquity > 0 ? (ddAbs / state.peakEquity) * 100 : 0;
    if (ddPct > state.maxDDPctRunning) state.maxDDPctRunning = ddPct;
    state.equityHistory.push(state.equity);
  }
}

// ============================================================================
// MAIN
// ============================================================================

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const LINES: string[] = [];
function log(s = ""): void { console.log(s); LINES.push(s); }

function reportR(tag: string, r: Res): void {
  log(`  ${tag}: $/day ${fmtD(r.dollarsPerDay)}  total ${fmtD(r.totalPnl)}  MDD $${r.maxDD.toFixed(2)}  PF ${r.pf.toFixed(2)}  WR ${r.wr.toFixed(1)}%  N=${r.numTrades}  maxL ${fmtD(r.maxSingleLoss)}`);
  if (r.byEngine.garch.n > 0) log(`     garch: ${fmtD(r.byEngine.garch.pnl)} (${r.byEngine.garch.n} trades)`);
  if (r.byEngine.rex.n > 0) log(`     rex:   ${fmtD(r.byEngine.rex.pnl)} (${r.byEngine.rex.n} trades)`);
}

function baseCfg(): Cfg {
  return {
    label: "",
    runGarch: false, runRex: false,
    marginGarch: 15, marginRex: 15,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailMode: "multi",
    trailSingleAct: 9, trailSingleDist: 0.5,
    trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
    zL1: 2.0, zL4: 1.5,
    garchMaxHoldH: 72,
    rexMult: 2.0,
    rexMaxHoldH: 12,
    regimeDef: "RV", regimeThr: 1.5,
  };
}

function main() {
  log("=".repeat(140));
  log("  VERIFICATION — 3 findings (ATR regime, compounding, REX trail)");
  log("  IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03-25");
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
    const atr14 = computeATR(h1, 14);
    const atrMed30 = computeRollingMedian(atr14, 720, 6);
    const rexSig20 = computeRangeExpansion(h1, atr14, 2.0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168, atr14, atrMed30, rexSig20 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  // ========================================================================
  // FINDING 1 — ATR vs RV regime for GARCH long-only
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  FINDING 1 — ATR regime filter (thr 1.6) vs deployed RV regime (thr 1.5)");
  log("  GARCH long-only, SL 0.15%, multi-stage trail 3/1 -> 9/0.5 -> 20/0.5, block h22-23, max hold 72h");
  log("=".repeat(140));

  const runGarchOnly = (label: string, regimeDef: RegimeDef, regimeThr: number, margin: number, slip = 1.5): { is: Res; oos: Res; } => {
    const cfg: Cfg = {
      ...baseCfg(),
      label,
      runGarch: true, runRex: false,
      marginGarch: margin,
      slSlipMult: slip,
      regimeDef, regimeThr,
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    return { is, oos };
  };

  log("\n  [A] Baseline: deployed RV regime thr 1.5, m$15 (slip 1.5x)");
  const rv15_15 = runGarchOnly("RV@1.5 m$15", "RV", 1.5, 15, 1.5);
  reportR("IS ", rv15_15.is);
  reportR("OOS", rv15_15.oos);

  log("\n  [B] ATR regime thr 1.6, m$15 (slip 1.5x)");
  const atr16_15 = runGarchOnly("ATR@1.6 m$15", "ATR", 1.6, 15, 1.5);
  reportR("IS ", atr16_15.is);
  reportR("OOS", atr16_15.oos);

  log("\n  [C] ATR regime thr 1.6, m$30 (slip 1.5x)");
  const atr16_30 = runGarchOnly("ATR@1.6 m$30", "ATR", 1.6, 30, 1.5);
  reportR("IS ", atr16_30.is);
  reportR("OOS", atr16_30.oos);

  log("\n  [D] RV regime thr 1.5, m$30 (for scaling comparison)");
  const rv15_30 = runGarchOnly("RV@1.5 m$30", "RV", 1.5, 30, 1.5);
  reportR("IS ", rv15_30.is);
  reportR("OOS", rv15_30.oos);

  log("\n  Stress: slip 2.5x");
  log("\n  [B'] ATR@1.6 m$15 slip 2.5");
  const atr16_15_s = runGarchOnly("ATR@1.6 m$15 s2.5", "ATR", 1.6, 15, 2.5);
  reportR("OOS", atr16_15_s.oos);
  log("\n  [A'] RV@1.5 m$15 slip 2.5");
  const rv15_15_s = runGarchOnly("RV@1.5 m$15 s2.5", "RV", 1.5, 15, 2.5);
  reportR("OOS", rv15_15_s.oos);

  // Finding 1 verdict
  log("\n  FINDING 1 VERDICT:");
  const claimAtrOOS = 1.58;
  const claimAtrMdd = 5.5;
  const claimRvOOS = 1.17;
  const claimRvMdd = 17;
  log(`    Claim ATR@1.6 m$15:     $/day ≈ +$${claimAtrOOS.toFixed(2)}  MDD ≈ $${claimAtrMdd}`);
  log(`    Actual ATR@1.6 m$15:    $/day ${fmtD(atr16_15.oos.dollarsPerDay)}  MDD $${atr16_15.oos.maxDD.toFixed(2)}`);
  log(`    Claim RV@1.5 m$15:      $/day ≈ +$${claimRvOOS.toFixed(2)}  MDD ≈ $${claimRvMdd}`);
  log(`    Actual RV@1.5 m$15:     $/day ${fmtD(rv15_15.oos.dollarsPerDay)}  MDD $${rv15_15.oos.maxDD.toFixed(2)}`);
  log(`    Delta ATR vs RV (OOS):  $/day ${fmtD(atr16_15.oos.dollarsPerDay - rv15_15.oos.dollarsPerDay)}  MDD ${(atr16_15.oos.maxDD - rv15_15.oos.maxDD).toFixed(2)}`);

  // Linear scaling check
  const scaleDpd = atr16_30.oos.dollarsPerDay / (atr16_15.oos.dollarsPerDay || 1e-9);
  const scaleMdd = atr16_30.oos.maxDD / (atr16_15.oos.maxDD || 1e-9);
  log(`\n    LINEAR SCALING CHECK (ATR@1.6, m$30 / m$15):`);
  log(`      $/day ratio: ${scaleDpd.toFixed(2)}x  (perfect linear = 2.00x)`);
  log(`      MDD ratio:   ${scaleMdd.toFixed(2)}x  (perfect linear = 2.00x)`);
  if (Math.abs(scaleDpd - 2) < 0.2 && Math.abs(scaleMdd - 2) < 0.3) {
    log("      -> Linear scaling HOLDS.");
  } else {
    log("      -> Linear scaling FAILS.");
  }

  // ========================================================================
  // FINDING 3 — REX multi-stage vs single-stage trail
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  FINDING 3 — REX standalone: multi-stage trail vs single-stage 9/0.5");
  log("  REX entry: 1h range >= 2.0*ATR, close in extreme 25%, regime RV>1.5, SL 0.15%, m$15, maxhold 12h");
  log("=".repeat(140));

  const runRexOnly = (label: string, trailMode: TrailMode, slip = 1.5): { is: Res; oos: Res; } => {
    const cfg: Cfg = {
      ...baseCfg(),
      label,
      runGarch: false, runRex: true,
      marginRex: 15,
      slSlipMult: slip,
      trailMode,
      trailSingleAct: 9, trailSingleDist: 0.5,
      trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
      regimeDef: "RV", regimeThr: 1.5,
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    return { is, oos };
  };

  log("\n  [E] REX multi-stage 3/1 -> 9/0.5 -> 20/0.5");
  const rexMulti = runRexOnly("REX multi", "multi");
  reportR("IS ", rexMulti.is);
  reportR("OOS", rexMulti.oos);

  log("\n  [F] REX single-stage 9/0.5");
  const rexSingle = runRexOnly("REX single 9/0.5", "single");
  reportR("IS ", rexSingle.is);
  reportR("OOS", rexSingle.oos);

  log("\n  Stress slip 2.5:");
  const rexMulti_s = runRexOnly("REX multi s2.5", "multi", 2.5);
  const rexSingle_s = runRexOnly("REX single s2.5", "single", 2.5);
  log(`    REX multi  OOS: ${fmtD(rexMulti_s.oos.dollarsPerDay)}/day MDD $${rexMulti_s.oos.maxDD.toFixed(2)}`);
  log(`    REX single OOS: ${fmtD(rexSingle_s.oos.dollarsPerDay)}/day MDD $${rexSingle_s.oos.maxDD.toFixed(2)}`);

  log("\n  FINDING 3 VERDICT:");
  log(`    Claim multi:   +$1.10/day MDD $13`);
  log(`    Actual multi:  ${fmtD(rexMulti.oos.dollarsPerDay)}/day MDD $${rexMulti.oos.maxDD.toFixed(2)}`);
  log(`    Claim single:  +$1.24/day MDD $12`);
  log(`    Actual single: ${fmtD(rexSingle.oos.dollarsPerDay)}/day MDD $${rexSingle.oos.maxDD.toFixed(2)}`);
  const diff3 = rexSingle.oos.dollarsPerDay - rexMulti.oos.dollarsPerDay;
  log(`    Single - multi $/day: ${fmtD(diff3)}`);
  if (diff3 > 0.05) log(`    -> Single-stage WINS by ${fmtD(diff3)}/day. Multi-stage trail hurts REX.`);
  else if (diff3 < -0.05) log(`    -> Multi-stage WINS. Claim is FALSE.`);
  else log(`    -> Approximately TIED (delta < $0.05/day).`);

  // ========================================================================
  // FINDING 2 — Compounding $60 -> $3000+
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  FINDING 2 — Compounding $60 start, 20%+20%, cap $80/engine");
  log("  Equity updates trade-by-trade; margin = pct * equity, clamped [$5, cap]");
  log("=".repeat(140));

  // ---- CAPS TO TEST ----
  const caps = [80, 200, 500, 1000];
  interface CompRes {
    cap: number;
    isEnd: number;
    oosFinal: number;
    peakEquity: number;
    maxDDDollar: number;
    maxDDPctRunning: number;
    pctAtCap: number;
    totalPnl: number;
    oosTrades: number;
    oosDpd: number;
    finalDpd: number;
  }
  const compRes: CompRes[] = [];

  for (const cap of caps) {
    log(`\n  [G-${cap}] Compound 20%/20%, start $60, cap $${cap}`);
    const cfg: CompCfg = {
      label: `cap$${cap}`,
      startEquity: 60,
      minMargin: 5,
      maxMargin: cap,
      pctGarch: 0.20, pctRex: 0.20,
      slPct: 0.0015, slSlipMult: 1.5,
      trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
      zL1: 2.0, zL4: 1.5,
      regimeDef: "RV", regimeThr: 1.5,
      garchMaxHoldH: 72, rexMaxHoldH: 12,
    };
    const state = newCompState(60);
    // Reset simCaches keyed by pairs length; caches are reusable
    runCompoundTop(pairs, cfg, state, IS_S, IS_E);
    const isEnd = state.equity;
    runCompoundTop(pairs, cfg, state, OOS_S, OOS_E);
    const oosFinal = state.equity;

    const atCapTotal = state.timesAtCapG + state.timesAtCapR;
    const entriesTotal = state.nMarginG + state.nMarginR;
    const pctCap = entriesTotal > 0 ? (atCapTotal / entriesTotal) * 100 : 0;
    const totalDays = IS_D + OOS_D;
    const dpd = (oosFinal - 60) / totalDays;
    const finalMgG = Math.min(oosFinal * 0.20, cap);
    const finalMgR = Math.min(oosFinal * 0.20, cap);
    const avgMgG = state.nMarginG > 0 ? state.sumMarginG / state.nMarginG : 0;
    const avgMgR = state.nMarginR > 0 ? state.sumMarginR / state.nMarginR : 0;
    const finalTotal = finalMgG + finalMgR;
    const avgTotal = avgMgG + avgMgR;
    const finalDpd = avgTotal > 0 ? dpd * (finalTotal / avgTotal) : dpd;

    log(`    IS-end equity:   $${isEnd.toFixed(2)}`);
    log(`    OOS-final:       $${oosFinal.toFixed(2)}  (growth: ${((oosFinal / 60 - 1) * 100).toFixed(1)}%)`);
    log(`    Peak equity:     $${state.peakEquity.toFixed(2)}`);
    log(`    MaxDD $:         $${state.maxDDDollar.toFixed(2)}`);
    log(`    MaxDD % of peak: ${state.maxDDPctRunning.toFixed(1)}%`);
    log(`    At-cap entries:  ${atCapTotal}/${entriesTotal} (${pctCap.toFixed(1)}%)`);
    log(`    Avg margin G/R:  $${avgMgG.toFixed(2)} / $${avgMgR.toFixed(2)}`);
    log(`    Final margin G/R:$${finalMgG.toFixed(2)} / $${finalMgR.toFixed(2)}`);
    log(`    Trades G/R:      ${state.nMarginG} / ${state.nMarginR}`);
    log(`    $/day avg:       ${fmtD(dpd)}`);
    log(`    $/day final-scale: ${fmtD(finalDpd)}`);

    compRes.push({
      cap, isEnd, oosFinal,
      peakEquity: state.peakEquity,
      maxDDDollar: state.maxDDDollar,
      maxDDPctRunning: state.maxDDPctRunning,
      pctAtCap: pctCap,
      totalPnl: oosFinal - 60,
      oosTrades: state.engTrades.garch + state.engTrades.rex,
      oosDpd: dpd,
      finalDpd,
    });
  }

  log("\n  FINDING 2 VERDICT:");
  log("    Cap$  | Final$  | Peak$  | MDD$  | MDD%  | AtCap% | Trades | $/day | final-scale $/day");
  for (const r of compRes) {
    log(`    $${String(r.cap).padEnd(4)} | $${r.oosFinal.toFixed(0).padEnd(6)} | $${r.peakEquity.toFixed(0).padEnd(5)} | $${r.maxDDDollar.toFixed(0).padEnd(4)} | ${r.maxDDPctRunning.toFixed(1).padStart(4)}% | ${r.pctAtCap.toFixed(0).padStart(5)}% | ${String(r.oosTrades).padEnd(6)} | ${fmtD(r.oosDpd).padStart(8)} | ${fmtD(r.finalDpd).padStart(8)}`);
  }
  const cap80 = compRes.find(r => r.cap === 80)!;
  log(`\n    Claim: $60 -> $3000+, MDD% < 33%`);
  log(`    Actual cap$80: $60 -> $${cap80.oosFinal.toFixed(0)}, MDD% ${cap80.maxDDPctRunning.toFixed(1)}%`);
  if (cap80.pctAtCap > 80) {
    log(`    -> FAKE COMPOUNDING: ${cap80.pctAtCap.toFixed(0)}% of entries hit the cap. It's essentially fixed-margin at $80 per engine.`);
  } else if (cap80.pctAtCap > 50) {
    log(`    -> PARTIAL COMPOUNDING: ${cap80.pctAtCap.toFixed(0)}% at cap. Compounding active early, then capped.`);
  } else {
    log(`    -> Genuine compounding: only ${cap80.pctAtCap.toFixed(0)}% at cap.`);
  }

  // ========================================================================
  // FINAL VERDICT
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  FINAL VERDICT");
  log("=".repeat(140));

  // Finding 1
  const f1_win = atr16_15.oos.dollarsPerDay > rv15_15.oos.dollarsPerDay && atr16_15.oos.maxDD <= rv15_15.oos.maxDD + 2;
  log(`  1) ATR regime (thr 1.6) vs RV regime (thr 1.5) at m$15:`);
  log(`     ATR: ${fmtD(atr16_15.oos.dollarsPerDay)}/day MDD $${atr16_15.oos.maxDD.toFixed(2)}`);
  log(`     RV:  ${fmtD(rv15_15.oos.dollarsPerDay)}/day MDD $${rv15_15.oos.maxDD.toFixed(2)}`);
  log(`     ${f1_win ? "DEPLOY" : "DO NOT DEPLOY"}`);

  // Finding 2
  log(`  2) Compounding $60 -> claim $3000+:`);
  log(`     cap$80: ended at $${cap80.oosFinal.toFixed(0)}, atCap ${cap80.pctAtCap.toFixed(0)}%`);
  const f2_win = cap80.oosFinal >= 3000 && cap80.maxDDPctRunning < 33;
  log(`     ${f2_win ? "DEPLOY" : "DO NOT DEPLOY (claim not supported)"}`);

  // Finding 3
  const f3_single_wins = rexSingle.oos.dollarsPerDay > rexMulti.oos.dollarsPerDay + 0.03;
  log(`  3) REX single-stage vs multi-stage trail:`);
  log(`     multi:  ${fmtD(rexMulti.oos.dollarsPerDay)}/day MDD $${rexMulti.oos.maxDD.toFixed(2)}`);
  log(`     single: ${fmtD(rexSingle.oos.dollarsPerDay)}/day MDD $${rexSingle.oos.maxDD.toFixed(2)}`);
  log(`     ${f3_single_wins ? "SWITCH REX TO SINGLE-STAGE 9/0.5" : "KEEP MULTI-STAGE"}`);

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "verify.txt"), LINES.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "verify.txt")}`);

}

// ============================================================================
// TOP-LEVEL compound runner
// ============================================================================
function runCompoundTop(
  pairs: PD[],
  cfg: CompCfg,
  state: CompState,
  startTs: number,
  endTs: number,
): void {
  const openPositions: OpenPos[] = [];
  const { timepoints, m5Maps, pairByName } = getSimCache(pairs, startTs, endTs);

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    // Exits
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair); if (!m5Map) continue;
      const bi = m5Map.get(ts); if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, isSL = false;
      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; isSL = true; }
      }
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        let actDist = -1;
        for (const [act, dist] of cfg.trailStages) {
          if (pos.pk >= act) actDist = dist;
        }
        if (actDist > 0 && cur <= pos.pk - actDist) { xp = bar.c; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;

        state.equity += pnl;
        state.totalPnl += pnl;
        state.engPnl[pos.engine] += pnl;
        state.engTrades[pos.engine] += 1;
        if (state.equity > state.peakEquity) state.peakEquity = state.equity;
        if (state.equity < state.minEquity) state.minEquity = state.equity;
        const ddAbs = state.peakEquity - state.equity;
        if (ddAbs > state.maxDDDollar) state.maxDDDollar = ddAbs;
        const ddPct = state.peakEquity > 0 ? (ddAbs / state.peakEquity) * 100 : 0;
        if (ddPct > state.maxDDPctRunning) state.maxDDPctRunning = ddPct;
        state.equityHistory.push(state.equity);
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    const rawG = state.equity * cfg.pctGarch;
    const rawR = state.equity * cfg.pctRex;
    const { m: mG, capped: capG } = clampMargin(rawG, cfg.minMargin, cfg.maxMargin);
    const { m: mR, capped: capR } = clampMargin(rawR, cfg.minMargin, cfg.maxMargin);

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // GARCH
      if (!openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) {
          if (regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) {
            const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
            if (inUse + mG <= state.equity * 0.95) {
              const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
              const sl = ep * (1 - cfg.slPct);
              openPositions.push({
                engine: "garch", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: mG * p.lev, margin: mG,
                maxHoldH: cfg.garchMaxHoldH,
              });
              state.sumMarginG += mG; state.nMarginG++;
              if (capG) state.timesAtCapG++;
              state.totalEntries++;
            }
          }
        }
      }

      // REX
      if (!openPositions.some(o => o.pair === p.name && o.engine === "rex")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          if (regimePasses(p, h1Idx, cfg.regimeDef, cfg.regimeThr)) {
            const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
            if (inUse + mR <= state.equity * 0.95) {
              const dir: "long" | "short" = sig > 0 ? "long" : "short";
              const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
              const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
              openPositions.push({
                engine: "rex", pair: p.name, dir, ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: mR * p.lev, margin: mR,
                maxHoldH: cfg.rexMaxHoldH,
              });
              state.sumMarginR += mR; state.nMarginR++;
              if (capR) state.timesAtCapR++;
              state.totalEntries++;
            }
          }
        }
      }
    }
  }

  // Close any still-open
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const bars = pd.ind.m5;
    let lb: C | null = null;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i]!.t < endTs) { lb = bars[i]!; break; } }
    if (!lb) continue;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    state.equity += pnl;
    state.totalPnl += pnl;
    state.engPnl[pos.engine] += pnl;
    state.engTrades[pos.engine] += 1;
    if (state.equity > state.peakEquity) state.peakEquity = state.equity;
    if (state.equity < state.minEquity) state.minEquity = state.equity;
    const ddAbs = state.peakEquity - state.equity;
    if (ddAbs > state.maxDDDollar) state.maxDDDollar = ddAbs;
    const ddPct = state.peakEquity > 0 ? (ddAbs / state.peakEquity) * 100 : 0;
    if (ddPct > state.maxDDPctRunning) state.maxDDPctRunning = ddPct;
    state.equityHistory.push(state.equity);
  }
}

main();
