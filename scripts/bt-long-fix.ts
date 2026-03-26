/**
 * Long-side analysis and fix for Daily Donchian strategy.
 * Problem: longs deeply unprofitable in OOS (WR 5.9%, -$139). Shorts carry all profit.
 * This script diagnoses WHY and tests fixes.
 */
import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10;
const NOT = SIZE * LEV; // $100 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
  ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-25").getTime();

// ── Types ───────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Pos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; peak: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdDays: number;
}

// ── Data Loading ────────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
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

// ── Indicators ──────────────────────────────────────────────────────
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

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let started = false;
  for (let i = 0; i < values.length; i++) {
    if (!started) {
      if (i < period - 1) { ema[i] = 0; continue; }
      // SMA as seed
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      ema[i] = sum / period;
      started = true;
    } else {
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    sma[i] = sum / period;
  }
  return sma;
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

// ── Cost Model ──────────────────────────────────────────────────────
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

// ── Strategy Runner ─────────────────────────────────────────────────
interface StratCfg {
  entryLBLong: number;
  entryLBShort: number;
  exitLB: number;
  atrMultLong: number;
  atrMultShort: number;
  maxHoldDays: number;
  allowLongs: boolean;
  allowShorts: boolean;
  btcTrendFilterLongs: boolean;  // require BTC EMA20 > EMA50 for longs
  relStrengthFilter: boolean;    // relative strength vs BTC
  btcSmaFilter: boolean;         // skip longs when BTC below 50d SMA
}

function runStrategy(
  cfg: StratCfg,
  pairs: string[],
  dailyData: Map<string, C[]>,
  btcDaily: C[],
  startTs: number,
  endTs: number,
): Tr[] {
  const atrPeriod = 14;
  const trades: Tr[] = [];

  // Pre-compute BTC indicators
  const btcCloses = btcDaily.map(c => c.c);
  const btcEma20 = calcEMA(btcCloses, 20);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcSma50 = calcSMA(btcCloses, 50);
  const btcTsMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTsMap.set(c.t, i));

  // Pre-compute BTC 20-day returns for relative strength
  const btcRet20 = new Array(btcDaily.length).fill(0);
  for (let i = 20; i < btcDaily.length; i++) {
    btcRet20[i] = btcDaily[i].c / btcDaily[i - 20].c - 1;
  }

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs) continue;
    const maxEntryLB = Math.max(cfg.entryLBLong, cfg.entryLBShort);
    if (cs.length < maxEntryLB + atrPeriod + 10) continue;
    const atr = calcATR(cs, atrPeriod);

    // Pre-compute pair 20-day returns for relative strength
    const pairRet20 = new Array(cs.length).fill(0);
    for (let i = 20; i < cs.length; i++) {
      pairRet20[i] = cs[i].c / cs[i - 20].c - 1;
    }
    const pairTsMap = new Map<number, number>();
    cs.forEach((c, i) => pairTsMap.set(c.t, i));

    let pos: Pos | null = null;
    const warmup = Math.max(maxEntryLB, atrPeriod, 50) + 1;

    for (let i = warmup; i < cs.length; i++) {
      if (cs[i].t > endTs) break;

      // Check exit
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // Donchian exit channel
        if (!xp) {
          const exitLow = donchianLow(cs, i, cfg.exitLB);
          const exitHigh = donchianHigh(cs, i, cfg.exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        // Max hold
        if (!xp && barsHeld >= cfg.maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          const tr: Tr = {
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason, holdDays: barsHeld,
          };
          if (pos.et >= startTs && pos.et < endTs) trades.push(tr);
          pos = null;
        }
      }

      // Entry signal: signal on day i-1, entry at day i open
      if (!pos && i >= warmup && cs[i].t >= startTs) {
        const prev = cs[i - 1];
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        // Check long breakout
        const dHigh = donchianHigh(cs, i - 1, cfg.entryLBLong);
        const dLow = donchianLow(cs, i - 1, cfg.entryLBShort);

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // Direction filters
        if (dir === "long" && !cfg.allowLongs) continue;
        if (dir === "short" && !cfg.allowShorts) continue;

        // BTC trend filter for longs
        if (dir === "long" && cfg.btcTrendFilterLongs) {
          const btcIdx = btcTsMap.get(cs[i - 1].t);
          if (btcIdx !== undefined && btcIdx >= 50) {
            if (btcEma20[btcIdx] <= btcEma50[btcIdx]) continue;
          }
        }

        // BTC SMA filter for longs (skip longs when BTC below 50d SMA)
        if (dir === "long" && cfg.btcSmaFilter) {
          const btcIdx = btcTsMap.get(cs[i - 1].t);
          if (btcIdx !== undefined && btcIdx >= 50) {
            if (btcDaily[btcIdx].c < btcSma50[btcIdx]) continue;
          }
        }

        // Relative strength filter
        if (cfg.relStrengthFilter) {
          const btcIdx = btcTsMap.get(cs[i - 1].t);
          if (btcIdx !== undefined && btcIdx >= 20) {
            const pairIdx = i - 1;
            if (pairIdx >= 20) {
              const relStr = pairRet20[pairIdx] - btcRet20[btcIdx];
              // Long only if outperforming BTC, short only if underperforming
              if (dir === "long" && relStr < 0) continue;
              if (dir === "short" && relStr > 0) continue;
            }
          }
        }

        const ep = cs[i].o;
        const atrMult = dir === "long" ? cfg.atrMultLong : cfg.atrMultShort;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;

        // Cap SL at 3.5%
        const maxSL = ep * 0.035;
        const actualSL = dir === "long"
          ? Math.max(sl, ep - maxSL)
          : Math.min(sl, ep + maxSL);

        pos = { pair, dir, ep, et: cs[i].t, sl: actualSL, peak: ep };
      }
    }
  }
  return trades;
}

