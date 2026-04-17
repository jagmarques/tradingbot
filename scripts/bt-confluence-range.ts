/**
 * bt-confluence-range.ts
 *
 * Backtester #4 — test 2 NEW signals walk-forward:
 *   Signal 1: Multi-TF Confluence (15m + 1h + 4h z-score)
 *   Signal 2: Range Expansion Continuation (1h range > k*ATR, close in upper/lower 25%)
 *
 * Each signal tested standalone AND combined with current GARCH SAFE portfolio.
 * IS:  2025-06-01 -> 2025-12-01
 * OOS: 2025-12-01 -> 2026-03-25
 *
 * Framework mirrors scripts/bt-sl-fast.ts.
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M15 = 15 * 60 * 1000;
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

interface C { t: number; o: number; h: number; l: number; c: number; }

interface PI {
  m5: C[];
  m15: C[]; h1: C[]; h4: C[];
  m15Map: Map<number, number>;
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z15: number[];
  z1: number[];
  z4: number[];
  atr1: number[];         // ATR(14) on 1h
  rv24: number[]; rv168: number[];
  // Range expansion signal per h1 bar idx (+1 long, -1 short, 0 none)
  rexSig25: Int8Array;    // range >= 2.5 * atr
  rexSig20: Int8Array;    // range >= 2.0 * atr
  rexSig30: Int8Array;    // range >= 3.0 * atr
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

// Wilder ATR(14) on close-to-close TR
function computeATR(cs: C[], period = 14): number[] {
  const out = new Array(cs.length).fill(0);
  if (cs.length < period + 2) return out;
  const tr: number[] = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i]!.h, l = cs[i]!.l, pc = cs[i - 1]!.c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // seed
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

type Engine = "garch" | "confluence" | "range";

interface Cfg {
  label: string;
  engines: Engine[];
  margin: number; // per engine
  slPct: number;
  trailAct: number; trailDist: number;
  maxHoldH: number;

  // GARCH (safe) settings
  garch: {
    zL1: number; zS1: number; zL4: number; zS4: number;
    regime: boolean; regimeThr: number;
  };
  // Confluence
  conf: {
    zL15: number; zS15: number;
    zL1: number; zS1: number;
    zL4: number; zS4: number;
    maxHoldH: number;
  };
  // Range expansion
  rex: {
    mult: 2.0 | 2.5 | 3.0;
    regime: boolean; regimeThr: number;
    maxHoldH: number;
  };
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  maxSingleLoss: number; numTrades: number;
  byEngine: Record<Engine, { pnl: number; n: number }>;
}

interface Tr {
  engine: Engine; pair: string; dir: "long" | "short";
  pnl: number; reason: string; exitTs: number;
}

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

  const runGarch = cfg.engines.includes("garch");
  const runConf = cfg.engines.includes("confluence");
  const runRex = cfg.engines.includes("range");

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
        const rsp = isSL ? pos.sp * SL_SLIP : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    // Entries: iterate pairs and try each enabled engine
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // ===== GARCH SAFE =====
      if (runGarch && !openPositions.some(o => o.pair === p.name && o.engine === "garch")) {
        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);
        let dir: "long" | "short" | null = null;
        if (z1 > cfg.garch.zL1 && z4 > cfg.garch.zL4) dir = "long";
        if (z1 < cfg.garch.zS1 && z4 < cfg.garch.zS4) dir = "short";
        if (dir) {
          let ok = true;
          if (cfg.garch.regime) {
            const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
            const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
            if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.garch.regimeThr) ok = false;
          }
          if (ok) {
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "garch", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: cfg.margin * p.lev, maxHoldH: cfg.maxHoldH,
            });
          }
        }
      }

      // ===== CONFLUENCE =====
      if (runConf && !openPositions.some(o => o.pair === p.name && o.engine === "confluence")) {
        // Use PRIOR closed bar z for 15m/1h/4h
        // z15 at 15m bin prior to ts
        const m15Bin = Math.floor((ts - 1) / M15) * M15; // last closed 15m bin
        const m15i = p.ind.m15Map.get(m15Bin);
        const z15 = m15i !== undefined && m15i >= 1 ? p.ind.z15[m15i]! : 0;

        const z1 = p.ind.z1[h1Idx - 1]!;
        const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

        let dir: "long" | "short" | null = null;
        if (z15 > cfg.conf.zL15 && z1 > cfg.conf.zL1 && z4 > cfg.conf.zL4) dir = "long";
        if (z15 < cfg.conf.zS15 && z1 < cfg.conf.zS1 && z4 < cfg.conf.zS4) dir = "short";
        if (dir) {
          const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
          const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
          openPositions.push({
            engine: "confluence", pair: p.name, dir, ep, et: ts, sl, pk: 0,
            sp: p.sp, lev: p.lev, not: cfg.margin * p.lev, maxHoldH: cfg.conf.maxHoldH,
          });
        }
      }

      // ===== RANGE EXPANSION =====
      if (runRex && !openPositions.some(o => o.pair === p.name && o.engine === "range")) {
        const sigArr = cfg.rex.mult === 2.0 ? p.ind.rexSig20 : cfg.rex.mult === 3.0 ? p.ind.rexSig30 : p.ind.rexSig25;
        const sig = sigArr[h1Idx - 1] ?? 0; // prior bar's signal
        if (sig !== 0) {
          let ok = true;
          if (cfg.rex.regime) {
            const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
            const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
            if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.rex.regimeThr) ok = false;
          }
          if (ok) {
            const dir: "long" | "short" = sig > 0 ? "long" : "short";
            const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
            const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
            openPositions.push({
              engine: "range", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: cfg.margin * p.lev, maxHoldH: cfg.rex.maxHoldH,
            });
          }
        }
      }
    }
  }

  // Close any still-open at end
  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    closed.push({ engine: pos.engine, pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end" });
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

  const byEngine: Record<Engine, { pnl: number; n: number }> = {
    garch: { pnl: 0, n: 0 },
    confluence: { pnl: 0, n: 0 },
    range: { pnl: 0, n: 0 },
  };
  for (const t of closed) { byEngine[t.engine].pnl += t.pnl; byEngine[t.engine].n += 1; }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function printRes(label: string, is: Res, oos: Res) {
  const isD = (is.dollarsPerDay).toFixed(2);
  const oD = (oos.dollarsPerDay).toFixed(2);
  console.log(
    `${label.padEnd(55)}  IS ${fmtD(is.dollarsPerDay).padStart(8)}/d MDD $${is.maxDD.toFixed(0).padStart(3)} PF ${is.pf.toFixed(2).padStart(4)} WR ${is.wr.toFixed(0).padStart(2)} N ${String(is.numTrades).padStart(4)}  |  OOS ${fmtD(oos.dollarsPerDay).padStart(8)}/d MDD $${oos.maxDD.toFixed(0).padStart(3)} PF ${oos.pf.toFixed(2).padStart(4)} WR ${oos.wr.toFixed(0).padStart(2)} N ${String(oos.numTrades).padStart(4)}`
  );
}

function flag(is: Res, oos: Res): string {
  const iD = is.dollarsPerDay;
  const oD = oos.dollarsPerDay;
  if (iD > 0.3 && oD < 0) return "  [OVERFIT: IS pos, OOS neg]";
  if (iD < 0 && oD > 0.3) return "  [REGIME-LUCK: IS neg, OOS pos]";
  if (iD > 0.3 && oD > 0.3 && Math.abs(iD - oD) / Math.max(iD, oD) > 0.7) return "  [HIGH DRIFT]";
  return "";
}

function main() {
  console.log("=".repeat(160));
  console.log("  CONFLUENCE + RANGE EXPANSION BACKTEST (walk-forward)");
  console.log("  IS 2025-06-01 -> 2025-12-01  |  OOS 2025-12-01 -> 2026-03-25");
  console.log("  SL 0.15%, SL_SLIP 1.5x, trail 9/0.5, margin $15/engine, max lev 10x, block 22-23 UTC");
  console.log("=".repeat(160));

  console.log("\nLoading pairs...");
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const m15 = aggregate(raw, M15, 2);
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 250 || h4.length < 50 || m15.length < 300) continue;
    const m15Map = new Map<number, number>();
    m15.forEach((c, i) => m15Map.set(c.t, i));
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z15 = computeZ(m15);
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const atr1 = computeATR(h1, 14);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const rexSig20 = computeRangeExpansion(h1, atr1, 2.0);
    const rexSig25 = computeRangeExpansion(h1, atr1, 2.5);
    const rexSig30 = computeRangeExpansion(h1, atr1, 3.0);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { m5, m15, h1, h4, m15Map, h1Map, h4Map, z15, z1, z4, atr1, rv24, rv168, rexSig20, rexSig25, rexSig30 },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  console.log(`${pairs.length} pairs loaded\n`);

  // Base shared settings
  const baseCfg: Omit<Cfg, "engines" | "label" | "conf" | "rex"> & { conf: Cfg["conf"]; rex: Cfg["rex"] } = {
    margin: 15,
    slPct: 0.0015,         // 0.15%
    trailAct: 9, trailDist: 0.5,
    maxHoldH: 72,
    garch: { zL1: 2, zS1: -4, zL4: 1.5, zS4: -1.5, regime: true, regimeThr: 1.5 },
    conf: { zL15: 2, zS15: -2, zL1: 2, zS1: -2, zL4: 1.5, zS4: -1.5, maxHoldH: 24 },
    rex: { mult: 2.5, regime: false, regimeThr: 1.5, maxHoldH: 12 },
  };

  // ---------- CONFLUENCE STANDALONE ----------
  console.log("=".repeat(160));
  console.log("  SIGNAL 1 — MULTI-TF CONFLUENCE (standalone, margin $15)");
  console.log("=".repeat(160));

  const confThresholds: { lbl: string; zL15: number; zS15: number; zL1: number; zS1: number; zL4: number; zS4: number }[] = [
    { lbl: "relaxed 1.5/1.5/1.0", zL15: 1.5, zS15: -1.5, zL1: 1.5, zS1: -1.5, zL4: 1.0, zS4: -1.0 },
    { lbl: "normal  2.0/2.0/1.5", zL15: 2.0, zS15: -2.0, zL1: 2.0, zS1: -2.0, zL4: 1.5, zS4: -1.5 },
    { lbl: "strict  3.0/3.0/2.0", zL15: 3.0, zS15: -3.0, zL1: 3.0, zS1: -3.0, zL4: 2.0, zS4: -2.0 },
  ];

  interface ConfRec { lbl: string; is: Res; oos: Res; }
  const confRecs: ConfRec[] = [];

  for (const t of confThresholds) {
    const cfg: Cfg = {
      ...baseCfg,
      label: `CONF ${t.lbl}`,
      engines: ["confluence"],
      conf: { zL15: t.zL15, zS15: t.zS15, zL1: t.zL1, zS1: t.zS1, zL4: t.zL4, zS4: t.zS4, maxHoldH: 24 },
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    confRecs.push({ lbl: t.lbl, is, oos });
    printRes(`CONF ${t.lbl}`, is, oos);
    console.log(flag(is, oos) || "");
  }

  // ---------- RANGE EXPANSION STANDALONE ----------
  console.log("\n" + "=".repeat(160));
  console.log("  SIGNAL 2 — RANGE EXPANSION CONTINUATION (standalone, margin $15)");
  console.log("=".repeat(160));

  interface RexRec { lbl: string; mult: 2.0 | 2.5 | 3.0; regime: boolean; is: Res; oos: Res; }
  const rexRecs: RexRec[] = [];
  const mults: Array<2.0 | 2.5 | 3.0> = [2.0, 2.5, 3.0];
  for (const regime of [false, true]) {
    for (const mult of mults) {
      const cfg: Cfg = {
        ...baseCfg,
        label: `REX mult=${mult} regime=${regime ? "ON" : "OFF"}`,
        engines: ["range"],
        rex: { mult, regime, regimeThr: 1.5, maxHoldH: 12 },
      };
      const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
      rexRecs.push({ lbl: `mult=${mult} regime=${regime ? "ON " : "OFF"}`, mult, regime, is, oos });
      printRes(`REX mult=${mult.toFixed(1)} regime=${regime ? "ON " : "OFF"}`, is, oos);
      console.log(flag(is, oos) || "");
    }
  }

  // ---------- GARCH SAFE baseline (reference) ----------
  console.log("\n" + "=".repeat(160));
  console.log("  BASELINE — GARCH SAFE solo (margin $15)");
  console.log("=".repeat(160));
  const garchSoloCfg: Cfg = { ...baseCfg, label: "GARCH solo", engines: ["garch"] };
  const garchIs = simulate(pairs, garchSoloCfg, IS_S, IS_E, IS_D);
  const garchOos = simulate(pairs, garchSoloCfg, OOS_S, OOS_E, OOS_D);
  printRes("GARCH SAFE (solo, $15 margin)", garchIs, garchOos);

  // ---------- PORTFOLIO COMBOS ($7 margin per engine) ----------
  console.log("\n" + "=".repeat(160));
  console.log("  PORTFOLIO COMBOS — each engine $7 margin (parallel, independent positions)");
  console.log("=".repeat(160));

  // Use best threshold per signal based on OOS+IS combined edge (honest-ish — we need to pick something)
  const bestConf = confRecs.reduce((a, b) =>
    (a.is.dollarsPerDay + a.oos.dollarsPerDay) > (b.is.dollarsPerDay + b.oos.dollarsPerDay) ? a : b);
  const bestRex = rexRecs.reduce((a, b) =>
    (a.is.dollarsPerDay + a.oos.dollarsPerDay) > (b.is.dollarsPerDay + b.oos.dollarsPerDay) ? a : b);

  console.log(`\nChosen CONF: ${bestConf.lbl}`);
  console.log(`Chosen REX : ${bestRex.lbl}`);

  // Re-derive threshold params for chosen conf
  const pickedConfT = confThresholds.find(t => t.lbl === bestConf.lbl)!;

  const portMargin = 7;
  const portBase = { ...baseCfg, margin: portMargin };

  // Combo A: GARCH + CONF
  {
    const cfg: Cfg = {
      ...portBase,
      label: "GARCH+CONF",
      engines: ["garch", "confluence"],
      conf: { zL15: pickedConfT.zL15, zS15: pickedConfT.zS15, zL1: pickedConfT.zL1, zS1: pickedConfT.zS1, zL4: pickedConfT.zL4, zS4: pickedConfT.zS4, maxHoldH: 24 },
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    printRes("GARCH + CONF (7+7)", is, oos);
    console.log(`   IS by engine : garch ${fmtD(is.byEngine.garch.pnl)} (${is.byEngine.garch.n})  conf ${fmtD(is.byEngine.confluence.pnl)} (${is.byEngine.confluence.n})`);
    console.log(`   OOS by engine: garch ${fmtD(oos.byEngine.garch.pnl)} (${oos.byEngine.garch.n})  conf ${fmtD(oos.byEngine.confluence.pnl)} (${oos.byEngine.confluence.n})`);
  }

  // Combo B: GARCH + REX
  {
    const cfg: Cfg = {
      ...portBase,
      label: "GARCH+REX",
      engines: ["garch", "range"],
      rex: { mult: bestRex.mult, regime: bestRex.regime, regimeThr: 1.5, maxHoldH: 12 },
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    printRes("GARCH + REX   (7+7)", is, oos);
    console.log(`   IS by engine : garch ${fmtD(is.byEngine.garch.pnl)} (${is.byEngine.garch.n})  range ${fmtD(is.byEngine.range.pnl)} (${is.byEngine.range.n})`);
    console.log(`   OOS by engine: garch ${fmtD(oos.byEngine.garch.pnl)} (${oos.byEngine.garch.n})  range ${fmtD(oos.byEngine.range.pnl)} (${oos.byEngine.range.n})`);
  }

  // Combo C: GARCH + CONF + REX
  {
    const cfg: Cfg = {
      ...portBase,
      label: "GARCH+CONF+REX",
      engines: ["garch", "confluence", "range"],
      conf: { zL15: pickedConfT.zL15, zS15: pickedConfT.zS15, zL1: pickedConfT.zL1, zS1: pickedConfT.zS1, zL4: pickedConfT.zL4, zS4: pickedConfT.zS4, maxHoldH: 24 },
      rex: { mult: bestRex.mult, regime: bestRex.regime, regimeThr: 1.5, maxHoldH: 12 },
    };
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    printRes("GARCH + CONF + REX (7+7+7)", is, oos);
    console.log(`   IS by engine : garch ${fmtD(is.byEngine.garch.pnl)} (${is.byEngine.garch.n})  conf ${fmtD(is.byEngine.confluence.pnl)} (${is.byEngine.confluence.n})  range ${fmtD(is.byEngine.range.pnl)} (${is.byEngine.range.n})`);
    console.log(`   OOS by engine: garch ${fmtD(oos.byEngine.garch.pnl)} (${oos.byEngine.garch.n})  conf ${fmtD(oos.byEngine.confluence.pnl)} (${oos.byEngine.confluence.n})  range ${fmtD(oos.byEngine.range.pnl)} (${oos.byEngine.range.n})`);
  }

  // ---------- FINAL SUMMARY ----------
  console.log("\n" + "=".repeat(160));
  console.log("  VERDICT");
  console.log("=".repeat(160));
  console.log("Target to beat: $0.39/day OOS at MDD < $20");
  console.log("");
  console.log("CONFLUENCE results (IS -> OOS):");
  for (const r of confRecs) {
    console.log(`  ${r.lbl.padEnd(22)} IS ${fmtD(r.is.dollarsPerDay)}/d (MDD $${r.is.maxDD.toFixed(0)}) -> OOS ${fmtD(r.oos.dollarsPerDay)}/d (MDD $${r.oos.maxDD.toFixed(0)})${flag(r.is, r.oos)}`);
  }
  console.log("");
  console.log("RANGE EXPANSION results (IS -> OOS):");
  for (const r of rexRecs) {
    console.log(`  ${r.lbl.padEnd(22)} IS ${fmtD(r.is.dollarsPerDay)}/d (MDD $${r.is.maxDD.toFixed(0)}) -> OOS ${fmtD(r.oos.dollarsPerDay)}/d (MDD $${r.oos.maxDD.toFixed(0)})${flag(r.is, r.oos)}`);
  }
}

main();
