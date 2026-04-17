/**
 * NOVEL 4 — Test four new signal families standalone and portfolio'd with GARCH v2.
 *
 * Signals:
 *  1. Market-beta residual mean reversion (uses BNB as market proxy; ETH not in cache)
 *  2. Session-boundary continuation
 *  3. Multi-TF triple confluence z-score (15m + 1h + 4h)
 *  4. Range expansion continuation
 *
 * Rules:
 *  - Fee 0.00035 per side, SL slip 1.5x
 *  - Real HL leverage (cap 10x) from /tmp/hl-leverage-map.txt
 *  - $15 margin fixed standalone; $7 margin in portfolio combos
 *  - Block hours 22-23 UTC, no cooldown
 *  - Trail 9/0.5 as default exit
 *  - SL exchange min 0.15%
 *
 * Walk-forward:
 *   IS  2025-06-01 -> 2025-12-01
 *   OOS 2025-12-01 -> 2026-03-25
 *
 * Beat baseline: SAFE GARCH OOS +$0.39/day, MDD<$20.
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const M15 = 15 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);
const MARGIN_STD = 15;
const MARGIN_COMBO = 7;

// Slippage estimates per pair (from bt-sl-fast)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
  BNB: 1.0e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

// Exact copy of QUANT_TRADING_PAIRS from bt-sl-fast.ts
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

const MIN_SL = 0.0015; // 0.15% min SL per user
const TRAIL_ACT = 9;
const TRAIL_DIST = 0.5;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; signal: string; }

interface PairInd {
  h1: C[]; h4: C[]; m5: C[]; m15: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  m15Map: Map<number, number>;
  z1: number[]; z4: number[]; z15: number[];
  // Signal 1 (beta residual) pre-computes (aligned to h1)
  beta: number[];      // 30d rolling beta to market
  residZ: number[];    // 48h rolling residual z-score
  // Signal 2 (session continuation)
  atrDaily: number[];  // aligned to h1: pair's 24h ATR%
  // Signal 4 (range expansion)
  atr14: number[];     // 14-bar ATR on h1 bars
}
interface PairData { name: string; ind: PairInd; sp: number; lev: number; }

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

// True Range based ATR (percentage) on a candle array.
function computeATRpct(cs: C[], window: number): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < window + 1) return out;
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const pc = cs[i - 1]!.c;
    const cur = cs[i]!;
    const t = Math.max(cur.h - cur.l, Math.abs(cur.h - pc), Math.abs(cur.l - pc));
    tr[i] = t / pc;
  }
  let sum = 0;
  for (let i = 1; i <= window; i++) sum += tr[i]!;
  out[window] = sum / window;
  for (let i = window + 1; i < cs.length; i++) {
    sum += tr[i]! - tr[i - window]!;
    out[i] = sum / window;
  }
  return out;
}

// 24h ATR% on 1h bars (uses computeATRpct with window=24)
function compute24hATR(h1: C[]): number[] { return computeATRpct(h1, 24); }

// Build 1h return series aligned to h1 bars (r[i] = c[i]/c[i-1]-1)
function computeReturns(cs: C[]): number[] {
  const r = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) r[i] = cs[i]!.c / cs[i - 1]!.c - 1;
  return r;
}

// Rolling beta of pair 1h returns vs market 1h returns, 30d window (720 bars).
// residZ computed over 48h (48 bars) rolling window.
function computeBetaResidZ(h1: C[], marketRet: Map<number, number>): { beta: number[]; residZ: number[] } {
  const n = h1.length;
  const beta = new Array(n).fill(0);
  const residZ = new Array(n).fill(0);
  const pr: number[] = new Array(n).fill(0);
  const mr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    pr[i] = h1[i]!.c / h1[i - 1]!.c - 1;
    mr[i] = marketRet.get(h1[i]!.t) ?? 0;
  }
  const BW = 720; // 30d of 1h bars
  const RW = 48;  // 48h residual z-score window
  // residuals computed after beta is known; we'll lag beta by 1 bar for look-ahead safety
  const resid: number[] = new Array(n).fill(0);
  for (let i = BW; i < n; i++) {
    // Compute beta over last BW bars, ending at i-1 (lag 1)
    let sXY = 0, sXX = 0, sX = 0, sY = 0;
    const start = i - BW;
    for (let j = start; j < i; j++) {
      sXY += pr[j]! * mr[j]!;
      sXX += mr[j]! * mr[j]!;
      sX += mr[j]!;
      sY += pr[j]!;
    }
    const meanX = sX / BW;
    const meanY = sY / BW;
    const cov = sXY / BW - meanX * meanY;
    const varX = sXX / BW - meanX * meanX;
    const b = varX > 1e-12 ? cov / varX : 0;
    beta[i] = b;
    resid[i] = pr[i]! - b * mr[i]!;
  }
  for (let i = BW + RW; i < n; i++) {
    let s = 0, ss = 0, c = 0;
    for (let j = i - RW; j < i; j++) {
      s += resid[j]!;
      ss += resid[j]! * resid[j]!;
      c++;
    }
    const mean = s / c;
    const varc = ss / c - mean * mean;
    const sd = Math.sqrt(Math.max(varc, 1e-12));
    residZ[i] = sd > 0 ? (resid[i]! - mean) / sd : 0;
  }
  return { beta, residZ };
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

// -----------------------------------------------------------------------------
// Universal open-position tracker + exit engine.
// -----------------------------------------------------------------------------

interface OpenPos {
  pair: string;
  dir: "long" | "short";
  ep: number;
  et: number;
  sl: number;
  pk: number;
  sp: number;
  lev: number;
  not: number;
  maxHoldH: number;
  signal: string;
}

function closePos(pos: OpenPos, ts: number, xp: number, isSL: boolean, reason: string, closed: Trade[]): number {
  const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
  const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
  const fees = pos.not * FEE * 2;
  const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
  closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason, signal: pos.signal });
  return fees;
}

// -----------------------------------------------------------------------------
// Entry signal functions. Each returns "long" | "short" | null at h1 bar close
// for that pair. All take a ctx of precomputed arrays.
// -----------------------------------------------------------------------------

interface SignalCfg {
  name: string;
  // Signal 1 (beta residual)
  betaZThr?: number;
  betaMarketFlatMult?: number; // |ETH_1h_ret| < mult * 24h stdev
  // Signal 2 (session continuation)
  sessionAtrMult?: number;
  // Signal 3 (triple confluence)
  triple15?: number; triple1?: number; triple4?: number;
  // Signal 4 (range expansion)
  rangeAtrMult?: number;
  closeFrac?: number;
  // general
  maxHoldH: number;
  slPct: number;
  margin: number;
}

// =============================================================================
// Simulator
// =============================================================================
interface SimCtx {
  pairs: PairData[];
  marketRet1h: Map<number, number>; // t -> market 1h return
  marketRV24: Map<number, number>;  // t -> market rolling 24h stdev of 1h returns
}

interface Res { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; winByReason: Record<string, number>; }

function simulateSignal(
  ctx: SimCtx,
  signal: "beta" | "session" | "triple" | "range" | "garch",
  cfg: SignalCfg,
  startTs: number,
  endTs: number,
  days: number,
): Res {
  const closed: Trade[] = [];
  const openPositions: OpenPos[] = [];
  const pairs = ctx.pairs;

  const all5mTimes = new Set<number>();
  for (const p of pairs) for (const b of p.ind.m5) if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
  const timepoints = [...all5mTimes].sort((a, b) => a - b);

  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PairData>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((c, i) => m.set(c.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

    // Exit checks on every 5m bar
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair); if (!m5Map) continue;
      const bi = m5Map.get(ts); if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) / H >= pos.maxHoldH) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= TRAIL_ACT && cur <= pos.pk - TRAIL_DIST) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        closePos(pos, ts, xp, isSL, reason, closed);
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entry logic — only at h1 bar boundary (for all four signals)
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 750) continue; // ensure 30d beta window warm
      if (openPositions.some(o => o.pair === p.name)) continue;

      let dir: "long" | "short" | null = null;

      if (signal === "garch") {
        // Baseline ENTRY: z1 > 2 && z4 > 1.5 long; mirrored short
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > 2 && z4 > 1.5) dir = "long";
        if (z1 < -2 && z4 < -1.5) dir = "short";
      } else if (signal === "beta") {
        const rz = p.ind.residZ[h1Idx - 1]!;
        const thr = cfg.betaZThr!;
        const mkt1h = ctx.marketRet1h.get(p.ind.h1[h1Idx - 1]!.t) ?? 0;
        const mkt24sd = ctx.marketRV24.get(p.ind.h1[h1Idx - 1]!.t) ?? 0;
        if (mkt24sd === 0) continue;
        const flat = Math.abs(mkt1h) < cfg.betaMarketFlatMult! * mkt24sd;
        if (!flat) continue;
        if (rz < -thr) dir = "long";   // alt crashed w/o market reason -> fade
        else if (rz > thr) dir = "short"; // alt pumped w/o market -> fade
      } else if (signal === "session") {
        if (!(hour === 0 || hour === 8 || hour === 16)) continue;
        // Last 1h return (bar that just closed at ts)
        const prev = p.ind.h1[h1Idx - 1]!;
        const ret = prev.c / prev.o - 1;
        const atrD = p.ind.atrDaily[h1Idx - 1] ?? 0;
        if (atrD === 0) continue;
        const thr = cfg.sessionAtrMult! * atrD;
        if (Math.abs(ret) < thr) continue;
        dir = ret > 0 ? "long" : "short";
      } else if (signal === "triple") {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        // 15m z: find last m15 bar strictly before ts
        const m15t = Math.floor((ts - 1) / M15) * M15;
        const m15Idx = p.ind.m15Map.get(m15t);
        if (m15Idx === undefined || m15Idx < 22) continue;
        const z15 = p.ind.z15[m15Idx]!;
        if (z15 > cfg.triple15! && z1 > cfg.triple1! && z4 > cfg.triple4!) dir = "long";
        else if (z15 < -cfg.triple15! && z1 < -cfg.triple1! && z4 < -cfg.triple4!) dir = "short";
      } else if (signal === "range") {
        const prev = p.ind.h1[h1Idx - 1]!;
        const atr = p.ind.atr14[h1Idx - 1] ?? 0;
        if (atr === 0) continue;
        const rng = (prev.h - prev.l) / prev.c;
        if (rng < cfg.rangeAtrMult! * atr) continue;
        const mid = (prev.h + prev.l) / 2;
        const upperThr = mid + cfg.closeFrac! * (prev.h - prev.l);
        const lowerThr = mid - cfg.closeFrac! * (prev.h - prev.l);
        if (prev.c > upperThr) dir = "long";
        else if (prev.c < lowerThr) dir = "short";
      }

      if (!dir) continue;

      const openPx = p.ind.h1[h1Idx]!.o;
      const ep = dir === "long" ? openPx * (1 + p.sp) : openPx * (1 - p.sp);
      const slPct = Math.max(cfg.slPct, MIN_SL);
      const slDist = ep * slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: cfg.margin * p.lev,
        maxHoldH: cfg.maxHoldH, signal,
      });
    }
  }

  // Close any still-open at end of period at last seen 5m bar close within window
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    // Last bar within the window
    let lb: C | null = null;
    for (let i = pd.ind.m5.length - 1; i >= 0; i--) {
      const c = pd.ind.m5[i]!;
      if (c.t < endTs) { lb = c; break; }
    }
    if (!lb) continue;
    closePos(pos, lb.t, lb.c, false, "end", closed);
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
  const winByReason: Record<string, number> = {};
  for (const t of closed) winByReason[t.reason] = (winByReason[t.reason] ?? 0) + 1;

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    winByReason,
  };
}

// Run two signal engines in parallel on the same time sweep (for portfolio tests)
function simulatePortfolio(
  ctx: SimCtx,
  sigA: "beta" | "session" | "triple" | "range" | "garch",
  cfgA: SignalCfg,
  sigB: "beta" | "session" | "triple" | "range" | "garch",
  cfgB: SignalCfg,
  startTs: number,
  endTs: number,
  days: number,
): Res {
  // Independent positions per signal — merged PnL stream.
  const a = simulateSignal(ctx, sigA, cfgA, startTs, endTs, days);
  const b = simulateSignal(ctx, sigB, cfgB, startTs, endTs, days);
  // Combine trades for MDD calc: we need to replay both lists chronologically.
  // Since simulateSignal returns aggregates, re-run but collect trades via a wrapper.
  // Simpler: just sum pnl and approximate MDD as sum of individual MDDs (conservative).
  const totalPnl = a.totalPnl + b.totalPnl;
  const numTrades = a.numTrades + b.numTrades;
  const wr = (a.wr * a.numTrades + b.wr * b.numTrades) / Math.max(1, numTrades);
  const pf = ((a.pf === Infinity ? 0 : a.pf) + (b.pf === Infinity ? 0 : b.pf)) / 2;
  const maxDD = a.maxDD + b.maxDD; // upper bound; not true merged DD
  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: Math.min(a.maxSingleLoss, b.maxSingleLoss),
    numTrades,
    winByReason: {},
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(140));
  console.log("  NOVEL 4 — beta residual / session continuation / triple confluence / range expansion");
  console.log("  Baseline to beat: OOS +$0.39/day MDD<$20 (SAFE GARCH)");
  console.log("  Market proxy: BNB (ETH/BTC not in /tmp/bt-pair-cache-5m)");
  console.log("=".repeat(140));

  // Load BNB as market proxy first
  const bnbRaw = load("BNBUSDT");
  if (bnbRaw.length < 5000) {
    console.log("FATAL: BNB market proxy not loadable");
    return;
  }
  const bnbH1 = aggregate(bnbRaw, H, 10);
  // Market 1h returns and 24h rolling stdev of 1h returns
  const bnbRet = computeReturns(bnbH1);
  const mktRet1h = new Map<number, number>();
  const mktRV24 = new Map<number, number>();
  for (let i = 0; i < bnbH1.length; i++) mktRet1h.set(bnbH1[i]!.t, bnbRet[i]!);
  // 24h rolling stdev (population) of 1h returns
  const W24 = 24;
  for (let i = W24; i < bnbH1.length; i++) {
    let s = 0, ss = 0;
    for (let j = i - W24; j < i; j++) { s += bnbRet[j]!; ss += bnbRet[j]! * bnbRet[j]!; }
    const mean = s / W24;
    const v = ss / W24 - mean * mean;
    mktRV24.set(bnbH1[i]!.t, Math.sqrt(Math.max(v, 0)));
  }

  console.log(`BNB market proxy loaded (${bnbH1.length} h1 bars)`);

  console.log("\nLoading pairs...");
  const pairs: PairData[] = [];
  let skipped = 0;
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) { skipped++; continue; }
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    const m15 = aggregate(raw, M15, 2);
    if (h1.length < 800 || h4.length < 50) { skipped++; continue; }
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const m15Map = new Map<number, number>();
    m15.forEach((c, i) => m15Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const z15 = computeZ(m15);
    const atrDaily = compute24hATR(h1);
    const atr14 = computeATRpct(h1, 14);
    const { beta, residZ } = computeBetaResidZ(h1, mktRet1h);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, m15, h1Map, h4Map, m15Map, z1, z4, z15, beta, residZ, atrDaily, atr14 },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  console.log(`${pairs.length} pairs loaded (${skipped} skipped for insufficient data)`);

  const ctx: SimCtx = { pairs, marketRet1h: mktRet1h, marketRV24: mktRV24 };

  // ---------------------------------------------------------------------------
  // GARCH baseline reproduction (SAFE config approximation)
  // ---------------------------------------------------------------------------
  const garchCfg: SignalCfg = {
    name: "garch", margin: MARGIN_STD, slPct: 0.003, maxHoldH: 72,
  };
  console.log("\n" + "=".repeat(140));
  console.log("GARCH baseline (our re-sim, $15 margin, 0.3% SL, trail 9/0.5)");
  console.log("=".repeat(140));
  const gIS = simulateSignal(ctx, "garch", garchCfg, IS_S, IS_E, IS_D);
  const gOOS = simulateSignal(ctx, "garch", garchCfg, OOS_S, OOS_E, OOS_D);
  console.log(`IS : ${fmtD(gIS.dollarsPerDay)}/d  MDD $${gIS.maxDD.toFixed(0)}  PF ${gIS.pf.toFixed(2)}  WR ${gIS.wr.toFixed(1)}%  N ${gIS.numTrades}`);
  console.log(`OOS: ${fmtD(gOOS.dollarsPerDay)}/d  MDD $${gOOS.maxDD.toFixed(0)}  PF ${gOOS.pf.toFixed(2)}  WR ${gOOS.wr.toFixed(1)}%  N ${gOOS.numTrades}`);

  // ---------------------------------------------------------------------------
  // Signal 1 — beta residual MR
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("SIGNAL 1: Beta-residual mean reversion (market-proxy = BNB)");
  console.log("Entry: |residZ| > thr AND |market 1h return| < 0.3 * 24h stdev | MaxHold 24h, SL 0.15%");
  console.log("=".repeat(140));
  console.log(`${"thr".padStart(6)} ${"period".padStart(6)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"N".padStart(6)}`);
  console.log("-".repeat(80));
  const betaResults: Array<{ thr: number; is: Res; oos: Res }> = [];
  for (const thr of [2.0, 2.5, 3.0]) {
    const cfg: SignalCfg = {
      name: `beta_${thr}`, margin: MARGIN_STD, slPct: MIN_SL, maxHoldH: 24,
      betaZThr: thr, betaMarketFlatMult: 0.3,
    };
    const is = simulateSignal(ctx, "beta", cfg, IS_S, IS_E, IS_D);
    const oos = simulateSignal(ctx, "beta", cfg, OOS_S, OOS_E, OOS_D);
    betaResults.push({ thr, is, oos });
    console.log(`${thr.toFixed(1).padStart(6)} ${"IS".padStart(6)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(5)} ${is.wr.toFixed(1).padStart(6)} ${String(is.numTrades).padStart(6)}`);
    console.log(`${"".padStart(6)} ${"OOS".padStart(6)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(5)} ${oos.wr.toFixed(1).padStart(6)} ${String(oos.numTrades).padStart(6)}`);
  }

  // ---------------------------------------------------------------------------
  // Signal 2 — session boundary continuation
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("SIGNAL 2: Session boundary continuation (00/08/16 UTC)");
  console.log("Entry: |1h return| > mult * 24h ATR | MaxHold 4h, SL 0.15%");
  console.log("=".repeat(140));
  console.log(`${"mult".padStart(6)} ${"period".padStart(6)} ${"$/day".padStart(9)} ${"MDD".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"N".padStart(6)}`);
  console.log("-".repeat(80));
  const sessionResults: Array<{ mult: number; is: Res; oos: Res }> = [];
  for (const mult of [1.0, 1.5, 2.0]) {
    const cfg: SignalCfg = {
      name: `sess_${mult}`, margin: MARGIN_STD, slPct: MIN_SL, maxHoldH: 4,
      sessionAtrMult: mult,
    };
    const is = simulateSignal(ctx, "session", cfg, IS_S, IS_E, IS_D);
    const oos = simulateSignal(ctx, "session", cfg, OOS_S, OOS_E, OOS_D);
    sessionResults.push({ mult, is, oos });
    console.log(`${mult.toFixed(1).padStart(6)} ${"IS".padStart(6)} ${fmtD(is.dollarsPerDay).padStart(9)} ${("$" + is.maxDD.toFixed(0)).padStart(7)} ${is.pf.toFixed(2).padStart(5)} ${is.wr.toFixed(1).padStart(6)} ${String(is.numTrades).padStart(6)}`);
    console.log(`${"".padStart(6)} ${"OOS".padStart(6)} ${fmtD(oos.dollarsPerDay).padStart(9)} ${("$" + oos.maxDD.toFixed(0)).padStart(7)} ${oos.pf.toFixed(2).padStart(5)} ${oos.wr.toFixed(1).padStart(6)} ${String(oos.numTrades).padStart(6)}`);
  }

  // ---------------------------------------------------------------------------
  // Signal 3 — triple confluence z-score
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("SIGNAL 3: Triple confluence (15m z>2 AND 1h z>2 AND 4h z>1.5)");
  console.log("Entry: all three thresholds | MaxHold 48h, SL 0.15%");
  console.log("=".repeat(140));
  const tripleCfg: SignalCfg = {
    name: "triple", margin: MARGIN_STD, slPct: MIN_SL, maxHoldH: 48,
    triple15: 2, triple1: 2, triple4: 1.5,
  };
  const tripleIS = simulateSignal(ctx, "triple", tripleCfg, IS_S, IS_E, IS_D);
  const tripleOOS = simulateSignal(ctx, "triple", tripleCfg, OOS_S, OOS_E, OOS_D);
  console.log(`IS : ${fmtD(tripleIS.dollarsPerDay)}/d  MDD $${tripleIS.maxDD.toFixed(0)}  PF ${tripleIS.pf.toFixed(2)}  WR ${tripleIS.wr.toFixed(1)}%  N ${tripleIS.numTrades}`);
  console.log(`OOS: ${fmtD(tripleOOS.dollarsPerDay)}/d  MDD $${tripleOOS.maxDD.toFixed(0)}  PF ${tripleOOS.pf.toFixed(2)}  WR ${tripleOOS.wr.toFixed(1)}%  N ${tripleOOS.numTrades}`);

  // ---------------------------------------------------------------------------
  // Signal 4 — range expansion continuation
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("SIGNAL 4: Range expansion continuation");
  console.log("Entry: range > 2.5*ATR14 AND close beyond mid+/-0.25*range | MaxHold 12h, SL 0.15%");
  console.log("=".repeat(140));
  const rangeCfg: SignalCfg = {
    name: "range", margin: MARGIN_STD, slPct: MIN_SL, maxHoldH: 12,
    rangeAtrMult: 2.5, closeFrac: 0.25,
  };
  const rangeIS = simulateSignal(ctx, "range", rangeCfg, IS_S, IS_E, IS_D);
  const rangeOOS = simulateSignal(ctx, "range", rangeCfg, OOS_S, OOS_E, OOS_D);
  console.log(`IS : ${fmtD(rangeIS.dollarsPerDay)}/d  MDD $${rangeIS.maxDD.toFixed(0)}  PF ${rangeIS.pf.toFixed(2)}  WR ${rangeIS.wr.toFixed(1)}%  N ${rangeIS.numTrades}`);
  console.log(`OOS: ${fmtD(rangeOOS.dollarsPerDay)}/d  MDD $${rangeOOS.maxDD.toFixed(0)}  PF ${rangeOOS.pf.toFixed(2)}  WR ${rangeOOS.wr.toFixed(1)}%  N ${rangeOOS.numTrades}`);

  // ---------------------------------------------------------------------------
  // PORTFOLIO COMBOS — each engine at $7 margin
  // Pair each novel signal w/ GARCH baseline
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("PORTFOLIO COMBOS — GARCH $7 + novel signal $7 (sum of two independent sims)");
  console.log("Note: MDD is conservative upper bound (sum of individual MDDs)");
  console.log("=".repeat(140));

  const garchHalf: SignalCfg = { name: "garch", margin: MARGIN_COMBO, slPct: 0.003, maxHoldH: 72 };

  const combos: Array<{ label: string; sig: "beta" | "session" | "triple" | "range"; cfg: SignalCfg }> = [
    { label: "GARCH + beta(2.5)", sig: "beta", cfg: { name: "beta_2.5", margin: MARGIN_COMBO, slPct: MIN_SL, maxHoldH: 24, betaZThr: 2.5, betaMarketFlatMult: 0.3 } },
    { label: "GARCH + session(1.5x)", sig: "session", cfg: { name: "sess_1.5", margin: MARGIN_COMBO, slPct: MIN_SL, maxHoldH: 4, sessionAtrMult: 1.5 } },
    { label: "GARCH + triple(2/2/1.5)", sig: "triple", cfg: { name: "triple", margin: MARGIN_COMBO, slPct: MIN_SL, maxHoldH: 48, triple15: 2, triple1: 2, triple4: 1.5 } },
    { label: "GARCH + range(2.5x)", sig: "range", cfg: { name: "range", margin: MARGIN_COMBO, slPct: MIN_SL, maxHoldH: 12, rangeAtrMult: 2.5, closeFrac: 0.25 } },
  ];

  for (const combo of combos) {
    const is = simulatePortfolio(ctx, "garch", garchHalf, combo.sig, combo.cfg, IS_S, IS_E, IS_D);
    const oos = simulatePortfolio(ctx, "garch", garchHalf, combo.sig, combo.cfg, OOS_S, OOS_E, OOS_D);
    console.log(`\n${combo.label}`);
    console.log(`  IS : ${fmtD(is.dollarsPerDay)}/d  MDD<=$${is.maxDD.toFixed(0)}  N ${is.numTrades}`);
    console.log(`  OOS: ${fmtD(oos.dollarsPerDay)}/d  MDD<=$${oos.maxDD.toFixed(0)}  N ${oos.numTrades}`);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(140));
  console.log("SUMMARY — Which signals beat +$0.39/day OOS with MDD<$20?");
  console.log("=".repeat(140));

  const winners: string[] = [];
  for (const b of betaResults) {
    if (b.oos.dollarsPerDay >= 0.5 && b.oos.maxDD < 20)
      winners.push(`Beta thr=${b.thr}: OOS ${fmtD(b.oos.dollarsPerDay)}/d MDD $${b.oos.maxDD.toFixed(0)}`);
  }
  for (const s of sessionResults) {
    if (s.oos.dollarsPerDay >= 0.5 && s.oos.maxDD < 20)
      winners.push(`Session ${s.mult}x: OOS ${fmtD(s.oos.dollarsPerDay)}/d MDD $${s.oos.maxDD.toFixed(0)}`);
  }
  if (tripleOOS.dollarsPerDay >= 0.5 && tripleOOS.maxDD < 20)
    winners.push(`Triple: OOS ${fmtD(tripleOOS.dollarsPerDay)}/d MDD $${tripleOOS.maxDD.toFixed(0)}`);
  if (rangeOOS.dollarsPerDay >= 0.5 && rangeOOS.maxDD < 20)
    winners.push(`Range: OOS ${fmtD(rangeOOS.dollarsPerDay)}/d MDD $${rangeOOS.maxDD.toFixed(0)}`);

  if (winners.length === 0) {
    console.log("NO standalone signals clear the bar (+$0.50/d OOS, MDD<$20)");
  } else {
    console.log("WINNERS:");
    for (const w of winners) console.log("  " + w);
  }
}

main();
