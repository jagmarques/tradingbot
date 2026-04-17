/**
 * PORTFOLIO OPTIMIZATION — GARCH long-only + REX with NEW ATR regime filter.
 *
 * GOAL: Find optimal TOTAL portfolio margin at OOS MDD < $20, beating
 *       deployed A$30+B$15 (~$4.39/day projection).
 *
 * TASK:
 *   1) REX standalone with ATR regime at m$15/$20/$25/$30
 *   2) GARCH+REX portfolio with ATR regime at margin splits:
 *      A15+B15, A30+B15, A30+B20, A30+B25, A30+B30,
 *      A25+B25, A20+B20, A25+B15, A35+B15, A40+B10
 *   3) Correlation GARCH/REX PnL under ATR regime (daily buckets)
 *   4) Stricter GARCH regime (1.6, 1.8, 2.0) to see if PF improves at higher margin
 *
 * Entries/exits:
 *   GARCH long-only: z1h>2.0, z4h>1.5, SL 0.15%, multi-stage trail 3/1->9/0.5->20/0.5
 *                    block h22-23, max hold 72h
 *   REX: 1h range>=2*ATR14, close in upper/lower 25%, SL 0.15%, same multi-stage trail
 *        max hold 12h
 *   ATR regime: ATR14_1h / rolling-median-720h(ATR14) >= thr
 *
 * Walk-forward: IS 2025-06-01 -> 2025-12-01, OOS 2025-12-01 -> 2026-03-25.
 * Pairs: from /tmp/bt-pair-cache-5m, 97+ loaded.
 * Re-simulation: NO linear scaling. Every config is a real bar-by-bar sim.
 * Constraint: OOS MDD < $20.
 *
 * Output: .company/backtester/portfolio-atr.txt
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
// Simulator — GARCH long + REX, ATR regime, multi-stage trail
// ============================================================================

type Engine = "garch" | "rex";

interface Cfg {
  label: string;
  runGarch: boolean;
  runRex: boolean;
  marginGarch: number;
  marginRex: number;
  slPct: number;
  slSlipMult: number;
  trailStages: Array<[number, number]>;
  zL1: number; zL4: number;
  garchMaxHoldH: number;
  rexMult: number;
  rexMaxHoldH: number;
  atrThrGarch: number;    // ATR regime threshold for GARCH
  atrThrRex: number;      // ATR regime threshold for REX
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
  byEngine: Record<Engine, { pnl: number; n: number; wins: number; losses: number; maxLoss: number; pf: number; wr: number; }>;
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

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      if (cfg.runGarch && !openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) {
          if (atrRegimePasses(p, h1Idx, cfg.atrThrGarch)) {
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

      if (cfg.runRex && !openPositions.some(o => o.pair === p.name && o.engine === "rex")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          if (atrRegimePasses(p, h1Idx, cfg.atrThrRex)) {
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

  const byEngine: Record<Engine, { pnl: number; n: number; wins: number; losses: number; maxLoss: number; pf: number; wr: number; }> = {
    garch: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0, pf: 0, wr: 0 },
    rex: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0, pf: 0, wr: 0 },
  };
  for (const e of ["garch", "rex"] as Engine[]) {
    const list = closed.filter(t => t.engine === e);
    const w = list.filter(t => t.pnl > 0);
    const l = list.filter(t => t.pnl <= 0);
    const gp2 = w.reduce((s, t) => s + t.pnl, 0);
    const gl2 = Math.abs(l.reduce((s, t) => s + t.pnl, 0));
    byEngine[e].pnl = list.reduce((s, t) => s + t.pnl, 0);
    byEngine[e].n = list.length;
    byEngine[e].wins = w.length;
    byEngine[e].losses = l.length;
    byEngine[e].maxLoss = l.length > 0 ? Math.min(...l.map(t => t.pnl)) : 0;
    byEngine[e].pf = gl2 > 0 ? gp2 / gl2 : (gp2 > 0 ? Infinity : 0);
    byEngine[e].wr = list.length > 0 ? (w.length / list.length) * 100 : 0;
  }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
    trades: closed,
  };
}

// Daily correlation between engine PnL streams
function dailyCorrelation(trades: Tr[], startTs: number, endTs: number): { corr: number; nDays: number; } {
  const days = Math.ceil((endTs - startTs) / D);
  const gDaily = new Array(days).fill(0);
  const rDaily = new Array(days).fill(0);
  for (const t of trades) {
    const di = Math.floor((t.exitTs - startTs) / D);
    if (di < 0 || di >= days) continue;
    if (t.engine === "garch") gDaily[di] += t.pnl;
    else if (t.engine === "rex") rDaily[di] += t.pnl;
  }
  const n = days;
  const mG = gDaily.reduce((s, v) => s + v, 0) / n;
  const mR = rDaily.reduce((s, v) => s + v, 0) / n;
  let num = 0, dG = 0, dR = 0;
  for (let i = 0; i < n; i++) {
    const xg = gDaily[i] - mG;
    const xr = rDaily[i] - mR;
    num += xg * xr;
    dG += xg * xg;
    dR += xr * xr;
  }
  const denom = Math.sqrt(dG * dR);
  const corr = denom > 0 ? num / denom : 0;
  return { corr, nDays: n };
}

// ============================================================================
// Main
// ============================================================================

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const LINES: string[] = [];
function log(s = ""): void { console.log(s); LINES.push(s); }

function reportR(tag: string, r: Res): void {
  log(`  ${tag}: $/day ${fmtD(r.dollarsPerDay)}  total ${fmtD(r.totalPnl)}  MDD $${r.maxDD.toFixed(2)}  PF ${r.pf.toFixed(2)}  WR ${r.wr.toFixed(1)}%  N=${r.numTrades}  maxL ${fmtD(r.maxSingleLoss)}`);
  if (r.byEngine.garch.n > 0) log(`     garch: ${fmtD(r.byEngine.garch.pnl)} N=${r.byEngine.garch.n} PF ${r.byEngine.garch.pf.toFixed(2)} WR ${r.byEngine.garch.wr.toFixed(1)}%`);
  if (r.byEngine.rex.n > 0)   log(`     rex:   ${fmtD(r.byEngine.rex.pnl)} N=${r.byEngine.rex.n} PF ${r.byEngine.rex.pf.toFixed(2)} WR ${r.byEngine.rex.wr.toFixed(1)}%`);
}

function baseCfg(): Cfg {
  return {
    label: "",
    runGarch: false, runRex: false,
    marginGarch: 15, marginRex: 15,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
    zL1: 2.0, zL4: 1.5,
    garchMaxHoldH: 72,
    rexMult: 2.0,
    rexMaxHoldH: 12,
    atrThrGarch: 1.6,
    atrThrRex: 1.6,
  };
}

function main() {
  log("=".repeat(140));
  log("  PORTFOLIO OPTIMIZATION — GARCH long + REX with ATR regime");
  log("  Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03-25");
  log("  Constraint: OOS MDD < $20");
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
    const atrMed30 = computeRollingMedian(atr14, 720, 6);
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

  // ========================================================================
  // STEP 1 — REX standalone with ATR regime @ 1.6 across margins
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 1 — REX standalone with ATR regime (thr 1.6) across margins");
  log("  Entry: range>=2*ATR, close in extreme 25%, SL 0.15%, multi-stage trail, maxhold 12h");
  log("=".repeat(140));

  interface RexStep { margin: number; isR: Res; oosR: Res; }
  const rexSteps: RexStep[] = [];
  for (const m of [15, 20, 25, 30]) {
    const cfg: Cfg = { ...baseCfg(), label: `REX-ATR m$${m}`, runRex: true, marginRex: m, atrThrRex: 1.6 };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(`\n  [REX m$${m}]`);
    reportR("IS ", is);
    reportR("OOS", oos);
    rexSteps.push({ margin: m, isR: is, oosR: oos });
  }

  log("\n  REX scaling summary (OOS):");
  log("  margin | $/day   | MDD$   | PF    | WR%   | N");
  for (const s of rexSteps) {
    log(`  $${String(s.margin).padEnd(5)} | ${fmtD(s.oosR.dollarsPerDay).padStart(7)} | $${s.oosR.maxDD.toFixed(2).padStart(5)} | ${s.oosR.pf.toFixed(2).padStart(5)} | ${s.oosR.wr.toFixed(1).padStart(5)} | ${s.oosR.numTrades}`);
  }

  // Compare vs old RV claim
  log("\n  Old RV regime REX m$15 OOS claim: +$1.24/day MDD $12");
  const rex15 = rexSteps.find(s => s.margin === 15)!;
  log(`  New ATR regime REX m$15 OOS: ${fmtD(rex15.oosR.dollarsPerDay)}/day MDD $${rex15.oosR.maxDD.toFixed(2)}`);
  const delta = rex15.oosR.dollarsPerDay - 1.24;
  log(`  Delta vs RV: ${fmtD(delta)}/day, ${rex15.oosR.maxDD < 12 ? "LOWER" : "HIGHER"} MDD`);

  // ========================================================================
  // STEP 2 — GARCH+REX portfolio under ATR regime at margin splits
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 2 — GARCH+REX portfolio (ATR regime @ 1.6 for both engines)");
  log("=".repeat(140));

  const splits: Array<[number, number]> = [
    [15, 15], [30, 15], [30, 20], [30, 25], [30, 30],
    [25, 25], [20, 20], [25, 15], [35, 15], [40, 10],
  ];

  interface PortRes { a: number; b: number; is: Res; oos: Res; corrIS: number; corrOOS: number; }
  const ports: PortRes[] = [];
  for (const [a, b] of splits) {
    const cfg: Cfg = {
      ...baseCfg(),
      label: `A$${a}+B$${b}`,
      runGarch: true, runRex: true,
      marginGarch: a, marginRex: b,
      atrThrGarch: 1.6, atrThrRex: 1.6,
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    const corrIS = dailyCorrelation(is.trades, IS_S, IS_E).corr;
    const corrOOS = dailyCorrelation(oos.trades, OOS_S, OOS_E).corr;
    log(`\n  [A$${a}+B$${b}]`);
    reportR("IS ", is);
    reportR("OOS", oos);
    log(`     corr(daily) IS ${corrIS.toFixed(3)}  OOS ${corrOOS.toFixed(3)}`);
    ports.push({ a, b, is, oos, corrIS, corrOOS });
  }

  log("\n  PORTFOLIO SPLIT SUMMARY (OOS):");
  log("  A   | B   | Total | $/day   | MDD$   | PF    | WR%   | N    | corr  | valid(MDD<20)");
  for (const p of ports) {
    const total = p.a + p.b;
    const valid = p.oos.maxDD < 20 ? "YES" : "no";
    log(`  $${String(p.a).padEnd(3)} | $${String(p.b).padEnd(3)} | $${String(total).padEnd(4)} | ${fmtD(p.oos.dollarsPerDay).padStart(7)} | $${p.oos.maxDD.toFixed(2).padStart(5)} | ${p.oos.pf.toFixed(2).padStart(5)} | ${p.oos.wr.toFixed(1).padStart(5)} | ${String(p.oos.numTrades).padEnd(4)} | ${p.corrOOS.toFixed(2).padStart(5)} | ${valid}`);
  }

  // ========================================================================
  // STEP 3 — Stricter GARCH ATR regime thresholds (1.6, 1.8, 2.0)
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 3 — Stricter GARCH ATR regime at higher margins");
  log("  Test if tighter regime -> higher PF -> can go bigger margin under MDD<$20");
  log("=".repeat(140));

  interface RegRes { thr: number; margin: number; is: Res; oos: Res; }
  const regResults: RegRes[] = [];
  for (const thr of [1.6, 1.8, 2.0]) {
    for (const m of [30, 40, 50, 60]) {
      const cfg: Cfg = {
        ...baseCfg(),
        label: `GARCH-ATR${thr} m$${m}`,
        runGarch: true, runRex: false,
        marginGarch: m,
        atrThrGarch: thr,
      };
      const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      regResults.push({ thr, margin: m, is, oos });
    }
  }

  log("\n  GARCH standalone — ATR threshold sweep (OOS):");
  log("  ATRthr | margin | $/day   | MDD$   | PF    | WR%   | N    | valid");
  for (const r of regResults) {
    const valid = r.oos.maxDD < 20 ? "YES" : "no";
    log(`  ${r.thr.toFixed(1).padStart(6)} | $${String(r.margin).padEnd(6)} | ${fmtD(r.oos.dollarsPerDay).padStart(7)} | $${r.oos.maxDD.toFixed(2).padStart(5)} | ${r.oos.pf.toFixed(2).padStart(5)} | ${r.oos.wr.toFixed(1).padStart(5)} | ${String(r.oos.numTrades).padEnd(4)} | ${valid}`);
  }

  // ========================================================================
  // STEP 4 — Combine stricter GARCH regime with REX (portfolio)
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 4 — Combined portfolio with stricter GARCH ATR thr");
  log("  For each thr (1.6, 1.8, 2.0), sweep margin at (A, B) = (30,15), (40,15), (50,15), (60,15)");
  log("=".repeat(140));

  interface StrictPort { thrG: number; a: number; b: number; is: Res; oos: Res; corrOOS: number; }
  const strictPorts: StrictPort[] = [];
  for (const thrG of [1.6, 1.8, 2.0]) {
    for (const [a, b] of [[30, 15], [40, 15], [50, 15], [60, 15], [40, 20], [50, 20]] as Array<[number, number]>) {
      const cfg: Cfg = {
        ...baseCfg(),
        label: `GARCH${thrG}+REX A$${a}+B$${b}`,
        runGarch: true, runRex: true,
        marginGarch: a, marginRex: b,
        atrThrGarch: thrG, atrThrRex: 1.6,
      };
      const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      const corrOOS = dailyCorrelation(oos.trades, OOS_S, OOS_E).corr;
      strictPorts.push({ thrG, a, b, is, oos, corrOOS });
    }
  }

  log("\n  STRICT GARCH + REX PORTFOLIO (OOS):");
  log("  Gthr | A   | B   | $/day   | MDD$   | PF    | WR%   | N    | corr  | valid");
  for (const p of strictPorts) {
    const valid = p.oos.maxDD < 20 ? "YES" : "no";
    log(`  ${p.thrG.toFixed(1).padStart(4)} | $${String(p.a).padEnd(3)} | $${String(p.b).padEnd(3)} | ${fmtD(p.oos.dollarsPerDay).padStart(7)} | $${p.oos.maxDD.toFixed(2).padStart(5)} | ${p.oos.pf.toFixed(2).padStart(5)} | ${p.oos.wr.toFixed(1).padStart(5)} | ${String(p.oos.numTrades).padEnd(4)} | ${p.corrOOS.toFixed(2).padStart(5)} | ${valid}`);
  }

  // ========================================================================
  // FINAL — Best config under MDD<$20
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  FINAL VERDICT");
  log("=".repeat(140));

  interface Cand { label: string; dpd: number; mdd: number; pf: number; a: number; b: number; thrG: number; }
  const candidates: Cand[] = [];
  for (const p of ports) {
    if (p.oos.maxDD < 20) {
      candidates.push({ label: `A$${p.a}+B$${p.b} ATR1.6`, dpd: p.oos.dollarsPerDay, mdd: p.oos.maxDD, pf: p.oos.pf, a: p.a, b: p.b, thrG: 1.6 });
    }
  }
  for (const p of strictPorts) {
    if (p.oos.maxDD < 20) {
      candidates.push({ label: `A$${p.a}+B$${p.b} ATR${p.thrG}/1.6`, dpd: p.oos.dollarsPerDay, mdd: p.oos.maxDD, pf: p.oos.pf, a: p.a, b: p.b, thrG: p.thrG });
    }
  }
  candidates.sort((a, b) => b.dpd - a.dpd);

  log("\n  Candidates under OOS MDD<$20, sorted by $/day:");
  log("  rank | config                         | $/day   | MDD$   | PF");
  for (let i = 0; i < Math.min(10, candidates.length); i++) {
    const c = candidates[i]!;
    log(`  ${String(i + 1).padEnd(4)} | ${c.label.padEnd(30)} | ${fmtD(c.dpd).padStart(7)} | $${c.mdd.toFixed(2).padStart(5)} | ${c.pf.toFixed(2)}`);
  }

  if (candidates.length > 0) {
    const best = candidates[0]!;
    log(`\n  BEST CONFIG: ${best.label}`);
    log(`    OOS $/day: ${fmtD(best.dpd)}`);
    log(`    OOS MDD:   $${best.mdd.toFixed(2)}`);
    log(`    OOS PF:    ${best.pf.toFixed(2)}`);
    log(`    vs deployed A$30+B$15 (~$4.39/day projection): ${fmtD(best.dpd - 4.39)}/day delta`);
    if (best.dpd >= 5.0) log("    -> MEETS $5+/day TARGET");
    else log("    -> BELOW $5/day target; deployed config may remain best realistic option");
  } else {
    log("\n  NO CANDIDATES under MDD<$20. Deploy the lowest-MDD config manually.");
  }

  // REX ATR vs RV conclusion
  log("\n  REX ATR regime vs old RV regime:");
  log(`    ATR@1.6 m$15:  ${fmtD(rex15.oosR.dollarsPerDay)}/day  MDD $${rex15.oosR.maxDD.toFixed(2)}`);
  log(`    RV @1.5 m$15:  +$1.24/day          MDD $12.00 (from prior verify)`);
  if (rex15.oosR.dollarsPerDay > 1.24 && rex15.oosR.maxDD < 12) log("    -> ATR regime strictly better");
  else if (rex15.oosR.dollarsPerDay < 1.24 && rex15.oosR.maxDD > 12) log("    -> ATR regime strictly worse");
  else log("    -> mixed: one dimension better, other worse");

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "portfolio-atr.txt"), LINES.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "portfolio-atr.txt")}`);
}

main();
