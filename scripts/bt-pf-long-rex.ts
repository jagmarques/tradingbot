/**
 * PORTFOLIO: GARCH LONG-ONLY LOOSE + RANGE EXPANSION
 *
 * Cycle 6 winners stacked. Each engine has its own position slot per pair
 * (same pair can be held by A and B simultaneously with independent trade IDs).
 *
 * Engine A — GARCH long-only loose:
 *   z1h > 2.0 AND z4h > 1.5, LONGS ONLY, SL 0.15%, vol regime ON (RV24/RV168 >= 1.5)
 *   trail 9/0.5, block h22-23, max hold 72h
 *
 * Engine B — Range Expansion:
 *   1h range >= 2.0 * ATR(14), close in extreme 25% (upper for long, lower for short)
 *   vol regime ON, SL 0.15%, trail 9/0.5, max hold 12h
 *
 * Walk-forward: IS 2025-06 -> 2025-12, OOS 2025-12 -> 2026-03
 * Test 7 margin splits, report correlation & stacking behavior.
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

type Engine = "A" | "B"; // A = GARCH long-only loose, B = Range Expansion

interface Cfg {
  label: string;
  marginA: number;
  marginB: number;
  // shared
  slPct: number;
  trailAct: number;
  trailDist: number;
  // A
  aZL1: number; aZL4: number;
  aRegime: boolean; aRegimeThr: number;
  aMaxHoldH: number;
  // B
  bMult: number;
  bRegime: boolean; bRegimeThr: number;
  bMaxHoldH: number;
}

interface OpenPos {
  engine: Engine;
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
}

interface Tr {
  engine: Engine; pair: string; dir: "long" | "short";
  pnl: number; reason: string; exitTs: number;
}

interface EngineStats { pnl: number; n: number; wins: number; losses: number; maxLoss: number; }
interface Res {
  totalPnl: number;
  dollarsPerDay: number;
  maxDD: number;
  pf: number;
  wr: number;
  maxSingleLoss: number;
  numTrades: number;
  byEngine: Record<Engine, EngineStats>;
  // For correlation
  dailyPnlA: Map<number, number>;
  dailyPnlB: Map<number, number>;
  trades: Tr[];
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

    // Entries
    for (const p of pairs) {
      const h1Idx = p.ind.h1Map.get(ts);
      if (h1Idx === undefined || h1Idx < 170) continue;

      // ===== Engine A — GARCH long-only loose =====
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
            const dir: "long" = "long";
            const ep = p.ind.h1[h1Idx]!.o * (1 + p.sp);
            const sl = ep * (1 - cfg.slPct);
            openPositions.push({
              engine: "A", pair: p.name, dir, ep, et: ts, sl, pk: 0,
              sp: p.sp, lev: p.lev, not: notA(p.lev), maxHoldH: cfg.aMaxHoldH,
            });
          }
        }
      }

      // ===== Engine B — Range Expansion =====
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

  // Close still-open at end
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

  const byEngine: Record<Engine, EngineStats> = {
    A: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
    B: { pnl: 0, n: 0, wins: 0, losses: 0, maxLoss: 0 },
  };
  const dailyPnlA = new Map<number, number>();
  const dailyPnlB = new Map<number, number>();
  for (const t of closed) {
    const e = byEngine[t.engine];
    e.pnl += t.pnl; e.n += 1;
    if (t.pnl > 0) e.wins += 1; else { e.losses += 1; if (t.pnl < e.maxLoss) e.maxLoss = t.pnl; }
    const day = Math.floor(t.exitTs / D) * D;
    const m = t.engine === "A" ? dailyPnlA : dailyPnlB;
    m.set(day, (m.get(day) ?? 0) + t.pnl);
  }

  return {
    totalPnl,
    dollarsPerDay: totalPnl / days,
    maxDD,
    pf,
    wr,
    maxSingleLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    numTrades: closed.length,
    byEngine,
    dailyPnlA,
    dailyPnlB,
    trades: closed,
  };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma, xb = b[i]! - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

function correlationReport(res: Res): {
  corr: number;
  sameLosingDays: number;
  daysA: number;
  daysB: number;
  losingDaysA: number;
  losingDaysB: number;
  bothLosingDays: number;
  bothWinningDays: number;
  aWinBLoseDays: number;
  aLoseBWinDays: number;
} {
  const allDays = new Set<number>([...res.dailyPnlA.keys(), ...res.dailyPnlB.keys()]);
  const days = [...allDays].sort((a, b) => a - b);
  const va: number[] = [];
  const vb: number[] = [];
  for (const d of days) {
    va.push(res.dailyPnlA.get(d) ?? 0);
    vb.push(res.dailyPnlB.get(d) ?? 0);
  }
  const corr = pearson(va, vb);

  let losingDaysA = 0, losingDaysB = 0, bothLose = 0, bothWin = 0, aw_bl = 0, al_bw = 0;
  for (let i = 0; i < days.length; i++) {
    const a = va[i]!, b = vb[i]!;
    if (a < 0) losingDaysA++;
    if (b < 0) losingDaysB++;
    if (a < 0 && b < 0) bothLose++;
    if (a > 0 && b > 0) bothWin++;
    if (a > 0 && b < 0) aw_bl++;
    if (a < 0 && b > 0) al_bw++;
  }

  return {
    corr,
    sameLosingDays: bothLose,
    daysA: [...res.dailyPnlA.values()].filter(v => v !== 0).length,
    daysB: [...res.dailyPnlB.values()].filter(v => v !== 0).length,
    losingDaysA,
    losingDaysB,
    bothLosingDays: bothLose,
    bothWinningDays: bothWin,
    aWinBLoseDays: aw_bl,
    aLoseBWinDays: al_bw,
  };
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }

function reportRes(label: string, r: Res) {
  log(`  ${label}`);
  log(`    Total: ${fmtD(r.totalPnl)}  $/day: ${fmtD(r.dollarsPerDay)}  MDD: $${r.maxDD.toFixed(2)}  PF: ${r.pf.toFixed(2)}  WR: ${r.wr.toFixed(1)}%`);
  log(`    Trades: ${r.numTrades}  MaxLoss: ${fmtD(r.maxSingleLoss)}`);
  log(`    A: ${fmtD(r.byEngine.A.pnl)} over ${r.byEngine.A.n} trades (${r.byEngine.A.wins}W/${r.byEngine.A.losses}L) maxL ${fmtD(r.byEngine.A.maxLoss)}`);
  log(`    B: ${fmtD(r.byEngine.B.pnl)} over ${r.byEngine.B.n} trades (${r.byEngine.B.wins}W/${r.byEngine.B.losses}L) maxL ${fmtD(r.byEngine.B.maxLoss)}`);
  const aDaily = r.byEngine.A.n > 0 ? r.byEngine.A.pnl / (r.dailyPnlA.size || 1) : 0;
  const bDaily = r.byEngine.B.n > 0 ? r.byEngine.B.pnl / (r.dailyPnlB.size || 1) : 0;
  void aDaily; void bDaily;
}

function main() {
  log("=".repeat(130));
  log("  PORTFOLIO — GARCH LONG-ONLY LOOSE (A) + RANGE EXPANSION (B)");
  log("  Engine A: z1h>2.0 AND z4h>1.5, LONGS ONLY, SL 0.15%, regime ON, trail 9/0.5, max hold 72h");
  log("  Engine B: 1h range >= 2.0*ATR, close in extreme 25%, SL 0.15%, regime ON, trail 9/0.5, max hold 12h");
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

  const baseCfg: Omit<Cfg, "label" | "marginA" | "marginB"> = {
    slPct: 0.0015,
    trailAct: 9,
    trailDist: 0.5,
    aZL1: 2.0, aZL4: 1.5,
    aRegime: true, aRegimeThr: 1.5,
    aMaxHoldH: 72,
    bMult: 2.0,
    bRegime: true, bRegimeThr: 1.5,
    bMaxHoldH: 12,
  };

  interface Split { label: string; marginA: number; marginB: number; }
  const splits: Split[] = [
    { label: "1. A$15 + B$15 (high commitment)", marginA: 15, marginB: 15 },
    { label: "2. A$10 + B$10 (balanced)",        marginA: 10, marginB: 10 },
    { label: "3. A$15 + B$8  (long-bias)",       marginA: 15, marginB: 8  },
    { label: "4. A$8  + B$15 (rex-bias)",        marginA: 8,  marginB: 15 },
    { label: "5. A$20 + B$10 (concentrated)",    marginA: 20, marginB: 10 },
    { label: "6. A$10 + B$5  (conservative)",    marginA: 10, marginB: 5  },
    { label: "7. A$25 + B$5  (max long + rex)",  marginA: 25, marginB: 5  },
  ];

  interface Rec {
    split: Split;
    is: Res; oos: Res;
    isCorr: ReturnType<typeof correlationReport>;
    oosCorr: ReturnType<typeof correlationReport>;
  }
  const recs: Rec[] = [];

  for (const s of splits) {
    const cfg: Cfg = { ...baseCfg, label: s.label, marginA: s.marginA, marginB: s.marginB };
    log("\n" + "=".repeat(130));
    log(`  ${s.label}`);
    log("=".repeat(130));
    const is = simulate(pairs, cfg, IS_S, IS_E, IS_D);
    const oos = simulate(pairs, cfg, OOS_S, OOS_E, OOS_D);
    const isCorr = correlationReport(is);
    const oosCorr = correlationReport(oos);
    log("\n  --- IS (Jun-Dec 2025) ---");
    reportRes("IS", is);
    log(`    Daily corr(A,B): ${isCorr.corr.toFixed(3)}  losing A:${isCorr.losingDaysA} B:${isCorr.losingDaysB} both:${isCorr.bothLosingDays}`);
    log("  --- OOS (Dec 2025 - Mar 2026) ---");
    reportRes("OOS", oos);
    log(`    Daily corr(A,B): ${oosCorr.corr.toFixed(3)}`);
    log(`    Losing days -- A:${oosCorr.losingDaysA}  B:${oosCorr.losingDaysB}  both:${oosCorr.bothLosingDays}  A-only:${oosCorr.aLoseBWinDays}  B-only:${oosCorr.aWinBLoseDays}`);
    log(`    Winning both: ${oosCorr.bothWinningDays}`);
    recs.push({ split: s, is, oos, isCorr, oosCorr });
  }

  // Standalone reference runs: A alone @ m$15, B alone @ m$15
  log("\n" + "=".repeat(130));
  log("  STANDALONE REFERENCE (for additivity check)");
  log("=".repeat(130));

  const aAloneCfg: Cfg = { ...baseCfg, label: "A alone m$15", marginA: 15, marginB: 0 };
  const bAloneCfg: Cfg = { ...baseCfg, label: "B alone m$15", marginA: 0, marginB: 15 };
  const aAloneIS = simulate(pairs, aAloneCfg, IS_S, IS_E, IS_D);
  const aAloneOOS = simulate(pairs, aAloneCfg, OOS_S, OOS_E, OOS_D);
  const bAloneIS = simulate(pairs, bAloneCfg, IS_S, IS_E, IS_D);
  const bAloneOOS = simulate(pairs, bAloneCfg, OOS_S, OOS_E, OOS_D);

  log("\n  Engine A alone @ m$15:");
  log(`    IS  $/day ${fmtD(aAloneIS.dollarsPerDay)}  MDD $${aAloneIS.maxDD.toFixed(2)}  PF ${aAloneIS.pf.toFixed(2)}  N=${aAloneIS.numTrades}`);
  log(`    OOS $/day ${fmtD(aAloneOOS.dollarsPerDay)}  MDD $${aAloneOOS.maxDD.toFixed(2)}  PF ${aAloneOOS.pf.toFixed(2)}  N=${aAloneOOS.numTrades}`);
  log("  Engine B alone @ m$15:");
  log(`    IS  $/day ${fmtD(bAloneIS.dollarsPerDay)}  MDD $${bAloneIS.maxDD.toFixed(2)}  PF ${bAloneIS.pf.toFixed(2)}  N=${bAloneIS.numTrades}`);
  log(`    OOS $/day ${fmtD(bAloneOOS.dollarsPerDay)}  MDD $${bAloneOOS.maxDD.toFixed(2)}  PF ${bAloneOOS.pf.toFixed(2)}  N=${bAloneOOS.numTrades}`);

  // Summary table
  log("\n" + "=".repeat(130));
  log("  OOS SUMMARY — all splits");
  log("=".repeat(130));
  log(`${"Split".padEnd(36)} ${"$/day".padStart(9)} ${"A$/day".padStart(9)} ${"B$/day".padStart(9)} ${"MDD".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)} ${"N".padStart(5)} ${"MaxL".padStart(9)} ${"corr".padStart(7)}`);
  log("-".repeat(130));
  for (const r of recs) {
    const aDay = r.oos.byEngine.A.pnl / OOS_D;
    const bDay = r.oos.byEngine.B.pnl / OOS_D;
    log(
      `${r.split.label.padEnd(36)} ` +
      `${fmtD(r.oos.dollarsPerDay).padStart(9)} ` +
      `${fmtD(aDay).padStart(9)} ` +
      `${fmtD(bDay).padStart(9)} ` +
      `${("$" + r.oos.maxDD.toFixed(0)).padStart(8)} ` +
      `${r.oos.pf.toFixed(2).padStart(6)} ` +
      `${r.oos.wr.toFixed(1).padStart(6)} ` +
      `${String(r.oos.numTrades).padStart(5)} ` +
      `${fmtD(r.oos.maxSingleLoss).padStart(9)} ` +
      `${r.oosCorr.corr.toFixed(3).padStart(7)}`
    );
  }

  // Additivity check — scale standalone engines to split margins and sum expected vs actual
  log("\n" + "=".repeat(130));
  log("  ADDITIVITY CHECK — expected (A_alone*scale + B_alone*scale) vs portfolio actual");
  log("=".repeat(130));
  log(`${"Split".padEnd(36)} ${"exp$/day".padStart(10)} ${"act$/day".padStart(10)} ${"delta".padStart(10)} ${"expMDD".padStart(8)} ${"actMDD".padStart(8)}`);
  log("-".repeat(130));
  for (const r of recs) {
    const expDay = aAloneOOS.dollarsPerDay * (r.split.marginA / 15) + bAloneOOS.dollarsPerDay * (r.split.marginB / 15);
    const expMDD = aAloneOOS.maxDD * (r.split.marginA / 15) + bAloneOOS.maxDD * (r.split.marginB / 15);
    const actDay = r.oos.dollarsPerDay;
    const actMDD = r.oos.maxDD;
    log(
      `${r.split.label.padEnd(36)} ` +
      `${fmtD(expDay).padStart(10)} ` +
      `${fmtD(actDay).padStart(10)} ` +
      `${fmtD(actDay - expDay).padStart(10)} ` +
      `${("$" + expMDD.toFixed(0)).padStart(8)} ` +
      `${("$" + actMDD.toFixed(0)).padStart(8)}`
    );
  }

  // Winners
  log("\n" + "=".repeat(130));
  log("  VERDICT");
  log("=".repeat(130));
  const passing = recs.filter(r => r.oos.maxDD < 20);
  passing.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  if (passing.length === 0) {
    log("  No portfolio split passed OOS MDD < $20.");
    const sorted = [...recs].sort((a, b) => a.oos.maxDD - b.oos.maxDD);
    log("  Lowest OOS MDD:");
    for (const r of sorted.slice(0, 3)) {
      log(`    ${r.split.label}: $/day ${fmtD(r.oos.dollarsPerDay)}, MDD $${r.oos.maxDD.toFixed(0)}, PF ${r.oos.pf.toFixed(2)}, corr ${r.oosCorr.corr.toFixed(3)}`);
    }
  } else {
    log("  Splits passing OOS MDD < $20 (sorted by $/day):");
    for (const r of passing) {
      log(`    ${r.split.label}: $/day ${fmtD(r.oos.dollarsPerDay)}, MDD $${r.oos.maxDD.toFixed(0)}, PF ${r.oos.pf.toFixed(2)}, corr ${r.oosCorr.corr.toFixed(3)}`);
    }
    const best = passing[0]!;
    log(`\n  BEST: ${best.split.label}`);
    log(`    OOS $/day: ${fmtD(best.oos.dollarsPerDay)}`);
    log(`    OOS $/day A: ${fmtD(best.oos.byEngine.A.pnl / OOS_D)}`);
    log(`    OOS $/day B: ${fmtD(best.oos.byEngine.B.pnl / OOS_D)}`);
    log(`    OOS MDD: $${best.oos.maxDD.toFixed(2)}`);
    log(`    OOS PF: ${best.oos.pf.toFixed(2)}`);
    log(`    OOS max single loss: ${fmtD(best.oos.maxSingleLoss)}`);
    log(`    OOS trades A: ${best.oos.byEngine.A.n}  B: ${best.oos.byEngine.B.n}`);
    log(`    OOS daily corr(A,B): ${best.oosCorr.corr.toFixed(3)}`);
    log(`    OOS both-losing days: ${best.oosCorr.bothLosingDays} of ${best.oosCorr.losingDaysA + best.oosCorr.aLoseBWinDays} A-losing days`);
  }

  // Correlation commentary
  log("\n  CORRELATION ANALYSIS (OOS daily P&L):");
  const corrs = recs.map(r => r.oosCorr.corr);
  const avgCorr = corrs.reduce((s, v) => s + v, 0) / corrs.length;
  log(`    Avg corr across all splits: ${avgCorr.toFixed(3)}`);
  if (avgCorr < 0.2) log("    -> LOW correlation: engines are genuinely uncorrelated — portfolio gives real diversification.");
  else if (avgCorr < 0.5) log("    -> MODERATE correlation: some shared regime exposure.");
  else log("    -> HIGH correlation: engines move together — diversification benefit limited.");

  const outDir = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "pf-long-rex.txt"), lines.join("\n") + "\n");
  log(`\nSaved to ${path.join(outDir, "pf-long-rex.txt")}`);
}

main();
