/**
 * AUDIT: GARCH long-only ATR regime scaling claim.
 *
 * Verifies the claim from .company/backtester/portfolio-atr.txt that:
 *   - GARCH ATR1.8 m$30 -> +$2.71/day, MDD $6.27
 *   - GARCH ATR1.8 m$60 -> +$5.42/day, MDD $12.54 (real re-sim, not extrapolation)
 *   - Portfolio A$60+B$15 ATR1.8/1.6 -> +$7.29/day, MDD $13.20
 *
 * HARDENED anti-lookahead:
 *   - Rolling median stride=1 (recomputed every bar from strictly past 720 ATR values)
 *   - Entry uses h1Idx-1 for z-score and regime (last completed bar)
 *   - Fill at open of current bar (h1[h1Idx].o)
 *   - z4 uses 4h bar strictly BEFORE current timestamp
 *
 * Also produces:
 *   - Per-month OOS breakdown
 *   - Concentration: % of profit from top 5 days
 *   - Slippage stress (1.5x, 2.5x, 4x)
 *
 * Output: .company/backtester/audit-atr.txt
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

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  atr14: number[]; atrMed30: number[];
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

/**
 * HARDENED rolling median. For each index i, uses STRICTLY values[i-window..i-1]
 * (inclusive of i-window, exclusive of i). Recomputed every bar (stride=1).
 * At index i, the sim will then read out[i-1], so effectively only bars <= i-2
 * can influence the decision at bar i — even more conservative than needed.
 */
function computeRollingMedianStrict(values: number[], window: number): number[] {
  const out = new Array(values.length).fill(0);
  if (values.length < window + 2) return out;
  for (let i = window; i < values.length; i++) {
    const slice: number[] = [];
    for (let j = i - window; j < i; j++) {
      const v = values[j]!;
      if (v > 0) slice.push(v);
    }
    if (slice.length < window / 4) { out[i] = 0; continue; }
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)]!;
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
  // Use the 4h bar that CLOSED before ts (strictly past)
  if (i !== undefined && i > 0) return z4[i - 1]!;
  let lo = 0, hi = h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h4[m]!.t < t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? z4[best]! : 0;
}

// ============================================================================
// Simulator
// ============================================================================

type Engine = "garch" | "rex";

interface Cfg {
  label: string;
  runGarch: boolean;
  runRex: boolean;
  marginGarch: number;
  marginRex: number;
  slPct: number;
  slSlipMult: number;
  trailStages: Array<[number, number]>;
  zL1: number; zL4: number;
  garchMaxHoldH: number;
  rexMult: number;
  rexMaxHoldH: number;
  atrThrGarch: number;
  atrThrRex: number;
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  margin: number;
  maxHoldH: number;
}

interface Tr { engine: Engine; pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; entryTs: number; }

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  maxSingleLoss: number; numTrades: number;
  trades: Tr[];
}

function atrRegimePasses(p: PD, h1Idx: number, thr: number): boolean {
  // Use index i = h1Idx - 1: this is the bar that closed at timestamp ts.
  // atrMed30[i] is computed from atr14[i-720..i-1] — strictly before bar i.
  const i = h1Idx - 1;
  const a = p.ind.atr14[i] ?? 0, b = p.ind.atrMed30[i] ?? 0;
  if (a === 0 || b === 0) return false;
  return a / b >= thr;
}

interface SimCache {
  timepoints: number[];
  m5Maps: Map<string, Map<number, number>>;
  pairByName: Map<string, PD>;
}
const simCaches = new Map<string, SimCache>();
function getSimCache(pairs: PD[], startTs: number, endTs: number): SimCache {
  const key = `${startTs}-${endTs}-${pairs.length}`;
  let c = simCaches.get(key);
  if (c) return c;
  const all5mTimes = new Set<number>();
  for (const p of pairs) for (const b of p.ind.m5) if (b.t >= startTs && b.t < endTs) all5mTimes.add(b.t);
  const timepoints = [...all5mTimes].sort((a, b) => a - b);
  const m5Maps = new Map<string, Map<number, number>>();
  const pairByName = new Map<string, PD>();
  for (const p of pairs) {
    const m = new Map<number, number>();
    p.ind.m5.forEach((cc, i) => m.set(cc.t, i));
    m5Maps.set(p.name, m);
    pairByName.set(p.name, p);
  }
  c = { timepoints, m5Maps, pairByName };
  simCaches.set(key, c);
  return c;
}

