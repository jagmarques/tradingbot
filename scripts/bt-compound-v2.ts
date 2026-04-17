/**
 * COMPOUND V2 — Higher margin caps to let $60 scale cleanly
 *
 * Engine A: GARCH long-only loose (z1h>2.0, z4h>1.5, SL 0.15%, trail 9/0.5, regime>1.5, maxH 72h)
 * Engine B: Range Expansion (range>=2.0*ATR14, close in extreme 25%, SL 0.15%, trail 9/0.5, regime>1.5, maxH 12h)
 *
 * Walk-forward:
 *   IS : 2025-06-01 -> 2025-12-01  (warm-up, starts at $60)
 *   OOS: 2025-12-01 -> 2026-03-25  (inherits IS-end equity)
 *
 * Tracks:
 *   - Final equity
 *   - MDD$ / MDD%running
 *   - $/day average and at final scale
 *   - Days-to-$200 / Days-to-$500 (counted from IS start)
 *   - Time-at-cap % (hours where either engine's margin was clamped to ceiling)
 *
 * Constraint: MaxDD < 33% of running equity
 *
 * Output: .company/backtester/compound-v2.txt
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
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
  // Separate caps per engine (A and B can differ, but set to same in most configs)
  maxMarginA: number;
  maxMarginB: number;
  pctA: number;
  pctB: number;
  fixedA?: number;  // if set, ignore pctA and use fixed $
  fixedB?: number;
  slPct: number;
  slSlipMult: number;
  trailAct: number; trailDist: number;
  regimeThr: number;
  zL1: number; zL4: number;
  rexMult: 2.0 | 2.5 | 3.0;
}

interface SimState {
  equity: number;
  peakEquity: number;
  maxDDDollar: number;
  maxDDPctRunning: number;
  minEquity: number;
  trades: Tr[];
  engPnl: Record<Engine, number>;
  engTrades: Record<Engine, number>;
  sumMarginA: number; nMarginA: number;
  sumMarginB: number; nMarginB: number;
  lastMarginA: number;
  lastMarginB: number;
  totalFees: number;
  // cap tracking
  cappedHoursA: number;
  cappedHoursB: number;
  totalHours: number;
  // trajectory markers (timestamps first reached)
  reached200Ts: number | null;
  reached500Ts: number | null;
  // equity curve (sampled once per hour at sizing step)
  equityHourly: { t: number; eq: number }[];
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
    cappedHoursA: 0, cappedHoursB: 0, totalHours: 0,
    reached200Ts: null, reached500Ts: null,
    equityHourly: [],
  };
}

function sizeA(equity: number, cfg: Cfg): { margin: number; capped: boolean } {
  let m = cfg.fixedA !== undefined ? cfg.fixedA : equity * cfg.pctA;
  let capped = false;
  if (m > cfg.maxMarginA) { m = cfg.maxMarginA; capped = true; }
  if (m < cfg.minMargin) m = cfg.minMargin;
  return { margin: m, capped };
}
function sizeB(equity: number, cfg: Cfg): { margin: number; capped: boolean } {
  let m = cfg.fixedB !== undefined ? cfg.fixedB : equity * cfg.pctB;
  let capped = false;
  if (m > cfg.maxMarginB) { m = cfg.maxMarginB; capped = true; }
  if (m < cfg.minMargin) m = cfg.minMargin;
  return { margin: m, capped };
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

        // trajectory markers
        if (state.reached200Ts === null && state.equity >= 200) state.reached200Ts = ts;
        if (state.reached500Ts === null && state.equity >= 500) state.reached500Ts = ts;

        state.trades.push({
          engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason,
          margin: pos.margin, equityAfter: state.equity,
        });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Sample equity and size margins
    state.totalHours++;
    const { margin: marginA, capped: capA } = sizeA(state.equity, cfg);
    const { margin: marginB, capped: capB } = sizeB(state.equity, cfg);
    if (capA) state.cappedHoursA++;
    if (capB) state.cappedHoursB++;
    state.lastMarginA = marginA;
    state.lastMarginB = marginB;
    state.equityHourly.push({ t: ts, eq: state.equity });

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

  // Close any still-open at end of period
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const bars = pd.ind.m5;
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
    if (state.reached200Ts === null && state.equity >= 200) state.reached200Ts = lb.t;
    if (state.reached500Ts === null && state.equity >= 500) state.reached500Ts = lb.t;
    state.trades.push({
      engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end",
      margin: pos.margin, equityAfter: state.equity,
    });
  }
}

interface Res {
  label: string;
  pctA: number; pctB: number;
  capA: number; capB: number;
  isEndEquity: number;
  isMaxDDDollar: number;
  isMaxDDPctRunning: number;
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
  // Combined (IS + OOS) trajectory
  daysTo200: number | null;
  daysTo500: number | null;
  timeAtCapPctA: number;
  timeAtCapPctB: number;
  timeAtCapPctAny: number;
  totalMaxDDPctRunning: number;
  safe: boolean;
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  const lines: string[] = [];
  const log = (s: string) => { console.log(s); lines.push(s); };

  log("=".repeat(160));
  log("  COMPOUND V2 — Higher caps so $60 can scale cleanly over 114 days OOS");
  log("  Engine A: GARCH long-only loose (z1h>2, z4h>1.5, SL 0.15%, trail 9/0.5, maxH 72h)");
  log("  Engine B: Range Expansion       (range>=2xATR14, close ext25%, SL 0.15%, trail 9/0.5, maxH 12h)");
  log("  Walk-forward: IS Jun-Dec 2025 (warmup from $60) | OOS Dec 2025 -> Mar 2026 (114d, inherits IS-end eq)");
  log("  Constraint  : MaxDD must stay < 33% of running equity");
  log("=".repeat(160));

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

  const base = {
    startEquity, minMargin,
    slPct: 0.0015, slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5,
    regimeThr: 1.5,
    zL1: 2.0, zL4: 1.5,
    rexMult: 2.0 as const,
  };

  const configs: Cfg[] = [
    // Fixed baseline (no compounding)
    { ...base, label: "Fixed $15+$15",   pctA: 0,    pctB: 0,    fixedA: 15, fixedB: 15, maxMarginA: 15, maxMarginB: 15 },
    // Symmetric compounding tiers
    { ...base, label: "10%+10% c40",     pctA: 0.10, pctB: 0.10, maxMarginA: 40,  maxMarginB: 40 },
    { ...base, label: "15%+15% c60",     pctA: 0.15, pctB: 0.15, maxMarginA: 60,  maxMarginB: 60 },
    { ...base, label: "20%+20% c80",     pctA: 0.20, pctB: 0.20, maxMarginA: 80,  maxMarginB: 80 },
    { ...base, label: "25%+25% c100",    pctA: 0.25, pctB: 0.25, maxMarginA: 100, maxMarginB: 100 },
    { ...base, label: "30%+30% c150",    pctA: 0.30, pctB: 0.30, maxMarginA: 150, maxMarginB: 150 },
    // A-heavier tilts
    { ...base, label: "10%A+5%B c60",    pctA: 0.10, pctB: 0.05, maxMarginA: 60,  maxMarginB: 60 },
    { ...base, label: "15%A+10%B c80",   pctA: 0.15, pctB: 0.10, maxMarginA: 80,  maxMarginB: 80 },
  ];

  log("\n" + "=".repeat(160));
  log("IS WARMUP (Jun-Dec 2025) — equity at end of IS carried into OOS");
  log("=".repeat(160));
  log(`${"Config".padEnd(18)} ${"Start".padStart(8)} ${"End".padStart(10)} ${"Pnl".padStart(10)} ${"MDD$".padStart(8)} ${"MDD%pk".padStart(8)} ${"Trds".padStart(6)} ${"A/B".padStart(10)} ${"Cap%A".padStart(7)} ${"Cap%B".padStart(7)}`);
  log("-".repeat(160));

  const results: Res[] = [];
  const isStates: SimState[] = [];

  for (const cfg of configs) {
    const isState = newState(cfg.startEquity);
    runPeriod(pairs, cfg, isState, IS_S, IS_E);
    isStates.push(isState);

    const isCapA = isState.totalHours > 0 ? (isState.cappedHoursA / isState.totalHours) * 100 : 0;
    const isCapB = isState.totalHours > 0 ? (isState.cappedHoursB / isState.totalHours) * 100 : 0;
    log(
      `${cfg.label.padEnd(18)} ` +
      `${("$" + cfg.startEquity.toFixed(0)).padStart(8)} ` +
      `${("$" + isState.equity.toFixed(2)).padStart(10)} ` +
      `${fmtD(isState.equity - cfg.startEquity).padStart(10)} ` +
      `${("$" + isState.maxDDDollar.toFixed(2)).padStart(8)} ` +
      `${(isState.maxDDPctRunning.toFixed(1) + "%").padStart(8)} ` +
      `${String(isState.trades.length).padStart(6)} ` +
      `${(isState.engTrades.garch + "/" + isState.engTrades.rex).padStart(10)} ` +
      `${(isCapA.toFixed(1) + "%").padStart(7)} ` +
      `${(isCapB.toFixed(1) + "%").padStart(7)}`
    );
  }

  log("\n" + "=".repeat(160));
  log("OOS RESULTS (Dec 2025 -> Mar 2026, 114d) — inherits IS-end equity");
  log("=".repeat(160));
  log(
    `${"Config".padEnd(18)} ` +
    `${"OOSStart".padStart(9)} ` +
    `${"OOSFinal".padStart(10)} ` +
    `${"Pnl".padStart(10)} ` +
    `${"Grw%".padStart(7)} ` +
    `${"MDD$".padStart(8)} ` +
    `${"MDD%pk".padStart(8)} ` +
    `${"$/dAvg".padStart(9)} ` +
    `${"$/dFin".padStart(9)} ` +
    `${"Trds".padStart(6)} ` +
    `${"PF".padStart(5)} ` +
    `${"WR%".padStart(6)} ` +
    `${"CapA%".padStart(6)} ` +
    `${"CapB%".padStart(6)} ` +
    `${"Safe".padStart(5)}`
  );
  log("-".repeat(160));

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;
    const isState = isStates[i]!;
    const isEndEquity = isState.equity;
    if (isEndEquity < minMargin * 2) {
      log(`  ${cfg.label} OOS SKIPPED — IS-end equity too low`);
      continue;
    }
    const oosState = newState(isEndEquity);
    runPeriod(pairs, cfg, oosState, OOS_S, OOS_E);

    // Combined trajectory: days to 200 / 500 starting from IS start
    let daysTo200: number | null = null;
    let daysTo500: number | null = null;
    // First check IS period
    if (isState.reached200Ts !== null) daysTo200 = (isState.reached200Ts - IS_S) / D;
    if (isState.reached500Ts !== null) daysTo500 = (isState.reached500Ts - IS_S) / D;
    // Then OOS (if not reached in IS). OOS starts at IS_D days from start.
    if (daysTo200 === null && oosState.reached200Ts !== null) daysTo200 = IS_D + (oosState.reached200Ts - OOS_S) / D;
    if (daysTo500 === null && oosState.reached500Ts !== null) daysTo500 = IS_D + (oosState.reached500Ts - OOS_S) / D;

    // Combined cap%
    const totalH = isState.totalHours + oosState.totalHours;
    const capA = totalH > 0 ? ((isState.cappedHoursA + oosState.cappedHoursA) / totalH) * 100 : 0;
    const capB = totalH > 0 ? ((isState.cappedHoursB + oosState.cappedHoursB) / totalH) * 100 : 0;
    const capAny = capA > capB ? capA : capB;

    // Overall MDD across IS+OOS: recompute from combined peak tracking.
    // Use the larger of running DDs observed in each period (approx — good enough).
    const totalMaxDDPctRunning = Math.max(isState.maxDDPctRunning, oosState.maxDDPctRunning);

    // OOS-specific metrics
    const pnl = oosState.equity - isEndEquity;
    const wins = oosState.trades.filter(t => t.pnl > 0);
    const losses = oosState.trades.filter(t => t.pnl <= 0);
    const wr = oosState.trades.length > 0 ? (wins.length / oosState.trades.length) * 100 : 0;
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = glAbs > 0 ? gp / glAbs : Infinity;
    const dpdAvg = pnl / OOS_D;

    // $/d at final scale: scale avg dpd by ratio of final-margin to avg-margin
    const avgMA = oosState.nMarginA > 0 ? oosState.sumMarginA / oosState.nMarginA : 0;
    const avgMB = oosState.nMarginB > 0 ? oosState.sumMarginB / oosState.nMarginB : 0;
    const { margin: finalMA } = sizeA(oosState.equity, cfg);
    const { margin: finalMB } = sizeB(oosState.equity, cfg);
    const avgTotal = avgMA + avgMB;
    const finalTotal = finalMA + finalMB;
    const dpdFinal = avgTotal > 0 ? dpdAvg * (finalTotal / avgTotal) : dpdAvg;

    const oosCapA = oosState.totalHours > 0 ? (oosState.cappedHoursA / oosState.totalHours) * 100 : 0;
    const oosCapB = oosState.totalHours > 0 ? (oosState.cappedHoursB / oosState.totalHours) * 100 : 0;

    const ddPctStart = (oosState.maxDDDollar / isEndEquity) * 100;
    const safe = totalMaxDDPctRunning < 33;

    const res: Res = {
      label: cfg.label,
      pctA: cfg.pctA, pctB: cfg.pctB,
      capA: cfg.maxMarginA, capB: cfg.maxMarginB,
      isEndEquity,
      isMaxDDDollar: isState.maxDDDollar,
      isMaxDDPctRunning: isState.maxDDPctRunning,
      oosStartEquity: isEndEquity,
      oosFinalEquity: oosState.equity,
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
      daysTo200, daysTo500,
      timeAtCapPctA: capA,
      timeAtCapPctB: capB,
      timeAtCapPctAny: capAny,
      totalMaxDDPctRunning,
      safe,
    };
    results.push(res);

    const growth = ((res.oosFinalEquity / res.oosStartEquity - 1) * 100).toFixed(1) + "%";
    log(
      `${cfg.label.padEnd(18)} ` +
      `${("$" + res.oosStartEquity.toFixed(2)).padStart(9)} ` +
      `${("$" + res.oosFinalEquity.toFixed(2)).padStart(10)} ` +
      `${fmtD(res.oosTotalPnl).padStart(10)} ` +
      `${growth.padStart(7)} ` +
      `${("$" + res.oosMaxDDDollar.toFixed(2)).padStart(8)} ` +
      `${(res.oosMaxDDPctRunning.toFixed(1) + "%").padStart(8)} ` +
      `${fmtD(res.oosDollarsPerDayAvg).padStart(9)} ` +
      `${fmtD(res.oosDollarsPerDayFinal).padStart(9)} ` +
      `${String(res.oosNumTrades).padStart(6)} ` +
      `${res.oosPf.toFixed(2).padStart(5)} ` +
      `${res.oosWr.toFixed(1).padStart(6)} ` +
      `${(oosCapA.toFixed(0) + "%").padStart(6)} ` +
      `${(oosCapB.toFixed(0) + "%").padStart(6)} ` +
      `${(res.safe ? "YES" : "NO").padStart(5)}`
    );
  }

  // Trajectory / cap / projection table
  log("\n" + "=".repeat(160));
  log("TRAJECTORY & CAP UTILIZATION (combined IS + OOS, ~235 days total)");
  log("=".repeat(160));
  log(
    `${"Config".padEnd(18)} ` +
    `${"ISEnd$".padStart(9)} ` +
    `${"OOSEnd$".padStart(10)} ` +
    `${"Peak$".padStart(9)} ` +
    `${"TotMDD%".padStart(9)} ` +
    `${"d->$200".padStart(9)} ` +
    `${"d->$500".padStart(9)} ` +
    `${"Cap%Any".padStart(9)} ` +
    `${"Cap%A".padStart(7)} ` +
    `${"Cap%B".padStart(7)}`
  );
  log("-".repeat(160));
  for (const r of results) {
    log(
      `${r.label.padEnd(18)} ` +
      `${("$" + r.isEndEquity.toFixed(2)).padStart(9)} ` +
      `${("$" + r.oosFinalEquity.toFixed(2)).padStart(10)} ` +
      `${("$" + r.oosPeakEquity.toFixed(2)).padStart(9)} ` +
      `${(r.totalMaxDDPctRunning.toFixed(1) + "%").padStart(9)} ` +
      `${(r.daysTo200 === null ? "n/a" : r.daysTo200.toFixed(0) + "d").padStart(9)} ` +
      `${(r.daysTo500 === null ? "n/a" : r.daysTo500.toFixed(0) + "d").padStart(9)} ` +
      `${(r.timeAtCapPctAny.toFixed(1) + "%").padStart(9)} ` +
      `${(r.timeAtCapPctA.toFixed(1) + "%").padStart(7)} ` +
      `${(r.timeAtCapPctB.toFixed(1) + "%").padStart(7)}`
    );
  }

  log("\n" + "=".repeat(160));
  log("PER-ENGINE OOS BREAKDOWN");
  log("=".repeat(160));
  log(`${"Config".padEnd(18)} ${"GARCH N".padStart(8)} ${"GARCH $".padStart(10)} ${"GARCH $/d".padStart(11)} ${"REX N".padStart(8)} ${"REX $".padStart(10)} ${"REX $/d".padStart(11)} ${"AvgA/B".padStart(13)} ${"FinA/B".padStart(13)}`);
  log("-".repeat(160));
  for (const r of results) {
    log(
      `${r.label.padEnd(18)} ` +
      `${String(r.oosGarchTrades).padStart(8)} ` +
      `${fmtD(r.oosGarchPnl).padStart(10)} ` +
      `${fmtD(r.oosGarchPnl / OOS_D).padStart(11)} ` +
      `${String(r.oosRexTrades).padStart(8)} ` +
      `${fmtD(r.oosRexPnl).padStart(10)} ` +
      `${fmtD(r.oosRexPnl / OOS_D).padStart(11)} ` +
      `${(r.oosAvgMarginA.toFixed(1) + "/" + r.oosAvgMarginB.toFixed(1)).padStart(13)} ` +
      `${(r.oosFinalMarginA.toFixed(1) + "/" + r.oosFinalMarginB.toFixed(1)).padStart(13)}`
    );
  }

  // Compute a proper 6-month simulated projection for each safe config:
  // Chain OOS growth rate forward. Use a daily compound rate implied by IS+OOS performance.
  log("\n" + "=".repeat(160));
  log("6-MONTH (240 DAY) PROJECTION — compound forward using observed daily growth rate");
  log("=".repeat(160));
  log(`${"Config".padEnd(18)} ${"$60->IS".padStart(10)} ${"IS->OOS".padStart(10)} ${"Total day".padStart(10)} ${"Daily g%".padStart(10)} ${"240d Eq".padStart(11)} ${"Hits $500?".padStart(12)}`);
  log("-".repeat(160));
  for (const r of results) {
    const totalDays = IS_D + OOS_D;
    const totalGrowth = r.oosFinalEquity / 60;
    // Compound daily: g = totalGrowth^(1/totalDays) - 1
    const dailyG = totalGrowth > 0 ? Math.pow(totalGrowth, 1 / totalDays) - 1 : 0;
    // Account for cap dampening: as equity grows past cap, pct-sizing stops scaling.
    // Simple model: if at OOS end margin is already capped, project LINEAR (final $/day) going forward.
    // If not capped, compound at dailyG until cap is reached, then linear.
    const finalTotalMargin = r.oosFinalMarginA + r.oosFinalMarginB;
    const maxTotalMargin = r.capA + r.capB;
    const capUtil = finalTotalMargin / maxTotalMargin;

    // Simulate day-by-day for 240 days
    let eq = 60;
    // Use IS+OOS blended daily P&L per $ of margin as baseline productivity
    // pnlPerMarginDay = totalPnl / totalDays / avgTotalMargin (during OOS)
    const avgTotal = r.oosAvgMarginA + r.oosAvgMarginB;
    // Use OOS only for productivity (forward-looking)
    const oosPnlPerMarginDay = avgTotal > 0 ? (r.oosTotalPnl / OOS_D) / avgTotal : 0;
    // Daily MDD shock applied via running % stability — just use expected path

    for (let d = 0; d < 240; d++) {
      const { margin: mA } = sizeA(eq, configs[results.indexOf(r)]!);
      const { margin: mB } = sizeB(eq, configs[results.indexOf(r)]!);
      const dayPnl = (mA + mB) * oosPnlPerMarginDay;
      eq += dayPnl;
      if (eq < 5) break;
    }

    log(
      `${r.label.padEnd(18)} ` +
      `${("$" + r.isEndEquity.toFixed(2)).padStart(10)} ` +
      `${("$" + r.oosFinalEquity.toFixed(2)).padStart(10)} ` +
      `${totalDays.toFixed(0).padStart(10)} ` +
      `${(dailyG * 100).toFixed(3).padStart(9)}% ` +
      `${("$" + eq.toFixed(2)).padStart(11)} ` +
      `${(eq >= 500 ? "YES" : "NO").padStart(12)}`
    );
  }

  log("\n" + "=".repeat(160));
  log("SAFETY CHECK: MaxDD must stay < 33% of running equity (combined IS + OOS)");
  log("=".repeat(160));
  for (const r of results) {
    const tag = r.safe ? "SAFE" : "BREACH";
    log(`  ${r.label.padEnd(18)} MDD ${r.totalMaxDDPctRunning.toFixed(1).padStart(5)}% of running peak — ${tag}`);
  }

  log("\n" + "=".repeat(160));
  log("VERDICT");
  log("=".repeat(160));
  const safe = results.filter(r => r.safe && r.label !== "Fixed $15+$15");
  const baseline = results.find(r => r.label === "Fixed $15+$15");
  if (baseline) {
    log(`  BASELINE Fixed $15+$15: OOS $${baseline.oosStartEquity.toFixed(2)} -> $${baseline.oosFinalEquity.toFixed(2)} | MDD ${baseline.totalMaxDDPctRunning.toFixed(1)}% | $/d ${fmtD(baseline.oosDollarsPerDayAvg)}`);
  }
  if (safe.length === 0) {
    log("  NO compound config passes MaxDD<33% — compounding too aggressive.");
  } else {
    // Rank by OOS final equity (bigger is better)
    safe.sort((a, b) => b.oosFinalEquity - a.oosFinalEquity);
    const best = safe[0]!;
    log("");
    log(`  BEST COMPOUND: ${best.label}`);
    log(`    $60 start -> IS end $${best.isEndEquity.toFixed(2)} -> OOS end $${best.oosFinalEquity.toFixed(2)}`);
    log(`    OOS profit: ${fmtD(best.oosTotalPnl)} (${((best.oosFinalEquity / best.oosStartEquity - 1) * 100).toFixed(1)}% OOS growth)`);
    log(`    Total growth from $60: ${((best.oosFinalEquity / 60 - 1) * 100).toFixed(1)}% over ${(IS_D + OOS_D).toFixed(0)} days`);
    log(`    MaxDD (combined)      : $${Math.max(best.isMaxDDDollar, best.oosMaxDDDollar).toFixed(2)} = ${best.totalMaxDDPctRunning.toFixed(1)}% of running peak`);
    log(`    Avg $/day OOS         : ${fmtD(best.oosDollarsPerDayAvg)}`);
    log(`    $/day at final scale  : ${fmtD(best.oosDollarsPerDayFinal)}`);
    log(`    Days-to-$200          : ${best.daysTo200 === null ? "not reached" : best.daysTo200.toFixed(0) + "d"}`);
    log(`    Days-to-$500          : ${best.daysTo500 === null ? "not reached" : best.daysTo500.toFixed(0) + "d"}`);
    log(`    Time-at-cap (any eng) : ${best.timeAtCapPctAny.toFixed(1)}% of all sizing hours`);
    log(`    Final margins A/B     : $${best.oosFinalMarginA.toFixed(2)} / $${best.oosFinalMarginB.toFixed(2)}`);
  }

  const outPath = ".company/backtester/compound-v2.txt";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"));
  log(`\nSaved to ${outPath}`);
}

main();
