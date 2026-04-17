/**
 * EXOTIC EXITS: test trailing/SL variants genuinely not covered before.
 *   1. ATR-based trailing stop (dynamic per pair volatility)
 *   2. Chandelier exit (peak high - N*ATR)
 *   3. Ultra-tight SL (0.1%, 0.15%, 0.2%)
 *   4. No SL (trail only + max hold safety)
 *   5. Hybrid: TP partial + trail runner
 *   6. Z-score flip exit (exit immediately on z sign change)
 *   7. Time-scaled trail (tightens over hold time)
 *   8. Ratcheting lock-in (lock profit at multiple levels)
 *   9. Reverse signal exit (exit when opposite signal fires on same pair)
 *
 * Base: long>4 short<-6 z4=3 m$10 (Config A). Goal: beat $0.35/day MDD $10.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-exotic-exits.ts
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
const MAX_HOLD_H = 72;
const MARGIN = 10;

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
  z1: number[]; z4: number[];
  atr14_h1: number[];
  atr14_m5: number[];
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
  for (let i = Math.max(4, 21); i < cs.length; i++) {
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

function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const hi = cs[i]!.h, lo = cs[i]!.l, pc = cs[i - 1]!.c;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    out[i + 1] = atr;
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
  // SL
  slMode: "fixed" | "atr_m5" | "none";
  slWidth: number; // price % for fixed, ATR multiplier for atr_m5
  slCapPct?: number; // max price % cap
  // TP
  tpPct?: number;
  // Trail
  trailMode: "none" | "fixed_lev" | "chandelier" | "atr_m5" | "time_scaled";
  trailAct: number; // leveraged %
  trailDist: number; // leveraged % OR ATR multiplier
  chandelierMult?: number; // N for peak_high - N*ATR
  timeScaleFactor?: number; // trail tightens by this factor per hour held
  // BE
  beAt?: number;
  // Ratchet (lock profit at levels)
  ratchetLevels?: Array<{ peak: number; lock: number }>;
  // Z-flip exit
  zFlipExit?: boolean;
  // Partial close
  partialAt?: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  pkPrice: number;
  sp: number; lev: number; not: number;
  beActivated: boolean;
  partialTaken: boolean;
  slLockedAt: number; // highest lock already achieved
}

interface SimResult { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

function simulate(pairs: PD[], cfg: Cfg): SimResult {
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
      const barsHeld = (ts - pos.et) / H;

      if (barsHeld >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      // SL check
      if (!xp && cfg.slMode !== "none") {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = pos.beActivated ? "be" : "sl"; isSL = true; }
      }

      // Update peak
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) {
        pos.pk = best;
        pos.pkPrice = pos.dir === "long" ? bar.h : bar.l;
      }

      // BE
      if (!xp && cfg.beAt !== undefined && !pos.beActivated && pos.pk >= cfg.beAt) {
        pos.sl = pos.ep;
        pos.beActivated = true;
      }

      // Ratcheting lock-in
      if (!xp && cfg.ratchetLevels) {
        for (const lv of cfg.ratchetLevels) {
          if (pos.pk >= lv.peak && pos.slLockedAt < lv.lock) {
            // Move SL to price corresponding to lv.lock leveraged pnl
            const priceMove = lv.lock / (pos.lev * 100);
            const newSl = pos.dir === "long" ? pos.ep * (1 + priceMove) : pos.ep * (1 - priceMove);
            pos.sl = newSl;
            pos.slLockedAt = lv.lock;
          }
        }
      }

      // TP
      if (!xp && cfg.tpPct !== undefined) {
        const tpPrice = pos.dir === "long"
          ? pos.ep * (1 + cfg.tpPct / 100 / pos.lev)
          : pos.ep * (1 - cfg.tpPct / 100 / pos.lev);
        const tpHit = pos.dir === "long" ? bar.h >= tpPrice : bar.l <= tpPrice;
        if (tpHit) { xp = tpPrice; reason = "tp"; }
      }

      // Partial close
      if (!xp && cfg.partialAt !== undefined && !pos.partialTaken && pos.pk >= cfg.partialAt) {
        const partPrice = pos.dir === "long"
          ? pos.ep * (1 + cfg.partialAt / 100 / pos.lev)
          : pos.ep * (1 - cfg.partialAt / 100 / pos.lev);
        const halfNot = pos.not / 2;
        const ex = pos.dir === "long" ? partPrice * (1 - pos.sp) : partPrice * (1 + pos.sp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * halfNot - halfNot * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason: "partial" });
        pos.not = halfNot;
        pos.partialTaken = true;
      }

      // Trail
      if (!xp && cfg.trailMode !== "none" && pos.pk >= cfg.trailAct) {
        let td = cfg.trailDist;
        if (cfg.trailMode === "time_scaled") {
          td = cfg.trailDist * Math.max(0.3, 1 - barsHeld * (cfg.timeScaleFactor ?? 0.05));
        }

        if (cfg.trailMode === "chandelier") {
          // Exit when price drops N*ATR from peak
          const atrIdx = bi;
          const atr = pd.ind.atr14_m5[atrIdx] ?? 0;
          const chandDist = atr * (cfg.chandelierMult ?? 3);
          const trigger = pos.dir === "long" ? pos.pkPrice - chandDist : pos.pkPrice + chandDist;
          const hit = pos.dir === "long" ? bar.c <= trigger : bar.c >= trigger;
          if (hit) { xp = bar.c; reason = "chand"; }
        } else if (cfg.trailMode === "atr_m5") {
          // Trail at N*ATR from peak
          const atrIdx = bi;
          const atr = pd.ind.atr14_m5[atrIdx] ?? 0;
          const chandDist = atr * td;
          const trigger = pos.dir === "long" ? pos.pkPrice - chandDist : pos.pkPrice + chandDist;
          const hit = pos.dir === "long" ? bar.c <= trigger : bar.c >= trigger;
          if (hit) { xp = bar.c; reason = "atrTrail"; }
        } else {
          // Fixed leveraged %
          const cur = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * pos.lev * 100
            : (pos.ep / bar.c - 1) * pos.lev * 100;
          if (cur <= pos.pk - td) { xp = bar.c; reason = "trail"; }
        }
      }

      // Z-flip exit
      if (!xp && cfg.zFlipExit && isH1Boundary) {
        const h1Idx = pd.ind.h1Map.get(ts);
        if (h1Idx !== undefined && h1Idx > 0) {
          const z1Now = pd.ind.z1[h1Idx - 1]!;
          if (pos.dir === "long" && z1Now < 0) { xp = bar.c; reason = "zflip"; }
          if (pos.dir === "short" && z1Now > 0) { xp = bar.c; reason = "zflip"; }
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
      if (h1Idx === undefined || h1Idx < 25) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > 4 && z4 > 3) dir = "long";
      if (z1 < -6 && z4 < -3) dir = "short";
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);

      let slDist: number;
      if (cfg.slMode === "atr_m5") {
        const m5MapX = m5Maps.get(p.name);
        const m5Idx = m5MapX?.get(ts);
        const atr = m5Idx !== undefined ? (p.ind.atr14_m5[m5Idx] ?? ep * 0.003) : ep * 0.003;
        slDist = atr * cfg.slWidth;
      } else {
        slDist = ep * cfg.slWidth;
      }
      if (cfg.slCapPct) slDist = Math.min(slDist, ep * cfg.slCapPct);
      const sl = cfg.slMode === "none"
        ? (dir === "long" ? 0 : Infinity)
        : (dir === "long" ? ep - slDist : ep + slDist);

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        pkPrice: ep,
        sp: p.sp, lev: p.lev, not: MARGIN * p.lev,
        beActivated: false,
        partialTaken: false,
        slLockedAt: 0,
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

  // Baseline
  out.push({
    label: "BASE: SL 0.3% + trail 9/0.5",
    slMode: "fixed", slWidth: 0.003, trailMode: "fixed_lev", trailAct: 9, trailDist: 0.5,
    beAt: 7,
  });

  // Ultra-tight SL
  for (const sl of [0.001, 0.0015, 0.002, 0.0025]) {
    out.push({
      label: `Tight SL ${(sl * 100).toFixed(2)}% + trail 9/0.5`,
      slMode: "fixed", slWidth: sl, trailMode: "fixed_lev", trailAct: 9, trailDist: 0.5,
      beAt: 7,
    });
  }

  // No SL
  out.push({
    label: "NO SL + trail 9/0.5 + BE@5",
    slMode: "none", slWidth: 0, trailMode: "fixed_lev", trailAct: 9, trailDist: 0.5,
    beAt: 5,
  });
  out.push({
    label: "NO SL + trail 5/0.5 + BE@3",
    slMode: "none", slWidth: 0, trailMode: "fixed_lev", trailAct: 5, trailDist: 0.5,
    beAt: 3,
  });

  // ATR-based SL
  for (const mult of [1, 2, 3]) {
    out.push({
      label: `ATR-SL ${mult}x m5 + trail 9/0.5`,
      slMode: "atr_m5", slWidth: mult, slCapPct: 0.01, trailMode: "fixed_lev", trailAct: 9, trailDist: 0.5,
      beAt: 7,
    });
  }

  // Chandelier exit (peak - N*ATR)
  for (const mult of [2, 3, 4, 5]) {
    out.push({
      label: `Chandelier ${mult}x ATR + SL 0.3%`,
      slMode: "fixed", slWidth: 0.003, trailMode: "chandelier", trailAct: 5, trailDist: 0,
      chandelierMult: mult, beAt: 7,
    });
  }

  // ATR-based trailing
  for (const mult of [1, 2, 3]) {
    out.push({
      label: `ATR-trail ${mult}x m5`,
      slMode: "fixed", slWidth: 0.003, trailMode: "atr_m5", trailAct: 5, trailDist: mult,
      beAt: 7,
    });
  }

  // Time-scaled trail (tightens over time)
  out.push({
    label: "Time-scaled trail (start 2, tighten)",
    slMode: "fixed", slWidth: 0.003, trailMode: "time_scaled", trailAct: 5, trailDist: 2, timeScaleFactor: 0.02,
    beAt: 5,
  });
  out.push({
    label: "Time-scaled trail (start 3, tighten fast)",
    slMode: "fixed", slWidth: 0.003, trailMode: "time_scaled", trailAct: 5, trailDist: 3, timeScaleFactor: 0.04,
    beAt: 5,
  });

  // Ratcheting lock-in
  out.push({
    label: "Ratchet 3/0, 5/2, 10/5, 20/10 + trail 9/0.5",
    slMode: "fixed", slWidth: 0.003,
    ratchetLevels: [{ peak: 3, lock: 0 }, { peak: 5, lock: 2 }, { peak: 10, lock: 5 }, { peak: 20, lock: 10 }],
    trailMode: "fixed_lev", trailAct: 20, trailDist: 1,
  });
  out.push({
    label: "Ratchet 5/2, 10/5, 20/15 + trail 30/1",
    slMode: "fixed", slWidth: 0.003,
    ratchetLevels: [{ peak: 5, lock: 2 }, { peak: 10, lock: 5 }, { peak: 20, lock: 15 }],
    trailMode: "fixed_lev", trailAct: 30, trailDist: 1,
  });
  out.push({
    label: "Ratchet aggressive 2/0,4/1,6/2,8/4,12/8",
    slMode: "fixed", slWidth: 0.003,
    ratchetLevels: [{ peak: 2, lock: 0 }, { peak: 4, lock: 1 }, { peak: 6, lock: 2 }, { peak: 8, lock: 4 }, { peak: 12, lock: 8 }],
    trailMode: "fixed_lev", trailAct: 15, trailDist: 1,
  });

  // TP + trail hybrid
  for (const tp of [3, 5, 7, 10]) {
    out.push({
      label: `TP ${tp}% (no trail)`,
      slMode: "fixed", slWidth: 0.003, tpPct: tp, trailMode: "none", trailAct: 999, trailDist: 999,
      beAt: 7,
    });
  }

  // Partial TP + trail runner
  out.push({
    label: "Partial @5% + trail 12/0.5",
    slMode: "fixed", slWidth: 0.003, partialAt: 5, trailMode: "fixed_lev", trailAct: 12, trailDist: 0.5,
    beAt: 7,
  });
  out.push({
    label: "Partial @3% + trail 9/0.5",
    slMode: "fixed", slWidth: 0.003, partialAt: 3, trailMode: "fixed_lev", trailAct: 9, trailDist: 0.5,
    beAt: 5,
  });

  // Z-flip exit
  out.push({
    label: "Z-flip exit + trail 9/0.5",
    slMode: "fixed", slWidth: 0.003, trailMode: "fixed_lev", trailAct: 9, trailDist: 0.5,
    beAt: 7, zFlipExit: true,
  });

  // Very wide trail (let winners run)
  for (const { a, d } of [{ a: 15, d: 5 }, { a: 20, d: 5 }, { a: 30, d: 5 }, { a: 15, d: 3 }]) {
    out.push({
      label: `Wide trail ${a}/${d}`,
      slMode: "fixed", slWidth: 0.003, trailMode: "fixed_lev", trailAct: a, trailDist: d,
      beAt: 7,
    });
  }

  return out;
}

function main() {
  console.log("=".repeat(140));
  console.log("  EXOTIC EXITS — ATR, chandelier, ultra-tight SL, no SL, ratchet, partial, z-flip");
  console.log("  Base: long>4 short<-6 z4=3 m$10, BE@7 (unless noted)");
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
    if (h1.length < 100 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const atr14_h1 = computeATR(h1, 14);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    const atr14_m5 = computeATR(m5, 14);
    const lev = getLev(n);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, atr14_h1, atr14_m5 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  console.log(`${pairs.length} pairs loaded`);

  const configs = buildConfigs();
  console.log(`Testing ${configs.length} configs...\n`);

  const hdr = `${"Config".padEnd(50)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`;
  console.log(hdr);
  console.log("-".repeat(140));

  const results: Array<{ cfg: Cfg; res: SimResult }> = [];
  for (const cfg of configs) {
    const res = simulate(pairs, cfg);
    results.push({ cfg, res });
    console.log(`${cfg.label.padEnd(50).slice(0, 50)} ${fmtD(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(8)} ${res.pf.toFixed(2).padStart(5)} ${res.wr.toFixed(1).padStart(6)} ${fmtD(res.maxSingleLoss).padStart(8)} ${String(res.numTrades).padStart(6)}`);
  }

  console.log("\n" + "=".repeat(140));
  console.log("TOP 15 BY $/DAY");
  console.log("=".repeat(140));
  console.log(hdr);
  const sorted = [...results].sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of sorted.slice(0, 15)) {
    console.log(`${r.cfg.label.padEnd(50).slice(0, 50)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(8)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
  }

  console.log("\n" + "=".repeat(140));
  console.log("SAFE (MDD < $20) sorted by $/day");
  console.log("=".repeat(140));
  console.log(hdr);
  const safe = results.filter(r => r.res.maxDD < 20 && r.res.dollarsPerDay > 0).sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of safe) {
    console.log(`${r.cfg.label.padEnd(50).slice(0, 50)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(8)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
  }
}

main();
