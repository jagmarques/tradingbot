/**
 * Monte Carlo Statistical Validation for Daily Donchian Breakout
 * Tests whether the strategy edge is statistically significant or explainable by chance.
 */
import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR_5M = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10;
const NOT = SIZE * LEV; // $100 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, AVAX: 2.55e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, SEI: 4.4e-4,
  TON: 4.6e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Pos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdDays: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateToDaily(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function donchianHigh(cs: C[], idx: number, lookback: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) max = Math.max(max, cs[i].h);
  return max;
}

function donchianLow(cs: C[], idx: number, lookback: number): number {
  let min = Infinity;
  for (let i = Math.max(0, idx - lookback); i < idx; i++) min = Math.min(min, cs[i].l);
  return min;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const cost = entrySlip * (NOT / ep) + exitSlip * (NOT / xp) + fees;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - cost;
}

// ─── Strategy: Daily Donchian Breakout ──────────────────────────────
function stratDonchian(
  pairs: string[],
  dailyData: Map<string, C[]>,
  entryLB: number,
  exitLB: number,
  atrMult: number,
  maxHoldDays: number,
  startTs: number,
): Tr[] {
  const atrPeriod = 14;
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < entryLB + atrPeriod + 10) continue;
    const atr = calcATR(cs, atrPeriod);
    let pos: Pos | null = null;
    const warmup = Math.max(entryLB, atrPeriod) + 1;

    for (let i = warmup; i < cs.length; i++) {
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const tr: Tr = {
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason, holdDays: barsHeld,
          };
          if (pos.et >= startTs) trades.push(tr);
          pos = null;
        }
      }

      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, entryLB);
        const dLow = donchianLow(cs, i - 1, entryLB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        const ep = cs[i].o;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;
        pos = { pair, dir, ep, et: cs[i].t, sl };
      }
    }
  }
  return trades;
}

// ─── Random Entry Strategy (same exits) ─────────────────────────────
function stratRandomEntry(
  pairs: string[],
  dailyData: Map<string, C[]>,
  entryLB: number,
  exitLB: number,
  atrMult: number,
  maxHoldDays: number,
  startTs: number,
  avgFrequency: number, // avg trades per pair per tradeable day
): Tr[] {
  const atrPeriod = 14;
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < entryLB + atrPeriod + 10) continue;
    const atr = calcATR(cs, atrPeriod);
    let pos: Pos | null = null;
    const warmup = Math.max(entryLB, atrPeriod) + 1;

    for (let i = warmup; i < cs.length; i++) {
      // Exit logic is identical to Donchian
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const tr: Tr = {
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason, holdDays: barsHeld,
          };
          if (pos.et >= startTs) trades.push(tr);
          pos = null;
        }
      }

      // Random entry instead of Donchian signal
      if (!pos && i >= warmup && cs[i].t >= startTs) {
        if (Math.random() > avgFrequency) continue;

        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        const dir: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
        const ep = cs[i].o;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;
        pos = { pair, dir, ep, et: cs[i].t, sl };
      }
    }
  }
  return trades;
}

// ─── Reversed Direction Strategy ────────────────────────────────────
function stratReversed(
  pairs: string[],
  dailyData: Map<string, C[]>,
  entryLB: number,
  exitLB: number,
  atrMult: number,
  maxHoldDays: number,
  startTs: number,
): Tr[] {
  const atrPeriod = 14;
  const trades: Tr[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < entryLB + atrPeriod + 10) continue;
    const atr = calcATR(cs, atrPeriod);
    let pos: Pos | null = null;
    const warmup = Math.max(entryLB, atrPeriod) + 1;

    for (let i = warmup; i < cs.length; i++) {
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const tr: Tr = {
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason, holdDays: barsHeld,
          };
          if (pos.et >= startTs) trades.push(tr);
          pos = null;
        }
      }

      // Same entry timing as Donchian, but REVERSED direction
      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, entryLB);
        const dLow = donchianLow(cs, i - 1, entryLB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        // REVERSED: breakout above -> short, breakout below -> long
        if (prev.c > dHigh) dir = "short";
        else if (prev.c < dLow) dir = "long";
        if (!dir) continue;

        const ep = cs[i].o;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;
        pos = { pair, dir, ep, et: cs[i].t, sl };
      }
    }
  }
  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number; total: number;
  maxDD: number; perDay: number;
}

