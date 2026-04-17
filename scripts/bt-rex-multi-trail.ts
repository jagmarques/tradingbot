/**
 * bt-rex-multi-trail.ts
 *
 * Range Expansion sweep WITH multi-stage trail [{a:20,d:0.5},{a:9,d:0.5},{a:3,d:1.0}]
 *
 * Goal: Beat previous REX deep best ($1.24/day OOS MDD $12, mult=2.0 single trail 9/0.5).
 * Target: $1.40+/day OOS MDD<$12 with multi-stage trail.
 *
 * Grid:
 *   atrP        {7, 14}
 *   mult        {1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0}
 *   closeThr    {0.15, 0.20, 0.25, 0.30}
 *   regimeThr   {1.0, 1.2, 1.5, 2.0}
 *   dir         {both, long}           (GARCH went long-only — test REX long-only too)
 *   maxHoldH    {8, 12, 24}
 *   SL fixed    0.15%
 *   margin fix  $15
 *   trail       MULTI [20/0.5, 9/0.5, 3/1.0]
 *
 * IS:  2025-06-01 -> 2025-12-01
 * OOS: 2025-12-01 -> 2026-03-25
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

interface TrailStage { act: number; dist: number; }

interface Cfg {
  atrP: number;
  mult: number;
  closeThr: number;
  regimeThr: number;
  dir: "long" | "short" | "both";
  slPct: number;
  maxHoldH: number;
  margin: number;
  trailStages: TrailStage[];
}

interface Res {
  totalPnl: number; dollarsPerDay: number; maxDD: number; pf: number; wr: number;
  numTrades: number; avgWin: number; avgLoss: number;
}
interface Tr { pair: string; dir: "long" | "short"; pnl: number; reason: string; exitTs: number; }

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
  const nStages = cfg.trailStages.length;

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

        // Multi-stage trail: find highest active stage
        if (nStages > 0) {
          let activeAct = -Infinity, activeDist = 0;
          for (let s = 0; s < nStages; s++) {
            const st = cfg.trailStages[s]!;
            if (pk >= st.act && st.act > activeAct) {
              activeAct = st.act;
              activeDist = st.dist;
            }
          }
          if (activeAct > -Infinity) {
            const cur = dir === "long" ? (bar.c / ep - 1) * p.lev * 100 : (ep / bar.c - 1) * p.lev * 100;
            if (cur <= pk - activeDist) { xp = bar.c; reason = "trail"; exitTs = bar.t; break; }
          }
        }
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

function fmtD(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

interface RecRow { cfg: Cfg; is: Res; oos: Res; }

const LOG_LINES: string[] = [];
function log(s: string = "") { console.log(s); LOG_LINES.push(s); }

function main() {
  log("=".repeat(170));
  log("  REX MULTI-TRAIL SWEEP — test multi-stage trail [20/0.5, 9/0.5, 3/1.0]");
  log("  IS 2025-06-01 -> 2025-12-01  |  OOS 2025-12-01 -> 2026-03-25");
  log("  Baseline to beat: $1.24/day OOS MDD $12 (mult=2.0, single trail 9/0.5)");
  log("  Target:           $1.40/day OOS MDD<$12 with multi-stage trail");
  log("=".repeat(170));

  log("\nLoading pairs...");

  const atrPeriods = [7, 14];
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

  // Fixed multi-stage trail per task spec
  const MULTI_TRAIL: TrailStage[] = [
    { act: 20, dist: 0.5 },
    { act: 9, dist: 0.5 },
    { act: 3, dist: 1.0 },
  ];
  log(`\nMulti-stage trail: [${MULTI_TRAIL.map(s => `{a:${s.act},d:${s.dist}}`).join(", ")}]`);
  log("Stage logic: highest active (pk >= act) stage applies its dist");

  // Grid
  const atrPs = [7, 14];
  const mults = [1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
  const closeThrs = [0.15, 0.20, 0.25, 0.30];
  const regimeThrs = [1.0, 1.2, 1.5, 2.0];
  const dirs: Array<"long" | "both"> = ["both", "long"];
  const maxHolds = [8, 12, 24];
  const SL_PCT = 0.0015;   // 0.15% as spec
  const MARGIN = 15;

  // Precompute signals
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

  const total = atrPs.length * mults.length * closeThrs.length * regimeThrs.length * dirs.length * maxHolds.length;
  log("\n" + "=".repeat(170));
  log(`  FULL GRID — ${atrPs.length}×${mults.length}×${closeThrs.length}×${regimeThrs.length}×${dirs.length}×${maxHolds.length} = ${total} configs`);
  log(`  fixed: SL ${(SL_PCT*100).toFixed(2)}%, margin $${MARGIN}, multi-trail [20/0.5, 9/0.5, 3/1.0]`);
  log("=".repeat(170));

  const all: RecRow[] = [];
  let count = 0;
  const t0 = Date.now();
  for (const atrP of atrPs) {
    for (const mult of mults) {
      for (const cl of closeThrs) {
        const sig = sigCache.get(sigKey(atrP, mult, cl))!;
        for (const rt of regimeThrs) {
          for (const dir of dirs) {
            for (const mh of maxHolds) {
              count++;
              const cfg: Cfg = {
                atrP, mult, closeThr: cl, regimeThr: rt, dir,
                slPct: SL_PCT, maxHoldH: mh, margin: MARGIN,
                trailStages: MULTI_TRAIL,
              };
              const is = simulate(pairs, cfg, sig, IS_S, IS_E, IS_D);
              const oos = simulate(pairs, cfg, sig, OOS_S, OOS_E, OOS_D);
              all.push({ cfg, is, oos });
              if (count % 25 === 0) {
                const pct = (count / total * 100).toFixed(0);
                process.stdout.write(`  ${count}/${total} (${pct}%)\r`);
              }
            }
          }
        }
      }
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  log(`  ${count}/${total} done in ${elapsed}s`);

  // ---------------------------------------------------------------------
  // Report 1: Top 10 OOS at MDD < $15
  // ---------------------------------------------------------------------
  const filtered15 = all
    .filter(r => r.is.maxDD < 30 && r.oos.maxDD < 15 && r.oos.dollarsPerDay > 0 && r.oos.numTrades >= 15);
  filtered15.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  log("\n" + "=".repeat(170));
  log(`  TOP 10 OOS at MDD < $15  (${filtered15.length} qualifying configs)`);
  log("=".repeat(170));
  log(
    `${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(6)}${"mh".padEnd(5)}` +
    `${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"IS PF".padStart(7)}${"IS N".padStart(7)}` +
    `${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS WR".padStart(8)}${"OOS N".padStart(7)}`
  );
  const top10 = Math.min(10, filtered15.length);
  for (let i = 0; i < top10; i++) {
    const r = filtered15[i]!;
    const c = r.cfg;
    log(
      `${String(i+1).padEnd(5)}${String(c.atrP).padEnd(6)}${c.mult.toFixed(2).padEnd(6)}${c.closeThr.toFixed(2).padEnd(7)}${c.regimeThr.toFixed(1).padEnd(6)}${c.dir.padEnd(6)}${String(c.maxHoldH).padEnd(5)}` +
      `${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${String(r.is.numTrades).padStart(7)}` +
      `${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // ---------------------------------------------------------------------
  // Report 2: Top 10 at MDD < $12 (tighter)
  // ---------------------------------------------------------------------
  const filtered12 = all
    .filter(r => r.is.maxDD < 30 && r.oos.maxDD < 12 && r.oos.dollarsPerDay > 0 && r.oos.numTrades >= 15);
  filtered12.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  log("\n" + "=".repeat(170));
  log(`  TOP 10 OOS at MDD < $12  (${filtered12.length} qualifying configs)`);
  log("=".repeat(170));
  log(
    `${"rank".padEnd(5)}${"atrP".padEnd(6)}${"mult".padEnd(6)}${"clThr".padEnd(7)}${"regT".padEnd(6)}${"dir".padEnd(6)}${"mh".padEnd(5)}` +
    `${"IS $/d".padStart(9)}${"IS MDD".padStart(9)}${"IS PF".padStart(7)}${"IS N".padStart(7)}` +
    `${"OOS $/d".padStart(10)}${"OOS MDD".padStart(10)}${"OOS PF".padStart(8)}${"OOS WR".padStart(8)}${"OOS N".padStart(7)}`
  );
  const top12 = Math.min(10, filtered12.length);
  for (let i = 0; i < top12; i++) {
    const r = filtered12[i]!;
    const c = r.cfg;
    log(
      `${String(i+1).padEnd(5)}${String(c.atrP).padEnd(6)}${c.mult.toFixed(2).padEnd(6)}${c.closeThr.toFixed(2).padEnd(7)}${c.regimeThr.toFixed(1).padEnd(6)}${c.dir.padEnd(6)}${String(c.maxHoldH).padEnd(5)}` +
      `${fmtD(r.is.dollarsPerDay).padStart(9)}${("$"+r.is.maxDD.toFixed(0)).padStart(9)}${r.is.pf.toFixed(2).padStart(7)}${String(r.is.numTrades).padStart(7)}` +
      `${fmtD(r.oos.dollarsPerDay).padStart(10)}${("$"+r.oos.maxDD.toFixed(0)).padStart(10)}${r.oos.pf.toFixed(2).padStart(8)}${r.oos.wr.toFixed(0).padStart(8)}${String(r.oos.numTrades).padStart(7)}`
    );
  }

  // ---------------------------------------------------------------------
  // Report 3: Long-only vs symmetric head-to-head at best shared params
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log("  LONG-ONLY vs BOTH — paired comparison at identical signal/hold params");
  log("=".repeat(170));

  const byKey = new Map<string, { both?: RecRow; long?: RecRow }>();
  for (const r of all) {
    const k = `${r.cfg.atrP}|${r.cfg.mult}|${r.cfg.closeThr}|${r.cfg.regimeThr}|${r.cfg.maxHoldH}`;
    let e = byKey.get(k);
    if (!e) { e = {}; byKey.set(k, e); }
    if (r.cfg.dir === "both") e.both = r;
    else if (r.cfg.dir === "long") e.long = r;
  }
  let longBetter = 0, bothBetter = 0, longProfit = 0, bothProfit = 0;
  let longMdd = 0, bothMdd = 0, pairs2 = 0;
  for (const e of byKey.values()) {
    if (!e.both || !e.long) continue;
    pairs2++;
    longProfit += e.long.oos.dollarsPerDay;
    bothProfit += e.both.oos.dollarsPerDay;
    longMdd += e.long.oos.maxDD;
    bothMdd += e.both.oos.maxDD;
    if (e.long.oos.dollarsPerDay > e.both.oos.dollarsPerDay) longBetter++;
    else bothBetter++;
  }
  log(`  pairs compared:         ${pairs2}`);
  log(`  long-only better OOS:   ${longBetter}/${pairs2} (${(longBetter/pairs2*100).toFixed(0)}%)`);
  log(`  symmetric better OOS:   ${bothBetter}/${pairs2} (${(bothBetter/pairs2*100).toFixed(0)}%)`);
  log(`  avg OOS $/day long:     ${fmtD(longProfit / pairs2)}`);
  log(`  avg OOS $/day both:     ${fmtD(bothProfit / pairs2)}`);
  log(`  avg OOS MDD long:       $${(longMdd / pairs2).toFixed(1)}`);
  log(`  avg OOS MDD both:       $${(bothMdd / pairs2).toFixed(1)}`);

  // Best of each direction at MDD < $15
  const longBest = filtered15.filter(r => r.cfg.dir === "long")[0];
  const bothBest = filtered15.filter(r => r.cfg.dir === "both")[0];
  log("");
  log("  Best long-only (MDD<$15):");
  if (longBest) {
    const c = longBest.cfg;
    log(`    atrP=${c.atrP} mult=${c.mult} cl=${c.closeThr} reg=${c.regimeThr} mh=${c.maxHoldH}h  ->  OOS ${fmtD(longBest.oos.dollarsPerDay)}/d MDD $${longBest.oos.maxDD.toFixed(0)} PF ${longBest.oos.pf.toFixed(2)} N ${longBest.oos.numTrades}`);
  } else log("    none");
  log("  Best symmetric (MDD<$15):");
  if (bothBest) {
    const c = bothBest.cfg;
    log(`    atrP=${c.atrP} mult=${c.mult} cl=${c.closeThr} reg=${c.regimeThr} mh=${c.maxHoldH}h  ->  OOS ${fmtD(bothBest.oos.dollarsPerDay)}/d MDD $${bothBest.oos.maxDD.toFixed(0)} PF ${bothBest.oos.pf.toFixed(2)} N ${bothBest.oos.numTrades}`);
  } else log("    none");

  // ---------------------------------------------------------------------
  // Report 4: Deploy-ready candidate  (best OOS at MDD<$12 + IS sanity)
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log("  DEPLOY-READY CANDIDATE — best OOS at MDD<$12 with IS PF>=1.3 and no direction blowup");
  log("=".repeat(170));

  const deployable = all
    .filter(r =>
      r.oos.maxDD < 12 &&
      r.is.maxDD < 25 &&
      r.oos.dollarsPerDay > 0 &&
      r.is.dollarsPerDay > 0 &&
      r.oos.numTrades >= 20 &&
      r.is.numTrades >= 30 &&
      r.is.pf >= 1.3
    );
  deployable.sort((a, b) => b.oos.dollarsPerDay - a.oos.dollarsPerDay);

  if (deployable.length === 0) {
    log("  NO deploy-ready config found (insufficient robustness).");
  } else {
    const best = deployable[0]!;
    const c = best.cfg;
    log(`  atrP           = ${c.atrP}`);
    log(`  ATR mult       = ${c.mult}`);
    log(`  closeThr       = ${c.closeThr}`);
    log(`  regimeThr      = ${c.regimeThr}${c.regimeThr <= 1.0 ? " (OFF)" : ""}`);
    log(`  direction      = ${c.dir}`);
    log(`  SL             = ${(c.slPct*100).toFixed(2)}%`);
    log(`  maxHold        = ${c.maxHoldH}h`);
    log(`  trail          = MULTI [20/0.5, 9/0.5, 3/1.0]`);
    log(`  margin         = $${c.margin}`);
    log("");
    log(`  IS   ${fmtD(best.is.dollarsPerDay)}/d  MDD $${best.is.maxDD.toFixed(0)}  PF ${best.is.pf.toFixed(2)}  WR ${best.is.wr.toFixed(0)}%  N ${best.is.numTrades}  total ${fmtD(best.is.totalPnl)}`);
    log(`  OOS  ${fmtD(best.oos.dollarsPerDay)}/d  MDD $${best.oos.maxDD.toFixed(0)}  PF ${best.oos.pf.toFixed(2)}  WR ${best.oos.wr.toFixed(0)}%  N ${best.oos.numTrades}  total ${fmtD(best.oos.totalPnl)}`);
    log(`  avgWin ${fmtD(best.oos.avgWin)}   avgLoss ${fmtD(best.oos.avgLoss)}`);
  }

  // ---------------------------------------------------------------------
  // HONEST VERDICT
  // ---------------------------------------------------------------------
  log("\n" + "=".repeat(170));
  log("  HONEST VERDICT — multi-stage trail vs single-stage baseline");
  log("=".repeat(170));
  const BASELINE_OOS = 1.24;
  const BASELINE_MDD = 12;
  const best15 = filtered15[0];
  const best12 = filtered12[0];
  if (best15) {
    log(`  Best OOS at MDD<$15:   ${fmtD(best15.oos.dollarsPerDay)}/day  MDD $${best15.oos.maxDD.toFixed(0)}  PF ${best15.oos.pf.toFixed(2)}`);
  } else log("  Best OOS at MDD<$15:   none qualifying");
  if (best12) {
    log(`  Best OOS at MDD<$12:   ${fmtD(best12.oos.dollarsPerDay)}/day  MDD $${best12.oos.maxDD.toFixed(0)}  PF ${best12.oos.pf.toFixed(2)}`);
  } else log("  Best OOS at MDD<$12:   none qualifying");
  log(`  Baseline (single 9/0.5): +$${BASELINE_OOS.toFixed(2)}/day  MDD $${BASELINE_MDD}`);
  if (best12) {
    const gain = best12.oos.dollarsPerDay - BASELINE_OOS;
    const gainPct = gain / BASELINE_OOS * 100;
    log(`  Improvement (MDD<$12): ${fmtD(gain)}/day (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(0)}%)`);
  }
  if (best15) {
    const gain = best15.oos.dollarsPerDay - BASELINE_OOS;
    const gainPct = gain / BASELINE_OOS * 100;
    log(`  Improvement (MDD<$15): ${fmtD(gain)}/day (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(0)}%)`);
  }
  log("");
  log(`  Configs OOS > $1.24/d at MDD<$15: ${filtered15.filter(r => r.oos.dollarsPerDay > 1.24).length}`);
  log(`  Configs OOS > $1.40/d at MDD<$15: ${filtered15.filter(r => r.oos.dollarsPerDay > 1.40).length}`);
  log(`  Configs OOS > $1.24/d at MDD<$12: ${filtered12.filter(r => r.oos.dollarsPerDay > 1.24).length}`);
  log(`  Configs OOS > $1.40/d at MDD<$12: ${filtered12.filter(r => r.oos.dollarsPerDay > 1.40).length}`);

  const outPath = "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot/.company/backtester/rex-multi-trail.txt";
  fs.writeFileSync(outPath, LOG_LINES.join("\n") + "\n");
  console.log(`\nwrote ${outPath}`);
}

main();
