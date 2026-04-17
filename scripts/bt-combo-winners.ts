/**
 * Combine the best levers discovered:
 *   - Asymmetric thresholds (longs looser, shorts stricter)
 *   - volWin tuning (50 > 20)
 *   - Margin scaling ($10 -> $50)
 *
 * Reuses data loader from bt-push-profit pattern.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-combo-winners.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MAX_HOLD_H = 72;
const CD_H = 1;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);
const SL_PCT = 0.003;
const TRAIL_ACT = 9;
const TRAIL_DIST = 0.5;

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
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
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

function computeZ(cs: C[], momLB: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLB + 1, volWin + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - momLB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
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

interface Cfg {
  label: string;
  margin: number;
  zLong1h: number; zShort1h: number;
  zLong4h: number; zShort4h: number;
  volWin: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}
interface SimResult { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

const zCache = new Map<string, { z1: Map<string, number[]>; z4: Map<string, number[]> }>();
function getZ(pairs: PDLoaded[], momLB: number, volWin: number) {
  const key = `${momLB}_${volWin}`;
  let entry = zCache.get(key);
  if (!entry) {
    entry = { z1: new Map(), z4: new Map() };
    for (const p of pairs) {
      entry.z1.set(p.name, computeZ(p.ind.h1, momLB, volWin));
      entry.z4.set(p.name, computeZ(p.ind.h4, momLB, volWin));
    }
    zCache.set(key, entry);
  }
  return entry;
}

function simulate(pairs: PDLoaded[], cfg: Cfg): SimResult {
  const zData = getZ(pairs, 3, cfg.volWin);
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
  const pairByName = new Map<string, PDLoaded>();
  for (const p of pairs) {
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
        if (pos.pk >= TRAIL_ACT && cur <= pos.pk - TRAIL_DIST) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (!isH1Boundary) continue;
    if (BLOCK.has(hourOfDay)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < cfg.volWin + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = zData.z1.get(p.name)![h1Idx - 1]!;
      const z4 = get4hZ(zData.z4.get(p.name)!, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > cfg.zLong1h && z4 > cfg.zLong4h) dir = "long";
      if (z1 < cfg.zShort1h && z4 < cfg.zShort4h) dir = "short";
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * SL_PCT;
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
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
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
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function buildConfigs(): Cfg[] {
  const out: Cfg[] = [];

  // Baseline winners from previous run
  const winners = [
    // label, zLong1h, zShort1h, zLong4h, zShort4h
    ["A: long4/short6 z4=2", 4, -6, 2, -2],
    ["B: long5/short6 z4=2", 5, -6, 2, -2],
    ["C: long3/short6 z4=2", 3, -6, 2, -2],
    ["D: long4/short5 z4=2", 4, -5, 2, -2],
    ["E: long4/short6 z4=2.5", 4, -6, 2.5, -2.5],
    ["F: long4/short6 z4=3", 4, -6, 3, -3],
    ["G: long5/short6 z4=2.5", 5, -6, 2.5, -2.5],
    ["H: long3/short5 z4=2", 3, -5, 2, -2],
    ["I: long5/short5 z4=2 (symm)", 5, -5, 2, -2],
  ] as const;

  // Margin levels
  const margins = [10, 20, 30, 50];
  // volWin levels (20 default, 50 performed better)
  const volWins = [20, 50];

  for (const [label, zl, zs, zl4, zs4] of winners) {
    for (const m of margins) {
      for (const vw of volWins) {
        out.push({
          label: `${label} m=$${m} vw${vw}`,
          margin: m,
          zLong1h: zl as number, zShort1h: zs as number,
          zLong4h: zl4 as number, zShort4h: zs4 as number,
          volWin: vw,
        });
      }
    }
  }

  return out;
}

function main() {
  console.log("=".repeat(130));
  console.log("  COMBO WINNERS — stack asymmetric thresholds + volWin + margin scaling");
  console.log(`  Period: ${OOS_D.toFixed(0)} days, fixed: momLB=3, sl=0.3%, trail=9/0.5, exchange SL, blocked h22-23`);
  console.log("=".repeat(130));

  console.log("\nLoading data...");
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
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map }, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  const configs = buildConfigs();
  console.log(`Testing ${configs.length} configs...\n`);

  const hdr = `${"Config".padEnd(50)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`;
  console.log(hdr);
  console.log("-".repeat(130));

  const results: Array<{ cfg: Cfg; res: SimResult }> = [];
  for (const cfg of configs) {
    const res = simulate(pairs, cfg);
    results.push({ cfg, res });
    const line = `${cfg.label.padEnd(50).slice(0, 50)} ${fmtD(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(8)} ${res.pf.toFixed(2).padStart(5)} ${res.wr.toFixed(1).padStart(6)} ${fmtD(res.maxSingleLoss).padStart(8)} ${String(res.numTrades).padStart(6)}`;
    console.log(line);
  }

  console.log("\n" + "=".repeat(130));
  console.log("TOP 15 BY $/DAY");
  console.log("=".repeat(130));
  console.log(hdr);
  const sorted = [...results].sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of sorted.slice(0, 15)) {
    const line = `${r.cfg.label.padEnd(50).slice(0, 50)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(8)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`;
    console.log(line);
  }

  console.log("\n" + "=".repeat(130));
  console.log("TOP 10 BY RISK-ADJUSTED ($/day ÷ MaxDD × 100)");
  console.log("=".repeat(130));
  console.log(hdr);
  const byRisk = results.filter(r => r.res.dollarsPerDay > 0 && r.res.maxDD > 0)
    .sort((a, b) => (b.res.dollarsPerDay / b.res.maxDD) - (a.res.dollarsPerDay / a.res.maxDD));
  for (const r of byRisk.slice(0, 10)) {
    const ratio = (r.res.dollarsPerDay / r.res.maxDD * 100).toFixed(2);
    const line = `${r.cfg.label.padEnd(50).slice(0, 50)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(8)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}  ratio=${ratio}%`;
    console.log(line);
  }
}

main();
