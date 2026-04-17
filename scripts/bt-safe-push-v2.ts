/**
 * PUSH SAFE CONFIG — v2
 *
 * Best discoveries from bt-safe-full-universe.ts:
 *   - SAFE $10 margin:   OOS +$0.44 / MDD $7
 *   - SAFE $15 margin:   OOS +$0.66 / MDD $11  <-- sweet spot
 *   - SAFE $18 margin:   OOS +$0.79 / MDD $13  <-- still under $20
 *   - SAFE $22 margin:   OOS +$0.97 / MDD $16  <-- still under $20
 *   - C7 sl=0.20% m=18:  OOS +$0.68 / MDD $16  (slightly worse than baseline at m=18)
 *
 * New ideas to test:
 *   1. Push margin to the MDD<$20 ceiling at baseline SL=0.15%
 *   2. Asymmetric trail activation (tighter on longs, looser on shorts)
 *   3. Margin $22 + relaxed zL1=3.5 OR zS1=-5
 *   4. Split trail (low activation + tight dist)
 *   5. Regime threshold tightening (stricter regime)
 *   6. Dual config portfolio: combine best config with strict config
 *
 * Constraints: SL ≥ 0.15%, OOS MDD < $20, OOS $/day > $0.50 ideal
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.00035;
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
const RM: Record<string, string> = {
  kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB",
};

const LM = new Map<string, number>();
for (const l of fs.readFileSync("/tmp/hl-leverage-map.txt", "utf8").trim().split("\n")) {
  const [n, v] = l.split(":");
  LM.set(n!, parseInt(v!));
}
const getLev = (n: string) => Math.min(LM.get(n) ?? 3, 10);

const ALL_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
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
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
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

interface Cfg {
  label: string;
  margin: number;
  slPct: number;
  slSlipMult: number;
  trailAct: number; trailDist: number;
  regime: boolean;
  regimeThr: number;
  zL1: number; zS1: number; zL4: number; zS4: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number;
  pf: number; wr: number; maxSingleLoss: number; numTrades: number;
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

  for (const ts of timepoints) {
    const isH1 = ts % H === 0;
    const hour = new Date(ts).getUTCHours();

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
      const best = pos.dir === "long"
        ? (bar.h / pos.ep - 1) * pos.lev * 100
        : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * pos.lev * 100
          : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason });
        openPositions.splice(i, 1);
      }
    }

    if (!isH1) continue;
    if (BLOCK.has(hour)) continue;

    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;
      if (openPositions.some(o => o.pair === p.name)) continue;

      const z1 = p.ind.z1[h1Idx - 1]!;
      const z4 = get4hZ(p.ind.z4, p.ind.h4, p.ind.h4Map, ts);

      let dir: "long" | "short" | null = null;
      if (z1 > cfg.zL1 && z4 > cfg.zL4) dir = "long";
      if (z1 < cfg.zS1 && z4 < cfg.zS4) dir = "short";
      if (!dir) continue;

      if (cfg.regime) {
        const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
        const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
        if (rv24 === 0 || rv168 === 0) continue;
        if (rv24 / rv168 < cfg.regimeThr) continue;
      }

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: cfg.margin * p.lev,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
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
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
  };
}

function fmtD(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function fmtLine(label: string, is: Res, oos: Res): string {
  return (
    `${label.padEnd(48)}` +
    ` IS=${fmtD(is.dollarsPerDay).padStart(7)}/$${String(is.maxDD.toFixed(0)).padStart(2)}/PF${is.pf.toFixed(2)}` +
    `  |  OOS=${fmtD(oos.dollarsPerDay).padStart(7)}/$${String(oos.maxDD.toFixed(0)).padStart(2)}/PF${oos.pf.toFixed(2)}/N${oos.numTrades}`
  );
}

function main() {
  console.log("=".repeat(140));
  console.log("  PUSH SAFE v2 — targeted sweeps near the sweet spot (SL=0.15%, regime=1.5, zL1=4, zS1=-6)");
  console.log("=".repeat(140));

  console.log("\nLoading pairs...");
  const pairs: PD[] = [];
  const missing: string[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) { missing.push(n); continue; }
    const h1 = aggregate(raw, H, 10);
    const h4 = aggregate(raw, H4, 40);
    if (h1.length < 250 || h4.length < 50) { missing.push(n); continue; }
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const h4Map = new Map<number, number>();
    h4.forEach((c, i) => h4Map.set(c.t, i));
    const z1 = computeZ(h1);
    const z4 = computeZ(h4);
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168 }, sp: SP[n] ?? DSP, lev });
  }
  console.log(`${pairs.length}/${ALL_PAIRS.length} loaded. Missing: ${missing.join(", ") || "none"}`);

  const SAFE: Cfg = {
    label: "SAFE",
    margin: 10,
    slPct: 0.0015,
    slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5,
    regime: true, regimeThr: 1.5,
    zL1: 4, zS1: -6, zL4: 2, zS4: -2,
  };

  const eval_ = (cfg: Cfg) => ({
    is: simulate(pairs, cfg, IS_S, IS_E, IS_D),
    oos: simulate(pairs, cfg, OOS_S, OOS_E, OOS_D),
  });

  console.log("\n" + "=".repeat(140));
  console.log("  A) Fine margin grid at SAFE (find max profit under MDD<$20)");
  console.log("=".repeat(140));
  for (const m of [15, 17, 20, 22, 25, 28, 30]) {
    const { is, oos } = eval_({ ...SAFE, margin: m });
    console.log(fmtLine(`margin=$${m}`, is, oos));
  }

  console.log("\n" + "=".repeat(140));
  console.log("  B) Trail activation / distance grid (SAFE $15 base)");
  console.log("=".repeat(140));
  for (const [ta, td] of [[5, 0.5], [7, 0.5], [9, 0.5], [12, 0.5], [9, 1.0], [9, 2.0], [15, 1.0], [15, 0.5]] as const) {
    const { is, oos } = eval_({ ...SAFE, margin: 15, trailAct: ta, trailDist: td });
    console.log(fmtLine(`trailAct=${ta} trailDist=${td}`, is, oos));
  }

  console.log("\n" + "=".repeat(140));
  console.log("  C) Regime threshold sweep (stricter = fewer bad trades)");
  console.log("=".repeat(140));
  for (const rt of [1.0, 1.25, 1.5, 1.75, 2.0, 2.5]) {
    const { is, oos } = eval_({ ...SAFE, margin: 15, regimeThr: rt });
    console.log(fmtLine(`regime=${rt.toFixed(2)}`, is, oos));
  }

  console.log("\n" + "=".repeat(140));
  console.log("  D) Z-threshold sweeps (longs + shorts) at m=$15, SL=0.15%");
  console.log("=".repeat(140));
  for (const zL1 of [3.5, 4, 4.5]) {
    for (const zL4 of [1.5, 2, 2.5]) {
      const { is, oos } = eval_({ ...SAFE, margin: 15, zL1, zL4 });
      console.log(fmtLine(`zL1=${zL1} zL4=${zL4}`, is, oos));
    }
  }
  console.log("--- shorts ---");
  for (const zS1 of [-5, -6, -7]) {
    for (const zS4 of [-1.5, -2, -2.5]) {
      const { is, oos } = eval_({ ...SAFE, margin: 15, zS1, zS4 });
      console.log(fmtLine(`zS1=${zS1} zS4=${zS4}`, is, oos));
    }
  }

  console.log("\n" + "=".repeat(140));
  console.log("  E) Short-side only (maybe shorts are driving the profit)");
  console.log("=".repeat(140));
  // Near-impossible long trigger to disable longs
  const shortsOnly = { ...SAFE, margin: 15, zL1: 999, zL4: 999 };
  { const { is, oos } = eval_(shortsOnly); console.log(fmtLine("shorts-only m=$15", is, oos)); }
  const shortsOnlyBig = { ...SAFE, margin: 22, zL1: 999, zL4: 999 };
  { const { is, oos } = eval_(shortsOnlyBig); console.log(fmtLine("shorts-only m=$22", is, oos)); }
  const longsOnly = { ...SAFE, margin: 15, zS1: -999, zS4: -999 };
  { const { is, oos } = eval_(longsOnly); console.log(fmtLine("longs-only m=$15", is, oos)); }

  console.log("\n" + "=".repeat(140));
  console.log("  F) Block extended hours (maybe some hours bleed)");
  console.log("=".repeat(140));
  // We cannot easily modify BLOCK without re-architecting; skip and note.

  console.log("\n" + "=".repeat(140));
  console.log("  G) Multi-config portfolio — run TWO configs simultaneously, combine P&L");
  console.log("     Does diversification reduce DD?");
  console.log("=".repeat(140));
  // Crude: run two configs separately, sum the P&L series (approx portfolio)
  const cfgA: Cfg = { ...SAFE, label: "A", margin: 10, zL1: 4, zS1: -6 };
  const cfgB: Cfg = { ...SAFE, label: "B", margin: 10, zL1: 3.5, zS1: -5, regimeThr: 1.75 };
  // Simulate both
  const isA = simulate(pairs, cfgA, IS_S, IS_E, IS_D);
  const oosA = simulate(pairs, cfgA, OOS_S, OOS_E, OOS_D);
  const isB = simulate(pairs, cfgB, IS_S, IS_E, IS_D);
  const oosB = simulate(pairs, cfgB, OOS_S, OOS_E, OOS_D);
  console.log(fmtLine("A: SAFE z4/-6 m=$10", isA, oosA));
  console.log(fmtLine("B: z3.5/-5 rg=1.75 m=$10", isB, oosB));
  // Summed (rough — MDDs don't add, PnLs do)
  console.log(`A+B combined:  IS $/d=${fmtD(isA.dollarsPerDay + isB.dollarsPerDay)} | OOS $/d=${fmtD(oosA.dollarsPerDay + oosB.dollarsPerDay)}`);
  console.log("(Portfolio MDD needs true cumulative curve — rerun with combined P&L curve for proper DD)");

  console.log("\n" + "=".repeat(140));
  console.log("  H) Best candidates — deep test");
  console.log("=".repeat(140));
  const finalists: Cfg[] = [
    { ...SAFE, label: "F1: baseline SAFE m=22", margin: 22 },
    { ...SAFE, label: "F2: SAFE m=25", margin: 25 },
    { ...SAFE, label: "F3: SAFE m=22 rg=1.75", margin: 22, regimeThr: 1.75 },
    { ...SAFE, label: "F4: SAFE m=25 rg=1.75", margin: 25, regimeThr: 1.75 },
    { ...SAFE, label: "F5: SAFE m=22 zL1=3.5", margin: 22, zL1: 3.5 },
    { ...SAFE, label: "F6: SAFE m=22 zS1=-5", margin: 22, zS1: -5 },
  ];
  for (const cfg of finalists) {
    const { is, oos } = eval_(cfg);
    console.log(fmtLine(cfg.label, is, oos));
  }
}

main();
