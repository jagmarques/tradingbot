/**
 * Devil's Advocate: Daily Donchian Breakout Stress Test
 *
 * Systematically tries to BREAK the strategy by testing for:
 * 1. Direction bias (long-only vs short-only)
 * 2. Random entry benchmark (1000 random entries)
 * 3. Regime split (6-month chunks)
 * 4. Spread sensitivity (2x and 3x spreads)
 * 5. Entry slippage sensitivity
 * 6. Survivorship bias (explicit note)
 * 7. Max-hold free lunch check
 * 8. Donchian vs SMA crossover comparison
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const FEE = 0.000_35;
const SIZE = 10;
const LEV = 10;
const NOT = SIZE * LEV;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, AVAX: 2.55e-4, ARB: 2.6e-4,
  ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

// Baseline params
const ENTRY_LB = 30;
const EXIT_LB = 15;
const ATR_MULT = 3;
const ATR_PER = 14;
const MAX_HOLD = 60;

// Periods
const FULL_START = new Date("2023-03-01").getTime(); // after warmup
const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Pos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdDays: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CD, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggDaily(bars: C[]): C[] {
  const grp = new Map<number, C[]>();
  for (const c of bars) {
    const dk = Math.floor(c.t / DAY) * DAY;
    const a = grp.get(dk) ?? [];
    a.push(c);
    grp.set(dk, a);
  }
  const out: C[] = [];
  for (const [ts, bs] of [...grp.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length < 12) continue;
    bs.sort((a, b) => a.t - b.t);
    out.push({
      t: ts,
      o: bs[0].o,
      h: Math.max(...bs.map(b => b.h)),
      l: Math.min(...bs.map(b => b.l)),
      c: bs[bs.length - 1].c,
    });
  }
  return out;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function donchHi(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let j = Math.max(0, idx - lb); j < idx; j++) mx = Math.max(mx, cs[j].h);
  return mx;
}

function donchLo(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let j = Math.max(0, idx - lb); j < idx; j++) mn = Math.min(mn, cs[j].l);
  return mn;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(
  pair: string, ep: number, xp: number, dir: "long"|"short",
  isSL: boolean, spreadMult = 1,
): number {
  const sp = (SPREAD[pair] ?? 4e-4) * spreadMult;
  const entryCost = ep * sp * (NOT / ep);
  const exitCost = xp * sp * (isSL ? 1.5 : 1) * (NOT / xp);
  const fees = NOT * FEE * 2;
  const raw = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  return raw - entryCost - exitCost - fees;
}

// ─── Strategy: Donchian Breakout ────────────────────────────────────
type DirFilter = "both" | "long" | "short";

function runDonchian(
  dailyData: Map<string, C[]>,
  startTs: number,
  endTs: number,
  dirFilter: DirFilter = "both",
  maxHold = MAX_HOLD,
  spreadMult = 1,
  entrySlipPct = 0,
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ENTRY_LB + ATR_PER + 5) continue;
    const atr = calcATR(cs, ATR_PER);
    let pos: Pos | null = null;
    const warmup = Math.max(ENTRY_LB, ATR_PER) + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Exit logic
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";
        const sp = (SPREAD[pair] ?? 4e-4) * spreadMult;

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * 1.5);
          reason = "stop-loss";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * 1.5);
          reason = "stop-loss";
        }

        if (!xp) {
          const eLow = donchLo(cs, i, EXIT_LB);
          const eHigh = donchHi(cs, i, EXIT_LB);
          if (pos.dir === "long" && bar.c < eLow) { xp = bar.c * (1 - sp); reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > eHigh) { xp = bar.c * (1 + sp); reason = "donchian-exit"; }
        }

        if (!xp && maxHold > 0 && holdDays >= maxHold) {
          const sp2 = (SPREAD[pair] ?? 4e-4) * spreadMult;
          xp = bar.c * (pos.dir === "long" ? (1 - sp2) : (1 + sp2));
          reason = "max-hold";
        }

        // maxHold=0 means no limit (infinite hold), still need exit channels/SL
        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL, spreadMult);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason, holdDays });
          }
          pos = null;
        }
      }

      // Entry logic
      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const hi = donchHi(cs, i - 1, ENTRY_LB);
        const lo = donchLo(cs, i - 1, ENTRY_LB);

        let dir: "long" | "short" | null = null;
        if (prev.c > hi) dir = "long";
        else if (prev.c < lo) dir = "short";
        if (!dir) continue;
        if (dirFilter !== "both" && dir !== dirFilter) continue;
        if (bar.t < startTs || bar.t >= endTs) continue;

        const sp = (SPREAD[pair] ?? 4e-4) * spreadMult;
        const slip = entrySlipPct / 100;
        const ep = dir === "long"
          ? bar.o * (1 + sp) * (1 + slip)
          : bar.o * (1 - sp) * (1 - slip);
        const sl = dir === "long"
          ? ep - ATR_MULT * prevATR
          : ep + ATR_MULT * prevATR;

        pos = { pair, dir, ep, et: bar.t, sl };
      }
    }
  }
  return trades;
}

// ─── SMA Cross Strategy (for comparison) ────────────────────────────
function runSMACross(
  dailyData: Map<string, C[]>,
  startTs: number,
  endTs: number,
  fastP = 30,
  slowP = 60,
): Tr[] {
  const trades: Tr[] = [];

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < slowP + ATR_PER + 5) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, fastP);
    const slow = calcSMA(closes, slowP);
    const atr = calcATR(cs, ATR_PER);

    let pos: Pos | null = null;
    const warmup = slowP + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";
        const sp = SPREAD[pair] ?? 4e-4;

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * 1.5);
          reason = "stop-loss";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * 1.5);
          reason = "stop-loss";
        }

        // SMA cross exit: fast crosses below slow (long), fast crosses above slow (short)
        if (!xp) {
          const prevFast = fast[i - 1];
          const prevSlow = slow[i - 1];
          const curFast = fast[i];
          const curSlow = slow[i];
          if (pos.dir === "long" && prevFast >= prevSlow && curFast < curSlow) {
            xp = bar.c * (1 - sp); reason = "sma-exit";
          } else if (pos.dir === "short" && prevFast <= prevSlow && curFast > curSlow) {
            xp = bar.c * (1 + sp); reason = "sma-exit";
          }
        }

        if (!xp && holdDays >= MAX_HOLD) {
          const sp2 = SPREAD[pair] ?? 4e-4;
          xp = bar.c * (pos.dir === "long" ? (1 - sp2) : (1 + sp2));
          reason = "max-hold";
        }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason, holdDays });
          }
          pos = null;
        }
      }

      // SMA cross entry
      if (!pos && i >= warmup) {
        const prevFast = fast[i - 2];
        const prevSlow = slow[i - 2];
        const curFast = fast[i - 1];
        const curSlow = slow[i - 1];
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;
        if (bar.t < startTs || bar.t >= endTs) continue;

        let dir: "long" | "short" | null = null;
        if (prevFast <= prevSlow && curFast > curSlow) dir = "long";
        else if (prevFast >= prevSlow && curFast < curSlow) dir = "short";
        if (!dir) continue;

        const sp = SPREAD[pair] ?? 4e-4;
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;

        pos = { pair, dir, ep, et: bar.t, sl };
      }
    }
  }
  return trades;
}

// ─── Random Entry Strategy ──────────────────────────────────────────
function runRandom(
  dailyData: Map<string, C[]>,
  startTs: number,
  endTs: number,
  nTrades: number,
  holdDistribution: number[],
  seed: number,
): Tr[] {
  // Simple seeded PRNG
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  // Collect all valid (pair, dayIndex) entry points in the window
  const validEntries: { pair: string; idx: number; cs: C[]; atr: number[] }[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ATR_PER + 30) continue;
    const atr = calcATR(cs, ATR_PER);
    for (let i = ATR_PER + 5; i < cs.length - 60; i++) {
      if (cs[i].t >= startTs && cs[i].t < endTs && atr[i - 1] > 0) {
        validEntries.push({ pair, idx: i, cs, atr });
      }
    }
  }

  if (validEntries.length === 0) return [];

  const trades: Tr[] = [];
  for (let n = 0; n < nTrades; n++) {
    const entryIdx = Math.floor(rand() * validEntries.length);
    const { pair, idx, cs, atr } = validEntries[entryIdx];
    const dir: "long" | "short" = rand() > 0.5 ? "long" : "short";

    // Pick hold period from distribution
    const holdIdx = Math.floor(rand() * holdDistribution.length);
    const holdTarget = holdDistribution[holdIdx];

    const sp = SPREAD[pair] ?? 4e-4;
    const ep = dir === "long" ? cs[idx].o * (1 + sp) : cs[idx].o * (1 - sp);
    const prevATR = atr[idx - 1];
    const sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;

    // Simulate trade with same SL/exit logic
    let xp = 0, reason = "", xtDay = 0;
    for (let j = idx; j < Math.min(cs.length, idx + holdTarget + 10); j++) {
      const bar = cs[j];
      const barsHeld = j - idx;

      if (dir === "long" && bar.l <= sl) {
        xp = sl * (1 - sp * 1.5); reason = "stop-loss"; xtDay = barsHeld; break;
      } else if (dir === "short" && bar.h >= sl) {
        xp = sl * (1 + sp * 1.5); reason = "stop-loss"; xtDay = barsHeld; break;
      }

      // Exit after hold target days
      if (barsHeld >= holdTarget) {
        xp = bar.c * (dir === "long" ? (1 - sp) : (1 + sp));
        reason = "time-exit"; xtDay = barsHeld; break;
      }
    }

    if (xp > 0) {
      const isSL = reason === "stop-loss";
      const pnl = tradePnl(pair, ep, xp, dir, isSL);
      trades.push({
        pair, dir, ep, xp,
        et: cs[idx].t, xt: cs[idx + xtDay]?.t ?? cs[idx].t,
        pnl, reason, holdDays: xtDay,
      });
    }
  }
  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wins: number; wr: number; pf: number; sharpe: number;
  total: number; perDay: number; avgWin: number; avgLoss: number;
  maxDD: number;
}

function calcMetrics(trades: Tr[]): Metrics {
  const z: Metrics = { n: 0, wins: 0, wr: 0, pf: 0, sharpe: 0, total: 0, perDay: 0, avgWin: 0, avgLoss: 0, maxDD: 0 };
  if (trades.length === 0) return z;

  const w = trades.filter(t => t.pnl > 0);
  const l = trades.filter(t => t.pnl <= 0);
  const gw = w.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(l.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // Daily Sharpe
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()].map(p => p / SIZE);
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) : 1;

  // Max drawdown
  let peak = 0, cum = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = Math.max(1, (lastT - firstT) / DAY);

  return {
    n: trades.length,
    wins: w.length,
    wr: w.length / trades.length * 100,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    total,
    perDay: total / days,
    avgWin: w.length > 0 ? gw / w.length : 0,
    avgLoss: l.length > 0 ? gl / l.length : 0,
    maxDD,
  };
}

function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function verdict(pass: boolean, warn: boolean): string {
  if (pass && !warn) return "PASS";
  if (warn) return "WARNING";
  return "FAIL";
}

// ─── Load Data ──────────────────────────────────────────────────────
console.log("================================================================");
console.log("  DEVIL'S ADVOCATE: DAILY DONCHIAN BREAKOUT STRESS TEST");
console.log("  Strategy: 30d entry / 15d exit / ATR x3 stop / 60d max hold");
console.log("  Cost: Taker 0.035%, spread map, 1.5x SL slippage, 10x lev");
console.log("================================================================\n");

console.log("Loading 5m data and aggregating to daily...");
const dailyData = new Map<string, C[]>();
for (const pair of PAIRS) {
  const raw = load5m(pair);
  if (raw.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  const daily = aggDaily(raw);
  dailyData.set(pair, daily);
  const first = new Date(daily[0].t).toISOString().slice(0, 10);
  const last = new Date(daily[daily.length - 1].t).toISOString().slice(0, 10);
  console.log(`  ${pair}: ${daily.length} daily bars (${first} to ${last})`);
}

// ─── Baseline ───────────────────────────────────────────────────────
console.log("\n--- Baseline run (full period + OOS) ---");
const baselineFull = runDonchian(dailyData, FULL_START, OOS_END);
const baselineOOS = runDonchian(dailyData, OOS_START, OOS_END);
const mFull = calcMetrics(baselineFull);
const mOOS = calcMetrics(baselineOOS);

console.log(`\nFull period: ${mFull.n} trades, WR ${mFull.wr.toFixed(1)}%, PF ${mFull.pf.toFixed(2)}, Sharpe ${mFull.sharpe.toFixed(2)}, Total ${fmtPnl(mFull.total)}, $/day ${fmtPnl(mFull.perDay)}`);
console.log(`OOS (Sep25+): ${mOOS.n} trades, WR ${mOOS.wr.toFixed(1)}%, PF ${mOOS.pf.toFixed(2)}, Sharpe ${mOOS.sharpe.toFixed(2)}, Total ${fmtPnl(mOOS.total)}, $/day ${fmtPnl(mOOS.perDay)}`);

// ================================================================
// TEST 1: Direction Bias
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 1: DIRECTION BIAS");
console.log("  If shorts dominate, strategy may just capture bear markets.");
console.log("================================================================\n");

const longFull = runDonchian(dailyData, FULL_START, OOS_END, "long");
const shortFull = runDonchian(dailyData, FULL_START, OOS_END, "short");
const longOOS = runDonchian(dailyData, OOS_START, OOS_END, "long");
const shortOOS = runDonchian(dailyData, OOS_START, OOS_END, "short");

const mlf = calcMetrics(longFull);
const msf = calcMetrics(shortFull);
const mlo = calcMetrics(longOOS);
const mso = calcMetrics(shortOOS);

console.log("Period        Dir     Trades    WR%      PF    Sharpe     Total    $/day    MaxDD");
console.log("-".repeat(90));
const rows = [
  { label: "Full", dir: "Long", m: mlf },
  { label: "Full", dir: "Short", m: msf },
  { label: "Full", dir: "Both", m: mFull },
  { label: "OOS", dir: "Long", m: mlo },
  { label: "OOS", dir: "Short", m: mso },
  { label: "OOS", dir: "Both", m: mOOS },
];
for (const r of rows) {
  console.log(
    `${r.label.padEnd(14)}${r.dir.padEnd(8)}${String(r.m.n).padStart(6)}  ${r.m.wr.toFixed(1).padStart(5)}%  ${r.m.pf.toFixed(2).padStart(6)}  ${r.m.sharpe.toFixed(2).padStart(6)}  ${fmtPnl(r.m.total).padStart(9)}  ${fmtPnl(r.m.perDay).padStart(7)}  ${fmtPnl(-r.m.maxDD).padStart(9)}`
  );
}

const longProfitable = mlf.total > 0;
const shortProfitable = msf.total > 0;
const longOOSProfitable = mlo.total > 0;
const shortOOSProfitable = mso.total > 0;
const dirBias = Math.abs(mlf.total - msf.total) / (Math.abs(mlf.total) + Math.abs(msf.total) + 1);

let test1Verdict: string;
if (longProfitable && shortProfitable && longOOSProfitable && shortOOSProfitable) {
  test1Verdict = "PASS";
} else if ((longProfitable || shortProfitable) && (longOOSProfitable || shortOOSProfitable)) {
  test1Verdict = "WARNING";
} else {
  test1Verdict = "FAIL";
}

console.log(`\nDirection bias ratio: ${(dirBias * 100).toFixed(1)}% (0% = perfectly balanced)`);
console.log(`Long profitable full: ${longProfitable ? "YES" : "NO"} | OOS: ${longOOSProfitable ? "YES" : "NO"}`);
console.log(`Short profitable full: ${shortProfitable ? "YES" : "NO"} | OOS: ${shortOOSProfitable ? "YES" : "NO"}`);
console.log(`\n>>> VERDICT: ${test1Verdict}`);
if (test1Verdict !== "PASS") {
  console.log(`    One or both directions are unprofitable. The strategy may be biased.`);
}

// ================================================================
// TEST 2: Random Entry Benchmark
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 2: RANDOM ENTRY BENCHMARK");
console.log("  1000 random entries with same holding period distribution.");
console.log("  If random entries match Donchian, the entry has no edge.");
console.log("================================================================\n");

// Get hold distribution from baseline OOS
const holdDist = baselineOOS.map(t => t.holdDays);
if (holdDist.length === 0) {
  console.log("No OOS trades to build hold distribution. SKIPPING.");
} else {
  const nRandomRuns = 20;
  const nRandomPerRun = baselineOOS.length; // Same number of trades
  const randomResults: Metrics[] = [];

  for (let r = 0; r < nRandomRuns; r++) {
    const seed = 42 + r * 7919;
    const trades = runRandom(dailyData, OOS_START, OOS_END, nRandomPerRun, holdDist, seed);
    randomResults.push(calcMetrics(trades));
  }

  const avgRandPF = randomResults.reduce((s, m) => s + m.pf, 0) / randomResults.length;
  const avgRandSharpe = randomResults.reduce((s, m) => s + m.sharpe, 0) / randomResults.length;
  const avgRandTotal = randomResults.reduce((s, m) => s + m.total, 0) / randomResults.length;
  const avgRandWR = randomResults.reduce((s, m) => s + m.wr, 0) / randomResults.length;
  const randBetterCount = randomResults.filter(m => m.pf >= mOOS.pf).length;

  console.log(`                   Donchian OOS     Random Avg (${nRandomRuns} runs)`);
  console.log("-".repeat(55));
  console.log(`Trades:           ${String(mOOS.n).padStart(8)}          ${String(nRandomPerRun).padStart(8)}`);
  console.log(`Win Rate:         ${mOOS.wr.toFixed(1).padStart(7)}%         ${avgRandWR.toFixed(1).padStart(7)}%`);
  console.log(`Profit Factor:    ${mOOS.pf.toFixed(2).padStart(8)}          ${avgRandPF.toFixed(2).padStart(8)}`);
  console.log(`Sharpe:           ${mOOS.sharpe.toFixed(2).padStart(8)}          ${avgRandSharpe.toFixed(2).padStart(8)}`);
  console.log(`Total PnL:        ${fmtPnl(mOOS.total).padStart(8)}          ${fmtPnl(avgRandTotal).padStart(8)}`);
  console.log(`\nRandom runs with PF >= Donchian PF: ${randBetterCount}/${nRandomRuns}`);

  const pfEdge = mOOS.pf - avgRandPF;
  let test2Verdict: string;
  if (pfEdge > 0.3 && randBetterCount <= 2) {
    test2Verdict = "PASS";
  } else if (pfEdge > 0.1 && randBetterCount <= 5) {
    test2Verdict = "WARNING";
  } else {
    test2Verdict = "FAIL";
  }

  console.log(`PF edge over random: ${pfEdge.toFixed(2)}`);
  console.log(`\n>>> VERDICT: ${test2Verdict}`);
  if (test2Verdict === "FAIL") {
    console.log(`    Random entries produce similar or better results. The entry signal may have no edge.`);
  }
}

// ================================================================
// TEST 3: Regime Split
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 3: REGIME SPLIT (6-MONTH CHUNKS)");
console.log("  Fixed params on each chunk. How many are profitable?");
console.log("================================================================\n");

const chunks: { label: string; start: number; end: number }[] = [
  { label: "2023-H1", start: new Date("2023-01-01").getTime(), end: new Date("2023-07-01").getTime() },
  { label: "2023-H2", start: new Date("2023-07-01").getTime(), end: new Date("2024-01-01").getTime() },
  { label: "2024-H1", start: new Date("2024-01-01").getTime(), end: new Date("2024-07-01").getTime() },
  { label: "2024-H2", start: new Date("2024-07-01").getTime(), end: new Date("2025-01-01").getTime() },
  { label: "2025-H1", start: new Date("2025-01-01").getTime(), end: new Date("2025-07-01").getTime() },
  { label: "2025-H2+", start: new Date("2025-07-01").getTime(), end: OOS_END },
];

console.log("Chunk       Trades    WR%      PF    Sharpe     Total    $/day    MaxDD     Status");
console.log("-".repeat(90));

let profitableChunks = 0;
const chunkResults: { label: string; m: Metrics }[] = [];

for (const chunk of chunks) {
  const trades = runDonchian(dailyData, chunk.start, chunk.end);
  const m = calcMetrics(trades);
  chunkResults.push({ label: chunk.label, m });
  const status = m.total > 0 ? "PROFIT" : (m.n === 0 ? "NO TRADES" : "LOSS");
  if (m.total > 0) profitableChunks++;

  console.log(
    `${chunk.label.padEnd(12)}${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(6)}  ${fmtPnl(m.total).padStart(9)}  ${fmtPnl(m.perDay).padStart(7)}  ${fmtPnl(-m.maxDD).padStart(9)}  ${status}`
  );
}

const chunksWithTrades = chunkResults.filter(c => c.m.n > 0).length;
const profRatio = chunksWithTrades > 0 ? profitableChunks / chunksWithTrades : 0;

// Check if OOS period (2025-H2) is an outlier
const oosChunk = chunkResults.find(c => c.label === "2025-H2+");
const nonOosChunks = chunkResults.filter(c => c.label !== "2025-H2+" && c.m.n > 0);
const avgNonOosPF = nonOosChunks.length > 0
  ? nonOosChunks.reduce((s, c) => s + c.m.pf, 0) / nonOosChunks.length : 0;

console.log(`\nProfitable chunks: ${profitableChunks}/${chunksWithTrades} (${(profRatio * 100).toFixed(0)}%)`);
if (oosChunk && nonOosChunks.length > 0) {
  console.log(`OOS period PF: ${oosChunk.m.pf.toFixed(2)} vs non-OOS avg PF: ${avgNonOosPF.toFixed(2)}`);
  if (oosChunk.m.pf > avgNonOosPF * 1.5) {
    console.log(`WARNING: OOS period appears unusually favorable compared to other regimes.`);
  }
}

let test3Verdict: string;
if (profRatio >= 0.67) {
  test3Verdict = "PASS";
} else if (profRatio >= 0.5) {
  test3Verdict = "WARNING";
} else {
  test3Verdict = "FAIL";
}

console.log(`\n>>> VERDICT: ${test3Verdict}`);
if (test3Verdict !== "PASS") {
  console.log(`    Less than 67% of regimes are profitable. The edge may be regime-dependent.`);
}

// ================================================================
// TEST 4: Spread Sensitivity
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 4: SPREAD SENSITIVITY");
console.log("  Does the strategy survive 2x and 3x spreads?");
console.log("================================================================\n");

const spread1x = runDonchian(dailyData, OOS_START, OOS_END, "both", MAX_HOLD, 1);
const spread2x = runDonchian(dailyData, OOS_START, OOS_END, "both", MAX_HOLD, 2);
const spread3x = runDonchian(dailyData, OOS_START, OOS_END, "both", MAX_HOLD, 3);

const m1x = calcMetrics(spread1x);
const m2x = calcMetrics(spread2x);
const m3x = calcMetrics(spread3x);

console.log("Spread     Trades    WR%      PF    Sharpe     Total    $/day");
console.log("-".repeat(65));
for (const [label, m] of [["1x", m1x], ["2x", m2x], ["3x", m3x]] as [string, Metrics][]) {
  console.log(
    `${label.padEnd(11)}${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(6)}  ${fmtPnl(m.total).padStart(9)}  ${fmtPnl(m.perDay).padStart(7)}`
  );
}

let test4Verdict: string;
if (m3x.pf > 1.0 && m3x.total > 0) {
  test4Verdict = "PASS";
} else if (m2x.pf > 1.0 && m2x.total > 0) {
  test4Verdict = "WARNING";
} else {
  test4Verdict = "FAIL";
}

console.log(`\n>>> VERDICT: ${test4Verdict}`);
if (test4Verdict === "FAIL") {
  console.log(`    Strategy is unprofitable with 2x spreads. The edge may not survive real execution.`);
} else if (test4Verdict === "WARNING") {
  console.log(`    Survives 2x but not 3x spreads. Execution quality matters.`);
}

// ================================================================
// TEST 5: Entry Slippage Sensitivity
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 5: ENTRY TIMING SLIPPAGE");
console.log("  What if entry price is worse than open?");
console.log("================================================================\n");

const slippages = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0];

console.log("Slippage%   Trades    WR%      PF    Sharpe     Total    $/day    Break?");
console.log("-".repeat(75));

let breakSlippage = -1;

for (const slip of slippages) {
  const trades = runDonchian(dailyData, OOS_START, OOS_END, "both", MAX_HOLD, 1, slip);
  const m = calcMetrics(trades);
  const broke = m.total <= 0;
  if (broke && breakSlippage < 0) breakSlippage = slip;
  console.log(
    `${slip.toFixed(2).padStart(8)}%  ${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(6)}  ${fmtPnl(m.total).padStart(9)}  ${fmtPnl(m.perDay).padStart(7)}  ${broke ? "BROKEN" : "OK"}`
  );
}

let test5Verdict: string;
if (breakSlippage < 0 || breakSlippage >= 0.5) {
  test5Verdict = "PASS";
} else if (breakSlippage >= 0.2) {
  test5Verdict = "WARNING";
} else {
  test5Verdict = "FAIL";
}

console.log(`\nBreaks at: ${breakSlippage >= 0 ? breakSlippage.toFixed(2) + "% adverse slippage" : "never (within tested range)"}`);
console.log(`\n>>> VERDICT: ${test5Verdict}`);
if (test5Verdict !== "PASS") {
  console.log(`    Strategy is sensitive to entry timing. ${breakSlippage.toFixed(2)}% slippage kills it.`);
}

// ================================================================
// TEST 6: Survivorship Bias
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 6: SURVIVORSHIP BIAS CHECK");
console.log("================================================================\n");

console.log("This test is an EXPLICIT NOTE, not a simulation.\n");
console.log("The 19 pairs tested are all actively trading on Hyperliquid today:");
console.log(`  ${PAIRS.join(", ")}\n`);
console.log("Potential survivorship bias issues:");
console.log("  - Pairs that were delisted, lost liquidity, or failed are NOT in the sample.");
console.log("  - Coins that went to zero would have generated massive short profits (not captured).");
console.log("  - Coins that were added recently (TRUMP) have shorter history.");
console.log("  - The sample is biased toward 'winners' that survived to 2026.");
console.log("");

// Check data availability
const dataRanges: { pair: string; days: number; first: string; last: string }[] = [];
for (const pair of PAIRS) {
  const cs = dailyData.get(pair);
  if (!cs) continue;
  dataRanges.push({
    pair,
    days: cs.length,
    first: new Date(cs[0].t).toISOString().slice(0, 10),
    last: new Date(cs[cs.length - 1].t).toISOString().slice(0, 10),
  });
}
dataRanges.sort((a, b) => a.days - b.days);

console.log("Pair     Days   From         To");
console.log("-".repeat(45));
for (const d of dataRanges) {
  console.log(`${d.pair.padEnd(9)}${String(d.days).padStart(4)}   ${d.first}   ${d.last}`);
}

const shortHistPairs = dataRanges.filter(d => d.days < 500);
console.log(`\nPairs with < 500 days of data: ${shortHistPairs.length > 0 ? shortHistPairs.map(d => d.pair).join(", ") : "none"}`);

console.log(`\n>>> VERDICT: WARNING`);
console.log(`    Survivorship bias is inherent in any backtest of currently-listed pairs.`);
console.log(`    Cannot be eliminated without delisted pairs data. Magnitude is unknown.`);

// ================================================================
// TEST 7: Max-Hold Free Lunch Check
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 7: MAX-HOLD FREE LUNCH CHECK");
console.log("  Is the max-hold exit artificially boosting results?");
console.log("================================================================\n");

const noHold = runDonchian(dailyData, OOS_START, OOS_END, "both", 0);      // infinite hold
const hold30 = runDonchian(dailyData, OOS_START, OOS_END, "both", 30);
const hold60 = runDonchian(dailyData, OOS_START, OOS_END, "both", 60);     // baseline
const hold90 = runDonchian(dailyData, OOS_START, OOS_END, "both", 90);
const hold120 = runDonchian(dailyData, OOS_START, OOS_END, "both", 120);

const mNoHold = calcMetrics(noHold);
const mHold30 = calcMetrics(hold30);
const mHold60 = calcMetrics(hold60);
const mHold90 = calcMetrics(hold90);
const mHold120 = calcMetrics(hold120);

console.log("MaxHold    Trades    WR%      PF    Sharpe     Total    $/day    MaxDD");
console.log("-".repeat(80));
for (const [label, m] of [
  ["None", mNoHold], ["30d", mHold30], ["60d", mHold60],
  ["90d", mHold90], ["120d", mHold120],
] as [string, Metrics][]) {
  console.log(
    `${label.padEnd(11)}${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(6)}  ${fmtPnl(m.total).padStart(9)}  ${fmtPnl(m.perDay).padStart(7)}  ${fmtPnl(-m.maxDD).padStart(9)}`
  );
}

// Max-hold exit analysis for baseline
const maxHoldTrades = baselineOOS.filter(t => t.reason === "max-hold");
const nonMaxHoldTrades = baselineOOS.filter(t => t.reason !== "max-hold");
const avgMaxHoldPnl = maxHoldTrades.length > 0
  ? maxHoldTrades.reduce((s, t) => s + t.pnl, 0) / maxHoldTrades.length : 0;
const totalMaxHoldPnl = maxHoldTrades.reduce((s, t) => s + t.pnl, 0);

console.log(`\nMax-hold exit details (60d baseline OOS):`);
console.log(`  Max-hold exits: ${maxHoldTrades.length}/${baselineOOS.length} trades (${(maxHoldTrades.length / baselineOOS.length * 100).toFixed(1)}%)`);
console.log(`  Avg PnL of max-hold exits: ${fmtPnl(avgMaxHoldPnl)}`);
console.log(`  Total PnL from max-hold exits: ${fmtPnl(totalMaxHoldPnl)}`);
console.log(`  Total PnL from other exits: ${fmtPnl(mOOS.total - totalMaxHoldPnl)}`);

const maxHoldDependence = Math.abs(totalMaxHoldPnl) / (Math.abs(mOOS.total) + 1);
const noHoldStillProfitable = mNoHold.total > 0;

let test7Verdict: string;
if (noHoldStillProfitable && maxHoldDependence < 0.5) {
  test7Verdict = "PASS";
} else if (noHoldStillProfitable || mHold90.total > 0) {
  test7Verdict = "WARNING";
} else {
  test7Verdict = "FAIL";
}

console.log(`\nStrategy profitable without max-hold: ${noHoldStillProfitable ? "YES" : "NO"}`);
console.log(`Max-hold PnL dependence: ${(maxHoldDependence * 100).toFixed(1)}% of total PnL`);
console.log(`\n>>> VERDICT: ${test7Verdict}`);
if (test7Verdict !== "PASS") {
  console.log(`    Max-hold exit contributes disproportionately. It may be a lucky artifact.`);
}

// ================================================================
// TEST 8: Donchian vs SMA Cross
// ================================================================
console.log("\n\n================================================================");
console.log("  TEST 8: DONCHIAN vs SMA CROSSOVER");
console.log("  If SMA cross is equally good, Donchian is not special.");
console.log("================================================================\n");

const smaTrades = runSMACross(dailyData, OOS_START, OOS_END, 30, 60);
const mSMA = calcMetrics(smaTrades);

const smaFull = runSMACross(dailyData, FULL_START, OOS_END, 30, 60);
const mSMAFull = calcMetrics(smaFull);

console.log("Strategy         Period   Trades    WR%      PF    Sharpe     Total    $/day    MaxDD");
console.log("-".repeat(95));
for (const [label, period, m] of [
  ["Donchian", "OOS", mOOS],
  ["SMA 30/60", "OOS", mSMA],
  ["Donchian", "Full", mFull],
  ["SMA 30/60", "Full", mSMAFull],
] as [string, string, Metrics][]) {
  console.log(
    `${label.padEnd(17)}${period.padEnd(9)}${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(6)}  ${fmtPnl(m.total).padStart(9)}  ${fmtPnl(m.perDay).padStart(7)}  ${fmtPnl(-m.maxDD).padStart(9)}`
  );
}

const donchianBetter = mOOS.pf > mSMA.pf;
const smaProfitable = mSMA.total > 0;
const pfDiff = mOOS.pf - mSMA.pf;

let test8Verdict: string;
if (donchianBetter && pfDiff > 0.3) {
  test8Verdict = "PASS";
} else if (donchianBetter && pfDiff > 0.1) {
  test8Verdict = "WARNING";
} else {
  test8Verdict = "FAIL";
}

console.log(`\nDonchian PF advantage over SMA: ${pfDiff >= 0 ? "+" : ""}${pfDiff.toFixed(2)}`);
console.log(`SMA cross profitable: ${smaProfitable ? "YES" : "NO"}`);
console.log(`\n>>> VERDICT: ${test8Verdict}`);
if (test8Verdict === "FAIL") {
  console.log(`    SMA cross is comparable or better. The Donchian entry is not adding unique value.`);
} else if (test8Verdict === "WARNING") {
  console.log(`    Donchian is slightly better, but the difference is small. The edge is in trend-following, not the specific entry.`);
}

// ================================================================
// OVERALL ASSESSMENT
// ================================================================
console.log("\n\n================================================================");
console.log("  OVERALL ASSESSMENT");
console.log("================================================================\n");

const verdicts: { test: string; result: string }[] = [
  { test: "1. Direction Bias", result: test1Verdict },
  { test: "2. Random Entry Benchmark", result: holdDist.length > 0 ? (
    (() => {
      // Re-derive for summary
      const nRandomRuns = 20;
      const randomResults: Metrics[] = [];
      for (let r = 0; r < nRandomRuns; r++) {
        const seed = 42 + r * 7919;
        const trades = runRandom(dailyData, OOS_START, OOS_END, baselineOOS.length, holdDist, seed);
        randomResults.push(calcMetrics(trades));
      }
      const avgRandPF = randomResults.reduce((s, m) => s + m.pf, 0) / randomResults.length;
      const randBetterCount = randomResults.filter(m => m.pf >= mOOS.pf).length;
      const pfEdge = mOOS.pf - avgRandPF;
      if (pfEdge > 0.3 && randBetterCount <= 2) return "PASS";
      if (pfEdge > 0.1 && randBetterCount <= 5) return "WARNING";
      return "FAIL";
    })()
  ) : "SKIP" },
  { test: "3. Regime Split", result: test3Verdict },
  { test: "4. Spread Sensitivity", result: test4Verdict },
  { test: "5. Entry Slippage", result: test5Verdict },
  { test: "6. Survivorship Bias", result: "WARNING" },
  { test: "7. Max-Hold Free Lunch", result: test7Verdict },
  { test: "8. Donchian vs SMA Cross", result: test8Verdict },
];

const fails = verdicts.filter(v => v.result === "FAIL").length;
const warns = verdicts.filter(v => v.result === "WARNING").length;
const passes = verdicts.filter(v => v.result === "PASS").length;

console.log("Test                          Verdict");
console.log("-".repeat(45));
for (const v of verdicts) {
  const icon = v.result === "PASS" ? "[OK]" : v.result === "WARNING" ? "[!!]" : v.result === "FAIL" ? "[XX]" : "[--]";
  console.log(`${icon} ${v.test.padEnd(30)} ${v.result}`);
}

console.log(`\nPASS: ${passes}  |  WARNING: ${warns}  |  FAIL: ${fails}`);

console.log("\n" + "=".repeat(60));
if (fails >= 2) {
  console.log("  STRATEGY HAS CRITICAL FLAWS");
  console.log("=".repeat(60));
  console.log("\nThe strategy failed multiple stress tests. Key concerns:");
  for (const v of verdicts.filter(v => v.result === "FAIL")) {
    console.log(`  - ${v.test}`);
  }
  console.log("\nThe positive backtest results may not translate to real trading.");
} else if (fails === 1) {
  console.log("  STRATEGY HAS ONE CRITICAL FLAW");
  console.log("=".repeat(60));
  console.log("\nOne critical test failed:");
  for (const v of verdicts.filter(v => v.result === "FAIL")) {
    console.log(`  - ${v.test}`);
  }
  console.log(`\n${warns} tests showed warnings. Proceed with extra caution.`);
} else if (warns >= 4) {
  console.log("  STRATEGY IS FRAGILE");
  console.log("=".repeat(60));
  console.log("\nNo critical failures, but many warnings indicate fragility.");
  console.log("The edge is real but thin. Execution quality is critical.");
} else {
  console.log("  STRATEGY IS ROBUST");
  console.log("=".repeat(60));
  console.log(`\n${passes} tests passed, ${warns} warnings, ${fails} failures.`);
  console.log("The strategy shows resilience across stress tests.");
}

console.log("\n--- Devil's advocate analysis complete ---");
