/**
 * SIGNAL QUALITY GRADING
 *
 * Bucket entries by signal strength and find the "sweet spot" zone that dominates.
 *
 * Engine A — GARCH (deployed):
 *   longs:  z1h > 2.0 AND z4h > 1.5, ATR regime > 1.8
 *   Buckets by z1h:
 *     B1: 2.0 < z1h <= 3.0  (marginal)
 *     B2: 3.0 < z1h <= 4.0
 *     B3: 4.0 < z1h <= 5.0
 *     B4: 5.0 < z1h <= 6.0
 *     B5: z1h > 6.0
 *
 * Engine B — REX (range expansion):
 *   1h range / ATR14 >= 1.6 (deployed), close extreme
 *   Buckets:
 *     range/ATR: 1.6-2.0, 2.0-2.5, 2.5-3.0, 3.0-4.0, 4.0+
 *     close position (dist from bar extreme as fraction of range):
 *       0-0.15 (extreme), 0.15-0.25 (edge), 0.25+ (deep)
 *
 * Each trade is sim'd with identical exit logic (SL 0.15%, trail 9/0.5, max hold 72h A / 12h B).
 * Walk-forward IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03.
 *
 * Then: best-bucket portfolio with scaled margin (if only 30% survive, size up 3x).
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

// ATR regime thresholds (matches deployed)
const GARCH_ATR_REGIME = 1.8;
const REX_ATR_REGIME = 1.6;
const REX_MULT = 1.6;

// Exit params — identical across buckets
const SL_PCT = 0.0015;
const TRAIL_ACT = 9;
const TRAIL_DIST = 0.5;
const GARCH_MAXHOLD_H = 72;
const REX_MAXHOLD_H = 12;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  atr1h: number[];
  rv24: number[]; rv168: number[];
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

// ATR regime (1h) — current ATR / avg ATR over longer window
function computeATRRegime(atr: number[], longWin = 168): number[] {
  const out = new Array(atr.length).fill(0);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < atr.length; i++) {
    if (atr[i]! > 0) { sum += atr[i]!; count++; }
    if (count > longWin) { sum -= atr[i - longWin]!; count--; }
    if (count >= longWin && atr[i]! > 0) {
      const avg = sum / count;
      if (avg > 0) out[i] = atr[i]! / avg;
    }
  }
  return out;
}

interface Trade {
  engine: "A" | "B";
  pair: string;
  dir: "long" | "short";
  entryTs: number;
  exitTs: number;
  pnl: number;
  // quality features
  z1: number;
  z4: number;
  atrRegime: number;
  rangeAtr: number;  // REX
  closePos: number;  // REX: 0 = at extreme (high for long, low for short), 1 = far from extreme
  reason: string;
}

interface SimResult {
  trades: Trade[];
}

function simulate(
  pairs: PD[],
  engine: "A" | "B",
  startTs: number,
  endTs: number,
  margin: number,
): SimResult {
  const closed: Trade[] = [];
  interface Pos {
    pair: string; dir: "long" | "short"; ep: number; et: number; sl: number;
    pk: number; sp: number; lev: number; not: number; maxHoldH: number;
    // recorded features at entry
    z1: number; z4: number; atrRegime: number; rangeAtr: number; closePos: number;
  }
  const openPositions: Pos[] = [];

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

  // ATR regime is long-run so precompute per pair
  const atrRegMap = new Map<string, number[]>();
  for (const p of pairs) atrRegMap.set(p.name, computeATRRegime(p.ind.atr1h, 168));

  const notional = (lev: number) => margin * lev;

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
        if (pos.pk >= TRAIL_ACT && cur <= pos.pk - TRAIL_DIST) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({
          engine, pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: ts, pnl, reason,
          z1: pos.z1, z4: pos.z4, atrRegime: pos.atrRegime, rangeAtr: pos.rangeAtr, closePos: pos.closePos,
        });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const atrReg = atrRegMap.get(p.name)![h1Idx - 1] ?? 0;

      if (engine === "A") {
        // GARCH long-only
        const z1 = p.ind.z1[h1Idx - 1] ?? 0;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > 2.0 && z4 > 1.5 && atrReg >= GARCH_ATR_REGIME) {
          const dir: "long" = "long";
          const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
          const sl = ep * (1 - SL_PCT);
          openPositions.push({
            pair: p.name, dir, ep, et: ts, sl, pk: 0,
            sp: p.sp, lev: p.lev, not: notional(p.lev), maxHoldH: GARCH_MAXHOLD_H,
            z1, z4, atrRegime: atrReg, rangeAtr: 0, closePos: 0,
          });
        }
      } else {
        // REX — check prior 1h bar for range expansion
        const prev = p.ind.h1[h1Idx - 1]!;
        const a = p.ind.atr1h[h1Idx - 1] ?? 0;
        if (a <= 0) continue;
        const range = prev.h - prev.l;
        if (range <= 0) continue;
        const rAtr = range / a;
        if (rAtr < REX_MULT) continue;
        if (atrReg < REX_ATR_REGIME) continue;
        const upper75 = prev.l + range * 0.75;
        const lower25 = prev.l + range * 0.25;
        let dir: "long" | "short" | null = null;
        let closePos = 0;
        if (prev.c >= upper75) {
          dir = "long";
          // closePos = distance from high as fraction of range (0 = at high)
          closePos = (prev.h - prev.c) / range;
        } else if (prev.c <= lower25) {
          dir = "short";
          closePos = (prev.c - prev.l) / range;
        }
        if (!dir) continue;
        const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
        const sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
        openPositions.push({
          pair: p.name, dir, ep, et: ts, sl, pk: 0,
          sp: p.sp, lev: p.lev, not: notional(p.lev), maxHoldH: REX_MAXHOLD_H,
          z1: 0, z4: 0, atrRegime: atrReg, rangeAtr: rAtr, closePos,
        });
      }
    }
  }

  // Close still-open at end
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    if (lb.t < startTs || lb.t >= endTs) continue;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    closed.push({
      engine, pair: pos.pair, dir: pos.dir, entryTs: pos.et, exitTs: lb.t, pnl, reason: "end",
      z1: pos.z1, z4: pos.z4, atrRegime: pos.atrRegime, rangeAtr: pos.rangeAtr, closePos: pos.closePos,
    });
  }

  return { trades: closed };
}

interface BucketStats {
  label: string;
  n: number;
  pnl: number;
  perDay: number;
  mdd: number;
  pf: number;
  wr: number;
}

function statsFrom(trades: Trade[], days: number, label: string): BucketStats {
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  const pnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const wr = sorted.length > 0 ? wins.length / sorted.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : (gp > 0 ? Infinity : 0);
  let cum = 0, peak = 0, mdd = 0;
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum; }
  return { label, n: sorted.length, pnl, perDay: pnl / days, mdd, pf, wr };
}

function fmtD(v: number): string {
  if (!isFinite(v)) return "+$Inf";
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function main() {
  log("=".repeat(130));
  log("  SIGNAL QUALITY GRADING — bucketing entries by signal strength");
  log("  GARCH: z1h>2.0, z4h>1.5, ATR regime>=1.8");
  log("  REX:   range/ATR>=1.6, extreme 25%, ATR regime>=1.6");
  log("  Exits: SL 0.15%, trail 9/0.5, max hold 72h (GARCH) / 12h (REX)");
  log("  Walk-forward IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03");
  log("=".repeat(130));

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
    const atr1h = computeATR(h1, 14);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, atr1h, rv24, rv168 },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  const MARGIN = 5; // base margin per trade

  log("\nRunning GARCH (A) simulation — IS...");
  const aIS = simulate(pairs, "A", IS_S, IS_E, MARGIN);
  log(`  ${aIS.trades.length} GARCH trades IS`);
  log("Running GARCH (A) simulation — OOS...");
  const aOOS = simulate(pairs, "A", OOS_S, OOS_E, MARGIN);
  log(`  ${aOOS.trades.length} GARCH trades OOS`);

  log("Running REX (B) simulation — IS...");
  const bIS = simulate(pairs, "B", IS_S, IS_E, MARGIN);
  log(`  ${bIS.trades.length} REX trades IS`);
  log("Running REX (B) simulation — OOS...");
  const bOOS = simulate(pairs, "B", OOS_S, OOS_E, MARGIN);
  log(`  ${bOOS.trades.length} REX trades OOS`);

  // ---------- GARCH z1h buckets ----------
  log("\n" + "=".repeat(130));
  log("  GARCH (A) — z1h BUCKETS");
  log("=".repeat(130));

  const garchBuckets: Array<{ label: string; lo: number; hi: number }> = [
    { label: "B1 2.0<z<=3.0 (marginal)", lo: 2.0, hi: 3.0 },
    { label: "B2 3.0<z<=4.0",             lo: 3.0, hi: 4.0 },
    { label: "B3 4.0<z<=5.0",             lo: 4.0, hi: 5.0 },
    { label: "B4 5.0<z<=6.0",             lo: 5.0, hi: 6.0 },
    { label: "B5 z>6.0",                   lo: 6.0, hi: Infinity },
  ];

  function filterByZ(trades: Trade[], lo: number, hi: number): Trade[] {
    return trades.filter(t => t.z1 > lo && t.z1 <= hi);
  }

  const hdr = `${"Bucket".padEnd(28)} ${"N".padStart(5)} ${"$/day".padStart(10)} ${"Total".padStart(10)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)}`;
  log("\n  --- IS (Jun-Dec 2025) ---");
  log(hdr);
  log("-".repeat(130));
  for (const b of garchBuckets) {
    const bt = filterByZ(aIS.trades, b.lo, b.hi);
    const s = statsFrom(bt, IS_D, b.label);
    log(
      `${b.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }
  log("\n  --- OOS (Dec 2025 - Mar 2026) ---");
  log(hdr);
  log("-".repeat(130));
  const garchOOSStats: BucketStats[] = [];
  for (const b of garchBuckets) {
    const bt = filterByZ(aOOS.trades, b.lo, b.hi);
    const s = statsFrom(bt, OOS_D, b.label);
    garchOOSStats.push(s);
    log(
      `${b.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }

  // ---------- REX range/ATR buckets ----------
  log("\n" + "=".repeat(130));
  log("  REX (B) — range/ATR BUCKETS");
  log("=".repeat(130));

  const rexRBuckets: Array<{ label: string; lo: number; hi: number }> = [
    { label: "R1 1.6<=r<2.0 (baseline)",  lo: 1.6, hi: 2.0 },
    { label: "R2 2.0<=r<2.5",              lo: 2.0, hi: 2.5 },
    { label: "R3 2.5<=r<3.0",              lo: 2.5, hi: 3.0 },
    { label: "R4 3.0<=r<4.0",              lo: 3.0, hi: 4.0 },
    { label: "R5 r>=4.0",                   lo: 4.0, hi: Infinity },
  ];

  function filterByR(trades: Trade[], lo: number, hi: number): Trade[] {
    return trades.filter(t => t.rangeAtr >= lo && t.rangeAtr < hi);
  }

  log("\n  --- IS ---");
  log(hdr);
  log("-".repeat(130));
  for (const b of rexRBuckets) {
    const bt = filterByR(bIS.trades, b.lo, b.hi);
    const s = statsFrom(bt, IS_D, b.label);
    log(
      `${b.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }
  log("\n  --- OOS ---");
  log(hdr);
  log("-".repeat(130));
  const rexROOSStats: BucketStats[] = [];
  for (const b of rexRBuckets) {
    const bt = filterByR(bOOS.trades, b.lo, b.hi);
    const s = statsFrom(bt, OOS_D, b.label);
    rexROOSStats.push(s);
    log(
      `${b.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }

  // ---------- REX close-position buckets ----------
  log("\n" + "=".repeat(130));
  log("  REX (B) — close position (distance from bar extreme / range)");
  log("=".repeat(130));

  const rexCBuckets: Array<{ label: string; lo: number; hi: number }> = [
    { label: "C1 0<=cp<0.15 (extreme)",  lo: 0.0, hi: 0.15 },
    { label: "C2 0.15<=cp<0.25 (edge)",   lo: 0.15, hi: 0.25 },
    { label: "C3 cp>=0.25 (deep)",        lo: 0.25, hi: Infinity },
  ];

  function filterByCP(trades: Trade[], lo: number, hi: number): Trade[] {
    return trades.filter(t => t.closePos >= lo && t.closePos < hi);
  }

  log("\n  --- IS ---");
  log(hdr);
  log("-".repeat(130));
  for (const b of rexCBuckets) {
    const bt = filterByCP(bIS.trades, b.lo, b.hi);
    const s = statsFrom(bt, IS_D, b.label);
    log(
      `${b.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }
  log("\n  --- OOS ---");
  log(hdr);
  log("-".repeat(130));
  const rexCOOSStats: BucketStats[] = [];
  for (const b of rexCBuckets) {
    const bt = filterByCP(bOOS.trades, b.lo, b.hi);
    const s = statsFrom(bt, OOS_D, b.label);
    rexCOOSStats.push(s);
    log(
      `${b.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }

  // ---------- Baselines ----------
  log("\n" + "=".repeat(130));
  log("  BASELINES — all trades (for reference)");
  log("=".repeat(130));

  const aBaseIS  = statsFrom(aIS.trades, IS_D, "GARCH all IS");
  const aBaseOOS = statsFrom(aOOS.trades, OOS_D, "GARCH all OOS");
  const bBaseIS  = statsFrom(bIS.trades, IS_D, "REX all IS");
  const bBaseOOS = statsFrom(bOOS.trades, OOS_D, "REX all OOS");
  log(hdr);
  log("-".repeat(130));
  for (const s of [aBaseIS, aBaseOOS, bBaseIS, bBaseOOS]) {
    log(
      `${s.label.padEnd(28)} ${String(s.n).padStart(5)} ${fmtD(s.perDay).padStart(10)} ` +
      `${fmtD(s.pnl).padStart(10)} ${("$" + s.mdd.toFixed(0)).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`
    );
  }

  // ---------- Pick best buckets (IS-driven, OOS-validated) ----------
  log("\n" + "=".repeat(130));
  log("  SWEET-SPOT SELECTION — pick best bucket per engine from IS, validate OOS");
  log("=".repeat(130));

  // Pick best GARCH bucket from IS where PF>1.3 and $/day>0
  function pickBest<T extends { n: number }>(
    isBucs: Array<{ label: string; lo: number; hi: number }>,
    filter: (trades: Trade[], lo: number, hi: number) => Trade[],
    isTrades: Trade[],
    oosTrades: Trade[],
    minN = 15,
  ): { label: string; lo: number; hi: number; isStats: BucketStats; oosStats: BucketStats } | null {
    let best: { label: string; lo: number; hi: number; isStats: BucketStats; oosStats: BucketStats } | null = null;
    for (const b of isBucs) {
      const itr = filter(isTrades, b.lo, b.hi);
      const is = statsFrom(itr, IS_D, b.label);
      if (is.n < minN) continue;
      if (is.pf < 1.1 || is.perDay <= 0) continue;
      const otr = filter(oosTrades, b.lo, b.hi);
      const oos = statsFrom(otr, OOS_D, b.label);
      if (!best || is.perDay > best.isStats.perDay) {
        best = { label: b.label, lo: b.lo, hi: b.hi, isStats: is, oosStats: oos };
      }
    }
    return best;
  }

  const bestG = pickBest(garchBuckets, filterByZ, aIS.trades, aOOS.trades);
  const bestR = pickBest(rexRBuckets, filterByR, bIS.trades, bOOS.trades);
  const bestC = pickBest(rexCBuckets, filterByCP, bIS.trades, bOOS.trades);

  log("\n  GARCH best (z1h): " + (bestG ? bestG.label : "none passed filter"));
  if (bestG) {
    log(`    IS:  N=${bestG.isStats.n}  $/day ${fmtD(bestG.isStats.perDay)}  MDD $${bestG.isStats.mdd.toFixed(0)}  PF ${bestG.isStats.pf.toFixed(2)}  WR ${bestG.isStats.wr.toFixed(1)}%`);
    log(`    OOS: N=${bestG.oosStats.n}  $/day ${fmtD(bestG.oosStats.perDay)}  MDD $${bestG.oosStats.mdd.toFixed(0)}  PF ${bestG.oosStats.pf.toFixed(2)}  WR ${bestG.oosStats.wr.toFixed(1)}%`);
  }
  log("\n  REX best range/ATR bucket: " + (bestR ? bestR.label : "none"));
  if (bestR) {
    log(`    IS:  N=${bestR.isStats.n}  $/day ${fmtD(bestR.isStats.perDay)}  MDD $${bestR.isStats.mdd.toFixed(0)}  PF ${bestR.isStats.pf.toFixed(2)}  WR ${bestR.isStats.wr.toFixed(1)}%`);
    log(`    OOS: N=${bestR.oosStats.n}  $/day ${fmtD(bestR.oosStats.perDay)}  MDD $${bestR.oosStats.mdd.toFixed(0)}  PF ${bestR.oosStats.pf.toFixed(2)}  WR ${bestR.oosStats.wr.toFixed(1)}%`);
  }
  log("\n  REX best close-pos bucket: " + (bestC ? bestC.label : "none"));
  if (bestC) {
    log(`    IS:  N=${bestC.isStats.n}  $/day ${fmtD(bestC.isStats.perDay)}  MDD $${bestC.isStats.mdd.toFixed(0)}  PF ${bestC.isStats.pf.toFixed(2)}  WR ${bestC.isStats.wr.toFixed(1)}%`);
    log(`    OOS: N=${bestC.oosStats.n}  $/day ${fmtD(bestC.oosStats.perDay)}  MDD $${bestC.oosStats.mdd.toFixed(0)}  PF ${bestC.oosStats.pf.toFixed(2)}  WR ${bestC.oosStats.wr.toFixed(1)}%`);
  }

  // ---------- Margin-scaled deploy config ----------
  log("\n" + "=".repeat(130));
  log("  MARGIN-SCALED DEPLOY — if fewer trades, size up each one");
  log("=".repeat(130));
  log("  Reasoning: baseline is $5 margin. If best bucket takes X% of trades, scale margin to");
  log("  maintain same aggregate notional exposure, then check if $/day beats baseline.");
  log("");

  const baseGarchN = aOOS.trades.length || 1;
  const baseRexN = bOOS.trades.length || 1;

  function scaleReport(
    baseOOS: BucketStats,
    bucketOOS: BucketStats,
    baseN: number,
    scaleCap = 6,
  ): { scale: number; scaledDay: number; scaledMDD: number; scaledMaxLoss: number } {
    const frac = bucketOOS.n / baseN;
    const rawScale = frac > 0 ? 1 / frac : 1;
    const scale = Math.min(rawScale, scaleCap);
    return {
      scale,
      scaledDay: bucketOOS.perDay * scale,
      scaledMDD: bucketOOS.mdd * scale,
      scaledMaxLoss: 0,
    };
  }

  if (bestG) {
    const sr = scaleReport(aBaseOOS, bestG.oosStats, baseGarchN);
    log(`  GARCH ${bestG.label}:`);
    log(`    Baseline (all trades, $5 margin): $/day ${fmtD(aBaseOOS.perDay)}  MDD $${aBaseOOS.mdd.toFixed(0)}  N=${aBaseOOS.n}`);
    log(`    Filtered OOS:                      $/day ${fmtD(bestG.oosStats.perDay)}  MDD $${bestG.oosStats.mdd.toFixed(0)}  N=${bestG.oosStats.n}`);
    log(`    Trade-count ratio: ${(bestG.oosStats.n / baseGarchN * 100).toFixed(1)}%, margin scale: ${sr.scale.toFixed(2)}x (capped 6x)`);
    log(`    Scaled (${sr.scale.toFixed(2)}x margin = $${(5 * sr.scale).toFixed(0)}/trade):`);
    log(`      Expected $/day ${fmtD(sr.scaledDay)}  Expected MDD $${sr.scaledMDD.toFixed(0)}`);
    const delta = sr.scaledDay - aBaseOOS.perDay;
    log(`      Delta vs baseline: ${fmtD(delta)}/day ${delta > 0 ? "BETTER" : "WORSE"}`);
  }
  if (bestR) {
    const sr = scaleReport(bBaseOOS, bestR.oosStats, baseRexN);
    log(`\n  REX ${bestR.label}:`);
    log(`    Baseline (all trades, $5 margin): $/day ${fmtD(bBaseOOS.perDay)}  MDD $${bBaseOOS.mdd.toFixed(0)}  N=${bBaseOOS.n}`);
    log(`    Filtered OOS:                      $/day ${fmtD(bestR.oosStats.perDay)}  MDD $${bestR.oosStats.mdd.toFixed(0)}  N=${bestR.oosStats.n}`);
    log(`    Trade-count ratio: ${(bestR.oosStats.n / baseRexN * 100).toFixed(1)}%, margin scale: ${sr.scale.toFixed(2)}x (capped 6x)`);
    log(`    Scaled (${sr.scale.toFixed(2)}x margin = $${(5 * sr.scale).toFixed(0)}/trade):`);
    log(`      Expected $/day ${fmtD(sr.scaledDay)}  Expected MDD $${sr.scaledMDD.toFixed(0)}`);
    const delta = sr.scaledDay - bBaseOOS.perDay;
    log(`      Delta vs baseline: ${fmtD(delta)}/day ${delta > 0 ? "BETTER" : "WORSE"}`);
  }

  // ---------- Combined portfolio ----------
  log("\n" + "=".repeat(130));
  log("  COMBINED QUALITY BUCKET PORTFOLIO — GARCH best + REX best, merged");
  log("=".repeat(130));

  if (bestG && bestR) {
    const mergedIS = [
      ...filterByZ(aIS.trades, bestG.lo, bestG.hi),
      ...filterByR(bIS.trades, bestR.lo, bestR.hi),
    ];
    const mergedOOS = [
      ...filterByZ(aOOS.trades, bestG.lo, bestG.hi),
      ...filterByR(bOOS.trades, bestR.lo, bestR.hi),
    ];
    const mIS = statsFrom(mergedIS, IS_D, "Merged IS");
    const mOOS = statsFrom(mergedOOS, OOS_D, "Merged OOS");
    log(`  IS:  N=${mIS.n}  $/day ${fmtD(mIS.perDay)}  MDD $${mIS.mdd.toFixed(0)}  PF ${mIS.pf.toFixed(2)}  WR ${mIS.wr.toFixed(1)}%`);
    log(`  OOS: N=${mOOS.n}  $/day ${fmtD(mOOS.perDay)}  MDD $${mOOS.mdd.toFixed(0)}  PF ${mOOS.pf.toFixed(2)}  WR ${mOOS.wr.toFixed(1)}%`);

    // Margin-scaled merged
    const baseMergedN = aOOS.trades.length + bOOS.trades.length;
    const frac = mOOS.n / (baseMergedN || 1);
    const scale = Math.min(frac > 0 ? 1 / frac : 1, 6);
    const baseBoth = statsFrom([...aOOS.trades, ...bOOS.trades], OOS_D, "Both baseline");
    log(`  Baseline (both engines all trades): $/day ${fmtD(baseBoth.perDay)}  MDD $${baseBoth.mdd.toFixed(0)}  N=${baseBoth.n}`);
    log(`  Trade-count ratio: ${(frac * 100).toFixed(1)}%  margin scale: ${scale.toFixed(2)}x`);
    log(`  Scaled OOS: $/day ${fmtD(mOOS.perDay * scale)}  MDD $${(mOOS.mdd * scale).toFixed(0)}`);
    const deltaM = mOOS.perDay * scale - baseBoth.perDay;
    log(`  Delta vs base combined: ${fmtD(deltaM)}/day ${deltaM > 0 ? "BETTER" : "WORSE"}`);
  }

  // ---------- Verdict ----------
  log("\n" + "=".repeat(130));
  log("  VERDICT");
  log("=".repeat(130));
  log("  Ranking GARCH z-buckets by OOS $/day (per-trade edge quality):");
  const sortedG = [...garchOOSStats].sort((a, b) => {
    const ea = a.n > 0 ? a.pnl / a.n : -Infinity;
    const eb = b.n > 0 ? b.pnl / b.n : -Infinity;
    return eb - ea;
  });
  for (const s of sortedG) {
    const edge = s.n > 0 ? s.pnl / s.n : 0;
    log(`    ${s.label.padEnd(30)} edge/trade ${fmtD(edge)}  N=${s.n}  $/day ${fmtD(s.perDay)}  PF ${s.pf.toFixed(2)}`);
  }

  log("\n  Ranking REX range/ATR buckets by OOS edge/trade:");
  const sortedR = [...rexROOSStats].sort((a, b) => {
    const ea = a.n > 0 ? a.pnl / a.n : -Infinity;
    const eb = b.n > 0 ? b.pnl / b.n : -Infinity;
    return eb - ea;
  });
  for (const s of sortedR) {
    const edge = s.n > 0 ? s.pnl / s.n : 0;
    log(`    ${s.label.padEnd(30)} edge/trade ${fmtD(edge)}  N=${s.n}  $/day ${fmtD(s.perDay)}  PF ${s.pf.toFixed(2)}`);
  }

  log("\n  Ranking REX close-pos buckets by OOS edge/trade:");
  const sortedC = [...rexCOOSStats].sort((a, b) => {
    const ea = a.n > 0 ? a.pnl / a.n : -Infinity;
    const eb = b.n > 0 ? b.pnl / b.n : -Infinity;
    return eb - ea;
  });
  for (const s of sortedC) {
    const edge = s.n > 0 ? s.pnl / s.n : 0;
    log(`    ${s.label.padEnd(30)} edge/trade ${fmtD(edge)}  N=${s.n}  $/day ${fmtD(s.perDay)}  PF ${s.pf.toFixed(2)}`);
  }

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "quality-bucket.txt"), lines.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "quality-bucket.txt")}`);
}

main();
