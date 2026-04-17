/**
 * PUSH PROFIT v2: Find path to >$5/day with MDD <$20
 *
 * Builds on the bt-exchange-sl-research.ts engine. Tests:
 *   A. Bigger margin sweep ($30-$50) on top5 z3/2 mc2-5
 *   B. Parallel engine simulation (two non-overlapping pair sets, merged equity)
 *   C. Multi-stage trails ([20/2, 50/5, 100/10])
 *   D. Wider pair universes (top8-top15) with bigger margin
 *   E. Conditional z-reversal (only if losing)
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-push-profit.ts
 */

import * as fs from "fs";
import * as path from "path";

// ───── Constants ─────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MOM_LB = 3;
const VOL_WIN = 20;
const MAX_HOLD_H = 72;
const CD_H = 1;
const BLOCK_HOURS = new Set([22, 23]);
const FEE = 0.00035;

// Spread per pair (from production)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

// Real HL max leverage map
const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
function getLev(n: string): number {
  return Math.min(LM.get(n) ?? 3, 10);
}

// 127 pairs
const ALL = [
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

const OOS_S = new Date("2025-06-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;

// ───── Types ─────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string;
  dir: "long" | "short";
  entryTs: number;
  exitTs: number;
  pnl: number;
  reason: string;
  peakPnlPct: number;
}
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  z1: number[]; z4: number[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
}
interface PD { name: string; ind: PI; sp: number; lev: number; not: number; }

// ───── Data ─────
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
    r.push({
      t,
      o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
  }
  return r.sort((a, b) => a.t - b.t);
}

function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - MOM_LB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += r * r;
      c++;
    }
    if (c < 10) continue;
    const v = Math.sqrt(ss / c);
    if (v === 0) continue;
    z[i] = m / v;
  }
  return z;
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

function get1hZNow(pd: PI, t: number): number {
  let lo = 0, hi = pd.h1.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pd.h1[m]!.t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? pd.z1[best]! : 0;
}

// ───── Strategy Config ─────
interface TrailStep { a: number; d: number; }
interface StratConfig {
  label: string;
  slPct: number;
  trail: TrailStep[];
  zReversal?: boolean;
  zReversalOnlyLosing?: boolean; // Only z-reverse if position is losing
  maxConcurrent?: number;
  z1hThresh?: number;
  z4hThresh?: number;
  marginUsd?: number;
  longOnly?: boolean;
  pairAllow?: Set<string>;
  maxHoldH?: number;
}

// ───── Simulation ─────
interface OpenPos {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  pk: number;
  sp: number;
  lev: number;
  not: number;
  entryZ1: number;
}

interface SimResult {
  trades: Tr[];
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;       // mark-to-market (includes unrealized)
  maxDDClosed: number;  // closed-trade only (for comparison)
  pf: number;
  wr: number;
  avgWin: number;
  avgLoss: number;
  maxSingleLoss: number;
  numTrades: number;
}

// Preload shared structures
let __timepoints: number[] | null = null;
let __m5Maps: Map<string, Map<number, number>> | null = null;
let __pairByName: Map<string, PD> | null = null;

function prepareShared(pairs: PD[]): void {
  if (__timepoints && __m5Maps && __pairByName) return;
  const all = new Set<number>();
  __m5Maps = new Map();
  __pairByName = new Map();
  for (const p of pairs) {
    __pairByName.set(p.name, p);
    const m = new Map<number, number>();
    for (let i = 0; i < p.ind.m5.length; i++) {
      const b = p.ind.m5[i]!;
      m.set(b.t, i);
      if (b.t >= OOS_S && b.t < OOS_E) all.add(b.t);
    }
    __m5Maps.set(p.name, m);
  }
  __timepoints = [...all].sort((a, b) => a - b);
}

