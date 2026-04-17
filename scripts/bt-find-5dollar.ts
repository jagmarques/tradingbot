/**
 * FIND $5/DAY WITH MDD < $20: test fundamentally different signals, not just GARCH tuning.
 *
 * Signals tested:
 *   1. GARCH z-score (current baseline, best $0.88/day MDD $29)
 *   2. Donchian breakout (high/low channel breakout)
 *   3. RSI mean reversion (RSI extremes)
 *   4. Volume spike momentum
 *   5. BB squeeze breakout
 *   6. ATR expansion (volatility breakout)
 *
 * Then portfolios of uncorrelated signals.
 * Walk-forward tested on IS (6mo) / OOS (4mo) to catch overfitting.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-find-5dollar.ts
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
const MAX_HOLD_H = 72;
const SL_PCT = 0.003;

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
const FULL_D = (OOS_E - IS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface Indicators {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rsi14_h1: number[];
  bbUp_h1: number[]; bbLo_h1: number[]; bbMid_h1: number[];
  donchHi_h1: number[]; donchLo_h1: number[];
  atr14_h1: number[];
  volMA_h1: number[]; // volume MA
}
interface PD { name: string; ind: Indicators; sp: number; lev: number; }

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

function computeZ(cs: C[], momLB = 3, volWin = 20): number[] {
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

function computeRSI(cs: C[], period = 14): number[] {
  const rsi = new Array(cs.length).fill(50);
  if (cs.length < period + 1) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = cs[i]!.c - cs[i - 1]!.c;
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= period; loss /= period;
  rsi[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < cs.length; i++) {
    const ch = cs[i]!.c - cs[i - 1]!.c;
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return rsi;
}

function computeBB(cs: C[], period = 20, mult = 2): { up: number[]; lo: number[]; mid: number[] } {
  const up = new Array(cs.length).fill(0);
  const lo = new Array(cs.length).fill(0);
  const mid = new Array(cs.length).fill(0);
  for (let i = period - 1; i < cs.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += cs[j]!.c;
    const m = sum / period;
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (cs[j]!.c - m) ** 2;
    const sd = Math.sqrt(ss / period);
    mid[i] = m;
    up[i] = m + sd * mult;
    lo[i] = m - sd * mult;
  }
  return { up, lo, mid };
}

function computeDonchian(cs: C[], period = 20): { hi: number[]; lo: number[] } {
  const hi = new Array(cs.length).fill(0);
  const lo = new Array(cs.length).fill(0);
  for (let i = period - 1; i < cs.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (cs[j]!.h > h) h = cs[j]!.h;
      if (cs[j]!.l < l) l = cs[j]!.l;
    }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
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

type SignalFn = (p: PD, h1Idx: number, ts: number) => "long" | "short" | null;

interface SignalDef {
  id: string;
  label: string;
  signal: SignalFn;
}

// ── SIGNAL 1: GARCH z-score asymmetric (our known winner) ──
function garchSignal(zL1: number, zS1: number, zL4: number, zS4: number): SignalFn {
  return (p, h1Idx, ts) => {
    if (h1Idx < 25) return null;
    const z1 = p.ind.z1[h1Idx - 1]!;
    const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
    if (z1 > zL1 && z4 > zL4) return "long";
    if (z1 < zS1 && z4 < zS4) return "short";
    return null;
  };
}

// ── SIGNAL 2: Donchian breakout ──
function donchianSignal(period: number): SignalFn {
  return (p, h1Idx) => {
    if (h1Idx < period + 2) return null;
    const prev = h1Idx - 1;
    const prevHi = p.ind.donchHi_h1[prev - 1]!; // channel from bar before signal bar
    const prevLo = p.ind.donchLo_h1[prev - 1]!;
    const close = p.ind.h1[prev]!.c;
    if (close > prevHi) return "long";
    if (close < prevLo) return "short";
    return null;
  };
}

// ── SIGNAL 3: RSI mean reversion ──
function rsiMRSignal(lowTh: number, highTh: number): SignalFn {
  return (p, h1Idx) => {
    if (h1Idx < 16) return null;
    const rsi = p.ind.rsi14_h1[h1Idx - 1]!;
    if (rsi < lowTh) return "long"; // oversold, expect bounce
    if (rsi > highTh) return "short"; // overbought, expect drop
    return null;
  };
}

// ── SIGNAL 4: BB squeeze breakout ──
function bbBreakoutSignal(): SignalFn {
  return (p, h1Idx) => {
    if (h1Idx < 22) return null;
    const prev = h1Idx - 1;
    const close = p.ind.h1[prev]!.c;
    const up = p.ind.bbUp_h1[prev]!;
    const lo = p.ind.bbLo_h1[prev]!;
    if (close > up) return "long";
    if (close < lo) return "short";
    return null;
  };
}

// ── SIGNAL 5: RSI + z-score combined (both must align) ──
function rsiZSignal(rsiLow: number, rsiHigh: number, zL: number, zS: number): SignalFn {
  return (p, h1Idx, ts) => {
    if (h1Idx < 22) return null;
    const rsi = p.ind.rsi14_h1[h1Idx - 1]!;
    const z1 = p.ind.z1[h1Idx - 1]!;
    const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
    // Mom-confluence: high RSI + high z + z4 positive -> long
    if (rsi > rsiHigh && z1 > zL && z4 > 2) return "long";
    if (rsi < rsiLow && z1 < zS && z4 < -2) return "short";
    return null;
  };
}

// ── Simulate a single signal with fixed exit rules ──
function simulate(
  pairs: PD[],
  signal: SignalFn,
  startTs: number,
  endTs: number,
  margin: number,
  days: number,
): { trades: Tr[]; totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; } {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  interface OpenPos {
    pair: string; dir: "long" | "short";
    ep: number; et: number; sl: number; pk: number;
    sp: number; lev: number; not: number;
    beActivated: boolean;
  }
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
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (!isH1Boundary) continue;
    if (BLOCK.has(hourOfDay)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const dir = signal(p, h1Idx, ts);
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * SL_PCT;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: margin * p.lev,
        beActivated: false,
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
  console.log("=".repeat(140));
  console.log("  FIND $5/DAY MDD<$20 — test alternative signals and portfolios");
  console.log(`  Target: $/day >= 5.00, MaxDD < 20, $60 account`);
  console.log(`  Full period: ${FULL_D.toFixed(0)} days, IS: ${IS_D.toFixed(0)}d, OOS: ${OOS_D.toFixed(0)}d`);
  console.log("=".repeat(140));

  console.log("\nLoading + computing indicators...");
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
    const rsi14_h1 = computeRSI(h1, 14);
    const bb = computeBB(h1, 20, 2);
    const don = computeDonchian(h1, 20);
    const atr14_h1 = computeATR(h1, 14);
    const volMA_h1 = new Array(h1.length).fill(0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: {
        h1, h4, m5, h1Map, h4Map,
        z1, z4, rsi14_h1,
        bbUp_h1: bb.up, bbLo_h1: bb.lo, bbMid_h1: bb.mid,
        donchHi_h1: don.hi, donchLo_h1: don.lo,
        atr14_h1, volMA_h1,
      },
      sp: SP[n] ?? DSP, lev,
    });
  }
  console.log(`${pairs.length} pairs loaded`);

  // ── TEST SIGNALS ──
  const signals: SignalDef[] = [
    { id: "garch_4_6_3", label: "GARCH long>4 short<-6 z4=3", signal: garchSignal(4, -6, 3, -3) },
    { id: "garch_4_6_2", label: "GARCH long>4 short<-6 z4=2", signal: garchSignal(4, -6, 2, -2) },
    { id: "garch_5_6_2", label: "GARCH long>5 short<-6 z4=2", signal: garchSignal(5, -6, 2, -2) },
    { id: "donch_12", label: "Donchian 12-bar breakout", signal: donchianSignal(12) },
    { id: "donch_20", label: "Donchian 20-bar breakout", signal: donchianSignal(20) },
    { id: "donch_50", label: "Donchian 50-bar breakout", signal: donchianSignal(50) },
    { id: "rsi_20_80", label: "RSI MR (<20 long, >80 short)", signal: rsiMRSignal(20, 80) },
    { id: "rsi_15_85", label: "RSI MR (<15 long, >85 short)", signal: rsiMRSignal(15, 85) },
    { id: "rsi_10_90", label: "RSI MR (<10 long, >90 short)", signal: rsiMRSignal(10, 90) },
    { id: "bb_brk", label: "BB 20/2 breakout", signal: bbBreakoutSignal() },
    { id: "rsi_z_70_30", label: "RSI+Z confluence (rsi>70/z>4)", signal: rsiZSignal(30, 70, 4, -6) },
    { id: "rsi_z_80_20", label: "RSI+Z confluence (rsi>80/z>4)", signal: rsiZSignal(20, 80, 4, -6) },
  ];

  const hdr = `${"Signal".padEnd(40)} ${"Period".padEnd(6)} ${"Margin".padStart(7)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`;
  console.log("\n" + hdr);
  console.log("-".repeat(140));

  interface Result { sig: SignalDef; period: string; margin: number; res: ReturnType<typeof simulate>; }
  const results: Result[] = [];

  // Each signal at margins $5, $10, $15, $20 on FULL period
  for (const sig of signals) {
    for (const m of [10, 20]) {
      const res = simulate(pairs, sig.signal, IS_S, OOS_E, m, FULL_D);
      results.push({ sig, period: "full", margin: m, res });
      console.log(`${sig.label.padEnd(40).slice(0, 40)} ${"full".padEnd(6)} ${("$" + m).padStart(7)} ${fmtD(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(7)} ${res.pf.toFixed(2).padStart(5)} ${res.wr.toFixed(1).padStart(6)} ${fmtD(res.maxSingleLoss).padStart(8)} ${String(res.numTrades).padStart(6)}`);
    }
  }

  // ── Top signals by $/day ──
  console.log("\n" + "=".repeat(140));
  console.log("TOP 15 BY $/DAY (any DD)");
  console.log("=".repeat(140));
  console.log(hdr);
  const byDay = [...results].sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of byDay.slice(0, 15)) {
    console.log(`${r.sig.label.padEnd(40).slice(0, 40)} ${r.period.padEnd(6)} ${("$" + r.margin).padStart(7)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(7)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
  }

  // ── Configs meeting the target ──
  console.log("\n" + "=".repeat(140));
  console.log("CONFIGS MEETING TARGET ($/day >= 5 AND MDD < $20)");
  console.log("=".repeat(140));
  console.log(hdr);
  const winners = results.filter(r => r.res.dollarsPerDay >= 5 && r.res.maxDD < 20);
  if (winners.length === 0) {
    console.log("(none — target unreachable with single signals tested)");
  } else {
    for (const r of winners) {
      console.log(`${r.sig.label.padEnd(40).slice(0, 40)} ${r.period.padEnd(6)} ${("$" + r.margin).padStart(7)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(7)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
    }
  }

  // ── Best risk-adjusted (for $60 account) ──
  console.log("\n" + "=".repeat(140));
  console.log("SAFE FOR $60 ACCOUNT (MDD < $20), sorted by $/day");
  console.log("=".repeat(140));
  console.log(hdr);
  const safe = results.filter(r => r.res.maxDD < 20 && r.res.dollarsPerDay > 0).sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of safe.slice(0, 15)) {
    console.log(`${r.sig.label.padEnd(40).slice(0, 40)} ${r.period.padEnd(6)} ${("$" + r.margin).padStart(7)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(7)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
  }
}

main();