function calcMetrics(trades: Tr[]): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, total: 0, maxDD: 0, perDay: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Sharpe: bucket by day
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()].map(p => p / SIZE);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    total,
    maxDD,
    perDay: days > 0 ? total / days : 0,
  };
}

// Simplified metrics from PnL array (for monte carlo)
function metricsFromPnls(pnls: number[]): { total: number; pf: number; sharpe: number; maxDD: number; wr: number } {
  if (pnls.length === 0) return { total: 0, pf: 0, sharpe: 0, maxDD: 0, wr: 0 };

  const total = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const wr = wins.length / pnls.length * 100;

  let cum = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const mean = total / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return { total, pf, sharpe, maxDD, wr };
}

// ─── Shuffle array (Fisher-Yates) ───────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Percentile helper ──────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function rankPercentile(value: number, sorted: number[]): number {
  let count = 0;
  for (const v of sorted) { if (v < value) count++; }
  return (count / sorted.length) * 100;
}

// ─── MAIN ───────────────────────────────────────────────────────────
console.log("=".repeat(80));
console.log("  DONCHIAN BREAKOUT MONTE CARLO STATISTICAL VALIDATION");
console.log("  30d entry, 15d exit, ATR x 3 stop, 60d max hold");
console.log("  19 pairs, 5m->daily, $10 margin, 10x leverage");
console.log("=".repeat(80));