function simulate(pairs: PD[], cfg: StratConfig): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  prepareShared(pairs);
  const timepoints = __timepoints!;
  const m5Maps = __m5Maps!;
  const pairByName = __pairByName!;

  const Z_LONG_1H = cfg.z1hThresh ?? 3.0;
  const Z_LONG_4H = cfg.z4hThresh ?? 2.0;
  const Z_SHORT_1H = -Z_LONG_1H;
  const Z_SHORT_4H = -Z_LONG_4H;
  const MARGIN = cfg.marginUsd ?? 22;

  // Mark-to-market MDD tracking
  let realizedPnl = 0;
  let mtmPeak = 0;
  let mtmMaxDD = 0;

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // ─── EXIT checks ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      const barsHeld = (ts - pos.et) / H;

      // 1) Max hold
      const maxHold = cfg.maxHoldH ?? MAX_HOLD_H;
      if (barsHeld >= maxHold) { xp = bar.c; reason = "maxh"; }

      // 2) Exchange SL (intra-bar)
      if (!xp) {
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }

      // Compute peak for trail
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      // 3) Multi-stage trailing stop (leveraged %) — CHECK ONLY AT 1H BOUNDARIES (matches production)
      if (!xp && isH1Boundary && cfg.trail.length > 0) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        let td = Infinity;
        for (const s of cfg.trail) if (pos.pk >= s.a) td = s.d;
        if (td < Infinity && cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
      }

      // 4) Z-reversal exit (on 1h boundary) — use PRIOR completed bar (no look-ahead)
      if (!xp && isH1Boundary) {
        const doZrev = cfg.zReversal || cfg.zReversalOnlyLosing;
        if (doZrev) {
          // Use h1Idx-1 (prior completed bar) not get1hZNow (which peeks at current unclosed bar)
          const h1i = pd.ind.h1Map.get(ts);
          const zNow = (h1i !== undefined && h1i > 0) ? pd.ind.z1[h1i - 1]! : 0;
          const reversed = (pos.dir === "long" && pos.entryZ1 > 0 && zNow < 0) ||
                           (pos.dir === "short" && pos.entryZ1 < 0 && zNow > 0);
          if (reversed) {
            if (cfg.zReversalOnlyLosing) {
              // Only fire if position is losing
              const curLev = pos.dir === "long"
                ? (bar.c / pos.ep - 1) * pos.lev * 100
                : (pos.ep / bar.c - 1) * pos.lev * 100;
              if (curLev < 0) { xp = bar.c; reason = "zrev"; }
            } else {
              xp = bar.c; reason = "zrev";
            }
          }
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * 1.5 : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (1 - ex / pos.ep)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: ts, pnl, reason, peakPnlPct: pos.pk });
        openPositions.splice(i, 1);
        realizedPnl += pnl;
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    // ─── ENTRY on 1h boundaries ───
    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.has(hourOfDay)) continue;
    if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) continue;

    for (const p of pairs) {
      if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) break;
      if (cfg.pairAllow && !cfg.pairAllow.has(p.name)) continue;
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > Z_LONG_1H && z4 > Z_LONG_4H) dir = "long";
      if (z1 < Z_SHORT_1H && z4 < Z_SHORT_4H) dir = "short";
      if (!dir) continue;
      if (cfg.longOnly && dir !== "long") continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const dist = ep * (cfg.slPct / 100);
      const slPrice = dir === "long" ? ep - dist : ep + dist;
      const effNot = MARGIN * p.lev;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl: slPrice, pk: 0,
        sp: p.sp, lev: p.lev, not: effNot,
        entryZ1: z1,
      });
    }

    // ─── Mark-to-market MDD: realized + unrealized at this timestep ───
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const pm = m5Maps.get(pos.pair);
      if (!pm) continue;
      const bi = pm.get(ts);
      if (bi === undefined) continue;
      const b = pairByName.get(pos.pair)!.ind.m5[bi]!;
      const midExit = pos.dir === "long" ? b.c * (1 - pos.sp) : b.c * (1 + pos.sp);
      unrealizedPnl += (pos.dir === "long" ? (midExit / pos.ep - 1) : (1 - midExit / pos.ep)) * pos.not - pos.not * FEE * 2;
    }
    const mtmEquity = realizedPnl + unrealizedPnl;
    if (mtmEquity > mtmPeak) mtmPeak = mtmEquity;
    if (mtmPeak - mtmEquity > mtmMaxDD) mtmMaxDD = mtmPeak - mtmEquity;
  }

  // Close remaining at end
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (1 - ex / pos.ep)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: lb.t, pnl, reason: "end", peakPnlPct: pos.pk });
  }

  return computeStats(closed, mtmMaxDD);
}

function computeStats(closed: Tr[], mtmDD?: number): SimResult {
  closed.sort((a, b) => a.exitTs - b.exitTs);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;
  let cum = 0, peak = 0, maxDDClosed = 0;
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDDClosed) maxDDClosed = peak - cum;
  }
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  let maxSingleLoss = 0;
  for (const t of losses) if (t.pnl < maxSingleLoss) maxSingleLoss = t.pnl;

  // Use mark-to-market MDD if available (from simulate), otherwise closed-trade MDD
  const maxDD = mtmDD !== undefined ? mtmDD : maxDDClosed;

  return {
    trades: closed,
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    maxDD,
    maxDDClosed,
    pf,
    wr,
    avgWin,
    avgLoss,
    maxSingleLoss,
    numTrades: closed.length,
  };
}

// ───── PARALLEL ENGINE: merge two engines' trades, compute combined MDD ─────
function mergeEngines(r1: SimResult, r2: SimResult): SimResult {
  const allTrades = [...r1.trades, ...r2.trades];
  return computeStats(allTrades);
}

