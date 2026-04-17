/**
 * CSDR — Cross-Sectional Dispersion Regime signal
 *
 * Concept: cross-sectional stdev of 1h returns across ALL pairs is a meta-signal.
 *   - disp_z < -1.5  (LOW regime)  → basket highly correlated → FADE extreme movers (mean rev)
 *     pair z > +3 → SHORT, pair z < -3 → LONG
 *   - disp_z > +1.5  (HIGH regime) → basket decorrelated → ride extreme movers (momentum)
 *     pair z > +3 → LONG,  pair z < -3 → SHORT
 *   - NEUTRAL between → no trades
 *
 * Framework copied from bt-sl-fast.ts (5m exits, 1h entries, walk-forward).
 *
 * Tests:
 *   1) CSDR standalone baseline
 *   2) Sweep disp z-thresholds ±1.0/±1.5/±2.0
 *   3) Sweep pair z-thresholds 2/3/4
 *   4) Sweep SL width 0.10% / 0.15% / 0.20%
 *   5) CSDR as a GATE on GARCH entries (only fire GARCH signal if CSDR regime
 *      is compatible: HIGH→momentum match, LOW→mean-rev match)
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
const MAX_HOLD_H = 24;
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
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  r1: number[]; // 1h log returns aligned to h1 index
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

function computeR1(cs: C[]): number[] {
  const r = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    r[i] = Math.log(cs[i]!.c / cs[i - 1]!.c);
  }
  return r;
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

// ──────────────────────────────────────────────
// Build global dispersion series aligned to 1h bars
// ──────────────────────────────────────────────
interface DispMap {
  // key = h1 timestamp, value = disp_z at that bar (using data up to end of that bar)
  zByTs: Map<number, number>;
}

function buildDispersion(pairs: PD[]): DispMap {
  // Collect all unique 1h timestamps across pairs
  const allTs = new Set<number>();
  for (const p of pairs) for (const b of p.ind.h1) allTs.add(b.t);
  const tsSorted = [...allTs].sort((a, b) => a - b);

  // Build cross-sectional dispersion (stdev of 1h returns) at each ts
  const dispSeries: number[] = [];
  const tsList: number[] = [];
  for (const ts of tsSorted) {
    const rets: number[] = [];
    for (const p of pairs) {
      const i = p.ind.h1Map.get(ts);
      if (i === undefined || i < 1) continue;
      const r = p.ind.r1[i];
      if (r === undefined || !isFinite(r)) continue;
      rets.push(r);
    }
    if (rets.length < 30) { dispSeries.push(NaN); tsList.push(ts); continue; }
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    let ss = 0;
    for (const v of rets) ss += (v - mean) ** 2;
    const stdev = Math.sqrt(ss / rets.length);
    dispSeries.push(stdev);
    tsList.push(ts);
  }

  // Rolling 7-day (168h) z-score of dispersion
  const W = 168;
  const zMap = new Map<number, number>();
  for (let i = 0; i < dispSeries.length; i++) {
    const ts = tsList[i]!;
    if (i < W) { zMap.set(ts, NaN); continue; }
    const val = dispSeries[i]!;
    if (!isFinite(val)) { zMap.set(ts, NaN); continue; }
    let sum = 0, cnt = 0;
    for (let j = i - W; j < i; j++) {
      const v = dispSeries[j]!;
      if (isFinite(v)) { sum += v; cnt++; }
    }
    if (cnt < W / 2) { zMap.set(ts, NaN); continue; }
    const m = sum / cnt;
    let ss = 0;
    for (let j = i - W; j < i; j++) {
      const v = dispSeries[j]!;
      if (isFinite(v)) ss += (v - m) ** 2;
    }
    const sd = Math.sqrt(ss / cnt);
    if (sd === 0) { zMap.set(ts, NaN); continue; }
    zMap.set(ts, (val - m) / sd);
  }

  return { zByTs: zMap };
}

// ──────────────────────────────────────────────
// Simulation
// ──────────────────────────────────────────────
type Mode =
  | { kind: "csdr"; dispHigh: number; dispLow: number; pairZ: number }
  | { kind: "garch" } // pure GARCH (baseline for comparison)
  | { kind: "garch+csdrgate"; dispHigh: number; dispLow: number }; // CSDR as gate

interface Cfg {
  label: string;
  margin: number;
  slPct: number;
  slSlipMult: number;
  trailAct: number; trailDist: number;
  mode: Mode;
  // GARCH z thresholds (for garch mode and gate mode)
  zL1: number; zS1: number; zL4: number; zS4: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface Res { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; numTrades: number; }

function simulate(
  pairs: PD[],
  disp: DispMap,
  cfg: Cfg,
  startTs: number,
  endTs: number,
  days: number,
): Res {
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

    // EXITS on every 5m bar
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
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Regime at this 1h bar (use last bar's z — no look-ahead)
    const dispZ = disp.zByTs.get(ts - H);
    const regimeHigh = dispZ !== undefined && isFinite(dispZ)
      ? (cfg.mode.kind === "csdr" ? dispZ > cfg.mode.dispHigh
         : cfg.mode.kind === "garch+csdrgate" ? dispZ > cfg.mode.dispHigh
         : false)
      : false;
    const regimeLow = dispZ !== undefined && isFinite(dispZ)
      ? (cfg.mode.kind === "csdr" ? dispZ < cfg.mode.dispLow
         : cfg.mode.kind === "garch+csdrgate" ? dispZ < cfg.mode.dispLow
         : false)
      : false;
    const regimeNeutral = !regimeHigh && !regimeLow;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;

      let dir: "long" | "short" | null = null;

      if (cfg.mode.kind === "csdr") {
        if (regimeNeutral) continue;
        const pz = cfg.mode.pairZ;
        if (regimeHigh) {
          // MOMENTUM: trade with the move
          if (z1 > pz) dir = "long";
          else if (z1 < -pz) dir = "short";
        } else if (regimeLow) {
          // MEAN REVERSION: fade the move
          if (z1 > pz) dir = "short";
          else if (z1 < -pz) dir = "long";
        }
      } else if (cfg.mode.kind === "garch") {
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) dir = "long";
        if (z1 < cfg.zS1 && z4 < cfg.zS4) dir = "short";
      } else if (cfg.mode.kind === "garch+csdrgate") {
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        let garchDir: "long" | "short" | null = null;
        if (z1 > cfg.zL1 && z4 > cfg.zL4) garchDir = "long";
        if (z1 < cfg.zS1 && z4 < cfg.zS4) garchDir = "short";
        if (!garchDir) continue;
        // GARCH is a momentum strat → require HIGH regime (momentum) OR neutral to trade
        // Under LOW regime, skip (would mean-revert against the GARCH signal)
        if (regimeLow) continue;
        dir = garchDir;
      }

      if (!dir) continue;

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

  return { totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr, numTrades: closed.length };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function printHeader() {
  console.log(`${"Config".padEnd(46)} ${"Period".padEnd(4)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"N".padStart(6)}`);
  console.log("-".repeat(100));
}
function printRes(label: string, is: Res, oos: Res) {
  console.log(`${label.padEnd(46)} ${"IS".padEnd(4)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(5)} ${is.wr.toFixed(1).padStart(6)} ${String(is.numTrades).padStart(6)}`);
  console.log(`${"".padEnd(46)} ${"OOS".padEnd(4)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(5)} ${oos.wr.toFixed(1).padStart(6)} ${String(oos.numTrades).padStart(6)}`);
}

function main() {
  console.log("=".repeat(110));
  console.log("  CSDR — Cross-Sectional Dispersion Regime");
  console.log("  Framework: 5m exits, 1h entries, trail 9/0.5, maxhold 24h, margin $15, block 22-23 UTC");
  console.log("  Walk-forward: IS Jun-Dec 2025 | OOS Dec 2025 - Mar 2026");
  console.log("=".repeat(110));

  console.log("\nLoading pair data...");
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
    const r1 = computeR1(h1);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, r1 }, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  console.log("\nBuilding cross-sectional dispersion regime series...");
  const disp = buildDispersion(pairs);
  // Quick distribution stats of disp_z
  const zs: number[] = [];
  for (const v of disp.zByTs.values()) if (isFinite(v)) zs.push(v);
  zs.sort((a, b) => a - b);
  const pct = (p: number) => zs[Math.floor(p * zs.length)]!;
  console.log(`  disp_z samples=${zs.length}  p5=${pct(0.05).toFixed(2)}  p25=${pct(0.25).toFixed(2)}  p50=${pct(0.50).toFixed(2)}  p75=${pct(0.75).toFixed(2)}  p95=${pct(0.95).toFixed(2)}`);
  const highFrac = zs.filter(v => v > 1.5).length / zs.length;
  const lowFrac = zs.filter(v => v < -1.5).length / zs.length;
  console.log(`  fraction HIGH (z>1.5)=${(highFrac*100).toFixed(1)}%  LOW (z<-1.5)=${(lowFrac*100).toFixed(1)}%`);

  const baseCfg: Cfg = {
    label: "",
    margin: MARGIN,
    slPct: 0.0015,
    slSlipMult: SL_SLIP,
    trailAct: 9, trailDist: 0.5,
    mode: { kind: "csdr", dispHigh: 1.5, dispLow: -1.5, pairZ: 3 },
    zL1: 2, zS1: -2, zL4: 1.5, zS4: -1.5,
  };

  // ──────────────────────────────────────────────
  // 1) CSDR standalone baseline
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(110));
  console.log("  TEST 1 — CSDR standalone baseline (disp ±1.5, pairZ 3, SL 0.15%)");
  console.log("=".repeat(110));
  printHeader();
  {
    const cfg = { ...baseCfg };
    const is = simulate(pairs, disp, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, disp, cfg, OOS_S, OOS_E, OOS_D);
    printRes("CSDR baseline", is, oos);
  }

  // ──────────────────────────────────────────────
  // 2) Dispersion z threshold sweep
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(110));
  console.log("  TEST 2 — Dispersion z threshold sweep (pairZ 3, SL 0.15%)");
  console.log("=".repeat(110));
  printHeader();
  for (const dz of [1.0, 1.5, 2.0]) {
    const cfg: Cfg = { ...baseCfg, mode: { kind: "csdr", dispHigh: dz, dispLow: -dz, pairZ: 3 } };
    const is = simulate(pairs, disp, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, disp, cfg, OOS_S, OOS_E, OOS_D);
    printRes(`disp±${dz.toFixed(1)}`, is, oos);
  }

  // ──────────────────────────────────────────────
  // 3) Pair entry z threshold sweep
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(110));
  console.log("  TEST 3 — Pair entry z-threshold sweep (disp ±1.5, SL 0.15%)");
  console.log("=".repeat(110));
  printHeader();
  for (const pz of [2, 3, 4]) {
    const cfg: Cfg = { ...baseCfg, mode: { kind: "csdr", dispHigh: 1.5, dispLow: -1.5, pairZ: pz } };
    const is = simulate(pairs, disp, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, disp, cfg, OOS_S, OOS_E, OOS_D);
    printRes(`pairZ ${pz}`, is, oos);
  }

  // ──────────────────────────────────────────────
  // 4) SL width sweep
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(110));
  console.log("  TEST 4 — SL width sweep (disp ±1.5, pairZ 3)");
  console.log("=".repeat(110));
  printHeader();
  for (const sl of [0.001, 0.0015, 0.002]) {
    const cfg: Cfg = { ...baseCfg, slPct: sl };
    const is = simulate(pairs, disp, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, disp, cfg, OOS_S, OOS_E, OOS_D);
    printRes(`SL ${(sl*100).toFixed(2)}%`, is, oos);
  }

  // ──────────────────────────────────────────────
  // 5) GARCH baseline + CSDR gate
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(110));
  console.log("  TEST 5 — GARCH baseline vs CSDR-gated GARCH");
  console.log("  GARCH: z1>2.0, z4>1.5 (longs) / z1<-2.0, z4<-1.5 (shorts), SL 0.15%");
  console.log("  CSDR gate: skip GARCH signals when disp_z < dispLow (LOW regime)");
  console.log("=".repeat(110));
  printHeader();
  {
    const cfg: Cfg = { ...baseCfg, mode: { kind: "garch" } };
    const is = simulate(pairs, disp, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, disp, cfg, OOS_S, OOS_E, OOS_D);
    printRes("GARCH pure", is, oos);
  }
  for (const dl of [-1.0, -1.5, -2.0]) {
    const cfg: Cfg = {
      ...baseCfg,
      mode: { kind: "garch+csdrgate", dispHigh: 999, dispLow: dl },
    };
    const is = simulate(pairs, disp, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, disp, cfg, OOS_S, OOS_E, OOS_D);
    printRes(`GARCH + CSDRgate(dispLow=${dl.toFixed(1)})`, is, oos);
  }

  console.log("\n" + "=".repeat(110));
  console.log("  DONE");
  console.log("=".repeat(110));
}

main();
