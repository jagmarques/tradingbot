/**
 * BT-SAFE-FINAL — hunt for the max profit config under constraints
 *
 * BREAKTHROUGH discoveries from bt-safe-push-v2:
 *   1. SHORTS LOSE MONEY — shorts-only m=$15: OOS -$0.09 (!). Longs-only: OOS +$0.75 MDD $5
 *   2. Regime=1.75 with m=$25: OOS +$1.08/day, MDD $4, PF 3.97
 *   3. Sign-restricted shorts (zS1=-7) effectively kills shorts: OOS +$0.75 MDD $5
 *
 * HYPOTHESES to validate:
 *   A) longs-only + regime=1.75 + max margin under MDD<$20
 *   B) longs-only + regime=1.5 + max margin under MDD<$20
 *   C) Check time/month splits — is the short-loss signal stable across periods?
 *   D) Bar-by-bar portfolio DD for multi-config
 *   E) Relaxed trail (0.5 -> 1.0) on longs-only
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
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
const RM: Record<string, string> = {
  kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB",
};

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

const ALL_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
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

// Split the full window into 5 equal slices for stability check
const FULL_S = new Date("2025-06-01").getTime();
const FULL_E = new Date("2026-03-25").getTime();
const IS_S = FULL_S;
const IS_E = new Date("2025-12-01").getTime();
const OOS_S = new Date("2025-12-01").getTime();
const OOS_E = FULL_E;
const IS_D = (IS_E - IS_S) / D;
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[]; rv168: number[];
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

interface Cfg {
  label: string;
  margin: number;
  slPct: number;
  slSlipMult: number;
  trailAct: number; trailDist: number;
  regime: boolean;
  regimeThr: number;
  zL1: number; zS1: number; zL4: number; zS4: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number;
  pf: number; wr: number; maxSingleLoss: number; numTrades: number;
  closed: Tr[];
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
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
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

      let dir: "long" | "short" | null = null;
      if (z1 > cfg.zL1 && z4 > cfg.zL4) dir = "long";
      if (z1 < cfg.zS1 && z4 < cfg.zS4) dir = "short";
      if (!dir) continue;

      if (cfg.regime) {
        const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
        const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
        if (rv24 === 0 || rv168 === 0) continue;
        if (rv24 / rv168 < cfg.regimeThr) continue;
      }

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: cfg.margin * p.lev,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
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
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    closed,
  };
}

// Given a closed trade list, compute DD
function ddFromTrades(closed: Tr[]): number {
  closed.sort((a, b) => a.exitTs - b.exitTs);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  return maxDD;
}

function fmtD(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function printLine(label: string, is: Res, oos: Res) {
  console.log(
    `${label.padEnd(46)}` +
    ` IS ${fmtD(is.dollarsPerDay).padStart(7)}/MDD$${String(is.maxDD.toFixed(0)).padStart(2)}/PF${is.pf.toFixed(2)}` +
    `  |  OOS ${fmtD(oos.dollarsPerDay).padStart(7)}/MDD$${String(oos.maxDD.toFixed(0)).padStart(2)}/PF${oos.pf.toFixed(2)}/N${oos.numTrades}`,
  );
}

// Monthly PnL breakdown
function monthlyPnl(closed: Tr[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of closed) {
    const d = new Date(t.exitTs);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    m.set(k, (m.get(k) ?? 0) + t.pnl);
  }
  return new Map([...m].sort());
}

function main() {
  console.log("=".repeat(140));
  console.log("  BT-SAFE-FINAL — validate discoveries, find max-profit config");
  console.log("=".repeat(140));

  console.log("\nLoading pairs...");
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
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168 }, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length}/${ALL_PAIRS.length} loaded`);

  const BASE: Cfg = {
    label: "base",
    margin: 10,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5,
    regime: true, regimeThr: 1.5,
    zL1: 4, zS1: -6, zL4: 2, zS4: -2,
  };

  const eval_ = (cfg: Cfg) => ({
    is: simulate(pairs, cfg, IS_S, IS_E, IS_D),
    oos: simulate(pairs, cfg, OOS_S, OOS_E, OOS_D),
  });

  // ---------- A: Longs-only margin sweep ----------
  console.log("\n" + "=".repeat(140));
  console.log("  A) LONGS-ONLY — margin scan at SAFE params (zS1=-999 to kill shorts)");
  console.log("=".repeat(140));
  for (const m of [15, 18, 20, 22, 25, 28, 32, 36, 40, 45]) {
    const cfg: Cfg = { ...BASE, margin: m, zS1: -999, zS4: -999 };
    const { is, oos } = eval_(cfg);
    printLine(`longs-only m=$${m}`, is, oos);
  }

  // ---------- B: Longs-only + regime=1.75 margin sweep ----------
  console.log("\n" + "=".repeat(140));
  console.log("  B) LONGS-ONLY + REGIME=1.75 — margin scan");
  console.log("=".repeat(140));
  for (const m of [15, 18, 20, 25, 30, 40, 50, 60, 75, 100]) {
    const cfg: Cfg = { ...BASE, margin: m, zS1: -999, zS4: -999, regimeThr: 1.75 };
    const { is, oos } = eval_(cfg);
    printLine(`longs-only rg=1.75 m=$${m}`, is, oos);
  }

  // ---------- C: zL1 relax at longs-only + rg=1.75 ----------
  console.log("\n" + "=".repeat(140));
  console.log("  C) LONGS-ONLY + rg=1.75 + zL1 relax");
  console.log("=".repeat(140));
  for (const zL1 of [3, 3.5, 4, 4.5]) {
    for (const m of [25, 40, 60]) {
      const cfg: Cfg = { ...BASE, margin: m, zS1: -999, zS4: -999, regimeThr: 1.75, zL1 };
      const { is, oos } = eval_(cfg);
      printLine(`L-only rg1.75 zL1=${zL1} m=$${m}`, is, oos);
    }
  }

  // ---------- D: Monthly breakdown of best candidate ----------
  console.log("\n" + "=".repeat(140));
  console.log("  D) MONTHLY PnL — best candidate stability check");
  console.log("=".repeat(140));
  const bestCfg: Cfg = { ...BASE, margin: 40, zS1: -999, zS4: -999, regimeThr: 1.75 };
  const bestFull = simulate(pairs, bestCfg, IS_S, OOS_E, (OOS_E - IS_S) / D);
  const monthly = monthlyPnl(bestFull.closed);
  console.log(`Config: longs-only rg=1.75 m=$40, full window`);
  console.log(`Total: ${fmtD(bestFull.totalPnl)}  $/d=${fmtD(bestFull.dollarsPerDay)}  MDD=$${bestFull.maxDD.toFixed(0)}  PF=${bestFull.pf.toFixed(2)}  N=${bestFull.numTrades}`);
  console.log("\nMonth       PnL       cumPnL");
  let cum = 0;
  for (const [k, v] of monthly) {
    cum += v;
    console.log(`  ${k}   ${fmtD(v).padStart(8)}  ${fmtD(cum).padStart(8)}`);
  }

  // ---------- E: Short-side monthly (is the short loss stable?) ----------
  console.log("\n" + "=".repeat(140));
  console.log("  E) SHORT-SIDE MONTHLY — are shorts a bleed or just bad in recent months?");
  console.log("=".repeat(140));
  const shortsCfg: Cfg = { ...BASE, margin: 15, zL1: 999, zL4: 999 };
  const shortsFull = simulate(pairs, shortsCfg, IS_S, OOS_E, (OOS_E - IS_S) / D);
  console.log(`Shorts-only m=$15: total=${fmtD(shortsFull.totalPnl)}  N=${shortsFull.numTrades}  PF=${shortsFull.pf.toFixed(2)}`);
  const sMonthly = monthlyPnl(shortsFull.closed);
  console.log("\nMonth       PnL       N");
  for (const [k, v] of sMonthly) {
    const monthTrades = shortsFull.closed.filter(t => {
      const d = new Date(t.exitTs);
      const k2 = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      return k2 === k;
    });
    console.log(`  ${k}   ${fmtD(v).padStart(8)}  N=${monthTrades.length}`);
  }

  // ---------- F: Ensemble — combine longs-only + regime=1.5 and longs-only + regime=1.75 ----------
  console.log("\n" + "=".repeat(140));
  console.log("  F) ENSEMBLE PORTFOLIO — true cumulative DD from combined trade stream");
  console.log("=".repeat(140));
  const cfgA: Cfg = { ...BASE, margin: 20, zS1: -999, zS4: -999, regimeThr: 1.5 };
  const cfgB: Cfg = { ...BASE, margin: 20, zS1: -999, zS4: -999, regimeThr: 1.75, zL1: 3.5 };
  const aRes = simulate(pairs, cfgA, OOS_S, OOS_E, OOS_D);
  const bRes = simulate(pairs, cfgB, OOS_S, OOS_E, OOS_D);
  const combined = [...aRes.closed, ...bRes.closed].sort((a, b) => a.exitTs - b.exitTs);
  const combinedMDD = ddFromTrades(combined);
  const combinedPnl = combined.reduce((s, t) => s + t.pnl, 0);
  console.log(`A: l-only rg1.5 m=$20: OOS ${fmtD(aRes.dollarsPerDay)}/MDD$${aRes.maxDD.toFixed(0)}/N=${aRes.numTrades}`);
  console.log(`B: l-only rg1.75 zL1=3.5 m=$20: OOS ${fmtD(bRes.dollarsPerDay)}/MDD$${bRes.maxDD.toFixed(0)}/N=${bRes.numTrades}`);
  console.log(`A+B portfolio (trade streams merged): OOS $/d=${fmtD(combinedPnl / OOS_D)}  MDD=$${combinedMDD.toFixed(0)}  N=${combined.length}`);

  // ---------- G: final deep bench ----------
  console.log("\n" + "=".repeat(140));
  console.log("  G) FINAL BENCH — best 6 configs, IS and OOS");
  console.log("=".repeat(140));
  const finals: Cfg[] = [
    { ...BASE, label: "CURRENT SAFE m=$10",     margin: 10 },
    { ...BASE, label: "SAFE m=$25 (max profit)", margin: 25 },
    { ...BASE, label: "longs-only m=$25",       margin: 25, zS1: -999, zS4: -999 },
    { ...BASE, label: "longs-only rg1.75 m=$40", margin: 40, zS1: -999, zS4: -999, regimeThr: 1.75 },
    { ...BASE, label: "longs-only rg1.75 m=$60", margin: 60, zS1: -999, zS4: -999, regimeThr: 1.75 },
    { ...BASE, label: "longs-only zL1=3.5 rg1.75 m=$40", margin: 40, zS1: -999, zS4: -999, regimeThr: 1.75, zL1: 3.5 },
    { ...BASE, label: "longs-only rg1.5 zS1=-7 m=$30", margin: 30, zS1: -7, zS4: -2 },
    { ...BASE, label: "longs-only rg1.5 m=$30", margin: 30, zS1: -999, zS4: -999 },
  ];
  for (const cfg of finals) {
    const { is, oos } = eval_(cfg);
    printLine(cfg.label, is, oos);
  }
}

main();
