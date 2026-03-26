/**
 * Strategy Research: fundamentally different approaches to overcome HL fees
 *
 * Fee problem: 0.035% taker × 2 × 10x = 0.7% margin round-trip
 * Maker alternative: 0.01% × 2 × 10x = 0.2% margin round-trip
 *
 * Strategies tested:
 * A) Daily Donchian Breakout - classic trend following, rides multi-day trends
 * B) 4h EMA Trend Follow with ATR trailing stop
 * C) Daily Momentum Rotation - long winners, short losers weekly
 * D) 1h Maker-Only Mean Reversion on tight-spread pairs
 * E) Bollinger Squeeze Breakout on 4h
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR_5M = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 10; // $10 margin
const NOT = SIZE * LEV; // $100 notional
const FEE_TAKER = 0.00035;
const FEE_MAKER = 0.0001;

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
  "LDO","LINK","OP","SOL","TIA","TRUMP","UNI","WIF","WLD","XRP"
];

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

function aggregate(candles: C[], barsPerGroup: number): C[] {
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue; // skip incomplete
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
  const DAY = 86400000;
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue; // need most of the day (288 × 5m bars)
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
    if (i < period) { atr[i] = 0; continue; }
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
    if (i < period - 1) { ema[i] = 0; continue; }
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

function calcBB(cs: C[], period: number, mult: number): { upper: number[]; lower: number[]; mid: number[]; width: number[] } {
  const upper: number[] = [], lower: number[] = [], mid: number[] = [], width: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i < period - 1) { upper.push(0); lower.push(0); mid.push(0); width.push(0); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += cs[j].c;
    const m = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (cs[j].c - m) ** 2;
    const std = Math.sqrt(sqSum / period);
    mid.push(m);
    upper.push(m + mult * std);
    lower.push(m - mult * std);
    width.push(std > 0 ? (2 * mult * std) / m : 0);
  }
  return { upper, lower, mid, width };
}

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); tr.push(cs[i].h - cs[i].l); continue; }
    const upMove = cs[i].h - cs[i-1].h;
    const downMove = cs[i-1].l - cs[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)));
  }
  // Smooth with Wilder's method
  const smoothTR: number[] = new Array(cs.length).fill(0);
  const smoothPDM: number[] = new Array(cs.length).fill(0);
  const smoothMDM: number[] = new Array(cs.length).fill(0);
  if (cs.length <= period) return adx;
  for (let i = 1; i <= period; i++) { smoothTR[period] += tr[i]; smoothPDM[period] += plusDM[i]; smoothMDM[period] += minusDM[i]; }
  for (let i = period + 1; i < cs.length; i++) {
    smoothTR[i] = smoothTR[i-1] - smoothTR[i-1] / period + tr[i];
    smoothPDM[i] = smoothPDM[i-1] - smoothPDM[i-1] / period + plusDM[i];
    smoothMDM[i] = smoothMDM[i-1] - smoothMDM[i-1] / period + minusDM[i];
  }
  const dx: number[] = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    if (smoothTR[i] === 0) continue;
    const pdi = 100 * smoothPDM[i] / smoothTR[i];
    const mdi = 100 * smoothMDM[i] / smoothTR[i];
    dx[i] = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  // Smooth DX to get ADX
  if (cs.length <= 2 * period) return adx;
  let adxSum = 0;
  for (let i = period; i < 2 * period; i++) adxSum += dx[i];
  adx[2 * period - 1] = adxSum / period;
  for (let i = 2 * period; i < cs.length; i++) {
    adx[i] = (adx[i-1] * (period - 1) + dx[i]) / period;
  }
  return adx;
}

// ─── Cost Calculation ───────────────────────────────────────────────
function tradeCost(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean, isMaker: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const fee = isMaker ? FEE_MAKER : FEE_TAKER;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * fee * 2;
  return entrySlip * (NOT / ep) + exitSlip * (NOT / xp) + fees;
}

function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean, isMaker = false): number {
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - tradeCost(pair, ep, xp, dir, isSL, isMaker);
}

// ─── Metrics ────────────────────────────────────────────────────────
function metrics(trades: Tr[]): { n: number; wr: number; pf: number; sharpe: number; dd: number; total: number; avg: number; perDay: number } {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, avg: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // Sharpe: bucket by day
  const DAY = 86400000;
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
    avg: total / trades.length,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Strategy A: Daily Donchian Breakout ────────────────────────────
function stratDonchian(pairs: string[], dailyData: Map<string, C[]>, params: {
  entryLB: number; exitLB: number; atrMult: number; atrPeriod: number; maxHoldDays: number;
}): Tr[] {
  const { entryLB, exitLB, atrMult, atrPeriod, maxHoldDays } = params;
  const trades: Tr[] = [];
  const DAY = 86400000;

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < entryLB + atrPeriod + 10) continue;
    const atr = calcATR(cs, atrPeriod);

    let pos: Pos | null = null;
    const warmup = Math.max(entryLB, atrPeriod) + 1;

    for (let i = warmup; i < cs.length; i++) {
      // Check exit for open position
      if (pos) {
        const bar = cs[i];
        const barsHeld = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        // SL check (intraday via daily H/L)
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // Donchian exit channel check (on close)
        if (!xp) {
          const exitLow = donchianLow(cs, i, exitLB);
          const exitHigh = donchianHigh(cs, i, exitLB);
          if (pos.dir === "long" && bar.c < exitLow) { xp = bar.c; reason = "donchian-exit"; }
          else if (pos.dir === "short" && bar.c > exitHigh) { xp = bar.c; reason = "donchian-exit"; }
        }

        // Max hold
        if (!xp && barsHeld >= maxHoldDays) { xp = bar.c; reason = "max-hold"; }

        // Update trailing peak
        if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
        else pos.peak = Math.min(pos.peak, bar.l);

        if (xp > 0) {
          const isSL = reason === "stop-loss";
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, isSL),
            reason, holdDays: barsHeld,
          });
          pos = null;
        }
      }

      // Generate new signal if no position
      if (!pos && i >= warmup) {
        const prev = cs[i - 1]; // signal based on yesterday
        const dHigh = donchianHigh(cs, i - 1, entryLB); // 20-day high excluding yesterday
        const dLow = donchianLow(cs, i - 1, entryLB);
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        if (prev.c > dHigh) dir = "long";
        else if (prev.c < dLow) dir = "short";
        if (!dir) continue;

        const ep = cs[i].o; // entry at today's open
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;

        pos = { pair, dir, ep, et: cs[i].t, sl, peak: ep };
      }
    }
  }
  return trades;
}

// ─── Strategy B: 4h EMA Trend Follow ─────────────────────────────────
function strat4hEMA(pairs: string[], h4Data: Map<string, C[]>, params: {
  fastEMA: number; slowEMA: number; atrMult: number; atrTrail: number; adxMin: number; maxHoldBars: number;
}): Tr[] {
  const { fastEMA, slowEMA, atrMult, atrTrail, adxMin, maxHoldBars } = params;
  const trades: Tr[] = [];
  const BAR_MS = 4 * 3600000;
  const DAY = 86400000;

  for (const pair of pairs) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < slowEMA + 50) continue;
    const closes = cs.map(c => c.c);
    const fast = calcEMA(closes, fastEMA);
    const slow = calcEMA(closes, slowEMA);
    const atr = calcATR(cs, 14);
    const adx = calcADX(cs, 14);

    let pos: Pos | null = null;
    const warmup = slowEMA + 30;

    for (let i = warmup; i < cs.length; i++) {
      if (pos) {
        const bar = cs[i];
        const barsHeld = i - Math.round((pos.et - cs[0].t) / BAR_MS);
        let xp = 0, reason = "";

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // Trail update
        if (!xp && atr[i] > 0) {
          if (pos.dir === "long") {
            pos.peak = Math.max(pos.peak, bar.h);
            const trailSL = pos.peak - atrTrail * atr[i];
            if (trailSL > pos.sl) pos.sl = trailSL;
          } else {
            pos.peak = Math.min(pos.peak, bar.l);
            const trailSL = pos.peak + atrTrail * atr[i];
            if (trailSL < pos.sl) pos.sl = trailSL;
          }
        }

        // EMA cross exit
        if (!xp) {
          if (pos.dir === "long" && fast[i] < slow[i] && fast[i-1] >= slow[i-1]) { xp = bar.c; reason = "ema-cross"; }
          else if (pos.dir === "short" && fast[i] > slow[i] && fast[i-1] <= slow[i-1]) { xp = bar.c; reason = "ema-cross"; }
        }

        // Max hold
        if (!xp && barsHeld >= maxHoldBars) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          const holdD = (bar.t - pos.et) / DAY;
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
            reason, holdDays: holdD,
          });
          pos = null;
        }
      }

      // Entry signal
      if (!pos && i >= warmup && fast[i-1] !== 0 && slow[i-1] !== 0) {
        const crossUp = fast[i-1] > slow[i-1] && fast[i-2] <= slow[i-2];
        const crossDn = fast[i-1] < slow[i-1] && fast[i-2] >= slow[i-2];
        if (!crossUp && !crossDn) continue;
        if (adx[i-1] < adxMin) continue;
        if (atr[i-1] <= 0) continue;

        const dir: "long" | "short" = crossUp ? "long" : "short";
        const ep = cs[i].o;
        const sl = dir === "long" ? ep - atrMult * atr[i-1] : ep + atrMult * atr[i-1];

        pos = { pair, dir, ep, et: cs[i].t, sl, peak: ep };
      }
    }
  }
  return trades;
}

// ─── Strategy C: Weekly Momentum Rotation ───────────────────────────
function stratMomentum(pairs: string[], dailyData: Map<string, C[]>, params: {
  lookbackDays: number; topN: number; holdDays: number;
}): Tr[] {
  const { lookbackDays, topN, holdDays } = params;
  const trades: Tr[] = [];
  const DAY = 86400000;

  // Get all unique day timestamps across all pairs
  const allDays = new Set<number>();
  for (const cs of dailyData.values()) {
    for (const c of cs) allDays.add(c.t);
  }
  const sortedDays = [...allDays].sort((a, b) => a - b);

  // Rebalance every holdDays
  const openPositions = new Map<string, { dir: "long"|"short"; ep: number; et: number }>();

  for (let d = lookbackDays; d < sortedDays.length; d += holdDays) {
    const today = sortedDays[d];
    const lookbackStart = sortedDays[d - lookbackDays];
    if (!lookbackStart) continue;

    // Close all open positions
    for (const [pair, pos] of openPositions) {
      const cs = dailyData.get(pair)!;
      const todayBar = cs.find(c => c.t >= today);
      if (!todayBar) continue;
      const xp = todayBar.o;
      const holdD = (todayBar.t - pos.et) / DAY;
      trades.push({
        pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: todayBar.t,
        pnl: tradePnl(pair, pos.ep, xp, pos.dir, false),
        reason: "rebalance", holdDays: holdD,
      });
    }
    openPositions.clear();

    // Rank pairs by return over lookback period
    const returns: { pair: string; ret: number; price: number }[] = [];
    for (const pair of pairs) {
      const cs = dailyData.get(pair);
      if (!cs) continue;
      const startBar = cs.find(c => c.t >= lookbackStart);
      const endBar = cs.find(c => c.t >= today);
      if (!startBar || !endBar) continue;
      returns.push({ pair, ret: endBar.o / startBar.c - 1, price: endBar.o });
    }
    returns.sort((a, b) => b.ret - a.ret);

    // Long top N, short bottom N
    const longPairs = returns.slice(0, topN);
    const shortPairs = returns.slice(-topN);

    for (const { pair, price } of longPairs) {
      openPositions.set(pair, { dir: "long", ep: price, et: today });
    }
    for (const { pair, price } of shortPairs) {
      openPositions.set(pair, { dir: "short", ep: price, et: today });
    }
  }

  return trades;
}

// ─── Strategy D: Maker-Only 1h Mean Reversion ───────────────────────
function stratMakerMR(pairs: string[], h1Data: Map<string, C[]>, params: {
  zThreshold: number; atrMult: number; tpMult: number; maxHoldBars: number;
}): Tr[] {
  const { zThreshold, atrMult, tpMult, maxHoldBars } = params;
  const trades: Tr[] = [];
  const HOUR = 3600000;
  const DAY = 86400000;
  // Only use tight-spread pairs for maker strategy
  const tightPairs = pairs.filter(p => (SPREAD[p] ?? 4e-4) <= 3e-4);

  for (const pair of tightPairs) {
    const cs = h1Data.get(pair);
    if (!cs || cs.length < 200) continue;
    const atr = calcATR(cs, 14);

    let pos: Pos | null = null;
    const warmup = 100;

    for (let i = warmup; i < cs.length; i++) {
      if (pos) {
        const bar = cs[i];
        let xp = 0, reason = "";
        const barsHeld = Math.round((bar.t - pos.et) / HOUR);

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // TP (based on ATR from entry)
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * (1 + tpMult * 0.01) : pos.ep * (1 - tpMult * 0.01);
          if (pos.dir === "long" && bar.h >= tp) { xp = tp; reason = "take-profit"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "take-profit"; }
        }

        // Max hold
        if (!xp && barsHeld >= maxHoldBars) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss", true), // MAKER fees
            reason, holdDays: (bar.t - pos.et) / DAY,
          });
          pos = null;
        }
      }

      if (!pos && i >= warmup) {
        // Z-score: 3-bar return / 20-bar rolling std
        const ret3 = cs[i-1].c / cs[i-4].c - 1;
        let sqSum = 0;
        for (let j = i - 20; j < i; j++) sqSum += ((cs[j].c / cs[j-1].c - 1) ** 2);
        const vol = Math.sqrt(sqSum / 20);
        if (vol <= 0) continue;
        const z = ret3 / vol;
        const curATR = atr[i-1];
        if (curATR <= 0) continue;

        let dir: "long" | "short" | null = null;
        if (z < -zThreshold) dir = "long"; // oversold → buy
        else if (z > zThreshold) dir = "short"; // overbought → sell

        if (!dir) continue;
        const ep = cs[i].o;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;
        pos = { pair, dir, ep, et: cs[i].t, sl, peak: ep };
      }
    }
  }
  return trades;
}

// ─── Strategy E: 4h Bollinger Squeeze Breakout ──────────────────────
function stratBBSqueeze(pairs: string[], h4Data: Map<string, C[]>, params: {
  bbPeriod: number; bbMult: number; squeezePctile: number; atrMult: number; tpMult: number; maxHoldBars: number;
}): Tr[] {
  const { bbPeriod, bbMult, squeezePctile, atrMult, tpMult, maxHoldBars } = params;
  const trades: Tr[] = [];
  const BAR_MS = 4 * 3600000;
  const DAY = 86400000;

  for (const pair of pairs) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < bbPeriod + 200) continue;
    const bb = calcBB(cs, bbPeriod, bbMult);
    const atr = calcATR(cs, 14);

    let pos: Pos | null = null;
    const warmup = bbPeriod + 100;

    for (let i = warmup; i < cs.length; i++) {
      if (pos) {
        const bar = cs[i];
        let xp = 0, reason = "";
        const barsHeld = Math.round((bar.t - pos.et) / BAR_MS);

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "stop-loss"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "stop-loss"; }

        // TP: entry ± tpMult * ATR
        if (!xp && atr[i] > 0) {
          const atrAtEntry = atr[Math.round((pos.et - cs[0].t) / BAR_MS)] || atr[i];
          const tp = pos.dir === "long" ? pos.ep + tpMult * atrAtEntry : pos.ep - tpMult * atrAtEntry;
          if (pos.dir === "long" && bar.h >= tp) { xp = tp; reason = "take-profit"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "take-profit"; }
        }

        // Max hold
        if (!xp && barsHeld >= maxHoldBars) { xp = bar.c; reason = "max-hold"; }

        if (xp > 0) {
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: tradePnl(pair, pos.ep, xp, pos.dir, reason === "stop-loss"),
            reason, holdDays: (bar.t - pos.et) / DAY,
          });
          pos = null;
        }
      }

      if (!pos && i >= warmup) {
        // Check for squeeze: width in bottom percentile over lookback
        const lookback = 100;
        const widths = bb.width.slice(i - lookback, i).filter(w => w > 0).sort((a, b) => a - b);
        if (widths.length < 50) continue;
        const threshold = widths[Math.floor(widths.length * squeezePctile / 100)];
        const currentWidth = bb.width[i - 1];
        if (currentWidth > threshold) continue; // not in squeeze

        // Breakout: close outside band
        const prev = cs[i - 1];
        let dir: "long" | "short" | null = null;
        if (prev.c > bb.upper[i - 1]) dir = "long";
        else if (prev.c < bb.lower[i - 1]) dir = "short";
        if (!dir) continue;

        const ep = cs[i].o;
        const curATR = atr[i - 1];
        if (curATR <= 0) continue;
        const sl = dir === "long" ? ep - atrMult * curATR : ep + atrMult * curATR;
        pos = { pair, dir, ep, et: cs[i].t, sl, peak: ep };
      }
    }
  }
  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("Loading 5m candle data...");
  const raw5m = new Map<string, C[]>();
  for (const pair of ALL_PAIRS) {
    const cs = load5m(pair);
    if (cs.length > 0) raw5m.set(pair, cs);
  }
  console.log(`Loaded ${raw5m.size} pairs\n`);

  // Aggregate timeframes
  console.log("Aggregating to daily, 4h, 1h...");
  const dailyData = new Map<string, C[]>();
  const h4Data = new Map<string, C[]>();
  const h1Data = new Map<string, C[]>();
  for (const [pair, cs] of raw5m) {
    dailyData.set(pair, aggregateToDaily(cs));
    h4Data.set(pair, aggregate(cs, 48));    // 48 × 5m = 4h
    h1Data.set(pair, aggregate(cs, 12));    // 12 × 5m = 1h
  }

  // Time split for OOS testing
  const OOS_START = new Date("2025-09-01").getTime(); // last ~7 months OOS
  const splitData = (data: Map<string, C[]>) => {
    const train = new Map<string, C[]>();
    const test = new Map<string, C[]>();
    for (const [pair, cs] of data) {
      train.set(pair, cs.filter(c => c.t < OOS_START));
      test.set(pair, cs); // test on full range for now (signal needs warmup from early data)
    }
    return { train, test };
  };

  const dailySplit = splitData(dailyData);
  const h4Split = splitData(h4Data);
  const h1Split = splitData(h1Data);

  // Count data
  for (const [pair, cs] of dailyData) {
    if (pair === "BTC") console.log(`  BTC daily: ${cs.length} bars`);
  }
  const firstPair = [...dailyData.values()][0];
  console.log(`  Typical daily: ${firstPair?.length ?? 0} bars`);
  console.log(`  OOS starts: 2025-09-01 (~7 months)\n`);

  // ═══════════════════════════════════════════════════════════════════
  console.log("=" .repeat(80));
  console.log("STRATEGY A: Daily Donchian Breakout");
  console.log("=" .repeat(80));

  for (const entryLB of [10, 20, 30, 50]) {
    const exitLB = Math.max(5, Math.floor(entryLB / 2));
    for (const atrMult of [2, 3]) {
      const label = `Entry=${entryLB}d Exit=${exitLB}d ATR×${atrMult}`;
      const allTrades = stratDonchian(ALL_PAIRS, dailyData, { entryLB, exitLB, atrMult, atrPeriod: 14, maxHoldDays: 60 });
      const oosTrades = allTrades.filter(t => t.et >= OOS_START);
      const m = metrics(oosTrades);
      const mAll = metrics(allTrades);
      console.log(`${label.padEnd(35)} | IS: ${mAll.n}tr $${mAll.total.toFixed(0).padStart(6)} PF=${mAll.pf.toFixed(2)} | OOS: ${m.n}tr $${m.total.toFixed(0).padStart(6)} WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Sh=${m.sharpe.toFixed(2)} $${m.perDay.toFixed(2)}/d`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(80));
  console.log("STRATEGY B: 4h EMA Trend Follow");
  console.log("=".repeat(80));

  for (const [fast, slow] of [[9, 21], [12, 26], [20, 50]]) {
    for (const adxMin of [15, 25]) {
      const label = `EMA(${fast}/${slow}) ADX>${adxMin}`;
      const allTrades = strat4hEMA(ALL_PAIRS, h4Data, { fastEMA: fast, slowEMA: slow, atrMult: 2.5, atrTrail: 2, adxMin, maxHoldBars: 120 });
      const oosTrades = allTrades.filter(t => t.et >= OOS_START);
      const m = metrics(oosTrades);
      const mAll = metrics(allTrades);
      console.log(`${label.padEnd(35)} | IS: ${mAll.n}tr $${mAll.total.toFixed(0).padStart(6)} PF=${mAll.pf.toFixed(2)} | OOS: ${m.n}tr $${m.total.toFixed(0).padStart(6)} WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Sh=${m.sharpe.toFixed(2)} $${m.perDay.toFixed(2)}/d`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(80));
  console.log("STRATEGY C: Weekly Momentum Rotation");
  console.log("=".repeat(80));

  for (const lookback of [7, 14, 21]) {
    for (const topN of [3, 5]) {
      for (const hold of [7, 14]) {
        const label = `LB=${lookback}d Top${topN} Hold=${hold}d`;
        const allTrades = stratMomentum(ALL_PAIRS, dailyData, { lookbackDays: lookback, topN, holdDays: hold });
        const oosTrades = allTrades.filter(t => t.et >= OOS_START);
        const m = metrics(oosTrades);
        const mAll = metrics(allTrades);
        console.log(`${label.padEnd(35)} | IS: ${mAll.n}tr $${mAll.total.toFixed(0).padStart(6)} PF=${mAll.pf.toFixed(2)} | OOS: ${m.n}tr $${m.total.toFixed(0).padStart(6)} WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Sh=${m.sharpe.toFixed(2)} $${m.perDay.toFixed(2)}/d`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(80));
  console.log("STRATEGY D: Maker-Only 1h Mean Reversion (tight-spread pairs)");
  console.log("=".repeat(80));

  for (const zTh of [2.0, 2.5, 3.0, 3.5]) {
    for (const tp of [1.5, 2.5, 4.0]) {
      const label = `Z=${zTh} TP=${tp}% ATR×2.5`;
      const allTrades = stratMakerMR(ALL_PAIRS, h1Data, { zThreshold: zTh, atrMult: 2.5, tpMult: tp, maxHoldBars: 48 });
      const oosTrades = allTrades.filter(t => t.et >= OOS_START);
      const m = metrics(oosTrades);
      const mAll = metrics(allTrades);
      console.log(`${label.padEnd(35)} | IS: ${mAll.n}tr $${mAll.total.toFixed(0).padStart(6)} PF=${mAll.pf.toFixed(2)} | OOS: ${m.n}tr $${m.total.toFixed(0).padStart(6)} WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Sh=${m.sharpe.toFixed(2)} $${m.perDay.toFixed(2)}/d`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(80));
  console.log("STRATEGY E: 4h Bollinger Squeeze Breakout");
  console.log("=".repeat(80));

  for (const sqPct of [15, 25]) {
    for (const tpMult of [3, 5, 8]) {
      const label = `Squeeze<${sqPct}pct TP=${tpMult}×ATR`;
      const allTrades = stratBBSqueeze(ALL_PAIRS, h4Data, { bbPeriod: 20, bbMult: 2, squeezePctile: sqPct, atrMult: 2, tpMult, maxHoldBars: 72 });
      const oosTrades = allTrades.filter(t => t.et >= OOS_START);
      const m = metrics(oosTrades);
      const mAll = metrics(allTrades);
      console.log(`${label.padEnd(35)} | IS: ${mAll.n}tr $${mAll.total.toFixed(0).padStart(6)} PF=${mAll.pf.toFixed(2)} | OOS: ${m.n}tr $${m.total.toFixed(0).padStart(6)} WR=${m.wr.toFixed(0)}% PF=${m.pf.toFixed(2)} Sh=${m.sharpe.toFixed(2)} $${m.perDay.toFixed(2)}/d`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("DONE. Positive OOS total PnL + PF > 1.3 + Sharpe > 0.5 = worth investigating further.");
  console.log("=".repeat(80));
}

main();
