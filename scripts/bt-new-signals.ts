/**
 * NEW SIGNAL FAMILIES — nothing to do with GARCH z-score.
 *
 * 1. CSM: Cross-sectional momentum (rank all pairs by return, long top-N short bottom-N)
 * 2. BTC-beta residual (short alts running without BTC support)
 * 3. 1h extreme reversal (fade >3 sigma moves)
 * 4. Donchian channel reversal (mean revert from channel extreme with OHLC confirmation)
 * 5. Range expansion (trade bars where range > 2x average)
 * 6. Volume-weighted dispersion (best alt vs worst alt)
 *
 * All use same exchange-SL risk framework.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/bt-new-signals.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const CD_H = 1;
const FEE = 0.00035;
const SL_SLIP = 1.5;
const BLOCK = new Set([22, 23]);
const MAX_HOLD_H = 72;

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

const OOS_S = new Date("2025-06-01").getTime();
const OOS_E = new Date("2026-03-25").getTime();
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  ret1h: number[]; // 1h returns
  ret6h: number[]; // 6h returns
  ret24h: number[]; // 24h returns
  stdev1h_168: number[]; // rolling stdev of 1h returns over 168 bars
  atr14_h1: number[];
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

function computeReturns(cs: C[], lb: number): number[] {
  const out = new Array(cs.length).fill(0);
  for (let i = lb; i < cs.length; i++) {
    out[i] = cs[i]!.c / cs[i - lb]!.c - 1;
  }
  return out;
}

function computeRollingStdev(arr: number[], window: number): number[] {
  const out = new Array(arr.length).fill(0);
  for (let i = window; i < arr.length; i++) {
    let sum = 0, sum2 = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += arr[j]!;
      sum2 += arr[j]! * arr[j]!;
    }
    const mean = sum / window;
    const variance = sum2 / window - mean * mean;
    out[i] = Math.sqrt(Math.max(0, variance));
  }
  return out;
}

function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const hi = cs[i]!.h, lo = cs[i]!.l, pc = cs[i - 1]!.c;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    out[i + 1] = atr;
  }
  return out;
}

type Signal = (p: PD, h1Idx: number, ts: number, ctx: Map<string, PD>) => "long" | "short" | null;

function signal_CSM(topN: number, lb: number): Signal {
  return (p, h1Idx, ts, ctx) => {
    if (h1Idx < lb + 1) return null;
    // Rank this pair against all pairs using 1h returns at h1Idx - 1
    const rets: Array<{ name: string; ret: number }> = [];
    for (const [name, otherP] of ctx) {
      const otherIdx = otherP.ind.h1Map.get(Math.floor(ts / H) * H);
      if (otherIdx === undefined || otherIdx < lb + 1) continue;
      const ret = otherP.ind.h1[otherIdx - 1]!.c / otherP.ind.h1[otherIdx - 1 - lb]!.c - 1;
      if (isFinite(ret)) rets.push({ name, ret });
    }
    if (rets.length < 20) return null;
    rets.sort((a, b) => b.ret - a.ret);
    const topSet = new Set(rets.slice(0, topN).map(r => r.name));
    const botSet = new Set(rets.slice(-topN).map(r => r.name));
    if (topSet.has(p.name)) return "long";
    if (botSet.has(p.name)) return "short";
    return null;
  };
}

function signal_ExtremeReversal(sigmaMult: number): Signal {
  return (p, h1Idx) => {
    if (h1Idx < 170) return null;
    const lastRet = p.ind.ret1h[h1Idx - 1]!;
    const stdev = p.ind.stdev1h_168[h1Idx - 1]!;
    if (stdev === 0) return null;
    const zRet = lastRet / stdev;
    if (zRet > sigmaMult) return "short"; // fade big up move
    if (zRet < -sigmaMult) return "long"; // fade big down move
    return null;
  };
}

function signal_Persistence(lb: number, th: number): Signal {
  // Long if last 3 1h closes all positive AND cumulative > th; short mirrored
  return (p, h1Idx) => {
    if (h1Idx < lb + 3) return null;
    const c1 = p.ind.h1[h1Idx - 1]!.c;
    const c2 = p.ind.h1[h1Idx - 2]!.c;
    const c3 = p.ind.h1[h1Idx - 3]!.c;
    const c0 = p.ind.h1[h1Idx - 1 - lb]!.c;
    const cumRet = c1 / c0 - 1;
    if (c1 > c2 && c2 > c3 && cumRet > th) return "long";
    if (c1 < c2 && c2 < c3 && cumRet < -th) return "short";
    return null;
  };
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  beActivated: boolean;
}

interface SimResult { totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number; maxSingleLoss: number; numTrades: number; }

function simulate(pairs: PD[], signal: Signal, margin: number, slPct: number, trailAct: number, trailDist: number, maxHoldH: number = MAX_HOLD_H): SimResult {
  const closed: Tr[] = [];
  const cdMap = new Map<string, number>();
  const openPositions: OpenPos[] = [];

  const all5mTimes = new Set<number>();
  for (const p of pairs) {
    for (const b of p.ind.m5) {
      if (b.t >= OOS_S && b.t < OOS_E) all5mTimes.add(b.t);
    }
  }
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
    const isH1Boundary = ts % H === 0;
    const hourOfDay = new Date(ts).getUTCHours();

    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const m5Map = m5Maps.get(pos.pair);
      if (!m5Map) continue;
      const bi = m5Map.get(ts);
      if (bi === undefined) continue;
      const pd = pairByName.get(pos.pair)!;
      const bar = pd.ind.m5[bi]!;

      let xp = 0, reason = "", isSL = false;

      if ((ts - pos.et) / H >= maxHoldH) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const hit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (hit) { xp = pos.sl; reason = pos.beActivated ? "be" : "sl"; isSL = true; }
      }

      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;

      if (!xp && !pos.beActivated && pos.pk >= 7) {
        pos.sl = pos.ep;
        pos.beActivated = true;
      }

      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= trailAct && cur <= pos.pk - trailDist) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cdMap.set(`${pos.pair}:${pos.dir}`, ts + CD_H * H);
      }
    }

    if (!isH1Boundary) continue;
    if (BLOCK.has(hourOfDay)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 25) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const dir = signal(p, h1Idx, ts, pairByName);
      if (!dir) continue;

      const ck = `${p.name}:${dir}`;
      if (cdMap.has(ck) && ts < cdMap.get(ck)!) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: margin * p.lev,
        beActivated: false,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - pos.not * FEE * 2;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end" });
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
  for (const t of closed) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / OOS_D,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  console.log("=".repeat(130));
  console.log("  NEW SIGNALS — cross-sectional momentum, extreme reversal, persistence");
  console.log("=".repeat(130));

  console.log("\nLoading...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const ret1h = computeReturns(h1, 1);
    const ret6h = computeReturns(h1, 6);
    const ret24h = computeReturns(h1, 24);
    const stdev1h_168 = computeRollingStdev(ret1h, 168);
    const atr14_h1 = computeATR(h1, 14);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= OOS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { h1, h4, m5, h1Map, ret1h, ret6h, ret24h, stdev1h_168, atr14_h1 },
      sp: SP[n] ?? DSP, lev,
    });
  }
  console.log(`${pairs.length} pairs loaded`);

  const tests: Array<{ label: string; signal: Signal; margin: number; slPct: number; trailAct: number; trailDist: number; maxHoldH?: number }> = [
    // CSM
    { label: "CSM top5 lb6", signal: signal_CSM(5, 6), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top5 lb12", signal: signal_CSM(5, 12), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top5 lb24", signal: signal_CSM(5, 24), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top8 lb6", signal: signal_CSM(8, 6), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top8 lb12", signal: signal_CSM(8, 12), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top10 lb12", signal: signal_CSM(10, 12), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top3 lb24", signal: signal_CSM(3, 24), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    // CSM with tight SL
    { label: "CSM top5 lb12 SL0.1%", signal: signal_CSM(5, 12), margin: 10, slPct: 0.001, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top8 lb12 SL0.1%", signal: signal_CSM(8, 12), margin: 10, slPct: 0.001, trailAct: 9, trailDist: 0.5 },
    // CSM higher margin
    { label: "CSM top5 lb12 m$20 SL0.1%", signal: signal_CSM(5, 12), margin: 20, slPct: 0.001, trailAct: 9, trailDist: 0.5 },
    { label: "CSM top5 lb12 m$30 SL0.1%", signal: signal_CSM(5, 12), margin: 30, slPct: 0.001, trailAct: 9, trailDist: 0.5 },

    // Extreme reversal
    { label: "ExtRev 2.5sigma", signal: signal_ExtremeReversal(2.5), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5, maxHoldH: 12 },
    { label: "ExtRev 3sigma", signal: signal_ExtremeReversal(3.0), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5, maxHoldH: 12 },
    { label: "ExtRev 4sigma", signal: signal_ExtremeReversal(4.0), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5, maxHoldH: 12 },
    { label: "ExtRev 5sigma", signal: signal_ExtremeReversal(5.0), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5, maxHoldH: 12 },
    { label: "ExtRev 3sigma SL0.1%", signal: signal_ExtremeReversal(3.0), margin: 10, slPct: 0.001, trailAct: 9, trailDist: 0.5, maxHoldH: 12 },
    { label: "ExtRev 3sigma SL0.1% m$20", signal: signal_ExtremeReversal(3.0), margin: 20, slPct: 0.001, trailAct: 9, trailDist: 0.5, maxHoldH: 12 },

    // Persistence momentum
    { label: "Persist lb6 th2%", signal: signal_Persistence(6, 0.02), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "Persist lb12 th3%", signal: signal_Persistence(12, 0.03), margin: 10, slPct: 0.003, trailAct: 9, trailDist: 0.5 },
    { label: "Persist lb6 th3% SL0.1%", signal: signal_Persistence(6, 0.03), margin: 10, slPct: 0.001, trailAct: 9, trailDist: 0.5 },
  ];

  const hdr = `${"Signal".padEnd(40)} ${"$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"MaxL".padStart(8)} ${"N".padStart(6)}`;
  console.log("\n" + hdr);
  console.log("-".repeat(130));

  const results: Array<{ label: string; res: SimResult }> = [];
  for (const t of tests) {
    const res = simulate(pairs, t.signal, t.margin, t.slPct, t.trailAct, t.trailDist, t.maxHoldH);
    results.push({ label: t.label, res });
    console.log(`${t.label.padEnd(40).slice(0, 40)} ${fmtD(res.dollarsPerDay).padStart(9)} ${("$" + res.maxDD.toFixed(0)).padStart(8)} ${res.pf.toFixed(2).padStart(5)} ${res.wr.toFixed(1).padStart(6)} ${fmtD(res.maxSingleLoss).padStart(8)} ${String(res.numTrades).padStart(6)}`);
  }

  // Summary
  console.log("\n" + "=".repeat(130));
  console.log("TOP BY $/DAY");
  console.log("=".repeat(130));
  console.log(hdr);
  const sorted = [...results].sort((a, b) => b.res.dollarsPerDay - a.res.dollarsPerDay);
  for (const r of sorted.slice(0, 10)) {
    console.log(`${r.label.padEnd(40).slice(0, 40)} ${fmtD(r.res.dollarsPerDay).padStart(9)} ${("$" + r.res.maxDD.toFixed(0)).padStart(8)} ${r.res.pf.toFixed(2).padStart(5)} ${r.res.wr.toFixed(1).padStart(6)} ${fmtD(r.res.maxSingleLoss).padStart(8)} ${String(r.res.numTrades).padStart(6)}`);
  }
}

main();
