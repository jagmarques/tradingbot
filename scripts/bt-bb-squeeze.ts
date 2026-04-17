/**
 * Bollinger Band Squeeze Breakout backtest
 *
 * Detects low-volatility compression (squeeze) and enters on breakout.
 * Two squeeze modes: BB-width percentile, Keltner channel overlap.
 *
 * Corrected engine:
 *   - MTM MDD: realized + unrealized at every 5m bar
 *   - Fee: 0.035% taker per side
 *   - Spread: per-pair map (default 5e-4)
 *   - Short PnL: (1 - ex/ep) * notional
 *   - SL checked every 5m bar (exchange-level)
 *   - Trail checked at 1h boundaries ONLY
 *   - Leverage map from /tmp/hl-leverage-map.txt, cap 10x
 *   - Period: 2025-06-01 to 2026-03-25 (297 days)
 *   - 125 pairs
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *      NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-bb-squeeze.ts
 */

import * as fs from "fs";
import * as path from "path";

// ───── Constants ─────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 5 * 60_000;
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35;

const OOS_S = new Date("2025-06-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;
const NUM_SLOTS = Math.ceil((OOS_E - OOS_S) / M5);

// Spread map
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DSP = 5e-4;
const RM: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

// Leverage map
const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
function getLev(n: string): number { return Math.min(LM.get(n) ?? 3, 10); }

// All 125 pairs
const ALL = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN",
  "TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC",
  "MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS",
  "MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ",
  "CAKE","SUPER","FTT","STRAX",
];

// ───── Types ─────
interface C { t: number; o: number; h: number; l: number; c: number; v?: number; }

interface PairData {
  name: string;
  sp: number;
  lev: number;
  h1: C[];
  h1Map: Map<number, number>;
  // Precomputed 1h indicators
  bbMid: Float64Array;
  bbUpper: Float64Array;
  bbLower: Float64Array;
  bbWidth: Float64Array;
  kcUpper: Float64Array;
  kcLower: Float64Array;
  h1Vol: Float64Array;      // volume proxy: (h-l)/c range
  h1VolAvg20: Float64Array; // 20-bar rolling avg of volume proxy
  // 5m slot arrays
  m5H: Float64Array;
  m5L: Float64Array;
  m5C: Float64Array;
  m5Valid: Uint8Array;
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

// ───── Indicators ─────
function computeATR(cs: C[], period: number): Float64Array {
  const out = new Float64Array(cs.length);
  if (cs.length < period + 1) return out;
  const tr = new Float64Array(cs.length);
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

function computeBB(closes: number[], period: number, mult: number): {
  mid: Float64Array; upper: Float64Array; lower: Float64Array; width: Float64Array;
} {
  const n = closes.length;
  const mid = new Float64Array(n);
  const upper = new Float64Array(n);
  const lower = new Float64Array(n);
  const width = new Float64Array(n);

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
    const m = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (closes[j]! - m) ** 2;
    const std = Math.sqrt(varSum / period);
    mid[i] = m;
    upper[i] = m + mult * std;
    lower[i] = m - mult * std;
    width[i] = m > 0 ? (upper[i]! - lower[i]!) / m : 0;
  }

  return { mid, upper, lower, width };
}

function computeKC(cs: C[], period: number, atrMult: number): {
  upper: Float64Array; lower: Float64Array;
} {
  const n = cs.length;
  const closes = cs.map(c => c.c);
  const atr = computeATR(cs, 14);

  // EMA of close for KC middle
  const ema = new Float64Array(n);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += closes[j]!;
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = closes[i]! * k + ema[i - 1]! * (1 - k);
    }
  }

  const upper = new Float64Array(n);
  const lower = new Float64Array(n);
  for (let i = period - 1; i < n; i++) {
    if (ema[i]! > 0 && atr[i]! > 0) {
      upper[i] = ema[i]! + atrMult * atr[i]!;
      lower[i] = ema[i]! - atrMult * atr[i]!;
    }
  }

  return { upper, lower };
}

