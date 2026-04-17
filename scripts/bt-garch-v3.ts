/**
 * GARCH v3 — Novel angle explorer. Tests 7 new ideas never backtested before.
 *
 * Angles:
 *   1. Shorter/longer z-score lookback (MOM_LB) + vol window (VOL_WIN)
 *   2. 4h-only entry (skip 1h z requirement)
 *   3. Dynamic margin scaling by z-strength
 *   4. Pyramiding (add to winners at higher z thresholds)
 *   5. Re-entry after SL with no cooldown
 *   6. ATR-scaled stop-loss (instead of fixed %)
 *   7. Weekend filter (skip Sat/Sun entries)
 *
 * Engine: copied from bt-mdd20.ts with all 4 bug fixes.
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-garch-v3.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MAX_HOLD_H = 72;
const FEE = 0.00035;
const BLOCK_HOURS = new Set([22, 23]);

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
const NUM_SLOTS = Math.ceil((OOS_E - OOS_S) / M5);

interface C { t: number; o: number; h: number; l: number; c: number; }

interface PairData {
  name: string;
  sp: number;
  lev: number;
  h1: C[];
  atr14: number[];
  atrMed30: number[];
  h1Map: Map<number, number>;
  h4: C[];
  h4Map: Map<number, number>;
  // z-scores per (momLb, volWin) combo — keyed by "momLb:volWin"
  z1Cache: Map<string, number[]>;
  z4Cache: Map<string, number[]>;
  m5O: Float64Array;
  m5H: Float64Array;
  m5L: Float64Array;
  m5C: Float64Array;
  m5Valid: Uint8Array;
}

// ---- Data Loading ----
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

function computeZ(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const m = cs[i]!.c / cs[i - momLb]!.c - 1;
    let ss = 0, c = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
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

// ---- Config ----
interface TrailStep { a: number; d: number; }
interface Cfg {
  label: string;
  angle: string;      // which angle category
  margin: number;
  slPct: number;       // fixed SL % (0 = use ATR-scaled)
  atrSlMult: number;   // ATR multiplier for SL (0 = use fixed slPct)
  trail: TrailStep[];
  z1h: number;         // 0 = skip 1h z requirement (4h-only mode)
  z4h: number;
  atrThr: number;      // 0 = no ATR regime filter
  bePct: number;
  momLb: number;
  volWin: number;
  noCooldown: boolean;
  weekendFilter: boolean;
  // Dynamic margin: if > 0, margin scales with z-strength
  dynMargin: boolean;
  // Pyramiding: if true, add $5 at z>3 and z>4 if profitable
  pyramid: boolean;
}

// ---- Simulation ----
interface OpenPos {
  pairIdx: number;
  ep: number;       // average entry price
  et: number;
  sl: number;
  pk: number;
  lev: number;
  not: number;       // total notional
  beFired: boolean;
  pyramidCount: number;
  margin: number;    // total margin committed
}

interface SimResult {
  totalPnl: number;
  dollarsPerDay: number;
  mtmMaxDD: number;
  pf: number;
  wr: number;
  numTrades: number;
  calmar: number;
}

function simulate(pairs: PairData[], cfg: Cfg, mddAbort = 40): SimResult {
  const pnls: number[] = [];
  const cdSlot = new Int32Array(pairs.length).fill(-1);
  const openPositions: OpenPos[] = [];
  const hasOpen = new Uint8Array(pairs.length);

  let realizedPnl = 0;
  let mtmPeak = 0;
  let mtmMaxDD = 0;
  let aborted = false;

  const zKey = `${cfg.momLb}:${cfg.volWin}`;

  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (aborted) break;
    const ts = OOS_S + slot * M5;
    const isH1 = ts % H === 0;

    // ---- EXIT checks (every 5m bar) ----
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
          pos.sl = pos.ep;
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
        if (isSL && !cfg.noCooldown) cdSlot[pos.pairIdx] = slot + 12; // 1h = 12 slots
      }
    }

    // ---- PYRAMIDING checks (1h boundary, if enabled) ----
    if (isH1 && cfg.pyramid) {
      for (const pos of openPositions) {
        if (pos.pyramidCount >= 2) continue; // max 3 entries total (1 initial + 2 adds)
        const pd = pairs[pos.pairIdx]!;
        if (!pd.m5Valid[slot]) continue;
        const barC = pd.m5C[slot]!;
        const curPnlPct = (barC / pos.ep - 1) * pos.lev * 100;
        if (curPnlPct <= 0) continue; // only add to winners

        const h1Idx = pd.h1Map.get(ts);
        if (h1Idx === undefined || h1Idx < cfg.volWin + 2) continue;
        const z1Arr = pd.z1Cache.get(zKey)!;
        const z1 = z1Arr[h1Idx - 1]!;

        const addThreshold = pos.pyramidCount === 0 ? 3.0 : 4.0;
        if (z1 > addThreshold) {
          const addMargin = 5;
          const addNot = addMargin * pd.lev;
          const addEp = barC * (1 + pd.sp);
          // Weighted average entry
          const totalNot = pos.not + addNot;
          pos.ep = (pos.ep * pos.not + addEp * addNot) / totalNot;
          pos.not = totalNot;
          pos.margin += addMargin;
          pos.pyramidCount++;
          // Recalculate SL from new average entry
          if (cfg.slPct > 0) {
            pos.sl = pos.ep * (1 - cfg.slPct / 100);
          }
        }
      }
    }

    // ---- MTM MDD (every 5m bar) ----
    if (openPositions.length > 0) {
      let unrealized = 0;
      for (const pos of openPositions) {
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

    if (mtmMaxDD > mddAbort) { aborted = true; continue; }

    // ---- ENTRY (1h boundaries only) ----
    if (!isH1) continue;
    const hourOfDay = new Date(ts).getUTCHours();
    if (BLOCK_HOURS.has(hourOfDay)) continue;

    // Weekend filter
    if (cfg.weekendFilter) {
      const dow = new Date(ts).getUTCDay();
      if (dow === 0 || dow === 6) continue;
    }

    for (let pi = 0; pi < pairs.length; pi++) {
      if (hasOpen[pi]) continue;
      const pd = pairs[pi]!;
      const h1Idx = pd.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < Math.max(cfg.volWin, cfg.momLb) + 2) continue;

      // Cooldown check
      if (slot < cdSlot[pi]!) continue;

      const z1Arr = pd.z1Cache.get(zKey)!;
      const z4Arr = pd.z4Cache.get(zKey)!;

      if (cfg.z1h > 0) {
        // Standard mode: require both 1h and 4h z-score
        const z1 = z1Arr[h1Idx - 1]!;
        if (z1 <= cfg.z1h) continue;
        const z4 = get4hZ(z4Arr, pd.h4, ts);
        if (z4 <= cfg.z4h) continue;
      } else {
        // 4h-only mode: skip 1h, use only 4h z-score
        const z4 = get4hZ(z4Arr, pd.h4, ts);
        if (z4 <= cfg.z4h) continue;
      }

      // ATR regime filter
      if (cfg.atrThr > 0) {
        const atrVal = pd.atr14[h1Idx - 1] ?? 0;
        const atrMed = pd.atrMed30[h1Idx - 1] ?? 0;
        if (atrVal === 0 || atrMed === 0 || atrVal / atrMed < cfg.atrThr) continue;
      }

      const rawOpen = pd.h1[h1Idx]!.o;
      const ep = rawOpen * (1 + pd.sp);

      // Determine margin
      let effMargin = cfg.margin;
      if (cfg.dynMargin) {
        const z1 = z1Arr[h1Idx - 1]!;
        if (z1 > 5.0) effMargin = 20;
        else if (z1 > 4.0) effMargin = 12;
        else if (z1 > 3.0) effMargin = 8;
        else effMargin = 5; // z > 2.0 (minimum entry threshold)
      }

      // Determine SL
      let slPrice: number;
      if (cfg.atrSlMult > 0) {
        // ATR-scaled SL
        const atrVal = pd.atr14[h1Idx - 1] ?? 0;
        if (atrVal === 0) continue;
        const slDist = atrVal * cfg.atrSlMult;
        slPrice = ep - slDist;
        // Cap at 2% from entry
        const maxSl = ep * (1 - 2.0 / 100);
        if (slPrice < maxSl) slPrice = maxSl;
      } else {
        slPrice = ep * (1 - cfg.slPct / 100);
      }

      const effNot = effMargin * pd.lev;

      openPositions.push({
        pairIdx: pi, ep, et: ts, sl: slPrice, pk: 0,
        lev: pd.lev, not: effNot, beFired: false,
        pyramidCount: 0, margin: effMargin,
      });
      hasOpen[pi] = 1;
    }
  }

  // Close remaining at end
  for (const pos of openPositions) {
    const pd = pairs[pos.pairIdx]!;
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
  let wins = 0, gp = 0, glAbs = 0;
  for (const p of pnls) {
    if (p > 0) { wins++; gp += p; }
    else { glAbs += Math.abs(p); }
  }
  const pf = glAbs > 0 ? gp / glAbs : (gp > 0 ? Infinity : 0);
  const wr = pnls.length > 0 ? wins / pnls.length * 100 : 0;
  const dpd = totalPnl / OOS_D;
  const calmar = mtmMaxDD > 0 ? dpd / mtmMaxDD : 0;

  return {
    totalPnl,
    dollarsPerDay: dpd,
    mtmMaxDD,
    pf, wr,
    numTrades: pnls.length,
    calmar,
  };
}

// ---- Main ----
console.log("Loading 5m data for 125+ pairs...");
const t0 = Date.now();

// All unique (momLb, volWin) combos we need z-scores for
const MOM_LBS = [1, 2, 3, 5, 7];
const VOL_WINS = [10, 15, 20, 30, 50];
const Z_KEYS: Array<[number, number]> = [];
for (const m of MOM_LBS) {
  for (const v of VOL_WINS) {
    Z_KEYS.push([m, v]);
  }
}

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

  const atr14 = computeATR(h1, 14);
  const atrMed30 = computeRollingMedian(atr14, 720);
  const lev = getLev(n);

  // Precompute z-scores for all (momLb, volWin) combos
  const z1Cache = new Map<string, number[]>();
  const z4Cache = new Map<string, number[]>();
  for (const [m, v] of Z_KEYS) {
    const key = `${m}:${v}`;
    z1Cache.set(key, computeZ(h1, m, v));
    z4Cache.set(key, computeZ(h4, m, v));
  }

  // Build indexed 5m arrays
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
    h1, atr14, atrMed30, h1Map,
    h4, h4Map,
    z1Cache, z4Cache,
    m5O, m5H, m5L, m5C, m5Valid,
  });
}
console.log(`${pairs.length} pairs loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

// ---- Build configs ----
const cfgs: Cfg[] = [];

const TRAIL_LIVE: TrailStep[] = [{ a: 3, d: 1 }, { a: 9, d: 0.5 }, { a: 20, d: 0.5 }];
const TRAIL_9: TrailStep[] = [{ a: 9, d: 0.5 }];
const TRAIL_20: TrailStep[] = [{ a: 20, d: 1 }];

function makeCfg(overrides: Partial<Cfg> & { label: string; angle: string }): Cfg {
  return {
    margin: 5, slPct: 0.15, atrSlMult: 0, trail: TRAIL_LIVE, z1h: 2, z4h: 1.5,
    atrThr: 1.6, bePct: 0, momLb: 3, volWin: 20, noCooldown: false,
    weekendFilter: false, dynMargin: false, pyramid: false,
    ...overrides,
  };
}

// ============================
// ANGLE 1: Z-score lookback + vol window variations
// MOM_LB x VOL_WIN combos (skip default 3:20), fixed other params
// With margins $5, $8 and ATR thresholds 1.6, 0 (no filter)
// = (25-1) * 2 * 2 = 96 configs
// ============================
for (const momLb of MOM_LBS) {
  for (const volWin of VOL_WINS) {
    if (momLb === 3 && volWin === 20) continue; // skip baseline
    for (const margin of [5, 8]) {
      for (const atrThr of [1.6, 0]) {
        cfgs.push(makeCfg({
          label: `A1 lb${momLb} vw${volWin} m$${margin} atr${atrThr || "-"}`,
          angle: "1-zlookback",
          margin, momLb, volWin, atrThr,
        }));
      }
    }
  }
}

// ============================
// ANGLE 2: 4h-only entry (no 1h z requirement)
// z4h thresholds x margins x ATR thresholds x trails
// = 4 * 3 * 3 * 3 = 108 configs
// ============================
for (const z4h of [1.0, 1.5, 2.0, 2.5]) {
  for (const margin of [3, 5, 8]) {
    for (const atrThr of [1.6, 2.0, 0]) {
      for (const trCfg of [
        { lbl: "trLive", t: TRAIL_LIVE },
        { lbl: "tr9", t: TRAIL_9 },
        { lbl: "tr20", t: TRAIL_20 },
      ]) {
        cfgs.push(makeCfg({
          label: `A2 4hOnly z4h${z4h} m$${margin} atr${atrThr || "-"} ${trCfg.lbl}`,
          angle: "2-4honly",
          z1h: 0, z4h, margin, atrThr, trail: trCfg.t,
        }));
      }
    }
  }
}

// ============================
// ANGLE 3: Dynamic margin by z-strength
// z thresholds x ATR thresholds x trails
// = 3 * 3 * 3 = 27 configs
// ============================
for (const z1h of [1.5, 2.0, 2.5]) {
  for (const atrThr of [1.6, 2.0, 0]) {
    for (const trCfg of [
      { lbl: "trLive", t: TRAIL_LIVE },
      { lbl: "tr9", t: TRAIL_9 },
      { lbl: "tr20", t: TRAIL_20 },
    ]) {
      cfgs.push(makeCfg({
        label: `A3 dynM z${z1h}/1.5 atr${atrThr || "-"} ${trCfg.lbl}`,
        angle: "3-dynmargin",
        z1h, z4h: 1.5, atrThr, trail: trCfg.t, dynMargin: true,
      }));
    }
  }
}

// ============================
// ANGLE 4: Pyramiding (add to winners)
// z thresholds x margins x ATR thresholds
// = 3 * 3 * 2 = 18 configs
// ============================
for (const z1h of [1.5, 2.0, 2.5]) {
  for (const margin of [3, 5, 8]) {
    for (const atrThr of [1.6, 0]) {
      cfgs.push(makeCfg({
        label: `A4 pyram z${z1h}/1.5 m$${margin} atr${atrThr || "-"}`,
        angle: "4-pyramid",
        z1h, z4h: 1.5, margin, atrThr, pyramid: true,
      }));
    }
  }
}

// ============================
// ANGLE 5: No cooldown after SL
// z thresholds x margins x ATR thresholds x SL pcts
// = 3 * 3 * 2 * 2 = 36 configs
// ============================
for (const z1h of [1.5, 2.0, 2.5]) {
  for (const margin of [3, 5, 8]) {
    for (const atrThr of [1.6, 0]) {
      for (const slPct of [0.15, 0.3]) {
        cfgs.push(makeCfg({
          label: `A5 noCD z${z1h}/1.5 m$${margin} sl${slPct} atr${atrThr || "-"}`,
          angle: "5-nocooldown",
          z1h, z4h: 1.5, margin, atrThr, slPct, noCooldown: true,
        }));
      }
    }
  }
}

// ============================
// ANGLE 6: ATR-scaled SL
// atrSlMult x z thresholds x margins x ATR regime
// = 3 * 3 * 3 * 2 = 54 configs
// ============================
for (const atrSlMult of [0.5, 1.0, 1.5]) {
  for (const z1h of [1.5, 2.0, 2.5]) {
    for (const margin of [3, 5, 8]) {
      for (const atrThr of [1.6, 0]) {
        cfgs.push(makeCfg({
          label: `A6 atrSL${atrSlMult}x z${z1h}/1.5 m$${margin} atr${atrThr || "-"}`,
          angle: "6-atrsl",
          z1h, z4h: 1.5, margin, atrThr, slPct: 0, atrSlMult,
        }));
      }
    }
  }
}

// ============================
// ANGLE 7: Weekend filter
// z thresholds x margins x ATR thresholds x SL
// = 3 * 3 * 2 * 2 = 36 configs
// ============================
for (const z1h of [1.5, 2.0, 2.5]) {
  for (const margin of [3, 5, 8]) {
    for (const atrThr of [1.6, 0]) {
      for (const slPct of [0.15, 0.3]) {
        cfgs.push(makeCfg({
          label: `A7 noWknd z${z1h}/1.5 m$${margin} sl${slPct} atr${atrThr || "-"}`,
          angle: "7-weekend",
          z1h, z4h: 1.5, margin, atrThr, slPct, weekendFilter: true,
        }));
      }
    }
  }
}

// ============================
// COMBO: Best ideas combined
// Short lookback + no cooldown + weekend filter
// = 4 * 3 * 2 * 2 = 48 configs
// ============================
for (const momLb of [1, 2, 5]) {
  for (const volWin of [10, 15, 30]) {
    for (const margin of [5, 8]) {
      for (const atrThr of [1.6, 0]) {
        cfgs.push(makeCfg({
          label: `COMBO lb${momLb} vw${volWin} m$${margin} atr${atrThr || "-"} noCD+wknd`,
          angle: "8-combo",
          momLb, volWin, margin, atrThr, noCooldown: true, weekendFilter: true,
        }));
      }
    }
  }
}

// ============================
// COMBO 2: Dynamic margin + short lookback
// = 3 * 3 * 2 = 18 configs
// ============================
for (const momLb of [1, 2, 5]) {
  for (const volWin of [10, 15, 30]) {
    for (const atrThr of [1.6, 0]) {
      cfgs.push(makeCfg({
        label: `COMBO2 lb${momLb} vw${volWin} dynM atr${atrThr || "-"}`,
        angle: "9-combo2",
        momLb, volWin, atrThr, dynMargin: true,
      }));
    }
  }
}

// ============================
// COMBO 3: ATR-scaled SL + no cooldown + weekend filter
// = 3 * 3 * 2 = 18 configs
// ============================
for (const atrSlMult of [0.5, 1.0, 1.5]) {
  for (const margin of [3, 5, 8]) {
    for (const atrThr of [1.6, 0]) {
      cfgs.push(makeCfg({
        label: `COMBO3 atrSL${atrSlMult}x m$${margin} atr${atrThr || "-"} noCD+wknd`,
        angle: "10-combo3",
        margin, atrThr, slPct: 0, atrSlMult, noCooldown: true, weekendFilter: true,
      }));
    }
  }
}

// ============================
// BASELINE reference (existing best configs for comparison)
// = 2 * 3 * 3 = 18 configs
// ============================
for (const margin of [5, 8]) {
  for (const atrThr of [1.6, 1.8, 0]) {
    for (const trCfg of [
      { lbl: "trLive", t: TRAIL_LIVE },
      { lbl: "tr9", t: TRAIL_9 },
      { lbl: "tr20", t: TRAIL_20 },
    ]) {
      cfgs.push(makeCfg({
        label: `BASE m$${margin} atr${atrThr || "-"} ${trCfg.lbl}`,
        angle: "0-baseline",
        margin, atrThr, trail: trCfg.t,
      }));
    }
  }
}

console.log(`Testing ${cfgs.length} configs across ${OOS_D.toFixed(0)} days...`);

interface Row {
  label: string;
  angle: string;
  dpd: number;
  mtm: number;
  pf: number;
  wr: number;
  n: number;
  calmar: number;
}

const allResults: Row[] = [];
const winners: Row[] = [];
let tested = 0;
const t1 = Date.now();

for (const cfg of cfgs) {
  const r = simulate(pairs, cfg);
  tested++;
  if (tested % 100 === 0) {
    const elapsed = (Date.now() - t1) / 1000;
    const eta = (elapsed / tested) * (cfgs.length - tested);
    console.log(`  ${tested}/${cfgs.length} (${elapsed.toFixed(0)}s elapsed, ETA ${eta.toFixed(0)}s)  winners: ${winners.length}`);
  }
  if (r.numTrades < 10) continue;
  const row: Row = {
    label: cfg.label,
    angle: cfg.angle,
    dpd: r.dollarsPerDay,
    mtm: r.mtmMaxDD,
    pf: r.pf,
    wr: r.wr,
    n: r.numTrades,
    calmar: r.calmar,
  };
  allResults.push(row);
  if (r.mtmMaxDD < 20 && r.totalPnl > 0) winners.push(row);
}

const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`\nDone. ${tested} configs in ${elapsed}s.\n`);

// ---- Output ----
function printTable(rows: Row[]): void {
  console.log(
    "$/day".padStart(7) + " " +
    "MTM_DD".padStart(8) + " " +
    "Calmar".padStart(8) + " " +
    "PF".padStart(6) + " " +
    "WR%".padStart(6) + " " +
    "#Tr".padStart(5) + "  " +
    "Angle".padStart(14) + "  " +
    "Config"
  );
  console.log("-".repeat(140));
  for (const r of rows) {
    console.log(
      `${r.dpd >= 0 ? "+" : ""}${r.dpd.toFixed(2)}`.padStart(7) + " " +
      `$${r.mtm.toFixed(2)}`.padStart(8) + " " +
      r.calmar.toFixed(4).padStart(8) + " " +
      r.pf.toFixed(2).padStart(6) + " " +
      r.wr.toFixed(1).padStart(6) + " " +
      String(r.n).padStart(5) + "  " +
      r.angle.padStart(14) + "  " +
      r.label
    );
  }
}

// Winners sorted by $/day
winners.sort((a, b) => b.dpd - a.dpd);

if (winners.length === 0) {
  console.log("NO configs with MTM MDD < $20 and positive PnL.");
  console.log("\nFallback: top 50 by lowest MTM MDD:");
  allResults.sort((a, b) => a.mtm - b.mtm);
  printTable(allResults.slice(0, 50));
} else {
  console.log(`=== ${winners.length} configs with MTM MDD < $20 sorted by $/day ===\n`);
  printTable(winners.slice(0, 50));

  // Group summary by angle
  console.log("\n\n=== ANGLE SUMMARY ===");
  const byAngle = new Map<string, Row[]>();
  for (const r of winners) {
    const arr = byAngle.get(r.angle) ?? [];
    arr.push(r);
    byAngle.set(r.angle, arr);
  }
  for (const [angle, rows] of [...byAngle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => b.dpd - a.dpd);
    const best = rows[0]!;
    const avgDpd = rows.reduce((s, r) => s + r.dpd, 0) / rows.length;
    const avgMdd = rows.reduce((s, r) => s + r.mtm, 0) / rows.length;
    console.log(`\n${angle}: ${rows.length} winners, avg $/day=${avgDpd.toFixed(2)}, avg MDD=$${avgMdd.toFixed(2)}`);
    console.log(`  Best: ${best.label} -> $${best.dpd.toFixed(2)}/day, MDD $${best.mtm.toFixed(2)}, PF ${best.pf.toFixed(2)}, Calmar ${best.calmar.toFixed(4)}`);
  }

  // Top 10 by Calmar ratio
  console.log("\n\n=== TOP 10 BY CALMAR RATIO ($/day per $1 MDD) ===\n");
  const byCalmar = [...winners].sort((a, b) => b.calmar - a.calmar);
  printTable(byCalmar.slice(0, 10));
}

// Show all results sorted by MDD if no winners found
if (winners.length > 0 && winners.length < 10) {
  console.log("\n\n=== Top 20 overall by $/day (any MDD) ===\n");
  allResults.sort((a, b) => b.dpd - a.dpd);
  printTable(allResults.slice(0, 20));
}
