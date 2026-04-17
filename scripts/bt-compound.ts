/**
 * COMPOUNDING BACKTEST — deployed SAFE config with dynamic margin sizing
 *
 * SAFE config:
 *   z1h > 4.0 / < -6.0, z4h > 2.0 / < -2.0
 *   SL 0.15% price, slip 1.5x on SL fills
 *   Trail 9/0.5
 *   Vol regime RV(24)/RV(168) > 1.5
 *
 * Experiment: margin = current_equity * X% (X in {15,20,25,30})
 *   - Cap min $5 (HL minimum), max ($60 * 0.5 = $30)
 *   - Track equity through time, update per closed trade
 *   - Report: final equity, max DD $ and %, $/day at final scale
 *   - Also compare vs weekly-withdraw (Fri 22 UTC: skim profit above $60)
 *
 * Baseline reference: fixed $15 margin
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
const OOS_D = (OOS_E - OOS_S) / D;

interface C { t: number; o: number; h: number; l: number; c: number; }
interface PI {
  h1: C[]; h4: C[]; m5: C[];
  h1Map: Map<number, number>;
  h4Map: Map<number, number>;
  z1: number[]; z4: number[];
  rv24: number[];
  rv168: number[];
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
  mode: "fixed" | "compound" | "compound_withdraw";
  fixedMargin: number;
  compoundPct: number;
  minMargin: number;
  maxMargin: number;
  startEquity: number;
  slPct: number;
  slSlipMult: number;
  trailAct: number; trailDist: number;
  regimeThr: number;
  zL1: number; zS1: number; zL4: number; zS4: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number; margin: number;
}

interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; margin: number; equityAfter: number; }

interface Res {
  label: string;
  startEquity: number;
  finalEquity: number;
  finalEquityEff: number;
  totalWithdrawn: number;
  peakEquity: number;
  maxDDDollar: number;
  maxDDPct: number;
  totalPnl: number;
  dollarsPerDayAvg: number;
  dollarsPerDayFinal: number;
  pf: number;
  wr: number;
  numTrades: number;
  avgMargin: number;
  minMarginSeen: number;
  maxMarginSeen: number;
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

  let equity = cfg.startEquity;
  let peakEquity = equity;
  let maxDDDollar = 0;
  let totalWithdrawn = 0;
  let sumMargin = 0;
  let nMargin = 0;
  let minMarginSeen = Infinity;
  let maxMarginSeen = 0;

  let lastWithdrawWeek = -1;

  function maybeWithdraw(ts: number) {
    if (cfg.mode !== "compound_withdraw") return;
    const d = new Date(ts);
    const weekday = d.getUTCDay();
    const hour = d.getUTCHours();
    const week = Math.floor(ts / (7 * D));
    if (weekday === 5 && hour >= 22 && week !== lastWithdrawWeek) {
      lastWithdrawWeek = week;
      if (equity > cfg.startEquity) {
        const skim = equity - cfg.startEquity;
        equity -= skim;
        totalWithdrawn += skim;
        if (equity > peakEquity) peakEquity = equity;
        // peakEquity should also drop so DD calc is reasonable after withdrawal
        peakEquity = Math.min(peakEquity, equity);
      }
    }
  }

  function marginForNextTrade(): number {
    if (cfg.mode === "fixed") return cfg.fixedMargin;
    let m = equity * cfg.compoundPct;
    if (m < cfg.minMargin) m = cfg.minMargin;
    if (m > cfg.maxMargin) m = cfg.maxMargin;
    return m;
  }

  let totalFees = 0;

  for (const ts of timepoints) {
    maybeWithdraw(ts);

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
      const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.l - 1) * pos.lev * 100;
      if (best > pos.pk) pos.pk = best;
      if (!xp) {
        const cur = pos.dir === "long" ? (bar.c / pos.ep - 1) * pos.lev * 100 : (pos.ep / bar.c - 1) * pos.lev * 100;
        if (pos.pk >= cfg.trailAct && cur <= pos.pk - cfg.trailDist) { xp = bar.c; reason = "trail"; }
      }

      if (xp > 0) {
        const rsp = isSL ? pos.sp * cfg.slSlipMult : pos.sp;
        const ex = pos.dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
        const fees = pos.not * FEE * 2;
        totalFees += fees;
        const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
        equity += pnl;
        if (equity > peakEquity) peakEquity = equity;
        const dd = peakEquity - equity;
        if (dd > maxDDDollar) maxDDDollar = dd;
        closed.push({ pair: pos.pair, dir: pos.dir, exitTs: ts, pnl, reason, margin: pos.margin, equityAfter: equity });
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

      const rv24 = p.ind.rv24[h1Idx - 1] ?? 0;
      const rv168 = p.ind.rv168[h1Idx - 1] ?? 0;
      if (rv24 === 0 || rv168 === 0) continue;
      if (rv24 / rv168 < cfg.regimeThr) continue;

      const margin = marginForNextTrade();
      const inUse = openPositions.reduce((s, o) => s + o.margin, 0);
      if (inUse + margin > equity * 0.95) continue;

      const ep = dir === "long" ? p.ind.h1[h1Idx]!.o * (1 + p.sp) : p.ind.h1[h1Idx]!.o * (1 - p.sp);
      const slDist = ep * cfg.slPct;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      sumMargin += margin;
      nMargin++;
      if (margin < minMarginSeen) minMarginSeen = margin;
      if (margin > maxMarginSeen) maxMarginSeen = margin;

      openPositions.push({
        pair: p.name, dir, ep, et: ts, sl, pk: 0,
        sp: p.sp, lev: p.lev, not: margin * p.lev, margin,
      });
    }
  }

  for (const pos of openPositions) {
    const pd = pairByName.get(pos.pair)!;
    const lb = pd.ind.m5[pd.ind.m5.length - 1]!;
    const ex = pos.dir === "long" ? lb.c * (1 - pos.sp) : lb.c * (1 + pos.sp);
    const fees = pos.not * FEE * 2;
    totalFees += fees;
    const pnl = (pos.dir === "long" ? (ex / pos.ep - 1) : (pos.ep / ex - 1)) * pos.not - fees;
    equity += pnl;
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    if (dd > maxDDDollar) maxDDDollar = dd;
    closed.push({ pair: pos.pair, dir: pos.dir, exitTs: lb.t, pnl, reason: "end", margin: pos.margin, equityAfter: equity });
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : Infinity;

  const finalEquityEff = equity;
  const avgMargin = nMargin > 0 ? sumMargin / nMargin : cfg.fixedMargin;
  const finalScaleMargin = cfg.mode === "fixed"
    ? cfg.fixedMargin
    : Math.min(cfg.maxMargin, Math.max(cfg.minMargin, (finalEquityEff + totalWithdrawn) * cfg.compoundPct));
  const dollarsPerDayAvg = totalPnl / days;
  const dollarsPerDayFinal = avgMargin > 0 ? dollarsPerDayAvg * (finalScaleMargin / avgMargin) : dollarsPerDayAvg;

  const maxDDPct = (maxDDDollar / cfg.startEquity) * 100;

  return {
    label: cfg.label,
    startEquity: cfg.startEquity,
    finalEquity: finalEquityEff + totalWithdrawn,
    finalEquityEff,
    totalWithdrawn,
    peakEquity,
    maxDDDollar,
    maxDDPct,
    totalPnl,
    dollarsPerDayAvg,
    dollarsPerDayFinal,
    pf,
    wr,
    numTrades: closed.length,
    avgMargin,
    minMarginSeen: minMarginSeen === Infinity ? 0 : minMarginSeen,
    maxMarginSeen,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

function main() {
  const lines: string[] = [];
  const log = (s: string) => { console.log(s); lines.push(s); };

  log("=".repeat(140));
  log("  COMPOUNDING BACKTEST — deployed SAFE config, dynamic margin sizing");
  log("  z1h>4.0/<-6.0, z4h>2.0/<-2.0 | SL 0.15% | Trail 9/0.5 | Regime 1.5 | OOS 2025-12-01 -> 2026-03-25");
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
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({ name: n, ind: { h1, h4, m5, h1Map, h4Map, z1, z4, rv24, rv168 }, sp: SP[n] ?? DSP, lev });
  }
  log(`${pairs.length} pairs loaded`);
  log(`OOS period: ${OOS_D.toFixed(1)} days`);

  const base = {
    slPct: 0.0015, slSlipMult: 1.5,
    trailAct: 9, trailDist: 0.5,
    regimeThr: 1.5,
    zL1: 4.0, zS1: -6.0, zL4: 2.0, zS4: -2.0,
  };

  const startEquity = 60;
  const minMargin = 5;
  const maxMargin = startEquity * 0.5;

  const configs: Cfg[] = [
    { ...base, label: "FIXED $15 (baseline)",  mode: "fixed",             fixedMargin: 15, compoundPct: 0,    minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 15%",          mode: "compound",          fixedMargin: 0,  compoundPct: 0.15, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 20%",          mode: "compound",          fixedMargin: 0,  compoundPct: 0.20, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 25%",          mode: "compound",          fixedMargin: 0,  compoundPct: 0.25, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 30%",          mode: "compound",          fixedMargin: 0,  compoundPct: 0.30, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 15% + WD Fri", mode: "compound_withdraw", fixedMargin: 0,  compoundPct: 0.15, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 20% + WD Fri", mode: "compound_withdraw", fixedMargin: 0,  compoundPct: 0.20, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 25% + WD Fri", mode: "compound_withdraw", fixedMargin: 0,  compoundPct: 0.25, minMargin, maxMargin, startEquity },
    { ...base, label: "COMPOUND 30% + WD Fri", mode: "compound_withdraw", fixedMargin: 0,  compoundPct: 0.30, minMargin, maxMargin, startEquity },
  ];

  log("\n" + "=".repeat(140));
  log("OOS RESULTS (start $60, cap margin min $5, max $30)");
  log("=".repeat(140));
  log("");
  log(`${"Config".padEnd(24)} ${"Final$".padStart(9)} ${"Growth".padStart(8)} ${"MaxDD$".padStart(8)} ${"MaxDD%".padStart(8)} ${"$/day".padStart(9)} ${"$/dFin".padStart(9)} ${"Trades".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(6)} ${"AvgMg".padStart(7)} ${"MgMin".padStart(6)} ${"MgMax".padStart(6)} ${"WD$".padStart(8)}`);
  log("-".repeat(140));

  const results: Res[] = [];
  for (const cfg of configs) {
    const r = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    results.push(r);
    const growth = ((r.finalEquity - r.startEquity) / r.startEquity * 100).toFixed(1) + "%";
    log(
      `${cfg.label.padEnd(24)} ` +
      `${("$" + r.finalEquity.toFixed(2)).padStart(9)} ` +
      `${growth.padStart(8)} ` +
      `${("$" + r.maxDDDollar.toFixed(2)).padStart(8)} ` +
      `${(r.maxDDPct.toFixed(1) + "%").padStart(8)} ` +
      `${fmtD(r.dollarsPerDayAvg).padStart(9)} ` +
      `${fmtD(r.dollarsPerDayFinal).padStart(9)} ` +
      `${String(r.numTrades).padStart(7)} ` +
      `${r.pf.toFixed(2).padStart(5)} ` +
      `${r.wr.toFixed(1).padStart(6)} ` +
      `${("$" + r.avgMargin.toFixed(1)).padStart(7)} ` +
      `${("$" + r.minMarginSeen.toFixed(1)).padStart(6)} ` +
      `${("$" + r.maxMarginSeen.toFixed(1)).padStart(6)} ` +
      `${("$" + r.totalWithdrawn.toFixed(2)).padStart(8)}`
    );
  }

  log("");
  log("=".repeat(140));
  log("COMPOUND vs FIXED ANALYSIS");
  log("=".repeat(140));
  const fixedR = results[0]!;
  log(`\nBaseline FIXED $15: final $${fixedR.finalEquity.toFixed(2)} (+$${(fixedR.finalEquity - 60).toFixed(2)}), MDD $${fixedR.maxDDDollar.toFixed(2)} (${fixedR.maxDDPct.toFixed(1)}%), ${fmtD(fixedR.dollarsPerDayAvg)}/day`);
  log("");
  for (let i = 1; i < results.length; i++) {
    const r = results[i]!;
    const pnlDiff = r.finalEquity - fixedR.finalEquity;
    const ddDiff = r.maxDDDollar - fixedR.maxDDDollar;
    const sign = pnlDiff >= 0 ? "+" : "";
    const ddSign = ddDiff >= 0 ? "+" : "";
    log(`${r.label.padEnd(24)}: vs fixed = ${sign}$${pnlDiff.toFixed(2)} PnL, ${ddSign}$${ddDiff.toFixed(2)} DD | Final scale $/day: ${fmtD(r.dollarsPerDayFinal)} (${((r.dollarsPerDayFinal / (fixedR.dollarsPerDayAvg || 1) - 1) * 100).toFixed(0)}% vs baseline)`);
  }

  log("");
  log("=".repeat(140));
  log("WHEN DOES MDD EXCEED $20?");
  log("=".repeat(140));
  for (const r of results) {
    const status = r.maxDDDollar > 20 ? "EXCEEDS $20" : "SAFE";
    log(`${r.label.padEnd(24)}: MDD $${r.maxDDDollar.toFixed(2)} (${r.maxDDPct.toFixed(1)}% of $60 start) — ${status}`);
  }

  log("");
  log("=".repeat(140));
  log("VERDICT");
  log("=".repeat(140));
  const pureCompound = results.slice(1, 5);
  const wdCompound = results.slice(5, 9);
  const bestCompound = pureCompound.reduce((best, r) => r.finalEquity > best.finalEquity ? r : best, pureCompound[0]!);
  const bestWithdraw = wdCompound.reduce((best, r) => r.finalEquity > best.finalEquity ? r : best, wdCompound[0]!);
  log(`Best pure-compound: ${bestCompound.label} — final $${bestCompound.finalEquity.toFixed(2)} (${((bestCompound.finalEquity / 60 - 1) * 100).toFixed(1)}% growth), MDD $${bestCompound.maxDDDollar.toFixed(2)} (${bestCompound.maxDDPct.toFixed(1)}%)`);
  log(`Best withdraw rule: ${bestWithdraw.label} — total $${bestWithdraw.finalEquity.toFixed(2)} (equity $${bestWithdraw.finalEquityEff.toFixed(2)} + withdrawn $${bestWithdraw.totalWithdrawn.toFixed(2)}), MDD $${bestWithdraw.maxDDDollar.toFixed(2)}`);
  const compoundGain = bestCompound.finalEquity - fixedR.finalEquity;
  log(`\nCompounding edge over fixed: $${compoundGain.toFixed(2)} extra over ${OOS_D.toFixed(0)} OOS days.`);
  const fixedPnl = fixedR.finalEquity - 60;
  if (fixedPnl > 0 && compoundGain > fixedPnl * 0.15) {
    log(`Verdict: COMPOUNDING IS MEANINGFULLY BETTER (${((compoundGain / fixedPnl) * 100).toFixed(0)}% more total profit vs fixed).`);
  } else if (fixedPnl <= 0) {
    log(`Verdict: fixed baseline is not profitable; compounding inherits same edge.`);
  } else {
    log(`Verdict: compounding adds little (margin cap $${maxMargin} throttles growth, or base $/day is too low to meaningfully scale).`);
  }

  const outPath = ".company/backtester/compound.txt";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"));
  log(`\nSaved to ${outPath}`);
}

main();
