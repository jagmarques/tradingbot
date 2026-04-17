/**
 * SL STRESS TEST — Wider SL widths × slippage multipliers on deployed 2-engine portfolio
 *
 * Question: Is SL 0.15% too tight? Does small noise kill it under realistic slippage?
 *
 * Deployed baseline:
 *   Engine A — GARCH long-only loose: z1h>2.0 AND z4h>1.5, LONGS ONLY
 *   Engine B — Range Expansion: 1h range >= 2.0*ATR, close in extreme 25%
 *   Both: SL 0.15% exchange, multi-stage trail 3/1 -> 9/0.5 -> 20/0.5, $15 margin
 *   Regime ON (rv24/rv168 >= 1.5), block h22-23, max hold A=72h B=12h
 *
 * GRID:
 *   SL widths: 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.70, 1.00 (%)
 *   SL_SLIP multipliers: 1.5x, 2.5x, 4.0x, 6.0x
 *   Trail fixed: multi-stage 3/1 -> 9/0.5 -> 20/0.5
 *   Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03
 *
 * Slippage only affects SL exits. We record each SL-hit's "clean" price and original spread,
 * so we can compute P&L at any slip multiplier without re-simulating.
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

const SL_WIDTHS = [0.0015, 0.0020, 0.0025, 0.0030, 0.0040, 0.0050, 0.0070, 0.0100];
const SLIP_MULTS = [1.5, 2.5, 4.0, 6.0];

// Multi-stage trail: 3/1 -> 9/0.5 -> 20/0.5 (act%, dist%)
const TRAIL_STAGES = [
  { act: 3, dist: 1.0 },
  { act: 9, dist: 0.5 },
  { act: 20, dist: 0.5 },
];

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[]; rv168: number[];
  atr1: number[];
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

type Engine = "A" | "B";

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
}

// Stored per-trade — we keep xp (clean exit price) and sp separately
// so we can recompute P&L at any slip multiplier when reason == "sl"
interface Tr {
  engine: Engine;
  pair: string;
  dir: "long" | "short";
  ep: number;
  xp: number;         // clean exit price (sl level, bar close, or last close)
  sp: number;         // per-pair base spread
  lev: number;
  not: number;
  reason: "sl" | "trail" | "maxh" | "end";
  exitTs: number;
}

function pnlAtSlip(t: Tr, slipMult: number): number {
  const rsp = t.reason === "sl" ? t.sp * slipMult : t.sp;
  const ex = t.dir === "long" ? t.xp * (1 - rsp) : t.xp * (1 + rsp);
  const fees = t.not * FEE * 2;
  return (t.dir === "long" ? (ex / t.ep - 1) : (t.ep / ex - 1)) * t.not - fees;
}

interface SimCfg {
  slPct: number;
  marginA: number;
  marginB: number;
  aMaxHoldH: number;
  bMaxHoldH: number;
  aZL1: number; aZL4: number;
  aRegime: boolean; aRegimeThr: number;
  bRegime: boolean; bRegimeThr: number;
  regimeThr: number;
}

function simulate(pairs: PD[], cfg: SimCfg, startTs: number, endTs: number): Tr[] {
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

  const notA = (lev: number) => cfg.marginA * lev;
  const notB = (lev: number) => cfg.marginB * lev;

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

      let xp = 0;
      let reason: "sl" | "trail" | "maxh" | "end" = "sl";

      if ((ts - pos.et) / H >= pos.maxHoldH) {
        xp = bar.c; reason = "maxh";
      }
      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = "sl"; }
      }

      // Peak tracking (leveraged %)
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp) {
        // Multi-stage trail: pick the highest-act stage that has been reached
        let activeDist = 0;
        let activeAct = -1;
        for (const st of TRAIL_STAGES) {
          if (pos.pk >= st.act && st.act > activeAct) {
            activeAct = st.act;
            activeDist = st.dist;
          }
        }
        if (activeAct >= 0) {
          const cur = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * pos.lev * 100
            : (pos.ep / bar.c - 1) * pos.lev * 100;
          if (cur <= pos.pk - activeDist) {
            xp = bar.c; reason = "trail";
          }
        }
      }

      if (xp > 0) {
        closed.push({
          engine: pos.engine, pair: pos.pair, dir: pos.dir,
          ep: pos.ep, xp, sp: pos.sp, lev: pos.lev, not: pos.not,
          reason, exitTs: ts,
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

      // Engine A — GARCH long-only loose
      if (cfg.marginA > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "A")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        if (z1 > cfg.aZL1 && z4 > cfg.aZL4) {
          let ok = true;
          if (cfg.aRegime) {
            const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
            const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
            if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.aRegimeThr) ok = false;
          }
          if (ok) {
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            openPositions.push({
              engine: "A", pair: p.name, dir: "long", ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notA(p.lev), maxHoldH: cfg.aMaxHoldH,
            });
          }
        }
      }

      // Engine B — Range Expansion
      if (cfg.marginB > 0 && !openPositions.some(o => o.pair === p.name && o.engine === "B")) {
        const sig = p.ind.rexSig20[h1Idx - 1] ?? 0;
        if (sig !== 0) {
          let ok = true;
          if (cfg.bRegime) {
            const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
            const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
            if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.bRegimeThr) ok = false;
          }
          if (ok) {
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

  // Close still-open at end (treat as "end" exit, no slip mult)
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    closed.push({
      engine: pos.engine, pair: pos.pair, dir: pos.dir,
      ep: pos.ep, xp: lb.c, sp: pos.sp, lev: pos.lev, not: pos.not,
      reason: "end", exitTs: lb.t,
    });
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);
  return closed;
}

interface Stats {
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  maxLoss: number;
  numTrades: number;
  slHits: number;
  slPnl: number;
  trailHits: number;
  trailPnl: number;
  maxhHits: number;
  maxhPnl: number;
  fees: number;
  grossProfit: number;
  feeDragPct: number;
  aTrades: number; aPnl: number;
  bTrades: number; bPnl: number;
}

function statsAtSlip(trades: Tr[], slip: number, days: number): Stats {
  const pnls = trades.map(t => pnlAtSlip(t, slip));
  let tot = 0, slHits = 0, slPnl = 0, trailHits = 0, trailPnl = 0, maxhHits = 0, maxhPnl = 0;
  let fees = 0, grossProfit = 0;
  let aT = 0, aP = 0, bT = 0, bP = 0;
  let wins = 0;
  let maxLoss = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;
    const p = pnls[i]!;
    tot += p;
    fees += t.not * FEE * 2;
    if (p > 0) { wins++; grossProfit += p; }
    if (p < maxLoss) maxLoss = p;
    if (t.reason === "sl") { slHits++; slPnl += p; }
    else if (t.reason === "trail") { trailHits++; trailPnl += p; }
    else if (t.reason === "maxh") { maxhHits++; maxhPnl += p; }
    if (t.engine === "A") { aT++; aP += p; } else { bT++; bP += p; }
  }
  const losses = pnls.filter(v => v <= 0);
  const winsArr = pnls.filter(v => v > 0);
  const gp = winsArr.reduce((s, v) => s + v, 0);
  const glAbs = Math.abs(losses.reduce((s, v) => s + v, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;
  let cum = 0, peak = 0, mdd = 0;
  const sorted = trades
    .map((t, i) => ({ ts: t.exitTs, p: pnls[i]! }))
    .sort((a, b) => a.ts - b.ts);
  for (const { p } of sorted) {
    cum += p;
    if (cum > peak) peak = cum;
    if (peak - cum > mdd) mdd = peak - cum;
  }
  return {
    totalPnl: tot,
    dollarsPerDay: tot / days,
    maxDD: mdd,
    pf,
    wr: trades.length > 0 ? wins / trades.length * 100 : 0,
    maxLoss,
    numTrades: trades.length,
    slHits, slPnl,
    trailHits, trailPnl,
    maxhHits, maxhPnl,
    fees,
    grossProfit,
    feeDragPct: grossProfit > 0 ? fees / grossProfit * 100 : 0,
    aTrades: aT, aPnl: aP,
    bTrades: bT, bPnl: bP,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function main() {
  log("=".repeat(140));
  log("  SL STRESS TEST — Wider SL × slippage multipliers on deployed 2-engine portfolio");
  log("  Engine A: GARCH long-only loose (z1h>2.0 AND z4h>1.5)");
  log("  Engine B: Range Expansion (1h range >= 2.0*ATR, close in extreme 25%)");
  log("  Trail: multi-stage 3/1 -> 9/0.5 -> 20/0.5  |  Margin: A=$15 B=$15  |  Regime ON (1.5)");
  log(`  SL widths: ${SL_WIDTHS.map(s => (s * 100).toFixed(2) + "%").join(", ")}`);
  log(`  Slip mults: ${SLIP_MULTS.map(s => s.toFixed(1) + "x").join(", ")}`);
  log("  Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03");
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
    if (h1.length < 250 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const atr1 = computeATR(h1, 14);
    const rexSig20 = computeRangeExpansion(h1, atr1, 2.0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168, atr1, rexSig20 },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  const baseCfg: Omit<SimCfg, "slPct"> = {
    marginA: 15, marginB: 15,
    aMaxHoldH: 72, bMaxHoldH: 12,
    aZL1: 2.0, aZL4: 1.5,
    aRegime: true, aRegimeThr: 1.5,
    bRegime: true, bRegimeThr: 1.5,
    regimeThr: 1.5,
  };

  // Run once per SL width per window (8 * 2 = 16 sims)
  const simResults = new Map<string, { is: Tr[]; oos: Tr[] }>();
  for (const sl of SL_WIDTHS) {
    const key = sl.toFixed(4);
    log(`\nSimulating SL=${(sl * 100).toFixed(2)}% ...`);
    const cfg: SimCfg = { ...baseCfg, slPct: sl };
    const is = simulate(pairs, cfg, IS_S, IS_E);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E);
    simResults.set(key, { is, oos });
    log(`  IS trades: ${is.length}  OOS trades: ${oos.length}`);
  }

  // Per-SL detailed breakdown: IS + OOS at each slip
  for (const sl of SL_WIDTHS) {
    const { is, oos } = simResults.get(sl.toFixed(4))!;
    log("\n" + "=".repeat(140));
    log(`  SL = ${(sl * 100).toFixed(2)}%`);
    log("=".repeat(140));

    log(`\n  IS (Jun-Dec 2025, ${IS_D.toFixed(0)} days):`);
    log(`  ${"slip".padStart(5)} ${"$/day".padStart(9)} ${"total".padStart(10)} ${"MDD".padStart(9)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)} ${"SLhits".padStart(7)} ${"SLpnl".padStart(10)} ${"feeDrag".padStart(8)} ${"A$/d".padStart(8)} ${"B$/d".padStart(8)}`);
    log("  " + "-".repeat(120));
    for (const slip of SLIP_MULTS) {
      const st = statsAtSlip(is, slip, IS_D);
      log(
        "  " +
        `${(slip.toFixed(1) + "x").padStart(5)} ` +
        `${fmtD(st.dollarsPerDay).padStart(9)} ` +
        `${fmtD(st.totalPnl).padStart(10)} ` +
        `${("$" + st.maxDD.toFixed(0)).padStart(9)} ` +
        `${st.pf.toFixed(2).padStart(6)} ` +
        `${st.wr.toFixed(1).padStart(6)} ` +
        `${String(st.numTrades).padStart(5)} ` +
        `${String(st.slHits).padStart(7)} ` +
        `${fmtD(st.slPnl).padStart(10)} ` +
        `${(st.feeDragPct.toFixed(1) + "%").padStart(8)} ` +
        `${fmtD(st.aPnl / IS_D).padStart(8)} ` +
        `${fmtD(st.bPnl / IS_D).padStart(8)}`
      );
    }

    log(`\n  OOS (Dec 2025 - Mar 2026, ${OOS_D.toFixed(0)} days):`);
    log(`  ${"slip".padStart(5)} ${"$/day".padStart(9)} ${"total".padStart(10)} ${"MDD".padStart(9)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)} ${"SLhits".padStart(7)} ${"SLpnl".padStart(10)} ${"feeDrag".padStart(8)} ${"A$/d".padStart(8)} ${"B$/d".padStart(8)}`);
    log("  " + "-".repeat(120));
    for (const slip of SLIP_MULTS) {
      const st = statsAtSlip(oos, slip, OOS_D);
      log(
        "  " +
        `${(slip.toFixed(1) + "x").padStart(5)} ` +
        `${fmtD(st.dollarsPerDay).padStart(9)} ` +
        `${fmtD(st.totalPnl).padStart(10)} ` +
        `${("$" + st.maxDD.toFixed(0)).padStart(9)} ` +
        `${st.pf.toFixed(2).padStart(6)} ` +
        `${st.wr.toFixed(1).padStart(6)} ` +
        `${String(st.numTrades).padStart(5)} ` +
        `${String(st.slHits).padStart(7)} ` +
        `${fmtD(st.slPnl).padStart(10)} ` +
        `${(st.feeDragPct.toFixed(1) + "%").padStart(8)} ` +
        `${fmtD(st.aPnl / OOS_D).padStart(8)} ` +
        `${fmtD(st.bPnl / OOS_D).padStart(8)}`
      );
    }
  }

  // Cross-grid matrix: OOS $/day by SL × slip
  log("\n" + "=".repeat(140));
  log("  OOS $/day MATRIX  (rows=SL width, cols=slip mult)");
  log("=".repeat(140));
  log("  " + "SL%".padStart(6) + SLIP_MULTS.map(s => (s.toFixed(1) + "x").padStart(11)).join(""));
  log("  " + "-".repeat(6 + SLIP_MULTS.length * 11));
  for (const sl of SL_WIDTHS) {
    const { oos } = simResults.get(sl.toFixed(4))!;
    let row = "  " + ((sl * 100).toFixed(2)).padStart(6);
    for (const slip of SLIP_MULTS) {
      const st = statsAtSlip(oos, slip, OOS_D);
      row += fmtD(st.dollarsPerDay).padStart(11);
    }
    log(row);
  }

  log("\n  OOS MDD MATRIX  (rows=SL width, cols=slip mult)");
  log("  " + "SL%".padStart(6) + SLIP_MULTS.map(s => (s.toFixed(1) + "x").padStart(11)).join(""));
  log("  " + "-".repeat(6 + SLIP_MULTS.length * 11));
  for (const sl of SL_WIDTHS) {
    const { oos } = simResults.get(sl.toFixed(4))!;
    let row = "  " + ((sl * 100).toFixed(2)).padStart(6);
    for (const slip of SLIP_MULTS) {
      const st = statsAtSlip(oos, slip, OOS_D);
      row += ("$" + st.maxDD.toFixed(0)).padStart(11);
    }
    log(row);
  }

  log("\n  OOS PF MATRIX  (rows=SL width, cols=slip mult)");
  log("  " + "SL%".padStart(6) + SLIP_MULTS.map(s => (s.toFixed(1) + "x").padStart(11)).join(""));
  log("  " + "-".repeat(6 + SLIP_MULTS.length * 11));
  for (const sl of SL_WIDTHS) {
    const { oos } = simResults.get(sl.toFixed(4))!;
    let row = "  " + ((sl * 100).toFixed(2)).padStart(6);
    for (const slip of SLIP_MULTS) {
      const st = statsAtSlip(oos, slip, OOS_D);
      row += st.pf.toFixed(2).padStart(11);
    }
    log(row);
  }

  log("\n  OOS #SL HITS (rows=SL width, cols=window — same across slip)");
  log("  " + "SL%".padStart(6) + "IS_hits".padStart(11) + "OOS_hits".padStart(11) + "IS_SL%".padStart(11) + "OOS_SL%".padStart(11));
  log("  " + "-".repeat(50));
  for (const sl of SL_WIDTHS) {
    const { is, oos } = simResults.get(sl.toFixed(4))!;
    const isSL = is.filter(t => t.reason === "sl").length;
    const oosSL = oos.filter(t => t.reason === "sl").length;
    const isPct = is.length > 0 ? (isSL / is.length * 100) : 0;
    const oosPct = oos.length > 0 ? (oosSL / oos.length * 100) : 0;
    log(
      "  " +
      ((sl * 100).toFixed(2)).padStart(6) +
      String(isSL).padStart(11) +
      String(oosSL).padStart(11) +
      (isPct.toFixed(1) + "%").padStart(11) +
      (oosPct.toFixed(1) + "%").padStart(11)
    );
  }

  // Survival rank at 2.5x (realistic live)
  log("\n" + "=".repeat(140));
  log("  SURVIVAL RANK @ 2.5x slip (REALISTIC LIVE) — OOS");
  log("=".repeat(140));
  interface Row { sl: number; st: Stats; }
  const rows25: Row[] = SL_WIDTHS.map(sl => ({
    sl,
    st: statsAtSlip(simResults.get(sl.toFixed(4))!.oos, 2.5, OOS_D),
  }));
  rows25.sort((a, b) => b.st.dollarsPerDay - a.st.dollarsPerDay);
  log(`  ${"rank".padStart(4)} ${"SL%".padStart(6)} ${"$/day".padStart(9)} ${"MDD".padStart(9)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"SLhits".padStart(7)} ${"slPnl".padStart(10)} ${"feeDrag".padStart(9)}`);
  log("  " + "-".repeat(75));
  for (let i = 0; i < rows25.length; i++) {
    const r = rows25[i]!;
    log(
      "  " +
      String(i + 1).padStart(4) + " " +
      ((r.sl * 100).toFixed(2)).padStart(6) + " " +
      fmtD(r.st.dollarsPerDay).padStart(9) + " " +
      ("$" + r.st.maxDD.toFixed(0)).padStart(9) + " " +
      r.st.pf.toFixed(2).padStart(6) + " " +
      r.st.wr.toFixed(1).padStart(6) + " " +
      String(r.st.slHits).padStart(7) + " " +
      fmtD(r.st.slPnl).padStart(10) + " " +
      (r.st.feeDragPct.toFixed(1) + "%").padStart(9)
    );
  }

  // Robustness: average rank across all slip levels
  log("\n" + "=".repeat(140));
  log("  ROBUSTNESS — avg rank of each SL across all slip levels (OOS)");
  log("=".repeat(140));
  const avgRanks = new Map<number, number>();
  const slipRanks = new Map<number, number[]>();
  for (const slip of SLIP_MULTS) {
    const rows: Row[] = SL_WIDTHS.map(sl => ({
      sl,
      st: statsAtSlip(simResults.get(sl.toFixed(4))!.oos, slip, OOS_D),
    }));
    rows.sort((a, b) => b.st.dollarsPerDay - a.st.dollarsPerDay);
    for (let i = 0; i < rows.length; i++) {
      const sl = rows[i]!.sl;
      const arr = slipRanks.get(sl) ?? [];
      arr.push(i + 1);
      slipRanks.set(sl, arr);
    }
  }
  for (const [sl, ranks] of slipRanks) {
    avgRanks.set(sl, ranks.reduce((s, v) => s + v, 0) / ranks.length);
  }
  const robust = [...avgRanks.entries()].sort((a, b) => a[1] - b[1]);
  log(`  ${"SL%".padStart(6)} ${"avgRank".padStart(8)} ${"ranks(1.5/2.5/4.0/6.0)".padStart(25)}`);
  log("  " + "-".repeat(45));
  for (const [sl, avg] of robust) {
    const ranks = slipRanks.get(sl)!;
    log(
      "  " +
      ((sl * 100).toFixed(2)).padStart(6) + " " +
      avg.toFixed(2).padStart(8) + " " +
      ranks.map(r => String(r)).join("/").padStart(25)
    );
  }

  // Verdict
  log("\n" + "=".repeat(140));
  log("  VERDICT");
  log("=".repeat(140));
  const best25 = rows25[0]!;
  const sl015 = rows25.find(r => Math.abs(r.sl - 0.0015) < 1e-9)!;
  log(`\n  Best @ 2.5x (realistic live): SL=${(best25.sl * 100).toFixed(2)}%`);
  log(`    $/day ${fmtD(best25.st.dollarsPerDay)}  MDD $${best25.st.maxDD.toFixed(0)}  PF ${best25.st.pf.toFixed(2)}  WR ${best25.st.wr.toFixed(1)}%`);
  log(`    SLhits ${best25.st.slHits}/${best25.st.numTrades} (${(best25.st.slHits / best25.st.numTrades * 100).toFixed(1)}%)`);
  log(`\n  Current deployed (0.15%) @ 2.5x:`);
  log(`    $/day ${fmtD(sl015.st.dollarsPerDay)}  MDD $${sl015.st.maxDD.toFixed(0)}  PF ${sl015.st.pf.toFixed(2)}  WR ${sl015.st.wr.toFixed(1)}%`);
  log(`    SLhits ${sl015.st.slHits}/${sl015.st.numTrades} (${(sl015.st.slHits / sl015.st.numTrades * 100).toFixed(1)}%)`);
  const delta = best25.st.dollarsPerDay - sl015.st.dollarsPerDay;
  log(`\n  Delta (best - 0.15%): ${fmtD(delta)}/day`);

  log("\n  0.15% survival across slip levels (OOS $/day):");
  for (const slip of SLIP_MULTS) {
    const st = statsAtSlip(simResults.get("0.0015")!.oos, slip, OOS_D);
    const dead = st.dollarsPerDay <= 0 ? "  [DEAD]" : st.dollarsPerDay < 1 ? "  [WEAK]" : "";
    log(`    ${slip.toFixed(1)}x: ${fmtD(st.dollarsPerDay)} MDD $${st.maxDD.toFixed(0)} PF ${st.pf.toFixed(2)}${dead}`);
  }

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "sl-stress.txt"), lines.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "sl-stress.txt")}`);
}

main();