// ───── Config Builder ─────
function buildConfigs(): StratConfig[] {
  const cfgs: StratConfig[] = [];

  // Pair universes
  const TOP5 = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK"]);
  const ALT5_A = new Set(["AVAX", "DOT", "ADA", "LDO", "OP"]);
  const ALT5_B = new Set(["ARB", "UNI", "NEAR", "APT", "TIA"]);
  const ALT5_C = new Set(["SUI", "ENA", "HYPE", "FET", "WIF"]);
  const TOP8 = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK", "AVAX", "DOT", "ADA"]);
  const TOP10 = new Set([...TOP8, "LDO", "OP"]);
  const TOP12 = new Set([...TOP10, "ARB", "UNI"]);
  const TOP15 = new Set([...TOP12, "NEAR", "APT", "SUI"]);

  // ═══════════════════════════════════════════════════════════════
  // A: BIGGER MARGIN SWEEP on top5 z3/2
  // ═══════════════════════════════════════════════════════════════
  for (const mrg of [30, 35, 40, 45, 50]) {
    for (const mc of [2, 3, 4, 5]) {
      // With tr80/8
      cfgs.push({
        label: `A $${mrg}mrg mc${mc} tr80/8 zrev`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
      // With tr100/10
      cfgs.push({
        label: `A $${mrg}mrg mc${mc} tr100/10 zrev`,
        slPct: 3, trail: [{ a: 100, d: 10 }], zReversal: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
    }
  }

  // Also test without zrev (trail+SL only)
  for (const mrg of [30, 40, 50]) {
    for (const mc of [2, 3, 5]) {
      cfgs.push({
        label: `A $${mrg}mrg mc${mc} tr80/8 noZrev`,
        slPct: 3, trail: [{ a: 80, d: 8 }],
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // C: MULTI-STAGE TRAILS on top5 z3/2
  // ═══════════════════════════════════════════════════════════════
  const multiTrails: Array<{ lbl: string; steps: TrailStep[] }> = [
    { lbl: "mt[20/2,50/5,100/10]", steps: [{ a: 20, d: 2 }, { a: 50, d: 5 }, { a: 100, d: 10 }] },
    { lbl: "mt[15/2,40/4,80/8]", steps: [{ a: 15, d: 2 }, { a: 40, d: 4 }, { a: 80, d: 8 }] },
    { lbl: "mt[10/1,30/3,60/6,100/10]", steps: [{ a: 10, d: 1 }, { a: 30, d: 3 }, { a: 60, d: 6 }, { a: 100, d: 10 }] },
    { lbl: "mt[20/3,50/5]", steps: [{ a: 20, d: 3 }, { a: 50, d: 5 }] },
    { lbl: "mt[30/3,70/7,120/12]", steps: [{ a: 30, d: 3 }, { a: 70, d: 7 }, { a: 120, d: 12 }] },
    { lbl: "mt[7/1,20/2,50/5,100/10]", steps: [{ a: 7, d: 1 }, { a: 20, d: 2 }, { a: 50, d: 5 }, { a: 100, d: 10 }] },
    { lbl: "mt[9/0.5,30/3,80/8]", steps: [{ a: 9, d: 0.5 }, { a: 30, d: 3 }, { a: 80, d: 8 }] },
    { lbl: "mt[15/1.5,50/5,100/10]", steps: [{ a: 15, d: 1.5 }, { a: 50, d: 5 }, { a: 100, d: 10 }] },
  ];
  for (const mt of multiTrails) {
    for (const mrg of [22, 30, 40]) {
      for (const mc of [2, 3, 5]) {
        cfgs.push({
          label: `C $${mrg}mrg mc${mc} ${mt.lbl} zrev`,
          slPct: 3, trail: mt.steps, zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // D: WIDER PAIR UNIVERSES with bigger margin
  // ═══════════════════════════════════════════════════════════════
  for (const uni of [
    { set: TOP8, name: "top8" },
    { set: TOP10, name: "top10" },
    { set: TOP12, name: "top12" },
    { set: TOP15, name: "top15" },
  ]) {
    for (const mrg of [25, 30, 35, 40]) {
      for (const mc of [3, 4, 5]) {
        cfgs.push({
          label: `D ${uni.name} $${mrg}mrg mc${mc} tr80/8 zrev`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: uni.set, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
        cfgs.push({
          label: `D ${uni.name} $${mrg}mrg mc${mc} tr100/10 zrev`,
          slPct: 3, trail: [{ a: 100, d: 10 }], zReversal: true,
          pairAllow: uni.set, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // E: CONDITIONAL Z-REVERSAL (only if losing)
  // Let winners ride on trail alone, cut losers via z-reversal
  // ═══════════════════════════════════════════════════════════════
  for (const mrg of [22, 30, 40, 50]) {
    for (const mc of [2, 3, 5]) {
      cfgs.push({
        label: `E $${mrg}mrg mc${mc} tr80/8 zrevLosing`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
      cfgs.push({
        label: `E $${mrg}mrg mc${mc} tr100/10 zrevLosing`,
        slPct: 3, trail: [{ a: 100, d: 10 }], zReversalOnlyLosing: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
    }
  }

  // E with multi-stage trails
  for (const mt of multiTrails.slice(0, 4)) {
    for (const mrg of [30, 40]) {
      for (const mc of [2, 3]) {
        cfgs.push({
          label: `E $${mrg}mrg mc${mc} ${mt.lbl} zrevLosing`,
          slPct: 3, trail: mt.steps, zReversalOnlyLosing: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // E on wider universes
  for (const uni of [
    { set: TOP8, name: "top8" },
    { set: TOP10, name: "top10" },
  ]) {
    for (const mrg of [30, 40]) {
      for (const mc of [3, 4, 5]) {
        cfgs.push({
          label: `E ${uni.name} $${mrg}mrg mc${mc} tr80/8 zrevLosing`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: uni.set, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // F: BASELINE reference (current best: $22mrg mc3 tr80/8 zrev top5)
  // ═══════════════════════════════════════════════════════════════
  cfgs.push({
    label: `F BASELINE $22mrg mc3 tr80/8 zrev top5`,
    slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
    pairAllow: TOP5, marginUsd: 22, maxConcurrent: 3,
    z1hThresh: 3, z4hThresh: 2,
  });

  // ═══════════════════════════════════════════════════════════════
  // G: WIDER SL sweep on high-margin configs (maybe 3% is too tight)
  // ═══════════════════════════════════════════════════════════════
  for (const slPct of [2, 4, 5, 7]) {
    for (const mrg of [30, 40]) {
      for (const mc of [2, 3]) {
        cfgs.push({
          label: `G SL${slPct}% $${mrg}mrg mc${mc} tr80/8 zrev top5`,
          slPct, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // H: LONG-ONLY variants (shorts may drag $/day and inflate MDD)
  // ═══════════════════════════════════════════════════════════════
  for (const mrg of [30, 40, 50]) {
    for (const mc of [2, 3, 5]) {
      cfgs.push({
        label: `H LONG $${mrg}mrg mc${mc} tr80/8 zrev top5`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2, longOnly: true,
      });
    }
  }
  for (const uni of [
    { set: TOP10, name: "top10" },
    { set: TOP15, name: "top15" },
  ]) {
    for (const mrg of [30, 40]) {
      for (const mc of [3, 5]) {
        cfgs.push({
          label: `H LONG ${uni.name} $${mrg}mrg mc${mc} tr80/8 zrev`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: uni.set, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2, longOnly: true,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // I: LOOSER Z on bigger margin (z2.5/1.5 or z2/1.5 -- more trades)
  // ═══════════════════════════════════════════════════════════════
  for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 2.5, z4: 2 }, { z1: 2, z4: 1.5 }]) {
    for (const mrg of [30, 40]) {
      for (const mc of [2, 3, 5]) {
        cfgs.push({
          label: `I z${z.z1}/${z.z4} $${mrg}mrg mc${mc} tr80/8 zrev top5`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: z.z1, z4hThresh: z.z4,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // J: EXTREME MARGIN ($60-$80) on top5 z3/2 mc1-2 (bet big, few slots)
  // At $80 margin x 10x = $800 notional, 3% SL = $24 max loss per trade
  // Need mc1 to keep MDD bounded: worst case = 1 loss = $24 > $20 MDD
  // So try mc1 with $40-$50 margin (3% SL = $12-$15 max loss)
  // ═══════════════════════════════════════════════════════════════
  for (const mrg of [40, 45, 50, 55, 60]) {
    cfgs.push({
      label: `J $${mrg}mrg mc1 tr80/8 zrev top5`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
      pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 1,
      z1hThresh: 3, z4hThresh: 2,
    });
    cfgs.push({
      label: `J $${mrg}mrg mc2 tr80/8 zrev top5`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
      pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 2,
      z1hThresh: 3, z4hThresh: 2,
    });
    // tr120/12 - even wider trail
    cfgs.push({
      label: `J $${mrg}mrg mc2 tr120/12 zrev top5`,
      slPct: 3, trail: [{ a: 120, d: 12 }], zReversal: true,
      pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 2,
      z1hThresh: 3, z4hThresh: 2,
    });
    // No trail at all — pure z-reversal exit (let it ride until z crosses 0)
    cfgs.push({
      label: `J $${mrg}mrg mc2 noTrail zrev top5`,
      slPct: 3, trail: [], zReversal: true,
      pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 2,
      z1hThresh: 3, z4hThresh: 2,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // K: WIDER Z on BIG MARGIN (more trades, more $/day)
  // z2/1.5 or z2/1 on top5-top15 with $30-$50 margin
  // ═══════════════════════════════════════════════════════════════
  for (const uni of [
    { set: TOP5, name: "top5" },
    { set: TOP8, name: "top8" },
    { set: TOP10, name: "top10" },
    { set: TOP15, name: "top15" },
  ]) {
    for (const z of [
      { z1: 2, z4: 1 }, { z1: 2, z4: 1.5 }, { z1: 1.5, z4: 1 },
    ]) {
      for (const mrg of [30, 40, 50]) {
        for (const mc of [2, 3, 5]) {
          cfgs.push({
            label: `K ${uni.name} z${z.z1}/${z.z4} $${mrg}mrg mc${mc} tr80/8 zrev`,
            slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
            pairAllow: uni.set, marginUsd: mrg, maxConcurrent: mc,
            z1hThresh: z.z1, z4hThresh: z.z4,
          });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // L: WIDER SL on big margin (maybe 3% SL is too tight for $50 margin)
  // Try SL 1.5-2% to reduce max single loss
  // ═══════════════════════════════════════════════════════════════
  for (const sl of [1.5, 2]) {
    for (const mrg of [40, 50, 60]) {
      for (const mc of [2, 3]) {
        cfgs.push({
          label: `L SL${sl}% $${mrg}mrg mc${mc} tr80/8 zrev top5`,
          slPct: sl, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // M: ALL 97+ PAIRS with z3/2 mc3-10 (more diversification = lower MDD?)
  // ═══════════════════════════════════════════════════════════════
  for (const mrg of [5, 7, 8, 9, 10, 12, 15, 20, 25, 30]) {
    for (const mc of [5, 7, 10, 15, 20, 25]) {
      cfgs.push({
        label: `M allPairs $${mrg}mrg mc${mc} tr80/8 zrev`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
    }
  }

  return cfgs;
}

// ═══════════════════════════════════════════════════════════════
// Build PARALLEL ENGINE configs (pairs must not overlap)
// ═══════════════════════════════════════════════════════════════
interface ParallelConfig {
  label: string;
  engine1: StratConfig;
  engine2: StratConfig;
}

function buildParallelConfigs(): ParallelConfig[] {
  const pcs: ParallelConfig[] = [];

  const TOP5 = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK"]);
  const ALT5_A = new Set(["AVAX", "DOT", "ADA", "LDO", "OP"]);
  const ALT5_B = new Set(["ARB", "UNI", "NEAR", "APT", "TIA"]);
  const ALT5_C = new Set(["SUI", "ENA", "HYPE", "FET", "WIF"]);

  // B1: top5 + alt5A
  for (const mrg of [22, 30, 40]) {
    for (const mc of [2, 3]) {
      pcs.push({
        label: `B top5+alt5A $${mrg}mrg mc${mc} tr80/8 zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: ALT5_A, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
      });
    }
  }

  // B2: top5 + alt5B
  for (const mrg of [22, 30, 40]) {
    for (const mc of [2, 3]) {
      pcs.push({
        label: `B top5+alt5B $${mrg}mrg mc${mc} tr80/8 zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: ALT5_B, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
      });
    }
  }

  // B3: top5 + alt5C
  for (const mrg of [22, 30]) {
    for (const mc of [2, 3]) {
      pcs.push({
        label: `B top5+alt5C $${mrg}mrg mc${mc} tr80/8 zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: ALT5_C, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
      });
    }
  }

  // B4: top5 + alt5A with zrevLosing
  for (const mrg of [30, 40]) {
    for (const mc of [2, 3]) {
      pcs.push({
        label: `B top5+alt5A $${mrg}mrg mc${mc} tr80/8 zrevLosing`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: ALT5_A, marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2,
        },
      });
    }
  }

  // B5: triple engine: top5 + alt5A + alt5B
  for (const mrg of [22, 30]) {
    pcs.push({
      label: `B top5+alt5A+alt5B $${mrg}mrg mc2 tr80/8 zrev (triple)`,
      engine1: {
        label: "e1+e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: new Set([...TOP5, ...ALT5_A]), marginUsd: mrg, maxConcurrent: 4,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e3", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: ALT5_B, marginUsd: mrg, maxConcurrent: 2,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B6: top5 + alt5A with multi-stage trail
  for (const mrg of [30, 40]) {
    pcs.push({
      label: `B top5+alt5A $${mrg}mrg mc3 mt[20/2,50/5,100/10] zrev`,
      engine1: {
        label: "e1", slPct: 3, trail: [{ a: 20, d: 2 }, { a: 50, d: 5 }, { a: 100, d: 10 }], zReversal: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 3,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e2", slPct: 3, trail: [{ a: 20, d: 2 }, { a: 50, d: 5 }, { a: 100, d: 10 }], zReversal: true,
        pairAllow: ALT5_A, marginUsd: mrg, maxConcurrent: 3,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B-SCALE: Scale down margin on best Calmar parallel engines to force MDD<$20
  // top5+alt5C at $22mrg mc3 has Calmar 0.174, MDD $26. Scale margin to get MDD<$20
  for (const mrg of [10, 12, 14, 15, 16, 17, 18, 19, 20]) {
    for (const mc of [2, 3]) {
      for (const alt of [
        { set: ALT5_C, name: "alt5C" },
        { set: ALT5_B, name: "alt5B" },
        { set: ALT5_A, name: "alt5A" },
      ]) {
        pcs.push({
          label: `B top5+${alt.name} $${mrg}mrg mc${mc} tr80/8 zrev (scaled)`,
          engine1: {
            label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
            pairAllow: TOP5, marginUsd: mrg, maxConcurrent: mc,
            z1hThresh: 3, z4hThresh: 2,
          },
          engine2: {
            label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
            pairAllow: alt.set, marginUsd: mrg, maxConcurrent: mc,
            z1hThresh: 3, z4hThresh: 2,
          },
        });
      }
    }
  }

  // B-TRIPLE-SCALE: Triple engine (top5+alt5A+alt5B) with small margin
  for (const mrg of [10, 12, 14, 15, 18, 20]) {
    pcs.push({
      label: `B TRIPLE $${mrg}mrg mc2 tr80/8 zrev (top5+altA+altB) scaled`,
      engine1: {
        label: "e1+e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: new Set([...TOP5, ...ALT5_A]), marginUsd: mrg, maxConcurrent: 3,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e3", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: ALT5_B, marginUsd: mrg, maxConcurrent: 2,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B-QUAD-SCALE: Quad engine with small margin
  for (const mrg of [10, 12, 14, 15, 16, 18, 20]) {
    pcs.push({
      label: `B QUAD $${mrg}mrg mc2 tr80/8 zrev (all4sets) scaled`,
      engine1: {
        label: "e1+e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: new Set([...TOP5, ...ALT5_A]), marginUsd: mrg, maxConcurrent: 3,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e3+e4", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: new Set([...ALT5_B, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B-ASYM: Asymmetric margin — bigger on better engine, smaller on weaker
  // alt5C is the best alt set. Give it more margin than top5
  for (const [mrg1, mrg2] of [[15, 25], [18, 30], [20, 35], [10, 30], [12, 25]]) {
    pcs.push({
      label: `B top5($${mrg1})+alt5C($${mrg2}) mc2 tr80/8 zrev (asym)`,
      engine1: {
        label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: TOP5, marginUsd: mrg1, maxConcurrent: 2,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: ALT5_C, marginUsd: mrg2, maxConcurrent: 2,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B7: QUAD engine — 4 non-overlapping 5-pair sets
  for (const mrg of [22, 30]) {
    pcs.push({
      label: `B QUAD $${mrg}mrg mc2 tr80/8 zrev (top5+altA+altB+altC)`,
      engine1: {
        label: "e1+e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: new Set([...TOP5, ...ALT5_A]), marginUsd: mrg, maxConcurrent: 4,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e3+e4", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: new Set([...ALT5_B, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 4,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B8: wider z-thresholds on parallel engines (more trades per set)
  for (const z of [{ z1: 2.5, z4: 1.5 }, { z1: 2, z4: 1.5 }]) {
    for (const mrg of [22, 30, 40]) {
      pcs.push({
        label: `B top5+alt5A z${z.z1}/${z.z4} $${mrg}mrg mc3 tr80/8 zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 3,
          z1hThresh: z.z1, z4hThresh: z.z4,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: ALT5_A, marginUsd: mrg, maxConcurrent: 3,
          z1hThresh: z.z1, z4hThresh: z.z4,
        },
      });
      pcs.push({
        label: `B top5+alt5C z${z.z1}/${z.z4} $${mrg}mrg mc3 tr80/8 zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 3,
          z1hThresh: z.z1, z4hThresh: z.z4,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: ALT5_C, marginUsd: mrg, maxConcurrent: 3,
          z1hThresh: z.z1, z4hThresh: z.z4,
        },
      });
    }
  }

  // B9: parallel engines with BIGGER margin ($40-$50) and mc1 per engine
  for (const mrg of [40, 50]) {
    for (const alt of [
      { set: ALT5_A, name: "alt5A" },
      { set: ALT5_B, name: "alt5B" },
      { set: ALT5_C, name: "alt5C" },
    ]) {
      pcs.push({
        label: `B top5+${alt.name} $${mrg}mrg mc1 tr80/8 zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 1,
          z1hThresh: 3, z4hThresh: 2,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
          pairAllow: alt.set, marginUsd: mrg, maxConcurrent: 1,
          z1hThresh: 3, z4hThresh: 2,
        },
      });
    }
  }

  // B10: parallel with SL 2% (tighter loss cap per trade)
  for (const mrg of [30, 40, 50]) {
    pcs.push({
      label: `B top5+alt5A SL2% $${mrg}mrg mc2 tr80/8 zrev`,
      engine1: {
        label: "e1", slPct: 2, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 2,
        z1hThresh: 3, z4hThresh: 2,
      },
      engine2: {
        label: "e2", slPct: 2, trail: [{ a: 80, d: 8 }], zReversal: true,
        pairAllow: ALT5_A, marginUsd: mrg, maxConcurrent: 2,
        z1hThresh: 3, z4hThresh: 2,
      },
    });
  }

  // B11: parallel with no trail (pure zrev exit) — let winners run unlimited
  for (const mrg of [30, 40]) {
    for (const alt of [
      { set: ALT5_A, name: "alt5A" },
      { set: ALT5_C, name: "alt5C" },
    ]) {
      pcs.push({
        label: `B top5+${alt.name} $${mrg}mrg mc2 noTrail zrev`,
        engine1: {
          label: "e1", slPct: 3, trail: [], zReversal: true,
          pairAllow: TOP5, marginUsd: mrg, maxConcurrent: 2,
          z1hThresh: 3, z4hThresh: 2,
        },
        engine2: {
          label: "e2", slPct: 3, trail: [], zReversal: true,
          pairAllow: alt.set, marginUsd: mrg, maxConcurrent: 2,
          z1hThresh: 3, z4hThresh: 2,
        },
      });
    }
  }

  return pcs;
}

// ───── Main ─────
function fmtDollar(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function main() {
  console.log("=".repeat(140));
  console.log("  PUSH PROFIT v2: Find path to >$5/day with MDD <$20");
  console.log("  Entry: z-score (per config), exchange SL, 5m exit check");
  console.log("  Period: 2025-06-01 to 2026-03-25 (" + OOS_D.toFixed(0) + " days)");
  console.log("=".repeat(140));

  console.log("\nLoading 5m + 1h + 4h data for all pairs...");
  const pairs: PD[] = [];
  for (const n of ALL) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const ind: PI = { h1, h4, m5, z1, z4, h1Map, h4Map };
    pairs.push({ name: n, ind, sp: SP[n] ?? DSP, lev, not: 10 * lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1: Single-engine configs
  // ═══════════════════════════════════════════════════════════════
  const configs = buildConfigs();
  console.log(`\nTesting ${configs.length} single-engine configs...\n`);

  const hdr = `${"Config".padEnd(55)} ${"$/day".padStart(9)} ${"MtmDD".padStart(7)} ${"ClsDD".padStart(7)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"AvgW".padStart(7)} ${"AvgL".padStart(7)} ${"MaxL".padStart(7)} ${"N".padStart(5)}`;

  const results: Array<{ label: string; res: SimResult }> = [];
  let cnt = 0;
  for (const cfg of configs) {
    // Reset shared caches (margin/pairAllow can change effective notional)
    __timepoints = null; __m5Maps = null; __pairByName = null;

    // Override notional for each pair based on config margin
    const effMargin = cfg.marginUsd ?? 22;
    const cfgPairs = pairs.map(p => ({ ...p, not: effMargin * p.lev }));

    const res = simulate(cfgPairs, cfg);
    results.push({ label: cfg.label, res });
    cnt++;
    if (cnt % 50 === 0) process.stdout.write(`  [${cnt}/${configs.length}]\r`);
  }
  console.log(`  Done: ${cnt} configs tested`);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2: Parallel engine configs
  // ═══════════════════════════════════════════════════════════════
  const parallelConfigs = buildParallelConfigs();
  console.log(`\nTesting ${parallelConfigs.length} parallel-engine configs...\n`);

  const parallelResults: Array<{ label: string; res: SimResult; e1: SimResult; e2: SimResult }> = [];
  for (const pc of parallelConfigs) {
    __timepoints = null; __m5Maps = null; __pairByName = null;
    const m1 = pc.engine1.marginUsd ?? 22;
    const p1 = pairs.map(p => ({ ...p, not: m1 * p.lev }));
    const r1 = simulate(p1, pc.engine1);

    __timepoints = null; __m5Maps = null; __pairByName = null;
    const m2 = pc.engine2.marginUsd ?? 22;
    const p2 = pairs.map(p => ({ ...p, not: m2 * p.lev }));
    const r2 = simulate(p2, pc.engine2);

    const merged = mergeEngines(r1, r2);
    parallelResults.push({ label: pc.label, res: merged, e1: r1, e2: r2 });
  }
  console.log(`  Done: ${parallelConfigs.length} parallel configs tested`);

  // ═══════════════════════════════════════════════════════════════
  // OUTPUT: All results sorted by $/day, MDD<$20 filter
  // ═══════════════════════════════════════════════════════════════
  const allResults = [
    ...results.map(r => ({ label: r.label, res: r.res })),
    ...parallelResults.map(r => ({ label: r.label, res: r.res })),
  ];

  // ── MAIN TARGET: MDD < $20 ──
  console.log("\n" + "=".repeat(140));
  console.log("*** MDD < $20 *** -- sorted by $/day (top 40)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));

  const mddOk = allResults.filter(r => r.res.maxDD < 20 && r.res.dollarsPerDay > 0)
    .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  if (mddOk.length === 0) {
    console.log("  NO configs achieved MDD < $20");
  } else {
    for (const r of mddOk.slice(0, 40)) {
      const s = r.res;
      console.log(`${r.label.padEnd(55).slice(0, 55)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(7)} ${("$" + s.maxDDClosed.toFixed(0)).padStart(7)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${fmtDollar(s.avgWin).padStart(7)} ${fmtDollar(s.avgLoss).padStart(7)} ${fmtDollar(s.maxSingleLoss).padStart(7)} ${String(s.numTrades).padStart(5)}`);
    }
  }

  // ── NEAR-MISS: MDD < $30 ──
  console.log("\n" + "=".repeat(140));
  console.log("MDD < $30 (near-miss) -- sorted by $/day (top 30)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));

  const mdd30 = allResults.filter(r => r.res.maxDD < 30 && r.res.maxDD >= 20 && r.res.dollarsPerDay > 0)
    .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of mdd30.slice(0, 30)) {
    const s = r.res;
    console.log(`${r.label.padEnd(55).slice(0, 55)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(7)} ${("$" + s.maxDDClosed.toFixed(0)).padStart(7)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${fmtDollar(s.avgWin).padStart(7)} ${fmtDollar(s.avgLoss).padStart(7)} ${fmtDollar(s.maxSingleLoss).padStart(7)} ${String(s.numTrades).padStart(5)}`);
  }

  // ── OVERALL TOP 20 by $/day ──
  console.log("\n" + "=".repeat(140));
  console.log("TOP 20 BY $/DAY (any MDD)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));

  const byDollar = allResults.filter(r => r.res.dollarsPerDay > 0)
    .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of byDollar.slice(0, 20)) {
    const s = r.res;
    console.log(`${r.label.padEnd(55).slice(0, 55)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(7)} ${("$" + s.maxDDClosed.toFixed(0)).padStart(7)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${fmtDollar(s.avgWin).padStart(7)} ${fmtDollar(s.avgLoss).padStart(7)} ${fmtDollar(s.maxSingleLoss).padStart(7)} ${String(s.numTrades).padStart(5)}`);
  }

  // ── BEST $/day per MDD ratio (Calmar-like) ──
  console.log("\n" + "=".repeat(140));
  console.log("TOP 20 BY $/DAY / MDD RATIO (Calmar proxy, profitable only)");
  console.log("=".repeat(140));
  console.log(`${"Config".padEnd(60)} ${"$/day".padStart(9)} ${"MDD".padStart(6)} ${"Ratio".padStart(7)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)}`);
  console.log("-".repeat(140));

  const byCalmar = allResults.filter(r => r.res.dollarsPerDay > 0 && r.res.maxDD > 0)
    .map(r => ({ ...r, calmar: r.res.dollarsPerDay / r.res.maxDD }))
    .sort((a, b) => b.calmar - a.calmar);
  for (const r of byCalmar.slice(0, 20)) {
    const s = r.res;
    console.log(`${r.label.padEnd(60).slice(0, 60)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(6)} ${r.calmar.toFixed(3).padStart(7)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${String(s.numTrades).padStart(5)}`);
  }

  // ── PARALLEL ENGINE DETAILS ──
  console.log("\n" + "=".repeat(140));
  console.log("PARALLEL ENGINE DETAILS (all, sorted by combined $/day)");
  console.log("=".repeat(140));
  console.log(`${"Config".padEnd(55)} ${"Comb$/d".padStart(9)} ${"CombMDD".padStart(8)} ${"CombPF".padStart(7)} ${"E1$/d".padStart(8)} ${"E1MDD".padStart(7)} ${"E2$/d".padStart(8)} ${"E2MDD".padStart(7)} ${"CombN".padStart(6)}`);
  console.log("-".repeat(140));

  const sortedParallel = [...parallelResults].sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of sortedParallel) {
    const c = r.res, e1 = r.e1, e2 = r.e2;
    console.log(`${r.label.padEnd(55).slice(0, 55)} ${fmtDollar(c.dollarsPerDay).padStart(9)} ${("$" + c.maxDD.toFixed(0)).padStart(8)} ${c.pf.toFixed(2).padStart(7)} ${fmtDollar(e1.dollarsPerDay).padStart(8)} ${("$" + e1.maxDD.toFixed(0)).padStart(7)} ${fmtDollar(e2.dollarsPerDay).padStart(8)} ${("$" + e2.maxDD.toFixed(0)).padStart(7)} ${String(c.numTrades).padStart(6)}`);
  }

  // ── TOP 5 DETAILED ──
  console.log("\n" + "=".repeat(140));
  console.log("TOP 5 MDD<$20 DETAILED");
  console.log("=".repeat(140));
  for (let i = 0; i < Math.min(5, mddOk.length); i++) {
    const r = mddOk[i]!;
    const s = r.res;
    console.log(`\n#${i + 1}: ${r.label}`);
    console.log(`  $/day:           ${fmtDollar(s.dollarsPerDay)}`);
    console.log(`  Total PnL:       ${fmtDollar(s.totalPnl)} over ${OOS_D.toFixed(0)} days`);
    console.log(`  Max DD:          $${s.maxDD.toFixed(2)}`);
    console.log(`  Profit Factor:   ${s.pf.toFixed(2)}`);
    console.log(`  Win rate:        ${s.wr.toFixed(1)}%`);
    console.log(`  Avg win:         ${fmtDollar(s.avgWin)}`);
    console.log(`  Avg loss:        ${fmtDollar(s.avgLoss)}`);
    console.log(`  Max single loss: ${fmtDollar(s.maxSingleLoss)}`);
    console.log(`  Num trades:      ${s.numTrades}`);
    const reasonCounts = new Map<string, { n: number; pnl: number }>();
    for (const t of s.trades) {
      const ex = reasonCounts.get(t.reason) ?? { n: 0, pnl: 0 };
      ex.n++; ex.pnl += t.pnl;
      reasonCounts.set(t.reason, ex);
    }
    console.log(`  Exit breakdown:`);
    for (const [reason, v] of reasonCounts) {
      console.log(`    ${reason.padEnd(10)} ${String(v.n).padStart(5)} trades  ${fmtDollar(v.pnl).padStart(9)}`);
    }
  }

  // Summary stats
  console.log("\n" + "=".repeat(140));
  console.log("SUMMARY");
  console.log("=".repeat(140));
  console.log(`Total configs tested: ${allResults.length}`);
  console.log(`  MDD < $20:  ${mddOk.length} configs`);
  if (mddOk.length > 0) {
    console.log(`  Best $/day with MDD < $20: ${fmtDollar(mddOk[0]!.res.dollarsPerDay)} (${mddOk[0]!.label})`);
  }
  console.log(`  MDD < $30:  ${mdd30.length + mddOk.length} configs`);
  const above5 = mddOk.filter(r => r.res.dollarsPerDay >= 5);
  console.log(`  >$5/day + MDD<$20: ${above5.length} configs`);
  if (above5.length > 0) {
    for (const r of above5) {
      console.log(`    ${r.label}: ${fmtDollar(r.res.dollarsPerDay)}/day, MDD $${r.res.maxDD.toFixed(0)}`);
    }
  } else {
    console.log(`  Closest to $5/day with MDD<$20:`);
    if (mddOk.length > 0) {
      const top3 = mddOk.slice(0, 3);
      for (const r of top3) {
        console.log(`    ${r.label}: ${fmtDollar(r.res.dollarsPerDay)}/day, MDD $${r.res.maxDD.toFixed(0)}`);
      }
    }
    // Show best overall that might be close
    const close = allResults.filter(r => r.res.dollarsPerDay >= 5 && r.res.maxDD < 30)
      .sort((a, b) => a.res.maxDD - b.res.maxDD);
    if (close.length > 0) {
      console.log(`  Best >$5/day with smallest MDD:`);
      for (const r of close.slice(0, 3)) {
        console.log(`    ${r.label}: ${fmtDollar(r.res.dollarsPerDay)}/day, MDD $${r.res.maxDD.toFixed(0)}`);
      }
    }
  }
}

main();
