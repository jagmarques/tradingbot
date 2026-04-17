/**
 * COMPOUNDING COMBO BACKTEST — GARCH long-only loose + Range Expansion
 *
 * Two engines running in parallel on $60 starting equity, each sized as a %
 * of CURRENT equity (compounding). Equity updates as trades close.
 *
 * Engine A: GARCH long-only loose
 *   z1h > 2.0, z4h > 1.5, LONG ONLY (no shorts)
 *   SL 0.15%, trail 9/0.5, vol regime RV24/RV168 > 1.5, max hold 72h
 *
 * Engine B: Range Expansion
 *   1h range >= 2.0 * ATR14, close in upper/lower 25% of the bar
 *   SL 0.15%, trail 9/0.5, vol regime RV24/RV168 > 1.5, max hold 12h
 *
 * Compound rates (per engine):
 *   15% A + 8%  B
 *   20% A + 10% B
 *   25% A + 12% B
 *   30% A + 15% B
 *
 * Margin floor $5 (HL min), ceiling $50.
 *
 * Walk-forward:
 *   IS: 2025-06-01 -> 2025-12-01  ("warm up" equity)
 *   OOS: 2025-12-01 -> 2026-03-25 (starts with IS-end equity)
 *
 * MaxDD constraint: < 33% of running equity.
 *
 * Output: .company/backtester/compound-combo.txt
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

const GARCH_MAX_HOLD_H = 72;
const REX_MAX_HOLD_H = 12;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  atr1: number[];
  rv24: number[]; rv168: number[];
  rexSig20: Int8Array;
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

function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 2) return out;
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i]!.h, l = cs[i]!.l, pc = cs[i - 1]!.c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let atr = sum / period;
  out[period] = atr;
  for (let i = period + 1; i < cs.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
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

function computeRangeExpansion(h1: C[], atr1: number[], mult: number): Int8Array {
  const out = new Int8Array(h1.length);
  for (let i = 14; i < h1.length; i++) {
    const bar = h1[i]!;
    const a = atr1[i];
    if (!a || a <= 0) continue;
    const range = bar.h - bar.l;
    if (range < mult * a) continue;
    if (range <= 0) continue;
    const upper75 = bar.l + range * 0.75;
    const lower25 = bar.l + range * 0.25;
    if (bar.c >= upper75) out[i] = 1;
    else if (bar.c <= lower25) out[i] = -1;
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

type Engine = "garch" | "rex";

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number; margin: number;
  maxHoldH: number;
}

interface Tr {
  engine: Engine; pair: string; dir: "long" | "short";
  pnl: number; reason: string; exitTs: number;
  margin: number; equityAfter: number;
}

interface Cfg {
  label: string;
  startEquity: number;
  minMargin: number;
  maxMargin: number;
  pctA: number;   // GARCH long-only loose
  pctB: number;   // Range expansion
  slPct: number;
  slSlipMult: number;
  trailAct: number; trailDist: number;
  regimeThr: number;
  // GARCH loose long-only thresholds
  zL1: number; zL4: number;
  // REX
  rexMult: 2.0 | 2.5 | 3.0;
}

interface SimState {
  equity: number;
  peakEquity: number;
  maxDDDollar: number;
  maxDDPctRunning: number;   // running-equity DD %, max observed
  minEquity: number;
  trades: Tr[];
  // per-engine accumulators
  engPnl: Record<Engine, number>;
  engTrades: Record<Engine, number>;
  sumMarginA: number; nMarginA: number;
  sumMarginB: number; nMarginB: number;
  lastMarginA: number;
  lastMarginB: number;
  totalFees: number;
}

function newState(startEquity: number): SimState {
  return {
    equity: startEquity,
    peakEquity: startEquity,
    maxDDDollar: 0,
    maxDDPctRunning: 0,
    minEquity: startEquity,
    trades: [],
    engPnl: { garch: 0, rex: 0 },
    engTrades: { garch: 0, rex: 0 },
    sumMarginA: 0, nMarginA: 0,
    sumMarginB: 0, nMarginB: 0,
    lastMarginA: 0, lastMarginB: 0,
    totalFees: 0,
  };
}

function clampMargin(raw: number, cfg: Cfg): number {
  if (raw < cfg.minMargin) return cfg.minMargin;
  if (raw > cfg.maxMargin) return cfg.maxMargin;
  return raw;
}

function runPeriod(
  pairs: PD[],
  cfg: Cfg,
  state: SimState,
  startTs: number,
  endTs: number,
): void {
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

    // Exits
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
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        state.totalFees += fees;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;

        state.equity += pnl;
        state.engPnl[pos.engine] += pnl;
        state.engTrades[pos.engine] += 1;
        if (state.equity > state.peakEquity) state.peakEquity = state.equity;
        if (state.equity < state.minEquity) state.minEquity = state.equity;
        const ddAbs = state.peakEquity - state.equity;
        if (ddAbs > state.maxDDDollar) state.maxDDDollar = ddAbs;
        const ddPct = state.peakEquity > 0 ? (ddAbs / state.peakEquity) * 100 : 0;
        if (ddPct > state.maxDDPctRunning) state.maxDDPctRunning = ddPct;

        state.trades.push({
          engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason,
          margin: pos.margin, equityAfter: state.equity,
        });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Compute current margins from running equity
    const marginA = clampMargin(state.equity * cfg.pctA, cfg);
    const marginB = clampMargin(state.equity * cfg.pctB, cfg);
    state.lastMarginA = marginA;
    state.lastMarginB = marginB;

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // Engine A: GARCH long-only loose
      if (!openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) {
          const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
          const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
          if (rv24 > 0 && rv168 > 0 && rv24 / rv168 >= cfg.regimeThr) {
            const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
            if (inUse + marginA <= state.equity * 0.95) {
              const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
              const sl = ep * (1 - cfg.slPct);
              openPositions.push({
                engine: "garch", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: marginA * p.lev, margin: marginA,
                maxHoldH: GARCH_MAX_HOLD_H,
              });
              state.sumMarginA += marginA; state.nMarginA++;
            }
          }
        }
      }

      // Engine B: Range expansion
      if (!openPositions.some(o => o.pair === p.name && o.engine === "rex")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
          const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
          if (rv24 > 0 && rv168 > 0 && rv24 / rv168 >= cfg.regimeThr) {
            const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
            if (inUse + marginB <= state.equity * 0.95) {
              const dir: "long" | "short" = sig > 0 ? "long" : "short";
              const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
              const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
              openPositions.push({
                engine: "rex", pair: p.name, dir, ep, et: ts, sl, pk: 0,
                sp: p.sp, lev: p.lev, not: marginB * p.lev, margin: marginB,
                maxHoldH: REX_MAX_HOLD_H,
              });
              state.sumMarginB += marginB; state.nMarginB++;
            }
          }
        }
      }
    }
  }

  // Close any still-open at end of period using last 5m bar close
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const bars = pd.ind.m5;
    // find last bar before endTs
    let lb: C | null = null;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i]!.t < endTs) { lb = bars[i]!; break; } }
    if (!lb) continue;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    state.totalFees += fees;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    state.equity += pnl;
    state.engPnl[pos.engine] += pnl;
    state.engTrades[pos.engine] += 1;
    if (state.equity > state.peakEquity) state.peakEquity = state.equity;
    if (state.equity < state.minEquity) state.minEquity = state.equity;
    const ddAbs = state.peakEquity - state.equity;
    if (ddAbs > state.maxDDDollar) state.maxDDDollar = ddAbs;
    const ddPct = state.peakEquity > 0 ? (ddAbs / state.peakEquity) * 100 : 0;
    if (ddPct > state.maxDDPctRunning) state.maxDDPctRunning = ddPct;
    state.trades.push({
      engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end",
      margin: pos.margin, equityAfter: state.equity,
    });
  }
}

interface Res {
  label: string;
  pctA: number; pctB: number;
  isEndEquity: number;
  oosStartEquity: number;
  oosFinalEquity: number;
  oosTotalPnl: number;
  oosPeakEquity: number;
  oosMaxDDDollar: number;
  oosMaxDDPctRunning: number;
  oosMaxDDPctStart: number;
  oosDollarsPerDayAvg: number;
  oosDollarsPerDayFinal: number;
  oosNumTrades: number;
  oosGarchTrades: number;
  oosGarchPnl: number;
  oosRexTrades: number;
  oosRexPnl: number;
  oosAvgMarginA: number;
  oosAvgMarginB: number;
  oosFinalMarginA: number;
  oosFinalMarginB: number;
  oosPf: number;
  oosWr: number;
  safe: boolean;
}

function buildRes(cfg: Cfg, isEndEquity: number, oosState: SimState, days: number): Res {
  const oosStart = isEndEquity;
  const final = oosState.equity;
  const pnl = final - oosStart;
  const wins = oosState.trades.filter(t => t.pnl > 0);
  const losses = oosState.trades.filter(t => t.pnl <= 0);
  const wr = oosState.trades.length > 0 ? (wins.length / oosState.trades.length) * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;

  const avgMA = oosState.nMarginA > 0 ? oosState.sumMarginA / oosState.nMarginA : 0;
  const avgMB = oosState.nMarginB > 0 ? oosState.sumMarginB / oosState.nMarginB : 0;
  const finalMA = clampMargin(final * cfg.pctA, cfg);
  const finalMB = clampMargin(final * cfg.pctB, cfg);

  const dpdAvg = pnl / days;

  // Scale to final-margin level: assume $/day scales linearly with total margin deployed.
  // Compare avg margin vs final margin.
  const avgTotal = avgMA + avgMB;
  const finalTotal = finalMA + finalMB;
  const dpdFinal = avgTotal > 0 ? dpdAvg * (finalTotal / avgTotal) : dpdAvg;

  const ddPctStart = (oosState.maxDDDollar / oosStart) * 100;

  return {
    label: cfg.label,
    pctA: cfg.pctA, pctB: cfg.pctB,
    isEndEquity,
    oosStartEquity: oosStart,
    oosFinalEquity: final,
    oosTotalPnl: pnl,
    oosPeakEquity: oosState.peakEquity,
    oosMaxDDDollar: oosState.maxDDDollar,
    oosMaxDDPctRunning: oosState.maxDDPctRunning,
    oosMaxDDPctStart: ddPctStart,
    oosDollarsPerDayAvg: dpdAvg,
    oosDollarsPerDayFinal: dpdFinal,
    oosNumTrades: oosState.trades.length,
    oosGarchTrades: oosState.engTrades.garch,
    oosGarchPnl: oosState.engPnl.garch,
    oosRexTrades: oosState.engTrades.rex,
    oosRexPnl: oosState.engPnl.rex,
    oosAvgMarginA: avgMA,
    oosAvgMarginB: avgMB,
    oosFinalMarginA: finalMA,
    oosFinalMarginB: finalMB,
    oosPf: pf,
    oosWr: wr,
    safe: oosState.maxDDPctRunning < 33,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  const lines: string[] = [];
  const log = (s: string) => { console.log(s); lines.push(s); };

  log("=".repeat(150));
  log("  COMPOUND COMBO BACKTEST — GARCH long-only loose + Range Expansion (mult=2.0)");
  log("  GARCH A: z1h>2.0 z4h>1.5 LONG ONLY, SL 0.15%, trail 9/0.5, regime>1.5, maxH 72");
  log("  REX   B: range>=2.0*ATR14, close in upper/lower 25%, SL 0.15%, trail 9/0.5, regime>1.5, maxH 12");
  log("  Walk-forward: IS 2025-06-01 -> 2025-12-01 (warmup) | OOS 2025-12-01 -> 2026-03-25");
  log("  Margin per engine = running equity * pct, floor $5, ceiling $50. Start $60.");
  log("  CRITICAL: MaxDD must stay < 33% of running equity");
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
    const atr1 = computeATR(h1, 14);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const rexSig20 = computeRangeExpansion(h1, atr1, 2.0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, atr1, rv24, rv168, rexSig20 }, sp: SP[n] ?? DSP, lev });
  }
  log(`${pairs.length} pairs loaded`);
  log(`IS period: ${IS_D.toFixed(1)} days | OOS period: ${OOS_D.toFixed(1)} days`);

  const startEquity = 60;
  const minMargin = 5;
  const maxMargin = 50;

  const base = {
    startEquity, minMargin, maxMargin,
    slPct: 0.0015, slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5,
    regimeThr: 1.5,
    zL1: 2.0, zL4: 1.5,
    rexMult: 2.0 as const,
  };

  const configs: Cfg[] = [
    { ...base, label: "15%A + 8%B",  pctA: 0.15, pctB: 0.08 },
    { ...base, label: "20%A + 10%B", pctA: 0.20, pctB: 0.10 },
    { ...base, label: "25%A + 12%B", pctA: 0.25, pctB: 0.12 },
    { ...base, label: "30%A + 15%B", pctA: 0.30, pctB: 0.15 },
  ];

  log("\n" + "=".repeat(150));
  log("IS WARMUP (Jun-Dec 2025) — equity at end of IS is carried into OOS");
  log("=".repeat(150));
  log(`${"Config".padEnd(16)} ${"StartEq".padStart(9)} ${"EndEq".padStart(9)} ${"ISPnl".padStart(9)} ${"ISPeak".padStart(9)} ${"ISMDD$".padStart(9)} ${"ISMDD%pk".padStart(9)} ${"Trds".padStart(5)} ${"A/B Trds".padStart(10)}`);
  log("-".repeat(150));

  const results: Res[] = [];
  for (const cfg of configs) {
    // IS warmup
    const isState = newState(cfg.startEquity);
    runPeriod(pairs, cfg, isState, IS_S, IS_E);

    const isEndEquity = isState.equity;
    log(
      `${cfg.label.padEnd(16)} ` +
      `${("$" + cfg.startEquity.toFixed(2)).padStart(9)} ` +
      `${("$" + isEndEquity.toFixed(2)).padStart(9)} ` +
      `${fmtD(isEndEquity - cfg.startEquity).padStart(9)} ` +
      `${("$" + isState.peakEquity.toFixed(2)).padStart(9)} ` +
      `${("$" + isState.maxDDDollar.toFixed(2)).padStart(9)} ` +
      `${(isState.maxDDPctRunning.toFixed(1) + "%").padStart(9)} ` +
      `${String(isState.trades.length).padStart(5)} ` +
      `${(isState.engTrades.garch + "/" + isState.engTrades.rex).padStart(10)}`
    );

    // OOS: start with IS-end equity
    if (isEndEquity < minMargin * 2) {
      log(`  OOS SKIPPED — IS-end equity $${isEndEquity.toFixed(2)} too low to run both engines.`);
      continue;
    }
    const oosState = newState(isEndEquity);
    runPeriod(pairs, cfg, oosState, OOS_S, OOS_E);
    const res = buildRes(cfg, isEndEquity, oosState, OOS_D);
    results.push(res);
  }

  log("\n" + "=".repeat(150));
  log("OOS RESULTS (Dec 2025 -> Mar 2026, 114 days) — equity carried from IS end");
  log("=".repeat(150));
  log(
    `${"Config".padEnd(16)} ` +
    `${"OOS Start".padStart(10)} ` +
    `${"OOS Final".padStart(10)} ` +
    `${"OOS Pnl".padStart(9)} ` +
    `${"Growth%".padStart(8)} ` +
    `${"MDD$".padStart(8)} ` +
    `${"MDD%run".padStart(9)} ` +
    `${"$/d avg".padStart(9)} ` +
    `${"$/d fin".padStart(9)} ` +
    `${"Trds".padStart(5)} ` +
    `${"PF".padStart(5)} ` +
    `${"WR%".padStart(6)} ` +
    `${"AvgA/B".padStart(11)} ` +
    `${"FinA/B".padStart(11)} ` +
    `${"Safe".padStart(5)}`
  );
  log("-".repeat(150));
  for (const r of results) {
    const growth = ((r.oosFinalEquity / r.oosStartEquity - 1) * 100).toFixed(1) + "%";
    log(
      `${r.label.padEnd(16)} ` +
      `${("$" + r.oosStartEquity.toFixed(2)).padStart(10)} ` +
      `${("$" + r.oosFinalEquity.toFixed(2)).padStart(10)} ` +
      `${fmtD(r.oosTotalPnl).padStart(9)} ` +
      `${growth.padStart(8)} ` +
      `${("$" + r.oosMaxDDDollar.toFixed(2)).padStart(8)} ` +
      `${(r.oosMaxDDPctRunning.toFixed(1) + "%").padStart(9)} ` +
      `${fmtD(r.oosDollarsPerDayAvg).padStart(9)} ` +
      `${fmtD(r.oosDollarsPerDayFinal).padStart(9)} ` +
      `${String(r.oosNumTrades).padStart(5)} ` +
      `${r.oosPf.toFixed(2).padStart(5)} ` +
      `${r.oosWr.toFixed(1).padStart(6)} ` +
      `${(r.oosAvgMarginA.toFixed(0) + "/" + r.oosAvgMarginB.toFixed(0)).padStart(11)} ` +
      `${(r.oosFinalMarginA.toFixed(0) + "/" + r.oosFinalMarginB.toFixed(0)).padStart(11)} ` +
      `${(r.safe ? "YES" : "NO").padStart(5)}`
    );
  }

  log("\n" + "=".repeat(150));
  log("PER-ENGINE OOS BREAKDOWN");
  log("=".repeat(150));
  log(`${"Config".padEnd(16)} ${"GARCH N".padStart(8)} ${"GARCH $".padStart(10)} ${"GARCH $/d".padStart(11)} ${"REX N".padStart(8)} ${"REX $".padStart(10)} ${"REX $/d".padStart(11)}`);
  log("-".repeat(150));
  for (const r of results) {
    log(
      `${r.label.padEnd(16)} ` +
      `${String(r.oosGarchTrades).padStart(8)} ` +
      `${fmtD(r.oosGarchPnl).padStart(10)} ` +
      `${fmtD(r.oosGarchPnl / OOS_D).padStart(11)} ` +
      `${String(r.oosRexTrades).padStart(8)} ` +
      `${fmtD(r.oosRexPnl).padStart(10)} ` +
      `${fmtD(r.oosRexPnl / OOS_D).padStart(11)}`
    );
  }

  log("\n" + "=".repeat(150));
  log("SAFETY CHECK: MaxDD must stay < 33% of running equity");
  log("=".repeat(150));
  for (const r of results) {
    const tag = r.oosMaxDDPctRunning < 33 ? "SAFE" : "BREACH";
    log(`  ${r.label.padEnd(16)} MDD ${r.oosMaxDDPctRunning.toFixed(1)}% of running peak — ${tag}`);
  }

  log("\n" + "=".repeat(150));
  log("VERDICT");
  log("=".repeat(150));
  const safe = results.filter(r => r.safe);
  if (safe.length === 0) {
    log("  NO config passes MaxDD<33% — compounding too aggressive at any tested rate.");
  } else {
    const best = safe.reduce((a, b) => b.oosFinalEquity > a.oosFinalEquity ? b : a);
    log(`  BEST SAFE: ${best.label}`);
    log(`    Start $60 -> IS end $${best.isEndEquity.toFixed(2)} -> OOS end $${best.oosFinalEquity.toFixed(2)}`);
    log(`    OOS profit over 114 days: ${fmtD(best.oosTotalPnl)} (${((best.oosFinalEquity / best.oosStartEquity - 1) * 100).toFixed(1)}% growth)`);
    log(`    MaxDD $${best.oosMaxDDDollar.toFixed(2)} = ${best.oosMaxDDPctRunning.toFixed(1)}% of running peak`);
    log(`    Avg $/day across OOS: ${fmtD(best.oosDollarsPerDayAvg)}`);
    log(`    $/day at FINAL margin scale: ${fmtD(best.oosDollarsPerDayFinal)}`);
    log(`    Final margin levels: A=$${best.oosFinalMarginA.toFixed(2)} B=$${best.oosFinalMarginB.toFixed(2)}`);
    log(`    Engine split: GARCH ${best.oosGarchTrades} trades / ${fmtD(best.oosGarchPnl)} | REX ${best.oosRexTrades} trades / ${fmtD(best.oosRexPnl)}`);

    // 90-day honest projection: use average $/day from OOS (not final scale which implies equity already grew)
    const ninetyAvg = best.oosDollarsPerDayAvg * 90;
    const ninetyFinal = best.oosDollarsPerDayFinal * 90;
    log("");
    log("  HONEST 90-DAY PROJECTION:");
    log(`    Conservative (avg OOS $/day * 90)    : ${fmtD(ninetyAvg)} total profit`);
    log(`    Optimistic   (final-scale $/day * 90): ${fmtD(ninetyFinal)} total profit`);
    log(`    Realistic range: ${fmtD(ninetyAvg)} to ${fmtD(ninetyFinal)}`);
  }

  const outPath = ".company/backtester/compound-combo.txt";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"));
  log(`\nSaved to ${outPath}`);
}

main();
