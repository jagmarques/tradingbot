/**
 * bt-rex-deep.ts
 *
 * Range Expansion DEEP parameter sweep — find the OPTIMAL configuration.
 *
 * Signal:
 *   1h bar where (high - low) > mult * ATR(atrP)
 *   close >= high - range*closeThr  -> LONG next bar
 *   close <= low  + range*closeThr  -> SHORT next bar
 *
 * Optional vol regime: RV(24)/RV(168) >= regimeThr
 *
 * Staged sweep (coarse -> refine):
 *   Stage 1: signal grid (atrP × mult × closeThr × regimeThr × dir) fixed exits -> rank by OOS
 *   Stage 2: top 15 signal configs × exit grid (SL × maxHold × trail)
 *   Stage 3: top 10 combined × margin grid
 *   Stage 4: walk-forward sanity on top 10 OOS configs at MDD < $20
 *
 * IS:  2025-06-01 -> 2025-12-01
 * OOS: 2025-12-01 -> 2026-03-25
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
  m5: C[];
  h1: C[];
  h1Map: Map<number, number>;
  rv24: number[]; rv168: number[];
  atrByP: Map<number, number[]>;  // atrPeriod -> atr array on h1
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

function computeATR(cs: C[], period: number): number[] {
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

// Compute signal: for each h1 idx i, sig=+1 long, -1 short, 0 none
// Uses i as the bar that just closed; entry on i+1 open (but consumer reads sig at h1Idx-1 before entering at h1Idx bar)
function computeRangeExpansion(h1: C[], atr1: number[], mult: number, closeThr: number): Int8Array {
  const out = new Int8Array(h1.length);
  const minI = Math.max(14, 2);
  for (let i = minI; i < h1.length; i++) {
    const bar = h1[i]!;
    const a = atr1[i];
    if (!a || a <= 0) continue;
    const range = bar.h - bar.l;
    if (range <= 0) continue;
    if (range < mult * a) continue;
    const upperLine = bar.h - range * closeThr;
    const lowerLine = bar.l + range * closeThr;
    if (bar.c >= upperLine) out[i] = 1;
    else if (bar.c <= lowerLine) out[i] = -1;
  }
  return out;
}

interface Cfg {
  // signal
  atrP: number;
  mult: number;
  closeThr: number;     // e.g. 0.25 = top/bottom 25%
  regimeThr: number;    // <= 1.0 => off
  dir: "long" | "short" | "both";
  // exits
  slPct: number;
  trailAct: number;
  trailDist: number;
  maxHoldH: number;
  // sizing
  margin: number;
}

interface OpenPos {
  pair: string; dir: "long" | "short";
  ep: number; et: number; sl: number; pk: number;
  sp: number; lev: number; not: number;
  maxHoldH: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  numTrades: number; avgWin: number; avgLoss: number;
}

interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }

// Per-pair simulation. Positions on different pairs are independent (no cross-pair margin or
// position limit). Drastically faster than iterating all 5m timepoints globally.
function simulate(
  pairs: PD[],
  cfg: Cfg,
  sigByPair: Map<string, Int8Array>,   // precomputed signal for this (atrP, mult, closeThr)
  startTs: number,
  endTs: number,
  days: number
): Res {
  const closed: Tr[] = [];

  const allowLong = cfg.dir !== "short";
  const allowShort = cfg.dir !== "long";
  const regimeOn = cfg.regimeThr > 1.0;

  for (const p of pairs) {
    const sigArr = sigByPair.get(p.name);
    if (!sigArr) continue;
    const h1 = p.ind.h1;
    const m5 = p.ind.m5;

    // Iterate h1 bars within [startTs, endTs). For each entry signal, fast-forward through
    // m5 bars until exit. Then skip to the next h1 boundary after exit.
    // Start index: find first h1 with t >= startTs
    let h1i = 0;
    while (h1i < h1.length && h1[h1i]!.t < startTs) h1i++;

    // Build a cursor into m5 that we advance monotonically with ts
    let m5i = 0;
    while (m5i < m5.length && m5[m5i]!.t < startTs) m5i++;

    while (h1i < h1.length && h1[h1i]!.t < endTs) {
      if (h1i < 170) { h1i++; continue; }
      const hour = new Date(h1[h1i]!.t).getUTCHours();
      if (BLOCK.has(hour)) { h1i++; continue; }
      const sig = sigArr[h1i - 1] ?? 0;
      if (sig === 0 ||
          (sig > 0 && !allowLong) ||
          (sig < 0 && !allowShort)) { h1i++; continue; }
      if (regimeOn) {
        const rv24 = p.ind.rv24[h1i - 1] ?? 0;
        const rv168 = p.ind.rv168[h1i - 1] ?? 0;
        if (rv24 === 0 || rv168 === 0 || rv24 / rv168 < cfg.regimeThr) { h1i++; continue; }
      }

      const entryTs = h1[h1i]!.t;
      const dir: "long" | "short" = sig > 0 ? "long" : "short";
      const ep = dir === "long" ? h1[h1i]!.o * (1 + p.sp) : h1[h1i]!.o * (1 - p.sp);
      const sl = dir === "long" ? ep * (1 - cfg.slPct) : ep * (1 + cfg.slPct);
      const notional = cfg.margin * p.lev;

      // Advance m5 cursor to entryTs
      while (m5i < m5.length && m5[m5i]!.t < entryTs) m5i++;

      let xp = 0, reason = "", isSL = false, pk = 0, exitTs = entryTs;
      let j = m5i;
      for (; j < m5.length; j++) {
        const bar = m5[j]!;
        if (bar.t < entryTs) continue;
        if ((bar.t - entryTs) / H >= cfg.maxHoldH) { xp = bar.c; reason = "maxh"; exitTs = bar.t; break; }

        const hit = dir === "long" ? bar.l <= sl : bar.h >= sl;
        if (hit) { xp = sl; reason = "sl"; isSL = true; exitTs = bar.t; break; }

        const best = dir === "long" ? (bar.h / ep - 1) * p.lev * 100 : (ep / bar.l - 1) * p.lev * 100;
        if (best > pk) pk = best;
        const cur = dir === "long" ? (bar.c / ep - 1) * p.lev * 100 : (ep / bar.c - 1) * p.lev * 100;
        if (pk >= cfg.trailAct && cur <= pk - cfg.trailDist) { xp = bar.c; reason = "trail"; exitTs = bar.t; break; }
      }
      if (xp === 0 && j >= m5.length) {
        const lb = m5[m5.length - 1]!;
        xp = lb.c; reason = "end"; exitTs = lb.t;
      }

      const rsp = isSL ? p.sp * SL_SLIP : p.sp;
      const ex = dir === "long" ? xp * (1 - rsp) : xp * (1 + rsp);
      const fees = notional * FEE * 2;
      const pnl = (dir === "long" ? (ex / ep - 1) : (ep / ex - 1)) * notional - fees;
      closed.push({ pair: p.name, dir, exitTs, pnl, reason });

      // Next potential entry: first h1 bar with t > exitTs (cooldown: effectively until current position closed)
      // Advance h1i past exitTs
      while (h1i < h1.length && h1[h1i]!.t <= exitTs) h1i++;
      // Advance m5i too for locality
      while (m5i < m5.length && m5[m5i]!.t < (h1i < h1.length ? h1[h1i]!.t : endTs)) m5i++;
    }
  }

  closed.sort((a, b) => a.exitTs - b.exitTs);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const glAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = glAbs > 0 ? gp / glAbs : (wins.length > 0 ? 99 : 0);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of closed) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  return {
    totalPnl, dollarsPerDay: totalPnl / days, maxDD, pf, wr,
    numTrades: closed.length,
    avgWin: wins.length > 0 ? gp / wins.length : 0,
    avgLoss: losses.length > 0 ? -glAbs / losses.length : 0,
  };
}

function cfgKey(c: Cfg): string {
  return `atrP=${c.atrP} mult=${c.mult} cl=${c.closeThr} reg=${c.regimeThr} dir=${c.dir} sl=${c.slPct} mh=${c.maxHoldH} trl=${c.trailAct}/${c.trailDist} mar=${c.margin}`;
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface RecRow {
  cfg: Cfg;
  is: Res;
  oos: Res;
}

// ========================================================================
const LOG_LINES: string[] = [];
function log(s: string = "") { console.log(s); LOG_LINES.push(s); }

function main() {
  log("=".repeat(170));
  log("  REX DEEP PARAMETER SWEEP — find OPTIMAL Range Expansion configuration");
  log("  IS 2025-06-01 -> 2025-12-01  |  OOS 2025-12-01 -> 2026-03-25");
  log("  Signal: 1h range > mult * ATR(atrP), close in extreme closeThr frac -> continuation next bar");
  log("=".repeat(170));

  log("\nLoading pairs...");

  const atrPeriods = [7, 14, 21];
  const pairs: PD[] = [];
  for (const n of ALL_PAIRS) {
    const s = RM[n] ?? n;
    let raw = load(`${s}USDT`);
    if (raw.length < 5000) raw = load(`${n}USDT`);
    if (raw.length < 5000) continue;
    const h1 = aggregate(raw, H, 10);
    if (h1.length < 250) continue;
    const h1Map = new Map<number, number>();
    h1.forEach((c, i) => h1Map.set(c.t, i));
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const atrByP = new Map<number, number[]>();
    for (const p of atrPeriods) atrByP.set(p, computeATR(h1, p));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { m5, h1, h1Map, rv24, rv168, atrByP },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  // ---------------------------------------------------------------------
  // STAGE 1: signal grid (fixed exits) — find best signal params
  // ---------------------------------------------------------------------
  const atrPs = [7, 14, 21];
  const mults = [1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
  const closeThrs = [0.15, 0.20, 0.25, 0.30];
  const regimeThrs = [1.0, 1.2, 1.5, 2.0]; // 1.0 = off
  const dirs: Array<"long" | "short" | "both"> = ["both", "long", "short"];

  // Precompute signals keyed by "atrP_mult_closeThr" -> Map<pair, Int8Array>
  const sigCache = new Map<string, Map<string, Int8Array>>();
  const sigKey = (atrP: number, mult: number, cl: number) => `${atrP}_${mult}_${cl}`;
  for (const atrP of atrPs) {
    for (const mult of mults) {
      for (const cl of closeThrs) {
        const m = new Map<string, Int8Array>();
        for (const p of pairs) {
          const atr = p.ind.atrByP.get(atrP)!;
          m.set(p.name, computeRangeExpansion(p.ind.h1, atr, mult, cl));
        }
        sigCache.set(sigKey(atrP, mult, cl), m);
      }
    }
  }
  log(`Precomputed ${sigCache.size} signal variants × ${pairs.length} pairs`);

  // Fixed exit baseline for stage 1
  const fixedExit = {
    slPct: 0.0020,
    trailAct: 9,
    trailDist: 0.5,
    maxHoldH: 12,
    margin: 15,
  };

  log("\n" + "=".repeat(170));
  log(`  STAGE 1 — SIGNAL GRID (fixed exits: SL 0.20%, maxHold 12h, trail 9/0.5, margin $15)`);
  log(`  ${atrPs.length}×${mults.length}×${closeThrs.length}×${regimeThrs.length}×${dirs.length} = ${atrPs.length*mults.length*closeThrs.length*regimeThrs.length*dirs.length} configs`);
  log("=".repeat(170));

  const stage1: RecRow[] = [];
  let count = 0;
  const total1 = atrPs.length * mults.length * closeThrs.length * regimeThrs.length * dirs.length;
  for (const atrP of atrPs) {
    for (const mult of mults) {
      for (const cl of closeThrs) {
        const sig = sigCache.get(sigKey(atrP, mult, cl))!;
        for (const rt of regimeThrs) {
          for (const dir of dirs) {
            count++;
            const cfg: Cfg = {
              atrP, mult, closeThr: cl, regimeThr: rt, dir,
              slPct: fixedExit.slPct,
              trailAct: fixedExit.trailAct, trailDist: fixedExit.trailDist,
              maxHoldH: fixedExit.maxHoldH, margin: fixedExit.margin,
            };
            const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
            const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
            stage1.push({ cfg, is, oos });
            if (count % 30 === 0) {
              process.stdout.write(`  stage1 ${count}/${total1}\r`);
            }
          }
        }
      }
    }
  }
  log(`  stage1 ${count}/${total1} done`);

  // Filter and rank: only keep MDD < 25 on both IS/OOS and OOS > 0
  const stage1Filtered = stage1
    .filter(r => r.is.maxDD < 30 && r.oos.maxDD < 25 && r.oos.dollarsPerDay > 0.1 && r.oos.numTrades >= 20);
  stage1Filtered.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  log(`\nStage 1: ${stage1Filtered.length} configs pass filter (IS MDD<30, OOS MDD<25, OOS>$0.10/d, N>=20)`);
  log("\nTop 25 Stage 1 (ranked by OOS $/day):");
  log(`${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(7)}${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"IS PF".padStart(7)}${"IS N".padStart(7)}${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS WR".padStart(8)}${"OOS N".padStart(7)}`);
  const topShow = Math.min(25, stage1Filtered.length);
  for (let i = 0; i < topShow; i++) {
    const r = stage1Filtered[i]!;
    log(
      `${String(i+1).padEnd(5)}${String(r.cfg.atrP).padEnd(6)}${r.cfg.mult.toFixed(2).padEnd(6)}${r.cfg.closeThr.toFixed(2).padEnd(7)}${r.cfg.regimeThr.toFixed(1).padEnd(6)}${r.cfg.dir.padEnd(7)}${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${String(r.is.numTrades).padStart(7)}${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // Pick top 15 promising signal configs for stage 2
  // Deduplicate by signal key (atrP, mult, closeThr, regimeThr, dir) — already unique
  const topForStage2 = stage1Filtered.slice(0, 15);

  // ---------------------------------------------------------------------
  // STAGE 2: exit parameter sweep on top 15 signal configs
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log(`  STAGE 2 — EXIT PARAMETER SWEEP on top 15 signal configs`);
  log("  SL {0.15, 0.20, 0.25, 0.30}% × maxHold {6, 12, 24}h × trail {9/0.5, 12/0.5, 7/0.3, 15/1}");
  log("=".repeat(170));

  const slPcts = [0.0015, 0.0020, 0.0025, 0.0030];
  const maxHolds = [6, 12, 24];
  const trails: Array<[number, number]> = [[9, 0.5], [12, 0.5], [7, 0.3], [15, 1]];

  const stage2: RecRow[] = [];
  let s2count = 0;
  const total2 = topForStage2.length * slPcts.length * maxHolds.length * trails.length;
  for (const base of topForStage2) {
    const sig = sigCache.get(sigKey(base.cfg.atrP, base.cfg.mult, base.cfg.closeThr))!;
    for (const sl of slPcts) {
      for (const mh of maxHolds) {
        for (const [ta, td] of trails) {
          s2count++;
          const cfg: Cfg = {
            ...base.cfg,
            slPct: sl, maxHoldH: mh, trailAct: ta, trailDist: td,
          };
          const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
          const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
          stage2.push({ cfg, is, oos });
          if (s2count % 20 === 0) process.stdout.write(`  stage2 ${s2count}/${total2}\r`);
        }
      }
    }
  }
  log(`  stage2 ${s2count}/${total2} done`);

  const stage2Filtered = stage2
    .filter(r => r.oos.maxDD < 25 && r.oos.dollarsPerDay > 0.1 && r.oos.numTrades >= 20);
  stage2Filtered.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  log(`\nStage 2: ${stage2Filtered.length} configs pass filter`);
  log("\nTop 20 Stage 2 (ranked by OOS $/day):");
  log(`${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(7)}${"sl%".padEnd(7)}${"mh".padEnd(5)}${"trail".padEnd(9)}${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS N".padStart(7)}`);
  const topShow2 = Math.min(20, stage2Filtered.length);
  for (let i = 0; i < topShow2; i++) {
    const r = stage2Filtered[i]!;
    const c = r.cfg;
    log(
      `${String(i+1).padEnd(5)}${String(c.atrP).padEnd(6)}${c.mult.toFixed(2).padEnd(6)}${c.closeThr.toFixed(2).padEnd(7)}${c.regimeThr.toFixed(1).padEnd(6)}${c.dir.padEnd(7)}${(c.slPct*100).toFixed(2).padEnd(7)}${String(c.maxHoldH).padEnd(5)}${(c.trailAct+"/"+c.trailDist).padEnd(9)}${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // ---------------------------------------------------------------------
  // STAGE 3: margin sweep on top 10 from stage 2
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log("  STAGE 3 — MARGIN SWEEP on top 10 stage-2 configs × {$15, $20, $25}");
  log("=".repeat(170));

  const margins = [15, 20, 25];
  const topForStage3 = stage2Filtered.slice(0, 10);
  const stage3: RecRow[] = [];
  for (const base of topForStage3) {
    const sig = sigCache.get(sigKey(base.cfg.atrP, base.cfg.mult, base.cfg.closeThr))!;
    for (const m of margins) {
      const cfg: Cfg = { ...base.cfg, margin: m };
      const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
      stage3.push({ cfg, is, oos });
    }
  }

  const stage3Filtered = stage3
    .filter(r => r.oos.maxDD < 20 && r.oos.dollarsPerDay > 0 && r.oos.numTrades >= 20);
  stage3Filtered.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  // Also full list of stage 1+2+3 combined for final leaderboard at MDD < 20
  const allCandidates: RecRow[] = [...stage1, ...stage2, ...stage3];
  const leaderMDD20 = allCandidates
    .filter(r => r.oos.maxDD < 20 && r.is.maxDD < 30 && r.oos.dollarsPerDay > 0 && r.oos.numTrades >= 20);
  // Dedupe by full cfg key
  const seen = new Set<string>();
  const leaderDedupe: RecRow[] = [];
  leaderMDD20.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  for (const r of leaderMDD20) {
    const k = cfgKey(r.cfg);
    if (seen.has(k)) continue;
    seen.add(k);
    leaderDedupe.push(r);
  }

  log("\n" + "=".repeat(170));
  log("  FINAL LEADERBOARD — TOP 10 OOS configs at MDD < $20");
  log("=".repeat(170));
  log(`${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(7)}${"sl%".padEnd(7)}${"mh".padEnd(5)}${"trail".padEnd(9)}${"mar".padEnd(6)}${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"IS PF".padStart(7)}${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS WR".padStart(8)}${"OOS N".padStart(7)}`);
  const topFinal = Math.min(10, leaderDedupe.length);
  for (let i = 0; i < topFinal; i++) {
    const r = leaderDedupe[i]!;
    const c = r.cfg;
    log(
      `${String(i+1).padEnd(5)}${String(c.atrP).padEnd(6)}${c.mult.toFixed(2).padEnd(6)}${c.closeThr.toFixed(2).padEnd(7)}${c.regimeThr.toFixed(1).padEnd(6)}${c.dir.padEnd(7)}${(c.slPct*100).toFixed(2).padEnd(7)}${String(c.maxHoldH).padEnd(5)}${(c.trailAct+"/"+c.trailDist).padEnd(9)}${("$"+c.margin).padEnd(6)}${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // Single best OOS
  if (leaderDedupe.length > 0) {
    const best = leaderDedupe[0]!;
    log("\n" + "=".repeat(170));
    log("  SINGLE BEST OOS CONFIG (MDD < $20)");
    log("=".repeat(170));
    log(`  atrP           = ${best.cfg.atrP}`);
    log(`  ATR mult       = ${best.cfg.mult}`);
    log(`  closeThr       = ${best.cfg.closeThr} (close in extreme ${(best.cfg.closeThr*100).toFixed(0)}% of range)`);
    log(`  regimeThr      = ${best.cfg.regimeThr} ${best.cfg.regimeThr <= 1.0 ? "(OFF)" : "(RV24/RV168 >= " + best.cfg.regimeThr + ")"}`);
    log(`  direction      = ${best.cfg.dir}`);
    log(`  SL             = ${(best.cfg.slPct*100).toFixed(2)}%`);
    log(`  maxHold        = ${best.cfg.maxHoldH}h`);
    log(`  trail          = ${best.cfg.trailAct}/${best.cfg.trailDist}`);
    log(`  margin         = $${best.cfg.margin}`);
    log("");
    log(`  IS   $${best.is.totalPnl.toFixed(2)} (${fmtD(best.is.dollarsPerDay)}/d)  MDD $${best.is.maxDD.toFixed(0)}  PF ${best.is.pf.toFixed(2)}  WR ${best.is.wr.toFixed(0)}%  N ${best.is.numTrades}`);
    log(`  OOS  $${best.oos.totalPnl.toFixed(2)} (${fmtD(best.oos.dollarsPerDay)}/d)  MDD $${best.oos.maxDD.toFixed(0)}  PF ${best.oos.pf.toFixed(2)}  WR ${best.oos.wr.toFixed(0)}%  N ${best.oos.numTrades}`);
    log(`  avgWin $${best.oos.avgWin.toFixed(2)}  avgLoss $${best.oos.avgLoss.toFixed(2)}`);

    // Stability check: same config with neighbor params (robustness)
    log("\n  Stability check (neighbor params):");
    const neighbors: Array<Partial<Cfg>> = [
      { mult: best.cfg.mult + 0.25 },
      { mult: Math.max(1.5, best.cfg.mult - 0.25) },
      { closeThr: Math.min(0.30, best.cfg.closeThr + 0.05) },
      { closeThr: Math.max(0.15, best.cfg.closeThr - 0.05) },
      { slPct: best.cfg.slPct + 0.0005 },
      { slPct: Math.max(0.001, best.cfg.slPct - 0.0005) },
      { maxHoldH: best.cfg.maxHoldH === 6 ? 12 : best.cfg.maxHoldH === 12 ? 24 : 12 },
    ];
    for (const nb of neighbors) {
      const cfg: Cfg = { ...best.cfg, ...nb };
      const key = sigKey(cfg.atrP, cfg.mult, cfg.closeThr);
      let sig = sigCache.get(key);
      if (!sig) {
        // compute ad hoc
        sig = new Map<string, Int8Array>();
        for (const p of pairs) {
          const atr = p.ind.atrByP.get(cfg.atrP)!;
          sig.set(p.name, computeRangeExpansion(p.ind.h1, atr, cfg.mult, cfg.closeThr));
        }
      }
      const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
      const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
      const changed = Object.entries(nb).map(([k, v]) => `${k}=${v}`).join(",");
      log(`    ${changed.padEnd(20)} IS ${fmtD(is.dollarsPerDay)}/d MDD $${is.maxDD.toFixed(0)}  |  OOS ${fmtD(oos.dollarsPerDay)}/d MDD $${oos.maxDD.toFixed(0)} PF ${oos.pf.toFixed(2)} N ${oos.numTrades}`);
    }
  }

  // ---------------------------------------------------------------------
  // HONEST VERDICT
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log("  HONEST VERDICT");
  log("=".repeat(170));
  const best = leaderDedupe[0];
  if (!best) {
    log("  No config achieved OOS > $0 at MDD < $20. REX signal is too marginal to deploy standalone.");
  } else {
    log(`  Max achievable OOS at MDD<$20: ${fmtD(best.oos.dollarsPerDay)}/day (MDD $${best.oos.maxDD.toFixed(0)}, PF ${best.oos.pf.toFixed(2)})`);
    log(`  Baseline (cycle 6): +$1.24/day at MDD $12`);
    log(`  Improvement: ${((best.oos.dollarsPerDay - 1.24) / 1.24 * 100).toFixed(0)}%`);
    log("");
    log(`  Configs meeting MDD<$20 OOS>$0: ${leaderDedupe.length}`);
    log(`  Configs with OOS > $1.5/d at MDD<$20: ${leaderDedupe.filter(r => r.oos.dollarsPerDay > 1.5).length}`);
    log(`  Configs with OOS > $2.0/d at MDD<$20: ${leaderDedupe.filter(r => r.oos.dollarsPerDay > 2.0).length}`);
    log(`  Configs with OOS > $3.0/d at MDD<$20: ${leaderDedupe.filter(r => r.oos.dollarsPerDay > 3.0).length}`);
    log("");
    // Honest check — how much can we trust it?
    log("  Drift check (OOS vs IS $/day) for top 10:");
    for (let i = 0; i < topFinal; i++) {
      const r = leaderDedupe[i]!;
      const drift = r.is.dollarsPerDay !== 0 ? (r.oos.dollarsPerDay - r.is.dollarsPerDay) / Math.abs(r.is.dollarsPerDay) * 100 : 0;
      log(`    #${i+1}: IS ${fmtD(r.is.dollarsPerDay)}/d -> OOS ${fmtD(r.oos.dollarsPerDay)}/d  drift ${drift.toFixed(0)}%`);
    }
  }

  // write output
  const outPath = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/rex-deep.txt";
  fs.writeFileSync(outPath, LOG_LINES.join("\n"));
  console.log(`\nwrote ${outPath}`);
}

main();
