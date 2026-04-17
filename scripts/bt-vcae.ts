/**
 * VCAE — Volatility Contraction After Expansion (3rd engine candidate)
 *
 * Signal (1h bars):
 *  - ATR14_1h on 1h closes
 *  - CLIMAX BAR: most recent 1h bar where range(H-L) >= climaxMult * ATR14
 *                AND |close-open| >= 0.6 * range (directional body, not wick)
 *  - CONTRACTION: next N consecutive 1h bars, each range <= contractionRatio * climaxRange,
 *                 monotonically decreasing
 *  - STRUCTURAL ANCHOR: climax high (bullish) within 0.3*ATR14 of 20-bar high
 *                       OR climax low (bearish) within 0.3*ATR14 of 20-bar low
 *  - BODY DRY-UP: sum of N contraction-bar bodies < 0.4 * climax body
 *
 * Entry (fade the climax):
 *  - Bullish climax  -> SHORT at next 1h open when Nth contraction bar closes
 *                       below the climax midpoint
 *  - Bearish climax  -> LONG at next 1h open when Nth contraction bar closes
 *                       above the climax midpoint
 *  - SL: 0.15% price, trail 3/1 -> 9/0.5 -> 20/0.5 (multi-stage)
 *  - Max hold: 48h
 *
 * Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03
 * Tests:
 *   1. Base standalone m$15
 *   2. climaxMult sweep: 1.5 / 2.0 / 2.5
 *   3. contraction bar count: 2 / 3 / 4
 *   4. contraction ratio: 0.5 / 0.6 / 0.7
 *   5. Sanity: no structural anchor
 *   6. Sanity: no body dry-up
 *   7. Portfolio GARCH + REX + VCAE at m$10 each
 *
 * Kill thresholds:
 *   - OOS $/day < $0.15 -> kill
 *   - OOS MDD > $20     -> kill
 *   - Edge vanishes without anchor/dry-up -> statistical artifact, kill
 *   - Target: +$0.35/day OOS, MDD<$15 as standalone
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const SL_SLIP = 1.5;
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
interface VcaeParams {
  climaxMult: number;
  contractBars: number;
  contractRatio: number;
  useAnchor: boolean;
  useDryUp: boolean;
  anchorAtrK: number;
  anchorLookback: number;
  bodyMinFrac: number;   // 0.6 body/range
  dryUpFrac: number;     // 0.4
}
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[]; rv168: number[];
  atr1: number[];
  rexSig20: Int8Array;
  // VCAE: precomputed signal per VCAE variant
  vcaeSigByKey: Map<string, Int8Array>;
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

/**
 * Compute VCAE signal: out[i] = direction for trade opened at h1[i].open
 * (i.e. bar i is the entry bar; the Nth contraction bar = bar i-1).
 *
 * +1 = LONG (bearish climax fade)
 * -1 = SHORT (bullish climax fade)
 *  0 = no signal
 */
