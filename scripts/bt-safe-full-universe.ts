/**
 * SAFE CONFIG + FULL UNIVERSE BACKTEST
 *
 * Runs the deployed SAFE GARCH v2 config on the FULL 127-pair universe (after cache backfill)
 * and on the previously-tested 102-pair subset for comparison.
 *
 * SAFE CONFIG (deployed):
 *   SL 0.15% fixed, slip 1.5x on SL, vol regime RV24/RV168 > 1.5
 *   z1=4/-6, z4=2/-2, no cooldown, margin $6-15 scaled, trail 9/0.5, max-hold 72h
 *
 * Also sweeps light modifications around the SAFE config to look for +EV wins:
 *   - margin scaling (6, 8, 10, 12, 15, 18)
 *   - SL widths (0.15, 0.20, 0.25, 0.30)
 *   - z1-long variations (3, 3.5, 4, 4.5, 5)
 *   - per-tier SL (tight on majors, wide on alts)
 *
 * Run: npx tsx scripts/bt-safe-full-universe.ts
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

// FULL 127-pair universe from QUANT_TRADING_PAIRS
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

// Majors get tighter SL in per-tier variant
const MAJORS = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "DOT", "AVAX", "LINK", "NEAR",
  "ARB", "OP", "UNI", "APT", "TIA", "SUI", "BNB", "LTC", "BCH",
]);

const IS_S = new Date("2025-06-01").getTime();
const IS_E = new Date("2025-12-01").getTime();
const OOS_S = new Date("2025-12-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
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
interface PD { name: string; ind: PI; sp: number; lev: number; isMajor: boolean; }

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
  slPctMajor?: number;  // override for majors
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
  pf: number; wr: number; maxSingleLoss: number; numTrades: number; feePct: number;
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

  let totalFees = 0;

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
        totalFees += fees;
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
      const slUsed = p.isMajor && cfg.slPctMajor !== undefined ? cfg.slPctMajor : cfg.slPct;
      const slDist = ep * slUsed;
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
    totalFees += fees;
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
    feePct: totalPnl !== 0 ? (totalFees / Math.abs(totalPnl + totalFees) * 100) : 0,
  };
}

function fmtD(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function fmtRes(label: string, r: Res) {
  console.log(
    `${label.padEnd(30)} $/d=${fmtD(r.dollarsPerDay).padStart(7)}  ` +
    `MDD=$${r.maxDD.toFixed(0).padStart(3)}  PF=${r.pf.toFixed(2)}  ` +
    `WR=${r.wr.toFixed(1)}%  N=${String(r.numTrades).padStart(5)}  ` +
    `MaxL=${fmtD(r.maxSingleLoss)}`,
  );
}

function main() {
  console.log("=".repeat(140));
  console.log("  SAFE CONFIG + FULL UNIVERSE BACKTEST (127 pairs after cache backfill)");
  console.log("=".repeat(140));

  console.log("\nLoading pairs...");
  const pairs: PD[] = [];
  const missing: string[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) { missing.push(n); continue; }
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 250 || h4.length < 50) { missing.push(n); continue; }
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
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168 },
      sp: SP[n] ?? DSP,
      lev,
      isMajor: MAJORS.has(n),
    });
  }
  console.log(`Loaded ${pairs.length}/${ALL_PAIRS.length} pairs. Missing: ${missing.join(", ") || "none"}`);
  const majorCount = pairs.filter(p => p.isMajor).length;
  console.log(`Majors loaded: ${majorCount}/${MAJORS.size}`);

  // Baseline SAFE config as currently deployed
  const SAFE: Cfg = {
    label: "SAFE-deployed",
    margin: 10, // midpoint of $6-15 auto-scaler band
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5,
    regime: true, regimeThr: 1.5,
    zL1: 4, zS1: -6, zL4: 2, zS4: -2,
  };

  console.log("\n" + "=".repeat(140));
  console.log("  1) BASELINE SAFE — full universe");
  console.log("=".repeat(140));
  const isBase = simulate(pairs, SAFE, IS_S, IS_E, IS_D);
  const oosBase = simulate(pairs, SAFE, OOS_S, OOS_E, OOS_D);
  fmtRes("SAFE IS  ", isBase);
  fmtRes("SAFE OOS ", oosBase);

  console.log("\n" + "=".repeat(140));
  console.log("  2) MARGIN SWEEP (SAFE config, OOS only, on full universe)");
  console.log("=".repeat(140));
  for (const m of [6, 8, 10, 12, 15, 18, 22]) {
    const cfg = { ...SAFE, margin: m };
    const r = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    fmtRes(`margin=$${m}`, r);
  }

  console.log("\n" + "=".repeat(140));
  console.log("  3) SL WIDTH SWEEP (margin $10, SAFE otherwise)");
  console.log("=".repeat(140));
  for (const sl of [0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005, 0.007, 0.01]) {
    const cfg = { ...SAFE, slPct: sl };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    console.log(
      `sl=${(sl * 100).toFixed(2)}%  ` +
      `IS $/d=${fmtD(is.dollarsPerDay).padStart(7)} MDD=$${is.maxDD.toFixed(0)} PF=${is.pf.toFixed(2)}  ` +
      `|  OOS $/d=${fmtD(oos.dollarsPerDay).padStart(7)} MDD=$${oos.maxDD.toFixed(0)} PF=${oos.pf.toFixed(2)} N=${oos.numTrades}`,
    );
  }

  console.log("\n" + "=".repeat(140));
  console.log("  4) Z1-LONG THRESHOLD SWEEP (relax for more trades)");
  console.log("=".repeat(140));
  for (const zL1 of [3, 3.5, 4, 4.5, 5]) {
    const cfg = { ...SAFE, zL1 };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    console.log(
      `zL1=${zL1}  IS $/d=${fmtD(is.dollarsPerDay).padStart(7)} MDD=$${is.maxDD.toFixed(0)} PF=${is.pf.toFixed(2)}  ` +
      `|  OOS $/d=${fmtD(oos.dollarsPerDay).padStart(7)} MDD=$${oos.maxDD.toFixed(0)} PF=${oos.pf.toFixed(2)} N=${oos.numTrades}`,
    );
  }

  console.log("\n" + "=".repeat(140));
  console.log("  5) PER-TIER SL (majors tight, alts wider) — only if enough majors loaded");
  console.log("=".repeat(140));
  if (majorCount >= 10) {
    const tiers: Array<[number, number]> = [
      [0.0015, 0.002],
      [0.0015, 0.003],
      [0.0015, 0.004],
      [0.002,  0.003],
      [0.002,  0.004],
      [0.0025, 0.004],
    ];
    for (const [maj, alt] of tiers) {
      const cfg = { ...SAFE, slPctMajor: maj, slPct: alt };
      const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      console.log(
        `major=${(maj * 100).toFixed(2)}% alt=${(alt * 100).toFixed(2)}%  ` +
        `IS $/d=${fmtD(is.dollarsPerDay).padStart(7)} MDD=$${is.maxDD.toFixed(0)}  |  ` +
        `OOS $/d=${fmtD(oos.dollarsPerDay).padStart(7)} MDD=$${oos.maxDD.toFixed(0)} PF=${oos.pf.toFixed(2)} N=${oos.numTrades}`,
      );
    }
  } else {
    console.log(`Only ${majorCount} majors loaded — skipping per-tier test`);
  }

  console.log("\n" + "=".repeat(140));
  console.log("  6) COMBINED — wider SL + more trades + moderate margin bump");
  console.log("=".repeat(140));
  const combos: Cfg[] = [
    { ...SAFE, label: "C1: sl=0.20% zL1=3.5 m=12", margin: 12, slPct: 0.002, zL1: 3.5 },
    { ...SAFE, label: "C2: sl=0.25% zL1=3 m=12",   margin: 12, slPct: 0.0025, zL1: 3 },
    { ...SAFE, label: "C3: sl=0.20% m=15",         margin: 15, slPct: 0.002 },
    { ...SAFE, label: "C4: sl=0.30% m=15 zL1=3.5", margin: 15, slPct: 0.003, zL1: 3.5 },
    { ...SAFE, label: "C5: sl=0.15% m=15",         margin: 15, slPct: 0.0015 },
    { ...SAFE, label: "C6: sl=0.15% m=18 zS1=-5",  margin: 18, slPct: 0.0015, zS1: -5 },
    { ...SAFE, label: "C7: sl=0.20% m=18",         margin: 18, slPct: 0.002 },
  ];
  for (const cfg of combos) {
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    console.log(`${cfg.label}`);
    fmtRes("  IS  ", is);
    fmtRes("  OOS ", oos);
  }
}

main();
