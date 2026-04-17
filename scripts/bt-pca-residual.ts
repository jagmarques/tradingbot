/**
 * PCA Basket Residual Stat-Arb (Avellaneda-Lee 2010) for Hyperliquid alts
 *
 * Strategy:
 *   1. Build 1h-returns matrix R[time × pair] across 102 pairs
 *   2. PC1 = equal-weight basket mean (first-order approximation of first principal component)
 *   3. Rolling beta(pair) = cov(pair_ret, PC1) / var(PC1) over PCA window
 *   4. residual_t = pair_ret_t - beta × PC1_t
 *   5. z-score residual over 48h rolling
 *   6. Entry: |resid_z| > threshold → fade (long if z<-thr, short if z>+thr)
 *   7. Exit: resid_z crosses 0, OR max hold, OR SL
 *
 * Fully market-neutral by construction — trades pair vs basket mispricing.
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.00035;
const SL_SLIP_MULT = 1.5;
const BLOCK = new Set([22, 23]);
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

interface PD {
  name: string;
  h1: C[];
  m5: C[];
  h1Map: Map<number, number>;
  m5Map: Map<number, number>;
  sp: number;
  lev: number;
  // residual z-score per h1 index (computed in build phase)
  residZ: Float64Array;
}

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

/**
 * Build residual z-score matrix.
 * - tGrid: aligned 1h timestamps (union of all pairs)
 * - For each time t, PC1_t = mean of pair returns that exist at t
 * - beta_pair = rolling cov(pair, PC1) / var(PC1) over pcaWinBars
 * - resid = pair_ret - beta × PC1
 * - resid_z over residWinBars
 */
function buildResidualZ(
  pairs: { name: string; h1: C[]; h1Map: Map<number, number> }[],
  tGrid: number[],
  pcaWinBars: number,
  residWinBars: number,
): Map<string, Float64Array> {
  const T = tGrid.length;
  const P = pairs.length;

  // Build returns matrix R[t][p]: NaN if pair has no bar at t or t-1
  const R: Float64Array[] = [];
  for (let ti = 0; ti < T; ti++) R.push(new Float64Array(P));
  for (let p = 0; p < P; p++) {
    const { h1, h1Map } = pairs[p]!;
    let prev = NaN;
    for (let ti = 0; ti < T; ti++) {
      const t = tGrid[ti]!;
      const bi = h1Map.get(t);
      if (bi === undefined) { R[ti]![p] = NaN; prev = NaN; continue; }
      const c = h1[bi]!.c;
      if (isNaN(prev)) { R[ti]![p] = NaN; prev = c; continue; }
      R[ti]![p] = c / prev - 1;
      prev = c;
    }
  }

  // PC1_t = mean across pairs with valid returns at t
  const PC1 = new Float64Array(T);
  for (let ti = 0; ti < T; ti++) {
    let sum = 0, n = 0;
    const row = R[ti]!;
    for (let p = 0; p < P; p++) {
      const v = row[p]!;
      if (!isNaN(v)) { sum += v; n++; }
    }
    PC1[ti] = n >= 5 ? sum / n : NaN;
  }

  // residuals[t][p]: pair_ret - beta × PC1 where beta rolled over pcaWinBars
  const resid: Float64Array[] = [];
  for (let ti = 0; ti < T; ti++) resid.push(new Float64Array(P));

  // Precompute per-pair residuals using rolling window betas
  for (let p = 0; p < P; p++) {
    for (let ti = 0; ti < T; ti++) {
      const r = R[ti]![p]!;
      const pc = PC1[ti]!;
      if (isNaN(r) || isNaN(pc)) { resid[ti]![p] = NaN; continue; }
      if (ti < pcaWinBars) { resid[ti]![p] = NaN; continue; }
      // Compute rolling cov(pair, PC1) / var(PC1) using last pcaWinBars including current
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, n = 0;
      for (let k = ti - pcaWinBars + 1; k <= ti; k++) {
        const rk = R[k]![p]!;
        const pk = PC1[k]!;
        if (isNaN(rk) || isNaN(pk)) continue;
        sumX += pk; sumY += rk; sumXY += pk * rk; sumXX += pk * pk; n++;
      }
      if (n < Math.floor(pcaWinBars * 0.6)) { resid[ti]![p] = NaN; continue; }
      const meanX = sumX / n, meanY = sumY / n;
      const varX = sumXX / n - meanX * meanX;
      if (varX <= 1e-12) { resid[ti]![p] = NaN; continue; }
      const covXY = sumXY / n - meanX * meanY;
      const beta = covXY / varX;
      resid[ti]![p] = r - beta * pc;
    }
  }

  // z-score residuals over residWinBars per pair
  const residZMap = new Map<string, Float64Array>();
  for (let p = 0; p < P; p++) {
    const z = new Float64Array(T);
    for (let ti = 0; ti < T; ti++) z[ti] = NaN;
    for (let ti = 0; ti < T; ti++) {
      if (ti < residWinBars) continue;
      let sum = 0, ss = 0, n = 0;
      for (let k = ti - residWinBars + 1; k <= ti; k++) {
        const v = resid[k]![p]!;
        if (isNaN(v)) continue;
        sum += v; ss += v * v; n++;
      }
      if (n < Math.floor(residWinBars * 0.6)) continue;
      const mean = sum / n;
      const variance = ss / n - mean * mean;
      if (variance <= 1e-12) continue;
      const sd = Math.sqrt(variance);
      const cur = resid[ti]![p]!;
      if (isNaN(cur)) continue;
      z[ti] = (cur - mean) / sd;
    }
    residZMap.set(pairs[p]!.name, z);
  }

  return residZMap;
}