function computeVCAE(h1: C[], atr1: number[], p: VcaeParams): Int8Array {
  const N = p.contractBars;
  const out = new Int8Array(h1.length);
  // Entry bar is i; Nth contraction bar is i-1, climax is i-1-N
  // Need anchor lookback of anchorLookback ending at climax bar
  const need = p.anchorLookback + N + 2;
  for (let i = need + 14; i < h1.length; i++) {
    const climaxIdx = i - 1 - N;
    if (climaxIdx < 14) continue;
    const climax = h1[climaxIdx]!;
    const atr = atr1[climaxIdx];
    if (!atr || atr <= 0) continue;

    const cRange = climax.h - climax.l;
    if (cRange <= 0) continue;
    if (cRange < p.climaxMult * atr) continue;

    const cBody = Math.abs(climax.c - climax.o);
    if (cBody < p.bodyMinFrac * cRange) continue;

    const bullish = climax.c > climax.o;
    const bearish = climax.c < climax.o;
    if (!bullish && !bearish) continue;

    // Contraction: next N bars
    let prevRange = cRange;
    let bodiesSum = 0;
    let ok = true;
    for (let k = 1; k <= N; k++) {
      const b = h1[climaxIdx + k]!;
      const r = b.h - b.l;
      if (r > p.contractRatio * cRange) { ok = false; break; }
      if (r > prevRange) { ok = false; break; } // monotonic
      bodiesSum += Math.abs(b.c - b.o);
      prevRange = r;
    }
    if (!ok) continue;

    // Body dry-up
    if (p.useDryUp) {
      if (!(bodiesSum < p.dryUpFrac * cBody)) continue;
    }

    // Trigger: Nth contraction bar closes beyond midpoint of climax (toward fade direction)
    const mid = (climax.h + climax.l) / 2;
    const lastContract = h1[climaxIdx + N]!;
    if (bullish) {
      if (!(lastContract.c < mid)) continue;
    } else {
      if (!(lastContract.c > mid)) continue;
    }

    // Structural anchor: climax at 20-bar extremity
    if (p.useAnchor) {
      const lbStart = Math.max(0, climaxIdx - p.anchorLookback + 1);
      if (bullish) {
        let hiN = -Infinity;
        for (let j = lbStart; j <= climaxIdx; j++) if (h1[j]!.h > hiN) hiN = h1[j]!.h;
        if (hiN - climax.h > p.anchorAtrK * atr) continue;
      } else {
        let loN = Infinity;
        for (let j = lbStart; j <= climaxIdx; j++) if (h1[j]!.l < loN) loN = h1[j]!.l;
        if (climax.l - loN > p.anchorAtrK * atr) continue;
      }
    }

    // Signal: bullish climax -> SHORT (-1), bearish climax -> LONG (+1)
    out[i] = bullish ? -1 : 1;
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

// Multi-stage trail: 3/1 -> 9/0.5 -> 20/0.5
function trailStop(peak: number): { act: number; dist: number } | null {
  if (peak >= 20) return { act: 20, dist: 0.5 };
  if (peak >= 9) return { act: 9, dist: 0.5 };
  if (peak >= 3) return { act: 3, dist: 1.0 };
  return null;
}

type Engine = "A" | "B" | "V"; // A=GARCH long-only, B=REX, V=VCAE

interface Cfg {
  label: string;
  marginA: number;
  marginB: number;
  marginV: number;
  slPct: number;
  // GARCH
  aZL1: number; aZL4: number;
  aRegime: boolean; aRegimeThr: number;
  aMaxHoldH: number;
  aTrailAct: number; aTrailDist: number;
  // REX
  bMult: number;
  bRegime: boolean; bRegimeThr: number;
  bMaxHoldH: number;
  bTrailAct: number; bTrailDist: number;
  // VCAE
  vParamKey: string;    // which precomputed signal to use
  vMaxHoldH: number;
  vLongOnly: boolean;
  vShortOnly: boolean;
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
  // For V (multi-stage trail)
  useMultiStage: boolean;
  // For A/B (fixed trail)
  trailAct: number; trailDist: number;
}

interface Tr {
  engine: Engine; pair: string; dir: "long" | "short";
  pnl: number; reason: string; exitTs: number;
}

interface EngineStats { pnl: number; n: number; wins: number; losses: number; maxLoss: number; }
interface Res {
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  maxSingleLoss: number;
  numTrades: number;
  byEngine: Record<Engine, EngineStats>;
  dailyPnlA: Map<number, number>;
  dailyPnlB: Map<number, number>;
  dailyPnlV: Map<number, number>;
  trades: Tr[];
}

function simulate(pairs: PD[], cfg: Cfg, startTs: number, endTs: number, days: number): Res {
  const closed: Tr[] = [];
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of pairs) for (const b of p.ind.m5) if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PD>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }

  const notA = (lev: number) => cfg.marginA * lev;
  const notB = (lev: number) => cfg.marginB * lev;
  const notV = (lev: number) => cfg.marginV * lev;

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
        if (pos.useMultiStage) {
          const tr = trailStop(pos.pk);
          if (tr && cur <= pos.pk - tr.dist) { xp = bar.c; reason = "trail"; }
        } else {
          if (pos.pk >= pos.trailAct && cur <= pos.pk - pos.trailDist) { xp = bar.c; reason = "trail"; }
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
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

      // ===== Engine A: GARCH long-only =====
      if (cfg.marginA > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "A")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.aZL1 && z4 > cfg.aZL4) {
          let ok = true;
          if (cfg.aRegime) {
            const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
            const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
            if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.aRegimeThr) ok = false;
          }
          if (ok) {
            const dir: "long" = "long";
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            openPositions.push({
              engine: "A", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notA(p.lev), maxHoldH: cfg.aMaxHoldH,
              useMultiStage: false, trailAct: cfg.aTrailAct, trailDist: cfg.aTrailDist,
            });
          }
        }
      }

      // ===== Engine B: Range Expansion =====
      if (cfg.marginB > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "B")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          let ok = true;
          if (cfg.bRegime) {
            const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
            const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
            if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.bRegimeThr) ok = false;
          }
          if (ok) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "B", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notB(p.lev), maxHoldH: cfg.bMaxHoldH,
              useMultiStage: false, trailAct: cfg.bTrailAct, trailDist: cfg.bTrailDist,
            });
          }
        }
      }

      // ===== Engine V: VCAE =====
      if (cfg.marginV > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "V")) {
        const vSig = p.ind.vcaeSigByKey.get(cfg.vParamKey);
        if (vSig) {
          let sig = vSig[h1Idx] ?? 0; // signal is indexed at entry bar
          if (cfg.vLongOnly && sig < 0) sig = 0;
          if (cfg.vShortOnly && sig > 0) sig = 0;
          if (sig !== 0) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "V", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notV(p.lev), maxHoldH: cfg.vMaxHoldH,
              useMultiStage: true, trailAct: 0, trailDist: 0,
            });
          }
        }
      }
    }
  }

  // Close still-open at end
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

  const byEngine: Record<Engine, EngineStats> = {
    A: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
    B: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
    V: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
  };
  const dailyPnlA = new Map<number, number>();
  const dailyPnlB = new Map<number, number>();
  const dailyPnlV = new Map<number, number>();
  for (const t of closed) {
    const e = byEngine[t.engine];
    e.pnl += t.pnl; e.n += 1;
    if (t.pnl > 0) e.wins += 1; else { e.losses += 1; if (t.pnl < e.maxLoss) e.maxLoss = t.pnl; }
    const day = Math.floor(t.exitTs / D) * D;
    const m = t.engine === "A" ? dailyPnlA : t.engine === "B" ? dailyPnlB : dailyPnlV;
    m.set(day, (m.get(day) ?? 0) + t.pnl);
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / days,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
    dailyPnlA,
    dailyPnlB,
    dailyPnlV,
    trades: closed,
  };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma, xb = b[i]! - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function baseVcaeParams(overrides: Partial<VcaeParams> = {}): VcaeParams {
  return {
    climaxMult: 2.0,
    contractBars: 3,
    contractRatio: 0.6,
    useAnchor: true,
    useDryUp: true,
    anchorAtrK: 0.3,
    anchorLookback: 20,
    bodyMinFrac: 0.6,
    dryUpFrac: 0.4,
    ...overrides,
  };
}

