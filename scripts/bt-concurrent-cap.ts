/**
 * CONCURRENT POSITION CAP TEST
 *
 * Tests whether capping max concurrent positions across the deployed 2-engine
 * portfolio reduces MDD meaningfully or just starves signal.
 *
 * DEPLOYED BASELINE (from .company/backtester/audit-atr.txt, Section 3):
 *   A: GARCH long-only, ATR1.8 regime, m$30, SL 0.15%, trail [3,1][9,0.5][20,0.5]
 *   B: Range Expansion, ATR1.6 regime, m$15, SL 0.15%, trail [3,1][9,0.5][20,0.5]
 *   Baseline OOS (verified): A+B ~ $5.02/day, MDD $14.47, PF 2.74
 *
 * HYPOTHESIS: At peak DD periods, bot may hold 10-20+ concurrent. Cap to 5-8
 *             might reduce MDD while costing little $/day (worst trades cluster).
 *
 * TEST MATRIX:
 *   - Global cap: Inf (baseline), 15, 12, 10, 8, 6, 5, 4, 3, 2
 *   - Per-engine cap: A10/B5, A8/B5, A5/B5
 *
 * FIFO rule: at each 1h entry tick, pairs are iterated in a deterministic order.
 * First signal in wins when multiple fire same bar. Entries that would exceed
 * the cap are rejected (not queued).
 *
 * Tracks per test:
 *   - OOS $/day vs baseline $5.02
 *   - OOS MDD vs baseline $14.47
 *   - Avg concurrent positions (time-weighted by m5 ticks)
 *   - Peak concurrent positions
 *   - % of signals rejected due to cap
 *
 * Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03-25
 * Output: .company/backtester/concurrent-cap.txt
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

// Hardened rolling median: strictly past window [i-window, i-1], stride=1.
function computeRollingMedianStrict(values: number[], window: number): number[] {
  const out = new Array(values.length).fill(0);
  if (values.length < window + 2) return out;
  for (let i = window; i < values.length; i++) {
    const slice: number[] = [];
    for (let j = i - window; j < i; j++) {
      const v = values[j]!;
      if (v > 0) slice.push(v);
    }
    if (slice.length < window / 4) { out[i] = 0; continue; }
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)]!;
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
// Simulator
// ============================================================================

type Engine = "A" | "B"; // A = GARCH long-only, B = Range Expansion

interface Cfg {
  label: string;
  marginA: number;
  marginB: number;
  slPct: number;
  slSlipMult: number;
  trailStages: Array<[number, number]>;
  zL1: number; zL4: number;
  aMaxHoldH: number;
  rexMult: number;
  bMaxHoldH: number;
  atrThrA: number;
  atrThrB: number;
  // concurrent caps
  maxTotal: number;     // Infinity for unlimited
  maxA: number;         // Infinity for unlimited
  maxB: number;         // Infinity for unlimited
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
}

interface Tr { engine: Engine; pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  maxSingleLoss: number; numTrades: number;
  // occupancy stats
  avgConcurrent: number;        // time-weighted over m5 ticks
  peakConcurrent: number;
  avgConcurrentA: number;
  avgConcurrentB: number;
  peakConcurrentA: number;
  peakConcurrentB: number;
  // cap rejection stats
  signalsA: number;
  signalsB: number;
  rejectedA: number;
  rejectedB: number;
  trades: Tr[];
}

function atrRegimePasses(p: PD, h1Idx: number, thr: number): boolean {
  const i = h1Idx - 1;
  const a = p.ind.atr14[i] ?? 0, b = p.ind.atrMed30[i] ?? 0;
  if (a === 0 || b === 0) return false;
  return a / b >= thr;
}

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

  const notA = (lev: number) => cfg.marginA * lev;
  const notB = (lev: number) => cfg.marginB * lev;

  // occupancy accumulators
  let tickCount = 0;
  let sumConcur = 0;
  let sumConcurA = 0;
  let sumConcurB = 0;
  let peakConcur = 0;
  let peakConcurA = 0;
  let peakConcurB = 0;

  // signal counters
  let signalsA = 0, signalsB = 0, rejectedA = 0, rejectedB = 0;

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    // ---- Exits (run every 5m tick for SL/trail/maxhold) ----
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
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    // ---- Entries (1h bar open, respecting blocked hours and caps) ----
    if (isH1 && !BLOCK.has(hour)) {
      // Iterate pairs in ALL_PAIRS deterministic order (FIFO: first signal in wins).
      for (const p of pairs) {
        const h1Idx = p.ind.h1Map.get(ts);
        if (h1Idx === undefined || h1Idx < 170) continue;

        // Count active A and B
        let curTotal = openPositions.length;
        let curA = 0, curB = 0;
        for (const o of openPositions) {
          if (o.engine === "A") curA++;
          else curB++;
        }

        // Engine A signal
        if (cfg.marginA > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "A")) {
          const z1 = p.ind.z1[h1Idx - 1]!;
          const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
          if (z1 > cfg.zL1 && z4 > cfg.zL4 && atrRegimePasses(p, h1Idx, cfg.atrThrA)) {
            signalsA++;
            if (curA < cfg.maxA && curTotal < cfg.maxTotal) {
              const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
              const sl = ep * (1 - cfg.slPct);
              openPositions.push({
                engine: "A", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: notA(p.lev), maxHoldH: cfg.aMaxHoldH,
              });
              curA++; curTotal++;
            } else {
              rejectedA++;
            }
          }
        }

        // Engine B signal
        if (cfg.marginB > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "B")) {
          const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
          if (sig !== 0 && atrRegimePasses(p, h1Idx, cfg.atrThrB)) {
            signalsB++;
            if (curB < cfg.maxB && curTotal < cfg.maxTotal) {
              const dir: "long" | "short" = sig > 0 ? "long" : "short";
              const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
              const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
              openPositions.push({
                engine: "B", pair: p.name, dir, ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: notB(p.lev), maxHoldH: cfg.bMaxHoldH,
              });
              curB++; curTotal++;
            } else {
              rejectedB++;
            }
          }
        }
      }
    }

    // ---- Occupancy sample (after entries/exits for this tick) ----
    tickCount++;
    const curTot = openPositions.length;
    let curA = 0, curB = 0;
    for (const o of openPositions) {
      if (o.engine === "A") curA++;
      else curB++;
    }
    sumConcur += curTot;
    sumConcurA += curA;
    sumConcurB += curB;
    if (curTot > peakConcur) peakConcur = curTot;
    if (curA > peakConcurA) peakConcurA = curA;
    if (curB > peakConcurB) peakConcurB = curB;
  }

  // close survivors
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

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    avgConcurrent: tickCount > 0 ? sumConcur / tickCount : 0,
    peakConcurrent: peakConcur,
    avgConcurrentA: tickCount > 0 ? sumConcurA / tickCount : 0,
    avgConcurrentB: tickCount > 0 ? sumConcurB / tickCount : 0,
    peakConcurrentA: peakConcurA,
    peakConcurrentB: peakConcurB,
    signalsA, signalsB, rejectedA, rejectedB,
    trades: closed,
  };
}

// ============================================================================
// Main
// ============================================================================

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }
function capLabel(v: number): string { return v === Infinity ? "inf" : String(v); }

const LINES: string[] = [];
function log(s = ""): void { console.log(s); LINES.push(s); }

function baseCfg(): Cfg {
  return {
    label: "",
    marginA: 30, marginB: 15,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
    zL1: 2.0, zL4: 1.5,
    aMaxHoldH: 72,
    rexMult: 2.0,
    bMaxHoldH: 12,
    atrThrA: 1.8,
    atrThrB: 1.6,
    maxTotal: Infinity,
    maxA: Infinity,
    maxB: Infinity,
  };
}

function reportCase(tag: string, r: Res, base?: Res): void {
  const ddpDelta = base ? ` (${fmtD(r.dollarsPerDay - base.dollarsPerDay)} vs base)` : "";
  const mddDelta = base ? ` (${(r.maxDD - base.maxDD >= 0 ? "+" : "") + "$" + (r.maxDD - base.maxDD).toFixed(2)})` : "";
  log(`  ${tag}:`);
  log(`    $/day: ${fmtD(r.dollarsPerDay).padStart(8)}${ddpDelta}`);
  log(`    MDD:   $${r.maxDD.toFixed(2).padStart(6)}${mddDelta}   PF ${r.pf.toFixed(2)}   WR ${r.wr.toFixed(1)}%   N=${r.numTrades}   maxL ${fmtD(r.maxSingleLoss)}`);
  log(`    Occupancy: avg ${r.avgConcurrent.toFixed(2)} (A ${r.avgConcurrentA.toFixed(2)} / B ${r.avgConcurrentB.toFixed(2)}), peak ${r.peakConcurrent} (A ${r.peakConcurrentA} / B ${r.peakConcurrentB})`);
  const sigA = r.signalsA, sigB = r.signalsB;
  const rA = r.rejectedA, rB = r.rejectedB;
  const pctA = sigA > 0 ? (100 * rA / sigA).toFixed(1) : "0.0";
  const pctB = sigB > 0 ? (100 * rB / sigB).toFixed(1) : "0.0";
  const pctT = (sigA + sigB) > 0 ? (100 * (rA + rB) / (sigA + sigB)).toFixed(1) : "0.0";
  log(`    Signals: A ${sigA} (rej ${rA}, ${pctA}%), B ${sigB} (rej ${rB}, ${pctB}%), total rejected ${pctT}%`);
}

function main() {
  log("=".repeat(140));
  log("  CONCURRENT POSITION CAP TEST — Deployed 2-Engine Portfolio");
  log("  A: GARCH long-only, ATR1.8, m$30  |  B: Range Expansion, ATR1.6, m$15");
  log("  SL 0.15%, trail [3,1][9,0.5][20,0.5], block h22-23, IS Jun-Dec 2025, OOS Dec 2025 - Mar 25 2026");
  log("  Baseline OOS target: $/day +$5.02, MDD $14.47, PF 2.74");
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
    const atr14 = computeATR(h1, 14);
    const atrMed30 = computeRollingMedianStrict(atr14, 720);
    const rexSig20 = computeRangeExpansion(h1, atr14, 2.0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, atr14, atrMed30, rexSig20 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  // --------------------------------------------------------------------------
  // Baseline (unlimited) — anchor
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  BASELINE — unlimited concurrent (deployed config)");
  log("=".repeat(140));
  const baseCase: Cfg = { ...baseCfg(), label: "baseline-uncapped" };
  const baseIS = simulate(pairs, baseCase, IS_S, IS_E, IS_D);
  const baseOOS = simulate(pairs, baseCase, OOS_S, OOS_E, OOS_D);
  log("\n  [baseline]");
  reportCase("IS ", baseIS);
  reportCase("OOS", baseOOS);

  // --------------------------------------------------------------------------
  // Global cap sweep
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 1 — Global concurrent cap sweep (cap = total open positions across A+B)");
  log("=".repeat(140));

  const globalCaps = [15, 12, 10, 8, 6, 5, 4, 3, 2];
  interface GlobalRec { cap: number; is: Res; oos: Res; }
  const globalRecs: GlobalRec[] = [];

  for (const cap of globalCaps) {
    const cfg: Cfg = { ...baseCfg(), label: `cap-total-${cap}`, maxTotal: cap };
    log(`\n  --- Global cap = ${cap} ---`);
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    reportCase("IS ", is, baseIS);
    reportCase("OOS", oos, baseOOS);
    globalRecs.push({ cap, is, oos });
  }

  // --------------------------------------------------------------------------
  // Per-engine cap tests
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 2 — Per-engine caps (maxA + maxB, no global cap)");
  log("=".repeat(140));

  interface PerEngineCase { label: string; maxA: number; maxB: number; }
  const perEngineCases: PerEngineCase[] = [
    { label: "A10_B5",  maxA: 10, maxB: 5 },
    { label: "A8_B5",   maxA: 8,  maxB: 5 },
    { label: "A5_B5",   maxA: 5,  maxB: 5 },
  ];

  interface PerEngineRec { c: PerEngineCase; is: Res; oos: Res; }
  const perEngineRecs: PerEngineRec[] = [];

  for (const pe of perEngineCases) {
    const cfg: Cfg = { ...baseCfg(), label: pe.label, maxA: pe.maxA, maxB: pe.maxB };
    log(`\n  --- A<=${pe.maxA}, B<=${pe.maxB} ---`);
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    reportCase("IS ", is, baseIS);
    reportCase("OOS", oos, baseOOS);
    perEngineRecs.push({ c: pe, is, oos });
  }

  // --------------------------------------------------------------------------
  // Summary tables
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SUMMARY — OOS numbers vs baseline (unlimited)");
  log("=".repeat(140));
  log(`  Baseline OOS: $/day ${fmtD(baseOOS.dollarsPerDay)}, MDD $${baseOOS.maxDD.toFixed(2)}, PF ${baseOOS.pf.toFixed(2)}, avg ${baseOOS.avgConcurrent.toFixed(2)}, peak ${baseOOS.peakConcurrent}, N=${baseOOS.numTrades}`);
  log("");
  log(`${"Config".padEnd(14)} ${"$/day".padStart(9)} ${"d$/day".padStart(9)} ${"MDD".padStart(8)} ${"dMDD".padStart(8)} ${"PF".padStart(6)} ${"N".padStart(5)} ${"avgC".padStart(6)} ${"peakC".padStart(6)} ${"rej%".padStart(7)}`);
  log("-".repeat(140));

  function sumLine(tag: string, r: Res, base: Res): string {
    const sig = r.signalsA + r.signalsB;
    const rej = r.rejectedA + r.rejectedB;
    const pct = sig > 0 ? (100 * rej / sig) : 0;
    return (
      `${tag.padEnd(14)} ` +
      `${fmtD(r.dollarsPerDay).padStart(9)} ` +
      `${fmtD(r.dollarsPerDay - base.dollarsPerDay).padStart(9)} ` +
      `${("$" + r.maxDD.toFixed(2)).padStart(8)} ` +
      `${((r.maxDD - base.maxDD >= 0 ? "+" : "-") + "$" + Math.abs(r.maxDD - base.maxDD).toFixed(2)).padStart(8)} ` +
      `${r.pf.toFixed(2).padStart(6)} ` +
      `${String(r.numTrades).padStart(5)} ` +
      `${r.avgConcurrent.toFixed(1).padStart(6)} ` +
      `${String(r.peakConcurrent).padStart(6)} ` +
      `${(pct.toFixed(1) + "%").padStart(7)}`
    );
  }

  log(sumLine("baseline", baseOOS, baseOOS));
  for (const g of globalRecs) log(sumLine(`cap=${g.cap}`, g.oos, baseOOS));
  for (const pe of perEngineRecs) log(sumLine(pe.c.label, pe.oos, baseOOS));

  // --------------------------------------------------------------------------
  // Verdict
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  VERDICT");
  log("=".repeat(140));

  interface Cand { label: string; oos: Res; }
  const all: Cand[] = [
    { label: "baseline", oos: baseOOS },
    ...globalRecs.map(g => ({ label: `cap=${g.cap}`, oos: g.oos })),
    ...perEngineRecs.map(pe => ({ label: pe.c.label, oos: pe.oos })),
  ];

  const targetCaps = all.filter(c => c.label !== "baseline" && c.oos.maxDD <= 10.0);
  if (targetCaps.length === 0) {
    log("  No cap brought OOS MDD <= $10. Showing best MDD reductions:");
    const sorted = [...all].filter(c => c.label !== "baseline").sort((a, b) => a.oos.maxDD - b.oos.maxDD);
    for (const c of sorted.slice(0, 5)) {
      const dpDelta = c.oos.dollarsPerDay - baseOOS.dollarsPerDay;
      const mddDelta = c.oos.maxDD - baseOOS.maxDD;
      log(`    ${c.label.padEnd(14)}  $/day ${fmtD(c.oos.dollarsPerDay)} (${fmtD(dpDelta)})  MDD $${c.oos.maxDD.toFixed(2)} (${mddDelta >= 0 ? "+" : ""}${mddDelta.toFixed(2)})  PF ${c.oos.pf.toFixed(2)}`);
    }
  } else {
    targetCaps.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
    log("  Caps meeting OOS MDD <= $10 (sorted by $/day desc):");
    for (const c of targetCaps) {
      const dpDelta = c.oos.dollarsPerDay - baseOOS.dollarsPerDay;
      const mddDelta = c.oos.maxDD - baseOOS.maxDD;
      log(`    ${c.label.padEnd(14)}  $/day ${fmtD(c.oos.dollarsPerDay)} (${fmtD(dpDelta)})  MDD $${c.oos.maxDD.toFixed(2)} (${mddDelta >= 0 ? "+" : ""}${mddDelta.toFixed(2)})  PF ${c.oos.pf.toFixed(2)}  N=${c.oos.numTrades}`);
    }
    const best = targetCaps[0]!;
    log(`\n  BEST CAP (MDD<=$10, max $/day): ${best.label}`);
    log(`    $/day: ${fmtD(best.oos.dollarsPerDay)}  (base ${fmtD(baseOOS.dollarsPerDay)}, delta ${fmtD(best.oos.dollarsPerDay - baseOOS.dollarsPerDay)})`);
    log(`    MDD:   $${best.oos.maxDD.toFixed(2)}  (base $${baseOOS.maxDD.toFixed(2)}, delta ${(best.oos.maxDD - baseOOS.maxDD).toFixed(2)})`);
    log(`    PF:    ${best.oos.pf.toFixed(2)}`);
    log(`    N:     ${best.oos.numTrades}`);
    log(`    avg occupancy ${best.oos.avgConcurrent.toFixed(2)}, peak ${best.oos.peakConcurrent}`);
  }

  // Also highlight the "knee" — lowest cap that still retains >=80% of baseline $/day
  log("");
  const knee = all
    .filter(c => c.label !== "baseline" && c.oos.dollarsPerDay >= 0.8 * baseOOS.dollarsPerDay)
    .sort((a, b) => a.oos.maxDD - b.oos.maxDD);
  if (knee.length > 0) {
    const k = knee[0]!;
    log(`  KNEE POINT (>=80% baseline $/day, lowest MDD): ${k.label}`);
    log(`    $/day ${fmtD(k.oos.dollarsPerDay)} (${((100 * k.oos.dollarsPerDay / baseOOS.dollarsPerDay) || 0).toFixed(1)}% of base)`);
    log(`    MDD $${k.oos.maxDD.toFixed(2)} (base $${baseOOS.maxDD.toFixed(2)}, -$${(baseOOS.maxDD - k.oos.maxDD).toFixed(2)})`);
  }

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "concurrent-cap.txt"), LINES.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "concurrent-cap.txt")}`);
}

main();
