/**
 * PUSH PROFIT v3: Explore untested angles for >$5/day
 *
 * New features (NOT in v2):
 *   1. Asymmetric z-thresholds (different z for longs vs shorts)
 *   2. Per-pair z-threshold optimization
 *   3. Time-of-day filter (session windows)
 *   4. ATR regime filter (high/low vol gating)
 *   5. Staggered entries (50%+50% on confirmation)
 *   6. Hybrid exit (zrev for losers, trail-only for winners)
 *   7. Dynamic margin based on z-strength
 *   8. Weekend filter (weekday-only entries)
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-push-v3.ts
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

// Spread per pair
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
  atr1: number[]; // ATR(14) on 1h bars
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

function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 2) return out;
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const hh = cs[i]!.h, ll = cs[i]!.l, pc = cs[i - 1]!.c;
    tr[i] = Math.max(hh - ll, Math.abs(hh - pc), Math.abs(ll - pc));
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

function get1hZNow(ind: PI, t: number): number {
  let lo = 0, hi = ind.h1.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ind.h1[m]!.t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? ind.z1[best]! : 0;
}

// Get ATR as % of price at given 1h index
function getAtrPct(ind: PI, h1Idx: number): number {
  if (h1Idx < 14 || h1Idx >= ind.atr1.length) return 0;
  const atrVal = ind.atr1[h1Idx]!;
  const price = ind.h1[h1Idx]!.c;
  if (price === 0) return 0;
  return (atrVal / price) * 100;
}

// Rolling median of ATR% over last N bars (for regime detection)
function getAtrMedian(ind: PI, h1Idx: number, window = 50): number {
  if (h1Idx < window + 14) return 0;
  const vals: number[] = [];
  for (let j = h1Idx - window; j < h1Idx; j++) {
    const v = ind.atr1[j]!;
    const p = ind.h1[j]!.c;
    if (v > 0 && p > 0) vals.push(v / p * 100);
  }
  if (vals.length < window / 4) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]!;
}

// ───── Strategy Config (v3 extended) ─────
interface TrailStep { a: number; d: number; }
interface StratConfig {
  label: string;
  slPct: number;
  trail: TrailStep[];
  zReversal?: boolean;
  zReversalOnlyLosing?: boolean;
  hybridExit?: boolean;           // NEW: zrev for losers, trail-only for winners
  maxConcurrent?: number;
  z1hThresh?: number;
  z4hThresh?: number;
  // NEW: asymmetric z
  z1hLong?: number;
  z4hLong?: number;
  z1hShort?: number;
  z4hShort?: number;
  marginUsd?: number;
  longOnly?: boolean;
  pairAllow?: Set<string>;
  maxHoldH?: number;
  // NEW: per-pair z overrides
  perPairZ?: Map<string, { z1Long: number; z4Long: number; z1Short: number; z4Short: number }>;
  // NEW: session filter (UTC hours allowed)
  sessionHours?: Set<number>;
  // NEW: ATR regime filter
  atrRegime?: "high" | "low";   // only enter when ATR is above/below median
  atrMultThresh?: number;        // ATR% must be > atrMult * median for "high", < for "low"
  // NEW: staggered entries
  staggeredEntry?: boolean;      // 50% on first signal, 50% on next bar if still valid
  // NEW: dynamic margin
  dynamicMargin?: boolean;       // margin scales with z-strength
  dynamicMarginMap?: Array<{ minZ: number; margin: number }>;
  // NEW: weekend filter
  weekdayOnly?: boolean;
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
  isStagger2?: boolean; // true if this is 2nd half of staggered entry
}

interface SimResult {
  trades: Tr[];
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  avgWin: number;
  avgLoss: number;
  maxSingleLoss: number;
  numTrades: number;
}

// Pending staggered entries
interface PendingStagger {
  pair: string;
  dir: "long" | "short";
  ts: number;
  z1: number;
  halfNot: number;
  sp: number;
  lev: number;
  slPct: number;
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
  const pendingStagger: PendingStagger[] = [];

  prepareShared(pairs);
  const timepoints = __timepoints!;
  const m5Maps = __m5Maps!;
  const pairByName = __pairByName!;

  // Resolve z-thresholds (support asymmetric)
  const Z_LONG_1H = cfg.z1hLong ?? cfg.z1hThresh ?? 3.0;
  const Z_LONG_4H = cfg.z4hLong ?? cfg.z4hThresh ?? 2.0;
  const Z_SHORT_1H = -(cfg.z1hShort ?? cfg.z1hThresh ?? 3.0);
  const Z_SHORT_4H = -(cfg.z4hShort ?? cfg.z4hThresh ?? 2.0);
  const BASE_MARGIN = cfg.marginUsd ?? 22;

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

      // 3) Multi-stage trailing stop (leveraged %)
      if (!xp && cfg.trail.length > 0) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        let td = Infinity;
        for (const s of cfg.trail) if (pos.pk >= s.a) td = s.d;
        if (td < Infinity && cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
      }

      // 4) Z-reversal exit logic
      if (!xp && isH1Boundary) {
        // Hybrid exit: zrev ONLY for losers, winners use trail exclusively
        if (cfg.hybridExit) {
          const curLev = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * pos.lev * 100
            : (pos.ep / bar.c - 1) * pos.lev * 100;
          if (curLev < 0) {
            // Position is losing -- apply z-reversal
            const zNow = get1hZNow(pd.ind, ts);
            const reversed = (pos.dir === "long" && pos.entryZ1 > 0 && zNow < 0) ||
                             (pos.dir === "short" && pos.entryZ1 < 0 && zNow > 0);
            if (reversed) { xp = bar.c; reason = "hzrev"; }
          }
          // Winners: no z-reversal at all, trail decides
        } else {
          const doZrev = cfg.zReversal || cfg.zReversalOnlyLosing;
          if (doZrev) {
            const zNow = get1hZNow(pd.ind, ts);
            const reversed = (pos.dir === "long" && pos.entryZ1 > 0 && zNow < 0) ||
                             (pos.dir === "short" && pos.entryZ1 < 0 && zNow > 0);
            if (reversed) {
              if (cfg.zReversalOnlyLosing) {
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
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * 1.5 : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: ts, pnl, reason, peakPnlPct: pos.pk });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    // ─── ENTRY on 1h boundaries ───
    if (!isH1Boundary) continue;
    if (BLOCK_HOURS.has(hourOfDay)) continue;

    // Weekend filter: skip Saturday (6) and Sunday (0)
    if (cfg.weekdayOnly) {
      const dow = new Date(ts).getUTCDay();
      if (dow === 0 || dow === 6) continue;
    }

    // Session filter: only enter during specified hours
    if (cfg.sessionHours && !cfg.sessionHours.has(hourOfDay)) continue;

    if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) continue;

    // Process pending stagger entries (2nd half)
    if (cfg.staggeredEntry) {
      for (let si = pendingStagger.length - 1; si >= 0; si--) {
        const ps = pendingStagger[si]!;
        if (ts - ps.ts < H) continue; // Wait at least 1h
        if (ts - ps.ts > 2 * H) { pendingStagger.splice(si, 1); continue; } // Expired
        if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) break;

        const pd = pairByName.get(ps.pair);
        if (!pd) { pendingStagger.splice(si, 1); continue; }
        const h1Idx = pd.ind.h1Map.get(ts);
        if (h1Idx === undefined || h1Idx < VOL_WIN + 2) { pendingStagger.splice(si, 1); continue; }

        // Check z-score is still valid
        const z1 = pd.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(pd.ind.z4, pd.ind.h4, pd.ind.h4Map, ts);
        let valid = false;
        if (ps.dir === "long" && z1 > Z_LONG_1H && z4 > Z_LONG_4H) valid = true;
        if (ps.dir === "short" && z1 < Z_SHORT_1H && z4 < Z_SHORT_4H) valid = true;

        if (valid) {
          const ep = ps.dir === "long"
            ? pd.ind.h1[h1Idx]!.o * (1 + ps.sp)
            : pd.ind.h1[h1Idx]!.o * (1 - ps.sp);
          const dist = ep * (ps.slPct / 100);
          const slPrice = ps.dir === "long" ? ep - dist : ep + dist;
          openPositions.push({
            pair: ps.pair, dir: ps.dir, ep, et: ts, sl: slPrice, pk: 0,
            sp: ps.sp, lev: ps.lev, not: ps.halfNot,
            entryZ1: z1, isStagger2: true,
          });
        }
        pendingStagger.splice(si, 1);
      }
    }

    for (const p of pairs) {
      if (cfg.maxConcurrent !== undefined && openPositions.length >= cfg.maxConcurrent) break;
      if (cfg.pairAllow && !cfg.pairAllow.has(p.name)) continue;
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      // For staggered: allow second position with isStagger2
      if (!cfg.staggeredEntry && openPositions.some(o => o.pair === p.name)) continue;
      if (cfg.staggeredEntry && openPositions.filter(o => o.pair === p.name).length >= 2) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      // Resolve per-pair z thresholds
      let z1LongEff = Z_LONG_1H, z4LongEff = Z_LONG_4H;
      let z1ShortEff = Z_SHORT_1H, z4ShortEff = Z_SHORT_4H;
      if (cfg.perPairZ) {
        const ppz = cfg.perPairZ.get(p.name);
        if (ppz) {
          z1LongEff = ppz.z1Long;
          z4LongEff = ppz.z4Long;
          z1ShortEff = -ppz.z1Short;
          z4ShortEff = -ppz.z4Short;
        }
      }

      let dir: "long" | "short" | null = null;
      if (z1 > z1LongEff && z4 > z4LongEff) dir = "long";
      if (z1 < z1ShortEff && z4 < z4ShortEff) dir = "short";
      if (!dir) continue;
      if (cfg.longOnly && dir !== "long") continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      // Skip if already have position in same pair (non-staggered)
      if (openPositions.some(o => o.pair === p.name && o.dir === dir && !cfg.staggeredEntry)) continue;
      if (cfg.staggeredEntry && openPositions.some(o => o.pair === p.name)) continue;

      // ATR regime filter
      if (cfg.atrRegime) {
        const atrPct = getAtrPct(p.ind, h1Idx);
        const atrMed = getAtrMedian(p.ind, h1Idx);
        const mult = cfg.atrMultThresh ?? 1.0;
        if (atrPct === 0 || atrMed === 0) continue;
        if (cfg.atrRegime === "high" && atrPct < atrMed * mult) continue;
        if (cfg.atrRegime === "low" && atrPct > atrMed * mult) continue;
      }

      // Compute margin
      let effMargin = BASE_MARGIN;
      if (cfg.dynamicMargin && cfg.dynamicMarginMap) {
        const absZ = Math.abs(z1);
        // Find highest matching tier
        let bestMargin = BASE_MARGIN;
        for (const tier of cfg.dynamicMarginMap) {
          if (absZ >= tier.minZ) bestMargin = tier.margin;
        }
        effMargin = bestMargin;
      }

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const dist = ep * (cfg.slPct / 100);
      const slPrice = dir === "long" ? ep - dist : ep + dist;

      if (cfg.staggeredEntry) {
        // Enter 50% now, queue 50% for confirmation
        const halfNot = (effMargin * p.lev) / 2;
        openPositions.push({
          pair: p.name, dir, ep, et: ts, sl: slPrice, pk: 0,
          sp: p.sp, lev: p.lev, not: halfNot,
          entryZ1: z1,
        });
        pendingStagger.push({
          pair: p.name, dir, ts, z1, halfNot, sp: p.sp, lev: p.lev, slPct: cfg.slPct,
        });
      } else {
        const effNot = effMargin * p.lev;
        openPositions.push({
          pair: p.name, dir, ep, et: ts, sl: slPrice, pk: 0,
          sp: p.sp, lev: p.lev, not: effNot,
          entryZ1: z1,
        });
      }
    }
  }

  // Close remaining at end
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: lb.t, pnl, reason: "end", peakPnlPct: pos.pk });
  }

  return computeStats(closed);
}

function computeStats(closed: Tr[]): SimResult {
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
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  let maxSingleLoss = 0;
  for (const t of losses) if (t.pnl < maxSingleLoss) maxSingleLoss = t.pnl;

  return {
    trades: closed, totalPnl, dollarsPerDay: totalPnl / OOS_D,
    maxDD, pf, wr, avgWin, avgLoss, maxSingleLoss, numTrades: closed.length,
  };
}

function mergeEngines(r1: SimResult, r2: SimResult): SimResult {
  return computeStats([...r1.trades, ...r2.trades]);
}

// ───── Config Builders ─────
const TOP5 = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK"]);
const ALT5_C = new Set(["SUI", "ENA", "HYPE", "FET", "WIF"]);
const TOP10 = new Set(["ETH", "SOL", "DOGE", "XRP", "LINK", "AVAX", "DOT", "ADA", "LDO", "OP"]);
const TOP15 = new Set([...TOP10, "ARB", "UNI", "NEAR", "APT", "SUI"]);

function buildConfigs(): StratConfig[] {
  const cfgs: StratConfig[] = [];

  // ==============================================================
  // BASELINE: reproduce known best
  // ==============================================================
  cfgs.push({
    label: `BL top5+alt5C $16mrg mc3 tr80/8 SL3% zrevLos`,
    slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
    pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: 16, maxConcurrent: 3,
    z1hThresh: 3, z4hThresh: 2,
  });
  cfgs.push({
    label: `BL top5+alt5C $22mrg mc3 tr80/8 SL3% zrev`,
    slPct: 3, trail: [{ a: 80, d: 8 }], zReversal: true,
    pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: 22, maxConcurrent: 3,
    z1hThresh: 3, z4hThresh: 2,
  });

  // ==============================================================
  // 1. ASYMMETRIC Z: longs may need different z than shorts
  // ==============================================================
  const asymZCombos = [
    { lz1: 2.5, lz4: 1.5, sz1: 3.5, sz4: 2.5 },  // easier longs, harder shorts
    { lz1: 3.0, lz4: 2.0, sz1: 3.5, sz4: 2.5 },  // same longs, harder shorts
    { lz1: 2.5, lz4: 2.0, sz1: 3.0, sz4: 2.0 },  // easier longs, same shorts
    { lz1: 2.0, lz4: 1.5, sz1: 3.0, sz4: 2.0 },  // much easier longs, same shorts
    { lz1: 3.0, lz4: 2.0, sz1: 4.0, sz4: 3.0 },  // same longs, very hard shorts
    { lz1: 2.5, lz4: 1.5, sz1: 4.0, sz4: 2.5 },  // easier longs, very hard shorts
    { lz1: 3.5, lz4: 2.5, sz1: 2.5, sz4: 1.5 },  // harder longs, easier shorts
    { lz1: 2.0, lz4: 1.0, sz1: 3.5, sz4: 2.0 },  // very easy longs, harder shorts
  ];
  for (const az of asymZCombos) {
    for (const mrg of [16, 22, 30]) {
      for (const mc of [3, 5]) {
        cfgs.push({
          label: `1-ASYM L${az.lz1}/${az.lz4} S${az.sz1}/${az.sz4} $${mrg}m mc${mc} zrevL`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
          z1hLong: az.lz1, z4hLong: az.lz4, z1hShort: az.sz1, z4hShort: az.sz4,
        });
      }
    }
  }
  // Also with hybrid exit on best combos
  for (const az of asymZCombos.slice(0, 4)) {
    for (const mrg of [22, 30]) {
      cfgs.push({
        label: `1-ASYM L${az.lz1}/${az.lz4} S${az.sz1}/${az.sz4} $${mrg}m mc3 hybrid`,
        slPct: 3, trail: [{ a: 80, d: 8 }], hybridExit: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
        z1hLong: az.lz1, z4hLong: az.lz4, z1hShort: az.sz1, z4hShort: az.sz4,
      });
    }
  }

  // ==============================================================
  // 2. PER-PAIR Z: stronger pairs get easier thresholds
  // ETH/SOL = high vol, good z signals -> z2.5/1.5
  // DOGE/WIF = meme coins, more noise -> z3.5/2.5
  // Others = default z3/2
  // ==============================================================
  const perPairProfiles: Array<{ label: string; map: Map<string, { z1Long: number; z4Long: number; z1Short: number; z4Short: number }> }> = [
    {
      label: "pp-A", // ETH/SOL easy, memes hard
      map: new Map([
        ["ETH", { z1Long: 2.5, z4Long: 1.5, z1Short: 2.5, z4Short: 1.5 }],
        ["SOL", { z1Long: 2.5, z4Long: 1.5, z1Short: 2.5, z4Short: 1.5 }],
        ["XRP", { z1Long: 3.0, z4Long: 2.0, z1Short: 3.0, z4Short: 2.0 }],
        ["LINK", { z1Long: 3.0, z4Long: 2.0, z1Short: 3.0, z4Short: 2.0 }],
        ["DOGE", { z1Long: 3.5, z4Long: 2.5, z1Short: 3.5, z4Short: 2.5 }],
        ["WIF", { z1Long: 3.5, z4Long: 2.5, z1Short: 3.5, z4Short: 2.5 }],
        ["SUI", { z1Long: 2.5, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["ENA", { z1Long: 3.0, z4Long: 2.0, z1Short: 3.0, z4Short: 2.0 }],
        ["HYPE", { z1Long: 2.5, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["FET", { z1Long: 3.0, z4Long: 2.0, z1Short: 3.0, z4Short: 2.0 }],
      ]),
    },
    {
      label: "pp-B", // All easier longs, standard shorts
      map: new Map([
        ["ETH", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["SOL", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["XRP", { z1Long: 2.5, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["LINK", { z1Long: 2.5, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["DOGE", { z1Long: 2.5, z4Long: 2.0, z1Short: 3.5, z4Short: 2.5 }],
        ["WIF", { z1Long: 3.0, z4Long: 2.0, z1Short: 3.5, z4Short: 2.5 }],
        ["SUI", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["ENA", { z1Long: 2.5, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["HYPE", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
        ["FET", { z1Long: 2.5, z4Long: 1.5, z1Short: 3.0, z4Short: 2.0 }],
      ]),
    },
    {
      label: "pp-C", // Aggressive: all z2/1.5 longs, z3.5/2.5 shorts
      map: new Map([
        ["ETH", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["SOL", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["XRP", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["LINK", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["DOGE", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["WIF", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["SUI", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["ENA", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["HYPE", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
        ["FET", { z1Long: 2.0, z4Long: 1.5, z1Short: 3.5, z4Short: 2.5 }],
      ]),
    },
  ];
  for (const pp of perPairProfiles) {
    for (const mrg of [16, 22, 30]) {
      for (const mc of [3, 5]) {
        cfgs.push({
          label: `2-PP ${pp.label} $${mrg}m mc${mc} tr80/8 zrevL`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2, perPairZ: pp.map,
        });
      }
    }
  }

  // ==============================================================
  // 3. TIME-OF-DAY FILTER: session windows
  // ==============================================================
  const sessions: Array<{ label: string; hours: Set<number> }> = [
    { label: "asia(0-8)", hours: new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]) },
    { label: "eu(8-16)", hours: new Set([8, 9, 10, 11, 12, 13, 14, 15, 16]) },
    { label: "us(14-21)", hours: new Set([14, 15, 16, 17, 18, 19, 20, 21]) },
    { label: "noUS(0-14)", hours: new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) },
    { label: "night(0-6,18-21)", hours: new Set([0, 1, 2, 3, 4, 5, 6, 18, 19, 20, 21]) },
    { label: "active(6-21)", hours: new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) },
  ];
  for (const sess of sessions) {
    for (const mrg of [16, 22, 30]) {
      for (const mc of [3, 5]) {
        cfgs.push({
          label: `3-TOD ${sess.label} $${mrg}m mc${mc} tr80/8 zrevL`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
          z1hThresh: 3, z4hThresh: 2, sessionHours: sess.hours,
        });
      }
    }
  }

  // ==============================================================
  // 4. ATR REGIME FILTER: only enter in high/low vol
  // ==============================================================
  for (const regime of ["high", "low"] as const) {
    for (const mult of [0.8, 1.0, 1.2, 1.5]) {
      for (const mrg of [16, 22, 30]) {
        for (const mc of [3, 5]) {
          cfgs.push({
            label: `4-ATR ${regime}${mult}x $${mrg}m mc${mc} tr80/8 zrevL`,
            slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
            pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
            z1hThresh: 3, z4hThresh: 2,
            atrRegime: regime, atrMultThresh: mult,
          });
        }
      }
    }
  }
  // ATR + asymmetric z (combo of two new features)
  for (const regime of ["high"] as const) {
    for (const mult of [1.0, 1.2]) {
      for (const mrg of [22, 30]) {
        cfgs.push({
          label: `4-ATR+ASYM ${regime}${mult}x L2.5/1.5 S3.5/2.5 $${mrg}m mc3`,
          slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
          pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
          z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
          atrRegime: regime, atrMultThresh: mult,
        });
      }
    }
  }

  // ==============================================================
  // 5. STAGGERED ENTRIES: 50%+50% on confirmation
  // ==============================================================
  for (const mrg of [22, 30, 40]) {
    for (const mc of [3, 5]) {
      cfgs.push({
        label: `5-STAGGER $${mrg}m mc${mc} tr80/8 zrevL`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2, staggeredEntry: true,
      });
    }
  }
  // Staggered + asymmetric z
  for (const mrg of [22, 30]) {
    cfgs.push({
      label: `5-STAGGER+ASYM L2.5/1.5 S3.5/2.5 $${mrg}m mc3`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
      staggeredEntry: true,
    });
  }

  // ==============================================================
  // 6. HYBRID EXIT: zrev for losers, trail-only for winners
  // (different from "zReversalOnlyLosing" -- hybrid means winners
  //  are NEVER touched by zrev, only trail decides)
  // The difference: zReversalOnlyLosing = "check zrev condition AND
  //  position must be losing". Hybrid = winners skip zrev entirely,
  //  losers get zrev regardless of z-reversal condition check.
  // Actually upon closer inspection these are the same. But let's
  // test hybrid with different trail configurations.
  // ==============================================================
  for (const mrg of [16, 22, 30]) {
    for (const mc of [3, 5]) {
      // Hybrid with tighter trail (let winners compound less)
      cfgs.push({
        label: `6-HYBRID $${mrg}m mc${mc} tr50/5 hybrid`,
        slPct: 3, trail: [{ a: 50, d: 5 }], hybridExit: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
      // Hybrid with wider trail
      cfgs.push({
        label: `6-HYBRID $${mrg}m mc${mc} tr80/8 hybrid`,
        slPct: 3, trail: [{ a: 80, d: 8 }], hybridExit: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
      // Hybrid with multi-stage trail
      cfgs.push({
        label: `6-HYBRID $${mrg}m mc${mc} mt[20/2,50/5,100/10] hybrid`,
        slPct: 3, trail: [{ a: 20, d: 2 }, { a: 50, d: 5 }, { a: 100, d: 10 }], hybridExit: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
      });
    }
  }

  // ==============================================================
  // 7. DYNAMIC MARGIN: bigger margin for higher z-strength
  // ==============================================================
  const dynamicMaps: Array<{ label: string; tiers: Array<{ minZ: number; margin: number }> }> = [
    { label: "dm-A", tiers: [{ minZ: 3, margin: 15 }, { minZ: 4, margin: 25 }, { minZ: 5, margin: 40 }] },
    { label: "dm-B", tiers: [{ minZ: 3, margin: 10 }, { minZ: 3.5, margin: 20 }, { minZ: 4, margin: 30 }, { minZ: 5, margin: 50 }] },
    { label: "dm-C", tiers: [{ minZ: 2.5, margin: 12 }, { minZ: 3, margin: 20 }, { minZ: 4, margin: 35 }] },
    { label: "dm-D", tiers: [{ minZ: 3, margin: 20 }, { minZ: 4, margin: 40 }, { minZ: 5, margin: 60 }] },
    { label: "dm-E", tiers: [{ minZ: 2.5, margin: 8 }, { minZ: 3, margin: 16 }, { minZ: 3.5, margin: 25 }, { minZ: 4, margin: 35 }, { minZ: 5, margin: 50 }] },
  ];
  for (const dm of dynamicMaps) {
    for (const mc of [3, 5]) {
      cfgs.push({
        label: `7-DYN ${dm.label} mc${mc} tr80/8 zrevL`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
        dynamicMargin: true, dynamicMarginMap: dm.tiers,
      });
      // Also with lower z threshold to catch more trades
      cfgs.push({
        label: `7-DYN ${dm.label} z2.5/1.5 mc${mc} tr80/8 zrevL`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), maxConcurrent: mc,
        z1hThresh: 2.5, z4hThresh: 1.5,
        dynamicMargin: true, dynamicMarginMap: dm.tiers,
      });
    }
  }

  // ==============================================================
  // 8. WEEKEND FILTER: weekday-only entries
  // ==============================================================
  for (const mrg of [16, 22, 30, 40]) {
    for (const mc of [3, 5]) {
      cfgs.push({
        label: `8-WKDAY $${mrg}m mc${mc} tr80/8 zrevL`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2, weekdayOnly: true,
      });
    }
  }
  // Weekend + asymmetric z
  for (const mrg of [22, 30]) {
    cfgs.push({
      label: `8-WKDAY+ASYM L2.5/1.5 S3.5/2.5 $${mrg}m mc3`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
      weekdayOnly: true,
    });
  }

  // ==============================================================
  // COMBO: Best-of combinations across multiple features
  // ==============================================================
  // ATR high + asymmetric z + weekend filter
  for (const mrg of [22, 30]) {
    cfgs.push({
      label: `X-COMBO atrHi+asymZ+wkday $${mrg}m mc3`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
      atrRegime: "high", atrMultThresh: 1.0,
      weekdayOnly: true,
    });
    cfgs.push({
      label: `X-COMBO atrHi+asymZ+wkday $${mrg}m mc5`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 5,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
      atrRegime: "high", atrMultThresh: 1.0,
      weekdayOnly: true,
    });
  }

  // Dynamic margin + ATR high + asymmetric z
  for (const dm of dynamicMaps.slice(0, 3)) {
    cfgs.push({
      label: `X-COMBO ${dm.label}+atrHi+asymZ mc3`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: new Set([...TOP5, ...ALT5_C]), maxConcurrent: 3,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
      atrRegime: "high", atrMultThresh: 1.0,
      dynamicMargin: true, dynamicMarginMap: dm.tiers,
    });
  }

  // Session + asymmetric z (Asia session where crypto is quieter for mean-rev)
  for (const sess of sessions.slice(0, 3)) {
    for (const mrg of [22, 30]) {
      cfgs.push({
        label: `X-COMBO ${sess.label}+asymZ $${mrg}m mc3`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
        z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
        sessionHours: sess.hours,
      });
    }
  }

  // Per-pair z + ATR high
  for (const pp of perPairProfiles.slice(0, 2)) {
    for (const mrg of [22, 30]) {
      cfgs.push({
        label: `X-COMBO ${pp.label}+atrHi $${mrg}m mc3`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        pairAllow: new Set([...TOP5, ...ALT5_C]), marginUsd: mrg, maxConcurrent: 3,
        z1hThresh: 3, z4hThresh: 2, perPairZ: pp.map,
        atrRegime: "high", atrMultThresh: 1.0,
      });
    }
  }

  // ==============================================================
  // WIDER PAIR SETS with new features
  // ==============================================================
  for (const uni of [
    { set: TOP10, name: "top10" },
    { set: TOP15, name: "top15" },
  ]) {
    // Asymmetric z on wider sets
    cfgs.push({
      label: `W-ASYM ${uni.name} L2.5/1.5 S3.5/2.5 $22m mc5 zrevL`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: uni.set, marginUsd: 22, maxConcurrent: 5,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
    });
    cfgs.push({
      label: `W-ASYM ${uni.name} L2.5/1.5 S3.5/2.5 $30m mc5 zrevL`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: uni.set, marginUsd: 30, maxConcurrent: 5,
      z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
    });
    // Dynamic margin on wider sets
    cfgs.push({
      label: `W-DYN ${uni.name} dm-A mc5 zrevL`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: uni.set, maxConcurrent: 5,
      z1hThresh: 3, z4hThresh: 2,
      dynamicMargin: true, dynamicMarginMap: dynamicMaps[0]!.tiers,
    });
    // ATR high on wider sets
    cfgs.push({
      label: `W-ATR ${uni.name} atrHi1.0x $22m mc5 zrevL`,
      slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
      pairAllow: uni.set, marginUsd: 22, maxConcurrent: 5,
      z1hThresh: 3, z4hThresh: 2,
      atrRegime: "high", atrMultThresh: 1.0,
    });
  }

  // ==============================================================
  // ALL 127 PAIRS with new features
  // ==============================================================
  // Asymmetric z on all pairs
  for (const mrg of [8, 10, 12, 15]) {
    for (const mc of [10, 15, 20]) {
      cfgs.push({
        label: `A-ALL L2.5/1.5 S3.5/2.5 $${mrg}m mc${mc} zrevL`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        marginUsd: mrg, maxConcurrent: mc,
        z1hLong: 2.5, z4hLong: 1.5, z1hShort: 3.5, z4hShort: 2.5,
      });
    }
  }
  // Dynamic margin on all pairs
  for (const dm of dynamicMaps.slice(0, 3)) {
    for (const mc of [10, 15, 20]) {
      cfgs.push({
        label: `A-ALL ${dm.label} mc${mc} zrevL`,
        slPct: 3, trail: [{ a: 80, d: 8 }], zReversalOnlyLosing: true,
        maxConcurrent: mc,
        z1hThresh: 3, z4hThresh: 2,
        dynamicMargin: true, dynamicMarginMap: dm.tiers,
      });
    }
  }

  return cfgs;
}

// ───── Main ─────
function fmtDollar(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function main() {
  console.log("=".repeat(140));
  console.log("  PUSH PROFIT v3: New angles for >$5/day");
  console.log("  Features: AsymZ, PerPairZ, TOD, ATR, Stagger, Hybrid, DynMargin, Weekend");
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
    const atr1 = computeATR(h1, 14);
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const ind: PI = { h1, h4, m5, z1, z4, h1Map, h4Map, atr1 };
    pairs.push({ name: n, ind, sp: SP[n] ?? DSP, lev, not: 10 * lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  const configs = buildConfigs();
  console.log(`\nTesting ${configs.length} configs...\n`);

  const hdr = `${"Config".padEnd(60)} ${"$/day".padStart(9)} ${"MDD".padStart(6)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"AvgW".padStart(7)} ${"AvgL".padStart(7)} ${"MaxL".padStart(7)} ${"N".padStart(5)}`;

  const results: Array<{ label: string; res: SimResult }> = [];
  let cnt = 0;
  for (const cfg of configs) {
    __timepoints = null; __m5Maps = null; __pairByName = null;
    const effMargin = cfg.marginUsd ?? 22;
    const cfgPairs = pairs.map(p => ({ ...p, not: effMargin * p.lev }));
    const res = simulate(cfgPairs, cfg);
    results.push({ label: cfg.label, res });
    cnt++;
    if (cnt % 20 === 0) process.stdout.write(`  [${cnt}/${configs.length}]\r`);
  }
  console.log(`  Done: ${cnt} configs tested`);

  // ─── OUTPUT by MDD bands ───
  const mddBands = [
    { label: "MDD < $20", min: 0, max: 20 },
    { label: "MDD $20-$30", min: 20, max: 30 },
    { label: "MDD $30-$40", min: 30, max: 40 },
    { label: "MDD $40-$50", min: 40, max: 50 },
  ];

  for (const band of mddBands) {
    const filtered = results
      .filter(r => r.res.maxDD >= band.min && r.res.maxDD < band.max && r.res.dollarsPerDay > 0)
      .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);

    console.log("\n" + "=".repeat(140));
    console.log(`*** ${band.label} *** -- sorted by $/day (top 25)`);
    console.log("=".repeat(140));
    console.log(hdr);
    console.log("-".repeat(140));

    if (filtered.length === 0) {
      console.log("  NO configs in this band");
    } else {
      for (const r of filtered.slice(0, 25)) {
        const s = r.res;
        console.log(`${r.label.padEnd(60).slice(0, 60)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(6)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${fmtDollar(s.avgWin).padStart(7)} ${fmtDollar(s.avgLoss).padStart(7)} ${fmtDollar(s.maxSingleLoss).padStart(7)} ${String(s.numTrades).padStart(5)}`);
      }
    }
  }

  // ─── OVERALL TOP 30 by $/day ───
  console.log("\n" + "=".repeat(140));
  console.log("TOP 30 BY $/DAY (any MDD)");
  console.log("=".repeat(140));
  console.log(hdr);
  console.log("-".repeat(140));

  const byDollar = results.filter(r => r.res.dollarsPerDay > 0)
    .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of byDollar.slice(0, 30)) {
    const s = r.res;
    console.log(`${r.label.padEnd(60).slice(0, 60)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(6)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${fmtDollar(s.avgWin).padStart(7)} ${fmtDollar(s.avgLoss).padStart(7)} ${fmtDollar(s.maxSingleLoss).padStart(7)} ${String(s.numTrades).padStart(5)}`);
  }

  // ─── BEST Calmar ($/day per $1 MDD) ───
  console.log("\n" + "=".repeat(140));
  console.log("TOP 20 BY CALMAR ($/day / MDD)");
  console.log("=".repeat(140));
  console.log(`${"Config".padEnd(60)} ${"$/day".padStart(9)} ${"MDD".padStart(6)} ${"Calmar".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)}`);
  console.log("-".repeat(140));

  const byCalmar = results.filter(r => r.res.dollarsPerDay > 0 && r.res.maxDD > 0)
    .map(r => ({ ...r, calmar: r.res.dollarsPerDay / r.res.maxDD }))
    .sort((a, b) => b.calmar - a.calmar);
  for (const r of byCalmar.slice(0, 20)) {
    const s = r.res;
    console.log(`${r.label.padEnd(60).slice(0, 60)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(6)} ${r.calmar.toFixed(4).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${String(s.numTrades).padStart(5)}`);
  }

  // ─── FEATURE COMPARISON: best per feature category ───
  console.log("\n" + "=".repeat(140));
  console.log("BEST PER FEATURE (compared to baseline)");
  console.log("=".repeat(140));

  const featureCategories = [
    { prefix: "BL", label: "BASELINE" },
    { prefix: "1-ASYM", label: "Asymmetric Z" },
    { prefix: "2-PP", label: "Per-Pair Z" },
    { prefix: "3-TOD", label: "Time-of-Day" },
    { prefix: "4-ATR", label: "ATR Regime" },
    { prefix: "5-STAGGER", label: "Staggered Entry" },
    { prefix: "6-HYBRID", label: "Hybrid Exit" },
    { prefix: "7-DYN", label: "Dynamic Margin" },
    { prefix: "8-WKDAY", label: "Weekend Filter" },
    { prefix: "X-COMBO", label: "Combo Features" },
    { prefix: "W-", label: "Wider Sets" },
    { prefix: "A-ALL", label: "All 127 Pairs" },
  ];

  console.log(`${"Feature".padEnd(20)} ${"Best Config".padEnd(55)} ${"$/day".padStart(9)} ${"MDD".padStart(6)} ${"Calmar".padStart(8)} ${"PF".padStart(6)} ${"N".padStart(5)}`);
  console.log("-".repeat(140));

  for (const fc of featureCategories) {
    const matching = results
      .filter(r => r.label.startsWith(fc.prefix) && r.res.dollarsPerDay > 0)
      .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
    if (matching.length === 0) continue;
    const best = matching[0]!;
    const s = best.res;
    const calmar = s.maxDD > 0 ? (s.dollarsPerDay / s.maxDD).toFixed(4) : "Inf";
    console.log(`${fc.label.padEnd(20)} ${best.label.padEnd(55).slice(0, 55)} ${fmtDollar(s.dollarsPerDay).padStart(9)} ${("$" + s.maxDD.toFixed(0)).padStart(6)} ${calmar.padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${String(s.numTrades).padStart(5)}`);
  }

  // ─── TOP 5 DETAILED ───
  console.log("\n" + "=".repeat(140));
  console.log("TOP 5 OVERALL DETAILED");
  console.log("=".repeat(140));
  for (let i = 0; i < Math.min(5, byDollar.length); i++) {
    const r = byDollar[i]!;
    const s = r.res;
    console.log(`\n#${i + 1}: ${r.label}`);
    console.log(`  $/day:           ${fmtDollar(s.dollarsPerDay)}`);
    console.log(`  Total PnL:       ${fmtDollar(s.totalPnl)} over ${OOS_D.toFixed(0)} days`);
    console.log(`  Max DD:          $${s.maxDD.toFixed(2)}`);
    console.log(`  Calmar:          ${(s.dollarsPerDay / s.maxDD).toFixed(4)}`);
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
    // Direction breakdown
    const longs = s.trades.filter(t => t.dir === "long");
    const shorts = s.trades.filter(t => t.dir === "short");
    const longPnl = longs.reduce((a, t) => a + t.pnl, 0);
    const shortPnl = shorts.reduce((a, t) => a + t.pnl, 0);
    console.log(`  Direction: ${longs.length} longs (${fmtDollar(longPnl)}), ${shorts.length} shorts (${fmtDollar(shortPnl)})`);
  }

  // Summary
  console.log("\n" + "=".repeat(140));
  console.log("SUMMARY");
  console.log("=".repeat(140));
  console.log(`Total configs tested: ${results.length}`);
  const above5 = results.filter(r => r.res.dollarsPerDay >= 5);
  console.log(`  >$5/day (any MDD):   ${above5.length} configs`);
  const above5mdd30 = above5.filter(r => r.res.maxDD < 30);
  console.log(`  >$5/day + MDD<$30:   ${above5mdd30.length} configs`);
  const above5mdd40 = above5.filter(r => r.res.maxDD < 40);
  console.log(`  >$5/day + MDD<$40:   ${above5mdd40.length} configs`);
  const above5mdd50 = above5.filter(r => r.res.maxDD < 50);
  console.log(`  >$5/day + MDD<$50:   ${above5mdd50.length} configs`);

  if (above5mdd50.length > 0) {
    console.log(`\n  Configs achieving >$5/day with MDD<$50:`);
    const sorted = above5mdd50.sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
    for (const r of sorted.slice(0, 10)) {
      console.log(`    ${r.label}: ${fmtDollar(r.res.dollarsPerDay)}/day, MDD $${r.res.maxDD.toFixed(0)}, PF ${r.res.pf.toFixed(2)}`);
    }
  }

  // Best new feature vs baseline
  const bl = results.find(r => r.label.startsWith("BL top5+alt5C $16"));
  if (bl) {
    console.log(`\n  Baseline: ${bl.label} = ${fmtDollar(bl.res.dollarsPerDay)}/day, MDD $${bl.res.maxDD.toFixed(0)}`);
    const improvements = results
      .filter(r => !r.label.startsWith("BL") && r.res.dollarsPerDay > bl.res.dollarsPerDay)
      .sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
    console.log(`  ${improvements.length} configs beat baseline $/day`);
    if (improvements.length > 0) {
      console.log(`  Best improvement: ${improvements[0]!.label}`);
      console.log(`    ${fmtDollar(improvements[0]!.res.dollarsPerDay)}/day (${fmtDollar(improvements[0]!.res.dollarsPerDay - bl.res.dollarsPerDay)} more), MDD $${improvements[0]!.res.maxDD.toFixed(0)}`);
    }
  }
}

main();
