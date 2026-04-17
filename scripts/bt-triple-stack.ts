/**
 * TRIPLE STACK — push toward $5/day with MDD < $20
 *
 * Engines:
 *   G: GARCH (long>4 short<-6 z4=2, SL 0.08%, trail 9/0.5, BE@7)
 *   X: ExtRev (fade >5sigma 1h moves, SL 0.1%, trail 9/0.5, max hold 12h)
 *   M: 15m z-score extreme (z15m>5 or <-5, SL 0.08%, trail 9/0.5)
 *
 * Portfolio combinations at various margin levels.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-triple-stack.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const M15 = 15 * 60_000;
const D = 86_400_000;
const CD_H = 1;
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

const OOS_S = new Date("2025-06-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; engine: string; }
interface PI {
  h1: C[]; h4: C[]; m15: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  m15Map: Map<number, number>;
  z1: number[]; z4: number[];
  z15m: number[];
  ret1h: number[];
  stdev1h_168: number[];
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

function computeReturns(cs: C[]): number[] {
  const out = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) out[i] = cs[i]!.c / cs[i - 1]!.c - 1;
  return out;
}

function computeRollingStdev(arr: number[], window: number): number[] {
  const out = new Array(arr.length).fill(0);
  for (let i = window; i < arr.length; i++) {
    let sum = 0, sum2 = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += arr[j]!;
      sum2 += arr[j]! * arr[j]!;
    }
    const mean = sum / window;
    const variance = sum2 / window - mean * mean;
    out[i] = Math.sqrt(Math.max(0, variance));
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

interface EngineCfg {
  id: string;
  kind: "garch" | "extrev" | "m15z";
  margin: number;
  slPct: number;
  trailAct: number;
  trailDist: number;
  beAt?: number;
  // GARCH
  zL1?: number; zS1?: number; zL4?: number; zS4?: number;
  // ExtRev
  sigmaMult?: number;
  // 15m z
  z15mLong?: number; z15mShort?: number;
  // Max hold
  maxHoldH: number;
}

interface OpenPos {
  engine: string;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  beActivated: boolean;
  maxHoldH: number;
  trailAct: number; trailDist: number;
  beAt?: number;
}

interface SimResult { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; byEngine: Record<string, { trades: number; pnl: number }>; }

function simulateMulti(pairs: PD[], engines: EngineCfg[]): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of pairs) {
    for (const b of p.ind.m5) {
      if (b.t >= OOS_S && b.t < OOS_E) all5mTimes.add(b.t);
    }
  }
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
    const isH1Boundary = ts % H === 0;
    const is15mBoundary = ts % M15 === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // EXITS
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;

      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = pos.beActivated ? "be" : "sl"; isSL = true; }
      }

      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp && pos.beAt !== undefined && !pos.beActivated && pos.pk >= pos.beAt) {
        pos.sl = pos.ep;
        pos.beActivated = true;
      }

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= pos.trailAct && cur <= pos.pk - pos.trailDist) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason, engine: pos.engine });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.engine}:${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (BLOCK.has(hourOfDay)) continue;

    // ENTRIES per engine
    for (const eng of engines) {
      // Each engine has its own boundary check
      const boundary = eng.kind === "m15z" ? is15mBoundary : isH1Boundary;
      if (!boundary) continue;

      for (const p of pairs) {
        const h1Idx = p.ind.h1Map.get(Math.floor(ts / H) * H);
        if (h1Idx === undefined || h1Idx < 170) continue;
        if (openPositions.some(o => o.pair === p.name && o.engine === eng.id)) continue;

        let dir: "long" | "short" | null = null;
        if (eng.kind === "garch") {
          const z1 = p.ind.z1[h1Idx - 1]!;
          const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
          if (z1 > eng.zL1! && z4 > eng.zL4!) dir = "long";
          if (z1 < eng.zS1! && z4 < eng.zS4!) dir = "short";
        } else if (eng.kind === "extrev") {
          const lastRet = p.ind.ret1h[h1Idx - 1]!;
          const stdev = p.ind.stdev1h_168[h1Idx - 1]!;
          if (stdev === 0) continue;
          const zRet = lastRet / stdev;
          if (zRet > eng.sigmaMult!) dir = "short";
          if (zRet < -eng.sigmaMult!) dir = "long";
        } else if (eng.kind === "m15z") {
          const m15Idx = p.ind.m15Map.get(ts);
          if (m15Idx === undefined || m15Idx < 25) continue;
          const z15 = p.ind.z15m[m15Idx - 1]!;
          if (z15 > eng.z15mLong!) dir = "long";
          if (z15 < eng.z15mShort!) dir = "short";
        }
        if (!dir) continue;

        const ck = `${eng.id}:${p.name}:${dir}`;
        if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

        // Use current 5m bar open as entry to avoid look-ahead
        const m5Idx = m5Maps.get(p.name)!.get(ts);
        if (m5Idx === undefined) continue;
        const entryBar = p.ind.m5[m5Idx]!;
        const ep = dir === "long" ? entryBar.o * (1 + p.sp) : entryBar.o * (1 - p.sp);

        const slDist = ep * eng.slPct;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        openPositions.push({
          engine: eng.id,
          pair: p.name, dir, ep, et: ts, sl, pk: 0,
          sp: p.sp, lev: p.lev, not: eng.margin * p.lev,
          beActivated: false,
          maxHoldH: eng.maxHoldH,
          trailAct: eng.trailAct, trailDist: eng.trailDist,
          beAt: eng.beAt,
        });
      }
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end", engine: pos.engine });
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
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const byEngine: Record<string, { trades: number; pnl: number }> = {};
  for (const t of closed) {
    if (!byEngine[t.engine]) byEngine[t.engine] = { trades: 0, pnl: 0 };
    byEngine[t.engine]!.trades++;
    byEngine[t.engine]!.pnl += t.pnl;
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(140));
  console.log("  TRIPLE STACK — GARCH + ExtRev + 15m z-score");
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
    const m15 = aggregate(raw, M15, 2);
    if (h1.length < 100 || h4.length < 50 || m15.length < 200) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const m15Map = new Map<number, number>();
    m15.forEach((c, i) => m15Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const z15m = computeZ(m15);
    const ret1h = computeReturns(h1);
    const stdev1h_168 = computeRollingStdev(ret1h, 168);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m15, m5, h1Map, h4Map, m15Map, z1, z4, z15m, ret1h, stdev1h_168 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  console.log(`${pairs.length} pairs loaded`);

  // Engine configs
  const G = (margin: number): EngineCfg => ({
    id: "G", kind: "garch", margin, slPct: 0.0008,
    zL1: 4, zS1: -6, zL4: 2, zS4: -2,
    trailAct: 9, trailDist: 0.5, beAt: 7, maxHoldH: 72,
  });
  const X5 = (margin: number): EngineCfg => ({
    id: "X", kind: "extrev", margin, slPct: 0.001, sigmaMult: 5,
    trailAct: 9, trailDist: 0.5, maxHoldH: 12,
  });
  const X4 = (margin: number): EngineCfg => ({
    id: "X", kind: "extrev", margin, slPct: 0.001, sigmaMult: 4,
    trailAct: 9, trailDist: 0.5, maxHoldH: 12,
  });
  const M15Z4 = (margin: number, z: number): EngineCfg => ({
    id: "M", kind: "m15z", margin, slPct: 0.0008,
    z15mLong: z, z15mShort: -z,
    trailAct: 9, trailDist: 0.5, beAt: 7, maxHoldH: 24,
  });

  const tests: Array<{ label: string; engines: EngineCfg[] }> = [
    // Baselines from portfolio-final
    { label: "G m$10 alone", engines: [G(10)] },
    { label: "X5 m$10 alone", engines: [X5(10)] },
    { label: "M15z5 m$10 alone", engines: [M15Z4(10, 5)] },
    { label: "M15z4 m$10 alone", engines: [M15Z4(10, 4)] },
    { label: "M15z6 m$10 alone", engines: [M15Z4(10, 6)] },

    // PF4 scaled
    { label: "PF4 scale: G+X5 m$10", engines: [G(10), X5(10)] },
    { label: "PF4 scale: G+X5 m$12", engines: [G(12), X5(12)] },
    { label: "PF4 scale: G+X5 m$15", engines: [G(15), X5(15)] },
    { label: "PF4 scale: G+X5 m$17", engines: [G(17), X5(17)] },
    { label: "PF4 scale: G+X5 m$20", engines: [G(20), X5(20)] },

    // Triple stacks
    { label: "Triple: G+X5+M15z4 m$10", engines: [G(10), X5(10), M15Z4(10, 4)] },
    { label: "Triple: G+X5+M15z5 m$10", engines: [G(10), X5(10), M15Z4(10, 5)] },
    { label: "Triple: G+X5+M15z6 m$10", engines: [G(10), X5(10), M15Z4(10, 6)] },
    { label: "Triple: G+X5+M15z4 m$7", engines: [G(7), X5(7), M15Z4(7, 4)] },
    { label: "Triple: G+X5+M15z5 m$7", engines: [G(7), X5(7), M15Z4(7, 5)] },
    { label: "Triple: G+X5+M15z5 m$8", engines: [G(8), X5(8), M15Z4(8, 5)] },
    { label: "Triple: G+X5+M15z5 m$5", engines: [G(5), X5(5), M15Z4(5, 5)] },

    // GARCH x 2 (different z configs) + ExtRev
    { label: "G22+G34+X5 m$7", engines: [
      { ...G(7), id: "G1", zL4: 2, zS4: -2 },
      { ...G(7), id: "G2", zL4: 3, zS4: -3 },
      X5(7),
    ] },
    { label: "G22+G34+X5 m$10", engines: [
      { ...G(10), id: "G1", zL4: 2, zS4: -2 },
      { ...G(10), id: "G2", zL4: 3, zS4: -3 },
      X5(10),
    ] },
    { label: "G22+X4+X5 m$7", engines: [
      { ...G(7), id: "G" },
      { ...X4(7), id: "X4" },
      { ...X5(7), id: "X5" },
    ] },
    { label: "G22+X4+X5 m$10", engines: [
      { ...G(10), id: "G" },
      { ...X4(10), id: "X4" },
      { ...X5(10), id: "X5" },
    ] },
  ];

  const hdr = `${"Config".padEnd(40)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`;
  console.log("\n" + hdr);
  console.log("-".repeat(140));

  const results: Array<{ label: string; res: SimResult }> = [];
  for (const t of tests) {
    const res = simulateMulti(pairs, t.engines);
    results.push({ label: t.label, res });
    console.log(`${t.label.padEnd(40).slice(0, 40)} ${fmtD(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(8)} ${res.pf.toFixed(2).padStart(5)} ${res.wr.toFixed(1).padStart(6)} ${fmtD(res.maxSingleLoss).padStart(8)} ${String(res.numTrades).padStart(6)}`);
    const engineSummary = Object.entries(res.byEngine).map(([id, s]) => `${id}:$${s.pnl.toFixed(0)}/${s.trades}`).join(" ");
    if (engineSummary) console.log(`   breakdown: ${engineSummary}`);
  }

  console.log("\n" + "=".repeat(140));
  console.log("SAFE (MDD < $20) BY $/DAY");
  console.log("=".repeat(140));
  console.log(hdr);
  const safe = results.filter(r => r.res.maxDD < 20 && r.res.dollarsPerDay > 0).sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of safe) {
    console.log(`${r.label.padEnd(40).slice(0, 40)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(8)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
  }

  console.log("\n" + "=".repeat(140));
  console.log("TARGET ($/day >= 5 AND MDD < $20)");
  console.log("=".repeat(140));
  const target = results.filter(r => r.res.dollarsPerDay >= 5 && r.res.maxDD < 20);
  if (target.length === 0) console.log("(none)");
  else for (const r of target) console.log(`${r.label}: ${fmtD(r.res.dollarsPerDay)}, MDD $${r.res.maxDD.toFixed(0)}`);
}

main();