function computeVolProxy(cs: C[]): { vol: Float64Array; avg20: Float64Array } {
  const n = cs.length;
  const vol = new Float64Array(n);
  const avg20 = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    vol[i] = cs[i]!.c > 0 ? (cs[i]!.h - cs[i]!.l) / cs[i]!.c : 0;
  }

  for (let i = 19; i < n; i++) {
    let s = 0;
    for (let j = i - 19; j <= i; j++) s += vol[j]!;
    avg20[i] = s / 20;
  }

  return { vol, avg20 };
}

// ───── Config ─────
type SqueezeMode = "bb" | "kc";
type TpMode = "rr2" | "trail_3_1" | "trail_5_2" | "trail_10_3";

interface Cfg {
  label: string;
  bbPeriod: number;
  bbStd: number;
  squeezeThr: number;   // multiplier on 50-bar rolling min width
  volFilter: number;    // multiplier on 20-bar avg volume
  slPct: number;        // SL as % of price (0.5, 1.0, 1.5)
  tpMode: TpMode;
  maxHoldH: number;
  margin: number;
  longOnly: boolean;
  squeezeMode: SqueezeMode;
}

// ───── Position ─────
interface OpenPos {
  pairIdx: number;
  dir: "long" | "short";
  ep: number;           // effective entry (after spread)
  rawEp: number;        // raw entry
  et: number;
  sl: number;
  tp: number;           // 0 if trail mode
  pk: number;           // peak leveraged PnL %
  lev: number;
  not: number;
}

interface SimResult {
  totalPnl: number;
  dollarsPerDay: number;
  mtmMaxDD: number;
  pf: number;
  wr: number;
  numTrades: number;
  avgHold: number;
}

