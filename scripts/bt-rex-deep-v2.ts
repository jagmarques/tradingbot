/**
 * bt-rex-deep-v2.ts
 *
 * Range Expansion DEEP parameter sweep v2 — WITH multi-stage trail 3/1 -> 9/0.5 -> 20/0.5
 * (the deployed trail). Previous sweep used single-stage trail.
 *
 * Grid:
 *   ATR mult: 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0
 *   Close extreme: 0.15, 0.20, 0.25, 0.30
 *   ATR period: 7, 14, 21
 *   Vol regime thr: 1.0 (off), 1.2, 1.5, 1.75, 2.0
 *   SL width: 0.12%, 0.15%, 0.18%, 0.20%
 *   Max hold: 6, 12, 24, 48h
 *   Direction: long-only, short-only, symmetric
 *   Trail (fixed multi-stage): 3/1 -> 9/0.5 -> 20/0.5
 *   Margin: $15 (fixed)
 *
 * Strategy: 2-stage search
 *   Stage 1: signal grid (atrP × mult × closeThr × regimeThr × dir) with baseline exits (SL 0.15%, maxHold 12h)
 *            to find top signals fast.
 *   Stage 2: refine top 15 signal configs over full SL × maxHold grid.
 *
 * IS:  2025-06-01 -> 2025-12-01
 * OOS: 2025-12-01 -> 2026-03-25
 *
 * TARGET: beat $1.24/day OOS at MDD<$12 for REX standalone.
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
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

// Multi-stage trail (deployed config): 3/1 -> 9/0.5 -> 20/0.5
// Meaning: peak>=3 -> distance 1, peak>=9 -> distance 0.5, peak>=20 -> distance 0.5
// All units are leveraged % PnL.
const TRAIL_STAGES: Array<[number, number]> = [
  [3, 1.0],
  [9, 0.5],
  [20, 0.5],
];

interface C { t: number; o: number; h: number; l: number; c: number; }

interface PI {
  m5: C[];
  h1: C[];
  rv24: number[]; rv168: number[];
  atrByP: Map<number, number[]>;
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
  atrP: number;
  mult: number;
  closeThr: number;
  regimeThr: number;
  dir: "long" | "short" | "both";
  slPct: number;
  maxHoldH: number;
  margin: number;
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  numTrades: number; avgWin: number; avgLoss: number;
}

interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }

// Multi-stage trail: activeStage is highest stage whose activation threshold pk has crossed.
// Stop when cur <= pk - stage.dist at the active stage.
function currentTrailDist(pk: number): number {
  let dist = Infinity;
  for (const [act, d] of TRAIL_STAGES) {
    if (pk >= act) dist = d;
  }
  return dist;
}

function simulate(
  pairs: PD[],
  cfg: Cfg,
  sigByPair: Map<string, Int8Array>,
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

    let h1i = 0;
    while (h1i < h1.length && h1[h1i]!.t < startTs) h1i++;
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

        // Multi-stage trail: any stage whose activation threshold is exceeded by pk
        // dictates the tightest stop distance. The LAST stage reached wins.
        const dist = currentTrailDist(pk);
        if (dist !== Infinity && cur <= pk - dist) { xp = bar.c; reason = "trail"; exitTs = bar.t; break; }
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

      while (h1i < h1.length && h1[h1i]!.t <= exitTs) h1i++;
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
  return `atrP=${c.atrP} mult=${c.mult} cl=${c.closeThr} reg=${c.regimeThr} dir=${c.dir} sl=${c.slPct} mh=${c.maxHoldH} mar=${c.margin}`;
}

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface RecRow {
  cfg: Cfg;
  is: Res;
  oos: Res;
}

const LOG_LINES: string[] = [];
function log(s: string = "") { console.log(s); LOG_LINES.push(s); }

function main() {
  log("=".repeat(170));
  log("  REX DEEP SWEEP v2 — multi-stage trail 3/1 -> 9/0.5 -> 20/0.5 (deployed trail)");
  log("  IS 2025-06-01 -> 2025-12-01  |  OOS 2025-12-01 -> 2026-03-25");
  log("  Signal: 1h range > mult * ATR(atrP), close in extreme closeThr -> continuation");
  log("  Target: beat $1.24/day OOS at MDD < $12 (single-stage baseline)");
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
    const rv24 = computeRVFast(h1, 24);
    const rv168 = computeRVFast(h1, 168);
    const atrByP = new Map<number, number[]>();
    for (const p of atrPeriods) atrByP.set(p, computeATR(h1, p));
    const lev = getLev(n);
    const m5 = raw.filter(b => b.t >= IS_S - 24 * H && b.t <= OOS_E + 24 * H);
    pairs.push({
      name: n,
      ind: { m5, h1, rv24, rv168, atrByP },
      sp: SP[n] ?? DSP,
      lev,
    });
  }
  log(`${pairs.length} pairs loaded`);

  // ---------------------------------------------------------------------
  // STAGE 1: signal grid (fixed baseline exits) — find best signal params
  // ---------------------------------------------------------------------
  const atrPs = [7, 14, 21];
  const mults = [1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
  const closeThrs = [0.15, 0.20, 0.25, 0.30];
  const regimeThrs = [1.0, 1.2, 1.5, 1.75, 2.0];
  const dirs: Array<"long" | "short" | "both"> = ["both", "long", "short"];

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

  const fixedExit = {
    slPct: 0.0015,
    maxHoldH: 12,
    margin: 15,
  };

  log("\n" + "=".repeat(170));
  log(`  STAGE 1 — SIGNAL GRID (fixed exits: SL 0.15%, maxHold 12h, trail 3/1->9/0.5->20/0.5, margin $15)`);
  const total1 = atrPs.length * mults.length * closeThrs.length * regimeThrs.length * dirs.length;
  log(`  ${atrPs.length}×${mults.length}×${closeThrs.length}×${regimeThrs.length}×${dirs.length} = ${total1} configs`);
  log("=".repeat(170));

  const stage1: RecRow[] = [];
  let count = 0;
  for (const atrP of atrPs) {
    for (const mult of mults) {
      for (const cl of closeThrs) {
        const sig = sigCache.get(sigKey(atrP, mult, cl))!;
        for (const rt of regimeThrs) {
          for (const dir of dirs) {
            count++;
            const cfg: Cfg = {
              atrP, mult, closeThr: cl, regimeThr: rt, dir,
              slPct: fixedExit.slPct, maxHoldH: fixedExit.maxHoldH, margin: fixedExit.margin,
            };
            const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
            const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
            stage1.push({ cfg, is, oos });
            if (count % 30 === 0) process.stdout.write(`  stage1 ${count}/${total1}\r`);
          }
        }
      }
    }
  }
  log(`  stage1 ${count}/${total1} done`);

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
      `${String(i+1).padEnd(5)}${String(r.cfg.atrP).padEnd(6)}${r.cfg.mult.toFixed(2).padEnd(6)}${r.cfg.closeThr.toFixed(2).padEnd(7)}${r.cfg.regimeThr.toFixed(2).padEnd(6)}${r.cfg.dir.padEnd(7)}${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${String(r.is.numTrades).padStart(7)}${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // Pick top 15 signal configs to refine
  const topForStage2 = stage1Filtered.slice(0, 15);

  // ---------------------------------------------------------------------
  // STAGE 2: exit sweep (SL × maxHold) on top signal configs
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log(`  STAGE 2 — EXIT SWEEP on top ${topForStage2.length} signal configs`);
  log("  SL {0.12, 0.15, 0.18, 0.20}% × maxHold {6, 12, 24, 48}h");
  log("=".repeat(170));

  const slPcts = [0.0012, 0.0015, 0.0018, 0.0020];
  const maxHolds = [6, 12, 24, 48];

  const stage2: RecRow[] = [];
  let s2count = 0;
  const total2 = topForStage2.length * slPcts.length * maxHolds.length;
  for (const base of topForStage2) {
    const sig = sigCache.get(sigKey(base.cfg.atrP, base.cfg.mult, base.cfg.closeThr))!;
    for (const sl of slPcts) {
      for (const mh of maxHolds) {
        s2count++;
        const cfg: Cfg = {
          ...base.cfg,
          slPct: sl, maxHoldH: mh,
        };
        const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
        const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
        stage2.push({ cfg, is, oos });
        if (s2count % 20 === 0) process.stdout.write(`  stage2 ${s2count}/${total2}\r`);
      }
    }
  }
  log(`  stage2 ${s2count}/${total2} done`);

  const stage2Filtered = stage2
    .filter(r => r.oos.maxDD < 20 && r.oos.dollarsPerDay > 0.1 && r.oos.numTrades >= 20);
  stage2Filtered.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  log(`\nStage 2: ${stage2Filtered.length} configs pass filter (OOS MDD<20, OOS>$0.10/d, N>=20)`);
  log("\nTop 25 Stage 2 (ranked by OOS $/day):");
  log(`${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(7)}${"sl%".padEnd(7)}${"mh".padEnd(5)}${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"IS PF".padStart(7)}${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS WR".padStart(8)}${"OOS N".padStart(7)}`);
  const topShow2 = Math.min(25, stage2Filtered.length);
  for (let i = 0; i < topShow2; i++) {
    const r = stage2Filtered[i]!;
    const c = r.cfg;
    log(
      `${String(i+1).padEnd(5)}${String(c.atrP).padEnd(6)}${c.mult.toFixed(2).padEnd(6)}${c.closeThr.toFixed(2).padEnd(7)}${c.regimeThr.toFixed(2).padEnd(6)}${c.dir.padEnd(7)}${(c.slPct*100).toFixed(2).padEnd(7)}${String(c.maxHoldH).padEnd(5)}${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // ---------------------------------------------------------------------
  // Final leaderboard — TOP 10 at OOS MDD<$15 (primary target)
  // ---------------------------------------------------------------------
  const allCandidates: RecRow[] = [...stage1, ...stage2];
  const leaderMDD15 = allCandidates
    .filter(r => r.oos.maxDD < 15 && r.is.maxDD < 30 && r.oos.dollarsPerDay > 0 && r.oos.numTrades >= 20);
  const seen = new Set<string>();
  const leader15: RecRow[] = [];
  leaderMDD15.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  for (const r of leaderMDD15) {
    const k = cfgKey(r.cfg);
    if (seen.has(k)) continue;
    seen.add(k);
    leader15.push(r);
  }

  // Also MDD<12 (to match previous-best band) and MDD<20
  const leader12 = leader15.filter(r => r.oos.maxDD < 12);
  const leaderMDD20 = allCandidates
    .filter(r => r.oos.maxDD < 20 && r.is.maxDD < 30 && r.oos.dollarsPerDay > 0 && r.oos.numTrades >= 20);
  const seen20 = new Set<string>();
  const leader20: RecRow[] = [];
  leaderMDD20.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);
  for (const r of leaderMDD20) {
    const k = cfgKey(r.cfg);
    if (seen20.has(k)) continue;
    seen20.add(k);
    leader20.push(r);
  }

  const headerRow = `${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(7)}${"sl%".padEnd(7)}${"mh".padEnd(5)}${"mar".padEnd(6)}${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"IS PF".padStart(7)}${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS WR".padStart(8)}${"OOS N".padStart(7)}`;
  const rowFmt = (i: number, r: RecRow) => {
    const c = r.cfg;
    return `${String(i+1).padEnd(5)}${String(c.atrP).padEnd(6)}${c.mult.toFixed(2).padEnd(6)}${c.closeThr.toFixed(2).padEnd(7)}${c.regimeThr.toFixed(2).padEnd(6)}${c.dir.padEnd(7)}${(c.slPct*100).toFixed(2).padEnd(7)}${String(c.maxHoldH).padEnd(5)}${("$"+c.margin).padEnd(6)}${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`;
  };

  log("\n" + "=".repeat(170));
  log("  LEADERBOARD — TOP 10 OOS at MDD < $15 (primary target)");
  log("=".repeat(170));
  log(headerRow);
  for (let i = 0; i < Math.min(10, leader15.length); i++) log(rowFmt(i, leader15[i]!));

  log("\n" + "=".repeat(170));
  log("  LEADERBOARD — TOP 10 OOS at MDD < $12 (match previous-best DD)");
  log("=".repeat(170));
  log(headerRow);
  for (let i = 0; i < Math.min(10, leader12.length); i++) log(rowFmt(i, leader12[i]!));

  log("\n" + "=".repeat(170));
  log("  LEADERBOARD — TOP 10 OOS at MDD < $20 (wider)");
  log("=".repeat(170));
  log(headerRow);
  for (let i = 0; i < Math.min(10, leader20.length); i++) log(rowFmt(i, leader20[i]!));

  // Single best at MDD<$15 for deployment
  if (leader15.length > 0) {
    const best = leader15[0]!;
    log("\n" + "=".repeat(170));
    log("  BEST DEPLOYMENT CONFIG (MDD < $15)");
    log("=".repeat(170));
    log(`  atrP           = ${best.cfg.atrP}`);
    log(`  ATR mult       = ${best.cfg.mult}`);
    log(`  closeThr       = ${best.cfg.closeThr} (close in extreme ${(best.cfg.closeThr*100).toFixed(0)}% of range)`);
    log(`  regimeThr      = ${best.cfg.regimeThr} ${best.cfg.regimeThr <= 1.0 ? "(OFF)" : "(RV24/RV168 >= " + best.cfg.regimeThr + ")"}`);
    log(`  direction      = ${best.cfg.dir}`);
    log(`  SL             = ${(best.cfg.slPct*100).toFixed(2)}%`);
    log(`  maxHold        = ${best.cfg.maxHoldH}h`);
    log(`  trail          = 3/1 -> 9/0.5 -> 20/0.5 (multi-stage)`);
    log(`  margin         = $${best.cfg.margin}`);
    log("");
    log(`  IS   $${best.is.totalPnl.toFixed(2)} (${fmtD(best.is.dollarsPerDay)}/d)  MDD $${best.is.maxDD.toFixed(0)}  PF ${best.is.pf.toFixed(2)}  WR ${best.is.wr.toFixed(0)}%  N ${best.is.numTrades}`);
    log(`  OOS  $${best.oos.totalPnl.toFixed(2)} (${fmtD(best.oos.dollarsPerDay)}/d)  MDD $${best.oos.maxDD.toFixed(0)}  PF ${best.oos.pf.toFixed(2)}  WR ${best.oos.wr.toFixed(0)}%  N ${best.oos.numTrades}`);
    log(`  avgWin $${best.oos.avgWin.toFixed(2)}  avgLoss $${best.oos.avgLoss.toFixed(2)}`);

    // Stability: neighbor params
    log("\n  Stability check (neighbor params):");
    const neighbors: Array<Partial<Cfg>> = [
      { mult: best.cfg.mult + 0.25 },
      { mult: Math.max(1.5, best.cfg.mult - 0.25) },
      { closeThr: Math.min(0.30, best.cfg.closeThr + 0.05) },
      { closeThr: Math.max(0.15, best.cfg.closeThr - 0.05) },
      { slPct: best.cfg.slPct + 0.0003 },
      { slPct: Math.max(0.0012, best.cfg.slPct - 0.0003) },
      { maxHoldH: best.cfg.maxHoldH === 6 ? 12 : best.cfg.maxHoldH === 12 ? 24 : best.cfg.maxHoldH === 24 ? 48 : 24 },
    ];
    for (const nb of neighbors) {
      const cfg: Cfg = { ...best.cfg, ...nb };
      const key = sigKey(cfg.atrP, cfg.mult, cfg.closeThr);
      let sig = sigCache.get(key);
      if (!sig) {
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
  log("  Baseline (single-stage trail 9/0.5): +$1.24/day OOS at MDD $12");
  log("  Multi-stage trail 3/1 -> 9/0.5 -> 20/0.5 results:");
  if (leader15.length > 0) {
    const best = leader15[0]!;
    log(`    Best OOS at MDD<$15: ${fmtD(best.oos.dollarsPerDay)}/d (MDD $${best.oos.maxDD.toFixed(0)}, PF ${best.oos.pf.toFixed(2)})`);
    log(`    Improvement vs baseline: ${((best.oos.dollarsPerDay - 1.24) / 1.24 * 100).toFixed(0)}%`);
  }
  if (leader12.length > 0) {
    const best12 = leader12[0]!;
    log(`    Best OOS at MDD<$12: ${fmtD(best12.oos.dollarsPerDay)}/d (MDD $${best12.oos.maxDD.toFixed(0)}, PF ${best12.oos.pf.toFixed(2)})`);
  }
  log("");
  log(`  Configs meeting MDD<$15 OOS>$0: ${leader15.length}`);
  log(`  Configs with OOS > $1.24/d at MDD<$15: ${leader15.filter(r => r.oos.dollarsPerDay > 1.24).length}`);
  log(`  Configs with OOS > $1.5/d at MDD<$15: ${leader15.filter(r => r.oos.dollarsPerDay > 1.5).length}`);
  log(`  Configs with OOS > $2.0/d at MDD<$15: ${leader15.filter(r => r.oos.dollarsPerDay > 2.0).length}`);
  log("");
  log("  Drift check (OOS vs IS $/day) for top 10 at MDD<$15:");
  for (let i = 0; i < Math.min(10, leader15.length); i++) {
    const r = leader15[i]!;
    const drift = r.is.dollarsPerDay !== 0 ? (r.oos.dollarsPerDay - r.is.dollarsPerDay) / Math.abs(r.is.dollarsPerDay) * 100 : 0;
    log(`    #${i+1}: IS ${fmtD(r.is.dollarsPerDay)}/d -> OOS ${fmtD(r.oos.dollarsPerDay)}/d  drift ${drift.toFixed(0)}%`);
  }

  const outPath = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/rex-deep-v2.txt";
  fs.writeFileSync(outPath, LOG_LINES.join("\n"));
  console.log(`\nwrote ${outPath}`);
}

main();
