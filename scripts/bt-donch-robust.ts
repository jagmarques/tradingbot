/**
 * Donchian Breakout Robustness Sweep
 * Tests parameter combinations around the winning config (30d entry, 15d exit, ATR×3)
 * to verify the edge is stable and not from one lucky setting.
 */
import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR_5M = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10; // $10 margin
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

const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Pos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; peak: number; }
interface Tr { pair: string; dir: "long"|"short"; ep: number; xp: number; et: number; xt: number; pnl: number; reason: string; holdDays: number; }

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
    if (bars.length < 200) continue; // need most of day (288 × 5m bars)
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
      // Only count trades with entry in OOS period
      // But need to simulate from warmup to handle positions correctly

      // Check exit for open position
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        // SL check (intraday)
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // Donchian exit channel (on close)
        if (!xp) {
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        // Max hold
        if (!xp && barsHeld >= maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const tr: Tr = {
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason, holdDays: barsHeld,
          };
          // Only count if entry was in OOS
          if (pos.et >= startTs) trades.push(tr);
          pos = null;
        }
      }

      // Entry signal: signal on day i-1, entry at day i open
      if (!pos && i >= warmup) {
        const prev = cs[i - 1]; // signal day
        const dHigh = donchianHigh(cs, i - 1, entryLB);
        const dLow = donchianLow(cs, i - 1, entryLB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        const ep = cs[i].o; // entry at today's open (anti-look-ahead)
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;

        pos = { pair, dir, ep, et: cs[i].t, sl, peak: ep };
      }
    }
  }
  return trades;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number; total: number; perDay: number;
}

