/**
 * SCALE-OUT / PARTIAL EXIT STRATEGIES
 *
 * Task: Test scale-out/partial-exit variants on deployed 2-engine portfolio.
 *
 * Baseline (deployed):
 *   Engine A — GARCH long-only loose (z1h>2.0 AND z4h>1.5, LONGS ONLY), m$30
 *   Engine B — Range Expansion mult=2.0, m$15
 *   Shared: SL 0.15%, multi-stage trail 3/1 -> 9/0.5 -> 20/0.5, vol regime ON
 *   OOS baseline ref: $5.02/day, MDD $14.47
 *
 * TEST variations (applied to both engines):
 *   1. Close 25% @ +2%, 25% @ +5%, 50% runner trail 3/1 -> 9/0.5 -> 20/0.5
 *   2. Close 33% @ +3%, 33% @ +9%, runner trail 20/0.5
 *   3. Close 50% @ peakRef (ref=50 here, fires once peak >= 5%), runner trails
 *      (half of current peak as floor — implemented as "close 50% once peak >= 5")
 *   4. Close 40% @ +6%, 30% @ +12%, 30% runner trail 20/0.5
 *   5. First target at 1xATR(entry) (lev%), second at 2xATR(entry), runner trails
 *   6. Close 100% @ +15% (no trail runner, clean TP)
 *   7. Close 100% @ +10% (tight TP)
 *   8. Close 100% @ +20% (wide TP)
 *   9. Hybrid: 50% @ +5% ONLY IF peak retraces 1% first, else let trail handle it
 *
 * Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03
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
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[]; rv168: number[];
  atr1: number[];
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

type Engine = "A" | "B";

// Partial step types
// "fixed"  — trigger at absolute leveraged % (peak >= trig)
// "atr"    — trigger at multiple of ATR-at-entry in price; converted to leveraged % once at open
// "hybrid" — trigger at peak >= trig AND peak has retraced `minRetrace` leveraged % from peak
interface PartialStep {
  kind: "fixed" | "atr" | "hybrid";
  trig: number;       // fixed: leveraged %; atr: multiple of ATR (e.g. 1 = 1xATR)
  frac: number;       // fraction of current (remaining) notional to close
  minRetrace?: number;// hybrid only: require peak - cur >= minRetrace (leveraged %)
}

interface TrailStage { act: number; dist: number; }

interface ExitCfg {
  label: string;
  partials: PartialStep[];
  trailStages: TrailStage[];
  beAt?: number;
}

interface Cfg {
  label: string;
  marginA: number;
  marginB: number;
  slPct: number;
  aZL1: number; aZL4: number;
  aRegimeThr: number;
  aMaxHoldH: number;
  bMult: number;
  bRegimeThr: number;
  bMaxHoldH: number;
  exit: ExitCfg;
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  origNot: number;
  maxHoldH: number;
  partialsTaken: number;
  beMoved: boolean;
  atrPctLev: number;  // 1xATR at entry converted to leveraged %
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
  avgWin: number;
  avgLoss: number;
  maxSingleLoss: number;
  numTrades: number;
  numFills: number; // total fill events including partials
  byEngine: Record<Engine, EngineStats>;
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

      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      let xp = 0, reason = "", isSL = false;

      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) {
          xp = pos.sl;
          reason = pos.beMoved ? "be" : "sl";
          isSL = !pos.beMoved;
        }
      }

      if (!xp && cfg.exit.beAt !== undefined && !pos.beMoved && pos.pk >= cfg.exit.beAt) {
        pos.sl = pos.ep;
        pos.beMoved = true;
      }

      // Partial closes (executed in order, each at most once)
      if (!xp) {
        while (pos.partialsTaken < cfg.exit.partials.length) {
          const step = cfg.exit.partials[pos.partialsTaken]!;
          // Resolve trigger to leveraged %
          let trigLev: number;
          if (step.kind === "atr") trigLev = step.trig * pos.atrPctLev;
          else trigLev = step.trig;
          if (pos.pk < trigLev) break;

          // Hybrid retracement gate
          if (step.kind === "hybrid") {
            const curLev = pos.dir === "long"
              ? (bar.c / pos.ep - 1) * pos.lev * 100
              : (pos.ep / bar.c - 1) * pos.lev * 100;
            const retrace = pos.pk - curLev;
            if (retrace < (step.minRetrace ?? 0)) break;
          }

          // Close `step.frac` of CURRENT notional at trigger price (fixed/atr) or bar.c (hybrid)
          let trigPrice: number;
          if (step.kind === "hybrid") {
            // Use current bar close (fires only when retrace confirmed)
            trigPrice = bar.c;
          } else {
            trigPrice = pos.dir === "long"
              ? pos.ep * (1 + trigLev / 100 / pos.lev)
              : pos.ep * (1 - trigLev / 100 / pos.lev);
          }
          const closeNot = pos.not * step.frac;
          const ex = pos.dir === "long" ? trigPrice * (1 - pos.sp) : trigPrice * (1 + pos.sp);
          const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * closeNot - closeNot * FEE * 2;
          closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason: `p${pos.partialsTaken + 1}` });
          pos.not = pos.not - closeNot;
          pos.partialsTaken += 1;
          if (pos.not <= 0.01) {
            xp = trigPrice; reason = "pfinal";
            break;
          }
        }
      }

      // Multi-stage trail
      if (!xp && cfg.exit.trailStages.length > 0) {
        let activeStage: TrailStage | null = null;
        for (const s of cfg.exit.trailStages) {
          if (pos.pk >= s.act) {
            if (!activeStage || s.act > activeStage.act) activeStage = s;
          }
        }
        if (activeStage) {
          const cur = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * pos.lev * 100
            : (pos.ep / bar.c - 1) * pos.lev * 100;
          if (cur <= pos.pk - activeStage.dist) { xp = bar.c; reason = "trail"; }
        }
      }

      if (xp > 0 && pos.not > 0.01) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      } else if (pos.not <= 0.01) {
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // ATR at entry: express as leveraged %
      const atrAbs = p.ind.atr1[h1Idx - 1] ?? 0;
      const prevClose = p.ind.h1[h1Idx - 1]!.c;
      const atrPct = prevClose > 0 ? (atrAbs / prevClose) * 100 : 0;

      // Engine A
      if (cfg.marginA > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "A")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.aZL1 && z4 > cfg.aZL4) {
          const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
          const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
          if (rv24 > 0 && rv168 > 0 && rv24 / rv168 >= cfg.aRegimeThr) {
            const dir: "long" = "long";
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            const notl = notA(p.lev);
            openPositions.push({
              engine: "A", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notl, origNot: notl,
              maxHoldH: cfg.aMaxHoldH, partialsTaken: 0, beMoved: false,
              atrPctLev: atrPct * p.lev,
            });
          }
        }
      }

      // Engine B
      if (cfg.marginB > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "B")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
          const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
          if (rv24 > 0 && rv168 > 0 && rv24 / rv168 >= cfg.bRegimeThr) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            const notl = notB(p.lev);
            openPositions.push({
              engine: "B", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notl, origNot: notl,
              maxHoldH: cfg.bMaxHoldH, partialsTaken: 0, beMoved: false,
              atrPctLev: atrPct * p.lev,
            });
          }
        }
      }
    }
  }

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
  const avgWin = wins.length > 0 ? gp / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  const byEngine: Record<Engine, EngineStats> = {
    A: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
    B: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
  };
  for (const t of closed) {
    const e = byEngine[t.engine];
    e.pnl += t.pnl; e.n += 1;
    if (t.pnl > 0) e.wins += 1; else { e.losses += 1; if (t.pnl < e.maxLoss) e.maxLoss = t.pnl; }
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / days,
    maxDD,
    pf,
    wr,
    avgWin,
    avgLoss,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    numFills: closed.length,
    byEngine,
    trades: closed,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function main() {
  log("=".repeat(130));
  log("  SCALE-OUT / PARTIAL EXIT — GARCH long-only ($30) + REX ($15) portfolio");
  log("  Baseline: SL 0.15%, multi-stage trail 3/1 -> 9/0.5 -> 20/0.5");
  log("  Deployed OOS reference: $5.02/day, MDD $14.47");
  log("  Walk-forward IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03");
  log("=".repeat(130));

  log("\nLoading pairs...");
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
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168, atr1, rexSig20 },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  const baseCfg: Omit<Cfg, "exit"> = {
    label: "",
    marginA: 30,
    marginB: 15,
    slPct: 0.0015,
    aZL1: 2.0, aZL4: 1.5,
    aRegimeThr: 1.5,
    aMaxHoldH: 72,
    bMult: 2.0,
    bRegimeThr: 1.5,
    bMaxHoldH: 12,
  };

  const BASELINE_TRAIL: TrailStage[] = [
    { act: 3, dist: 1 },
    { act: 9, dist: 0.5 },
    { act: 20, dist: 0.5 },
  ];

  const exitConfigs: ExitCfg[] = [
    // BASELINE
    {
      label: "BASELINE: trail 3/1->9/0.5->20/0.5",
      partials: [],
      trailStages: BASELINE_TRAIL,
    },
    // 1
    {
      label: "1. 25% @ +2%, 25% @ +5%, runner trail 3/1->9/0.5->20/0.5",
      // 25% of orig, then 25% of orig from 75% remaining -> frac2 = 0.3333
      partials: [
        { kind: "fixed", trig: 2, frac: 0.25 },
        { kind: "fixed", trig: 5, frac: 0.3333 },
      ],
      trailStages: BASELINE_TRAIL,
    },
    // 2
    {
      label: "2. 33% @ +3%, 33% @ +9%, runner trail 20/0.5",
      // 33% orig, then 33% orig from 67% remaining -> frac2 = 0.5
      partials: [
        { kind: "fixed", trig: 3, frac: 0.3333 },
        { kind: "fixed", trig: 9, frac: 0.5 },
      ],
      trailStages: [{ act: 20, dist: 0.5 }],
    },
    // 3: Close 50% at peak-ref (fires once peak >= 5%, then 50% off), runner trails
    {
      label: "3. 50% once peak >= 5% (half-peak lock), runner trail 3/1->9/0.5->20/0.5",
      partials: [{ kind: "fixed", trig: 5, frac: 0.5 }],
      trailStages: BASELINE_TRAIL,
    },
    // 4
    {
      label: "4. 40% @ +6%, 30% @ +12%, runner trail 20/0.5",
      // 40% orig, then 30% orig from 60% remaining -> frac2 = 0.5
      partials: [
        { kind: "fixed", trig: 6, frac: 0.40 },
        { kind: "fixed", trig: 12, frac: 0.50 },
      ],
      trailStages: [{ act: 20, dist: 0.5 }],
    },
    // 5: ATR targets
    {
      label: "5. 50% @ 1xATR, 25% @ 2xATR, runner trail 3/1->9/0.5->20/0.5",
      // 50% orig, then 25% orig from 50% remaining -> frac2 = 0.5
      partials: [
        { kind: "atr", trig: 1, frac: 0.5 },
        { kind: "atr", trig: 2, frac: 0.5 },
      ],
      trailStages: BASELINE_TRAIL,
    },
    // 6: Clean TP @ +15%
    {
      label: "6. 100% TP @ +15% (no trail)",
      partials: [{ kind: "fixed", trig: 15, frac: 1.0 }],
      trailStages: [],
    },
    // 7: Clean TP @ +10%
    {
      label: "7. 100% TP @ +10% (no trail)",
      partials: [{ kind: "fixed", trig: 10, frac: 1.0 }],
      trailStages: [],
    },
    // 8: Clean TP @ +20%
    {
      label: "8. 100% TP @ +20% (no trail)",
      partials: [{ kind: "fixed", trig: 20, frac: 1.0 }],
      trailStages: [],
    },
    // 9: Hybrid — 50% @ +5% ONLY IF peak retraces 1% first
    {
      label: "9. Hybrid: 50% @ +5% gated by 1% retrace, trail 3/1->9/0.5->20/0.5",
      partials: [{ kind: "hybrid", trig: 5, frac: 0.5, minRetrace: 1 }],
      trailStages: BASELINE_TRAIL,
    },
    // Bonus: keep runner + add very early lock only
    {
      label: "10. Bonus: 25% @ +3% only, runner trail 3/1->9/0.5->20/0.5",
      partials: [{ kind: "fixed", trig: 3, frac: 0.25 }],
      trailStages: BASELINE_TRAIL,
    },
    {
      label: "11. Bonus: 20% @ +4%, 20% @ +8%, runner trail 3/1->9/0.5->20/0.5",
      // 20% orig, then 20% orig from 80% remaining -> frac2 = 0.25
      partials: [
        { kind: "fixed", trig: 4, frac: 0.20 },
        { kind: "fixed", trig: 8, frac: 0.25 },
      ],
      trailStages: BASELINE_TRAIL,
    },
  ];

  interface Rec {
    label: string;
    is: Res;
    oos: Res;
  }
  const recs: Rec[] = [];

  for (const exit of exitConfigs) {
    const cfg: Cfg = { ...baseCfg, label: exit.label, exit };
    log("\n" + "-".repeat(130));
    log(`  ${exit.label}`);
    log("-".repeat(130));
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(`  IS  $/day ${fmtD(is.dollarsPerDay).padStart(8)}  MDD $${is.maxDD.toFixed(2).padStart(6)}  PF ${is.pf.toFixed(2)}  WR ${is.wr.toFixed(1)}%  N=${is.numTrades}  A:${is.byEngine.A.n} B:${is.byEngine.B.n}  avgW ${fmtD(is.avgWin)}  avgL ${fmtD(is.avgLoss)}`);
    log(`  OOS $/day ${fmtD(oos.dollarsPerDay).padStart(8)}  MDD $${oos.maxDD.toFixed(2).padStart(6)}  PF ${oos.pf.toFixed(2)}  WR ${oos.wr.toFixed(1)}%  N=${oos.numTrades}  A:${oos.byEngine.A.n} B:${oos.byEngine.B.n}  avgW ${fmtD(oos.avgWin)}  avgL ${fmtD(oos.avgLoss)}`);
    log(`  OOS A: ${fmtD(oos.byEngine.A.pnl)} (${oos.byEngine.A.n})  B: ${fmtD(oos.byEngine.B.pnl)} (${oos.byEngine.B.n})  maxLoss ${fmtD(oos.maxSingleLoss)}`);
    recs.push({ label: exit.label, is, oos });
  }

  // Summary sorted by OOS $/day
  log("\n" + "=".repeat(130));
  log("  OOS SUMMARY — sorted by $/day descending");
  log("=".repeat(130));
  log(`${"Config".padEnd(62)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(6)} ${"avgW".padStart(8)} ${"avgL".padStart(8)}`);
  log("-".repeat(130));
  const sortedByPnl = [...recs].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  for (const r of sortedByPnl) {
    log(
      `${r.label.padEnd(62)} ` +
      `${fmtD(r.oos.dollarsPerDay).padStart(9)} ` +
      `${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ` +
      `${r.oos.pf.toFixed(2).padStart(6)} ` +
      `${r.oos.wr.toFixed(1).padStart(6)} ` +
      `${String(r.oos.numTrades).padStart(6)} ` +
      `${fmtD(r.oos.avgWin).padStart(8)} ` +
      `${fmtD(r.oos.avgLoss).padStart(8)}`
    );
  }

  // Sorted by MDD
  log("\n  OOS SUMMARY — sorted by MDD ascending (lowest drawdown first)");
  log("-".repeat(130));
  log(`${"Config".padEnd(62)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(6)}`);
  log("-".repeat(130));
  const sortedByMDD = [...recs].sort((a, b) => a.oos.maxDD - b.oos.maxDD);
  for (const r of sortedByMDD) {
    log(
      `${r.label.padEnd(62)} ` +
      `${fmtD(r.oos.dollarsPerDay).padStart(9)} ` +
      `${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ` +
      `${r.oos.pf.toFixed(2).padStart(6)} ` +
      `${r.oos.wr.toFixed(1).padStart(6)} ` +
      `${String(r.oos.numTrades).padStart(6)}`
    );
  }

  // IS vs OOS
  log("\n" + "=".repeat(130));
  log("  IS vs OOS CONSISTENCY (watch for overfitting)");
  log("=".repeat(130));
  log(`${"Config".padEnd(62)} ${"IS$/d".padStart(9)} ${"OOS$/d".padStart(9)} ${"ISMDD".padStart(8)} ${"OOSMDD".padStart(8)} ${"ISPF".padStart(6)} ${"OOSPF".padStart(6)}`);
  log("-".repeat(130));
  for (const r of recs) {
    log(
      `${r.label.padEnd(62)} ` +
      `${fmtD(r.is.dollarsPerDay).padStart(9)} ` +
      `${fmtD(r.oos.dollarsPerDay).padStart(9)} ` +
      `${("$" + r.is.maxDD.toFixed(0)).padStart(8)} ` +
      `${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ` +
      `${r.is.pf.toFixed(2).padStart(6)} ` +
      `${r.oos.pf.toFixed(2).padStart(6)}`
    );
  }

  // VERDICT
  log("\n" + "=".repeat(130));
  log("  VERDICT — vs in-run baseline & deployed reference ($5.02/day MDD $14.47)");
  log("=".repeat(130));

  const baseline = recs[0]!;
  log(`\n  In-run baseline: $/day ${fmtD(baseline.oos.dollarsPerDay)}  MDD $${baseline.oos.maxDD.toFixed(2)}  PF ${baseline.oos.pf.toFixed(2)}  N=${baseline.oos.numTrades}`);

  // Passing MDD < 14
  const passMDD = recs.filter(r => r.oos.maxDD < 14 && r.label !== baseline.label);
  passMDD.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  log(`\n  Configs with OOS MDD < $14 (${passMDD.length}):`);
  for (const r of passMDD) {
    const dpnl = r.oos.dollarsPerDay - baseline.oos.dollarsPerDay;
    const dmdd = r.oos.maxDD - baseline.oos.maxDD;
    log(`    ${r.label.padEnd(62)} $/day ${fmtD(r.oos.dollarsPerDay)} (Δ${fmtD(dpnl)})  MDD $${r.oos.maxDD.toFixed(0)} (Δ$${dmdd.toFixed(0)})  PF ${r.oos.pf.toFixed(2)}`);
  }

  // Configs beating baseline $/day
  const beatPnl = recs.filter(r => r.oos.dollarsPerDay > baseline.oos.dollarsPerDay && r.label !== baseline.label);
  beatPnl.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  log(`\n  Configs beating baseline $/day (${beatPnl.length}):`);
  for (const r of beatPnl) {
    const dpnl = r.oos.dollarsPerDay - baseline.oos.dollarsPerDay;
    const dmdd = r.oos.maxDD - baseline.oos.maxDD;
    log(`    ${r.label.padEnd(62)} $/day ${fmtD(r.oos.dollarsPerDay)} (+${fmtD(dpnl)})  MDD $${r.oos.maxDD.toFixed(0)} (Δ$${dmdd.toFixed(0)})  PF ${r.oos.pf.toFixed(2)}`);
  }

  // Risk-adj
  log("\n  BEST BY RISK-ADJ ($/day / MDD):");
  const ranked = [...recs]
    .filter(r => r.oos.maxDD > 0 && r.oos.dollarsPerDay > 0)
    .map(r => ({ r, score: r.oos.dollarsPerDay / r.oos.maxDD }))
    .sort((a, b) => b.score - a.score);
  for (const { r, score } of ranked.slice(0, 6)) {
    log(`    ${r.label.padEnd(62)} score ${score.toFixed(4)}  $/day ${fmtD(r.oos.dollarsPerDay)}  MDD $${r.oos.maxDD.toFixed(0)}  PF ${r.oos.pf.toFixed(2)}`);
  }

  // BEST MDD<14 winner summary
  log("\n" + "=".repeat(130));
  if (passMDD.length > 0) {
    const best = passMDD[0]!;
    const beatsBase = best.oos.dollarsPerDay > baseline.oos.dollarsPerDay;
    log(`  BEST @ MDD<$14: ${best.label}`);
    log(`    OOS: $/day ${fmtD(best.oos.dollarsPerDay)}  MDD $${best.oos.maxDD.toFixed(2)}  PF ${best.oos.pf.toFixed(2)}  WR ${best.oos.wr.toFixed(1)}%  N=${best.oos.numTrades}`);
    log(`    vs in-run baseline: ${beatsBase ? "BEATS" : "LOSES TO"} by ${fmtD(best.oos.dollarsPerDay - baseline.oos.dollarsPerDay)}/day`);
    log(`    vs deployed ref $5.02: ${best.oos.dollarsPerDay > 5.02 ? "BEATS" : "LOSES TO"} by $${(best.oos.dollarsPerDay - 5.02).toFixed(2)}/day`);
  } else {
    log(`  No scale-out config achieved MDD < $14 at these margins.`);
  }
  log("=".repeat(130));

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "scale-out.txt"), lines.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "scale-out.txt")}`);
}

main();
