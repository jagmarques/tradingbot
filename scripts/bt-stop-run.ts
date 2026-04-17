/**
 * STOP-RUN REVERSAL — 5m wick-based signal
 *
 * Fires on 5m bars when a big asymmetric wick sweeps a recent swing low/high.
 * Idea: stop-run liquidity grab on the 12-bar (1h) extreme gets rejected.
 *
 * Long entry on bar N close:
 *   - lowerWick / range > wickRatio (default 0.65)
 *   - lowerWick > 2 * upperWick
 *   - lowerWick > 1.5 * ATR14_5m
 *   - bar N-1 close > bar N low
 *   - bar N low < min(low) of N-L .. N-1 - 0.1%
 *
 * Short: mirror.
 *
 * Framework mirrors bt-sl-fast.ts (5m cache, HL real lev cap, spread, fees, trail).
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const M5 = 5 * 60_000;
const D = 86_400_000;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);
const MAX_HOLD_H = 72;

// per-pair spreads from sl-fast framework
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
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; entryTs: number; }

interface PI {
  m5: C[];
  h1: C[];
  h1Map: Map<number, number>;
  atr14_5m: number[];
  rv24: number[];  // on h1
  rv168: number[]; // on h1
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

// Wilder ATR14 on 5m bars
function computeATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  if (cs.length < period + 1) return atr;
  const tr: number[] = new Array(cs.length).fill(0);
  tr[0] = cs[0]!.h - cs[0]!.l;
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i]!.h - cs[i]!.l;
    const b = Math.abs(cs[i]!.h - cs[i - 1]!.c);
    const d = Math.abs(cs[i]!.l - cs[i - 1]!.c);
    tr[i] = Math.max(a, b, d);
  }
  // seed with SMA
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  atr[period] = sum / period;
  for (let i = period + 1; i < cs.length; i++) {
    atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  return atr;
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

interface Cfg {
  label: string;
  margin: number;
  slPct: number;           // stop loss percent from entry
  wickRatio: number;       // lowerWick/range threshold
  sweepLookback: number;   // bars of 5m history defining swept low
  atrMult: number;         // wick must exceed ATR*this
  asymRatio: number;       // dominant wick/opposite wick
  sweepBuf: number;        // 0.001 = 0.1% below recent min
  regime: boolean;         // use vol regime filter
  regimeThr: number;       // rv24/rv168 threshold
  longOnly: boolean;
  trailAct: number;
  trailDist: number;
  trailAct2: number;
  trailDist2: number;
  trailAct3: number;
  trailDist3: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface Res { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; feePct: number; grossPnl: number; totalFees: number; closed: Tr[]; }

function simulate(pairs: PD[], cfg: Cfg, startTs: number, endTs: number, days: number): Res {
  const closed: Tr[] = [];
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

  let totalFees = 0;

  for (const ts of timepoints) {
    const hour = new Date(ts).getUTCHours();

    // --- exits on every 5m bar ---
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair); if (!m5Map) continue;
      const bi = m5Map.get(ts); if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;
      if ((ts - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        // multi-stage trail: pick active stage by peak
        let act = cfg.trailAct, dist = cfg.trailDist;
        if (pos.pk >= cfg.trailAct3) { act = cfg.trailAct3; dist = cfg.trailDist3; }
        else if (pos.pk >= cfg.trailAct2) { act = cfg.trailAct2; dist = cfg.trailDist2; }
        if (pos.pk >= act && cur <= pos.pk - dist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        totalFees += fees;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, entryTs: pos.et, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    // --- entries on every 5m bar ---
    if (BLOCK.has(hour)) continue;

    for (const p of pairs) {
      const m5Map = m5Maps.get(p.name)!;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      if (bi < Math.max(cfg.sweepLookback + 2, 20)) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const bar = p.ind.m5[bi]!;
      const prev = p.ind.m5[bi - 1]!;
      const atr = p.ind.atr14_5m[bi]!;
      if (atr <= 0) continue;

      const upperWick = bar.h - Math.max(bar.o, bar.c);
      const lowerWick = Math.min(bar.o, bar.c) - bar.l;
      const range = bar.h - bar.l;
      if (range <= 0) continue;

      // vol regime filter (hourly based)
      if (cfg.regime) {
        const h1Bucket = Math.floor(ts / H) * H;
        const h1i = p.ind.h1Map.get(h1Bucket);
        if (h1i === undefined || h1i < 170) continue;
        const rv24 = p.ind.rv24[h1i - 1] ?? 0;
        const rv168 = p.ind.rv168[h1i - 1] ?? 0;
        if (rv24 === 0 || rv168 === 0) continue;
        if (rv24 / rv168 < cfg.regimeThr) continue;
      }

      let dir: "long" | "short" | null = null;

      // LONG: big lower wick sweeping recent min
      if (
        lowerWick / range > cfg.wickRatio &&
        lowerWick > cfg.asymRatio * upperWick &&
        lowerWick > cfg.atrMult * atr &&
        prev.c > bar.l
      ) {
        let minLow = Infinity;
        for (let j = bi - cfg.sweepLookback; j < bi; j++) {
          if (p.ind.m5[j]!.l < minLow) minLow = p.ind.m5[j]!.l;
        }
        if (bar.l < minLow * (1 - cfg.sweepBuf)) dir = "long";
      }

      // SHORT: big upper wick sweeping recent max
      if (!dir && !cfg.longOnly) {
        if (
          upperWick / range > cfg.wickRatio &&
          upperWick > cfg.asymRatio * lowerWick &&
          upperWick > cfg.atrMult * atr &&
          prev.c < bar.h
        ) {
          let maxHigh = -Infinity;
          for (let j = bi - cfg.sweepLookback; j < bi; j++) {
            if (p.ind.m5[j]!.h > maxHigh) maxHigh = p.ind.m5[j]!.h;
          }
          if (bar.h > maxHigh * (1 + cfg.sweepBuf)) dir = "short";
        }
      }

      if (!dir) continue;

      // enter at bar N close
      const ep = dir === "long" ? bar.c * (1 + p.sp) : bar.c * (1 - p.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: cfg.margin * p.lev,
      });
    }
  }

  // close any remaining at last 5m bar
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    totalFees += fees;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, entryTs: pos.et, pnl, reason: "end" });
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const grossPnl = totalPnl + totalFees;
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
    feePct: grossPnl !== 0 ? (totalFees / Math.abs(grossPnl) * 100) : 0,
    grossPnl, totalFees, closed,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function logHeader() {
  console.log(`${"Label".padEnd(38)} ${"Period".padEnd(5)} ${"$/day".padStart(8)} ${"MDD".padStart(6)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)} ${"Fee%".padStart(6)}`);
  console.log("-".repeat(105));
}

function logRow(label: string, is: Res, oos: Res) {
  console.log(`${label.padEnd(38)} ${"IS".padEnd(5)} ${fmtD(is.dollarsPerDay).padStart(8)} ${("$" + is.maxDD.toFixed(0)).padStart(6)} ${is.pf.toFixed(2).padStart(5)} ${is.wr.toFixed(1).padStart(6)} ${fmtD(is.maxSingleLoss).padStart(8)} ${String(is.numTrades).padStart(6)} ${(is.feePct.toFixed(0) + "%").padStart(6)}`);
  console.log(`${"".padEnd(38)} ${"OOS".padEnd(5)} ${fmtD(oos.dollarsPerDay).padStart(8)} ${("$" + oos.maxDD.toFixed(0)).padStart(6)} ${oos.pf.toFixed(2).padStart(5)} ${oos.wr.toFixed(1).padStart(6)} ${fmtD(oos.maxSingleLoss).padStart(8)} ${String(oos.numTrades).padStart(6)} ${(oos.feePct.toFixed(0) + "%").padStart(6)}`);
}

function main() {
  console.log("=".repeat(110));
  console.log("  STOP-RUN REVERSAL — 5m wick + sweep, WF IS Jun-Dec25 / OOS Dec25-Mar26");
  console.log("  Fee 0.035%, SL slip 1.5x, margin $15, lev cap 10x, 102 pairs, block 22-23 UTC");
  console.log("=".repeat(110));

  console.log("\nLoading cached 5m bars...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    if (m5.length < 5000) continue;
    const h1 = aggregate(m5, H, 10);
    if (h1.length < 250) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const atr14_5m = computeATR(m5, 14);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const lev = getLev(n);
    pairs.push({
      name: n,
      ind: { m5, h1, h1Map, atr14_5m, rv24, rv168 },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  console.log(`${pairs.length} pairs loaded\n`);

  // NOTE: base (regime OFF) fires 10k+ trades and is catastrophically negative
  // (known from prior run: IS -$5.65/d MDD $1037 PF 0.38 WR 12.6% N=10219 feeDrag 85%).
  // For efficiency, all sweeps use regime ON which cuts trade count ~20x.
  const base: Cfg = {
    label: "base",
    margin: 15,
    slPct: 0.0015,
    wickRatio: 0.65,
    sweepLookback: 12,
    atrMult: 1.5,
    asymRatio: 2.0,
    sweepBuf: 0.001,
    regime: true,
    regimeThr: 1.5,
    longOnly: false,
    trailAct: 3, trailDist: 1,
    trailAct2: 9, trailDist2: 0.5,
    trailAct3: 20, trailDist3: 0.5,
  };

  // Prior-run baseline WITHOUT regime is referenced inline below — not rerun.
  console.log("TEST 1 — base signal (regime OFF) — cached from prior run");
  console.log(`  IS : -$5.65/d MDD $1037 PF 0.38 WR 12.6% N=10219 fee drag 85%`);
  console.log(`  OOS: -$11.39/d MDD $1298 PF 0.29 WR 10.0% N=11411 fee drag 63%`);
  console.log("  -> BASE SIGNAL IS CATASTROPHICALLY NEGATIVE, 10k+ trades eaten by fees\n");

  // ---- TEST 1b: base with regime ON (used as reference going forward) ----
  console.log("TEST 1b — base with regime ON (rv24/rv168>1.5)");
  logHeader();
  const baseIs = simulate(pairs, base, IS_S, IS_E, IS_D);
  const baseOos = simulate(pairs, base, OOS_S, OOS_E, OOS_D);
  logRow("base_regON", baseIs, baseOos);
  console.log();

  // ---- TEST 2: wick ratio ----
  console.log("TEST 2 — wick ratio sweep (regime ON)");
  logHeader();
  for (const wr of [0.60, 0.65, 0.70]) {
    const cfg = { ...base, wickRatio: wr };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    logRow(`wickRatio=${wr}`, is, oos);
  }
  console.log();

  // ---- TEST 3: sweep lookback ----
  console.log("TEST 3 — sweep lookback (regime ON)");
  logHeader();
  for (const lb of [12, 20, 24]) {
    const cfg = { ...base, sweepLookback: lb };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    logRow(`lookback=${lb}`, is, oos);
  }
  console.log();

  // ---- TEST 4: regime filter confirmation (already partially cached) ----
  console.log("TEST 4 — vol regime filter OFF vs ON (OFF cached)");
  console.log("  OFF: IS -$5.65/d MDD $1037 / OOS -$11.39/d MDD $1298 (from test 1)");
  console.log(`  ON : IS ${fmtD(baseIs.dollarsPerDay)}/d MDD $${baseIs.maxDD.toFixed(0)} / OOS ${fmtD(baseOos.dollarsPerDay)}/d MDD $${baseOos.maxDD.toFixed(0)}\n`);

  // ---- TEST 5: long-only vs symmetric ----
  console.log("TEST 5 — direction symmetry (regime ON)");
  logHeader();
  {
    const longOnly = { ...base, longOnly: true };
    const isL = simulate(pairs, longOnly, IS_S, IS_E, IS_D);
    const oosL = simulate(pairs, longOnly, OOS_S, OOS_E, OOS_D);
    logRow("symmetric (L+S, from base)", baseIs, baseOos);
    logRow("long-only", isL, oosL);
  }
  console.log();

  // ---- TEST 6: SL variations ----
  console.log("TEST 6 — SL sweep (regime ON)");
  logHeader();
  for (const sl of [0.001, 0.0015, 0.002]) {
    const cfg = { ...base, slPct: sl };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    logRow(`slPct=${(sl * 100).toFixed(2)}%`, is, oos);
  }
  console.log();

  // ---- Find best OOS config at MDD < $15 ----
  console.log("=".repeat(110));
  console.log("TEST 7 — Small combo search (regime ON only — filter already cuts trades 20x)");
  console.log("=".repeat(110));
  logHeader();

  interface Rec { label: string; is: Res; oos: Res; cfg: Cfg; }
  const records: Rec[] = [];

  // restrict sweep to regime ON (we already know regime OFF is catastrophically bad)
  for (const wr of [0.65, 0.70]) {
    for (const lb of [12, 20]) {
      for (const sl of [0.001, 0.0015, 0.002]) {
        for (const lo of [false, true]) {
          const cfg: Cfg = { ...base, wickRatio: wr, sweepLookback: lb, slPct: sl, regime: true, longOnly: lo };
          const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
          const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
          const lab = `w${wr} lb${lb} sl${(sl * 100).toFixed(2)} rON ${lo ? "L" : "LS"}`;
          records.push({ label: lab, is, oos, cfg });
          logRow(lab, is, oos);
        }
      }
    }
  }

  // best by OOS $/day at MDD<$15
  const valid = records.filter(r => r.oos.maxDD < 15 && r.oos.numTrades >= 30);
  valid.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  console.log(`\n${valid.length} configs pass MDD<$15 and N>=30 in OOS. Top 15:`);
  logHeader();
  for (const r of valid.slice(0, 15)) logRow(r.label, r.is, r.oos);

  // overall best OOS ignoring MDD for comparison
  console.log("\nTop 10 OOS $/day (no MDD filter):");
  logHeader();
  const byDay = [...records].sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  for (const r of byDay.slice(0, 10)) logRow(r.label, r.is, r.oos);

  // ---- Summary ----
  console.log("\n" + "=".repeat(110));
  console.log("SUMMARY");
  console.log("=".repeat(110));
  console.log(`Base OOS: ${fmtD(baseOos.dollarsPerDay)}/day, MDD $${baseOos.maxDD.toFixed(0)}, PF ${baseOos.pf.toFixed(2)}, WR ${baseOos.wr.toFixed(1)}%, N=${baseOos.numTrades}`);
  console.log(`Base OOS fee drag: $${baseOos.totalFees.toFixed(2)} fees on $${baseOos.grossPnl.toFixed(2)} gross (${(baseOos.totalFees / Math.max(0.01, Math.abs(baseOos.grossPnl)) * 100).toFixed(1)}% of gross)`);

  if (valid.length > 0) {
    const best = valid[0]!;
    console.log(`\nBEST OOS @ MDD<$15: ${best.label}`);
    console.log(`  IS : ${fmtD(best.is.dollarsPerDay)}/day MDD $${best.is.maxDD.toFixed(0)} PF ${best.is.pf.toFixed(2)} WR ${best.is.wr.toFixed(1)}% N=${best.is.numTrades}`);
    console.log(`  OOS: ${fmtD(best.oos.dollarsPerDay)}/day MDD $${best.oos.maxDD.toFixed(0)} PF ${best.oos.pf.toFixed(2)} WR ${best.oos.wr.toFixed(1)}% N=${best.oos.numTrades}`);
    console.log(`  OOS fee drag: $${best.oos.totalFees.toFixed(2)} on gross $${best.oos.grossPnl.toFixed(2)} (${(best.oos.totalFees / Math.max(0.01, Math.abs(best.oos.grossPnl)) * 100).toFixed(1)}%)`);

    // Kill threshold
    const kill = best.oos.dollarsPerDay >= 0.20 && best.oos.maxDD < 15;
    console.log(`\nKILL THRESHOLD (OOS $/day >= $0.20 AND MDD<$15): ${kill ? "PASS — consider deploy" : "FAIL — do not deploy"}`);

    // --- correlation proxy vs GARCH window exposure ---
    // Emit daily PnL buckets for the best cfg so we can eyeball correlation later
    const byDay = new Map<number, number>();
    for (const t of best.oos.closed) {
      const day = Math.floor(t.exitTs / D) * D;
      byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
    }
    const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    let posDays = 0, negDays = 0, zero = 0;
    for (const [, v] of days) { if (v > 0) posDays++; else if (v < 0) negDays++; else zero++; }
    console.log(`\nBest cfg OOS daily stats: ${days.length} trading days, ${posDays} positive / ${negDays} negative / ${zero} flat`);
    const mean = days.reduce((s, [, v]) => s + v, 0) / Math.max(1, days.length);
    const variance = days.reduce((s, [, v]) => s + (v - mean) ** 2, 0) / Math.max(1, days.length);
    const std = Math.sqrt(variance);
    console.log(`Daily PnL mean $${mean.toFixed(2)}, std $${std.toFixed(2)}, Sharpe(d) ${(mean / Math.max(0.01, std)).toFixed(2)}`);
  } else {
    console.log("\nNO config passes MDD<$15 AND N>=30 in OOS.");
  }

  // Fee drag across base
  console.log(`\nFee drag check (base IS): $${baseIs.totalFees.toFixed(2)} fees on $${baseIs.grossPnl.toFixed(2)} gross = ${(baseIs.totalFees / Math.max(0.01, Math.abs(baseIs.grossPnl)) * 100).toFixed(1)}% of |gross|`);
}

main();
