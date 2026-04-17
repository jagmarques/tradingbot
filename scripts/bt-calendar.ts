/**
 * CALENDAR EFFECTS TEST — DOW and Hour filters on deployed 2-engine portfolio
 *
 * DEPLOYED BASELINE (OOS ~$4.58/day, MDD $7.64, PF 2.95):
 *   A: GARCH long-only, z1h>2.0 & z4h>1.5, ATR1.8 regime, m$30, SL 0.15%, trail [3,1][9,0.5][20,0.5]
 *   B: Range Expansion (2.0*ATR), ATR1.6 regime, m$15, same SL/trail, max hold 12h
 *   block h22-23 already applied
 *
 * GOAL: test whether filtering trades by DAY-OF-WEEK and HOUR-OF-DAY (UTC) at ENTRY
 *       time improves OOS $/day without degrading MDD. Differ from prior hour test
 *       which was pair-specific: this is portfolio-wide DOW/hour buckets.
 *
 * RIGOR:
 *   - Bonferroni: 7 DOWs -> p<0.007, 24 hours -> p<0.002
 *   - Filters chosen on IS, validated on OOS
 *   - Cross-validation: pairs split into 2 halves, find bad hours on half A, test on half B
 *
 * TESTS:
 *   1. Raw DOW PnL distribution
 *   2. Raw hour PnL distribution
 *   3. Filter out IS-worst DOW, test OOS
 *   4. Filter out IS-worst 3 hours, test OOS
 *   5. Month-start vs month-end (first 5 days vs last 5 days)
 *   6. Pair-half CV on worst hours
 *
 * KILL THRESHOLD: any filter must improve OOS $/day AND not degrade MDD.
 *
 * Output: .company/backtester/calendar.txt
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

type Engine = "A" | "B";

interface Cfg {
  label: string;
  marginA: number;
  marginB: number;
  slPct: number;
  slSlipMult: number;
  trailStages: Array<[number, number]>;
  zL1: number; zL4: number;
  aMaxHoldH: number;
  rexMult: number;
  bMaxHoldH: number;
  atrThrA: number;
  atrThrB: number;
  // calendar filters (applied at ENTRY time on 1h bar hour + day-of-week)
  blockDow?: Set<number>;   // 0=Sun..6=Sat
  blockHour?: Set<number>;  // extra hour blocks on top of 22-23
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
}

interface Tr {
  engine: Engine; pair: string; dir: "long" | "short";
  pnl: number; reason: string;
  entryTs: number; exitTs: number;
  entryHour: number; entryDow: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  maxSingleLoss: number; numTrades: number;
  trades: Tr[];
}

function atrRegimePasses(p: PD, h1Idx: number, thr: number): boolean {
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
  const key = `${startTs}-${endTs}-${pairs.map(p => p.name).join(",")}`;
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

  const notA = (lev: number) => cfg.marginA * lev;
  const notB = (lev: number) => cfg.marginB * lev;

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const d = new Date(ts);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();

    // Exits (5m)
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
        const ed = new Date(pos.et);
        closed.push({
          engine: pos.engine, pair: pos.pair, dir: pos.dir,
          pnl, reason, entryTs: pos.et, exitTs: ts,
          entryHour: ed.getUTCHours(), entryDow: ed.getUTCDay(),
        });
        openPositions.splice(i, 1);
      }
    }

    // Entries — 1h bar, block default 22-23 + calendar filters
    if (isH1 && !BLOCK.has(hour)) {
      if (cfg.blockHour && cfg.blockHour.has(hour)) continue;
      if (cfg.blockDow && cfg.blockDow.has(dow)) continue;
      for (const p of pairs) {
        const h1Idx = p.ind.h1Map.get(ts);
        if (h1Idx === undefined || h1Idx < 170) continue;

        if (cfg.marginA > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "A")) {
          const z1 = p.ind.z1[h1Idx - 1]!;
          const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
          if (z1 > cfg.zL1 && z4 > cfg.zL4 && atrRegimePasses(p, h1Idx, cfg.atrThrA)) {
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            openPositions.push({
              engine: "A", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notA(p.lev), maxHoldH: cfg.aMaxHoldH,
            });
          }
        }

        if (cfg.marginB > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "B")) {
          const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
          if (sig !== 0 && atrRegimePasses(p, h1Idx, cfg.atrThrB)) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "B", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notB(p.lev), maxHoldH: cfg.bMaxHoldH,
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
    const ed = new Date(pos.et);
    closed.push({
      engine: pos.engine, pair: pos.pair, dir: pos.dir,
      pnl, reason: "end", entryTs: pos.et, exitTs: lb.t,
      entryHour: ed.getUTCHours(), entryDow: ed.getUTCDay(),
    });
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
// Statistics helpers
// ============================================================================

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length; }
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const v of xs) s += (v - m) * (v - m);
  return Math.sqrt(s / (xs.length - 1));
}

// t-statistic for H0: mean=0 vs population mean. Returns {t, p_two_sided}
function tTestZero(xs: number[]): { t: number; p: number; n: number; mean: number; sd: number } {
  const n = xs.length;
  if (n < 2) return { t: 0, p: 1, n, mean: 0, sd: 0 };
  const m = mean(xs);
  const sd = stdev(xs);
  if (sd === 0) return { t: 0, p: 1, n, mean: m, sd };
  const se = sd / Math.sqrt(n);
  const t = m / se;
  // Two-sided p using normal approximation (n usually >>30)
  const p = 2 * (1 - normCdf(Math.abs(t)));
  return { t, p, n, mean: m, sd };
}

// Abramowitz-Stegun normal CDF approximation
function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const xa = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + pp * xa);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-xa * xa);
  return 0.5 * (1 + sign * y);
}

// ============================================================================
// Main
// ============================================================================

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }
const LINES: string[] = [];
function log(s = ""): void { console.log(s); LINES.push(s); }

function baseCfg(): Cfg {
  return {
    label: "",
    marginA: 30, marginB: 15,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailStages: [[3, 1], [9, 0.5], [20, 0.5]],
    zL1: 2.0, zL4: 1.5,
    aMaxHoldH: 72,
    rexMult: 2.0,
    bMaxHoldH: 12,
    atrThrA: 1.8,
    atrThrB: 1.6,
  };
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface BucketStat {
  key: number;
  label: string;
  n: number;
  total: number;
  mean: number;
  sd: number;
  t: number;
  p: number;
  wr: number;
}

function bucketStats<T extends { pnl: number }>(trades: T[], keyOf: (t: T) => number, labelOf: (k: number) => string, nKeys: number): BucketStat[] {
  const groups: number[][] = [];
  for (let i = 0; i < nKeys; i++) groups.push([]);
  for (const tr of trades) {
    const k = keyOf(tr);
    if (k >= 0 && k < nKeys) groups[k]!.push(tr.pnl);
  }
  const out: BucketStat[] = [];
  for (let k = 0; k < nKeys; k++) {
    const arr = groups[k]!;
    const t = tTestZero(arr);
    const wins = arr.filter(v => v > 0).length;
    out.push({
      key: k,
      label: labelOf(k),
      n: arr.length,
      total: arr.reduce((s, v) => s + v, 0),
      mean: t.mean,
      sd: t.sd,
      t: t.t,
      p: t.p,
      wr: arr.length > 0 ? 100 * wins / arr.length : 0,
    });
  }
  return out;
}

function printBucketTable(title: string, stats: BucketStat[], pCrit: number): void {
  log(`\n  ${title}`);
  log(`  ${"Bucket".padEnd(6)} ${"N".padStart(6)} ${"Total".padStart(10)} ${"Mean".padStart(9)} ${"SD".padStart(8)} ${"WR%".padStart(6)} ${"t".padStart(8)} ${"p".padStart(10)} sig?`);
  log(`  ${"-".repeat(90)}`);
  for (const s of stats) {
    const sig = (s.p < pCrit && s.n >= 20) ? (s.mean < 0 ? "BAD*" : "GOOD*") : "";
    log(
      `  ${s.label.padEnd(6)} ` +
      `${String(s.n).padStart(6)} ` +
      `${fmtD(s.total).padStart(10)} ` +
      `${fmtD(s.mean).padStart(9)} ` +
      `${s.sd.toFixed(4).padStart(8)} ` +
      `${s.wr.toFixed(1).padStart(6)} ` +
      `${s.t.toFixed(2).padStart(8)} ` +
      `${s.p.toExponential(2).padStart(10)}  ${sig}`
    );
  }
}

function main(): void {
  log("=".repeat(140));
  log("  CALENDAR EFFECTS TEST — DOW & Hour filters on deployed 2-engine portfolio");
  log("  A: GARCH long-only, z1h>2.0 & z4h>1.5, ATR1.8, m$30");
  log("  B: Range Expansion 2.0*ATR, ATR1.6, m$15");
  log("  SL 0.15%, trail [3,1][9,0.5][20,0.5], block h22-23 default");
  log("  Walk-forward IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03-25");
  log("  Target baseline: OOS $/day +$4.58, MDD $7.64, PF 2.95");
  log("=".repeat(140));

  log("\nLoading pairs...");
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

  // ========================================================================
  // Step 1: Baseline
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 1 — Baseline walk-forward (unfiltered)");
  log("=".repeat(140));
  const cfgBase: Cfg = { ...baseCfg(), label: "baseline" };
  const isRes = simulate(pairs, cfgBase, IS_S, IS_E, IS_D);
  const oosRes = simulate(pairs, cfgBase, OOS_S, OOS_E, OOS_D);
  log(`  IS : $/day ${fmtD(isRes.dollarsPerDay)}  MDD $${isRes.maxDD.toFixed(2)}  PF ${isRes.pf.toFixed(2)}  WR ${isRes.wr.toFixed(1)}%  N=${isRes.numTrades}`);
  log(`  OOS: $/day ${fmtD(oosRes.dollarsPerDay)}  MDD $${oosRes.maxDD.toFixed(2)}  PF ${oosRes.pf.toFixed(2)}  WR ${oosRes.wr.toFixed(1)}%  N=${oosRes.numTrades}`);

  // ========================================================================
  // Step 2: Raw DOW distribution on IS
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 2 — IS raw DOW distribution (Bonferroni 7 buckets: sig p<0.00714)");
  log("=".repeat(140));
  const P_DOW = 0.05 / 7;
  const dowStatsIS = bucketStats(isRes.trades, t => t.entryDow, k => DOW_NAMES[k]!, 7);
  printBucketTable("IS DOW distribution (by entry day UTC):", dowStatsIS, P_DOW);

  log("\n  OOS DOW distribution (reference only):");
  const dowStatsOOS = bucketStats(oosRes.trades, t => t.entryDow, k => DOW_NAMES[k]!, 7);
  printBucketTable("OOS DOW distribution:", dowStatsOOS, P_DOW);

  // ========================================================================
  // Step 3: Raw hour distribution on IS
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 3 — IS raw hour distribution (Bonferroni 24 buckets: sig p<0.00208)");
  log("=".repeat(140));
  const P_HR = 0.05 / 24;
  const hrStatsIS = bucketStats(isRes.trades, t => t.entryHour, k => `h${k.toString().padStart(2, "0")}`, 24);
  printBucketTable("IS hour distribution (by entry hour UTC):", hrStatsIS, P_HR);

  log("\n  OOS hour distribution (reference only):");
  const hrStatsOOS = bucketStats(oosRes.trades, t => t.entryHour, k => `h${k.toString().padStart(2, "0")}`, 24);
  printBucketTable("OOS hour distribution:", hrStatsOOS, P_HR);

  // ========================================================================
  // Step 4: Significant bad buckets identification (on IS)
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 4 — Significant bad buckets on IS (Bonferroni)");
  log("=".repeat(140));
  const badDowSig = dowStatsIS.filter(s => s.p < P_DOW && s.mean < 0 && s.n >= 20);
  const badHrSig = hrStatsIS.filter(s => s.p < P_HR && s.mean < 0 && s.n >= 20);
  log(`  Bonferroni-significant bad DOW (p<${P_DOW.toFixed(4)}): ${badDowSig.length === 0 ? "NONE" : badDowSig.map(s => `${s.label}(mean=${fmtD(s.mean)}, p=${s.p.toExponential(2)})`).join(", ")}`);
  log(`  Bonferroni-significant bad hour (p<${P_HR.toFixed(4)}): ${badHrSig.length === 0 ? "NONE" : badHrSig.map(s => `${s.label}(mean=${fmtD(s.mean)}, p=${s.p.toExponential(2)})`).join(", ")}`);

  // IS-worst picks (ignoring significance — as per task)
  const worstDowIS = [...dowStatsIS].filter(s => s.n >= 20).sort((a, b) => a.mean - b.mean);
  const worstHrIS = [...hrStatsIS].filter(s => s.n >= 20).sort((a, b) => a.mean - b.mean);
  const worstDow = worstDowIS[0]!;
  const worstHr3 = worstHrIS.slice(0, 3);
  log(`\n  IS-worst DOW (by mean, ignoring sig): ${worstDow.label} (mean ${fmtD(worstDow.mean)}, total ${fmtD(worstDow.total)}, p=${worstDow.p.toExponential(2)})`);
  log(`  IS-worst 3 hours (by mean, ignoring sig):`);
  for (const h of worstHr3) log(`    ${h.label} (mean ${fmtD(h.mean)}, total ${fmtD(h.total)}, n=${h.n}, p=${h.p.toExponential(2)})`);

  // ========================================================================
  // Step 5: Filter OOS — block IS-worst DOW
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 5 — OOS with IS-worst DOW blocked");
  log("=".repeat(140));
  const cfgBlockDow: Cfg = { ...baseCfg(), label: "blockDow", blockDow: new Set([worstDow.key]) };
  const oosBlockDow = simulate(pairs, cfgBlockDow, OOS_S, OOS_E, OOS_D);
  log(`  Block DOW: ${worstDow.label}`);
  log(`  OOS: $/day ${fmtD(oosBlockDow.dollarsPerDay)} (d ${fmtD(oosBlockDow.dollarsPerDay - oosRes.dollarsPerDay)})  MDD $${oosBlockDow.maxDD.toFixed(2)} (d ${(oosBlockDow.maxDD - oosRes.maxDD >= 0 ? "+" : "") + "$" + (oosBlockDow.maxDD - oosRes.maxDD).toFixed(2)})  PF ${oosBlockDow.pf.toFixed(2)}  N=${oosBlockDow.numTrades}`);
  const dowImproves = oosBlockDow.dollarsPerDay > oosRes.dollarsPerDay && oosBlockDow.maxDD <= oosRes.maxDD;
  log(`  Passes kill threshold (improves $/day AND not degrade MDD)? ${dowImproves ? "YES" : "NO"}`);

  // ========================================================================
  // Step 6: Filter OOS — block IS-worst 3 hours
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 6 — OOS with IS-worst 3 hours blocked");
  log("=".repeat(140));
  const blockHrSet = new Set(worstHr3.map(h => h.key));
  const cfgBlockHr: Cfg = { ...baseCfg(), label: "blockHr3", blockHour: blockHrSet };
  const oosBlockHr = simulate(pairs, cfgBlockHr, OOS_S, OOS_E, OOS_D);
  log(`  Block hours: ${[...blockHrSet].sort((a, b) => a - b).map(h => "h" + h).join(", ")}`);
  log(`  OOS: $/day ${fmtD(oosBlockHr.dollarsPerDay)} (d ${fmtD(oosBlockHr.dollarsPerDay - oosRes.dollarsPerDay)})  MDD $${oosBlockHr.maxDD.toFixed(2)} (d ${(oosBlockHr.maxDD - oosRes.maxDD >= 0 ? "+" : "") + "$" + (oosBlockHr.maxDD - oosRes.maxDD).toFixed(2)})  PF ${oosBlockHr.pf.toFixed(2)}  N=${oosBlockHr.numTrades}`);
  const hrImproves = oosBlockHr.dollarsPerDay > oosRes.dollarsPerDay && oosBlockHr.maxDD <= oosRes.maxDD;
  log(`  Passes kill threshold? ${hrImproves ? "YES" : "NO"}`);

  // Also test: combined DOW+hour filter
  log("\n  Combined (block worst DOW + worst 3 hours):");
  const cfgCombined: Cfg = { ...baseCfg(), label: "blockBoth", blockDow: new Set([worstDow.key]), blockHour: blockHrSet };
  const oosComb = simulate(pairs, cfgCombined, OOS_S, OOS_E, OOS_D);
  log(`  OOS: $/day ${fmtD(oosComb.dollarsPerDay)} (d ${fmtD(oosComb.dollarsPerDay - oosRes.dollarsPerDay)})  MDD $${oosComb.maxDD.toFixed(2)} (d ${(oosComb.maxDD - oosRes.maxDD >= 0 ? "+" : "") + "$" + (oosComb.maxDD - oosRes.maxDD).toFixed(2)})  PF ${oosComb.pf.toFixed(2)}  N=${oosComb.numTrades}`);
  const combImproves = oosComb.dollarsPerDay > oosRes.dollarsPerDay && oosComb.maxDD <= oosRes.maxDD;
  log(`  Passes kill threshold? ${combImproves ? "YES" : "NO"}`);

  // ========================================================================
  // Step 7: Month-start vs month-end split
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 7 — Month-start (1..5) vs month-end (last 5 days)");
  log("=".repeat(140));
  function dayOfMonth(ts: number): number { return new Date(ts).getUTCDate(); }
  function daysInMonth(ts: number): number {
    const d = new Date(ts);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  }
  const categorize = (trades: Tr[]): { start: number[]; end: number[]; mid: number[] } => {
    const start: number[] = [], end: number[] = [], mid: number[] = [];
    for (const t of trades) {
      const dom = dayOfMonth(t.entryTs);
      const dim = daysInMonth(t.entryTs);
      if (dom <= 5) start.push(t.pnl);
      else if (dom > dim - 5) end.push(t.pnl);
      else mid.push(t.pnl);
    }
    return { start, end, mid };
  };
  const isBuckets = categorize(isRes.trades);
  const oosBuckets = categorize(oosRes.trades);
  function showBuck(label: string, bk: { start: number[]; end: number[]; mid: number[] }) {
    for (const [name, arr] of [["month-start(1-5)", bk.start], ["month-end(last 5)", bk.end], ["mid", bk.mid]] as const) {
      const t = tTestZero(arr);
      log(`    ${label} ${name.padEnd(18)} n=${String(arr.length).padStart(5)} total ${fmtD(arr.reduce((s, v) => s + v, 0)).padStart(9)} mean ${fmtD(t.mean).padStart(8)} t=${t.t.toFixed(2).padStart(6)} p=${t.p.toExponential(2)}`);
    }
  }
  log("  IS:");
  showBuck("IS ", isBuckets);
  log("  OOS:");
  showBuck("OOS", oosBuckets);

  // ========================================================================
  // Step 8: Cross-validation — split pairs in halves, find bad hours on half A, test on half B
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  STEP 8 — Pair-split CV: find IS-worst hours on half A, test on half B");
  log("=".repeat(140));

  // Split pairs deterministically by index parity (both halves representative)
  const halfA = pairs.filter((_, i) => i % 2 === 0);
  const halfB = pairs.filter((_, i) => i % 2 === 1);
  log(`  halfA: ${halfA.length} pairs, halfB: ${halfB.length} pairs`);

  const cfgCV: Cfg = baseCfg();
  const isA = simulate(halfA, cfgCV, IS_S, IS_E, IS_D);
  const isB = simulate(halfB, cfgCV, IS_S, IS_E, IS_D);

  const hrA = bucketStats(isA.trades, t => t.entryHour, k => `h${k.toString().padStart(2, "0")}`, 24);
  const hrB = bucketStats(isB.trades, t => t.entryHour, k => `h${k.toString().padStart(2, "0")}`, 24);

  const worstHrA_raw = [...hrA].filter(s => s.n >= 10).sort((a, b) => a.mean - b.mean).slice(0, 3);
  const worstHrB_raw = [...hrB].filter(s => s.n >= 10).sort((a, b) => a.mean - b.mean).slice(0, 3);

  log(`  IS-worst 3 hours in halfA: ${worstHrA_raw.map(s => `${s.label}(mean ${fmtD(s.mean)})`).join(", ")}`);
  log(`  IS-worst 3 hours in halfB: ${worstHrB_raw.map(s => `${s.label}(mean ${fmtD(s.mean)})`).join(", ")}`);

  const overlapAB = worstHrA_raw.map(s => s.key).filter(k => worstHrB_raw.some(s => s.key === k));
  log(`  Overlap: ${overlapAB.length === 0 ? "NONE" : overlapAB.map(k => `h${k}`).join(", ")}`);

  // Apply halfA's IS-worst hours to halfB's OOS (cross-validation)
  const cfgCV_A_on_B: Cfg = { ...baseCfg(), blockHour: new Set(worstHrA_raw.map(s => s.key)) };
  const oosB_base = simulate(halfB, baseCfg(), OOS_S, OOS_E, OOS_D);
  const oosB_filt = simulate(halfB, cfgCV_A_on_B, OOS_S, OOS_E, OOS_D);
  log(`\n  halfB OOS (apply halfA's IS-worst-hour filter):`);
  log(`    baseline: $/day ${fmtD(oosB_base.dollarsPerDay)}  MDD $${oosB_base.maxDD.toFixed(2)}  PF ${oosB_base.pf.toFixed(2)}  N=${oosB_base.numTrades}`);
  log(`    filtered: $/day ${fmtD(oosB_filt.dollarsPerDay)}  MDD $${oosB_filt.maxDD.toFixed(2)}  PF ${oosB_filt.pf.toFixed(2)}  N=${oosB_filt.numTrades}`);
  log(`    delta:    $/day ${fmtD(oosB_filt.dollarsPerDay - oosB_base.dollarsPerDay)}, MDD ${(oosB_filt.maxDD - oosB_base.maxDD >= 0 ? "+" : "") + "$" + (oosB_filt.maxDD - oosB_base.maxDD).toFixed(2)}`);
  const cvAonB = oosB_filt.dollarsPerDay > oosB_base.dollarsPerDay && oosB_filt.maxDD <= oosB_base.maxDD;
  log(`    CV pass (A-filter helps B)? ${cvAonB ? "YES" : "NO"}`);

  // And reverse: B's worst hours on A's OOS
  const cfgCV_B_on_A: Cfg = { ...baseCfg(), blockHour: new Set(worstHrB_raw.map(s => s.key)) };
  const oosA_base = simulate(halfA, baseCfg(), OOS_S, OOS_E, OOS_D);
  const oosA_filt = simulate(halfA, cfgCV_B_on_A, OOS_S, OOS_E, OOS_D);
  log(`\n  halfA OOS (apply halfB's IS-worst-hour filter):`);
  log(`    baseline: $/day ${fmtD(oosA_base.dollarsPerDay)}  MDD $${oosA_base.maxDD.toFixed(2)}  PF ${oosA_base.pf.toFixed(2)}  N=${oosA_base.numTrades}`);
  log(`    filtered: $/day ${fmtD(oosA_filt.dollarsPerDay)}  MDD $${oosA_filt.maxDD.toFixed(2)}  PF ${oosA_filt.pf.toFixed(2)}  N=${oosA_filt.numTrades}`);
  log(`    delta:    $/day ${fmtD(oosA_filt.dollarsPerDay - oosA_base.dollarsPerDay)}, MDD ${(oosA_filt.maxDD - oosA_base.maxDD >= 0 ? "+" : "") + "$" + (oosA_filt.maxDD - oosA_base.maxDD).toFixed(2)}`);
  const cvBonA = oosA_filt.dollarsPerDay > oosA_base.dollarsPerDay && oosA_filt.maxDD <= oosA_base.maxDD;
  log(`    CV pass (B-filter helps A)? ${cvBonA ? "YES" : "NO"}`);

  // ========================================================================
  // Verdict
  // ========================================================================
  log("\n" + "=".repeat(140));
  log("  VERDICT");
  log("=".repeat(140));
  log(`  Baseline OOS:             $/day ${fmtD(oosRes.dollarsPerDay)}, MDD $${oosRes.maxDD.toFixed(2)}, PF ${oosRes.pf.toFixed(2)}, N=${oosRes.numTrades}`);
  log(`  Block worst DOW:          $/day ${fmtD(oosBlockDow.dollarsPerDay)}, MDD $${oosBlockDow.maxDD.toFixed(2)}, PF ${oosBlockDow.pf.toFixed(2)}   pass=${dowImproves}`);
  log(`  Block worst 3 hours:      $/day ${fmtD(oosBlockHr.dollarsPerDay)}, MDD $${oosBlockHr.maxDD.toFixed(2)}, PF ${oosBlockHr.pf.toFixed(2)}   pass=${hrImproves}`);
  log(`  Block both:               $/day ${fmtD(oosComb.dollarsPerDay)}, MDD $${oosComb.maxDD.toFixed(2)}, PF ${oosComb.pf.toFixed(2)}   pass=${combImproves}`);
  log(`  CV halfA->halfB:          pass=${cvAonB}`);
  log(`  CV halfB->halfA:          pass=${cvBonA}`);

  const anyBonferroni = badDowSig.length + badHrSig.length > 0;
  log("");
  log(`  Bonferroni-significant bad buckets on IS: ${anyBonferroni ? "YES — " + [...badDowSig, ...badHrSig].map(s => s.label).join(", ") : "NONE"}`);
  const anyPass = dowImproves || hrImproves || combImproves;
  log(`  Any filter passed kill threshold on OOS?  ${anyPass ? "YES" : "NO"}`);

  log("");
  if (anyBonferroni && anyPass && cvAonB && cvBonA) {
    log("  DEPLOY: statistically significant bad buckets on IS, filter improves OOS, CV holds.");
  } else if (!anyBonferroni && !anyPass) {
    log("  LEAVE ALONE: no statistically significant bad buckets, and no filter improves OOS.");
    log("  The raw distributions are consistent with noise; any hour/DOW block would overfit.");
  } else if (anyPass && !(cvAonB && cvBonA)) {
    log("  LEAVE ALONE: a filter improves OOS on the full set but fails pair-split CV — overfit.");
  } else {
    log("  MIXED: partial signal — safer to LEAVE ALONE unless all three rigor gates align.");
  }

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "calendar.txt"), LINES.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "calendar.txt")}`);
}

main();