function calcMetrics(trades: Tr[]): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, total: 0, perDay: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

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
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating to daily...");
const dailyData = new Map<string, C[]>();
for (const pair of ALL_PAIRS) {
  const raw = load5m(pair);
  if (raw.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  const daily = aggregateToDaily(raw);
  dailyData.set(pair, daily);
  console.log(`  ${pair}: ${raw.length} 5m bars -> ${daily.length} daily bars`);
}

// Parameter sweep
const entryLBs = [15, 20, 25, 30, 35, 40, 45, 50];
const atrMults = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
const maxHolds = [30, 60, 90];

interface Result {
  entryLB: number; exitLB: number; atrMult: number; maxHold: number;
  m: Metrics;
}

const results: Result[] = [];
let total = 0;

// Calculate total combos
for (const elb of entryLBs) {
  const exitLBs = [Math.round(elb / 3), Math.round(elb / 2), Math.round(elb * 2 / 3)];
  total += exitLBs.length * atrMults.length * maxHolds.length;
}

console.log(`\nSweeping ${total} parameter combinations...\n`);
let done = 0;

for (const entryLB of entryLBs) {
  const exitLBs = [...new Set([Math.round(entryLB / 3), Math.round(entryLB / 2), Math.round(entryLB * 2 / 3)])];

  for (const exitLB of exitLBs) {
    for (const atrMult of atrMults) {
      for (const maxHold of maxHolds) {
        const trades = stratDonchian(ALL_PAIRS, dailyData, entryLB, exitLB, atrMult, maxHold, OOS_START);
        const m = calcMetrics(trades);
        results.push({ entryLB, exitLB, atrMult, maxHold, m });
        done++;
        if (done % 50 === 0) process.stdout.write(`  ${done}/${total} done\r`);
      }
    }
  }
}
console.log(`  ${done}/${total} done\n`);

// ─── Output ─────────────────────────────────────────────────────────

// Sort by Sharpe
results.sort((a, b) => b.m.sharpe - a.m.sharpe);

// Top 30
console.log("=== TOP 30 PARAMETER COMBOS BY OOS SHARPE ===\n");
console.log(
  "Rank  EntryLB  ExitLB  ATR×   MaxH   Trades    WR%     PF    Sharpe     Total    $/day"
);
console.log("-".repeat(95));

for (let i = 0; i < Math.min(30, results.length); i++) {
  const r = results[i];
  const m = r.m;
  const star = (r.entryLB === 30 && r.exitLB === 15 && r.atrMult === 3.0) ? " <-- BASELINE" : "";
  console.log(
    `${String(i + 1).padStart(4)}  ${String(r.entryLB).padStart(7)}  ${String(r.exitLB).padStart(6)}  ${r.atrMult.toFixed(1).padStart(4)}  ${String(r.maxHold).padStart(5)}  ${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(7)}  ${(m.total >= 0 ? "+" : "") + "$" + m.total.toFixed(0).replace("-", "")}${m.total < 0 ? " " : "  "}  ${(m.perDay >= 0 ? "+" : "") + "$" + m.perDay.toFixed(2)}${star}`
  );
}

// Robustness metrics
const profitable = results.filter(r => r.m.pf > 1.0 && r.m.n >= 5);
const strong = results.filter(r => r.m.pf > 1.5 && r.m.n >= 5);
const withTrades = results.filter(r => r.m.n >= 5);

console.log(`\n=== ROBUSTNESS METRICS ===\n`);
console.log(`Total parameter combos: ${results.length}`);
console.log(`Combos with >= 5 trades: ${withTrades.length}`);
console.log(`Robustness Score: ${withTrades.length > 0 ? (profitable.length / withTrades.length * 100).toFixed(1) : "N/A"}% of combos profitable (PF > 1.0)`);
console.log(`Strong Combos: ${withTrades.length > 0 ? (strong.length / withTrades.length * 100).toFixed(1) : "N/A"}% have PF > 1.5`);

// Heat map: for each entry lookback, average OOS PF across all exit/ATR combos
console.log(`\n=== HEAT MAP: AVG OOS PF BY ENTRY LOOKBACK ===\n`);
console.log("EntryLB  AvgPF    AvgSharpe  AvgWR%   Combos  Profitable%  Strong%");
console.log("-".repeat(75));

for (const elb of entryLBs) {
  const subset = results.filter(r => r.entryLB === elb && r.m.n >= 5);
  if (subset.length === 0) { console.log(`${String(elb).padStart(7)}  (no trades)`); continue; }

  const avgPF = subset.reduce((s, r) => s + r.m.pf, 0) / subset.length;
  const avgSharpe = subset.reduce((s, r) => s + r.m.sharpe, 0) / subset.length;
  const avgWR = subset.reduce((s, r) => s + r.m.wr, 0) / subset.length;
  const profPct = subset.filter(r => r.m.pf > 1.0).length / subset.length * 100;
  const strongPct = subset.filter(r => r.m.pf > 1.5).length / subset.length * 100;

  console.log(
    `${String(elb).padStart(7)}  ${avgPF.toFixed(2).padStart(5)}  ${avgSharpe.toFixed(2).padStart(9)}  ${avgWR.toFixed(1).padStart(5)}%  ${String(subset.length).padStart(6)}  ${profPct.toFixed(0).padStart(10)}%  ${strongPct.toFixed(0).padStart(6)}%`
  );
}

// Heat map by ATR multiplier
console.log(`\n=== HEAT MAP: AVG OOS PF BY ATR MULTIPLIER ===\n`);
console.log("ATR×     AvgPF    AvgSharpe  AvgWR%   Combos  Profitable%  Strong%");
console.log("-".repeat(75));

for (const atr of atrMults) {
  const subset = results.filter(r => r.atrMult === atr && r.m.n >= 5);
  if (subset.length === 0) { console.log(`${atr.toFixed(1).padStart(5)}  (no trades)`); continue; }

  const avgPF = subset.reduce((s, r) => s + r.m.pf, 0) / subset.length;
  const avgSharpe = subset.reduce((s, r) => s + r.m.sharpe, 0) / subset.length;
  const avgWR = subset.reduce((s, r) => s + r.m.wr, 0) / subset.length;
  const profPct = subset.filter(r => r.m.pf > 1.0).length / subset.length * 100;
  const strongPct = subset.filter(r => r.m.pf > 1.5).length / subset.length * 100;

  console.log(
    `${atr.toFixed(1).padStart(5)}  ${avgPF.toFixed(2).padStart(5)}  ${avgSharpe.toFixed(2).padStart(9)}  ${avgWR.toFixed(1).padStart(5)}%  ${String(subset.length).padStart(6)}  ${profPct.toFixed(0).padStart(10)}%  ${strongPct.toFixed(0).padStart(6)}%`
  );
}

// Heat map by max hold
console.log(`\n=== HEAT MAP: AVG OOS PF BY MAX HOLD DAYS ===\n`);
console.log("MaxH     AvgPF    AvgSharpe  AvgWR%   Combos  Profitable%  Strong%");
console.log("-".repeat(75));

for (const mh of maxHolds) {
  const subset = results.filter(r => r.maxHold === mh && r.m.n >= 5);
  if (subset.length === 0) { console.log(`${String(mh).padStart(5)}  (no trades)`); continue; }

  const avgPF = subset.reduce((s, r) => s + r.m.pf, 0) / subset.length;
  const avgSharpe = subset.reduce((s, r) => s + r.m.sharpe, 0) / subset.length;
  const avgWR = subset.reduce((s, r) => s + r.m.wr, 0) / subset.length;
  const profPct = subset.filter(r => r.m.pf > 1.0).length / subset.length * 100;
  const strongPct = subset.filter(r => r.m.pf > 1.5).length / subset.length * 100;

  console.log(
    `${String(mh).padStart(5)}  ${avgPF.toFixed(2).padStart(5)}  ${avgSharpe.toFixed(2).padStart(9)}  ${avgWR.toFixed(1).padStart(5)}%  ${String(subset.length).padStart(6)}  ${profPct.toFixed(0).padStart(10)}%  ${strongPct.toFixed(0).padStart(6)}%`
  );
}

// Find the baseline result
const baseline = results.find(r => r.entryLB === 30 && r.exitLB === 15 && r.atrMult === 3.0 && r.maxHold === 60);
if (baseline) {
  const rank = results.indexOf(baseline) + 1;
  console.log(`\n=== BASELINE (30d/15d/ATR×3/60d hold) ===\n`);
  console.log(`Rank: ${rank} / ${results.length}`);
  console.log(`Trades: ${baseline.m.n}, WR: ${baseline.m.wr.toFixed(1)}%, PF: ${baseline.m.pf.toFixed(2)}, Sharpe: ${baseline.m.sharpe.toFixed(2)}`);
  console.log(`Total PnL: $${baseline.m.total.toFixed(2)}, $/day: $${baseline.m.perDay.toFixed(2)}`);
}

// Show neighbors of baseline (30d entry)
console.log(`\n=== BASELINE NEIGHBORS (entry=30, all exit/ATR combos, hold=60) ===\n`);
console.log("ExitLB  ATR×    Trades    WR%     PF    Sharpe     Total    $/day");
console.log("-".repeat(70));
const neighbors = results
  .filter(r => r.entryLB === 30 && r.maxHold === 60)
  .sort((a, b) => b.m.sharpe - a.m.sharpe);
for (const r of neighbors) {
  const m = r.m;
  const star = (r.exitLB === 15 && r.atrMult === 3.0) ? " <--" : "";
  console.log(
    `${String(r.exitLB).padStart(6)}  ${r.atrMult.toFixed(1).padStart(4)}  ${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(7)}  ${(m.total >= 0 ? "+" : "") + "$" + Math.abs(m.total).toFixed(0)}  ${(m.perDay >= 0 ? "+" : "") + "$" + m.perDay.toFixed(2)}${star}`
  );
}
