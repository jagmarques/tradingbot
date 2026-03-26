/**
 * Funding Rate Filter Backtest
 *
 * Tests cross-sectional funding rate filters to improve Donchian strategy.
 * No actual funding data available -- simulates funding as (close-open)/open * 0.1.
 *
 * Strategies:
 * 0. Baseline Donchian (30d entry, 15d exit, ATR*3 stop, BTC filter for longs)
 * 1. Funding Rate Contrarian Filter (cross-sectional rank)
 * 2. Funding Rate Momentum Filter (3-day change)
 * 3. Extreme Funding Contrarian (own 30d range percentile)
 * 4. Donchian + Funding Confirmation (direction alignment)
 * 5. Funding Carry Only (weekly rebalance, no trend signal)
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to daily.
 * OOS: 2025-09-01 onwards. Full period from 2023-01.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 5; // $5 margin
const NOT = SIZE * LEV; // $50 notional
const FEE = 0.00035;
const DAY = 86400000;

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

const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();
const FULL_START = new Date("2023-01-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Pos {
  pair: string; dir: "long"|"short"; ep: number; et: number;
  sl: number; atrAtEntry: number;
}
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; holdDays: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
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
    if (bars.length < 200) continue; // skip partial days
    daily.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
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

// ─── Cost Calculation ───────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics { n: number; wr: number; pf: number; sharpe: number; dd: number; total: number; perDay: number; }

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const days = (endTs - startTs) / DAY;
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

// ─── Simulated Funding Rate ─────────────────────────────────────────
// funding[pair][dayIdx] = simulated daily funding rate
function computeSimulatedFunding(dailyData: Map<string, C[]>): Map<string, number[]> {
  const fundingMap = new Map<string, number[]>();
  for (const [pair, cs] of dailyData) {
    const fr = new Array(cs.length).fill(0);
    for (let i = 0; i < cs.length; i++) {
      if (cs[i].o > 0) {
        fr[i] = ((cs[i].c - cs[i].o) / cs[i].o) * 0.1;
      }
    }
    fundingMap.set(pair, fr);
  }
  return fundingMap;
}

// 7-day average funding
function avg7dFunding(fr: number[], idx: number): number {
  if (idx < 7) return 0;
  let s = 0;
  for (let i = idx - 7; i < idx; i++) s += fr[i];
  return s / 7;
}

// 3-day funding change
function funding3dChange(fr: number[], idx: number): number {
  if (idx < 4) return 0;
  const now = (fr[idx-1] + fr[idx-2] + fr[idx-3]) / 3;
  const prev = idx >= 7 ? (fr[idx-4] + fr[idx-5] + fr[idx-6]) / 3 : 0;
  return now - prev;
}

// Percentile within own 30-day range
function fundingPercentile30d(fr: number[], idx: number): number {
  if (idx < 30) return 0.5;
  const window: number[] = [];
  for (let i = idx - 30; i < idx; i++) window.push(fr[i]);
  const sorted = [...window].sort((a, b) => a - b);
  const current = fr[idx - 1]; // use yesterday's
  let rank = 0;
  for (const v of sorted) if (v <= current) rank++;
  return rank / sorted.length;
}

// Cross-sectional rank at a given day (1=most negative, N=most positive)
function crossSectionalRank(
  pairs: string[],
  fundingMap: Map<string, number[]>,
  timeIdxMap: Map<string, Map<number, number>>,
  dayTs: number,
): Map<string, number> {
  const values: { pair: string; val: number }[] = [];
  for (const pair of pairs) {
    const fr = fundingMap.get(pair);
    const tm = timeIdxMap.get(pair);
    if (!fr || !tm) continue;
    const idx = tm.get(dayTs);
    if (idx === undefined || idx < 7) continue;
    values.push({ pair, val: avg7dFunding(fr, idx) });
  }
  values.sort((a, b) => a.val - b.val);
  const ranks = new Map<string, number>();
  values.forEach((v, i) => ranks.set(v.pair, i + 1));
  return ranks;
}

// ─── BTC Trend Filter ───────────────────────────────────────────────
function buildBtcTrend(btcDaily: C[]): Map<number, "long"|"short"> {
  const closes = btcDaily.map(c => c.c);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const map = new Map<number, "long"|"short">();
  for (let i = 50; i < btcDaily.length; i++) {
    if (ema20[i] > 0 && ema50[i] > 0) {
      map.set(btcDaily[i].t, ema20[i] > ema50[i] ? "long" : "short");
    }
  }
  return map;
}

// ─── Strategy 0: Baseline Donchian ──────────────────────────────────
function runBaseline(
  pairs: string[],
  dailyData: Map<string, C[]>,
  btcTrend: Map<number, "long"|"short">,
  minTs: number,
  maxTs: number,
): Tr[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PERIOD = 14;
  const MAX_HOLD = 60;

  const trades: Tr[] = [];

  for (const pair of pairs) {
    if (pair === "BTC") continue;
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ENTRY_LB + ATR_PERIOD + 10) continue;
    const atr = calcATR(cs, ATR_PERIOD);

    let pos: Pos | null = null;
    const warmup = Math.max(ENTRY_LB, ATR_PERIOD, 30) + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Check exit
      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, EXIT_LB);
          const exitHigh = donchianHigh(cs, i, EXIT_LB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          if (bar.t >= minTs && bar.t < maxTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
              reason, holdDays: barsHeld,
            });
          }
          pos = null;
        }
      }

      // Entry
      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, ENTRY_LB);
        const dLow = donchianLow(cs, i - 1, ENTRY_LB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long"|"short"|null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // BTC filter: longs only in uptrend
        if (dir === "long") {
          const bt = btcTrend.get(bar.t);
          if (!bt || bt !== "long") continue;
        }

        const ep = bar.o;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { pair, dir, ep, et: bar.t, sl, atrAtEntry: curATR };
      }
    }
  }

  return trades;
}

// ─── Strategy 1: Funding Contrarian Filter ──────────────────────────
function runFundingContrarian(
  pairs: string[],
  dailyData: Map<string, C[]>,
  btcTrend: Map<number, "long"|"short">,
  fundingMap: Map<string, number[]>,
  timeIdxMap: Map<string, Map<number, number>>,
  minTs: number,
  maxTs: number,
): Tr[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PERIOD = 14;
  const MAX_HOLD = 60;

  const trades: Tr[] = [];
  const totalPairs = pairs.filter(p => p !== "BTC").length;
  const medianRank = totalPairs / 2;

  for (const pair of pairs) {
    if (pair === "BTC") continue;
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ENTRY_LB + ATR_PERIOD + 10) continue;
    const atr = calcATR(cs, ATR_PERIOD);

    let pos: Pos | null = null;
    const warmup = Math.max(ENTRY_LB, ATR_PERIOD, 30) + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, EXIT_LB);
          const exitHigh = donchianHigh(cs, i, EXIT_LB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          if (bar.t >= minTs && bar.t < maxTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
              reason, holdDays: barsHeld,
            });
          }
          pos = null;
        }
      }

      if (!pos && i >= warmup) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, ENTRY_LB);
        const dLow = donchianLow(cs, i - 1, ENTRY_LB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long"|"short"|null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // BTC filter for longs
        if (dir === "long") {
          const bt = btcTrend.get(bar.t);
          if (!bt || bt !== "long") continue;
        }

        // Funding contrarian filter: cross-sectional rank
        const ranks = crossSectionalRank(pairs, fundingMap, timeIdxMap, cs[i-1].t);
        const myRank = ranks.get(pair);
        if (myRank === undefined) continue;

        // Longs: bottom 50% (low/negative funding = cheap to hold long)
        if (dir === "long" && myRank > medianRank) continue;
        // Shorts: top 50% (high/positive funding = collect funding as short)
        if (dir === "short" && myRank <= medianRank) continue;

        const ep = bar.o;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { pair, dir, ep, et: bar.t, sl, atrAtEntry: curATR };
      }
    }
  }

  return trades;
}

// ─── Strategy 2: Funding Momentum Filter ────────────────────────────
function runFundingMomentum(
  pairs: string[],
  dailyData: Map<string, C[]>,
  btcTrend: Map<number, "long"|"short">,
  fundingMap: Map<string, number[]>,
  timeIdxMap: Map<string, Map<number, number>>,
  minTs: number,
  maxTs: number,
): Tr[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PERIOD = 14;
  const MAX_HOLD = 60;

  const trades: Tr[] = [];

  for (const pair of pairs) {
    if (pair === "BTC") continue;
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ENTRY_LB + ATR_PERIOD + 10) continue;
    const atr = calcATR(cs, ATR_PERIOD);
    const fr = fundingMap.get(pair);
    const tm = timeIdxMap.get(pair);

    let pos: Pos | null = null;
    const warmup = Math.max(ENTRY_LB, ATR_PERIOD, 30) + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, EXIT_LB);
          const exitHigh = donchianHigh(cs, i, EXIT_LB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          if (bar.t >= minTs && bar.t < maxTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
              reason, holdDays: barsHeld,
            });
          }
          pos = null;
        }
      }

      if (!pos && i >= warmup && fr && tm) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, ENTRY_LB);
        const dLow = donchianLow(cs, i - 1, ENTRY_LB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long"|"short"|null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // BTC filter for longs
        if (dir === "long") {
          const bt = btcTrend.get(bar.t);
          if (!bt || bt !== "long") continue;
        }

        // Funding momentum filter
        const frIdx = tm.get(cs[i-1].t);
        if (frIdx === undefined || frIdx < 7) continue;
        const fChange = funding3dChange(fr, frIdx);

        // Longs: enter when funding is decreasing (becoming cheaper)
        if (dir === "long" && fChange >= 0) continue;
        // Shorts: enter when funding is increasing (becoming crowded long)
        if (dir === "short" && fChange <= 0) continue;

        const ep = bar.o;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { pair, dir, ep, et: bar.t, sl, atrAtEntry: curATR };
      }
    }
  }

  return trades;
}

// ─── Strategy 3: Extreme Funding Contrarian ─────────────────────────
function runExtremeFunding(
  pairs: string[],
  dailyData: Map<string, C[]>,
  fundingMap: Map<string, number[]>,
  timeIdxMap: Map<string, Map<number, number>>,
  minTs: number,
  maxTs: number,
): Tr[] {
  const ATR_MULT = 3;
  const ATR_PERIOD = 14;
  const MAX_HOLD = 30; // shorter hold for mean-reversion

  const trades: Tr[] = [];

  for (const pair of pairs) {
    if (pair === "BTC" || pair === "ETH") continue; // skip majors for this
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 45) continue;
    const atr = calcATR(cs, ATR_PERIOD);
    const fr = fundingMap.get(pair);
    const tm = timeIdxMap.get(pair);
    if (!fr || !tm) continue;

    let pos: Pos | null = null;
    const warmup = 35;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        // Exit when funding normalizes (back to 40-60% percentile)
        if (!xp) {
          const frIdx = tm.get(bar.t);
          if (frIdx !== undefined && frIdx >= 30) {
            const pct = fundingPercentile30d(fr, frIdx);
            if (pct >= 0.4 && pct <= 0.6) { xp = bar.c; reason = "funding-norm"; }
          }
        }

        if (xp > 0) {
          if (bar.t >= minTs && bar.t < maxTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
              reason, holdDays: barsHeld,
            });
          }
          pos = null;
        }
      }

      if (!pos && i >= warmup) {
        const frIdx = tm.get(cs[i-1].t);
        if (frIdx === undefined || frIdx < 30) continue;
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        const pct = fundingPercentile30d(fr, frIdx);

        let dir: "long"|"short"|null = null;
        // Extreme negative funding (bottom 10%): long (oversold, shorts paying heavily)
        if (pct <= 0.10) dir = "long";
        // Extreme positive funding (top 10%): short (overbought, longs paying heavily)
        else if (pct >= 0.90) dir = "short";
        if (!dir) continue;

        const ep = bar.o;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { pair, dir, ep, et: bar.t, sl, atrAtEntry: curATR };
      }
    }
  }

  return trades;
}

// ─── Strategy 4: Donchian + Funding Confirmation ────────────────────
function runDonchianFundingConfirm(
  pairs: string[],
  dailyData: Map<string, C[]>,
  btcTrend: Map<number, "long"|"short">,
  fundingMap: Map<string, number[]>,
  timeIdxMap: Map<string, Map<number, number>>,
  minTs: number,
  maxTs: number,
): Tr[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PERIOD = 14;
  const MAX_HOLD = 60;

  const trades: Tr[] = [];

  for (const pair of pairs) {
    if (pair === "BTC") continue;
    const cs = dailyData.get(pair);
    if (!cs || cs.length < ENTRY_LB + ATR_PERIOD + 10) continue;
    const atr = calcATR(cs, ATR_PERIOD);
    const fr = fundingMap.get(pair);
    const tm = timeIdxMap.get(pair);

    let pos: Pos | null = null;
    const warmup = Math.max(ENTRY_LB, ATR_PERIOD, 30) + 1;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        if (!xp) {
          const exitLow = donchianLow(cs, i, EXIT_LB);
          const exitHigh = donchianHigh(cs, i, EXIT_LB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        if (!xp && barsHeld >= MAX_HOLD) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          if (bar.t >= minTs && bar.t < maxTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
              pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
              reason, holdDays: barsHeld,
            });
          }
          pos = null;
        }
      }

      if (!pos && i >= warmup && fr && tm) {
        const prev = cs[i - 1];
        const dHigh = donchianHigh(cs, i - 1, ENTRY_LB);
        const dLow = donchianLow(cs, i - 1, ENTRY_LB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long"|"short"|null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        // BTC filter for longs
        if (dir === "long") {
          const bt = btcTrend.get(bar.t);
          if (!bt || bt !== "long") continue;
        }

        // Funding confirmation: direction must align
        const frIdx = tm.get(cs[i-1].t);
        if (frIdx === undefined || frIdx < 7) continue;
        const avgFR = avg7dFunding(fr, frIdx);

        // Long breakout + negative funding = strong (cheap to hold + momentum)
        if (dir === "long" && avgFR >= 0) continue;
        // Short breakout + positive funding = strong (paid to hold + momentum)
        if (dir === "short" && avgFR <= 0) continue;

        const ep = bar.o;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { pair, dir, ep, et: bar.t, sl, atrAtEntry: curATR };
      }
    }
  }

  return trades;
}

// ─── Strategy 5: Funding Carry Only ─────────────────────────────────
function runFundingCarry(
  pairs: string[],
  dailyData: Map<string, C[]>,
  fundingMap: Map<string, number[]>,
  timeIdxMap: Map<string, Map<number, number>>,
  minTs: number,
  maxTs: number,
): Tr[] {
  const HOLD_DAYS = 7;
  const TOP_N = 3;
  const ATR_PERIOD = 14;
  const ATR_MULT = 3;

  const trades: Tr[] = [];
  const tradablePairs = pairs.filter(p => p !== "BTC");

  // Get all unique day timestamps
  const allDays = new Set<number>();
  for (const [, cs] of dailyData) {
    for (const c of cs) allDays.add(c.t);
  }
  const sortedDays = [...allDays].sort((a, b) => a - b);

  // Weekly rebalance: every 7 days
  interface CarryPos {
    pair: string; dir: "long"|"short"; ep: number; et: number;
    sl: number; atrAtEntry: number;
  }
  const positions: CarryPos[] = [];
  let lastRebalance = 0;

  for (const dayTs of sortedDays) {
    // Check exits first (SL or hold period expired)
    const toClose: number[] = [];
    for (let p = 0; p < positions.length; p++) {
      const pos = positions[p];
      const cs = dailyData.get(pos.pair);
      const tm = timeIdxMap.get(pos.pair);
      if (!cs || !tm) continue;
      const idx = tm.get(dayTs);
      if (idx === undefined) continue;
      const bar = cs[idx];
      const barsHeld = Math.round((dayTs - pos.et) / DAY);

      let xp = 0, reason = "";

      if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

      if (!xp && barsHeld >= HOLD_DAYS) { xp = bar.c; reason = "rebalance"; }

      if (xp > 0) {
        if (dayTs >= minTs && dayTs < maxTs) {
          trades.push({
            pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: dayTs,
            pnl: tradePnl(pos.pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
            reason, holdDays: barsHeld,
          });
        }
        toClose.push(p);
      }
    }
    // Remove closed
    for (let j = toClose.length - 1; j >= 0; j--) positions.splice(toClose[j], 1);

    // Rebalance weekly (signal on day i-1, entry on day i)
    if (dayTs - lastRebalance >= HOLD_DAYS * DAY && positions.length === 0) {
      lastRebalance = dayTs;

      // Rank pairs by 7-day avg funding
      const rankings: { pair: string; avgFR: number; idx: number }[] = [];
      for (const pair of tradablePairs) {
        const fr = fundingMap.get(pair);
        const tm = timeIdxMap.get(pair);
        const cs = dailyData.get(pair);
        if (!fr || !tm || !cs) continue;
        // Use previous day's data (anti-look-ahead)
        // Find the day before dayTs
        let prevDayTs = dayTs - DAY;
        let prevIdx = tm.get(prevDayTs);
        // If exact match not found, search nearby
        if (prevIdx === undefined) {
          for (let d = 1; d <= 3; d++) {
            prevIdx = tm.get(dayTs - d * DAY);
            if (prevIdx !== undefined) break;
          }
        }
        if (prevIdx === undefined || prevIdx < 7) continue;
        rankings.push({ pair, avgFR: avg7dFunding(fr, prevIdx), idx: prevIdx });
      }

      if (rankings.length < TOP_N * 2) continue;
      rankings.sort((a, b) => a.avgFR - b.avgFR);

      // Long bottom N (cheapest funding)
      for (let j = 0; j < TOP_N && j < rankings.length; j++) {
        const { pair, idx } = rankings[j];
        const cs = dailyData.get(pair)!;
        const tm = timeIdxMap.get(pair)!;
        const barIdx = tm.get(dayTs);
        if (barIdx === undefined) continue;
        const ep = cs[barIdx].o;
        const atr = calcATR(cs, ATR_PERIOD);
        const curATR = atr[Math.min(idx, atr.length - 1)];
        if (curATR <= 0) continue;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        positions.push({
          pair, dir: "long", ep, et: dayTs, sl: ep - slDist, atrAtEntry: curATR,
        });
      }

      // Short top N (most expensive funding)
      for (let j = rankings.length - 1; j >= rankings.length - TOP_N && j >= 0; j--) {
        const { pair, idx } = rankings[j];
        const cs = dailyData.get(pair)!;
        const tm = timeIdxMap.get(pair)!;
        const barIdx = tm.get(dayTs);
        if (barIdx === undefined) continue;
        const ep = cs[barIdx].o;
        const atr = calcATR(cs, ATR_PERIOD);
        const curATR = atr[Math.min(idx, atr.length - 1)];
        if (curATR <= 0) continue;
        const slDist = Math.min(ATR_MULT * curATR, ep * 0.035);
        positions.push({
          pair, dir: "short", ep, et: dayTs, sl: ep + slDist, atrAtEntry: curATR,
        });
      }
    }
  }

  return trades;
}

// ─── Print Helpers ──────────────────────────────────────────────────
function fmtRow(name: string, m: Metrics, baseline?: Metrics) {
  const pnlStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
  const dayStr = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;
  let delta = "";
  if (baseline && baseline.total !== 0) {
    const d = m.total - baseline.total;
    delta = d >= 0 ? `  (+$${d.toFixed(1)})` : `  (-$${Math.abs(d).toFixed(1)})`;
  }
  console.log(
    `${name.padEnd(35)} ${String(m.n).padStart(5)}  ${pnlStr.padStart(10)}  ` +
    `${m.pf === Infinity ? "  Inf" : m.pf.toFixed(2).padStart(5)}  ` +
    `${m.sharpe.toFixed(2).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ` +
    `${dayStr.padStart(8)}  $${m.dd.toFixed(1).padStart(7)}${delta}`
  );
}

function header() {
  console.log(
    `${"Strategy".padEnd(35)} ${"Trades".padStart(5)}  ${"PnL".padStart(10)}  ` +
    `${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"WR".padStart(6)}  ` +
    `${"$/day".padStart(8)}  ${"MaxDD".padStart(8)}`
  );
  console.log("-".repeat(105));
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(105));
  console.log("FUNDING RATE FILTER BACKTEST");
  console.log("Simulated funding: (close - open) / open * 0.1 (rough directional proxy)");
  console.log("Cost: 0.035% taker/side, spread map, 1.5x SL slippage, 10x leverage, $5 margin");
  console.log("Anti-look-ahead: signal on day i-1, entry at day i open");
  console.log("=".repeat(105));
  console.log("\nLoading and aggregating 5m candles to daily...\n");

  const dailyData = new Map<string, C[]>();
  for (const pair of ALL_PAIRS) {
    const raw = load5m(pair);
    if (raw.length === 0) { console.log(`  SKIP ${pair} (no data)`); continue; }
    const daily = aggregateToDaily(raw);
    dailyData.set(pair, daily);
    const firstDate = new Date(daily[0].t).toISOString().slice(0, 10);
    const lastDate = new Date(daily[daily.length - 1].t).toISOString().slice(0, 10);
    console.log(`  ${pair.padEnd(6)}: ${String(raw.length).padStart(7)} 5m -> ${String(daily.length).padStart(4)} daily  (${firstDate} to ${lastDate})`);
  }

  const btcDaily = dailyData.get("BTC");
  if (!btcDaily) { console.log("ERROR: no BTC data"); return; }

  // Build time index maps
  const timeIdxMap = new Map<string, Map<number, number>>();
  for (const [pair, cs] of dailyData) {
    const m = new Map<number, number>();
    cs.forEach((c, i) => m.set(c.t, i));
    timeIdxMap.set(pair, m);
  }

  // BTC trend
  const btcTrend = buildBtcTrend(btcDaily);

  // Simulated funding
  const fundingMap = computeSimulatedFunding(dailyData);

  const fullDays = (OOS_END - FULL_START) / DAY;
  const oosDays = (OOS_END - OOS_START) / DAY;
  console.log(`\nFull period: 2023-01-01 to 2026-03-26 (${fullDays.toFixed(0)} days)`);
  console.log(`OOS period: 2025-09-01 to 2026-03-26 (${oosDays.toFixed(0)} days)\n`);

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 0: BASELINE
  // ═══════════════════════════════════════════════════════════════════
  console.log("=".repeat(105));
  console.log("STRATEGY 0: BASELINE DONCHIAN (30d/15d, ATRx3 stop, BTC filter for longs)");
  console.log("=".repeat(105));

  const baseFullTrades = runBaseline(ALL_PAIRS, dailyData, btcTrend, FULL_START, OOS_END);
  const baseOosTrades = baseFullTrades.filter(t => t.xt >= OOS_START);
  const baseIsTrades = baseFullTrades.filter(t => t.xt < OOS_START);

  header();
  const baseFullM = calcMetrics(baseFullTrades, FULL_START, OOS_END);
  const baseOosM = calcMetrics(baseOosTrades, OOS_START, OOS_END);
  const baseIsM = calcMetrics(baseIsTrades, FULL_START, OOS_START);
  fmtRow("Baseline (Full)", baseFullM);
  fmtRow("Baseline (IS)", baseIsM);
  fmtRow("Baseline (OOS)", baseOosM);

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 1: FUNDING CONTRARIAN FILTER
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("STRATEGY 1: FUNDING CONTRARIAN FILTER");
  console.log("Rank pairs by 7d avg funding. Longs: bottom 50% only. Shorts: top 50% only.");
  console.log("=".repeat(105));

  const s1Full = runFundingContrarian(ALL_PAIRS, dailyData, btcTrend, fundingMap, timeIdxMap, FULL_START, OOS_END);
  const s1Oos = s1Full.filter(t => t.xt >= OOS_START);
  const s1Is = s1Full.filter(t => t.xt < OOS_START);

  header();
  fmtRow("Baseline (Full)", baseFullM);
  fmtRow("Baseline (OOS)", baseOosM);
  fmtRow("S1: Contrarian (Full)", calcMetrics(s1Full, FULL_START, OOS_END), baseFullM);
  fmtRow("S1: Contrarian (IS)", calcMetrics(s1Is, FULL_START, OOS_START), baseIsM);
  fmtRow("S1: Contrarian (OOS)", calcMetrics(s1Oos, OOS_START, OOS_END), baseOosM);

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 2: FUNDING MOMENTUM FILTER
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("STRATEGY 2: FUNDING MOMENTUM FILTER");
  console.log("Longs: enter when 3d funding is DECREASING. Shorts: enter when 3d funding is INCREASING.");
  console.log("=".repeat(105));

  const s2Full = runFundingMomentum(ALL_PAIRS, dailyData, btcTrend, fundingMap, timeIdxMap, FULL_START, OOS_END);
  const s2Oos = s2Full.filter(t => t.xt >= OOS_START);
  const s2Is = s2Full.filter(t => t.xt < OOS_START);

  header();
  fmtRow("Baseline (Full)", baseFullM);
  fmtRow("Baseline (OOS)", baseOosM);
  fmtRow("S2: Momentum (Full)", calcMetrics(s2Full, FULL_START, OOS_END), baseFullM);
  fmtRow("S2: Momentum (IS)", calcMetrics(s2Is, FULL_START, OOS_START), baseIsM);
  fmtRow("S2: Momentum (OOS)", calcMetrics(s2Oos, OOS_START, OOS_END), baseOosM);

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 3: EXTREME FUNDING CONTRARIAN
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("STRATEGY 3: EXTREME FUNDING CONTRARIAN (pure funding, no Donchian)");
  console.log("Long when funding in bottom 10% of own 30d range. Short when top 10%.");
  console.log("Exit when funding normalizes to 40-60% range, or SL/max-hold(30d).");
  console.log("=".repeat(105));

  const s3Full = runExtremeFunding(ALL_PAIRS, dailyData, fundingMap, timeIdxMap, FULL_START, OOS_END);
  const s3Oos = s3Full.filter(t => t.xt >= OOS_START);
  const s3Is = s3Full.filter(t => t.xt < OOS_START);

  header();
  fmtRow("Baseline (Full)", baseFullM);
  fmtRow("Baseline (OOS)", baseOosM);
  fmtRow("S3: Extreme FR (Full)", calcMetrics(s3Full, FULL_START, OOS_END), baseFullM);
  fmtRow("S3: Extreme FR (IS)", calcMetrics(s3Is, FULL_START, OOS_START), baseIsM);
  fmtRow("S3: Extreme FR (OOS)", calcMetrics(s3Oos, OOS_START, OOS_END), baseOosM);

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 4: DONCHIAN + FUNDING CONFIRMATION
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("STRATEGY 4: DONCHIAN + FUNDING CONFIRMATION");
  console.log("Donchian breakout + 7d avg funding must support direction.");
  console.log("Long breakout + negative funding = enter. Short breakout + positive funding = enter.");
  console.log("=".repeat(105));

  const s4Full = runDonchianFundingConfirm(ALL_PAIRS, dailyData, btcTrend, fundingMap, timeIdxMap, FULL_START, OOS_END);
  const s4Oos = s4Full.filter(t => t.xt >= OOS_START);
  const s4Is = s4Full.filter(t => t.xt < OOS_START);

  header();
  fmtRow("Baseline (Full)", baseFullM);
  fmtRow("Baseline (OOS)", baseOosM);
  fmtRow("S4: Confirm (Full)", calcMetrics(s4Full, FULL_START, OOS_END), baseFullM);
  fmtRow("S4: Confirm (IS)", calcMetrics(s4Is, FULL_START, OOS_START), baseIsM);
  fmtRow("S4: Confirm (OOS)", calcMetrics(s4Oos, OOS_START, OOS_END), baseOosM);

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 5: FUNDING CARRY ONLY
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("STRATEGY 5: FUNDING CARRY ONLY (weekly rebalance)");
  console.log("Short top-3 funding (collect), Long bottom-3 funding (cheap). Rebalance weekly.");
  console.log("=".repeat(105));

  const s5Full = runFundingCarry(ALL_PAIRS, dailyData, fundingMap, timeIdxMap, FULL_START, OOS_END);
  const s5Oos = s5Full.filter(t => t.xt >= OOS_START);
  const s5Is = s5Full.filter(t => t.xt < OOS_START);

  header();
  fmtRow("Baseline (Full)", baseFullM);
  fmtRow("Baseline (OOS)", baseOosM);
  fmtRow("S5: Carry (Full)", calcMetrics(s5Full, FULL_START, OOS_END), baseFullM);
  fmtRow("S5: Carry (IS)", calcMetrics(s5Is, FULL_START, OOS_START), baseIsM);
  fmtRow("S5: Carry (OOS)", calcMetrics(s5Oos, OOS_START, OOS_END), baseOosM);

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY TABLE
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("SUMMARY: OOS COMPARISON (2025-09-01 to 2026-03-26)");
  console.log("=".repeat(105));
  header();
  fmtRow("0. Baseline Donchian", baseOosM);
  fmtRow("1. Funding Contrarian Filter", calcMetrics(s1Oos, OOS_START, OOS_END), baseOosM);
  fmtRow("2. Funding Momentum Filter", calcMetrics(s2Oos, OOS_START, OOS_END), baseOosM);
  fmtRow("3. Extreme Funding Contrarian", calcMetrics(s3Oos, OOS_START, OOS_END), baseOosM);
  fmtRow("4. Donchian + Funding Confirm", calcMetrics(s4Oos, OOS_START, OOS_END), baseOosM);
  fmtRow("5. Funding Carry Only", calcMetrics(s5Oos, OOS_START, OOS_END), baseOosM);

  console.log(`\n${"=".repeat(105)}`);
  console.log("SUMMARY: FULL PERIOD COMPARISON (2023-01-01 to 2026-03-26)");
  console.log("=".repeat(105));
  header();
  fmtRow("0. Baseline Donchian", baseFullM);
  fmtRow("1. Funding Contrarian Filter", calcMetrics(s1Full, FULL_START, OOS_END), baseFullM);
  fmtRow("2. Funding Momentum Filter", calcMetrics(s2Full, FULL_START, OOS_END), baseFullM);
  fmtRow("3. Extreme Funding Contrarian", calcMetrics(s3Full, FULL_START, OOS_END), baseFullM);
  fmtRow("4. Donchian + Funding Confirm", calcMetrics(s4Full, FULL_START, OOS_END), baseFullM);
  fmtRow("5. Funding Carry Only", calcMetrics(s5Full, FULL_START, OOS_END), baseFullM);

  // ═══════════════════════════════════════════════════════════════════
  // TRADE BREAKDOWN per Strategy
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(105)}`);
  console.log("TRADE BREAKDOWN BY DIRECTION (OOS)");
  console.log("=".repeat(105));

  const breakdown = (name: string, trades: Tr[]) => {
    const longs = trades.filter(t => t.dir === "long");
    const shorts = trades.filter(t => t.dir === "short");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    const longWR = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length * 100 : 0;
    const shortWR = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;
    const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;
    console.log(`${name.padEnd(35)} L: ${String(longs.length).padStart(3)} (${longWR.toFixed(0).padStart(2)}% WR, ${longPnl >= 0 ? "+" : ""}$${longPnl.toFixed(1)})  S: ${String(shorts.length).padStart(3)} (${shortWR.toFixed(0).padStart(2)}% WR, ${shortPnl >= 0 ? "+" : ""}$${shortPnl.toFixed(1)})  AvgHold: ${avgHold.toFixed(1)}d`);
  };

  breakdown("0. Baseline", baseOosTrades);
  breakdown("1. Contrarian", s1Oos);
  breakdown("2. Momentum", s2Oos);
  breakdown("3. Extreme FR", s3Oos);
  breakdown("4. Confirm", s4Oos);
  breakdown("5. Carry", s5Oos);

  // Exit reason breakdown
  console.log(`\n${"=".repeat(105)}`);
  console.log("EXIT REASONS (OOS)");
  console.log("=".repeat(105));

  const exitReasons = (name: string, trades: Tr[]) => {
    const reasons = new Map<string, { count: number; pnl: number }>();
    for (const t of trades) {
      const r = reasons.get(t.reason) ?? { count: 0, pnl: 0 };
      r.count++; r.pnl += t.pnl;
      reasons.set(t.reason, r);
    }
    const parts: string[] = [];
    for (const [reason, { count, pnl }] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
      parts.push(`${reason}: ${count} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(1)})`);
    }
    console.log(`${name.padEnd(35)} ${parts.join("  |  ")}`);
  };

  exitReasons("0. Baseline", baseOosTrades);
  exitReasons("1. Contrarian", s1Oos);
  exitReasons("2. Momentum", s2Oos);
  exitReasons("3. Extreme FR", s3Oos);
  exitReasons("4. Confirm", s4Oos);
  exitReasons("5. Carry", s5Oos);

  console.log(`\n${"=".repeat(105)}`);
  console.log("NOTE: Funding data is SIMULATED as (close-open)/open * 0.1");
  console.log("This captures the directional relationship but is NOT actual exchange funding rates.");
  console.log("Real funding rates should be tested before deploying any funding-based filter.");
  console.log("=".repeat(105));
}

main();