// ── Metrics ─────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; total: number; perDay: number; avgPnl: number;
}

function calcMetrics(trades: Tr[], periodDays?: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, total: 0, perDay: 0, avgPnl: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);
  const days = periodDays ?? ((Math.max(...trades.map(t => t.xt)) - Math.min(...trades.map(t => t.et))) / DAY);
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: Math.min(pf, 99.9),
    total,
    perDay: days > 0 ? total / days : 0,
    avgPnl: total / trades.length,
  };
}

function fmtPnl(v: number): string {
  return v >= 0 ? `+$${v.toFixed(1)}` : `-$${Math.abs(v).toFixed(1)}`;
}

function fmtPnlS(v: number): string {
  return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`;
}

// ── Main ────────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating to daily...\n");
const dailyData = new Map<string, C[]>();
for (const pair of ALL_PAIRS) {
  const raw = load5m(pair);
  if (raw.length === 0) { console.log(`  WARN: no data for ${pair}`); continue; }
  const daily = aggregateToDaily(raw);
  dailyData.set(pair, daily);
}
const btcDaily = dailyData.get("BTC")!;
console.log(`Loaded ${ALL_PAIRS.length} pairs, BTC has ${btcDaily.length} daily bars\n`);

// Baseline config: 30d entry, ATR*3, 15d exit, 60d max hold
const BASELINE: StratCfg = {
  entryLBLong: 30, entryLBShort: 30,
  exitLB: 15,
  atrMultLong: 3, atrMultShort: 3,
  maxHoldDays: 60,
  allowLongs: true, allowShorts: true,
  btcTrendFilterLongs: false,
  relStrengthFilter: false,
  btcSmaFilter: false,
};

// ════════════════════════════════════════════════════════════════════
// 1. Full-period long vs short breakdown by half-year
// ════════════════════════════════════════════════════════════════════
console.log("=".repeat(80));
console.log("1. LONG VS SHORT BREAKDOWN BY HALF-YEAR (Baseline: 30d/ATR*3/15d exit/60d hold)");
console.log("=".repeat(80));

const halfYears = [
  { label: "2023-H1", start: new Date("2023-01-01").getTime(), end: new Date("2023-07-01").getTime() },
  { label: "2023-H2", start: new Date("2023-07-01").getTime(), end: new Date("2024-01-01").getTime() },
  { label: "2024-H1", start: new Date("2024-01-01").getTime(), end: new Date("2024-07-01").getTime() },
  { label: "2024-H2", start: new Date("2024-07-01").getTime(), end: new Date("2025-01-01").getTime() },
  { label: "2025-H1", start: new Date("2025-01-01").getTime(), end: new Date("2025-07-01").getTime() },
  { label: "2025-H2", start: new Date("2025-07-01").getTime(), end: new Date("2026-01-01").getTime() },
  { label: "2026-Q1", start: new Date("2026-01-01").getTime(), end: new Date("2026-04-01").getTime() },
];

console.log("\nPeriod     | ---- LONGS ----                     | ---- SHORTS ----");
console.log("           | Trades  WR%    PF     PnL    AvgPnl | Trades  WR%    PF     PnL    AvgPnl");
console.log("-".repeat(95));

for (const hy of halfYears) {
  const trades = runStrategy(BASELINE, ALL_PAIRS, dailyData, btcDaily, hy.start, hy.end);
  const longs = trades.filter(t => t.dir === "long");
  const shorts = trades.filter(t => t.dir === "short");
  const mL = calcMetrics(longs);
  const mS = calcMetrics(shorts);
  console.log(
    `${hy.label.padEnd(10)} | ${String(mL.n).padStart(6)}  ${mL.wr.toFixed(1).padStart(5)}  ${mL.pf.toFixed(2).padStart(5)}  ${fmtPnlS(mL.total).padStart(6)}  ${fmtPnl(mL.avgPnl).padStart(7)} | ${String(mS.n).padStart(6)}  ${mS.wr.toFixed(1).padStart(5)}  ${mS.pf.toFixed(2).padStart(5)}  ${fmtPnlS(mS.total).padStart(6)}  ${fmtPnl(mS.avgPnl).padStart(7)}`
  );
}

// Full period
const allTrades = runStrategy(BASELINE, ALL_PAIRS, dailyData, btcDaily, FULL_START, END);
const allLongs = allTrades.filter(t => t.dir === "long");
const allShorts = allTrades.filter(t => t.dir === "short");
const mAL = calcMetrics(allLongs);
const mAS = calcMetrics(allShorts);
console.log("-".repeat(95));
console.log(
  `${"FULL".padEnd(10)} | ${String(mAL.n).padStart(6)}  ${mAL.wr.toFixed(1).padStart(5)}  ${mAL.pf.toFixed(2).padStart(5)}  ${fmtPnlS(mAL.total).padStart(6)}  ${fmtPnl(mAL.avgPnl).padStart(7)} | ${String(mAS.n).padStart(6)}  ${mAS.wr.toFixed(1).padStart(5)}  ${mAS.pf.toFixed(2).padStart(5)}  ${fmtPnlS(mAS.total).padStart(6)}  ${fmtPnl(mAS.avgPnl).padStart(7)}`
);

// OOS period
const oosTrades = runStrategy(BASELINE, ALL_PAIRS, dailyData, btcDaily, OOS_START, END);
const oosLongs = oosTrades.filter(t => t.dir === "long");
const oosShorts = oosTrades.filter(t => t.dir === "short");
const mOL = calcMetrics(oosLongs);
const mOS = calcMetrics(oosShorts);
console.log(
  `${"OOS".padEnd(10)} | ${String(mOL.n).padStart(6)}  ${mOL.wr.toFixed(1).padStart(5)}  ${mOL.pf.toFixed(2).padStart(5)}  ${fmtPnlS(mOL.total).padStart(6)}  ${fmtPnl(mOL.avgPnl).padStart(7)} | ${String(mOS.n).padStart(6)}  ${mOS.wr.toFixed(1).padStart(5)}  ${mOS.pf.toFixed(2).padStart(5)}  ${fmtPnlS(mOS.total).padStart(6)}  ${fmtPnl(mOS.avgPnl).padStart(7)}`
);

// ════════════════════════════════════════════════════════════════════
// 2. Market regime during OOS
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("2. BTC MARKET REGIME DURING OOS (2025-09 to 2026-03)");
console.log("=".repeat(80));

const btcTsMap = new Map<number, number>();
btcDaily.forEach((c, i) => btcTsMap.set(c.t, i));

console.log("\nDate           BTC Close     EMA20     EMA50     SMA50     Trend");
console.log("-".repeat(75));

const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
const btcSma50 = calcSMA(btcCloses, 50);

// Show first and last of each month from 2025-09 to 2026-03
const monthStarts = [
  "2025-09", "2025-10", "2025-11", "2025-12",
  "2026-01", "2026-02", "2026-03",
];

for (const ms of monthStarts) {
  // Find first and ~15th and last day in this month
  const monthBars = btcDaily.filter(c => {
    const d = new Date(c.t).toISOString().slice(0, 7);
    return d === ms;
  });
  if (monthBars.length === 0) continue;

  const showBars = [monthBars[0]];
  const mid = Math.floor(monthBars.length / 2);
  if (mid > 0 && mid < monthBars.length - 1) showBars.push(monthBars[mid]);
  showBars.push(monthBars[monthBars.length - 1]);

  for (const bar of showBars) {
    const idx = btcTsMap.get(bar.t);
    if (idx === undefined) continue;
    const e20 = btcEma20[idx];
    const e50 = btcEma50[idx];
    const s50 = btcSma50[idx];
    const trend = e20 > e50 ? "BULL" : "BEAR";
    const dateStr = new Date(bar.t).toISOString().slice(0, 10);
    console.log(
      `${dateStr}     $${bar.c.toFixed(0).padStart(7)}   $${e20.toFixed(0).padStart(7)}   $${e50.toFixed(0).padStart(7)}   $${s50.toFixed(0).padStart(7)}     ${trend}`
    );
  }
}

// Summary: what % of OOS was bear
let bearDays = 0, bullDays = 0;
for (const bar of btcDaily) {
  if (bar.t < OOS_START || bar.t >= END) continue;
  const idx = btcTsMap.get(bar.t);
  if (idx === undefined || idx < 50) continue;
  if (btcEma20[idx] > btcEma50[idx]) bullDays++;
  else bearDays++;
}
console.log(`\nOOS regime: ${bullDays} bull days, ${bearDays} bear days (${(bearDays/(bullDays+bearDays)*100).toFixed(0)}% bear)`);

// BTC drawdown
const btcOosStart = btcDaily.find(c => c.t >= OOS_START);
const btcOosEnd = btcDaily.filter(c => c.t < END).pop();
if (btcOosStart && btcOosEnd) {
  const btcChange = (btcOosEnd.c / btcOosStart.o - 1) * 100;
  console.log(`BTC: $${btcOosStart.o.toFixed(0)} -> $${btcOosEnd.c.toFixed(0)} (${btcChange >= 0 ? "+" : ""}${btcChange.toFixed(1)}%) over OOS period`);

  // Find peak and trough in OOS
  let peak = 0, trough = Infinity;
  for (const bar of btcDaily) {
    if (bar.t < OOS_START || bar.t >= END) continue;
    if (bar.h > peak) peak = bar.h;
    if (bar.l < trough) trough = bar.l;
  }
  console.log(`BTC peak: $${peak.toFixed(0)}, trough: $${trough.toFixed(0)}, max drawdown from peak: ${((trough/peak-1)*100).toFixed(1)}%`);
}

// ════════════════════════════════════════════════════════════════════
// 3. Long-side fixes
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("3. LONG-SIDE FIXES");
console.log("=".repeat(80));

interface FixResult {
  name: string;
  fullLongs: Metrics;
  fullShorts: Metrics;
  fullAll: Metrics;
  oosLongs: Metrics;
  oosShorts: Metrics;
  oosAll: Metrics;
}

const fixes: FixResult[] = [];

// Helper to run a fix
function runFix(name: string, cfg: StratCfg): FixResult {
  const fullTr = runStrategy(cfg, ALL_PAIRS, dailyData, btcDaily, FULL_START, END);
  const fullDays = (END - FULL_START) / DAY;
  const oosDays = (END - OOS_START) / DAY;

  const fL = fullTr.filter(t => t.dir === "long");
  const fS = fullTr.filter(t => t.dir === "short");

  const oosTr = fullTr.filter(t => t.et >= OOS_START);
  const oL = oosTr.filter(t => t.dir === "long");
  const oS = oosTr.filter(t => t.dir === "short");

  return {
    name,
    fullLongs: calcMetrics(fL, fullDays),
    fullShorts: calcMetrics(fS, fullDays),
    fullAll: calcMetrics(fullTr, fullDays),
    oosLongs: calcMetrics(oL, oosDays),
    oosShorts: calcMetrics(oS, oosDays),
    oosAll: calcMetrics(oosTr, oosDays),
  };
}

// (a) Baseline
fixes.push(runFix("A) Baseline", BASELINE));

// (b) Asymmetric: long 50d/ATR*2, short 30d/ATR*3
fixes.push(runFix("B) Asymmetric", {
  ...BASELINE,
  entryLBLong: 50,
  entryLBShort: 30,
  atrMultLong: 2,
  atrMultShort: 3,
}));

// (c) BTC EMA confirmation for longs
fixes.push(runFix("C) BTC-EMA longs", {
  ...BASELINE,
  btcTrendFilterLongs: true,
}));

// (d) Relative strength filter
fixes.push(runFix("D) RelStrength", {
  ...BASELINE,
  relStrengthFilter: true,
}));

// (e) BTC SMA filter for longs (skip longs when BTC below 50d SMA)
fixes.push(runFix("E) BTC-SMA longs", {
  ...BASELINE,
  btcSmaFilter: true,
}));

// (f) Shorts only
fixes.push(runFix("F) Shorts only", {
  ...BASELINE,
  allowLongs: false,
}));

// (g) Asymmetric + BTC trend
fixes.push(runFix("G) Asym+BTC-EMA", {
  ...BASELINE,
  entryLBLong: 50,
  entryLBShort: 30,
  atrMultLong: 2,
  atrMultShort: 3,
  btcTrendFilterLongs: true,
}));

// (h) BTC-EMA + RelStrength
fixes.push(runFix("H) BTC-EMA+Rel", {
  ...BASELINE,
  btcTrendFilterLongs: true,
  relStrengthFilter: true,
}));

// (i) BTC-SMA + RelStrength
fixes.push(runFix("I) BTC-SMA+Rel", {
  ...BASELINE,
  btcSmaFilter: true,
  relStrengthFilter: true,
}));

// Print results
console.log("\n--- FULL PERIOD (2023-01 to 2026-03) ---\n");
console.log("Fix                | ---- LONGS ----                   | ---- SHORTS ----                  | ---- ALL ----");
console.log("                   | N    WR%    PF    PnL    $/day    | N    WR%    PF    PnL    $/day    | N    WR%    PF    PnL    $/day");
console.log("-".repeat(125));

for (const f of fixes) {
  const fL = f.fullLongs, fS = f.fullShorts, fA = f.fullAll;
  console.log(
    `${f.name.padEnd(18)} | ${String(fL.n).padStart(4)} ${fL.wr.toFixed(1).padStart(5)}  ${fL.pf.toFixed(2).padStart(5)} ${fmtPnlS(fL.total).padStart(6)} ${fmtPnl(fL.perDay).padStart(8)} | ${String(fS.n).padStart(4)} ${fS.wr.toFixed(1).padStart(5)}  ${fS.pf.toFixed(2).padStart(5)} ${fmtPnlS(fS.total).padStart(6)} ${fmtPnl(fS.perDay).padStart(8)} | ${String(fA.n).padStart(4)} ${fA.wr.toFixed(1).padStart(5)}  ${fA.pf.toFixed(2).padStart(5)} ${fmtPnlS(fA.total).padStart(6)} ${fmtPnl(fA.perDay).padStart(8)}`
  );
}

console.log("\n--- OOS PERIOD (2025-09-01 onwards) ---\n");
console.log("Fix                | ---- LONGS ----                   | ---- SHORTS ----                  | ---- ALL ----");
console.log("                   | N    WR%    PF    PnL    $/day    | N    WR%    PF    PnL    $/day    | N    WR%    PF    PnL    $/day");
console.log("-".repeat(125));

for (const f of fixes) {
  const oL = f.oosLongs, oS = f.oosShorts, oA = f.oosAll;
  console.log(
    `${f.name.padEnd(18)} | ${String(oL.n).padStart(4)} ${oL.wr.toFixed(1).padStart(5)}  ${oL.pf.toFixed(2).padStart(5)} ${fmtPnlS(oL.total).padStart(6)} ${fmtPnl(oL.perDay).padStart(8)} | ${String(oS.n).padStart(4)} ${oS.wr.toFixed(1).padStart(5)}  ${oS.pf.toFixed(2).padStart(5)} ${fmtPnlS(oS.total).padStart(6)} ${fmtPnl(oS.perDay).padStart(8)} | ${String(oA.n).padStart(4)} ${oA.wr.toFixed(1).padStart(5)}  ${oA.pf.toFixed(2).padStart(5)} ${fmtPnlS(oA.total).padStart(6)} ${fmtPnl(oA.perDay).padStart(8)}`
  );
}

// ════════════════════════════════════════════════════════════════════
// 4. OOS Long trade detail for baseline (understand what went wrong)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("4. OOS LONG TRADES DETAIL (Baseline) - what went wrong?");
console.log("=".repeat(80));

const oosBaselineLongs = allTrades.filter(t => t.dir === "long" && t.et >= OOS_START);
console.log(`\n${oosBaselineLongs.length} long trades in OOS:\n`);
console.log("Pair     Entry Date   Exit Date    Dir    Reason          EP          XP       PnL    Hold");
console.log("-".repeat(100));

for (const t of oosBaselineLongs.sort((a, b) => a.et - b.et)) {
  console.log(
    `${t.pair.padEnd(8)} ${new Date(t.et).toISOString().slice(0, 10)}   ${new Date(t.xt).toISOString().slice(0, 10)}   ${t.dir.padEnd(6)} ${t.reason.padEnd(15)} $${t.ep.toFixed(4).padStart(10)} $${t.xp.toFixed(4).padStart(10)} ${fmtPnl(t.pnl).padStart(8)}  ${String(t.holdDays).padStart(3)}d`
  );
}

// Exit reason breakdown
const exitReasons = new Map<string, { count: number; pnl: number }>();
for (const t of oosBaselineLongs) {
  const r = exitReasons.get(t.reason) ?? { count: 0, pnl: 0 };
  r.count++;
  r.pnl += t.pnl;
  exitReasons.set(t.reason, r);
}
console.log("\nExit reason breakdown:");
for (const [reason, data] of exitReasons) {
  console.log(`  ${reason.padEnd(15)}: ${data.count} trades, ${fmtPnlS(data.pnl)} total`);
}

// ════════════════════════════════════════════════════════════════════
// 5. Best combined strategy summary
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("5. BEST COMBINED STRATEGY SUMMARY");
console.log("=".repeat(80));

// Find best fix by OOS ALL PnL (excluding shorts-only)
const bestFix = fixes
  .filter(f => f.name !== "F) Shorts only")
  .sort((a, b) => b.oosAll.total - a.oosAll.total)[0];

const shortsOnly = fixes.find(f => f.name === "F) Shorts only")!;

console.log(`\nBest long-side fix: ${bestFix.name}`);
console.log("\n                    FULL PERIOD                    OOS PERIOD");
console.log("                    N    WR%    PF    PnL  $/day   N    WR%    PF    PnL  $/day");
console.log("-".repeat(80));

const row = (label: string, fm: Metrics, om: Metrics) =>
  `${label.padEnd(19)} ${String(fm.n).padStart(4)} ${fm.wr.toFixed(1).padStart(5)}  ${fm.pf.toFixed(2).padStart(5)} ${fmtPnlS(fm.total).padStart(6)} ${fmtPnl(fm.perDay).padStart(7)}  ${String(om.n).padStart(4)} ${om.wr.toFixed(1).padStart(5)}  ${om.pf.toFixed(2).padStart(5)} ${fmtPnlS(om.total).padStart(6)} ${fmtPnl(om.perDay).padStart(7)}`;

console.log(row("Best fix (longs)", bestFix.fullLongs, bestFix.oosLongs));
console.log(row("Best fix (shorts)", bestFix.fullShorts, bestFix.oosShorts));
console.log(row("Best fix (all)", bestFix.fullAll, bestFix.oosAll));
console.log("-".repeat(80));
console.log(row("Baseline (all)", fixes[0].fullAll, fixes[0].oosAll));
console.log(row("Shorts-only", shortsOnly.fullAll, shortsOnly.oosAll));

// Improvement
const baseOos = fixes[0].oosAll.total;
const bestOos = bestFix.oosAll.total;
const improvement = bestOos - baseOos;
console.log(`\nOOS improvement over baseline: ${fmtPnlS(improvement)} (${((improvement / Math.abs(baseOos)) * 100).toFixed(0)}%)`);
console.log(`OOS vs shorts-only: best fix ${fmtPnlS(bestOos)} vs shorts-only ${fmtPnlS(shortsOnly.oosAll.total)}`);

// Final recommendation
console.log("\n" + "=".repeat(80));
console.log("RECOMMENDATION");
console.log("=".repeat(80));

// Sort fixes by OOS total PnL
const ranked = [...fixes].sort((a, b) => b.oosAll.total - a.oosAll.total);
console.log("\nAll strategies ranked by OOS total PnL:\n");
console.log("Rank  Strategy             OOS PnL   OOS $/day  OOS WR%   Full PnL  Full $/day");
console.log("-".repeat(85));
for (let i = 0; i < ranked.length; i++) {
  const f = ranked[i];
  console.log(
    `${String(i + 1).padStart(4)}  ${f.name.padEnd(20)} ${fmtPnlS(f.oosAll.total).padStart(8)}  ${fmtPnl(f.oosAll.perDay).padStart(9)}  ${f.oosAll.wr.toFixed(1).padStart(5)}%  ${fmtPnlS(f.fullAll.total).padStart(8)}  ${fmtPnl(f.fullAll.perDay).padStart(9)}`
  );
}
