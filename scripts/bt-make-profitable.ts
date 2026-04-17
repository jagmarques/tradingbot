/**
 * MAKE IT PROFITABLE: aggressive search for any config that beats breakeven.
 *
 * Uses EXCHANGE SL (tick-level) because user already deployed that fix.
 * Varies entry signal, pair subset, SL width, trail, TP, direction (momentum vs MR).
 *
 * Baseline in this sim (from bt-exchange-sl-verify.ts):
 *   Bot SL before fix: -$1.86/day
 *   Exchange SL after: -$3.44/day
 *
 * Goal: find ANY config > $0/day, ideally > $2/day.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-make-profitable.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MOM_LB = 3;
const VOL_WIN = 20;
const MAX_HOLD_H = 72;
const CD_H = 1;
const FEE = 0.00035;
const MARGIN = 10;
const SL_SLIP = 1.5;

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
  z1: number[]; z4: number[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
}
interface PD { name: string; ind: PI; sp: number; lev: number; not: number; }

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

interface Cfg {
  label: string;
  zLong1h: number; zShort1h: number;
  zLong4h: number; zShort4h: number;
  mode: "momentum" | "meanrev"; // momentum: z>thresh -> long, meanrev: z>thresh -> short
  slPricePct: number;   // SL as % price move from entry
  trailAct: number;     // leveraged pnl % to activate trail
  trailDist: number;    // leveraged pnl % pullback from peak to exit
  tpPct?: number;       // optional leveraged TP %
  blockHours: Set<number>;
  minLev?: number;       // only pairs with lev >= this (e.g. 10 = majors only)
  maxHoldH?: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface SimResult {
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  avgWin: number;
  avgLoss: number;
  maxSingleLoss: number;
  numTrades: number;
  trailPct: number;
}

function simulate(pairs: PD[], cfg: Cfg): SimResult {
  const active = cfg.minLev ? pairs.filter(p => p.lev >= cfg.minLev!) : pairs;
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of active) {
    for (const b of p.ind.m5) {
      if (b.t >= OOS_S && b.t < OOS_E) all5mTimes.add(b.t);
    }
  }
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PD>();
  for (const p of active) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }

  const maxHold = cfg.maxHoldH ?? MAX_HOLD_H;

  for (const ts of timepoints) {
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    // ─── EXITS ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;

      if ((ts - pos.et) / H >= maxHold) { xp = bar.c; reason = "maxh"; }

      // Exchange SL: intra-bar high/low hit
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }

      // peak
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      // TP
      if (!xp && cfg.tpPct !== undefined) {
        const tpPrice = pos.dir === "long"
          ? pos.ep * (1 + cfg.tpPct / 100 / pos.lev)
          : pos.ep * (1 - cfg.tpPct / 100 / pos.lev);
        const tpHit = pos.dir === "long" ? bar.h >= tpPrice : bar.l <= tpPrice;
        if (tpHit) { xp = tpPrice; reason = "tp"; }
      }

      // Trail
      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) {
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

    // ─── ENTRIES ───
    if (!isH1Boundary) continue;
    if (cfg.blockHours.has(hourOfDay)) continue;

    for (const p of active) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      // Signal direction based on mode
      let dir: "long" | "short" | null = null;
      if (cfg.mode === "momentum") {
        if (z1 > cfg.zLong1h && z4 > cfg.zLong4h) dir = "long";
        if (z1 < cfg.zShort1h && z4 < cfg.zShort4h) dir = "short";
      } else {
        // mean reversion: high z -> short, low z -> long
        if (z1 > cfg.zLong1h && z4 > cfg.zLong4h) dir = "short";
        if (z1 < cfg.zShort1h && z4 < cfg.zShort4h) dir = "long";
      }
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * cfg.slPricePct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({ pair: p.name, dir, ep, et: ts, sl, pk: 0, sp: p.sp, lev: p.lev, not: p.not });
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
    avgWin: wins.length > 0 ? gp / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    trailPct: closed.length > 0 ? closed.filter(t => t.reason === "trail").length / closed.length * 100 : 0,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function buildConfigs(): Cfg[] {
  const out: Cfg[] = [];
  const BLOCK = new Set([22, 23]);

  // ─── TRACK A: Vary z-threshold (keep everything else current live) ───
  for (const z1 of [2.0, 2.5, 3.0, 3.5, 4.0, 5.0]) {
    for (const z4 of [1.5, 2.0, 2.5, 3.0]) {
      out.push({
        label: `MOM z1:${z1}/z4:${z4} sl0.3 trail9/0.5`,
        zLong1h: z1, zShort1h: -z1, zLong4h: z4, zShort4h: -z4,
        mode: "momentum", slPricePct: 0.003,
        trailAct: 9, trailDist: 0.5, blockHours: BLOCK,
      });
    }
  }

  // ─── TRACK B: REVERSE DIRECTION (mean reversion) ───
  for (const z1 of [2.0, 2.5, 3.0, 4.0]) {
    for (const z4 of [1.5, 2.0, 2.5]) {
      out.push({
        label: `MR z1:${z1}/z4:${z4} sl0.3 trail9/0.5`,
        zLong1h: z1, zShort1h: -z1, zLong4h: z4, zShort4h: -z4,
        mode: "meanrev", slPricePct: 0.003,
        trailAct: 9, trailDist: 0.5, blockHours: BLOCK,
      });
    }
  }

  // ─── TRACK C: Wider SL with momentum ───
  for (const slp of [0.005, 0.007, 0.01, 0.015]) {
    for (const z1 of [2.0, 3.0]) {
      out.push({
        label: `MOM z1:${z1}/z4:1.5 sl${(slp * 100).toFixed(1)}% trail9/0.5`,
        zLong1h: z1, zShort1h: -z1, zLong4h: 1.5, zShort4h: -1.5,
        mode: "momentum", slPricePct: slp,
        trailAct: 9, trailDist: 0.5, blockHours: BLOCK,
      });
    }
  }

  // ─── TRACK D: Tighter trail with momentum ───
  for (const trail of [{ a: 3, d: 0.2 }, { a: 5, d: 0.3 }, { a: 7, d: 0.3 }, { a: 5, d: 1 }, { a: 12, d: 0.5 }, { a: 15, d: 1 }]) {
    out.push({
      label: `MOM z1:2.0/z4:1.5 sl0.3 trail${trail.a}/${trail.d}`,
      zLong1h: 2.0, zShort1h: -2.0, zLong4h: 1.5, zShort4h: -1.5,
      mode: "momentum", slPricePct: 0.003,
      trailAct: trail.a, trailDist: trail.d, blockHours: BLOCK,
    });
  }

  // ─── TRACK E: Fixed TP (no trail) ───
  for (const tp of [3, 5, 7, 10, 15]) {
    out.push({
      label: `MOM z1:2.0/z4:1.5 sl0.3 TP${tp}%`,
      zLong1h: 2.0, zShort1h: -2.0, zLong4h: 1.5, zShort4h: -1.5,
      mode: "momentum", slPricePct: 0.003,
      trailAct: 999, trailDist: 999, tpPct: tp, blockHours: BLOCK,
    });
  }

  // ─── TRACK F: Majors-only (lev >= 10) ───
  out.push({
    label: "MOM z1:2.0/z4:1.5 sl0.3 trail9/0.5 10x-only",
    zLong1h: 2.0, zShort1h: -2.0, zLong4h: 1.5, zShort4h: -1.5,
    mode: "momentum", slPricePct: 0.003,
    trailAct: 9, trailDist: 0.5, blockHours: BLOCK, minLev: 10,
  });
  out.push({
    label: "MOM z1:3.0/z4:2.0 sl0.3 trail9/0.5 10x-only",
    zLong1h: 3.0, zShort1h: -3.0, zLong4h: 2.0, zShort4h: -2.0,
    mode: "momentum", slPricePct: 0.003,
    trailAct: 9, trailDist: 0.5, blockHours: BLOCK, minLev: 10,
  });
  out.push({
    label: "MR z1:3.0/z4:2.0 sl0.3 trail9/0.5 10x-only",
    zLong1h: 3.0, zShort1h: -3.0, zLong4h: 2.0, zShort4h: -2.0,
    mode: "meanrev", slPricePct: 0.003,
    trailAct: 9, trailDist: 0.5, blockHours: BLOCK, minLev: 10,
  });

  // ─── TRACK G: Longer max hold ───
  for (const mh of [24, 48, 120]) {
    out.push({
      label: `MOM z1:3.0/z4:2.0 sl0.5 trail12/0.5 mh${mh}h`,
      zLong1h: 3.0, zShort1h: -3.0, zLong4h: 2.0, zShort4h: -2.0,
      mode: "momentum", slPricePct: 0.005,
      trailAct: 12, trailDist: 0.5, blockHours: BLOCK, maxHoldH: mh,
    });
  }

  // ─── TRACK H: Best guess combo — strict z + wider SL + wider trail + MR ───
  for (const z1 of [2.5, 3.0, 3.5]) {
    for (const sl of [0.005, 0.007]) {
      for (const mode of ["momentum", "meanrev"] as const) {
        out.push({
          label: `${mode.toUpperCase().slice(0, 3)} z1:${z1}/z4:2.0 sl${(sl * 100).toFixed(1)}% trail12/0.5`,
          zLong1h: z1, zShort1h: -z1, zLong4h: 2.0, zShort4h: -2.0,
          mode, slPricePct: sl,
          trailAct: 12, trailDist: 0.5, blockHours: BLOCK,
        });
      }
    }
  }

  // ─── TRACK I: Extreme z-thresholds (rare but high quality) ───
  out.push({
    label: "MOM z1:5.0/z4:3.0 sl0.3 trail9/0.5 (extreme)",
    zLong1h: 5.0, zShort1h: -5.0, zLong4h: 3.0, zShort4h: -3.0,
    mode: "momentum", slPricePct: 0.003,
    trailAct: 9, trailDist: 0.5, blockHours: BLOCK,
  });
  out.push({
    label: "MR z1:5.0/z4:3.0 sl0.3 trail9/0.5 (extreme)",
    zLong1h: 5.0, zShort1h: -5.0, zLong4h: 3.0, zShort4h: -3.0,
    mode: "meanrev", slPricePct: 0.003,
    trailAct: 9, trailDist: 0.5, blockHours: BLOCK,
  });
  out.push({
    label: "MOM z1:6.0/z4:4.0 sl0.5 trail9/0.5 (ultra-extreme)",
    zLong1h: 6.0, zShort1h: -6.0, zLong4h: 4.0, zShort4h: -4.0,
    mode: "momentum", slPricePct: 0.005,
    trailAct: 9, trailDist: 0.5, blockHours: BLOCK,
  });

  return out;
}

function main() {
  console.log("=".repeat(130));
  console.log("  MAKE IT PROFITABLE — exchange SL already deployed, now find an entry/exit combo that profits");
  console.log(`  Period: ${OOS_D.toFixed(0)} days OOS`);
  console.log("=".repeat(130));

  console.log("\nLoading 5m + 1h + 4h...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, z1, z4, h1Map, h4Map }, sp: SP[n] ?? DSP, lev, not: MARGIN * lev });
  }
  console.log(`${pairs.length} pairs loaded`);

  const configs = buildConfigs();
  console.log(`Testing ${configs.length} configs...\n`);

  const hdr = `${"Config".padEnd(60)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"AvgW".padStart(7)} ${"AvgL".padStart(7)} ${"MaxL".padStart(8)} ${"Trl%".padStart(6)} ${"N".padStart(6)}`;
  console.log(hdr);
  console.log("-".repeat(130));

  const results: Array<{ cfg: Cfg; res: SimResult }> = [];
  for (const cfg of configs) {
    const res = simulate(pairs, cfg);
    results.push({ cfg, res });
    const line = `${cfg.label.padEnd(60).slice(0, 60)} ${fmtD(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(7)} ${res.pf.toFixed(2).padStart(5)} ${res.wr.toFixed(1).padStart(6)} ${fmtD(res.avgWin).padStart(7)} ${fmtD(res.avgLoss).padStart(7)} ${fmtD(res.maxSingleLoss).padStart(8)} ${res.trailPct.toFixed(1).padStart(6)} ${String(res.numTrades).padStart(6)}`;
    console.log(line);
  }

  console.log("\n" + "=".repeat(130));
  console.log("TOP 15 BY $/DAY");
  console.log("=".repeat(130));
  console.log(hdr);
  console.log("-".repeat(130));
  const sorted = [...results].sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of sorted.slice(0, 15)) {
    const line = `${r.cfg.label.padEnd(60).slice(0, 60)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(7)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.avgWin).padStart(7)} ${fmtD(r.res.avgLoss).padStart(7)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${r.res.trailPct.toFixed(1).padStart(6)} ${String(r.res.numTrades).padStart(6)}`;
    console.log(line);
  }

  const profitable = sorted.filter(r => r.res.dollarsPerDay > 0);
  console.log("\n" + "=".repeat(130));
  console.log(`PROFITABLE CONFIGS: ${profitable.length} of ${results.length}`);
  console.log("=".repeat(130));

  if (profitable.length === 0) {
    console.log("\nNO CONFIG IS PROFITABLE.");
    console.log("The GARCH v2 signal is fundamentally broken in this OOS period.");
    console.log("Recommendation: STOP the engine until entry logic is reworked.");
  } else {
    console.log("\nTOP 3 PROFITABLE DETAILED:");
    for (let i = 0; i < Math.min(3, profitable.length); i++) {
      const r = profitable[i]!;
      console.log(`\n#${i + 1}: ${r.cfg.label}`);
      console.log(`  Mode: ${r.cfg.mode}, SL: ${(r.cfg.slPricePct * 100).toFixed(2)}% price, Trail: ${r.cfg.trailAct}/${r.cfg.trailDist}`);
      console.log(`  Z thresholds: 1h=${r.cfg.zLong1h}, 4h=${r.cfg.zLong4h}`);
      console.log(`  $/day: ${fmtD(r.res.dollarsPerDay)}`);
      console.log(`  Total PnL: ${fmtD(r.res.totalPnl)} over ${OOS_D.toFixed(0)} days`);
      console.log(`  Max DD: $${r.res.maxDD.toFixed(2)}`);
      console.log(`  PF: ${r.res.pf.toFixed(2)}`);
      console.log(`  Win rate: ${r.res.wr.toFixed(1)}%`);
      console.log(`  Num trades: ${r.res.numTrades}`);
      console.log(`  Avg win: ${fmtD(r.res.avgWin)}  | Avg loss: ${fmtD(r.res.avgLoss)}`);
      console.log(`  Max single loss: ${fmtD(r.res.maxSingleLoss)}`);
    }
  }
}

main();