console.log("\nLoading 5m data and aggregating to daily...");
const dailyData = new Map<string, C[]>();
for (const pair of ALL_PAIRS) {
  const raw = load5m(pair);
  if (raw.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  const daily = aggregateToDaily(raw);
  dailyData.set(pair, daily);
  console.log(`  ${pair}: ${raw.length} 5m bars -> ${daily.length} daily bars`);
}

// Parameters
const ENTRY_LB = 30;
const EXIT_LB = 15;
const ATR_MULT = 3.0;
const MAX_HOLD = 60;

// Use earliest data start as strategy start (after warmup)
const allFirstTs = [...dailyData.values()].map(cs => cs[0]?.t ?? Infinity);
const dataStart = Math.min(...allFirstTs);
const STRAT_START = dataStart; // run from beginning of available data

// Run actual strategy
console.log("\nRunning baseline strategy...");
const actualTrades = stratDonchian(ALL_PAIRS, dailyData, ENTRY_LB, EXIT_LB, ATR_MULT, MAX_HOLD, STRAT_START);
const actualMetrics = calcMetrics(actualTrades);
const actualPnls = actualTrades.map(t => t.pnl);

console.log(`\n--- Baseline Results ---`);
console.log(`Trades: ${actualMetrics.n}`);
console.log(`Win Rate: ${actualMetrics.wr.toFixed(1)}%`);
console.log(`Profit Factor: ${actualMetrics.pf.toFixed(2)}`);
console.log(`Sharpe: ${actualMetrics.sharpe.toFixed(2)}`);
console.log(`Total PnL: $${actualMetrics.total.toFixed(2)}`);
console.log(`Max Drawdown: $${actualMetrics.maxDD.toFixed(2)}`);
console.log(`$/day: $${actualMetrics.perDay.toFixed(2)}`);

// ─── TEST 1: Monte Carlo Permutation Test ───────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  TEST 1: MONTE CARLO PERMUTATION TEST (1000 iterations)");
console.log("=".repeat(80));
console.log("Shuffling trade order to test if sequence matters...\n");

const MC_ITERS = 1000;
const mcTotals: number[] = [];
const mcSharpes: number[] = [];
const mcMaxDDs: number[] = [];

for (let i = 0; i < MC_ITERS; i++) {
  const shuffled = shuffle(actualPnls);
  const m = metricsFromPnls(shuffled);
  mcTotals.push(m.total);
  mcSharpes.push(m.sharpe);
  mcMaxDDs.push(m.maxDD);
}

mcTotals.sort((a, b) => a - b);
mcSharpes.sort((a, b) => a - b);
mcMaxDDs.sort((a, b) => a - b);

const totalPctile = rankPercentile(actualMetrics.total, mcTotals);
const sharpePctile = rankPercentile(actualMetrics.sharpe, mcSharpes);
const ddPctile = rankPercentile(actualMetrics.maxDD, mcMaxDDs);

console.log("Metric        Actual     5th pct    25th pct   50th pct   75th pct   95th pct   Rank");
console.log("-".repeat(95));
console.log(`Total PnL     $${actualMetrics.total.toFixed(0).padStart(6)}  $${percentile(mcTotals, 5).toFixed(0).padStart(7)}  $${percentile(mcTotals, 25).toFixed(0).padStart(7)}  $${percentile(mcTotals, 50).toFixed(0).padStart(7)}  $${percentile(mcTotals, 75).toFixed(0).padStart(7)}  $${percentile(mcTotals, 95).toFixed(0).padStart(7)}  ${totalPctile.toFixed(1)}%`);
console.log(`Sharpe        ${actualMetrics.sharpe.toFixed(2).padStart(7)}  ${percentile(mcSharpes, 5).toFixed(2).padStart(8)}  ${percentile(mcSharpes, 25).toFixed(2).padStart(8)}  ${percentile(mcSharpes, 50).toFixed(2).padStart(8)}  ${percentile(mcSharpes, 75).toFixed(2).padStart(8)}  ${percentile(mcSharpes, 95).toFixed(2).padStart(8)}  ${sharpePctile.toFixed(1)}%`);
console.log(`Max DD        $${actualMetrics.maxDD.toFixed(0).padStart(6)}  $${percentile(mcMaxDDs, 5).toFixed(0).padStart(7)}  $${percentile(mcMaxDDs, 25).toFixed(0).padStart(7)}  $${percentile(mcMaxDDs, 50).toFixed(0).padStart(7)}  $${percentile(mcMaxDDs, 75).toFixed(0).padStart(7)}  $${percentile(mcMaxDDs, 95).toFixed(0).padStart(7)}  ${ddPctile.toFixed(1)}%`);

// Note: for permutation test, total PnL stays the same (sum invariant under shuffle)
// The meaningful test is Sharpe and MaxDD (path-dependent)
const mc1Verdict = sharpePctile < 5 ? "FAIL" : sharpePctile < 25 ? "WARNING" : "PASS";
console.log(`\nNote: Total PnL is sum-invariant (same across all shuffles). Sharpe and MaxDD are path-dependent.`);
console.log(`Sharpe percentile: ${sharpePctile.toFixed(1)}% -- actual Sharpe is ${sharpePctile > 50 ? "BETTER" : "WORSE"} than ${sharpePctile.toFixed(0)}% of random orderings`);
console.log(`MaxDD percentile: ${ddPctile.toFixed(1)}% -- ${ddPctile < 50 ? "lower (better)" : "higher (worse)"} DD than median shuffle`);
console.log(`Verdict: ${mc1Verdict}`);

// ─── TEST 2: Bootstrap Confidence Intervals ─────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  TEST 2: BOOTSTRAP CONFIDENCE INTERVALS (1000 iterations)");
console.log("=".repeat(80));
console.log("Resampling trades WITH replacement...\n");

const BS_ITERS = 1000;
const bsPFs: number[] = [];
const bsSharpes: number[] = [];
const bsTotals: number[] = [];
const bsWRs: number[] = [];

for (let i = 0; i < BS_ITERS; i++) {
  const sample: number[] = [];
  for (let j = 0; j < actualPnls.length; j++) {
    sample.push(actualPnls[Math.floor(Math.random() * actualPnls.length)]);
  }
  const m = metricsFromPnls(sample);
  bsPFs.push(m.pf);
  bsSharpes.push(m.sharpe);
  bsTotals.push(m.total);
  bsWRs.push(m.wr);
}

bsPFs.sort((a, b) => a - b);
bsSharpes.sort((a, b) => a - b);
bsTotals.sort((a, b) => a - b);
bsWRs.sort((a, b) => a - b);

console.log("Metric        5th pct    25th pct   50th pct   75th pct   95th pct");
console.log("-".repeat(75));
console.log(`PF            ${percentile(bsPFs, 5).toFixed(2).padStart(8)}  ${percentile(bsPFs, 25).toFixed(2).padStart(8)}  ${percentile(bsPFs, 50).toFixed(2).padStart(8)}  ${percentile(bsPFs, 75).toFixed(2).padStart(8)}  ${percentile(bsPFs, 95).toFixed(2).padStart(8)}`);
console.log(`Sharpe        ${percentile(bsSharpes, 5).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 25).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 50).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 75).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 95).toFixed(2).padStart(8)}`);
console.log(`Total PnL     $${percentile(bsTotals, 5).toFixed(0).padStart(6)}  $${percentile(bsTotals, 25).toFixed(0).padStart(6)}  $${percentile(bsTotals, 50).toFixed(0).padStart(6)}  $${percentile(bsTotals, 75).toFixed(0).padStart(6)}  $${percentile(bsTotals, 95).toFixed(0).padStart(6)}`);
console.log(`Win Rate      ${percentile(bsWRs, 5).toFixed(1).padStart(7)}%  ${percentile(bsWRs, 25).toFixed(1).padStart(7)}%  ${percentile(bsWRs, 50).toFixed(1).padStart(7)}%  ${percentile(bsWRs, 75).toFixed(1).padStart(7)}%  ${percentile(bsWRs, 95).toFixed(1).padStart(7)}%`);

const pf5th = percentile(bsPFs, 5);
const total5th = percentile(bsTotals, 5);
const bs2Verdict = pf5th > 1.0 ? "PASS" : pf5th > 0.8 ? "WARNING" : "FAIL";
console.log(`\n5th percentile PF: ${pf5th.toFixed(2)} -- ${pf5th > 1.0 ? "PROFITABLE even in worst-case bootstrap" : "NOT profitable in worst case"}`);
console.log(`5th percentile Total PnL: $${total5th.toFixed(0)} -- ${total5th > 0 ? "positive" : "NEGATIVE"} in worst case`);
console.log(`95% CI for PF: [${percentile(bsPFs, 2.5).toFixed(2)}, ${percentile(bsPFs, 97.5).toFixed(2)}]`);
console.log(`Verdict: ${bs2Verdict}`);

// ─── TEST 3: Random Entry Test ──────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  TEST 3: RANDOM ENTRY TEST (500 iterations)");
console.log("=".repeat(80));
console.log("Same exits (Donchian exit + ATR stop + max hold), but RANDOM entries...\n");

const RAND_ITERS = 500;

// Calculate average entry frequency from actual strategy
// Count total tradeable days per pair and total entries per pair
let totalSignals = 0;
let totalDays = 0;
for (const pair of ALL_PAIRS) {
  const cs = dailyData.get(pair);
  if (!cs) continue;
  const warmup = Math.max(ENTRY_LB, 14) + 1;
  const pairDays = cs.filter(c => c.t >= STRAT_START).length - warmup;
  if (pairDays > 0) totalDays += pairDays;
  const pairTrades = actualTrades.filter(t => t.pair === pair).length;
  totalSignals += pairTrades;
}
// Approximate: each pair has avgFreq probability of entering on any given day
// But we need to account for the fact that you can only enter when not in a position
// Use a slightly higher frequency to compensate
const avgFreq = totalDays > 0 ? (totalSignals / totalDays) * 2.0 : 0.02;
console.log(`Actual signal frequency: ${totalSignals} entries across ${totalDays} pair-days = ${(totalSignals/totalDays*100).toFixed(2)}%`);
console.log(`Random entry probability per pair-day: ${(avgFreq * 100).toFixed(2)}% (boosted to account for position blocking)\n`);

const randPFs: number[] = [];
const randTotals: number[] = [];
const randSharpes: number[] = [];
const randNs: number[] = [];

for (let i = 0; i < RAND_ITERS; i++) {
  const rt = stratRandomEntry(ALL_PAIRS, dailyData, ENTRY_LB, EXIT_LB, ATR_MULT, MAX_HOLD, STRAT_START, avgFreq);
  const m = calcMetrics(rt);
  randPFs.push(m.pf);
  randTotals.push(m.total);
  randSharpes.push(m.sharpe);
  randNs.push(m.n);
}

randPFs.sort((a, b) => a - b);
randTotals.sort((a, b) => a - b);
randSharpes.sort((a, b) => a - b);
randNs.sort((a, b) => a - b);

const randPFgt1 = randPFs.filter(pf => pf > 1.0).length;
const randPFgt15 = randPFs.filter(pf => pf > 1.5).length;
const randPFgtActual = randPFs.filter(pf => pf > actualMetrics.pf).length;
const actualPFrank = rankPercentile(actualMetrics.pf, randPFs);

console.log("Random entry results distribution:");
console.log(`  Avg trades per run: ${(randNs.reduce((s, n) => s + n, 0) / RAND_ITERS).toFixed(0)} (actual: ${actualMetrics.n})`);
console.log(`  PF > 1.0: ${randPFgt1}/${RAND_ITERS} (${(randPFgt1/RAND_ITERS*100).toFixed(1)}%)`);
console.log(`  PF > 1.5: ${randPFgt15}/${RAND_ITERS} (${(randPFgt15/RAND_ITERS*100).toFixed(1)}%)`);
console.log(`  PF > actual (${actualMetrics.pf.toFixed(2)}): ${randPFgtActual}/${RAND_ITERS} (${(randPFgtActual/RAND_ITERS*100).toFixed(1)}%)`);
console.log(`  Actual PF percentile vs random: ${actualPFrank.toFixed(1)}%`);

console.log(`\n  Random PF distribution:`);
console.log(`    5th pct:  ${percentile(randPFs, 5).toFixed(2)}`);
console.log(`    25th pct: ${percentile(randPFs, 25).toFixed(2)}`);
console.log(`    50th pct: ${percentile(randPFs, 50).toFixed(2)}`);
console.log(`    75th pct: ${percentile(randPFs, 75).toFixed(2)}`);
console.log(`    95th pct: ${percentile(randPFs, 95).toFixed(2)}`);

console.log(`\n  Random Sharpe distribution:`);
console.log(`    5th pct:  ${percentile(randSharpes, 5).toFixed(2)}`);
console.log(`    50th pct: ${percentile(randSharpes, 50).toFixed(2)}`);
console.log(`    95th pct: ${percentile(randSharpes, 95).toFixed(2)}`);
console.log(`    Actual:   ${actualMetrics.sharpe.toFixed(2)} (percentile: ${rankPercentile(actualMetrics.sharpe, randSharpes).toFixed(1)}%)`);

const re3Verdict = actualPFrank >= 95 ? "PASS" : actualPFrank >= 75 ? "WARNING" : "FAIL";
console.log(`\nEntry signal adds value: ${actualPFrank >= 75 ? "YES" : "UNCLEAR"} -- actual PF at ${actualPFrank.toFixed(1)}th percentile of random entries`);
console.log(`p-value (entry edge): ${((100 - actualPFrank) / 100).toFixed(3)}`);
console.log(`Verdict: ${re3Verdict}`);

// ─── TEST 4: Time-Reversed Trades Test ──────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  TEST 4: TIME-REVERSED TRADES TEST");
console.log("=".repeat(80));
console.log("Same entry timing, but REVERSED direction (longs->shorts, shorts->longs)...\n");

const reversedTrades = stratReversed(ALL_PAIRS, dailyData, ENTRY_LB, EXIT_LB, ATR_MULT, MAX_HOLD, STRAT_START);
const reversedMetrics = calcMetrics(reversedTrades);

console.log("               Original     Reversed");
console.log("-".repeat(45));
console.log(`Trades:        ${String(actualMetrics.n).padStart(8)}     ${String(reversedMetrics.n).padStart(8)}`);
console.log(`Win Rate:      ${actualMetrics.wr.toFixed(1).padStart(7)}%     ${reversedMetrics.wr.toFixed(1).padStart(7)}%`);
console.log(`PF:            ${actualMetrics.pf.toFixed(2).padStart(8)}     ${reversedMetrics.pf.toFixed(2).padStart(8)}`);
console.log(`Sharpe:        ${actualMetrics.sharpe.toFixed(2).padStart(8)}     ${reversedMetrics.sharpe.toFixed(2).padStart(8)}`);
console.log(`Total PnL:     $${actualMetrics.total.toFixed(0).padStart(6)}     $${reversedMetrics.total.toFixed(0).padStart(6)}`);
console.log(`Max DD:        $${actualMetrics.maxDD.toFixed(0).padStart(6)}     $${reversedMetrics.maxDD.toFixed(0).padStart(6)}`);

const dirEdge = actualMetrics.total - reversedMetrics.total;
const tr4Verdict = reversedMetrics.total < 0 && actualMetrics.total > 0 ? "PASS"
  : reversedMetrics.pf < 1.0 ? "PASS"
  : reversedMetrics.pf < actualMetrics.pf * 0.7 ? "WARNING"
  : "FAIL";
console.log(`\nDirectional edge: $${dirEdge.toFixed(0)} (original - reversed)`);
console.log(`Reversed profitable: ${reversedMetrics.total > 0 ? "YES (weak directional signal)" : "NO (strong directional signal)"}`);
console.log(`Reversed PF: ${reversedMetrics.pf.toFixed(2)} -- ${reversedMetrics.pf < 1.0 ? "below 1.0, directional signal has real value" : "above 1.0, may be capturing volatility not direction"}`);
console.log(`Verdict: ${tr4Verdict}`);

// ─── TEST 5: Sample Size Adequacy ───────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  TEST 5: SAMPLE SIZE ADEQUACY");
console.log("=".repeat(80));

// Per-pair breakdown
console.log("\nTrades per pair:");
console.log("Pair       Trades   Longs   Shorts   WR%      PnL");
console.log("-".repeat(60));
for (const pair of ALL_PAIRS) {
  const pt = actualTrades.filter(t => t.pair === pair);
  const longs = pt.filter(t => t.dir === "long").length;
  const shorts = pt.filter(t => t.dir === "short").length;
  const wr = pt.length > 0 ? pt.filter(t => t.pnl > 0).length / pt.length * 100 : 0;
  const pnl = pt.reduce((s, t) => s + t.pnl, 0);
  console.log(`${pair.padEnd(10)} ${String(pt.length).padStart(6)}  ${String(longs).padStart(6)}  ${String(shorts).padStart(7)}  ${wr.toFixed(1).padStart(5)}%  ${(pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(1)}`);
}
console.log(`${"TOTAL".padEnd(10)} ${String(actualMetrics.n).padStart(6)}`);

// Minimum sample size for significance
// Approximate formula: n_min = (z^2 * var(PnL)) / (mean(PnL))^2
// For 95% confidence (z=1.96)
const meanPnl = actualPnls.reduce((s, p) => s + p, 0) / actualPnls.length;
const varPnl = actualPnls.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / (actualPnls.length - 1);
const stdPnl = Math.sqrt(varPnl);
const z95 = 1.96;

// t-test: is mean significantly > 0?
const tStat = meanPnl / (stdPnl / Math.sqrt(actualPnls.length));
// Approximate p-value from t-distribution (use normal approximation for large n)
const pValueTTest = 1 - normalCDF(tStat);

// Min sample size formula for PF
const pf = actualMetrics.pf;
const nMinPF = pf > 1 ? Math.ceil((z95 ** 2 * varPnl * pf ** 2) / ((meanPnl * (pf - 1) / pf) ** 2 * (pf - 1) ** 2)) : Infinity;

// Simpler: min N for mean > 0 at 95% confidence
const nMinMean = Math.ceil((z95 * stdPnl / meanPnl) ** 2);

console.log(`\nSample statistics:`);
console.log(`  Total trades: ${actualPnls.length}`);
console.log(`  Mean PnL per trade: $${meanPnl.toFixed(3)}`);
console.log(`  Std PnL per trade: $${stdPnl.toFixed(3)}`);
console.log(`  t-statistic (mean > 0): ${tStat.toFixed(3)}`);
console.log(`  p-value (one-tailed): ${pValueTTest.toFixed(4)}`);

console.log(`\nMinimum sample sizes (95% confidence):`);
console.log(`  For mean > 0: ${nMinMean} trades needed (have ${actualPnls.length})`);
console.log(`  Surplus/deficit: ${actualPnls.length - nMinMean > 0 ? "+" : ""}${actualPnls.length - nMinMean} trades`);

const ss5Verdict = pValueTTest < 0.05 ? "PASS" : pValueTTest < 0.10 ? "WARNING" : "FAIL";
console.log(`\nt-test verdict: ${pValueTTest < 0.05 ? "SIGNIFICANT at 5% level" : pValueTTest < 0.10 ? "marginally significant (10% level)" : "NOT significant"}`);
console.log(`Verdict: ${ss5Verdict}`);

// ─── TEST 6: Stationarity Check ─────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  TEST 6: STATIONARITY CHECK (4 quarters)");
console.log("=".repeat(80));

// Sort trades by entry time
const sortedTrades = [...actualTrades].sort((a, b) => a.et - b.et);
const firstEntry = sortedTrades[0]?.et ?? 0;
const lastEntry = sortedTrades[sortedTrades.length - 1]?.et ?? 0;
const quarterLen = (lastEntry - firstEntry) / 4;

console.log("\nSplitting trades by entry time into 4 equal quarters...\n");
console.log("Quarter    Period                Trades   WR%     PF     Sharpe    Total    $/day");
console.log("-".repeat(90));

let stableQuarters = 0;
const quarterPFs: number[] = [];

for (let q = 0; q < 4; q++) {
  const qStart = firstEntry + q * quarterLen;
  const qEnd = firstEntry + (q + 1) * quarterLen;
  const qTrades = sortedTrades.filter(t => t.et >= qStart && t.et < qEnd);
  const qPnls = qTrades.map(t => t.pnl);
  const m = metricsFromPnls(qPnls);

  const qDays = quarterLen / DAY;
  const perDay = qDays > 0 ? m.total / qDays : 0;

  const startDate = new Date(qStart).toISOString().slice(0, 10);
  const endDate = new Date(qEnd).toISOString().slice(0, 10);

  quarterPFs.push(m.pf);
  if (m.pf > 1.0) stableQuarters++;

  console.log(`Q${q + 1}         ${startDate} - ${endDate}  ${String(qTrades.length).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(7)}  ${(m.total >= 0 ? "+" : "") + "$" + Math.abs(m.total).toFixed(0).padStart(5)}  ${(perDay >= 0 ? "+" : "") + "$" + Math.abs(perDay).toFixed(2)}`);
}

const minQuarterPF = Math.min(...quarterPFs);
const maxQuarterPF = Math.max(...quarterPFs);
const pfRange = maxQuarterPF - minQuarterPF;

const st6Verdict = stableQuarters >= 3 ? "PASS" : stableQuarters >= 2 ? "WARNING" : "FAIL";
console.log(`\nProfitable quarters: ${stableQuarters}/4`);
console.log(`PF range: ${minQuarterPF.toFixed(2)} - ${maxQuarterPF.toFixed(2)} (spread: ${pfRange.toFixed(2)})`);
console.log(`Edge concentrated: ${stableQuarters <= 1 ? "YES (only 1 quarter)" : stableQuarters === 2 ? "PARTIALLY (2 quarters)" : "NO (distributed)"}`);
console.log(`Verdict: ${st6Verdict}`);

// ─── OVERALL ASSESSMENT ─────────────────────────────────────────────
console.log("\n" + "=".repeat(80));
console.log("  OVERALL STATISTICAL ASSESSMENT");
console.log("=".repeat(80));

const verdicts = [
  { test: "1. Monte Carlo Permutation", verdict: mc1Verdict },
  { test: "2. Bootstrap CI", verdict: bs2Verdict },
  { test: "3. Random Entry", verdict: re3Verdict },
  { test: "4. Time-Reversed", verdict: tr4Verdict },
  { test: "5. Sample Size", verdict: ss5Verdict },
  { test: "6. Stationarity", verdict: st6Verdict },
];

console.log("\nTest                         Verdict");
console.log("-".repeat(45));
for (const v of verdicts) {
  console.log(`${v.test.padEnd(30)} ${v.verdict}`);
}

const passCount = verdicts.filter(v => v.verdict === "PASS").length;
const failCount = verdicts.filter(v => v.verdict === "FAIL").length;
const warnCount = verdicts.filter(v => v.verdict === "WARNING").length;

let overallConfidence: string;
let pValueEquiv: number;

if (passCount >= 5) {
  overallConfidence = "HIGH CONFIDENCE";
  pValueEquiv = 0.01;
} else if (passCount >= 4 && failCount === 0) {
  overallConfidence = "HIGH CONFIDENCE";
  pValueEquiv = 0.02;
} else if (passCount >= 3 && failCount <= 1) {
  overallConfidence = "MODERATE CONFIDENCE";
  pValueEquiv = 0.05;
} else if (passCount >= 2) {
  overallConfidence = "MODERATE CONFIDENCE";
  pValueEquiv = 0.10;
} else {
  overallConfidence = "LOW CONFIDENCE";
  pValueEquiv = 0.20;
}

console.log(`\nPASS: ${passCount}  |  WARNING: ${warnCount}  |  FAIL: ${failCount}`);
console.log(`\nOverall: ${overallConfidence}`);
console.log(`Equivalent p-value: ${pValueEquiv}`);
console.log(`t-test p-value (mean PnL > 0): ${pValueTTest.toFixed(4)}`);

console.log(`\nKey findings:`);
if (pf5th > 1.0) console.log(`  - Bootstrap 5th percentile PF = ${pf5th.toFixed(2)} (>1.0: robust even in worst case)`);
else console.log(`  - Bootstrap 5th percentile PF = ${pf5th.toFixed(2)} (<1.0: fragile in worst case)`);

if (actualPFrank >= 90) console.log(`  - Entry signal at ${actualPFrank.toFixed(0)}th percentile vs random: strong directional edge`);
else if (actualPFrank >= 75) console.log(`  - Entry signal at ${actualPFrank.toFixed(0)}th percentile vs random: moderate edge`);
else console.log(`  - Entry signal at ${actualPFrank.toFixed(0)}th percentile vs random: weak or no entry edge`);

if (reversedMetrics.total < 0) console.log(`  - Reversed trades lose $${Math.abs(reversedMetrics.total).toFixed(0)}: directional signal confirmed`);
else console.log(`  - Reversed trades also profit $${reversedMetrics.total.toFixed(0)}: volatility capture, not direction`);

console.log(`  - ${stableQuarters}/4 quarters profitable: ${stableQuarters >= 3 ? "stable" : "unstable"} edge`);
console.log(`  - ${actualPnls.length} trades (need ~${nMinMean} for 95% significance)`);

// ─── Normal CDF approximation ───────────────────────────────────────
function normalCDF(x: number): number {
  // Abramowitz and Stegun approximation
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}
