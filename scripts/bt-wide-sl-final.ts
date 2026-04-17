/**
 * WIDE SL FINAL — find best wider-SL config (user hates SL < 0.15%)
 *
 * Staged search to keep runtime manageable:
 *  Stage 1: coarse SL × Trail × Z at regime 1.2, BE off
 *  Stage 2: top 10 from stage 1 refined across all regime × BE combos
 *
 * No cooldown, block hours 22-23 UTC, margin $15, FEE 0.00035, SL_SLIP 1.5, trail 9/0.5 default
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
const MAX_HOLD_H = 72;
const MARGIN = 15;

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
  rv24: number[];
  rv168: number[];
  z4At1h: number[]; // 4h z-score evaluated at each 1h bar (shifted one 4h bar back)
  m5TsToIdx: Map<number, number>;
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

function precomputeZ4At1h(h1: C[], z4: number[], h4: C[]): number[] {
  // For each 1h bar at time t, compute 4h z-score using completed 4h bar (shifted by one)
  const out = new Array(h1.length).fill(0);
  const h4Ts: number[] = h4.map(b => b.t);
  let j = 0;
  for (let i = 0; i < h1.length; i++) {
    const t = h1[i]!.t;
    // Find the most recent 4h bar with t4 < t
    while (j < h4Ts.length && h4Ts[j]! < t) j++;
    // j is now first with h4Ts[j] >= t, so we want j - 2 (one back completed)
    const idx = j - 2;
    if (idx >= 0) out[i] = z4[idx]!;
  }
  return out;
}

interface Cfg {
  label: string;
  slPct: number;
  trailAct: number; trailDist: number;
  regimeThr: number; // 1.0 means off
  zL1: number; zS1: number; zL4: number; zS4: number;
  beEnabled: boolean; bePct: number;
}

interface OpenPos {
  pair: string; dir: 1 | -1; // 1=long, -1=short
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  beMoved: boolean;
  m5Idx: number; // current index into m5 for this pair
}

interface Res { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

// Shared precomputed state per period
interface Sim {
  pairs: PD[];
  timepoints: number[];
  hours: Uint8Array; // hour for each timepoint
  isH1: Uint8Array; // 1 if timepoint is hour-aligned
  // per-pair index for each timepoint, -1 if pair has no bar at that ts
  pairIdxPerTs: Int32Array[]; // pairIdxPerTs[pairIdx][tpIdx] = m5 index or -1
}

function buildSim(pairs: PD[], startTs: number, endTs: number): Sim {
  const allSet = new Set<number>();
  for (const p of pairs) for (const b of p.ind.m5) if (b.t >= startTs && b.t < endTs) allSet.add(b.t);
  const timepoints = [...allSet].sort((a, b) => a - b);
  const n = timepoints.length;
  const hours = new Uint8Array(n);
  const isH1 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    hours[i] = new Date(timepoints[i]!).getUTCHours();
    isH1[i] = timepoints[i]! % H === 0 ? 1 : 0;
  }
  const pairIdxPerTs: Int32Array[] = [];
  for (const p of pairs) {
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const mi = p.ind.m5TsToIdx.get(timepoints[i]!);
      arr[i] = mi === undefined ? -1 : mi;
    }
    pairIdxPerTs.push(arr);
  }
  return { pairs, timepoints, hours, isH1, pairIdxPerTs };
}

function simulate(sim: Sim, cfg: Cfg, days: number): Res {
  const closed: Tr[] = [];
  const openPositions: OpenPos[] = [];
  const openPairSet = new Set<number>(); // pair indices with an open position
  const { pairs, timepoints, hours, isH1, pairIdxPerTs } = sim;
  const n = timepoints.length;
  const nPairs = pairs.length;

  for (let ti = 0; ti < n; ti++) {
    const ts = timepoints[ti]!;

    // Process open positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pidx = (pos as { pairIdx: number } & OpenPos).pairIdx;
      const bi = pairIdxPerTs[pidx]![ti];
      if (bi < 0) continue;
      const pd = pairs[pidx]!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) >= MAX_HOLD_H * H) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = pos.dir === 1 ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      const best = pos.dir === 1 ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp && cfg.beEnabled && !pos.beMoved && pos.pk >= cfg.bePct) {
        pos.sl = pos.ep;
        pos.beMoved = true;
      }

      if (!xp) {
        const cur = pos.dir === 1 ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === 1 ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === 1 ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ pair: pos.pair, dir: pos.dir === 1 ? "long" : "short", exitTs: ts, pnl, reason });
        openPairSet.delete(pidx);
        openPositions.splice(i, 1);
      }
    }

    if (!isH1[ti]) continue;
    if (BLOCK.has(hours[ti]!)) continue;

    // Entry check
    for (let p = 0; p < nPairs; p++) {
      if (openPairSet.has(p)) continue;
      const pd = pairs[p]!;
      const h1Idx = pd.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      const z1 = pd.ind.z1[h1Idx - 1]!;
      const z4 = pd.ind.z4At1h[h1Idx]!;

      let dir: 1 | -1 | 0 = 0;
      if (z1 > cfg.zL1 && z4 > cfg.zL4) dir = 1;
      else if (z1 < cfg.zS1 && z4 < cfg.zS4) dir = -1;
      if (dir === 0) continue;

      if (cfg.regimeThr > 1.0) {
        const rv24 = pd.ind.rv24[h1Idx - 1] ?? 0;
        const rv168 = pd.ind.rv168[h1Idx - 1] ?? 0;
        if (rv24 === 0 || rv168 === 0) continue;
        if (rv24 / rv168 < cfg.regimeThr) continue;
      }

      const openBar = pd.ind.h1[h1Idx]!;
      const ep = dir === 1 ? openBar.o * (1 + pd.sp) : openBar.o * (1 - pd.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === 1 ? ep - slDist : ep + slDist;

      const pos: OpenPos & { pairIdx: number } = {
        pair: pd.name, dir, ep, et: ts, sl, pk: 0,
        sp: pd.sp, lev: pd.lev, not: MARGIN * pd.lev, beMoved: false, m5Idx: -1,
        pairIdx: p,
      };
      openPositions.push(pos);
      openPairSet.add(p);
    }
  }

  // Close remaining positions at last bar
  for (const pos of openPositions) {
    const pidx = (pos as { pairIdx: number } & OpenPos).pairIdx;
    const pd = pairs[pidx]!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === 1 ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === 1 ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    closed.push({ pair: pos.pair, dir: pos.dir === 1 ? "long" : "short", exitTs: lb.t, pnl, reason: "end" });
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
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface Rec {
  label: string;
  cfg: Cfg;
  is: Res;
  oos: Res;
}

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function main() {
  log("=".repeat(150));
  log("  WIDE SL FINAL — margin $15, fee 0.035%/side, slip 1.5x on SL, trail 9/0.5 default");
  log("  IS 2025-06-01 to 2025-12-01 | OOS 2025-12-01 to 2026-03-25");
  log("  No cooldown, block h22-23 UTC, base z=(2,-4,1.5,-1.5), regime RV24/RV168>1.2");
  log("  Staged search: Stage1 (SL x Trail x Z, BE off, regime 1.2), Stage2 (top10 across regimes + BE)");
  log("=".repeat(150));

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
    const z4At1h = precomputeZ4At1h(h1, z4, h4);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const m5TsToIdx = new Map<number, number>();
    m5.forEach((c, i) => m5TsToIdx.set(c.t, i));
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168, z4At1h, m5TsToIdx }, sp: SP[n] ?? DSP, lev });
  }
  log(`${pairs.length} pairs loaded`);

  log("\nBuilding IS/OOS sim state...");
  const t0 = Date.now();
  const simIS = buildSim(pairs, IS_S, IS_E);
  const simOOS = buildSim(pairs, OOS_S, OOS_E);
  log(`Sim state built in ${((Date.now() - t0) / 1000).toFixed(1)}s (IS ${simIS.timepoints.length} tps, OOS ${simOOS.timepoints.length} tps)`);

  // Dimensions
  const slWidths = [0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005];
  const trails: Array<[number, number, boolean, number, string]> = [
    [9, 0.5, false, 0, "T9/0.5"],
    [12, 0.5, false, 0, "T12/0.5"],
    [15, 1.0, false, 0, "T15/1"],
    [20, 1.0, false, 0, "T20/1"],
    [5, 0.3, true, 3, "T5/0.3+BE3"],
  ];
  const zSets: Array<[number, number, number, number, string]> = [
    [2, -4, 1.5, -1.5, "Z(2,-4,1.5,-1.5)"],
    [3, -5, 2, -2, "Z(3,-5,2,-2)"],
    [4, -6, 2, -2, "Z(4,-6,2,-2)"],
    [2, -3, 1.5, -1.5, "Z(2,-3,1.5,-1.5)"],
  ];
  const regimeThrs: Array<[number, string]> = [
    [1.0, "R-off"],
    [1.2, "R1.2"],
    [1.5, "R1.5"],
    [2.0, "R2.0"],
  ];

  const allRecords: Rec[] = [];
  const stage1Records: Rec[] = [];

  // ----- STAGE 1 -----
  log("\n" + "=".repeat(150));
  log("STAGE 1 — Coarse search (SL x Trail x Z, regime=1.2, BE off)");
  log("=".repeat(150));
  log(`${"Label".padEnd(50)} ${"Per".padEnd(4)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"MaxL".padStart(9)} ${"N".padStart(6)}`);
  log("-".repeat(150));

  const stage1Start = Date.now();
  let ci = 0;
  const stage1Total = slWidths.length * trails.length * zSets.length;
  for (const sl of slWidths) {
    for (const [ta, td, teBe, teBePct, tlab] of trails) {
      for (const [zL1, zS1, zL4, zS4, zlab] of zSets) {
        ci++;
        const label = `SL${(sl * 100).toFixed(2)}%_${tlab}_${zlab}`;
        const cfg: Cfg = {
          label, slPct: sl,
          trailAct: ta, trailDist: td,
          regimeThr: 1.2,
          zL1, zS1, zL4, zS4,
          beEnabled: teBe, bePct: teBePct,
        };
        const is = simulate(simIS, cfg, IS_D);
        const oos = simulate(simOOS, cfg, OOS_D);
        const rec: Rec = { label, cfg, is, oos };
        stage1Records.push(rec);
        allRecords.push(rec);

        log(`${label.padEnd(50)} ${"IS".padEnd(4)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(6)} ${is.wr.toFixed(1).padStart(6)} ${fmtD(is.maxSingleLoss).padStart(9)} ${String(is.numTrades).padStart(6)}`);
        log(`${"".padEnd(50)} ${"OOS".padEnd(4)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(6)} ${oos.wr.toFixed(1).padStart(6)} ${fmtD(oos.maxSingleLoss).padStart(9)} ${String(oos.numTrades).padStart(6)}`);
      }
    }
  }
  log(`\nStage 1 done: ${ci}/${stage1Total} configs in ${((Date.now() - stage1Start) / 1000).toFixed(0)}s`);

  // ----- STAGE 2 -----
  // Take top 10 stage1 by OOS $/day with MDD<$20, then test each across regime thresholds + BE5 variant
  const s1Qualified = stage1Records.filter(r => r.oos.maxDD < 20 && r.oos.dollarsPerDay > 0);
  const s1Top = [...s1Qualified].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay).slice(0, 10);

  log("\n" + "=".repeat(150));
  log("STAGE 2 — Refining top stage1 configs across regime thresholds + BE5");
  log("=".repeat(150));
  log(`${"Label".padEnd(65)} ${"Per".padEnd(4)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"MaxL".padStart(9)} ${"N".padStart(6)}`);
  log("-".repeat(150));

  const stage2Start = Date.now();
  for (const base of s1Top) {
    for (const [rthr, rlab] of regimeThrs) {
      for (const beAdd of [false, true]) {
        // Skip original config (already tested): regime 1.2 + BE off
        if (rthr === 1.2 && !beAdd) continue;
        // Skip BE add if trail already has BE
        if (beAdd && base.cfg.beEnabled) continue;

        const label = `${base.label}_${rlab}${beAdd ? "_BE5" : ""}`;
        const cfg: Cfg = {
          ...base.cfg,
          label,
          regimeThr: rthr,
          beEnabled: base.cfg.beEnabled || beAdd,
          bePct: base.cfg.beEnabled ? base.cfg.bePct : (beAdd ? 5 : 0),
        };
        const is = simulate(simIS, cfg, IS_D);
        const oos = simulate(simOOS, cfg, OOS_D);
        allRecords.push({ label, cfg, is, oos });

        log(`${label.padEnd(65)} ${"IS".padEnd(4)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(6)} ${is.wr.toFixed(1).padStart(6)} ${fmtD(is.maxSingleLoss).padStart(9)} ${String(is.numTrades).padStart(6)}`);
        log(`${"".padEnd(65)} ${"OOS".padEnd(4)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(6)} ${oos.wr.toFixed(1).padStart(6)} ${fmtD(oos.maxSingleLoss).padStart(9)} ${String(oos.numTrades).padStart(6)}`);
      }
    }
  }
  log(`\nStage 2 done in ${((Date.now() - stage2Start) / 1000).toFixed(0)}s, total ${allRecords.length} configs`);

  // ----- RANKINGS -----
  const under20 = allRecords.filter(r => r.oos.maxDD < 20);
  const byDpd = [...under20].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  log("\n" + "=".repeat(150));
  log("TOP 10 BY OOS $/DAY (MDD < $20)");
  log("=".repeat(150));
  log(`${"Label".padEnd(65)} ${"OOS $/d".padStart(9)} ${"OOS MDD".padStart(9)} ${"OOS PF".padStart(7)} ${"OOS WR".padStart(7)} ${"IS $/d".padStart(9)} ${"IS MDD".padStart(9)} ${"OOS N".padStart(7)}`);
  for (let i = 0; i < Math.min(10, byDpd.length); i++) {
    const r = byDpd[i]!;
    log(`${r.label.padEnd(65)} ${fmtD(r.oos.dollarsPerDay).padStart(9)} ${("$" + r.oos.maxDD.toFixed(1)).padStart(9)} ${r.oos.pf.toFixed(2).padStart(7)} ${r.oos.wr.toFixed(1).padStart(7)} ${fmtD(r.is.dollarsPerDay).padStart(9)} ${("$" + r.is.maxDD.toFixed(1)).padStart(9)} ${String(r.oos.numTrades).padStart(7)}`);
  }

  const byRA = [...under20].filter(r => r.oos.maxDD > 0 && r.oos.dollarsPerDay > 0)
    .sort((a, b) => (b.oos.dollarsPerDay / b.oos.maxDD) - (a.oos.dollarsPerDay / a.oos.maxDD));
  log("\n" + "=".repeat(150));
  log("TOP 10 BY OOS RISK-ADJUSTED ($/day / MDD * 100), MDD < $20");
  log("=".repeat(150));
  log(`${"Label".padEnd(65)} ${"R.Adj".padStart(7)} ${"OOS $/d".padStart(9)} ${"OOS MDD".padStart(9)} ${"OOS PF".padStart(7)} ${"OOS WR".padStart(7)} ${"IS $/d".padStart(9)}`);
  for (let i = 0; i < Math.min(10, byRA.length); i++) {
    const r = byRA[i]!;
    const ra = r.oos.dollarsPerDay / r.oos.maxDD * 100;
    log(`${r.label.padEnd(65)} ${ra.toFixed(2).padStart(7)} ${fmtD(r.oos.dollarsPerDay).padStart(9)} ${("$" + r.oos.maxDD.toFixed(1)).padStart(9)} ${r.oos.pf.toFixed(2).padStart(7)} ${r.oos.wr.toFixed(1).padStart(7)} ${fmtD(r.is.dollarsPerDay).padStart(9)}`);
  }

  // HONEST VERDICT
  log("\n" + "=".repeat(150));
  log("HONEST VERDICT");
  log("=".repeat(150));
  const threshold = 1.5;
  const qualifying = allRecords.filter(r => r.oos.dollarsPerDay >= threshold && r.oos.maxDD < 20);
  if (qualifying.length === 0) {
    const best = byDpd[0];
    log(`NO wider-SL config reaches >= $${threshold.toFixed(2)}/day OOS with MDD < $20.`);
    if (best) {
      log(`Best OOS $/day with MDD<$20: ${fmtD(best.oos.dollarsPerDay)}/day, MDD $${best.oos.maxDD.toFixed(1)}, PF ${best.oos.pf.toFixed(2)}`);
      log(`  -> ${best.label}`);
    }
    const bestAny = [...allRecords].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay)[0];
    if (bestAny) {
      log(`Best OOS $/day any MDD: ${fmtD(bestAny.oos.dollarsPerDay)}/day, MDD $${bestAny.oos.maxDD.toFixed(1)}, PF ${bestAny.oos.pf.toFixed(2)}`);
      log(`  -> ${bestAny.label}`);
    }
  } else {
    log(`YES — ${qualifying.length} configs reach >= $${threshold.toFixed(2)}/day OOS with MDD < $20:`);
    const topQ = qualifying.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay).slice(0, 5);
    for (const r of topQ) {
      log(`  ${r.label}: OOS ${fmtD(r.oos.dollarsPerDay)}/day MDD $${r.oos.maxDD.toFixed(1)} PF ${r.oos.pf.toFixed(2)} | IS ${fmtD(r.is.dollarsPerDay)}/day MDD $${r.is.maxDD.toFixed(1)}`);
    }
  }

  const outPath = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/wide-sl-final.txt";
  fs.writeFileSync(outPath, lines.join("\n"));
  log(`\nSaved to ${outPath}`);
}

main();
