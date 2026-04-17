/**
 * PAIR QUALITY FILTER — GARCH long-only + REX portfolio (A$15 + B$15)
 *
 * Walk-forward pair selection:
 *   IS 2025-06 -> 2025-12 picks pairs (by per-pair PnL per engine)
 *   OOS 2025-12 -> 2026-03 validates
 *
 * Tests:
 *   1. Symmetric filter     — same pair set for both engines (top-20/30/40/50/60/80)
 *   2. Independent filter   — each engine picks its own top-N pairs
 *   3. Exclude-worst filter — remove bottom 10/20/30 pairs from both engines
 *   4. Baseline             — all pairs (reference)
 *
 * Baseline to beat: OOS $2.41/day @ MDD $15 (all 124 pairs).
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

interface Cfg {
  marginA: number;
  marginB: number;
  slPct: number;
  trailAct: number;
  trailDist: number;
  aZL1: number; aZL4: number;
  aRegime: boolean; aRegimeThr: number;
  aMaxHoldH: number;
  bMult: number;
  bRegime: boolean; bRegimeThr: number;
  bMaxHoldH: number;
  // pair filter sets — if non-null, only these pair names trade for that engine
  pairsA?: Set<string> | null;
  pairsB?: Set<string> | null;
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
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

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) { xp = bar.c; reason = "trail"; }
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

      // Engine A — GARCH long-only loose
      const aAllowed = cfg.pairsA ? cfg.pairsA.has(p.name) : true;
      if (cfg.marginA > 0 && aAllowed && !openPositions.some(o => o.pair === p.name && o.engine === "A")) {
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
            });
          }
        }
      }

      // Engine B — Range Expansion
      const bAllowed = cfg.pairsB ? cfg.pairsB.has(p.name) : true;
      if (cfg.marginB > 0 && bAllowed && !openPositions.some(o => o.pair === p.name && o.engine === "B")) {
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
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
    trades: closed,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function perPairPnl(trades: Tr[], engine: Engine): Map<string, { pnl: number; n: number }> {
  const m = new Map<string, { pnl: number; n: number }>();
  for (const t of trades) {
    if (t.engine !== engine) continue;
    const e = m.get(t.pair) ?? { pnl: 0, n: 0 };
    e.pnl += t.pnl; e.n += 1;
    m.set(t.pair, e);
  }
  return m;
}

function topNPairs(pairPnl: Map<string, { pnl: number; n: number }>, allPairs: string[], n: number): Set<string> {
  // Include pairs with trades, ranked by total PnL; if fewer than N have trades, fall back to including
  // remaining untested pairs at the bottom (they were zero in IS — safe to exclude).
  const ranked: [string, number][] = [];
  for (const p of allPairs) {
    const e = pairPnl.get(p);
    ranked.push([p, e ? e.pnl : 0]);
  }
  ranked.sort((a, b) => b[1] - a[1]);
  return new Set(ranked.slice(0, n).map(r => r[0]));
}

function excludeWorstN(pairPnl: Map<string, { pnl: number; n: number }>, allPairs: string[], n: number): Set<string> {
  const ranked: [string, number][] = [];
  for (const p of allPairs) {
    const e = pairPnl.get(p);
    ranked.push([p, e ? e.pnl : 0]);
  }
  ranked.sort((a, b) => a[1] - b[1]); // ascending
  const excluded = new Set(ranked.slice(0, n).map(r => r[0]));
  return new Set(allPairs.filter(p => !excluded.has(p)));
}

function main() {
  log("=".repeat(130));
  log("  PAIR QUALITY FILTER — GARCH long-only (A) + REX (B) portfolio");
  log("  Walk-forward: IS 2025-06 -> 2025-12 picks pairs, OOS 2025-12 -> 2026-03 validates");
  log("  Baseline to beat: OOS $2.41/day @ MDD $15 (all pairs)");
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
  const loadedNames = pairs.map(p => p.name);

  const baseCfg: Omit<Cfg, "pairsA" | "pairsB"> = {
    marginA: 15, marginB: 15,
    slPct: 0.0015,
    trailAct: 9,
    trailDist: 0.5,
    aZL1: 2.0, aZL4: 1.5,
    aRegime: true, aRegimeThr: 1.5,
    aMaxHoldH: 72,
    bMult: 2.0,
    bRegime: true, bRegimeThr: 1.5,
    bMaxHoldH: 12,
  };

  // Step 1: Run baseline on IS AND OOS
  log("\n" + "=".repeat(130));
  log("  STEP 1 — Baseline (all pairs) IS + OOS");
  log("=".repeat(130));
  const baseIS = simulate(pairs, { ...baseCfg, pairsA: null, pairsB: null }, IS_S, IS_E, IS_D);
  const baseOOS = simulate(pairs, { ...baseCfg, pairsA: null, pairsB: null }, OOS_S, OOS_E, OOS_D);
  log(`  IS  : $/day ${fmtD(baseIS.dollarsPerDay)}  MDD $${baseIS.maxDD.toFixed(2)}  PF ${baseIS.pf.toFixed(2)}  N=${baseIS.numTrades}  A:${baseIS.byEngine.A.n} B:${baseIS.byEngine.B.n}`);
  log(`  OOS : $/day ${fmtD(baseOOS.dollarsPerDay)}  MDD $${baseOOS.maxDD.toFixed(2)}  PF ${baseOOS.pf.toFixed(2)}  N=${baseOOS.numTrades}  A:${baseOOS.byEngine.A.n} B:${baseOOS.byEngine.B.n}`);

  // Step 2: Per-pair IS PnL ranking
  log("\n" + "=".repeat(130));
  log("  STEP 2 — Per-pair IS PnL ranking");
  log("=".repeat(130));
  const ppA = perPairPnl(baseIS.trades, "A");
  const ppB = perPairPnl(baseIS.trades, "B");
  // Combined per-pair
  const ppCombined = new Map<string, { pnl: number; n: number }>();
  for (const p of loadedNames) {
    const a = ppA.get(p) ?? { pnl: 0, n: 0 };
    const b = ppB.get(p) ?? { pnl: 0, n: 0 };
    ppCombined.set(p, { pnl: a.pnl + b.pnl, n: a.n + b.n });
  }

  const sortedCombined = [...ppCombined.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  const sortedA = [...loadedNames].map(p => [p, ppA.get(p) ?? { pnl: 0, n: 0 }] as const).sort((a, b) => b[1].pnl - a[1].pnl);
  const sortedB = [...loadedNames].map(p => [p, ppB.get(p) ?? { pnl: 0, n: 0 }] as const).sort((a, b) => b[1].pnl - a[1].pnl);

  log("\n  Top 15 pairs by COMBINED IS PnL:");
  for (let i = 0; i < Math.min(15, sortedCombined.length); i++) {
    const [n, v] = sortedCombined[i]!;
    const a = ppA.get(n) ?? { pnl: 0, n: 0 };
    const b = ppB.get(n) ?? { pnl: 0, n: 0 };
    log(`    ${String(i + 1).padStart(2)}. ${n.padEnd(10)} total ${fmtD(v.pnl).padStart(8)}  A ${fmtD(a.pnl).padStart(8)} (${a.n})  B ${fmtD(b.pnl).padStart(8)} (${b.n})`);
  }
  log("\n  Bottom 15 pairs by COMBINED IS PnL:");
  for (let i = 0; i < Math.min(15, sortedCombined.length); i++) {
    const [n, v] = sortedCombined[sortedCombined.length - 1 - i]!;
    const a = ppA.get(n) ?? { pnl: 0, n: 0 };
    const b = ppB.get(n) ?? { pnl: 0, n: 0 };
    log(`    ${String(i + 1).padStart(2)}. ${n.padEnd(10)} total ${fmtD(v.pnl).padStart(8)}  A ${fmtD(a.pnl).padStart(8)} (${a.n})  B ${fmtD(b.pnl).padStart(8)} (${b.n})`);
  }

  // Step 3: Symmetric filter — same pair set both engines, by combined PnL
  log("\n" + "=".repeat(130));
  log("  STEP 3 — SYMMETRIC FILTER (top-N by combined IS PnL, applied to both engines)");
  log("=".repeat(130));
  log(`${"N".padStart(5)} ${"$/day IS".padStart(10)} ${"$/day OOS".padStart(11)} ${"IS MDD".padStart(8)} ${"OOS MDD".padStart(9)} ${"OOS PF".padStart(8)} ${"OOS N".padStart(7)} ${"A/B".padStart(10)}`);
  log("-".repeat(130));
  interface Row { label: string; oosDay: number; oosMDD: number; oosPF: number; oosN: number; }
  const symRows: Row[] = [];
  for (const N of [20, 30, 40, 50, 60, 80]) {
    const sel = topNPairs(ppCombined, loadedNames, N);
    const cfg: Cfg = { ...baseCfg, pairsA: sel, pairsB: sel };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(
      `${String(N).padStart(5)} ${fmtD(is.dollarsPerDay).padStart(10)} ${fmtD(oos.dollarsPerDay).padStart(11)} ` +
      `${("$" + is.maxDD.toFixed(0)).padStart(8)} ${("$" + oos.maxDD.toFixed(0)).padStart(9)} ` +
      `${oos.pf.toFixed(2).padStart(8)} ${String(oos.numTrades).padStart(7)} ${(oos.byEngine.A.n + "/" + oos.byEngine.B.n).padStart(10)}`
    );
    symRows.push({ label: `sym top-${N}`, oosDay: oos.dollarsPerDay, oosMDD: oos.maxDD, oosPF: oos.pf, oosN: oos.numTrades });
  }

  // Step 4: Independent filter — each engine picks its own top-N pairs
  log("\n" + "=".repeat(130));
  log("  STEP 4 — INDEPENDENT FILTER (each engine picks own top-N by its IS PnL)");
  log("=".repeat(130));
  log(`${"N".padStart(5)} ${"$/day IS".padStart(10)} ${"$/day OOS".padStart(11)} ${"IS MDD".padStart(8)} ${"OOS MDD".padStart(9)} ${"OOS PF".padStart(8)} ${"OOS N".padStart(7)} ${"A/B".padStart(10)}`);
  log("-".repeat(130));
  const indRows: Row[] = [];
  for (const N of [20, 30, 40, 50, 60, 80]) {
    const selA = topNPairs(ppA, loadedNames, N);
    const selB = topNPairs(ppB, loadedNames, N);
    const cfg: Cfg = { ...baseCfg, pairsA: selA, pairsB: selB };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(
      `${String(N).padStart(5)} ${fmtD(is.dollarsPerDay).padStart(10)} ${fmtD(oos.dollarsPerDay).padStart(11)} ` +
      `${("$" + is.maxDD.toFixed(0)).padStart(8)} ${("$" + oos.maxDD.toFixed(0)).padStart(9)} ` +
      `${oos.pf.toFixed(2).padStart(8)} ${String(oos.numTrades).padStart(7)} ${(oos.byEngine.A.n + "/" + oos.byEngine.B.n).padStart(10)}`
    );
    indRows.push({ label: `ind top-${N}`, oosDay: oos.dollarsPerDay, oosMDD: oos.maxDD, oosPF: oos.pf, oosN: oos.numTrades });
  }

  // Step 5: Exclude worst-N from both engines, by combined PnL
  log("\n" + "=".repeat(130));
  log("  STEP 5 — EXCLUDE WORST-N (drop bottom-N by combined IS PnL from both engines)");
  log("=".repeat(130));
  log(`${"drop".padStart(5)} ${"keep".padStart(6)} ${"$/day IS".padStart(10)} ${"$/day OOS".padStart(11)} ${"IS MDD".padStart(8)} ${"OOS MDD".padStart(9)} ${"OOS PF".padStart(8)} ${"OOS N".padStart(7)}`);
  log("-".repeat(130));
  const excRows: Row[] = [];
  for (const N of [10, 20, 30]) {
    const sel = excludeWorstN(ppCombined, loadedNames, N);
    const cfg: Cfg = { ...baseCfg, pairsA: sel, pairsB: sel };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(
      `${String(N).padStart(5)} ${String(sel.size).padStart(6)} ${fmtD(is.dollarsPerDay).padStart(10)} ${fmtD(oos.dollarsPerDay).padStart(11)} ` +
      `${("$" + is.maxDD.toFixed(0)).padStart(8)} ${("$" + oos.maxDD.toFixed(0)).padStart(9)} ` +
      `${oos.pf.toFixed(2).padStart(8)} ${String(oos.numTrades).padStart(7)}`
    );
    excRows.push({ label: `drop-${N}`, oosDay: oos.dollarsPerDay, oosMDD: oos.maxDD, oosPF: oos.pf, oosN: oos.numTrades });
  }

  // Step 6: Exclude worst-N per engine independently
  log("\n" + "=".repeat(130));
  log("  STEP 6 — EXCLUDE WORST-N PER ENGINE (each engine drops its own worst pairs)");
  log("=".repeat(130));
  log(`${"drop".padStart(5)} ${"keepA".padStart(6)} ${"keepB".padStart(6)} ${"$/day IS".padStart(10)} ${"$/day OOS".padStart(11)} ${"IS MDD".padStart(8)} ${"OOS MDD".padStart(9)} ${"OOS PF".padStart(8)} ${"OOS N".padStart(7)}`);
  log("-".repeat(130));
  const excIndRows: Row[] = [];
  for (const N of [10, 20, 30]) {
    const selA = excludeWorstN(ppA, loadedNames, N);
    const selB = excludeWorstN(ppB, loadedNames, N);
    const cfg: Cfg = { ...baseCfg, pairsA: selA, pairsB: selB };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(
      `${String(N).padStart(5)} ${String(selA.size).padStart(6)} ${String(selB.size).padStart(6)} ${fmtD(is.dollarsPerDay).padStart(10)} ${fmtD(oos.dollarsPerDay).padStart(11)} ` +
      `${("$" + is.maxDD.toFixed(0)).padStart(8)} ${("$" + oos.maxDD.toFixed(0)).padStart(9)} ` +
      `${oos.pf.toFixed(2).padStart(8)} ${String(oos.numTrades).padStart(7)}`
    );
    excIndRows.push({ label: `drop-${N} ind`, oosDay: oos.dollarsPerDay, oosMDD: oos.maxDD, oosPF: oos.pf, oosN: oos.numTrades });
  }

  // Step 7: Profit-only filter — each engine keeps only IS-profitable pairs
  log("\n" + "=".repeat(130));
  log("  STEP 7 — PROFIT-ONLY FILTER (keep only pairs with +IS PnL per engine)");
  log("=".repeat(130));
  const profitA = new Set<string>();
  const profitB = new Set<string>();
  for (const p of loadedNames) {
    if ((ppA.get(p)?.pnl ?? 0) > 0) profitA.add(p);
    if ((ppB.get(p)?.pnl ?? 0) > 0) profitB.add(p);
  }
  const profitCombined = new Set<string>();
  for (const p of loadedNames) if ((ppCombined.get(p)?.pnl ?? 0) > 0) profitCombined.add(p);
  log(`  Profitable in IS: A=${profitA.size} pairs, B=${profitB.size} pairs, combined=${profitCombined.size}`);

  const runProfitIndependent = simulate(pairs, { ...baseCfg, pairsA: profitA, pairsB: profitB }, OOS_S, OOS_E, OOS_D);
  const runProfitIndIS = simulate(pairs, { ...baseCfg, pairsA: profitA, pairsB: profitB }, IS_S, IS_E, IS_D);
  const runProfitCombined = simulate(pairs, { ...baseCfg, pairsA: profitCombined, pairsB: profitCombined }, OOS_S, OOS_E, OOS_D);
  const runProfitCombinedIS = simulate(pairs, { ...baseCfg, pairsA: profitCombined, pairsB: profitCombined }, IS_S, IS_E, IS_D);
  log(`  Independent   IS $/day ${fmtD(runProfitIndIS.dollarsPerDay)} MDD $${runProfitIndIS.maxDD.toFixed(2)}  | OOS $/day ${fmtD(runProfitIndependent.dollarsPerDay)} MDD $${runProfitIndependent.maxDD.toFixed(2)} PF ${runProfitIndependent.pf.toFixed(2)} N=${runProfitIndependent.numTrades}`);
  log(`  Combined      IS $/day ${fmtD(runProfitCombinedIS.dollarsPerDay)} MDD $${runProfitCombinedIS.maxDD.toFixed(2)}  | OOS $/day ${fmtD(runProfitCombined.dollarsPerDay)} MDD $${runProfitCombined.maxDD.toFixed(2)} PF ${runProfitCombined.pf.toFixed(2)} N=${runProfitCombined.numTrades}`);
  const profitRows: Row[] = [
    { label: "profit-only ind", oosDay: runProfitIndependent.dollarsPerDay, oosMDD: runProfitIndependent.maxDD, oosPF: runProfitIndependent.pf, oosN: runProfitIndependent.numTrades },
    { label: "profit-only comb", oosDay: runProfitCombined.dollarsPerDay, oosMDD: runProfitCombined.maxDD, oosPF: runProfitCombined.pf, oosN: runProfitCombined.numTrades },
  ];

  // Summary: everything vs baseline
  log("\n" + "=".repeat(130));
  log("  FINAL SUMMARY — all filters vs baseline");
  log("=".repeat(130));
  log(`  BASELINE (all pairs): OOS $/day ${fmtD(baseOOS.dollarsPerDay)}  MDD $${baseOOS.maxDD.toFixed(2)}  PF ${baseOOS.pf.toFixed(2)}  N=${baseOOS.numTrades}`);
  log("");
  log(`${"Filter".padEnd(22)} ${"OOS $/day".padStart(11)} ${"delta".padStart(9)} ${"OOS MDD".padStart(10)} ${"OOS PF".padStart(8)} ${"OOS N".padStart(7)}`);
  log("-".repeat(130));
  const allRows: Row[] = [...symRows, ...indRows, ...excRows, ...excIndRows, ...profitRows];
  for (const r of allRows) {
    const delta = r.oosDay - baseOOS.dollarsPerDay;
    log(
      `${r.label.padEnd(22)} ${fmtD(r.oosDay).padStart(11)} ${fmtD(delta).padStart(9)} ` +
      `${("$" + r.oosMDD.toFixed(2)).padStart(10)} ${r.oosPF.toFixed(2).padStart(8)} ${String(r.oosN).padStart(7)}`
    );
  }

  // Beat baseline?
  log("\n" + "=".repeat(130));
  log("  VERDICT");
  log("=".repeat(130));
  const beatsBoth = allRows.filter(r => r.oosDay > baseOOS.dollarsPerDay && r.oosMDD < baseOOS.maxDD);
  const beatsDay = allRows.filter(r => r.oosDay > baseOOS.dollarsPerDay);
  const lowerMDD = allRows.filter(r => r.oosMDD < baseOOS.maxDD);
  log(`  Filters beating baseline on BOTH $/day AND MDD: ${beatsBoth.length}`);
  for (const r of beatsBoth) {
    log(`    ${r.label}: $/day ${fmtD(r.oosDay)} (+${(r.oosDay - baseOOS.dollarsPerDay).toFixed(2)})  MDD $${r.oosMDD.toFixed(2)} (vs $${baseOOS.maxDD.toFixed(2)})`);
  }
  log(`  Filters beating on $/day only: ${beatsDay.length}`);
  log(`  Filters beating on MDD only: ${lowerMDD.length}`);

  const bestDay = [...allRows].sort((a, b) => b.oosDay - a.oosDay)[0]!;
  const bestMDD = [...allRows].sort((a, b) => a.oosMDD - b.oosMDD)[0]!;
  log(`\n  Best $/day filter: ${bestDay.label} => ${fmtD(bestDay.oosDay)} / MDD $${bestDay.oosMDD.toFixed(2)}`);
  log(`  Best MDD filter:   ${bestMDD.label} => ${fmtD(bestMDD.oosDay)} / MDD $${bestMDD.oosMDD.toFixed(2)}`);

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "pair-filter.txt"), lines.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "pair-filter.txt")}`);
}

main();
