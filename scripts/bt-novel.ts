/**
 * Novel / SOTA strategy backtest
 *
 * 1. Dual Momentum (Antonacci) - 12m, 6m, 3m lookbacks
 * 2. Trend Following with Volatility Targeting - EMA(50) + vol-scaled sizing
 * 3. Supertrend (3 param sets on 4h)
 * 4. Heikin-Ashi Trend Following (daily)
 * 5. Mean Reversion on Daily (3-sigma, BTC/ETH/SOL only)
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/
 * OOS: 2025-09-01 onwards
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10; // $10 margin
const NOT = SIZE * LEV; // $100 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const OOS_START = new Date("2025-09-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const ALL_PAIRS = [
  "ADA","APT","ARB","BTC","DASH","DOGE","DOT","ENA","ETH",
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
  notional?: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48; // 48 × 5m = 4h
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
    });
  }
  return result;
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

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    sma[i] = s / period;
  }
  return sma;
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean, notional: number = NOT): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = notional * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
function metrics(trades: Tr[]): {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
} {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
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

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

function printMetrics(name: string, trades: Tr[]) {
  const m = metrics(trades);
  const sign = m.total >= 0 ? "+" : "";
  console.log(
    `  ${name.padEnd(42)} `
    + `N=${String(m.n).padStart(5)}  `
    + `PnL=${sign}$${m.total.toFixed(0).padStart(7)}  `
    + `PF=${(m.pf === Infinity ? "Inf" : m.pf.toFixed(2)).padStart(5)}  `
    + `Sharpe=${m.sharpe.toFixed(2).padStart(6)}  `
    + `WR=${m.wr.toFixed(1).padStart(5)}%  `
    + `$/day=${m.perDay.toFixed(2).padStart(7)}  `
    + `MaxDD=$${m.dd.toFixed(0).padStart(6)}`
  );
}

// ─── Load All Data ──────────────────────────────────────────────────
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
const dailyData = new Map<string, C[]>();
const fourHData = new Map<string, C[]>();
for (const pair of ALL_PAIRS) {
  const c5 = load5m(pair);
  if (c5.length === 0) { console.log(`  SKIP ${pair} (no data)`); continue; }
  raw5m.set(pair, c5);
  dailyData.set(pair, aggregateToDaily(c5));
  fourHData.set(pair, aggregateTo4h(c5));
  const daily = dailyData.get(pair)!;
  console.log(`  ${pair}: ${c5.length} 5m, ${daily.length} daily, ${fourHData.get(pair)!.length} 4h`);
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 1: DUAL MOMENTUM (ANTONACCI)
// ═══════════════════════════════════════════════════════════════════
function stratDualMomentum(lookbackMonths: number): Tr[] {
  const trades: Tr[] = [];
  const lookbackDays = lookbackMonths * 30;

  // Build monthly rebalance dates from OOS start
  const rebalDates: number[] = [];
  const allDailyTs = new Set<number>();
  for (const [, cs] of dailyData) for (const c of cs) if (c.t >= OOS_START) allDailyTs.add(c.t);
  const sortedDays = [...allDailyTs].sort((a, b) => a - b);

  // First of each month
  let lastMonth = -1;
  for (const t of sortedDays) {
    const d = new Date(t);
    const m = d.getFullYear() * 12 + d.getMonth();
    if (m !== lastMonth) { rebalDates.push(t); lastMonth = m; }
  }

  // Active positions
  const positions = new Map<string, { ep: number; et: number; dir: "long"|"short" }>();

  for (let ri = 0; ri < rebalDates.length; ri++) {
    const rebalTs = rebalDates[ri];
    const nextRebalTs = ri + 1 < rebalDates.length ? rebalDates[ri + 1] : Infinity;

    // Close all existing positions at rebalance
    for (const [pair, pos] of positions) {
      const cs = dailyData.get(pair)!;
      const bar = cs.find(c => c.t >= rebalTs);
      if (!bar) continue;
      const xp = bar.o;
      const pnl = tradePnl(pair, pos.ep, xp, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: rebalTs, pnl, reason: "rebalance" });
    }
    positions.clear();

    // Rank pairs by lookback return
    const ranked: { pair: string; ret: number }[] = [];
    for (const pair of ALL_PAIRS) {
      const cs = dailyData.get(pair);
      if (!cs) continue;
      // Find bar at rebalance and bar lookbackDays ago
      const currIdx = cs.findIndex(c => c.t >= rebalTs);
      if (currIdx < 0) continue;
      const lookbackTs = rebalTs - lookbackDays * DAY;
      const pastIdx = cs.findIndex(c => c.t >= lookbackTs);
      if (pastIdx < 0 || pastIdx >= currIdx) continue;
      const ret = cs[currIdx].o / cs[pastIdx].c - 1;
      ranked.push({ pair, ret });
    }

    // Absolute momentum: positive return only
    const absFiltered = ranked.filter(r => r.ret > 0);
    // Relative momentum: top 5
    absFiltered.sort((a, b) => b.ret - a.ret);
    const selected = absFiltered.slice(0, 5);

    // Open long positions
    for (const s of selected) {
      const cs = dailyData.get(s.pair)!;
      const bar = cs.find(c => c.t >= rebalTs);
      if (!bar) continue;
      positions.set(s.pair, { ep: bar.o, et: rebalTs, dir: "long" });
    }
  }

  // Close remaining
  for (const [pair, pos] of positions) {
    const cs = dailyData.get(pair)!;
    const lastBar = cs[cs.length - 1];
    const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
    trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 2: TREND FOLLOWING WITH VOLATILITY TARGETING
// ═══════════════════════════════════════════════════════════════════
function stratVolTarget(): Tr[] {
  const trades: Tr[] = [];
  const TARGET_VOL = 0.15; // 15% annualized
  const TRAIL_ATR_MULT = 2.5;

  for (const pair of ALL_PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 60) continue;

    const closes = cs.map(c => c.c);
    const ema50 = calcEMA(closes, 50);
    const atr = calcATR(cs, 14);

    let pos: { dir: "long"|"short"; ep: number; et: number; peak: number; sl: number; notional: number } | null = null;

    for (let i = 51; i < cs.length; i++) {
      if (cs[i].t < OOS_START) continue;

      // Calculate realized vol (20-day rolling std of daily returns)
      let sumRet = 0, sumRetSq = 0, nRet = 0;
      for (let j = Math.max(1, i - 19); j <= i; j++) {
        const r = cs[j].c / cs[j-1].c - 1;
        sumRet += r; sumRetSq += r * r; nRet++;
      }
      if (nRet < 10) continue;
      const meanRet = sumRet / nRet;
      const dailyVol = Math.sqrt(sumRetSq / nRet - meanRet * meanRet);
      const annualVol = dailyVol * Math.sqrt(365);
      if (annualVol <= 0) continue;

      // Volatility-scaled notional
      const scaledNotional = Math.min(NOT * 3, Math.max(NOT * 0.25, NOT * (TARGET_VOL / annualVol)));

      // Use signal from bar i-1 (anti look-ahead)
      const prevEma = ema50[i - 1];
      if (prevEma === 0) continue;
      const desiredDir: "long"|"short" = cs[i-1].c > prevEma ? "long" : "short";

      // Manage existing position
      if (pos) {
        const bar = cs[i];
        // Trail SL
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          const trailSL = pos.peak - TRAIL_ATR_MULT * atr[i-1];
          pos.sl = Math.max(pos.sl, trailSL);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          const trailSL = pos.peak + TRAIL_ATR_MULT * atr[i-1];
          pos.sl = Math.min(pos.sl, trailSL);
        }

        let xp = 0, reason = "";

        // SL hit
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "trail-sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "trail-sl"; }

        // Direction flip
        if (!xp && desiredDir !== pos.dir) { xp = bar.o; reason = "flip"; }

        if (xp) {
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, reason === "trail-sl", pos.notional);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason, notional: pos.notional });
          pos = null;
        }
      }

      // Open new position if none
      if (!pos) {
        const ep = cs[i].o;
        const sl = desiredDir === "long"
          ? ep - TRAIL_ATR_MULT * atr[i-1]
          : ep + TRAIL_ATR_MULT * atr[i-1];
        pos = { dir: desiredDir, ep, et: cs[i].t, peak: ep, sl, notional: scaledNotional };
      }
    }

    // Close remaining
    if (pos) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false, pos.notional);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end", notional: pos.notional });
      pos = null;
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 3: SUPERTREND
// ═══════════════════════════════════════════════════════════════════
function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1); // 1 = up (bullish), -1 = down (bearish)

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    // Carry forward
    if (i > atrPeriod) {
      const prevUpper = (cs[i-1].h + cs[i-1].l) / 2 + mult * atr[i-1];
      const prevLower = (cs[i-1].h + cs[i-1].l) / 2 - mult * atr[i-1];
      // Final bands from previous iteration
      const prevFinalUpper = st[i-1] > 0 && dirs[i-1] === -1 ? st[i-1] : prevUpper;
      const prevFinalLower = st[i-1] > 0 && dirs[i-1] === 1 ? st[i-1] : prevLower;

      if (lowerBand > prevFinalLower || cs[i-1].c < prevFinalLower) {
        // keep lowerBand
      } else {
        lowerBand = prevFinalLower;
      }
      if (upperBand < prevFinalUpper || cs[i-1].c > prevFinalUpper) {
        // keep upperBand
      } else {
        upperBand = prevFinalUpper;
      }
    }

    // Determine direction
    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i-1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

function stratSupertrend(atrPeriod: number, mult: number): Tr[] {
  const trades: Tr[] = [];

  for (const pair of ALL_PAIRS) {
    const cs = fourHData.get(pair);
    if (!cs || cs.length < atrPeriod + 20) continue;

    const { dir } = calcSupertrend(cs, atrPeriod, mult);

    let pos: { dir: "long"|"short"; ep: number; et: number } | null = null;

    for (let i = atrPeriod + 1; i < cs.length; i++) {
      if (cs[i].t < OOS_START) continue;

      // Signal from bar i-1 (anti look-ahead)
      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      if (pos && flipped) {
        // Exit
        const xp = cs[i].o;
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: cs[i].t, pnl, reason: "flip" });
        pos = null;
      }

      if (!pos && flipped) {
        const newDir: "long"|"short" = prevDir === 1 ? "long" : "short";
        pos = { dir: newDir, ep: cs[i].o, et: cs[i].t };
      }
    }

    // Close remaining
    if (pos) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 4: HEIKIN-ASHI TREND FOLLOWING (Daily)
// ═══════════════════════════════════════════════════════════════════
function toHeikinAshi(cs: C[]): C[] {
  const ha: C[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i === 0) {
      const haClose = (cs[0].o + cs[0].h + cs[0].l + cs[0].c) / 4;
      ha.push({ t: cs[0].t, o: cs[0].o, h: cs[0].h, l: cs[0].l, c: haClose });
    } else {
      const haClose = (cs[i].o + cs[i].h + cs[i].l + cs[i].c) / 4;
      const haOpen = (ha[i-1].o + ha[i-1].c) / 2;
      ha.push({
        t: cs[i].t,
        o: haOpen,
        h: Math.max(cs[i].h, haOpen, haClose),
        l: Math.min(cs[i].l, haOpen, haClose),
        c: haClose,
      });
    }
  }
  return ha;
}

function stratHeikinAshi(): Tr[] {
  const trades: Tr[] = [];

  for (const pair of ALL_PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 30) continue;

    const ha = toHeikinAshi(cs);
    const atr = calcATR(cs, 14);

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;

    for (let i = 5; i < cs.length; i++) {
      if (cs[i].t < OOS_START) continue;

      // Check previous 3 HA candles (i-3, i-2, i-1) for signal — anti look-ahead
      const ha1 = ha[i-3], ha2 = ha[i-2], ha3 = ha[i-1];
      if (!ha1 || !ha2 || !ha3) continue;

      const isGreen = (c: C) => c.c > c.o;
      const isRed = (c: C) => c.c < c.o;
      // No lower wick for bullish: low equals open (body starts at bottom)
      const noLowerWick = (c: C) => Math.abs(c.l - Math.min(c.o, c.c)) < (c.h - c.l) * 0.01;
      // No upper wick for bearish: high equals open (body starts at top)
      const noUpperWick = (c: C) => Math.abs(c.h - Math.max(c.o, c.c)) < (c.h - c.l) * 0.01;

      const bullSignal = isGreen(ha1) && isGreen(ha2) && isGreen(ha3)
        && noLowerWick(ha1) && noLowerWick(ha2) && noLowerWick(ha3);
      const bearSignal = isRed(ha1) && isRed(ha2) && isRed(ha3)
        && noUpperWick(ha1) && noUpperWick(ha2) && noUpperWick(ha3);

      // Exit on first opposite color HA candle
      if (pos) {
        const currHA = ha[i-1]; // signal from bar i-1
        let shouldExit = false;
        if (pos.dir === "long" && isRed(currHA)) shouldExit = true;
        if (pos.dir === "short" && isGreen(currHA)) shouldExit = true;

        // SL check on daily bar
        const bar = cs[i];
        if (pos.dir === "long" && bar.l <= pos.sl) {
          const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl, reason: "sl" });
          pos = null;
          continue;
        }
        if (pos.dir === "short" && bar.h >= pos.sl) {
          const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl, reason: "sl" });
          pos = null;
          continue;
        }

        if (shouldExit) {
          const xp = cs[i].o;
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, false);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: cs[i].t, pnl, reason: "ha-exit" });
          pos = null;
        }
      }

      // Open new
      if (!pos && (bullSignal || bearSignal)) {
        const dir: "long"|"short" = bullSignal ? "long" : "short";
        const ep = cs[i].o;
        const atrVal = atr[i-1] || atr[i-2] || 0;
        if (atrVal === 0) continue;
        const sl = dir === "long" ? ep - 2 * atrVal : ep + 2 * atrVal;
        pos = { dir, ep, et: cs[i].t, sl };
      }
    }

    // Close remaining
    if (pos) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 5: MEAN REVERSION ON DAILY (3-SIGMA, BTC/ETH/SOL)
// ═══════════════════════════════════════════════════════════════════
function stratMeanRev(): Tr[] {
  const trades: Tr[] = [];
  const MR_PAIRS = ["BTC", "ETH", "SOL"];
  const ZSCORE_LB = 20;

  for (const pair of MR_PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ZSCORE_LB + 5) continue;

    const closes = cs.map(c => c.c);
    const sma20 = calcSMA(closes, ZSCORE_LB);

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number; tp: number } | null = null;

    for (let i = ZSCORE_LB + 1; i < cs.length; i++) {
      if (cs[i].t < OOS_START) continue;

      // Compute z-score on bar i-1 (anti look-ahead)
      const prevIdx = i - 1;
      const mean = sma20[prevIdx];
      if (mean === 0) continue;

      let sumSq = 0;
      for (let j = prevIdx - ZSCORE_LB + 1; j <= prevIdx; j++) {
        sumSq += (closes[j] - mean) ** 2;
      }
      const std = Math.sqrt(sumSq / ZSCORE_LB);
      if (std === 0) continue;

      const z = (closes[prevIdx] - mean) / std;

      // Manage position
      if (pos) {
        const bar = cs[i];
        let xp = 0, reason = "";

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }

        // TP check (mean reversion target)
        if (!xp) {
          if (pos.dir === "long" && bar.h >= pos.tp) { xp = pos.tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= pos.tp) { xp = pos.tp; reason = "tp"; }
        }

        if (xp) {
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, reason === "sl");
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          pos = null;
        }
      }

      // Entry: 3-sigma deviation
      if (!pos) {
        if (z <= -3) {
          // Price crashed below 3-sigma -> long (mean reversion)
          const ep = cs[i].o;
          const tp = mean; // revert to mean
          const sl = mean - 4 * std; // 4-sigma SL
          pos = { dir: "long", ep, et: cs[i].t, sl, tp };
        } else if (z >= 3) {
          // Price pumped above 3-sigma -> short (mean reversion)
          const ep = cs[i].o;
          const tp = mean; // revert to mean
          const sl = mean + 4 * std; // 4-sigma SL
          pos = { dir: "short", ep, et: cs[i].t, sl, tp };
        }
      }
    }

    // Close remaining
    if (pos) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════
// RUN ALL STRATEGIES
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("NOVEL STRATEGY BACKTEST — OOS from 2025-09-01");
console.log("Cost: taker 0.035%, spread map, 1.5x SL slip, 10x lev, $10 margin");
console.log("=".repeat(110));

// 1. Dual Momentum
console.log("\n--- 1. DUAL MOMENTUM (Antonacci) ---");
console.log("  Long top-5 pairs with positive abs momentum, rebalance monthly\n");
for (const lb of [3, 6, 12]) {
  const trades = stratDualMomentum(lb);
  printMetrics(`Lookback=${lb}mo`, trades);
}

// 2. Vol-Targeted Trend Following
console.log("\n--- 2. TREND FOLLOWING + VOLATILITY TARGETING ---");
console.log("  EMA(50) direction, vol-scaled sizing, 2.5x ATR trail\n");
const volTrades = stratVolTarget();
printMetrics("VolTarget 15% ann", volTrades);

// Breakdown by pair
const volByPair = new Map<string, Tr[]>();
for (const t of volTrades) {
  const arr = volByPair.get(t.pair) ?? [];
  arr.push(t);
  volByPair.set(t.pair, arr);
}
console.log("\n  Per-pair breakdown:");
for (const pair of ALL_PAIRS) {
  const pt = volByPair.get(pair);
  if (!pt || pt.length === 0) continue;
  const m = metrics(pt);
  const sign = m.total >= 0 ? "+" : "";
  console.log(`    ${pair.padEnd(6)} N=${String(m.n).padStart(3)}  PnL=${sign}$${m.total.toFixed(1).padStart(8)}  WR=${m.wr.toFixed(0).padStart(3)}%  $/day=${m.perDay.toFixed(2).padStart(6)}`);
}

// 3. Supertrend
console.log("\n--- 3. SUPERTREND (4h bars) ---");
console.log("  Long above / short below supertrend, exit on flip\n");
for (const [atrP, mult] of [[10, 3], [14, 2], [7, 4]] as [number, number][]) {
  const trades = stratSupertrend(atrP, mult);
  printMetrics(`ST(${atrP}, ${mult})`, trades);
}

// Best supertrend per-pair breakdown
const bestSTTrades = stratSupertrend(10, 3);
const stByPair = new Map<string, Tr[]>();
for (const t of bestSTTrades) {
  const arr = stByPair.get(t.pair) ?? [];
  arr.push(t);
  stByPair.set(t.pair, arr);
}
console.log("\n  Per-pair ST(10,3):");
for (const pair of ALL_PAIRS) {
  const pt = stByPair.get(pair);
  if (!pt || pt.length === 0) continue;
  const m = metrics(pt);
  const sign = m.total >= 0 ? "+" : "";
  console.log(`    ${pair.padEnd(6)} N=${String(m.n).padStart(3)}  PnL=${sign}$${m.total.toFixed(1).padStart(8)}  WR=${m.wr.toFixed(0).padStart(3)}%  $/day=${m.perDay.toFixed(2).padStart(6)}`);
}

// 4. Heikin-Ashi
console.log("\n--- 4. HEIKIN-ASHI TREND FOLLOWING (Daily) ---");
console.log("  3 green/no-lower-wick -> long, 3 red/no-upper-wick -> short, exit on color flip\n");
const haTrades = stratHeikinAshi();
printMetrics("HA Trend", haTrades);

// HA per-pair breakdown
const haByPair = new Map<string, Tr[]>();
for (const t of haTrades) {
  const arr = haByPair.get(t.pair) ?? [];
  arr.push(t);
  haByPair.set(t.pair, arr);
}
console.log("\n  Per-pair breakdown:");
for (const pair of ALL_PAIRS) {
  const pt = haByPair.get(pair);
  if (!pt || pt.length === 0) continue;
  const m = metrics(pt);
  const sign = m.total >= 0 ? "+" : "";
  console.log(`    ${pair.padEnd(6)} N=${String(m.n).padStart(3)}  PnL=${sign}$${m.total.toFixed(1).padStart(8)}  WR=${m.wr.toFixed(0).padStart(3)}%  $/day=${m.perDay.toFixed(2).padStart(6)}`);
}

// 5. Mean Reversion
console.log("\n--- 5. MEAN REVERSION DAILY (3-sigma, BTC/ETH/SOL) ---");
console.log("  Entry on 3-sigma move, TP at SMA(20), SL at 4-sigma\n");
const mrTrades = stratMeanRev();
printMetrics("MeanRev 3sig", mrTrades);

// MR per-pair
const mrByPair = new Map<string, Tr[]>();
for (const t of mrTrades) {
  const arr = mrByPair.get(t.pair) ?? [];
  arr.push(t);
  mrByPair.set(t.pair, arr);
}
console.log("\n  Per-pair breakdown:");
for (const pair of ["BTC", "ETH", "SOL"]) {
  const pt = mrByPair.get(pair);
  if (!pt || pt.length === 0) { console.log(`    ${pair.padEnd(6)} No trades`); continue; }
  const m = metrics(pt);
  const sign = m.total >= 0 ? "+" : "";
  console.log(`    ${pair.padEnd(6)} N=${String(m.n).padStart(3)}  PnL=${sign}$${m.total.toFixed(1).padStart(8)}  WR=${m.wr.toFixed(0).padStart(3)}%  $/day=${m.perDay.toFixed(2).padStart(6)}`);
}

// ═══════════════════════════════════════════════════════════════════
// SUMMARY COMPARISON TABLE
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("SUMMARY COMPARISON");
console.log("=".repeat(110));
console.log(
  "  Strategy".padEnd(48)
  + "N".padStart(6)
  + "PnL".padStart(10)
  + "PF".padStart(7)
  + "Sharpe".padStart(8)
  + "WR".padStart(7)
  + "$/day".padStart(9)
  + "MaxDD".padStart(9)
);
console.log("-".repeat(110));

const allResults: { name: string; trades: Tr[] }[] = [
  { name: "Dual Momentum 3mo", trades: stratDualMomentum(3) },
  { name: "Dual Momentum 6mo", trades: stratDualMomentum(6) },
  { name: "Dual Momentum 12mo", trades: stratDualMomentum(12) },
  { name: "Vol-Target Trend EMA(50)", trades: volTrades },
  { name: "Supertrend(10,3) 4h", trades: bestSTTrades },
  { name: "Supertrend(14,2) 4h", trades: stratSupertrend(14, 2) },
  { name: "Supertrend(7,4) 4h", trades: stratSupertrend(7, 4) },
  { name: "Heikin-Ashi Daily", trades: haTrades },
  { name: "MeanRev 3sig BTC/ETH/SOL", trades: mrTrades },
];

for (const r of allResults) {
  const m = metrics(r.trades);
  const sign = m.total >= 0 ? "+" : "";
  console.log(
    `  ${r.name.padEnd(46)}`
    + `${String(m.n).padStart(6)}`
    + `${sign}$${m.total.toFixed(0).padStart(7)}`.padStart(10)
    + `${(m.pf === Infinity ? "Inf" : m.pf.toFixed(2)).padStart(7)}`
    + `${m.sharpe.toFixed(2).padStart(8)}`
    + `${m.wr.toFixed(1).padStart(6)}%`
    + `${m.perDay.toFixed(2).padStart(9)}`
    + `  $${m.dd.toFixed(0).padStart(6)}`
  );
}

console.log("\nDone.");
