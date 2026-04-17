/**
 * VALIDATE M15z6 finding via walk-forward.
 * In-sample: 2025-06-01 -> 2025-12-01 (6 months)
 * Out-of-sample: 2025-12-01 -> 2026-03-25 (4 months)
 *
 * Also check: concentration (top 5 pairs / top 5 days contribution),
 * uncapped leverage impact, sensitivity to z threshold.
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
const MAX_HOLD_H = 24;
const MARGIN = 10;
const SL_PCT = 0.0008;

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
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; entryTs: number; }
interface PI {
  h1: C[]; h4: C[]; m15: C[]; m5: C[];
  h1Map: Map<number, number>;
  m15Map: Map<number, number>;
  z15m: number[];
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

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  beActivated: boolean;
}

interface SimResult { trades: Tr[]; totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

function simulate(pairs: PD[], zThreshold: number, startTs: number, endTs: number, days: number): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of pairs) {
    for (const b of p.ind.m5) {
      if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
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

      if ((ts - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = pos.beActivated ? "be" : "sl"; isSL = true; }
      }

      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp && !pos.beActivated && pos.pk >= 7) {
        pos.sl = pos.ep;
        pos.beActivated = true;
      }

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= 9 && cur <= pos.pk - 0.5) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, entryTs: pos.et, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (!is15mBoundary) continue;
    if (BLOCK.has(hourOfDay)) continue;

    for (const p of pairs) {
      const m15Idx = p.ind.m15Map.get(ts);
      if (m15Idx === undefined || m15Idx < 25) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z15 = p.ind.z15m[m15Idx - 1]!;
      let dir: "long" | "short" | null = null;
      if (z15 > zThreshold) dir = "long";
      if (z15 < -zThreshold) dir = "short";
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      // Use current 5m bar open (no look-ahead)
      const m5Idx = m5Maps.get(p.name)!.get(ts);
      if (m5Idx === undefined) continue;
      const entryBar = p.ind.m5[m5Idx]!;
      const ep = dir === "long" ? entryBar.o * (1 + p.sp) : entryBar.o * (1 - p.sp);
      const slDist = ep * SL_PCT;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: MARGIN * p.lev,
        beActivated: false,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, entryTs: pos.et, pnl, reason: "end" });
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

  return {
    trades: closed,
    totalPnl,
    dollarsPerDay: totalPnl / days,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(130));
  console.log("  M15z6 VALIDATION — walk-forward + concentration analysis");
  console.log(`  IS: 2025-06-01 -> 2025-12-01 (${IS_D.toFixed(0)}d)`);
  console.log(`  OOS: 2025-12-01 -> 2026-03-25 (${OOS_D.toFixed(0)}d)`);
  console.log("=".repeat(130));

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
    const m15Map = new Map<number, number>();
    m15.forEach((c, i) => m15Map.set(c.t, i));
    const z15m = computeZ(m15);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m15, m5, h1Map, m15Map, z15m },
      sp: SP[n] ?? DSP, lev,
    });
  }
  console.log(`${pairs.length} pairs loaded`);

  console.log("\n=== WALK-FORWARD VALIDATION ===\n");
  console.log(`${"z-threshold".padEnd(15)} ${"Period".padEnd(6)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`);
  console.log("-".repeat(130));

  for (const z of [5, 5.5, 6, 6.5, 7, 8]) {
    const isRes = simulate(pairs, z, IS_S, IS_E, IS_D);
    const oosRes = simulate(pairs, z, OOS_S, OOS_E, OOS_D);
    const fullRes = simulate(pairs, z, IS_S, OOS_E, IS_D + OOS_D);
    const rowIs = `${"z>" + z + "/<" + (-z)}`.padEnd(15);
    console.log(`${rowIs} ${"IS".padEnd(6)} ${fmtD(isRes.dollarsPerDay).padStart(9)} ${("$" + isRes.maxDD.toFixed(0)).padStart(7)} ${isRes.pf.toFixed(2).padStart(5)} ${isRes.wr.toFixed(1).padStart(6)} ${fmtD(isRes.maxSingleLoss).padStart(8)} ${String(isRes.numTrades).padStart(6)}`);
    console.log(`${"".padEnd(15)} ${"OOS".padEnd(6)} ${fmtD(oosRes.dollarsPerDay).padStart(9)} ${("$" + oosRes.maxDD.toFixed(0)).padStart(7)} ${oosRes.pf.toFixed(2).padStart(5)} ${oosRes.wr.toFixed(1).padStart(6)} ${fmtD(oosRes.maxSingleLoss).padStart(8)} ${String(oosRes.numTrades).padStart(6)}`);
    console.log(`${"".padEnd(15)} ${"FULL".padEnd(6)} ${fmtD(fullRes.dollarsPerDay).padStart(9)} ${("$" + fullRes.maxDD.toFixed(0)).padStart(7)} ${fullRes.pf.toFixed(2).padStart(5)} ${fullRes.wr.toFixed(1).padStart(6)} ${fmtD(fullRes.maxSingleLoss).padStart(8)} ${String(fullRes.numTrades).padStart(6)}`);
    console.log("");
  }

  // Concentration analysis for z=6 full period
  console.log("\n=== CONCENTRATION ANALYSIS (z=6 full period) ===\n");
  const res = simulate(pairs, 6, IS_S, OOS_E, IS_D + OOS_D);
  console.log(`Total: ${res.numTrades} trades, ${fmtD(res.totalPnl)} net, PF ${res.pf.toFixed(2)}`);

  // Top 5 winners and losers
  const sortedByPnl = [...res.trades].sort((a, b) => b.pnl - a.pnl);
  console.log("\nTop 10 winning trades:");
  for (const t of sortedByPnl.slice(0, 10)) {
    console.log(`  ${t.pair.padEnd(10)} ${t.dir.padEnd(5)} ${fmtD(t.pnl).padStart(9)} ${t.reason}`);
  }
  console.log("\nTop 10 losing trades:");
  for (const t of sortedByPnl.slice(-10).reverse()) {
    console.log(`  ${t.pair.padEnd(10)} ${t.dir.padEnd(5)} ${fmtD(t.pnl).padStart(9)} ${t.reason}`);
  }

  // Per-pair breakdown
  const byPair = new Map<string, { trades: number; pnl: number }>();
  for (const t of res.trades) {
    const s = byPair.get(t.pair) ?? { trades: 0, pnl: 0 };
    s.trades++;
    s.pnl += t.pnl;
    byPair.set(t.pair, s);
  }
  const sortedPairs = [...byPair.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  console.log("\nTop 10 pairs by PnL:");
  for (const [name, s] of sortedPairs.slice(0, 10)) {
    console.log(`  ${name.padEnd(10)} ${fmtD(s.pnl).padStart(9)} trades=${s.trades}`);
  }
  console.log("\nBottom 10 pairs by PnL:");
  for (const [name, s] of sortedPairs.slice(-10).reverse()) {
    console.log(`  ${name.padEnd(10)} ${fmtD(s.pnl).padStart(9)} trades=${s.trades}`);
  }

  // What % of profit from top 5 pairs?
  const top5Pnl = sortedPairs.slice(0, 5).reduce((s, [, v]) => s + v.pnl, 0);
  const top10Pnl = sortedPairs.slice(0, 10).reduce((s, [, v]) => s + v.pnl, 0);
  console.log(`\nTop 5 pairs contribution: ${fmtD(top5Pnl)} (${(top5Pnl / res.totalPnl * 100).toFixed(0)}% of total)`);
  console.log(`Top 10 pairs contribution: ${fmtD(top10Pnl)} (${(top10Pnl / res.totalPnl * 100).toFixed(0)}% of total)`);

  // % of profit from biggest single trade
  const topTradePnl = sortedByPnl[0]!.pnl;
  console.log(`Single biggest trade: ${fmtD(topTradePnl)} (${(topTradePnl / res.totalPnl * 100).toFixed(0)}% of total)`);

  // Daily PnL concentration
  const dailyPnl = new Map<number, number>();
  for (const t of res.trades) {
    const day = Math.floor(t.exitTs / D);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  const sortedDays = [...dailyPnl.values()].sort((a, b) => b - a);
  const topDayPnl = sortedDays[0]!;
  const top5DaysPnl = sortedDays.slice(0, 5).reduce((s, x) => s + x, 0);
  console.log(`Single biggest day: ${fmtD(topDayPnl)} (${(topDayPnl / res.totalPnl * 100).toFixed(0)}% of total)`);
  console.log(`Top 5 days contribution: ${fmtD(top5DaysPnl)} (${(top5DaysPnl / res.totalPnl * 100).toFixed(0)}% of total)`);
  console.log(`Total days traded: ${dailyPnl.size}`);
}

main();