function paramKey(p: VcaeParams): string {
  return `m${p.climaxMult}_n${p.contractBars}_r${p.contractRatio}_a${p.useAnchor ? 1 : 0}_d${p.useDryUp ? 1 : 0}`;
}

function reportStandalone(label: string, isR: Res, oosR: Res) {
  log(`  ${label}`);
  log(`    IS  $/day ${fmtD(isR.dollarsPerDay)}  MDD $${isR.maxDD.toFixed(2)}  PF ${isR.pf.toFixed(2)}  WR ${isR.wr.toFixed(1)}%  N=${isR.numTrades}  maxL ${fmtD(isR.maxSingleLoss)}`);
  log(`    OOS $/day ${fmtD(oosR.dollarsPerDay)}  MDD $${oosR.maxDD.toFixed(2)}  PF ${oosR.pf.toFixed(2)}  WR ${oosR.wr.toFixed(1)}%  N=${oosR.numTrades}  maxL ${fmtD(oosR.maxSingleLoss)}`);
}

function killCheck(oosR: Res): { pass: boolean; reason: string } {
  if (oosR.dollarsPerDay < 0.15) return { pass: false, reason: "OOS $/day < $0.15" };
  if (oosR.maxDD > 20) return { pass: false, reason: "OOS MDD > $20" };
  return { pass: true, reason: "" };
}