function simulate(pairs: PD[], cfg: Cfg, startTs: number, endTs: number, days: number): Res {
  const closed: Tr[] = [];
  const openPositions: OpenPos[] = [];
  const { timepoints, m5Maps, pairByName } = getSimCache(pairs, startTs, endTs);

  const notG = (lev: number) => cfg.marginGarch * lev;
  const notR = (lev: number) => cfg.marginRex * lev;

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
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        let actDist = -1;
        for (const [act, dist] of cfg.trailStages) {
          if (pos.pk >= act) actDist = dist;
        }
        if (actDist > 0 && cur <= pos.pk - actDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, entryTs: pos.et, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      if (cfg.runGarch && !openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.zL1 && z4 > cfg.zL4) {
          if (atrRegimePasses(p, h1Idx, cfg.atrThrGarch)) {
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            openPositions.push({
              engine: "garch", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notG(p.lev), margin: cfg.marginGarch,
              maxHoldH: cfg.garchMaxHoldH,
            });
          }
        }
      }

      if (cfg.runRex && !openPositions.some(o => o.pair === p.name && o.engine === "rex")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          if (atrRegimePasses(p, h1Idx, cfg.atrThrRex)) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "rex", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notR(p.lev), margin: cfg.marginRex,
              maxHoldH: cfg.rexMaxHoldH,
            });
          }
        }
      }
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: lb.t, entryTs: pos.et, pnl, reason: "end" });
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

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    trades: closed,
  };
}

// ============================================================================
// Analytics
// ============================================================================

function monthBucket(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function perMonth(trades: Tr[]): Array<{ month: string; pnl: number; n: number; }> {
  const m = new Map<string, { pnl: number; n: number; }>();
  for (const t of trades) {
    const k = monthBucket(t.exitTs);
    const cur = m.get(k) ?? { pnl: 0, n: 0 };
    cur.pnl += t.pnl;
    cur.n++;
    m.set(k, cur);
  }
  return [...m.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month));
}

function concentration(trades: Tr[]): { top1: number; top5: number; topPct5: number; totalDays: number; topDays: Array<{ day: string; pnl: number; }>; } {
  const daily = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.exitTs);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    daily.set(key, (daily.get(key) ?? 0) + t.pnl);
  }
  const arr = [...daily.entries()].map(([day, pnl]) => ({ day, pnl }));
  const total = arr.reduce((s, v) => s + v.pnl, 0);
  arr.sort((a, b) => b.pnl - a.pnl);
  const top1 = arr.length > 0 ? arr[0]!.pnl : 0;
  const top5 = arr.slice(0, 5).reduce((s, v) => s + v.pnl, 0);
  const topPct5 = total !== 0 ? (top5 / total) * 100 : 0;
  return { top1, top5, topPct5, totalDays: arr.length, topDays: arr.slice(0, 5) };
}

// ============================================================================
// Main
// ============================================================================

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const LINES: string[] = [];
function log(s = ""): void { console.log(s); LINES.push(s); }

function reportR(tag: string, r: Res): void {
  log(`  ${tag}: $/day ${fmtD(r.dollarsPerDay)}  total ${fmtD(r.totalPnl)}  MDD $${r.maxDD.toFixed(2)}  PF ${r.pf.toFixed(2)}  WR ${r.wr.toFixed(1)}%  N=${r.numTrades}  maxL ${fmtD(r.maxSingleLoss)}`);
}

function baseCfg(): Cfg {
  return {
    label: "",
    runGarch: false, runRex: false,
    marginGarch: 30, marginRex: 15,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
    zL1: 2.0, zL4: 1.5,
    garchMaxHoldH: 72,
    rexMult: 2.0,
    rexMaxHoldH: 12,
    atrThrGarch: 1.8,
    atrThrRex: 1.6,
  };
}

