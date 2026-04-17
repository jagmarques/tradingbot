/**
 * REALISTIC SL — wider SL so fees aren't dominant + stress-test with worse slippage.
 *
 * Fee round-trip = 0.07% (on notional). SL 0.06% is SMALLER than fees.
 * SL should be at least 3-5x fee cost for sane math.
 *
 * Also test 2x and 3x slippage multipliers to see what survives under worse live conditions.
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
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24_h1: number[];
  rv_median30d: number[];
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

function computeRV(cs: C[], window: number): number[] {
  const out = new Array(cs.length).fill(0);
  for (let i = window; i < cs.length; i++) {
    let ss = 0, c = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (j < 1) continue;
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += r * r; c++;
    }
    if (c < 10) continue;
    out[i] = Math.sqrt(ss / c);
  }
  return out;
}

function computeRollingMedian(arr: number[], window: number): number[] {
  const out = new Array(arr.length).fill(0);
  for (let i = window; i < arr.length; i++) {
    const slice = arr.slice(i - window + 1, i + 1).filter(x => x > 0);
    if (slice.length === 0) continue;
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)]!;
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
  slSlipMult: number; // 1.5 = normal, 3 = worse live, 5 = catastrophic
  trailAct: number; trailDist: number;
  regime: boolean;
  regimeThr: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface Res { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; totalFees: number; }

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
      const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
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
      if (h1Idx === undefined || h1Idx < 720) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > 2 && z4 > 1.5) dir = "long";
      if (z1 < -4 && z4 < -1.5) dir = "short";
      if (!dir) continue;

      if (cfg.regime) {
        const rv = p.ind.rv24_h1[h1Idx - 1] ?? 0;
        const rvMed = p.ind.rv_median30d[h1Idx - 1] ?? 0;
        if (rv === 0 || rvMed === 0) continue;
        if (rv / rvMed < cfg.regimeThr) continue;
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
    numTrades: closed.length, totalFees,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(140));
  console.log("  REALISTIC SL — wider SL (fees not dominant) + slippage stress test");
  console.log("  Fee round-trip: 0.07% | SL should be ≥3x fees = 0.21%+");
  console.log("=".repeat(140));

  console.log("\nLoading...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 800 || h4.length < 100) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const rv24_h1 = computeRV(h1, 24);
    const rv_median30d = computeRollingMedian(rv24_h1, 720);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24_h1, rv_median30d }, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  const base = {
    margin: 15, slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5, regime: true, regimeThr: 1.5,
  };

  // Wide SL sweep at realistic slippage
  const slWidths = [0.0006, 0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01];
  const slipMults = [1.5, 2.5, 4.0];

  console.log(`\n${"Config".padEnd(35)} ${"Slip".padStart(5)} ${"Period".padEnd(6)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)} ${"Fees%".padStart(7)}`);
  console.log("-".repeat(140));

  const results: Array<{ label: string; slipMult: number; is: Res; oos: Res }> = [];
  for (const slip of slipMults) {
    for (const sl of slWidths) {
      const cfg: Cfg = { ...base, slPct: sl, slSlipMult: slip, label: `SL ${(sl * 100).toFixed(2)}%` };
      const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      results.push({ label: cfg.label, slipMult: slip, is, oos });
      const feePctIs = is.totalPnl !== 0 ? (is.totalFees / Math.abs(is.totalPnl + is.totalFees) * 100).toFixed(0) : "-";
      const feePctOos = oos.totalPnl !== 0 ? (oos.totalFees / Math.abs(oos.totalPnl + oos.totalFees) * 100).toFixed(0) : "-";
      console.log(`${cfg.label.padEnd(35).slice(0, 35)} ${(slip + "x").padStart(5)} ${"IS".padEnd(6)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(5)} ${is.wr.toFixed(1).padStart(6)} ${fmtD(is.maxSingleLoss).padStart(8)} ${String(is.numTrades).padStart(6)} ${(feePctIs + "%").padStart(7)}`);
      console.log(`${"".padEnd(35)} ${"".padStart(5)} ${"OOS".padEnd(6)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(5)} ${oos.wr.toFixed(1).padStart(6)} ${fmtD(oos.maxSingleLoss).padStart(8)} ${String(oos.numTrades).padStart(6)} ${(feePctOos + "%").padStart(7)}`);
    }
    console.log("-".repeat(140));
  }

  // Rankings
  console.log("\n" + "=".repeat(140));
  console.log("SAFE (MDD<$20, PROFITABLE at EACH slip level) — sorted by OOS $/day at 2.5x slip");
  console.log("=".repeat(140));
  const at25x = results.filter(r => r.slipMult === 2.5 && r.oos.maxDD < 20 && r.oos.dollarsPerDay > 0);
  at25x.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  for (const r of at25x) {
    // Check this config is also OK at 4x slip
    const at4x = results.find(x => x.label === r.label && x.slipMult === 4);
    const robustStr = at4x ? (at4x.oos.dollarsPerDay > 0.5 ? "✓robust" : "fragile") : "?";
    console.log(`${r.label.padEnd(25)} OOS $/day=${fmtD(r.oos.dollarsPerDay).padStart(9)} MDD=$${r.oos.maxDD.toFixed(0).padStart(3)} PF=${r.oos.pf.toFixed(2)} — at 4x slip: ${fmtD(at4x?.oos.dollarsPerDay ?? 0)} ${robustStr}`);
  }
}

main();