function main() {
  log("=".repeat(130));
  log("  VCAE — VOLATILITY CONTRACTION AFTER EXPANSION (3rd engine candidate)");
  log("  Signal: 1h climax bar (range >= K*ATR, body>=0.6*range) + N monotonic contraction bars");
  log("          + 20-bar structural anchor + body dry-up + trigger beyond climax midpoint");
  log("  SL 0.15%, multi-stage trail 3/1 -> 9/0.5 -> 20/0.5, max hold 48h");
  log("  Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03");
  log("=".repeat(130));

  log("\nLoading pairs...");

  // Precompute param variants we need
  const baseP = baseVcaeParams();
  const paramVariants: { key: string; p: VcaeParams; label: string }[] = [];
  const addVariant = (label: string, p: VcaeParams) => {
    const k = paramKey(p);
    if (!paramVariants.some(v => v.key === k)) paramVariants.push({ key: k, p, label });
  };
  addVariant("base m2.0 n3 r0.6 anchor+dryup", baseP);
  // Test 2: climaxMult
  addVariant("climax 1.5", baseVcaeParams({ climaxMult: 1.5 }));
  addVariant("climax 2.5", baseVcaeParams({ climaxMult: 2.5 }));
  // Test 3: contraction count
  addVariant("n 2 bars", baseVcaeParams({ contractBars: 2 }));
  addVariant("n 4 bars", baseVcaeParams({ contractBars: 4 }));
  // Test 4: contraction ratio
  addVariant("ratio 0.5", baseVcaeParams({ contractRatio: 0.5 }));
  addVariant("ratio 0.7", baseVcaeParams({ contractRatio: 0.7 }));
  // Test 5: no anchor
  addVariant("no anchor", baseVcaeParams({ useAnchor: false }));
  // Test 6: no dry-up
  addVariant("no dry-up", baseVcaeParams({ useDryUp: false }));
  // Bonus: no anchor AND no dry-up (pure climax+contraction)
  addVariant("no anchor no dry-up", baseVcaeParams({ useAnchor: false, useDryUp: false }));

  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 250 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const atr1 = computeATR(h1, 14);
    const rexSig20 = computeRangeExpansion(h1, atr1, 2.0);
    const vcaeSigByKey = new Map<string, Int8Array>();
    for (const v of paramVariants) {
      vcaeSigByKey.set(v.key, computeVCAE(h1, atr1, v.p));
    }
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168, atr1, rexSig20, vcaeSigByKey },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  // Signal-count sanity check
  log("\n  Signal counts (entry bars, full loaded history):");
  for (const v of paramVariants) {
    let bull = 0, bear = 0;
    for (const p of pairs) {
      const s = p.ind.vcaeSigByKey.get(v.key);
      if (!s) continue;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === -1) bull++;
        else if (s[i] === 1) bear++;
      }
    }
    log(`    ${v.label.padEnd(40)}  key=${v.key.padEnd(38)}  short=${bull}  long=${bear}  total=${bull + bear}`);
  }

  // Base config for VCAE-only runs (marginA=marginB=0)
  const vcaeOnlyCfg = (vKey: string, margin: number, label: string, lo = false, so = false): Cfg => ({
    label,
    marginA: 0, marginB: 0, marginV: margin,
    slPct: 0.0015,
    aZL1: 2.0, aZL4: 1.5, aRegime: true, aRegimeThr: 1.5, aMaxHoldH: 72,
    aTrailAct: 9, aTrailDist: 0.5,
    bMult: 2.0, bRegime: true, bRegimeThr: 1.5, bMaxHoldH: 12,
    bTrailAct: 9, bTrailDist: 0.5,
    vParamKey: vKey, vMaxHoldH: 48,
    vLongOnly: lo, vShortOnly: so,
  });

  interface VRec {
    label: string;
    key: string;
    is: Res;
    oos: Res;
    isK: { pass: boolean; reason: string };
    oosK: { pass: boolean; reason: string };
  }
  const vRecs: VRec[] = [];

  log("\n" + "=".repeat(130));
  log("  TEST 1/5/6: VCAE STANDALONE VARIANTS @ m$15 (base + sanity removals)");
  log("=".repeat(130));
  for (const v of paramVariants) {
    const cfg = vcaeOnlyCfg(v.key, 15, `VCAE ${v.label} m$15`);
    const isR = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oosR = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log("");
    reportStandalone(`VCAE ${v.label}`, isR, oosR);
    const oosK = killCheck(oosR);
    log(`    OOS kill: ${oosK.pass ? "PASS" : "FAIL - " + oosK.reason}`);
    vRecs.push({
      label: v.label, key: v.key, is: isR, oos: oosR,
      isK: killCheck(isR), oosK,
    });
  }

  // Test 6/7: Long-only and Short-only VCAE (using base variant)
  log("\n" + "=".repeat(130));
  log("  TEST 6/7: VCAE LONG-ONLY and SHORT-ONLY (base params @ m$15)");
  log("=".repeat(130));
  const baseKey = paramKey(baseP);
  const loCfg = vcaeOnlyCfg(baseKey, 15, "VCAE long-only m$15", true, false);
  const soCfg = vcaeOnlyCfg(baseKey, 15, "VCAE short-only m$15", false, true);
  const loIS = simulate(pairs, loCfg, IS_S, IS_E, IS_D);
  const loOOS = simulate(pairs, loCfg, OOS_S, OOS_E, OOS_D);
  const soIS = simulate(pairs, soCfg, IS_S, IS_E, IS_D);
  const soOOS = simulate(pairs, soCfg, OOS_S, OOS_E, OOS_D);
  reportStandalone("VCAE long-only (base)", loIS, loOOS);
  const loK = killCheck(loOOS);
  log(`    OOS kill: ${loK.pass ? "PASS" : "FAIL - " + loK.reason}`);
  log("");
  reportStandalone("VCAE short-only (base)", soIS, soOOS);
  const soK = killCheck(soOOS);
  log(`    OOS kill: ${soK.pass ? "PASS" : "FAIL - " + soK.reason}`);

  // Summary table
  log("\n" + "=".repeat(130));
  log("  STANDALONE SUMMARY @ m$15");
  log("=".repeat(130));
  log(`${"Variant".padEnd(36)} ${"IS$/d".padStart(9)} ${"ISMdd".padStart(8)} ${"ISPF".padStart(6)} ${"ISN".padStart(5)} ${"OOS$/d".padStart(9)} ${"OOSMdd".padStart(8)} ${"OOSPF".padStart(6)} ${"OOSN".padStart(5)} ${"kill".padStart(6)}`);
  log("-".repeat(130));
  for (const r of vRecs) {
    log(
      `${r.label.padEnd(36)} ` +
      `${fmtD(r.is.dollarsPerDay).padStart(9)} ` +
      `${("$" + r.is.maxDD.toFixed(0)).padStart(8)} ` +
      `${r.is.pf.toFixed(2).padStart(6)} ` +
      `${String(r.is.numTrades).padStart(5)} ` +
      `${fmtD(r.oos.dollarsPerDay).padStart(9)} ` +
      `${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ` +
      `${r.oos.pf.toFixed(2).padStart(6)} ` +
      `${String(r.oos.numTrades).padStart(5)} ` +
      `${(r.oosK.pass ? "PASS" : "FAIL").padStart(6)}`
    );
  }

  // Identify best VCAE variant by OOS $/day among those passing kill
  const passing = vRecs.filter(r => r.oosK.pass);
  let best: VRec | null = null;
  if (passing.length > 0) {
    passing.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
    best = passing[0]!;
  } else {
    // Pick least-bad (highest OOS $/day) for portfolio test anyway
    const sorted = [...vRecs].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
    best = sorted[0]!;
  }

  // Sanity check comparison: base vs no-anchor vs no-dryup
  log("\n" + "=".repeat(130));
  log("  STATISTICAL-ARTIFACT CHECK");
  log("=".repeat(130));
  const baseRec = vRecs.find(r => r.label.includes("base"));
  const noAnchor = vRecs.find(r => r.label === "no anchor");
  const noDryup = vRecs.find(r => r.label === "no dry-up");
  const neither = vRecs.find(r => r.label === "no anchor no dry-up");
  if (baseRec && noAnchor && noDryup && neither) {
    log(`  Base (anchor+dryup):  OOS $/day ${fmtD(baseRec.oos.dollarsPerDay)}  MDD $${baseRec.oos.maxDD.toFixed(0)}  PF ${baseRec.oos.pf.toFixed(2)}  N=${baseRec.oos.numTrades}`);
    log(`  No anchor:            OOS $/day ${fmtD(noAnchor.oos.dollarsPerDay)}  MDD $${noAnchor.oos.maxDD.toFixed(0)}  PF ${noAnchor.oos.pf.toFixed(2)}  N=${noAnchor.oos.numTrades}`);
    log(`  No dry-up:            OOS $/day ${fmtD(noDryup.oos.dollarsPerDay)}  MDD $${noDryup.oos.maxDD.toFixed(0)}  PF ${noDryup.oos.pf.toFixed(2)}  N=${noDryup.oos.numTrades}`);
    log(`  No anchor no dry-up:  OOS $/day ${fmtD(neither.oos.dollarsPerDay)}  MDD $${neither.oos.maxDD.toFixed(0)}  PF ${neither.oos.pf.toFixed(2)}  N=${neither.oos.numTrades}`);
    const baseEdge = baseRec.oos.dollarsPerDay;
    const degraded =
      (noAnchor.oos.dollarsPerDay < baseEdge * 0.7 || noAnchor.oos.pf < baseRec.oos.pf * 0.85) &&
      (noDryup.oos.dollarsPerDay < baseEdge * 0.7 || noDryup.oos.pf < baseRec.oos.pf * 0.85);
    if (baseEdge <= 0) {
      log("  Base has no OOS edge — nothing to artifact-check.");
    } else if (degraded) {
      log("  -> Edge degrades when filters removed: structural components are load-bearing (not artifacts).");
    } else {
      log("  -> Edge DOES NOT degrade without anchor/dry-up: suggests components are NOT the edge source.");
      log("     This is a warning — filters may be statistical noise that happen to match.");
    }
  }

  // Portfolio test: GARCH + REX + VCAE
  log("\n" + "=".repeat(130));
  log(`  TEST 7: PORTFOLIO GARCH + REX + VCAE (using best VCAE variant: ${best.label})`);
  log("=".repeat(130));

  const pfCfg = (mA: number, mB: number, mV: number, label: string): Cfg => ({
    label,
    marginA: mA, marginB: mB, marginV: mV,
    slPct: 0.0015,
    aZL1: 2.0, aZL4: 1.5, aRegime: true, aRegimeThr: 1.5, aMaxHoldH: 72,
    aTrailAct: 9, aTrailDist: 0.5,
    bMult: 2.0, bRegime: true, bRegimeThr: 1.5, bMaxHoldH: 12,
    bTrailAct: 9, bTrailDist: 0.5,
    vParamKey: best.key, vMaxHoldH: 48,
    vLongOnly: false, vShortOnly: false,
  });

  interface PfRec {
    label: string; mA: number; mB: number; mV: number;
    is: Res; oos: Res;
  }
  const pfRecs: PfRec[] = [];

  // Standalone reference runs so we can compute additivity
  log("\n  Running standalone reference runs at m$10 (for additivity)...");
  const aOnlyCfg = pfCfg(10, 0, 0, "A only m$10");
  const bOnlyCfg = pfCfg(0, 10, 0, "B only m$10");
  const vOnlyCfg = pfCfg(0, 0, 10, "V only m$10");
  const aIS10 = simulate(pairs, aOnlyCfg, IS_S, IS_E, IS_D);
  const aOOS10 = simulate(pairs, aOnlyCfg, OOS_S, OOS_E, OOS_D);
  const bIS10 = simulate(pairs, bOnlyCfg, IS_S, IS_E, IS_D);
  const bOOS10 = simulate(pairs, bOnlyCfg, OOS_S, OOS_E, OOS_D);
  const vIS10 = simulate(pairs, vOnlyCfg, IS_S, IS_E, IS_D);
  const vOOS10 = simulate(pairs, vOnlyCfg, OOS_S, OOS_E, OOS_D);

  log(`    A alone m$10  IS ${fmtD(aIS10.dollarsPerDay)}/d MDD $${aIS10.maxDD.toFixed(0)}  OOS ${fmtD(aOOS10.dollarsPerDay)}/d MDD $${aOOS10.maxDD.toFixed(0)}  N=${aOOS10.numTrades}`);
  log(`    B alone m$10  IS ${fmtD(bIS10.dollarsPerDay)}/d MDD $${bIS10.maxDD.toFixed(0)}  OOS ${fmtD(bOOS10.dollarsPerDay)}/d MDD $${bOOS10.maxDD.toFixed(0)}  N=${bOOS10.numTrades}`);
  log(`    V alone m$10  IS ${fmtD(vIS10.dollarsPerDay)}/d MDD $${vIS10.maxDD.toFixed(0)}  OOS ${fmtD(vOOS10.dollarsPerDay)}/d MDD $${vOOS10.maxDD.toFixed(0)}  N=${vOOS10.numTrades}`);

  // Portfolio splits — spec: GARCH $15 + REX $15 + VCAE $5-$10
  const splits: { label: string; mA: number; mB: number; mV: number }[] = [
    { label: "A$15 + B$15 (no V, baseline)",   mA: 15, mB: 15, mV: 0  },
    { label: "A$15 + B$15 + V$5",              mA: 15, mB: 15, mV: 5  },
    { label: "A$15 + B$15 + V$8",              mA: 15, mB: 15, mV: 8  },
    { label: "A$15 + B$15 + V$10",             mA: 15, mB: 15, mV: 10 },
    { label: "A$10 + B$10 + V$10 (balanced)",  mA: 10, mB: 10, mV: 10 },
    { label: "A$10 + B$10 (no V, bl10)",       mA: 10, mB: 10, mV: 0  },
    { label: "A$10 + V$10 (A+V only)",         mA: 10, mB: 0,  mV: 10 },
    { label: "B$10 + V$10 (B+V only)",         mA: 0,  mB: 10, mV: 10 },
  ];

  for (const s of splits) {
    const cfg = pfCfg(s.mA, s.mB, s.mV, s.label);
    log("\n  --- " + s.label + " ---");
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    pfRecs.push({ label: s.label, mA: s.mA, mB: s.mB, mV: s.mV, is, oos });
    log(`    IS  total ${fmtD(is.totalPnl)}  $/day ${fmtD(is.dollarsPerDay)}  MDD $${is.maxDD.toFixed(2)}  PF ${is.pf.toFixed(2)}  N=${is.numTrades}`);
    log(`        A=${fmtD(is.byEngine.A.pnl)} (${is.byEngine.A.n})  B=${fmtD(is.byEngine.B.pnl)} (${is.byEngine.B.n})  V=${fmtD(is.byEngine.V.pnl)} (${is.byEngine.V.n})`);
    log(`    OOS total ${fmtD(oos.totalPnl)}  $/day ${fmtD(oos.dollarsPerDay)}  MDD $${oos.maxDD.toFixed(2)}  PF ${oos.pf.toFixed(2)}  N=${oos.numTrades}`);
    log(`        A=${fmtD(oos.byEngine.A.pnl)} (${oos.byEngine.A.n})  B=${fmtD(oos.byEngine.B.pnl)} (${oos.byEngine.B.n})  V=${fmtD(oos.byEngine.V.pnl)} (${oos.byEngine.V.n})`);
  }

  // Correlation V vs A, V vs B (OOS daily)
  log("\n" + "=".repeat(130));
  log("  OOS CORRELATION ANALYSIS (daily P&L)");
  log("=".repeat(130));
  const balanced = pfRecs.find(r => r.mA === 10 && r.mB === 10 && r.mV === 10);
  if (balanced) {
    const days = new Set<number>([
      ...balanced.oos.dailyPnlA.keys(),
      ...balanced.oos.dailyPnlB.keys(),
      ...balanced.oos.dailyPnlV.keys(),
    ]);
    const sorted = [...days].sort((a, b) => a - b);
    const va: number[] = [], vb: number[] = [], vv: number[] = [];
    for (const d of sorted) {
      va.push(balanced.oos.dailyPnlA.get(d) ?? 0);
      vb.push(balanced.oos.dailyPnlB.get(d) ?? 0);
      vv.push(balanced.oos.dailyPnlV.get(d) ?? 0);
    }
    const cAB = pearson(va, vb);
    const cAV = pearson(va, vv);
    const cBV = pearson(vb, vv);
    log(`  corr(A,B) = ${cAB.toFixed(3)}`);
    log(`  corr(A,V) = ${cAV.toFixed(3)}`);
    log(`  corr(B,V) = ${cBV.toFixed(3)}`);

    // Additivity: expected = A + B + V standalone, scaled proportionally
    const expDay = aOOS10.dollarsPerDay + bOOS10.dollarsPerDay + vOOS10.dollarsPerDay;
    const expMDD = aOOS10.maxDD + bOOS10.maxDD + vOOS10.maxDD;
    log(`\n  ADDITIVITY (A$10+B$10+V$10):`);
    log(`    Expected $/day (sum of singles): ${fmtD(expDay)}`);
    log(`    Actual   $/day:                  ${fmtD(balanced.oos.dollarsPerDay)}`);
    log(`    Delta:                           ${fmtD(balanced.oos.dollarsPerDay - expDay)}`);
    log(`    Expected MDD (sum of singles):   $${expMDD.toFixed(2)}`);
    log(`    Actual   MDD:                    $${balanced.oos.maxDD.toFixed(2)}`);
    log(`    MDD reduction (diversification): $${(expMDD - balanced.oos.maxDD).toFixed(2)}`);

    // VCAE marginal contribution to portfolio
    const baseline = pfRecs.find(r => r.mA === 10 && r.mB === 10 && r.mV === 0);
    if (baseline) {
      const marginalDay = balanced.oos.dollarsPerDay - baseline.oos.dollarsPerDay;
      const marginalMDD = balanced.oos.maxDD - baseline.oos.maxDD;
      log(`\n  VCAE MARGINAL CONTRIBUTION TO A+B PORTFOLIO (OOS):`);
      log(`    Baseline A$10+B$10:        $/day ${fmtD(baseline.oos.dollarsPerDay)}  MDD $${baseline.oos.maxDD.toFixed(2)}`);
      log(`    With VCAE A$10+B$10+V$10:  $/day ${fmtD(balanced.oos.dollarsPerDay)}  MDD $${balanced.oos.maxDD.toFixed(2)}`);
      log(`    Marginal $/day from V:     ${fmtD(marginalDay)}`);
      log(`    Marginal MDD change:       $${marginalMDD >= 0 ? "+" : ""}${marginalMDD.toFixed(2)}`);
      // Standalone V OOS
      log(`    Standalone V m$10 OOS:     ${fmtD(vOOS10.dollarsPerDay)}/d  MDD $${vOOS10.maxDD.toFixed(2)}`);
      if (marginalDay < vOOS10.dollarsPerDay * 0.5) {
        log(`    -> V loses >50% of its edge when stacked (overlap with A or B).`);
      } else {
        log(`    -> V retains most of its standalone edge (uncorrelated).`);
      }
    }
  }

  // Primary spec portfolio test: A$15+B$15+V{5,8,10} vs A$15+B$15 baseline
  log("\n" + "=".repeat(130));
  log("  PRIMARY SPEC: A$15 + B$15 + V$5-$10  vs  A$15+B$15 baseline (OOS marginal)");
  log("=".repeat(130));
  const bl15 = pfRecs.find(r => r.mA === 15 && r.mB === 15 && r.mV === 0);
  const v5 = pfRecs.find(r => r.mA === 15 && r.mB === 15 && r.mV === 5);
  const v8 = pfRecs.find(r => r.mA === 15 && r.mB === 15 && r.mV === 8);
  const v10 = pfRecs.find(r => r.mA === 15 && r.mB === 15 && r.mV === 10);
  if (bl15) {
    log(`  Baseline A$15+B$15:        OOS ${fmtD(bl15.oos.dollarsPerDay)}/d  MDD $${bl15.oos.maxDD.toFixed(2)}  PF ${bl15.oos.pf.toFixed(2)}  N=${bl15.oos.numTrades}`);
    for (const r of [v5, v8, v10]) {
      if (!r) continue;
      const mDay = r.oos.dollarsPerDay - bl15.oos.dollarsPerDay;
      const mMdd = r.oos.maxDD - bl15.oos.maxDD;
      log(`  ${r.label}: OOS ${fmtD(r.oos.dollarsPerDay)}/d  MDD $${r.oos.maxDD.toFixed(2)}  PF ${r.oos.pf.toFixed(2)}  | marginal ${fmtD(mDay)}/d  ${mMdd >= 0 ? "+" : ""}$${mMdd.toFixed(2)} MDD`);
    }
  }

  // Final verdict
  log("\n" + "=".repeat(130));
  log("  VERDICT");
  log("=".repeat(130));
  const bestIS = best.is;
  const bestOOS = best.oos;
  log(`  Best VCAE variant: ${best.label}  (key=${best.key})`);
  log(`    IS  $/day ${fmtD(bestIS.dollarsPerDay)}  MDD $${bestIS.maxDD.toFixed(2)}  PF ${bestIS.pf.toFixed(2)}  N=${bestIS.numTrades}`);
  log(`    OOS $/day ${fmtD(bestOOS.dollarsPerDay)}  MDD $${bestOOS.maxDD.toFixed(2)}  PF ${bestOOS.pf.toFixed(2)}  N=${bestOOS.numTrades}`);
  const killV = killCheck(bestOOS);
  const target = bestOOS.dollarsPerDay >= 0.35 && bestOOS.maxDD < 15;
  if (!killV.pass) {
    log(`  KILL: ${killV.reason}`);
    log(`  Verdict: DO NOT DEPLOY as 3rd engine.`);
  } else if (!target) {
    log(`  Passes kill thresholds but misses target (+$0.35/d, MDD<$15).`);
    log(`    target $/day: ${bestOOS.dollarsPerDay >= 0.35 ? "MET" : "MISS (" + fmtD(bestOOS.dollarsPerDay) + ")"}`);
    log(`    target MDD:   ${bestOOS.maxDD < 15 ? "MET" : "MISS ($" + bestOOS.maxDD.toFixed(0) + ")"}`);
    log(`  Verdict: BORDERLINE — only deploy if portfolio-marginal $/day is meaningfully positive with low corr.`);
  } else {
    log(`  Passes kill thresholds AND target.`);
    log(`  Verdict: candidate OK — final decision hinges on marginal contribution inside portfolio.`);
  }

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "vcae.txt"), lines.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "vcae.txt")}`);
}

main();