function main() {
  log("=".repeat(140));
  log("  AUDIT — GARCH ATR regime claim verification");
  log("  Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03-25");
  log("  Anti-lookahead: rolling median stride=1, strictly past window [i-720, i-1]");
  log("=".repeat(140));

  log("\nLoading pairs with STRICT rolling median (stride=1, no caching)...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 900 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const atr14 = computeATR(h1, 14);
    const atrMed30 = computeRollingMedianStrict(atr14, 720);
    const rexSig20 = computeRangeExpansion(h1, atr14, 2.0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, atr14, atrMed30, rexSig20 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  // --------------------------------------------------------------------------
  // Section 1 — Replicate GARCH standalone ATR 1.6 m$30 (reference anchor)
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 1 — Replicate GARCH-only ATR 1.6 m$30 (anchor: prior claim $3.15/day MDD $10.84)");
  log("=".repeat(140));
  {
    const cfg: Cfg = { ...baseCfg(), label: "GARCH-ATR1.6-m30", runGarch: true, atrThrGarch: 1.6, marginGarch: 30 };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(`\n  [${cfg.label}]`);
    reportR("IS ", is);
    reportR("OOS", oos);
    log(`  Prior claim OOS: +$3.15/day MDD $10.84`);
    const dpdDelta = oos.dollarsPerDay - 3.15;
    const mddDelta = oos.maxDD - 10.84;
    log(`  Delta: ${fmtD(dpdDelta)}/day  MDD delta ${fmtD(mddDelta)}`);
    if (Math.abs(dpdDelta) < 0.10 && Math.abs(mddDelta) < 0.50) log("  -> REPLICATION MATCH");
    else log("  -> REPLICATION MISMATCH (see drift above)");
  }

  // --------------------------------------------------------------------------
  // Section 2 — GARCH standalone ATR 1.8 m$30 and m$60 (core claim under audit)
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 2 — GARCH-only ATR 1.8 at m$30 and m$60 (AUDITED claim)");
  log("  Prior claim: m$30 +$2.71/day MDD $6.27; m$60 +$5.42/day MDD $12.54");
  log("=".repeat(140));

  const garchConfigs: Array<{ thr: number; margin: number; }> = [
    { thr: 1.8, margin: 30 },
    { thr: 1.8, margin: 60 },
  ];
  for (const gc of garchConfigs) {
    const cfg: Cfg = { ...baseCfg(), label: `GARCH-ATR${gc.thr}-m${gc.margin}`, runGarch: true, atrThrGarch: gc.thr, marginGarch: gc.margin };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);

    log(`\n  [${cfg.label}]`);
    reportR("IS ", is);
    reportR("OOS", oos);

    // Concentration
    const conc = concentration(oos.trades);
    log(`  OOS concentration: top1 day ${fmtD(conc.top1)}, top5 ${fmtD(conc.top5)} (${conc.topPct5.toFixed(1)}% of total across ${conc.totalDays} trading days)`);
    log("  Top 5 days:");
    for (const d of conc.topDays) log(`    ${d.day}: ${fmtD(d.pnl)}`);

    // Per month
    const mnt = perMonth(oos.trades);
    log("  Per-month OOS:");
    for (const m of mnt) log(`    ${m.month}: ${fmtD(m.pnl).padStart(8)}  N=${m.n}`);
  }

  // --------------------------------------------------------------------------
  // Section 3 — Portfolio A$60 GARCH + B$15 REX, ATR 1.8/1.6 (headline claim)
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 3 — Portfolio A$60 GARCH + B$15 REX (ATR 1.8/1.6) — HEADLINE CLAIM");
  log("  Prior claim: +$7.29/day MDD $13.20 PF 2.86");
  log("=".repeat(140));
  {
    const cfg: Cfg = {
      ...baseCfg(),
      label: "A60-B15-ATR1.8-1.6",
      runGarch: true, runRex: true,
      marginGarch: 60, marginRex: 15,
      atrThrGarch: 1.8, atrThrRex: 1.6,
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(`\n  [${cfg.label}]`);
    reportR("IS ", is);
    reportR("OOS", oos);
    const conc = concentration(oos.trades);
    log(`  OOS concentration: top1 ${fmtD(conc.top1)}, top5 ${fmtD(conc.top5)} (${conc.topPct5.toFixed(1)}% of total / ${conc.totalDays} days)`);
    log("  Top 5 days:");
    for (const d of conc.topDays) log(`    ${d.day}: ${fmtD(d.pnl)}`);

    const mnt = perMonth(oos.trades);
    log("  Per-month OOS:");
    for (const m of mnt) log(`    ${m.month}: ${fmtD(m.pnl).padStart(8)}  N=${m.n}`);
  }

  // --------------------------------------------------------------------------
  // Section 4 — SLIP STRESS on winning config
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 4 — Slippage stress on A$60+B$15 ATR1.8/1.6 and GARCH-only m$60 ATR1.8");
  log("=".repeat(140));
  for (const mult of [1.5, 2.5, 4.0]) {
    log(`\n  slipMult = ${mult.toFixed(1)}x`);
    // Portfolio
    {
      const cfg: Cfg = {
        ...baseCfg(),
        label: `A60-B15-slip${mult}`,
        runGarch: true, runRex: true,
        marginGarch: 60, marginRex: 15,
        atrThrGarch: 1.8, atrThrRex: 1.6,
        slSlipMult: mult,
      };
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      log(`    portfolio A60+B15: $/day ${fmtD(oos.dollarsPerDay)}  MDD $${oos.maxDD.toFixed(2)}  PF ${oos.pf.toFixed(2)}  N=${oos.numTrades}`);
    }
    // GARCH standalone
    {
      const cfg: Cfg = {
        ...baseCfg(),
        label: `GARCH-m60-slip${mult}`,
        runGarch: true,
        marginGarch: 60,
        atrThrGarch: 1.8,
        slSlipMult: mult,
      };
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      log(`    GARCH-only  m$60: $/day ${fmtD(oos.dollarsPerDay)}  MDD $${oos.maxDD.toFixed(2)}  PF ${oos.pf.toFixed(2)}  N=${oos.numTrades}`);
    }
  }

  // --------------------------------------------------------------------------
  // Section 5 — Margin linearity sanity check (m$15, m$30, m$60 for GARCH ATR 1.8)
  // --------------------------------------------------------------------------
  log("\n" + "=".repeat(140));
  log("  SECTION 5 — Margin linearity (trade count must be identical across margins)");
  log("=".repeat(140));
  for (const m of [15, 30, 45, 60]) {
    const cfg: Cfg = { ...baseCfg(), label: `GARCH-ATR1.8-m${m}`, runGarch: true, atrThrGarch: 1.8, marginGarch: m };
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    log(`  m$${m}: $/day ${fmtD(oos.dollarsPerDay).padStart(8)}  MDD $${oos.maxDD.toFixed(2).padStart(6)}  PF ${oos.pf.toFixed(2)}  N=${oos.numTrades}`);
  }

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "audit-atr.txt"), LINES.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "audit-atr.txt")}`);
}

main();