// ───── Simulation ─────
function simulate(pairs: PairData[], cfg: Cfg, maxPos: number, mddAbort: number): SimResult {
  const pnls: number[] = [];
  const holdTimes: number[] = [];
  const openPositions: OpenPos[] = [];
  const hasOpen = new Uint8Array(pairs.length);

  let realizedPnl = 0;
  let mtmPeak = 0;
  let mtmMaxDD = 0;
  let aborted = false;

  // Trail params from tpMode
  let trailAct = 0, trailDist = 0;
  let useFixedTP = false;
  if (cfg.tpMode === "trail_3_1") { trailAct = 3; trailDist = 1; }
  else if (cfg.tpMode === "trail_5_2") { trailAct = 5; trailDist = 2; }
  else if (cfg.tpMode === "trail_10_3") { trailAct = 10; trailDist = 3; }
  else if (cfg.tpMode === "rr2") { useFixedTP = true; }

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

      let xp = 0, isSL = false, reason = "";

      // 1) Exchange SL (every 5m bar)
      if (pos.dir === "long" && barL <= pos.sl) {
        xp = pos.sl; isSL = true; reason = "sl";
      } else if (pos.dir === "short" && barH >= pos.sl) {
        xp = pos.sl; isSL = true; reason = "sl";
      }

      // 2) Fixed TP (every 5m bar, only if rr2 mode)
      if (!xp && useFixedTP && pos.tp > 0) {
        if (pos.dir === "long" && barH >= pos.tp) { xp = pos.tp; reason = "tp"; }
        else if (pos.dir === "short" && barL <= pos.tp) { xp = pos.tp; reason = "tp"; }
      }

      // 3) Trail peak tracking (every 5m bar, but trail exit only at 1h)
      if (pos.dir === "long") {
        const best = (barH / pos.ep - 1) * pos.lev * 100;
        if (best > pos.pk) pos.pk = best;
      } else {
        const best = (1 - barL / pos.ep) * pos.lev * 100;
        if (best > pos.pk) pos.pk = best;
      }

      // 4) Trail exit (1h boundary only)
      if (!xp && isH1 && trailAct > 0 && pos.pk >= trailAct) {
        let curPct: number;
        if (pos.dir === "long") {
          curPct = (barC / pos.ep - 1) * pos.lev * 100;
        } else {
          curPct = (1 - barC / pos.ep) * pos.lev * 100;
        }
        if (curPct <= pos.pk - trailDist) { xp = barC; reason = "trail"; }
      }

      // 5) Max hold (1h boundary only)
      if (!xp && isH1 && (ts - pos.et) >= cfg.maxHoldH * H) {
        xp = barC; reason = "mh";
      }

      if (xp > 0) {
        const rsp = isSL ? pd.sp * 1.5 : pd.sp;
        let pnl: number;
        if (pos.dir === "long") {
          const ex = xp * (1 - rsp);
          pnl = (ex / pos.ep - 1) * pos.not - pos.not * FEE * 2;
        } else {
          const ex = xp * (1 + rsp);
          pnl = (1 - ex / pos.ep) * pos.not - pos.not * FEE * 2;
        }
        pnls.push(pnl);
        holdTimes.push(ts - pos.et);
        realizedPnl += pnl;
        hasOpen[pos.pairIdx] = 0;
        openPositions.splice(i, 1);
      }
    }

    // ─── MTM MDD (every 5m bar) ───
    if (openPositions.length > 0) {
      let unrealized = 0;
      for (let i = 0; i < openPositions.length; i++) {
        const pos = openPositions[i]!;
        const pd = pairs[pos.pairIdx]!;
        if (!pd.m5Valid[slot]) continue;
        if (pos.dir === "long") {
          const midExit = pd.m5C[slot]! * (1 - pd.sp);
          unrealized += (midExit / pos.ep - 1) * pos.not - pos.not * FEE * 2;
        } else {
          const midExit = pd.m5C[slot]! * (1 + pd.sp);
          unrealized += (1 - midExit / pos.ep) * pos.not - pos.not * FEE * 2;
        }
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

    // ─── ENTRY (1h boundaries only) ───
    if (!isH1) continue;

    for (let pi = 0; pi < pairs.length; pi++) {
      if (openPositions.length >= maxPos) break;
      if (hasOpen[pi]) continue;
      const pd = pairs[pi]!;
      const h1Idx = pd.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 55) continue; // need enough history for BB + squeeze

      // Signal based on completed bar (h1Idx - 1)
      const prev = h1Idx - 1;
      if (prev < 54) continue;
      if (pd.bbWidth[prev]! <= 0 || pd.bbMid[prev]! <= 0) continue;

      // ─── Squeeze Detection ───
      let squeezeActive = false;

      if (cfg.squeezeMode === "bb") {
        // BB Width squeeze: current width < squeezeThr * 50-bar rolling min
        let minWidth = Infinity;
        for (let j = Math.max(0, prev - 50); j < prev; j++) {
          if (pd.bbWidth[j]! > 0 && pd.bbWidth[j]! < minWidth) minWidth = pd.bbWidth[j]!;
        }
        if (minWidth < Infinity && pd.bbWidth[prev]! < cfg.squeezeThr * minWidth) {
          squeezeActive = true;
        }
      } else {
        // Keltner Channel squeeze: BB inside KC
        if (pd.kcUpper[prev]! > 0 && pd.kcLower[prev]! > 0) {
          if (pd.bbUpper[prev]! < pd.kcUpper[prev]! && pd.bbLower[prev]! > pd.kcLower[prev]!) {
            squeezeActive = true;
          }
        }
      }

      if (!squeezeActive) continue;

      // ─── Breakout Detection ───
      let dir: "long" | "short" | null = null;
      const prevClose = pd.h1[prev]!.c;

      if (cfg.squeezeMode === "bb") {
        // Close breaks above/below BB band
        if (prevClose > pd.bbUpper[prev]!) dir = "long";
        else if (prevClose < pd.bbLower[prev]!) dir = "short";
      } else {
        // BB breaks outside KC (expansion from squeeze)
        if (pd.bbUpper[prev]! > pd.kcUpper[prev]! && prevClose > pd.bbMid[prev]!) dir = "long";
        else if (pd.bbLower[prev]! < pd.kcLower[prev]! && prevClose < pd.bbMid[prev]!) dir = "short";
      }

      if (!dir) continue;
      if (cfg.longOnly && dir === "short") continue;

      // ─── Volume Filter ───
      if (cfg.volFilter > 1.0) {
        if (pd.h1VolAvg20[prev]! <= 0) continue;
        if (pd.h1Vol[prev]! < cfg.volFilter * pd.h1VolAvg20[prev]!) continue;
      }

      // ─── Entry ───
      const rawOpen = pd.h1[h1Idx]!.o;
      const ep = dir === "long"
        ? rawOpen * (1 + pd.sp)
        : rawOpen * (1 - pd.sp);
      const effNot = cfg.margin * pd.lev;

      // SL: fixed % from entry, capped at slPct
      const slDist = ep * (cfg.slPct / 100);
      let sl: number;
      if (dir === "long") {
        sl = ep - slDist;
      } else {
        sl = ep + slDist;
      }

      // TP: 2:1 R:R if fixed TP mode
      let tp = 0;
      if (useFixedTP) {
        if (dir === "long") tp = ep + 2 * slDist;
        else tp = ep - 2 * slDist;
      }

      openPositions.push({
        pairIdx: pi, dir, ep, rawEp: rawOpen, et: ts, sl, tp,
        pk: 0, lev: pd.lev, not: effNot,
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
      let pnl: number;
      if (pos.dir === "long") {
        const ex = lastC * (1 - pd.sp);
        pnl = (ex / pos.ep - 1) * pos.not - pos.not * FEE * 2;
      } else {
        const ex = lastC * (1 + pd.sp);
        pnl = (1 - ex / pos.ep) * pos.not - pos.not * FEE * 2;
      }
      pnls.push(pnl);
      holdTimes.push(OOS_E - pos.et);
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
  const avgHold = holdTimes.length > 0
    ? holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length / H
    : 0;

  return {
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    mtmMaxDD,
    pf, wr,
    numTrades: pnls.length,
    avgHold,
  };
}

// ───── Main ─────
console.log("Loading 5m data for all pairs...");
const t0 = Date.now();
const pairs: PairData[] = [];

for (const n of ALL) {
  const s = RM[n] ?? n;
  let raw = load(`${s}USDT`);
  if (raw.length < 5000) raw = load(`${n}USDT`);
  if (raw.length < 5000) continue;

  const h1 = aggregate(raw, H, 10);
  if (h1.length < 200) continue;

  const h1Map = new Map<number, number>();
  h1.forEach((c, i) => h1Map.set(c.t, i));
  const lev = getLev(n);

  // BB indicators (period=20 is max we test)
  const closes = h1.map(c => c.c);
  // We precompute BB for all 3 std devs; during sim we pick the right one
  // Actually the sweep tests bbStd as parameter, so we compute at runtime
  // For speed, precompute BB(20, 2.0) as default and KC
  // But sweep needs different bbStd... we precompute all 3 variants
  const bb15 = computeBB(closes, 20, 1.5);
  const bb20 = computeBB(closes, 20, 2.0);
  const bb25 = computeBB(closes, 20, 2.5);
  const kc = computeKC(h1, 20, 1.5);

  const { vol, avg20 } = computeVolProxy(h1);

  // 5m slot arrays
  const m5H = new Float64Array(NUM_SLOTS);
  const m5L = new Float64Array(NUM_SLOTS);
  const m5C = new Float64Array(NUM_SLOTS);
  const m5Valid = new Uint8Array(NUM_SLOTS);

  for (const b of raw) {
    if (b.t < OOS_S || b.t >= OOS_E) continue;
    const slot = Math.round((b.t - OOS_S) / M5);
    if (slot >= 0 && slot < NUM_SLOTS) {
      m5H[slot] = b.h;
      m5L[slot] = b.l;
      m5C[slot] = b.c;
      m5Valid[slot] = 1;
    }
  }

  // Store all BB variants - we'll select at sim time via index
  // Pack into a single object with tag for which std to use
  const pairData: PairData & {
    bb15: ReturnType<typeof computeBB>;
    bb20: ReturnType<typeof computeBB>;
    bb25: ReturnType<typeof computeBB>;
  } = {
    name: n, sp: SP[n] ?? DSP, lev,
    h1, h1Map,
    bbMid: bb20.mid,
    bbUpper: bb20.upper,
    bbLower: bb20.lower,
    bbWidth: bb20.width,
    kcUpper: kc.upper,
    kcLower: kc.lower,
    h1Vol: vol,
    h1VolAvg20: avg20,
    m5H, m5L, m5C, m5Valid,
    bb15, bb20, bb25,
  };

  (pairs as any[]).push(pairData);
}

console.log(`${pairs.length} pairs loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

// Helper to swap BB variant on all pairs before a sim run
function setBBVariant(bbStd: number): void {
  for (const pd of pairs as any[]) {
    const key = bbStd === 1.5 ? "bb15" : bbStd === 2.5 ? "bb25" : "bb20";
    const bb = pd[key];
    pd.bbMid = bb.mid;
    pd.bbUpper = bb.upper;
    pd.bbLower = bb.lower;
    pd.bbWidth = bb.width;
  }
}

// ───── Config Sweep ─────
const configs: Cfg[] = [];

const BB_STDS: number[] = [1.5, 2.0, 2.5];
const SQUEEZE_THRS: number[] = [1.0, 1.2, 1.5];
const VOL_FILTERS: number[] = [1.0, 1.5, 2.0];
const SL_PCTS: number[] = [0.5, 1.0, 1.5];
const TP_MODES: TpMode[] = ["rr2", "trail_3_1", "trail_5_2", "trail_10_3"];
const MAX_HOLDS: number[] = [12, 24, 48];
const MARGINS: number[] = [5, 7, 10, 15];
const DIRECTIONS: Array<{ longOnly: boolean; label: string }> = [
  { longOnly: false, label: "both" },
  { longOnly: true, label: "long" },
];
const SQUEEZE_MODES: SqueezeMode[] = ["bb", "kc"];

// Build sweep configs -- target ~300
// To keep it manageable, we do a structured sweep:
// BB squeeze mode with all parameter combos
for (const sm of SQUEEZE_MODES) {
  for (const bbStd of BB_STDS) {
    // KC mode ignores bbStd for squeeze detection but uses it for BB bands
    for (const sqThr of sm === "kc" ? [1.0] : SQUEEZE_THRS) {
      for (const volF of VOL_FILTERS) {
        for (const slPct of SL_PCTS) {
          for (const tpMode of TP_MODES) {
            for (const maxH of MAX_HOLDS) {
              for (const margin of MARGINS) {
                for (const d of DIRECTIONS) {
                  configs.push({
                    label: `${sm} bb${bbStd} sq${sqThr} v${volF} sl${slPct} ${tpMode} ${maxH}h $${margin} ${d.label}`,
                    bbPeriod: 20,
                    bbStd,
                    squeezeThr: sqThr,
                    volFilter: volF,
                    slPct,
                    tpMode,
                    maxHoldH: maxH,
                    margin,
                    longOnly: d.longOnly,
                    squeezeMode: sm,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
}

console.log(`Total configs: ${configs.length}`);

// ─── Reduce to ~300 by sampling ───
// The full sweep above produces ~5000+ configs. We prune to ~300 by fixing some dimensions.
// Strategy: test most important levers with full range, fix others at reasonable defaults.
const prunedConfigs: Cfg[] = [];

// Tier 1: Core BB sweep (bb mode, both+long, all SL, all TP, margin=[5,10], maxH=[24,48], bbStd=[1.5,2.0,2.5], sqThr=[1.0,1.2,1.5], vol=1.5)
for (const bbStd of BB_STDS) {
  for (const sqThr of SQUEEZE_THRS) {
    for (const slPct of SL_PCTS) {
      for (const tpMode of TP_MODES) {
        for (const maxH of [24, 48]) {
          for (const margin of [5, 10]) {
            for (const d of DIRECTIONS) {
              prunedConfigs.push({
                label: `bb${bbStd} sq${sqThr} sl${slPct} ${tpMode} ${maxH}h $${margin} ${d.label}`,
                bbPeriod: 20, bbStd, squeezeThr: sqThr, volFilter: 1.5,
                slPct, tpMode, maxHoldH: maxH, margin, longOnly: d.longOnly,
                squeezeMode: "bb",
              });
            }
          }
        }
      }
    }
  }
}

// Tier 2: Volume filter sweep (best-guess BB params, vary volume)
for (const volF of VOL_FILTERS) {
  for (const d of DIRECTIONS) {
    for (const tpMode of TP_MODES) {
      prunedConfigs.push({
        label: `bb2.0 sq1.2 v${volF} sl1.0 ${tpMode} 24h $7 ${d.label}`,
        bbPeriod: 20, bbStd: 2.0, squeezeThr: 1.2, volFilter: volF,
        slPct: 1.0, tpMode, maxHoldH: 24, margin: 7, longOnly: d.longOnly,
        squeezeMode: "bb",
      });
    }
  }
}

// Tier 3: Margin sweep
for (const margin of MARGINS) {
  for (const d of DIRECTIONS) {
    prunedConfigs.push({
      label: `bb2.0 sq1.2 sl1.0 trail_5_2 24h $${margin} ${d.label}`,
      bbPeriod: 20, bbStd: 2.0, squeezeThr: 1.2, volFilter: 1.5,
      slPct: 1.0, tpMode: "trail_5_2", maxHoldH: 24, margin, longOnly: d.longOnly,
      squeezeMode: "bb",
    });
  }
}

// Tier 4: KC squeeze variant
for (const bbStd of BB_STDS) {
  for (const slPct of SL_PCTS) {
    for (const tpMode of TP_MODES) {
      for (const maxH of [24, 48]) {
        for (const d of DIRECTIONS) {
          prunedConfigs.push({
            label: `kc bb${bbStd} sl${slPct} ${tpMode} ${maxH}h $7 ${d.label}`,
            bbPeriod: 20, bbStd, squeezeThr: 1.0, volFilter: 1.5,
            slPct, tpMode, maxHoldH: maxH, margin: 7, longOnly: d.longOnly,
            squeezeMode: "kc",
          });
        }
      }
    }
  }
}

// Tier 5: 12h max hold combos
for (const tpMode of TP_MODES) {
  for (const slPct of SL_PCTS) {
    for (const d of DIRECTIONS) {
      prunedConfigs.push({
        label: `bb2.0 sq1.2 sl${slPct} ${tpMode} 12h $7 ${d.label}`,
        bbPeriod: 20, bbStd: 2.0, squeezeThr: 1.2, volFilter: 1.5,
        slPct, tpMode, maxHoldH: 12, margin: 7, longOnly: d.longOnly,
        squeezeMode: "bb",
      });
    }
  }
}

// Deduplicate by label
const seen = new Set<string>();
const finalConfigs: Cfg[] = [];
for (const c of prunedConfigs) {
  if (!seen.has(c.label)) {
    seen.add(c.label);
    finalConfigs.push(c);
  }
}

console.log(`Pruned to ${finalConfigs.length} unique configs. Running...`);

// ───── Run Sweep ─────
interface Row {
  label: string;
  dpd: number;
  mtm: number;
  pf: number;
  wr: number;
  n: number;
  total: number;
  avgHold: number;
}

const results: Row[] = [];
let tested = 0;
const t1 = Date.now();

// Group configs by bbStd to minimize BB swaps
const byStd = new Map<number, Cfg[]>();
for (const c of finalConfigs) {
  const arr = byStd.get(c.bbStd) ?? [];
  arr.push(c);
  byStd.set(c.bbStd, arr);
}

const MAX_POS_OPTIONS = [10]; // fixed max concurrent for simplicity in sweep

for (const [bbStd, cfgGroup] of byStd) {
  setBBVariant(bbStd);

  for (const cfg of cfgGroup) {
    const r = simulate(pairs, cfg, 10, 50); // maxPos=10, mddAbort=$50
    results.push({
      label: cfg.label,
      dpd: r.dollarsPerDay,
      mtm: r.mtmMaxDD,
      pf: r.pf,
      wr: r.wr,
      n: r.numTrades,
      total: r.totalPnl,
      avgHold: r.avgHold,
    });
    tested++;
    if (tested % 50 === 0) {
      const elapsed = (Date.now() - t1) / 1000;
      const eta = (elapsed / tested) * (finalConfigs.length - tested);
      process.stdout.write(`\r  ${tested}/${finalConfigs.length} (${elapsed.toFixed(0)}s, ETA ${eta.toFixed(0)}s)`);
    }
  }
}

const elapsed = (Date.now() - t1) / 1000;
console.log(`\n\nDone. ${tested} configs in ${elapsed.toFixed(1)}s.\n`);

// ───── Output ─────
// Filter MDD < $20, sort by $/day desc, show top 50
const filtered = results
  .filter(r => r.mtm < 20 && r.n >= 10)
  .sort((a, b) => b.dpd - a.dpd)
  .slice(0, 50);

console.log("=".repeat(130));
console.log("TOP 50 CONFIGS (MTM MDD < $20, min 10 trades)");
console.log("=".repeat(130));

const hdr = [
  "#".padStart(3),
  "Config".padEnd(55),
  "Trades".padStart(7),
  "WR%".padStart(6),
  "PF".padStart(6),
  "Total".padStart(9),
  "$/day".padStart(8),
  "MtmDD".padStart(7),
  "AvgH".padStart(6),
].join(" ");
console.log(hdr);
console.log("-".repeat(130));

for (let i = 0; i < filtered.length; i++) {
  const r = filtered[i]!;
  const row = [
    String(i + 1).padStart(3),
    r.label.padEnd(55),
    String(r.n).padStart(7),
    (r.wr.toFixed(1) + "%").padStart(6),
    r.pf.toFixed(2).padStart(6),
    ("$" + r.total.toFixed(1)).padStart(9),
    ("$" + r.dpd.toFixed(3)).padStart(8),
    ("$" + r.mtm.toFixed(1)).padStart(7),
    (r.avgHold.toFixed(1) + "h").padStart(6),
  ].join(" ");
  console.log(row);
}

if (filtered.length === 0) {
  console.log("No configs found with MTM MDD < $20 and >= 10 trades.");
  console.log("\nRelaxing to MDD < $40:");
  const relaxed = results
    .filter(r => r.mtm < 40 && r.n >= 10)
    .sort((a, b) => b.dpd - a.dpd)
    .slice(0, 50);
  console.log(hdr);
  console.log("-".repeat(130));
  for (let i = 0; i < relaxed.length; i++) {
    const r = relaxed[i]!;
    const row = [
      String(i + 1).padStart(3),
      r.label.padEnd(55),
      String(r.n).padStart(7),
      (r.wr.toFixed(1) + "%").padStart(6),
      r.pf.toFixed(2).padStart(6),
      ("$" + r.total.toFixed(1)).padStart(9),
      ("$" + r.dpd.toFixed(3)).padStart(8),
      ("$" + r.mtm.toFixed(1)).padStart(7),
      (r.avgHold.toFixed(1) + "h").padStart(6),
    ].join(" ");
    console.log(row);
  }
}

// Summary stats
console.log("\n--- Summary ---");
const profitable = results.filter(r => r.dpd > 0);
const sub20 = results.filter(r => r.mtm < 20 && r.n >= 10);
console.log(`Total configs tested: ${tested}`);
console.log(`Profitable: ${profitable.length} (${(profitable.length / tested * 100).toFixed(1)}%)`);
console.log(`MDD < $20 with 10+ trades: ${sub20.length}`);
if (filtered.length > 0) {
  console.log(`Best $/day (MDD<$20): $${filtered[0]!.dpd.toFixed(3)} [${filtered[0]!.label}]`);
}
const best = results.sort((a, b) => b.dpd - a.dpd)[0];
if (best) {
  console.log(`Best $/day overall: $${best.dpd.toFixed(3)} [${best.label}] MDD=$${best.mtm.toFixed(1)}`);
}
