/**
 * MDD <$20 Explorer — Corrected GARCH v2 backtest with all 4 bug fixes.
 *
 * Bug fixes applied:
 *   1. Trail fires ONLY at 1h boundaries (not every 5m bar)
 *   2. MDD is mark-to-market (unrealized at EVERY 5m bar, not just 1h)
 *   3. Z-reversal uses prior completed bar (h1Idx-1), no look-ahead
 *   4. Short PnL uses (1 - ex/ep) not (ep/ex - 1)
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-mdd20.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MOM_LB = 3;
const VOL_WIN = 20;
const MAX_HOLD_H = 72;
const CD_H = 1;
const BLOCK_HOURS = new Set([22, 23]);
const FEE = 0.00035;

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
function getLev(n: string): number { return Math.min(LM.get(n) ?? 3, 10); }

const ALL = [
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

// Per-pair precomputed data using indexed arrays for fast lookup
interface PairData {
  name: string;
  sp: number;
  lev: number;
  // 1h bars + indicators (full history for indicator computation)
  h1: C[];
  z1: number[];
  atr14: number[];
  atrMed30: number[];
  h1Map: Map<number, number>;
  // 4h bars + indicators
  h4: C[];
  z4: number[];
  h4Map: Map<number, number>;
  // 5m bars indexed by slot offset from OOS_S
  // m5Slots[slotIdx] = {o,h,l,c} or undefined if no data
  m5O: Float64Array;  // open prices at each 5m slot
  m5H: Float64Array;  // high
  m5L: Float64Array;  // low
  m5C: Float64Array;  // close
  m5Valid: Uint8Array; // 1 if slot has data, 0 if not
}

// ───── Data Loading ─────
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
    r.push({
      t,
      o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
  }
  return r.sort((a, b) => a.t - b.t);
}

function computeZ(cs: C[]): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - MOM_LB]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - VOL_WIN); j <= i; j++) {
      const rr = cs[j]!.c / cs[j - 1]!.c - 1;
      ss += rr * rr;
      c++;
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
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const hi = cs[i]!.h, lo = cs[i]!.l, pc = cs[i - 1]!.c;
    tr[i] = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i]!;
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < cs.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

function computeRollingMedian(values: number[], window: number): number[] {
  const out = new Array(values.length).fill(0);
  if (values.length < window + 2) return out;
  // Sample every 6 bars (stride 6) for speed — matches live engine
  const STRIDE = 6;
  for (let i = window; i < values.length; i++) {
    const slice: number[] = [];
    for (let j = i - window; j < i; j += STRIDE) {
      const v = values[j]!;
      if (v > 0) slice.push(v);
    }
    if (slice.length < 10) { out[i] = 0; continue; }
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)]!;
  }
  return out;
}

function get4hZ(z4: number[], h4: C[], t: number): number {
  let lo = 0, hi = h4.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h4[m]!.t < t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best >= 0 ? z4[best]! : 0;
}

// ───── Config ─────
interface TrailStep { a: number; d: number; }
interface Cfg {
  label: string;
  margin: number;
  slPct: number;
  trail: TrailStep[];
  z1h: number;
  z4h: number;
  atrThr: number;
  bePct: number;
}

// ───── Simulation ─────
interface OpenPos {
  pairIdx: number;
  ep: number;
  et: number;
  sl: number;
  pk: number;
  lev: number;
  not: number;
  beFired: boolean;
}

interface SimResult {
  totalPnl: number;
  dollarsPerDay: number;
  mtmMaxDD: number;
  closedMaxDD: number;
  pf: number;
  wr: number;
  numTrades: number;
}

// Total number of 5m slots in OOS period
const NUM_SLOTS = Math.ceil((OOS_E - OOS_S) / M5);

function simulate(pairs: PairData[], cfg: Cfg, mddAbort = 40): SimResult {
  const pnls: number[] = [];
  const cdSlot = new Int32Array(pairs.length).fill(-1);
  const openPositions: OpenPos[] = [];
  const hasOpen = new Uint8Array(pairs.length);

  let realizedPnl = 0;
  let mtmPeak = 0;
  let mtmMaxDD = 0;
  let aborted = false;

  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (aborted) break;
    const ts = OOS_S + slot * M5;
    const isH1 = ts % H === 0;

    // ─── EXIT checks (every 5m bar) ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pd = pairs[pos.pairIdx]!;
      if (!pd.m5Valid[slot]) continue;

      const barH = pd.m5H[slot]!;
      const barL = pd.m5L[slot]!;
      const barC = pd.m5C[slot]!;

      let xp = 0, isSL = false;

      // 1) Max hold
      if ((ts - pos.et) >= MAX_HOLD_H * H) { xp = barC; }

      // 2) Exchange SL (intra-bar)
      if (!xp && barL <= pos.sl) { xp = pos.sl; isSL = true; }

      // Track peak (bar.h for longs, every 5m)
      const best = (barH / pos.ep - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      // 3) Breakeven (1h boundary only)
      if (!xp && isH1 && cfg.bePct > 0) {
        if (!pos.beFired && pos.pk >= cfg.bePct) {
          pos.beFired = true;
          pos.sl = pos.ep; // move SL to entry
        }
        if (pos.beFired) {
          const curLev = (barC / pos.ep - 1) * pos.lev * 100;
          if (curLev <= 0) { xp = barC; }
        }
      }

      // 4) Trail (1h boundary only)
      if (!xp && isH1 && cfg.trail.length > 0) {
        const cur = (barC / pos.ep - 1) * pos.lev * 100;
        let td = Infinity;
        for (let s = 0; s < cfg.trail.length; s++) {
          if (pos.pk >= cfg.trail[s]!.a) td = cfg.trail[s]!.d;
        }
        if (td < Infinity && cur <= pos.pk - td) { xp = barC; }
      }

      if (xp > 0) {
        const rsp = isSL ? pd.sp * 1.5 : pd.sp;
        const ex = xp * (1 - rsp);
        const pnl = (ex / pos.ep - 1) * pos.not - pos.not * FEE * 2;
        pnls.push(pnl);
        realizedPnl += pnl;
        hasOpen[pos.pairIdx] = 0;
        openPositions.splice(i, 1);
        if (isSL) cdSlot[pos.pairIdx] = slot + CD_H * 12; // 1h = 12 slots
      }
    }

    // ─── MTM MDD (every 5m bar) ───
    if (openPositions.length > 0) {
      let unrealized = 0;
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i]!;
        const pd = pairs[pos.pairIdx]!;
        if (!pd.m5Valid[slot]) continue;
        const midExit = pd.m5C[slot]! * (1 - pd.sp);
        unrealized += (midExit / pos.ep - 1) * pos.not - pos.not * FEE * 2;
      }
      const eq = realizedPnl + unrealized;
      if (eq > mtmPeak) mtmPeak = eq;
      const dd = mtmPeak - eq;
      if (dd > mtmMaxDD) mtmMaxDD = dd;
    } else {
      if (realizedPnl > mtmPeak) mtmPeak = realizedPnl;
      const dd = mtmPeak - realizedPnl;
      if (dd > mtmMaxDD) mtmMaxDD = dd;
    }

    // Early abort if MDD already exceeds threshold
    if (mtmMaxDD > mddAbort) { aborted = true; continue; }

    // ─── ENTRY (1h boundaries only) ───
    if (!isH1) continue;
    const hourOfDay = new Date(ts).getUTCHours();
    if (BLOCK_HOURS.has(hourOfDay)) continue;

    for (let pi = 0; pi < pairs.length; pi++) {
      if (hasOpen[pi]) continue;
      const pd = pairs[pi]!;
      const h1Idx = pd.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < VOL_WIN + 2) continue;

      // Z-score uses prior completed bar (BUG FIX #3)
      const z1 = pd.z1[h1Idx - 1]!;
      if (z1 <= cfg.z1h) continue; // quick reject

      const z4 = get4hZ(pd.z4, pd.h4, ts);
      if (z4 <= cfg.z4h) continue;

      // ATR regime filter
      const atrVal = pd.atr14[h1Idx - 1] ?? 0;
      const atrMed = pd.atrMed30[h1Idx - 1] ?? 0;
      if (atrVal === 0 || atrMed === 0 || atrVal / atrMed < cfg.atrThr) continue;

      // Cooldown check
      if (slot < cdSlot[pi]!) continue;

      const rawOpen = pd.h1[h1Idx]!.o;
      const ep = rawOpen * (1 + pd.sp);
      const slPrice = ep * (1 - cfg.slPct / 100);
      const effNot = cfg.margin * pd.lev;

      openPositions.push({
        pairIdx: pi, ep, et: ts, sl: slPrice, pk: 0,
        lev: pd.lev, not: effNot, beFired: false,
      });
      hasOpen[pi] = 1;
    }
  }

  // Close remaining at end
  for (const pos of openPositions) {
    const pd = pairs[pos.pairIdx]!;
    // Find last valid slot
    let lastC = 0;
    for (let s = NUM_SLOTS - 1; s >= 0; s--) {
      if (pd.m5Valid[s]) { lastC = pd.m5C[s]!; break; }
    }
    if (lastC > 0) {
      const ex = lastC * (1 - pd.sp);
      const pnl = (ex / pos.ep - 1) * pos.not - pos.not * FEE * 2;
      pnls.push(pnl);
    }
  }

  // Stats
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  let wins = 0, gp = 0, losses = 0, glAbs = 0;
  for (const p of pnls) {
    if (p > 0) { wins++; gp += p; }
    else { losses++; glAbs += Math.abs(p); }
  }
  const pf = glAbs > 0 ? gp / glAbs : (gp > 0 ? Infinity : 0);
  const wr = pnls.length > 0 ? wins / pnls.length * 100 : 0;

  let cum = 0, peak = 0, closedMaxDD = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > closedMaxDD) closedMaxDD = dd;
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    mtmMaxDD,
    closedMaxDD,
    pf, wr,
    numTrades: pnls.length,
  };
}

// ───── Main ─────
console.log("Loading 5m data for 127 pairs...");
const t0 = Date.now();
const pairs: PairData[] = [];
for (const n of ALL) {
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
  const atrMed30 = computeRollingMedian(atr14, 720);
  const lev = getLev(n);

  // Build indexed 5m arrays (slot-based)
  const m5O = new Float64Array(NUM_SLOTS);
  const m5H = new Float64Array(NUM_SLOTS);
  const m5L = new Float64Array(NUM_SLOTS);
  const m5C = new Float64Array(NUM_SLOTS);
  const m5Valid = new Uint8Array(NUM_SLOTS);

  for (const b of raw) {
    if (b.t < OOS_S || b.t >= OOS_E) continue;
    const slot = Math.round((b.t - OOS_S) / M5);
    if (slot >= 0 && slot < NUM_SLOTS) {
      m5O[slot] = b.o;
      m5H[slot] = b.h;
      m5L[slot] = b.l;
      m5C[slot] = b.c;
      m5Valid[slot] = 1;
    }
  }

  pairs.push({
    name: n, sp: SP[n] ?? DSP, lev,
    h1, z1, atr14, atrMed30, h1Map,
    h4, z4, h4Map,
    m5O, m5H, m5L, m5C, m5Valid,
  });
}
console.log(`${pairs.length} pairs loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

// ───── Build configs ─────
const cfgs: Cfg[] = [];

const MARGINS = [3, 4, 5, 6, 7, 8, 10];
const ATR_THRESHOLDS = [1.4, 1.6, 1.8, 2.0, 2.5, 3.0];
const Z_COMBOS: Array<[number, number]> = [[2, 1.5], [2.5, 1.5], [2.5, 2], [3, 2]];
const SL_PCTS = [0.15, 0.2, 0.3];
const TRAIL_VARIANTS: Array<{ lbl: string; steps: TrailStep[] }> = [
  { lbl: "tr[3/1,9/.5,20/.5]", steps: [{ a: 3, d: 1 }, { a: 9, d: 0.5 }, { a: 20, d: 0.5 }] },
  { lbl: "tr[9/.5]", steps: [{ a: 9, d: 0.5 }] },
  { lbl: "tr[20/1]", steps: [{ a: 20, d: 1 }] },
  { lbl: "none", steps: [] },
];
const BE_PCTS = [0, 2, 3, 5];

for (const margin of MARGINS) {
  for (const atrThr of ATR_THRESHOLDS) {
    for (const [z1h, z4h] of Z_COMBOS) {
      for (const slPct of SL_PCTS) {
        for (const tv of TRAIL_VARIANTS) {
          for (const bePct of BE_PCTS) {
            if (tv.steps.length === 0 && bePct === 0) continue;
            cfgs.push({
              label: `m$${margin} atr${atrThr} z${z1h}/${z4h} sl${slPct} ${tv.lbl} be${bePct || "-"}`,
              margin, slPct, trail: tv.steps,
              z1h, z4h, atrThr, bePct,
            });
          }
        }
      }
    }
  }
}

console.log(`Testing ${cfgs.length} configs...`);

interface Row { label: string; dpd: number; mtm: number; closed: number; pf: number; wr: number; n: number; }
const allResults: Row[] = [];
const winners: Row[] = [];
let tested = 0;
const t1 = Date.now();

for (const cfg of cfgs) {
  const r = simulate(pairs, cfg);
  tested++;
  if (tested % 1000 === 0) {
    const elapsed = (Date.now() - t1) / 1000;
    const eta = (elapsed / tested) * (cfgs.length - tested);
    console.log(`  ${tested}/${cfgs.length} (${elapsed.toFixed(0)}s elapsed, ETA ${eta.toFixed(0)}s)  winners so far: ${winners.length}`);
  }
  if (r.numTrades < 10) continue;
  const row: Row = {
    label: cfg.label,
    dpd: r.dollarsPerDay,
    mtm: r.mtmMaxDD,
    closed: r.closedMaxDD,
    pf: r.pf,
    wr: r.wr,
    n: r.numTrades,
  };
  allResults.push(row);
  if (r.mtmMaxDD < 20 && r.totalPnl > 0) winners.push(row);
}

const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`\nDone. ${tested} configs in ${elapsed}s.\n`);

// ───── Output ─────
winners.sort((a, b) => b.dpd - a.dpd);

if (winners.length === 0) {
  console.log("NO configs with MTM MDD < $20 and positive PnL.");
  console.log("\nFallback: top 30 by lowest MTM MDD:");
  allResults.sort((a, b) => a.mtm - b.mtm);
  printTable(allResults.slice(0, 30));
} else {
  console.log(`${winners.length} configs with MTM MDD < $20 and positive PnL:\n`);
  printTable(winners.slice(0, 100));
  if (winners.length > 100) console.log(`... and ${winners.length - 100} more.`);
}

function printTable(rows: Row[]): void {
  console.log(
    "$/day".padStart(7) + " " +
    "MTM_DD".padStart(8) + " " +
    "Cl_DD".padStart(8) + " " +
    "PF".padStart(6) + " " +
    "WR%".padStart(6) + " " +
    "#Tr".padStart(5) + "  " +
    "Config"
  );
  console.log("-".repeat(130));
  for (const r of rows) {
    console.log(
      `${r.dpd >= 0 ? "+" : ""}${r.dpd.toFixed(2)}`.padStart(7) + " " +
      `$${r.mtm.toFixed(2)}`.padStart(8) + " " +
      `$${r.closed.toFixed(2)}`.padStart(8) + " " +
      r.pf.toFixed(2).padStart(6) + " " +
      r.wr.toFixed(1).padStart(6) + " " +
      String(r.n).padStart(5) + "  " +
      r.label
    );
  }
}
