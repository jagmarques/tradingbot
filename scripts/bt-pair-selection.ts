/**
 * PAIR SELECTION: find which pairs are profitable and which bleed.
 * Only trading the profitable subset could multiply returns.
 *
 * Uses base config: long>4, short<-6, z4=3, margin=$30, volWin=20, BE@7%, exchange SL.
 *
 * Also tests hour-by-hour P&L to find MORE bad hours beyond h22-23.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-pair-selection.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const CD_H = 1;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);
const MOM_LB = 3;
const VOL_WIN = 20;
const MARGIN = 30;
const MAX_HOLD_H = 72;

// Config (best known)
const Z_LONG_1H = 4;
const Z_SHORT_1H = -6;
const Z_LONG_4H = 3;
const Z_SHORT_4H = -3;
const SL_PCT = 0.003;
const TRAIL_ACT = 9;
const TRAIL_DIST = 0.5;
const BE_AT = 7;

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
const IS_E = new Date("2025-12-01").getTime(); // first 6 months = in-sample
const OOS_S = new Date("2025-12-01").getTime(); // last ~4 months = out-of-sample
const OOS_E = new Date("2026-03-25").getTime();
const IS_D = (IS_E - IS_S) / D;
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; entryTs: number; hourEntered: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
}
interface PDLoaded { name: string; ind: PI; sp: number; lev: number; }

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
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - MOM_LB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
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

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  beActivated: boolean;
  hourEntered: number;
}

function simulate(pairs: PDLoaded[], startTs: number, endTs: number, allowedPairs?: Set<string>, blockedHours?: Set<number>): Tr[] {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];
  const bh = blockedHours ?? BLOCK;
  const filtered = allowedPairs ? pairs.filter(p => allowedPairs.has(p.name)) : pairs;

  const all5mTimes = new Set<number>();
  for (const p of filtered) {
    for (const b of p.ind.m5) {
      if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
    }
  }
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PDLoaded>();
  for (const p of filtered) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;

      if ((ts - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = pos.beActivated ? "be" : "sl"; isSL = true; }
      }

      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      // BE@7%
      if (!xp && !pos.beActivated && pos.pk >= BE_AT) {
        pos.sl = pos.ep;
        pos.beActivated = true;
      }

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= TRAIL_ACT && cur <= pos.pk - TRAIL_DIST) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason, entryTs: pos.et, hourEntered: pos.hourEntered });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (!isH1Boundary) continue;
    if (bh.has(hourOfDay)) continue;

    for (const p of filtered) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > Z_LONG_1H && z4 > Z_LONG_4H) dir = "long";
      if (z1 < Z_SHORT_1H && z4 < Z_SHORT_4H) dir = "short";
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * SL_PCT;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: MARGIN * p.lev,
        beActivated: false,
        hourEntered: hourOfDay,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end", entryTs: pos.et, hourEntered: pos.hourEntered });
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);
  return closed;
}

interface Stats { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; numTrades: number; }
function computeStats(trades: Tr[], days: number): Stats {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  return { totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr, numTrades: trades.length };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(130));
  console.log("  PAIR SELECTION & HOUR ANALYSIS — find profitable subset using in-sample, validate OOS");
  console.log(`  Base config: long>${Z_LONG_1H}, short<${Z_SHORT_1H}, z4=${Z_LONG_4H}, margin=$${MARGIN}, BE@${BE_AT}%, trail ${TRAIL_ACT}/${TRAIL_DIST}`);
  console.log(`  In-sample: 2025-06-01 -> 2025-12-01 (${IS_D.toFixed(0)} days)`);
  console.log(`  Out-of-sample: 2025-12-01 -> 2026-03-25 (${OOS_D.toFixed(0)} days)`);
  console.log("=".repeat(130));

  console.log("\nLoading...");
  const pairs: PDLoaded[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4 }, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  // ── STEP 1: In-sample simulation, compute P&L per pair ──
  console.log("\nSTEP 1: IN-SAMPLE full run (all pairs)");
  const isAllTrades = simulate(pairs, IS_S, IS_E);
  const isAllStats = computeStats(isAllTrades, IS_D);
  console.log(`  All 102 pairs IS: $/day=${fmtD(isAllStats.dollarsPerDay)}, PF=${isAllStats.pf.toFixed(2)}, trades=${isAllStats.numTrades}`);

  // Per-pair stats
  const pairStats = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of isAllTrades) {
    const s = pairStats.get(t.pair) ?? { pnl: 0, trades: 0, wins: 0 };
    s.pnl += t.pnl;
    s.trades += 1;
    if (t.pnl > 0) s.wins += 1;
    pairStats.set(t.pair, s);
  }
  const sortedPairs = [...pairStats.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  console.log("\n  Top 20 pairs (IS P&L):");
  for (const [p, s] of sortedPairs.slice(0, 20)) {
    console.log(`    ${p.padEnd(10)} ${fmtD(s.pnl).padStart(9)} trades=${String(s.trades).padStart(4)} wr=${(s.wins / s.trades * 100).toFixed(0).padStart(3)}%`);
  }
  console.log("\n  Bottom 20 pairs (IS P&L):");
  for (const [p, s] of sortedPairs.slice(-20).reverse()) {
    console.log(`    ${p.padEnd(10)} ${fmtD(s.pnl).padStart(9)} trades=${String(s.trades).padStart(4)} wr=${(s.wins / s.trades * 100).toFixed(0).padStart(3)}%`);
  }

  // Hour-by-hour P&L (IS)
  console.log("\n  Hourly P&L distribution (IS, by entry hour):");
  const hourPnl = new Array(24).fill(0).map(() => ({ pnl: 0, trades: 0 }));
  for (const t of isAllTrades) {
    hourPnl[t.hourEntered]!.pnl += t.pnl;
    hourPnl[t.hourEntered]!.trades += 1;
  }
  for (let h = 0; h < 24; h++) {
    const { pnl, trades } = hourPnl[h]!;
    console.log(`    h${h.toString().padStart(2, "0")}: ${fmtD(pnl).padStart(9)} trades=${String(trades).padStart(4)} avg=${trades > 0 ? fmtD(pnl / trades).padStart(7) : "    —  "}`);
  }

  // Identify bad hours (negative P&L in IS)
  const badHours = new Set<number>();
  for (let h = 0; h < 24; h++) {
    if (hourPnl[h]!.pnl < 0) badHours.add(h);
  }
  console.log(`  Bad hours (negative IS P&L): ${[...badHours].sort((a, b) => a - b).join(", ")}`);

  // ── STEP 2: In-sample filtered by top-N pairs ──
  console.log("\nSTEP 2: IN-SAMPLE filtered by top-N positive pairs");
  const positivePairs = sortedPairs.filter(([, s]) => s.pnl > 0);
  console.log(`  ${positivePairs.length} pairs are IS-positive (out of ${sortedPairs.length})`);

  for (const n of [10, 20, 30, 40, 50, 60, positivePairs.length]) {
    const subset = new Set(positivePairs.slice(0, n).map(([p]) => p));
    const trades = simulate(pairs, IS_S, IS_E, subset);
    const stats = computeStats(trades, IS_D);
    console.log(`  Top ${String(n).padStart(3)} pairs IS: $/day=${fmtD(stats.dollarsPerDay).padStart(9)} MDD=$${stats.maxDD.toFixed(0).padStart(4)} PF=${stats.pf.toFixed(2)} trades=${String(stats.numTrades).padStart(5)}`);
  }

  // ── STEP 3: Out-of-sample validation ──
  console.log("\nSTEP 3: OUT-OF-SAMPLE validation (best IS subset applied to OOS)");
  const oosAllTrades = simulate(pairs, OOS_S, OOS_E);
  const oosAllStats = computeStats(oosAllTrades, OOS_D);
  console.log(`  All pairs OOS: $/day=${fmtD(oosAllStats.dollarsPerDay)} MDD=$${oosAllStats.maxDD.toFixed(0)} PF=${oosAllStats.pf.toFixed(2)} trades=${oosAllStats.numTrades}`);

  for (const n of [10, 20, 30, 40, 50, 60]) {
    const subset = new Set(positivePairs.slice(0, n).map(([p]) => p));
    const trades = simulate(pairs, OOS_S, OOS_E, subset);
    const stats = computeStats(trades, OOS_D);
    console.log(`  Top ${String(n).padStart(3)} pairs OOS: $/day=${fmtD(stats.dollarsPerDay).padStart(9)} MDD=$${stats.maxDD.toFixed(0).padStart(4)} PF=${stats.pf.toFixed(2)} trades=${String(stats.numTrades).padStart(5)}`);
  }

  // ── STEP 4: OOS with bad hours also blocked ──
  console.log("\nSTEP 4: OOS with IS bad hours also blocked");
  const allBadHours = new Set([...BLOCK, ...badHours]);
  console.log(`  Blocked hours: ${[...allBadHours].sort((a, b) => a - b).join(", ")}`);
  const oosHourFiltered = simulate(pairs, OOS_S, OOS_E, undefined, allBadHours);
  const oosHourStats = computeStats(oosHourFiltered, OOS_D);
  console.log(`  All pairs + bad hours blocked OOS: $/day=${fmtD(oosHourStats.dollarsPerDay)} MDD=$${oosHourStats.maxDD.toFixed(0)} PF=${oosHourStats.pf.toFixed(2)}`);

  // Combined: top pairs + bad hours
  for (const n of [20, 30, 50]) {
    const subset = new Set(positivePairs.slice(0, n).map(([p]) => p));
    const trades = simulate(pairs, OOS_S, OOS_E, subset, allBadHours);
    const stats = computeStats(trades, OOS_D);
    console.log(`  Top ${String(n).padStart(3)} pairs + bad hours blocked OOS: $/day=${fmtD(stats.dollarsPerDay).padStart(9)} MDD=$${stats.maxDD.toFixed(0).padStart(4)} PF=${stats.pf.toFixed(2)} trades=${String(stats.numTrades).padStart(5)}`);
  }

  // ── STEP 5: Full period with top pairs (for comparison to previous results) ──
  console.log("\nSTEP 5: FULL period (IS+OOS) with top-N pairs");
  const fullAllTrades = simulate(pairs, IS_S, OOS_E);
  const fullAllStats = computeStats(fullAllTrades, IS_D + OOS_D);
  console.log(`  All pairs full: $/day=${fmtD(fullAllStats.dollarsPerDay)} MDD=$${fullAllStats.maxDD.toFixed(0)} PF=${fullAllStats.pf.toFixed(2)} trades=${fullAllStats.numTrades}`);

  for (const n of [20, 30, 50]) {
    const subset = new Set(positivePairs.slice(0, n).map(([p]) => p));
    const trades = simulate(pairs, IS_S, OOS_E, subset);
    const stats = computeStats(trades, IS_D + OOS_D);
    console.log(`  Top ${String(n).padStart(3)} pairs full: $/day=${fmtD(stats.dollarsPerDay).padStart(9)} MDD=$${stats.maxDD.toFixed(0).padStart(4)} PF=${stats.pf.toFixed(2)} trades=${String(stats.numTrades).padStart(5)}`);
  }
}

main();