interface Cfg {
  label: string;
  margin: number;
  slPct: number;
  maxHoldH: number;
  zThr: number;
  pcaWinBars: number;
  residWinBars: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number;
  sp: number; lev: number; not: number;
}

interface Res { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

function simulate(pairs: PD[], cfg: Cfg, startTs: number, endTs: number, days: number, tGrid: number[], tGridMap: Map<number, number>): Res {
  const closed: Tr[] = [];
  const openPositions: OpenPos[] = [];

  // Build all 5m timepoints across all pairs (same as bt-sl-fast)
  const all5mTimes = new Set<number>();
  for (const p of pairs) for (const b of p.m5) if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const pairByName = new Map<string, PD>();
  for (const p of pairs) pairByName.set(p.name, p);

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    // Manage open positions at every 5m timestamp
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pd = pairByName.get(pos.pair)!;
      const bi = pd.m5Map.get(ts);
      if (bi === undefined) continue;
      const bar = pd.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      // Max hold
      if ((ts - pos.et) / H >= cfg.maxHoldH) { xp = bar.c; reason = "maxh"; }
      // SL intra-bar
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      // Resid z-crosses 0 at 1h bar boundary only
      if (!xp && isH1) {
        const gi = tGridMap.get(ts);
        if (gi !== undefined) {
          const z = pd.residZ[gi]!;
          if (!isNaN(z)) {
            if (pos.dir === "long" && z >= 0) { xp = bar.c; reason = "zx"; }
            else if (pos.dir === "short" && z <= 0) { xp = bar.c; reason = "zx"; }
          }
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP_MULT : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    const gi = tGridMap.get(ts);
    if (gi === undefined) continue;

    // Entry scan
    for (const p of pairs) {
      const h1Idx = p.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 1) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      // Use residZ at previous bar (signal before entry, no lookahead)
      const giPrev = gi - 1;
      if (giPrev < 0) continue;
      const z = p.residZ[giPrev]!;
      if (isNaN(z)) continue;

      let dir: "long" | "short" | null = null;
      if (z < -cfg.zThr) dir = "long";
      else if (z > cfg.zThr) dir = "short";
      if (!dir) continue;

      const ep = dir === "long" ? p.h1[h1Idx]!.o * (1 + p.sp) : p.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl,
        sp: p.sp, lev: p.lev, not: cfg.margin * p.lev,
      });
    }
  }

  // Close open positions at last bar
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.m5[pd.m5.length - 1]!;
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
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(140));
  console.log("  PCA BASKET RESIDUAL STAT-ARB (Avellaneda-Lee 2010)");
  console.log("  Fade residuals vs equal-weight PC1 basket | Market-neutral");
  console.log("  Entry: |resid_z| > thr | Exit: resid_z crosses 0 | SL 0.15%+ | Max hold 6/12/24h");
  console.log("=".repeat(140));

  console.log("\nLoading pairs...");
  const rawPairs: { name: string; h1: C[]; m5: C[]; h1Map: Map<number, number>; m5Map: Map<number, number>; sp: number; lev: number }[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    if (h1.length < 500) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const m5Map = new Map<number, number>();
    m5.forEach((c, i) => m5Map.set(c.t, i));
    rawPairs.push({ name: n, h1, m5, h1Map, m5Map, sp: SP[n] ?? DSP, lev: getLev(n) });
  }
  console.log(`${rawPairs.length} pairs loaded`);

  // Build aligned 1h tGrid (union of all pair timestamps, restricted to [IS_S-30d, OOS_E])
  const tSet = new Set<number>();
  const gridStart = IS_S - 30 * D;
  for (const p of rawPairs) {
    for (const c of p.h1) {
      if (c.t >= gridStart && c.t <= OOS_E) tSet.add(c.t);
    }
  }
  const tGrid = [...tSet].sort((a, b) => a - b);
  const tGridMap = new Map<number, number>();
  tGrid.forEach((t, i) => tGridMap.set(t, i));
  console.log(`tGrid: ${tGrid.length} hours (${((tGrid[tGrid.length - 1]! - tGrid[0]!) / D).toFixed(0)} days)`);

  const residWinBars = 48; // 48h z-score window

  // Variations
  const pcaWinDays = [3, 7, 14];
  const zThrs = [2.0, 2.5, 3.0];
  const slPcts = [0.0015, 0.0020, 0.0025];
  const maxHolds = [6, 12, 24];

  interface Rec { pcaWin: number; zThr: number; slPct: number; maxH: number; is: Res; oos: Res; }
  const records: Rec[] = [];

  // Cache residZ per pcaWin
  const residCache = new Map<number, Map<string, Float64Array>>();

  console.log(`\n${"pcaD".padStart(5)} ${"zThr".padStart(5)} ${"SL".padStart(6)} ${"MxH".padStart(4)} ${"Period".padEnd(6)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`);
  console.log("-".repeat(140));

  for (const pcaWinD of pcaWinDays) {
    const pcaWinBars = pcaWinD * 24;
    console.log(`\nComputing residZ for PCA window ${pcaWinD}d...`);
    const residZMap = buildResidualZ(
      rawPairs.map(p => ({ name: p.name, h1: p.h1, h1Map: p.h1Map })),
      tGrid,
      pcaWinBars,
      residWinBars,
    );
    residCache.set(pcaWinD, residZMap);

    // Attach to pairs
    const pairs: PD[] = rawPairs.map(p => ({
      name: p.name, h1: p.h1, m5: p.m5, h1Map: p.h1Map, m5Map: p.m5Map,
      sp: p.sp, lev: p.lev,
      residZ: residZMap.get(p.name)!,
    }));

    for (const zThr of zThrs) {
      for (const slPct of slPcts) {
        for (const maxH of maxHolds) {
          const cfg: Cfg = {
            label: `pca${pcaWinD}-z${zThr}-sl${slPct}-h${maxH}`,
            margin: MARGIN,
            slPct,
            maxHoldH: maxH,
            zThr,
            pcaWinBars,
            residWinBars,
          };
          const is = simulate(pairs, cfg, IS_S, IS_E, IS_D, tGrid, tGridMap);
          const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D, tGrid, tGridMap);
          records.push({ pcaWin: pcaWinD, zThr, slPct, maxH, is, oos });

          const slStr = (slPct * 100).toFixed(2) + "%";
          console.log(`${String(pcaWinD).padStart(5)} ${zThr.toFixed(1).padStart(5)} ${slStr.padStart(6)} ${String(maxH).padStart(4)} ${"IS".padEnd(6)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(5)} ${is.wr.toFixed(1).padStart(6)} ${fmtD(is.maxSingleLoss).padStart(8)} ${String(is.numTrades).padStart(6)}`);
          console.log(`${"".padStart(5)} ${"".padStart(5)} ${"".padStart(6)} ${"".padStart(4)} ${"OOS".padEnd(6)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(5)} ${oos.wr.toFixed(1).padStart(6)} ${fmtD(oos.maxSingleLoss).padStart(8)} ${String(oos.numTrades).padStart(6)}`);
        }
      }
    }
    console.log("-".repeat(140));
  }

  // Summary: best OOS at MDD < $20, both IS and OOS positive
  console.log("\n" + "=".repeat(140));
  console.log("  RANKED (OOS $/day, MDD<$20, IS>0 & OOS>0)");
  console.log("=".repeat(140));
  const eligible = records.filter(r => r.oos.maxDD < 20 && r.is.dollarsPerDay > 0 && r.oos.dollarsPerDay > 0);
  eligible.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  if (eligible.length === 0) {
    console.log("(none — no config meets MDD<$20 with both IS and OOS positive)");
  } else {
    console.log(`${"pcaD".padStart(5)} ${"zThr".padStart(5)} ${"SL".padStart(6)} ${"MxH".padStart(4)} ${"IS$/d".padStart(9)} ${"OOS$/d".padStart(9)} ${"IS MDD".padStart(8)} ${"OOSMDD".padStart(8)} ${"OOS PF".padStart(7)} ${"OOS WR".padStart(7)} ${"OOS N".padStart(6)}`);
    console.log("-".repeat(140));
    for (const r of eligible.slice(0, 20)) {
      console.log(`${String(r.pcaWin).padStart(5)} ${r.zThr.toFixed(1).padStart(5)} ${((r.slPct * 100).toFixed(2) + "%").padStart(6)} ${String(r.maxH).padStart(4)} ${fmtD(r.is.dollarsPerDay).padStart(9)} ${fmtD(r.oos.dollarsPerDay).padStart(9)} ${("$" + r.is.maxDD.toFixed(0)).padStart(8)} ${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ${r.oos.pf.toFixed(2).padStart(7)} ${r.oos.wr.toFixed(1).padStart(7)} ${String(r.oos.numTrades).padStart(6)}`);
    }
  }

  // Top OOS irrespective of MDD threshold
  console.log("\n" + "=".repeat(140));
  console.log("  TOP 10 OOS $/day (any MDD)");
  console.log("=".repeat(140));
  const byOos = [...records].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  console.log(`${"pcaD".padStart(5)} ${"zThr".padStart(5)} ${"SL".padStart(6)} ${"MxH".padStart(4)} ${"IS$/d".padStart(9)} ${"OOS$/d".padStart(9)} ${"IS MDD".padStart(8)} ${"OOSMDD".padStart(8)} ${"OOS PF".padStart(7)} ${"OOS WR".padStart(7)} ${"OOS N".padStart(6)}`);
  console.log("-".repeat(140));
  for (const r of byOos.slice(0, 10)) {
    console.log(`${String(r.pcaWin).padStart(5)} ${r.zThr.toFixed(1).padStart(5)} ${((r.slPct * 100).toFixed(2) + "%").padStart(6)} ${String(r.maxH).padStart(4)} ${fmtD(r.is.dollarsPerDay).padStart(9)} ${fmtD(r.oos.dollarsPerDay).padStart(9)} ${("$" + r.is.maxDD.toFixed(0)).padStart(8)} ${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ${r.oos.pf.toFixed(2).padStart(7)} ${r.oos.wr.toFixed(1).padStart(7)} ${String(r.oos.numTrades).padStart(6)}`);
  }

  console.log("\n" + "=".repeat(140));
  console.log("  TARGET: beat $0.39/day OOS at MDD<$20");
  console.log("=".repeat(140));
  const winners = eligible.filter(r => r.oos.dollarsPerDay > 0.39);
  if (winners.length === 0) {
    console.log("No config beats $0.39/day OOS with MDD<$20.");
  } else {
    console.log(`${winners.length} config(s) beat target. Best: ${fmtD(winners[0]!.oos.dollarsPerDay)}/day OOS (MDD $${winners[0]!.oos.maxDD.toFixed(0)})`);
  }
}

main();
