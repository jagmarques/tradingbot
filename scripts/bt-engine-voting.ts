/**
 * Engine Voting Backtest
 *
 * Combines signals from 4 engines into a voting system:
 *   1. Supertrend(14, 1.75) direction
 *   2. GARCH v2 z-score (1h + 4h thresholds)
 *   3. Daily Donchian trend (SMA20 > SMA50)
 *   4. BTC trend (EMA20 > EMA50)
 *
 * Tests: Unanimous, Majority, Simple Majority, Weighted voting
 * vs standalone Supertrend baseline.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ───
const CD = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 5;
const NOT = SIZE * LEV; // $50 notional
const FEE = 0.00035;
const DAY = 86400000;
const H = 3600000;
const SL_SLIP = 1.5;

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

const PAIRS = [
  "OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","TRUMPUSDT","DASHUSDT",
  "DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","LINKUSDT","ADAUSDT",
  "WLDUSDT","XRPUSDT","UNIUSDT","ETHUSDT","TIAUSDT","SOLUSDT",
];
const TRADE_PAIRS = PAIRS; // all trade (BTC separate)

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  UNIUSDT: 2.75e-4, APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4,
  WLDUSDT: 4e-4, DOTUSDT: 4.95e-4, WIFUSDT: 5.05e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4, DASHUSDT: 7.15e-4, BTCUSDT: 0.5e-4,
  ETHUSDT: 0.8e-4, SOLUSDT: 1.2e-4, TIAUSDT: 3.8e-4,
};

const MAX_HOLD = 30 * DAY;

// ─── Types ───
interface C { t: number; o: number; h: number; l: number; c: number }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Load & Aggregate ───
function ld5m(p: string): C[] {
  const f = path.join(CD, p + ".json");
  if (!fs.existsSync(f)) return [];
  return (JSON.parse(fs.readFileSync(f, "utf8")) as any[]).map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function agg(bars5m: C[], n: number): C[] {
  const out: C[] = [];
  const interval = n * 5 * 60000;
  let cur: C | null = null;
  for (const b of bars5m) {
    const slot = Math.floor(b.t / interval) * interval;
    if (!cur || cur.t !== slot) {
      if (cur) out.push(cur);
      cur = { t: slot, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function agg4h(bars5m: C[]): C[] { return agg(bars5m, 48); }
function agg1h(bars5m: C[]): C[] { return agg(bars5m, 12); }
function aggDaily(bars5m: C[]): C[] { return agg(bars5m, 288); }

// ─── Indicators ───
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
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
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
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

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const stArr = new Array(cs.length).fill(0);
  const dirArr = new Array(cs.length).fill(1); // 1=up (bullish), -1=down (bearish)
  let upperBand = 0, lowerBand = 0;

  for (let i = 0; i < cs.length; i++) {
    if (atr[i] === 0) { stArr[i] = cs[i].c; continue; }
    const mid = (cs[i].h + cs[i].l) / 2;
    let ub = mid + mult * atr[i];
    let lb = mid - mult * atr[i];

    if (i > 0 && atr[i - 1] > 0) {
      if (lb > lowerBand || cs[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      if (ub < upperBand || cs[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    if (i === 0 || atr[i - 1] === 0) {
      dirArr[i] = 1;
    } else if (dirArr[i - 1] === 1) {
      dirArr[i] = cs[i].c < lb ? -1 : 1;
    } else {
      dirArr[i] = cs[i].c > ub ? 1 : -1;
    }

    stArr[i] = dirArr[i] === 1 ? lb : ub;
    upperBand = ub;
    lowerBand = lb;
  }
  return { st: stArr, dir: dirArr };
}

// Z-score: returns over lookback window normalized by rolling vol
function calcZScore(cs: C[], retBars: number, lookback: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = lookback + retBars; i < cs.length; i++) {
    const ret = cs[i].c / cs[i - retBars].c - 1;
    let sumSq = 0, n = 0;
    for (let j = Math.max(retBars, i - lookback); j <= i; j++) {
      sumSq += (cs[j].c / cs[j - retBars].c - 1) ** 2;
      n++;
    }
    if (n < 5) continue;
    const vol = Math.sqrt(sumSq / n);
    if (vol > 0) z[i] = ret / vol;
  }
  return z;
}

// ─── Cost helpers ───
function entryCost(pair: string, dir: "long" | "short", price: number): number {
  const sp = SP[pair] ?? 4e-4;
  return dir === "long" ? price * (1 + sp) : price * (1 - sp);
}
function exitCost(pair: string, dir: "long" | "short", price: number, isSL: boolean): number {
  const sp = SP[pair] ?? 4e-4;
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? price * (1 - slip) : price * (1 + slip);
}
function tradePnl(dir: "long" | "short", ep: number, xp: number): number {
  const raw = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  return raw - NOT * FEE * 2;
}

// ─── Data Loading ───
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of [...TRADE_PAIRS, "BTCUSDT"]) {
  const d = ld5m(p);
  if (d.length > 0) raw5m.set(p, d);
  else console.log("  MISSING:", p);
}

// Build aggregated data
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
const dailyData = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h4Data.set(p, agg4h(bars));
  h1Data.set(p, agg1h(bars));
  dailyData.set(p, aggDaily(bars));
}

console.log(`Loaded ${raw5m.size} pairs. 4h bars: ${h4Data.get("BTCUSDT")?.length ?? 0} BTC bars.`);

// ─── Pre-compute Indicators ───
// 1) Supertrend(14, 1.75) on 4h
const stData = new Map<string, { dir: number[] }>();
for (const pair of TRADE_PAIRS) {
  const cs = h4Data.get(pair);
  if (!cs) continue;
  const { dir } = calcSupertrend(cs, 14, 1.75);
  stData.set(pair, { dir });
}

// 2) GARCH v2 z-scores on 1h and 4h
const z1hData = new Map<string, number[]>();
const z4hData = new Map<string, number[]>();
for (const pair of TRADE_PAIRS) {
  const cs1h = h1Data.get(pair);
  const cs4h = h4Data.get(pair);
  if (cs1h) z1hData.set(pair, calcZScore(cs1h, 3, 20));
  if (cs4h) z4hData.set(pair, calcZScore(cs4h, 3, 20));
}

// 3) Daily SMA20 / SMA50 for Donchian trend
const sma20Data = new Map<string, number[]>();
const sma50Data = new Map<string, number[]>();
for (const pair of TRADE_PAIRS) {
  const cs = dailyData.get(pair);
  if (!cs) continue;
  sma20Data.set(pair, calcSMA(cs.map(c => c.c), 20));
  sma50Data.set(pair, calcSMA(cs.map(c => c.c), 50));
}

// 4) BTC EMA20/EMA50 on daily
const btcDaily = dailyData.get("BTCUSDT")!;
const btcEma20 = calcEMA(btcDaily.map(c => c.c), 20);
const btcEma50 = calcEMA(btcDaily.map(c => c.c), 50);

// ATR on 4h for stops
const atr4hData = new Map<string, number[]>();
for (const pair of TRADE_PAIRS) {
  const cs = h4Data.get(pair);
  if (!cs) continue;
  atr4hData.set(pair, calcATR(cs, 14));
}

// ─── Build 4h bar timestamps & index maps ───
const h4Idx = new Map<string, Map<number, number>>();
for (const [pair, cs] of h4Data) {
  const m = new Map<number, number>();
  cs.forEach((c, i) => m.set(c.t, i));
  h4Idx.set(pair, m);
}
const h1Idx = new Map<string, Map<number, number>>();
for (const [pair, cs] of h1Data) {
  const m = new Map<number, number>();
  cs.forEach((c, i) => m.set(c.t, i));
  h1Idx.set(pair, m);
}
const dailyIdx = new Map<string, Map<number, number>>();
for (const [pair, cs] of dailyData) {
  const m = new Map<number, number>();
  cs.forEach((c, i) => m.set(c.t, i));
  dailyIdx.set(pair, m);
}

// ─── Helper: find last bar index <= t ───
function findLastIdx(cs: C[], t: number): number {
  let lo = 0, hi = cs.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].t <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

// ─── Vote Functions ───
// Returns +1 (bull), -1 (bear), or 0 (neutral) for each engine at a given 4h bar time

function voteSupertrend(pair: string, barTime: number): number {
  const cs = h4Data.get(pair);
  const sd = stData.get(pair);
  if (!cs || !sd) return 0;
  // Find last completed 4h bar before barTime
  const idx = findLastIdx(cs, barTime - 1);
  if (idx < 0) return 0;
  return sd.dir[idx]; // 1 = bull, -1 = bear
}

function voteGARCH(pair: string, barTime: number): number {
  const cs1h = h1Data.get(pair);
  const cs4h = h4Data.get(pair);
  const z1h = z1hData.get(pair);
  const z4h = z4hData.get(pair);
  if (!cs1h || !cs4h || !z1h || !z4h) return 0;

  // Find last completed 1h bar before barTime
  const idx1h = findLastIdx(cs1h, barTime - 1);
  const idx4h = findLastIdx(cs4h, barTime - 1);
  if (idx1h < 0 || idx4h < 0) return 0;
  if (idx1h >= z1h.length || idx4h >= z4h.length) return 0;

  const z1 = z1h[idx1h];
  const z4 = z4h[idx4h];

  // Relaxed thresholds for voting
  if (z1 > 2 && z4 > 1.5) return 1;   // bullish MR signal (price overextended up, expect revert... but for trend voting: extended = strong)
  if (z1 < -2 && z4 < -1.5) return -1; // bearish
  return 0;
}

function voteDonchianTrend(pair: string, barTime: number): number {
  const cs = dailyData.get(pair);
  const s20 = sma20Data.get(pair);
  const s50 = sma50Data.get(pair);
  if (!cs || !s20 || !s50) return 0;

  const idx = findLastIdx(cs, barTime - 1);
  if (idx < 50 || idx >= s20.length || idx >= s50.length) return 0;
  if (s20[idx] === 0 || s50[idx] === 0) return 0;

  return s20[idx] > s50[idx] ? 1 : -1;
}

function voteBTC(barTime: number): number {
  if (!btcDaily) return 0;
  const idx = findLastIdx(btcDaily, barTime - 1);
  if (idx < 50) return 0;
  const e20 = btcEma20[idx];
  const e50 = btcEma50[idx];
  if (!e20 || !e50) return 0;
  return e20 > e50 ? 1 : -1;
}

// ─── Strategy Configuration ───
interface StratCfg {
  name: string;
  shouldEnter: (score: number, wScore: number) => "long" | "short" | null;
  shouldExit: (score: number, wScore: number, posDir: "long" | "short") => boolean;
}

const strategies: StratCfg[] = [
  {
    name: "Unanimous (|s|=4)",
    shouldEnter: (s) => s === 4 ? "long" : s === -4 ? "short" : null,
    shouldExit: (s, _w, dir) => dir === "long" ? s <= -3 : s >= 3,
  },
  {
    name: "Majority (|s|>=3)",
    shouldEnter: (s) => s >= 3 ? "long" : s <= -3 ? "short" : null,
    shouldExit: (s, _w, dir) => dir === "long" ? s <= -2 : s >= 2,
  },
  {
    name: "Simple Maj (|s|>=2)",
    shouldEnter: (s) => s >= 2 ? "long" : s <= -2 ? "short" : null,
    shouldExit: (s, _w, dir) => dir === "long" ? s <= -2 : s >= 2,
  },
  {
    name: "Weighted (|ws|>3)",
    shouldEnter: (_s, ws) => ws > 3 ? "long" : ws < -3 ? "short" : null,
    shouldExit: (_s, ws, dir) => dir === "long" ? ws < -2 : ws > 2,
  },
];

// ─── Simulation ───
interface Pos {
  pair: string; dir: "long" | "short"; ep: number; et: number; sl: number;
}

function simulate(cfg: StratCfg, startTs: number, endTs: number): Tr[] {
  // Collect all unique 4h timestamps across all pairs
  const allTs = new Set<number>();
  for (const pair of TRADE_PAIRS) {
    const cs = h4Data.get(pair);
    if (cs) for (const c of cs) if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);

  const positions = new Map<string, Pos>();
  const trades: Tr[] = [];

  for (const t of sortedTs) {
    const closed = new Set<string>();

    // Check exits first
    for (const [pair, pos] of positions) {
      const cs = h4Data.get(pair);
      if (!cs) continue;
      const barIdx = findLastIdx(cs, t);
      if (barIdx < 0) continue;
      const bar = cs[barIdx];
      if (bar.t !== t) continue; // only process on exact 4h bar match

      const sp = SP[pair] ?? 4e-4;
      let xp = 0;
      let isSL = false;
      let reason = "";

      // SL check (intrabar)
      if (pos.dir === "long" && bar.l <= pos.sl) {
        xp = pos.sl; isSL = true; reason = "SL";
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        xp = pos.sl; isSL = true; reason = "SL";
      }

      // Max hold
      if (!xp && t - pos.et >= MAX_HOLD) {
        xp = bar.c; reason = "MaxHold";
      }

      // Score-based exit
      if (!xp) {
        const vST = voteSupertrend(pair, t);
        const vG = voteGARCH(pair, t);
        const vD = voteDonchianTrend(pair, t);
        const vB = voteBTC(t);
        const score = vST + vG + vD + vB;
        const wScore = vST * 2 + vG * 2 + vD + vB;

        if (cfg.shouldExit(score, wScore, pos.dir)) {
          xp = bar.o; reason = "ScoreFlip";
        }
      }

      if (xp > 0) {
        const xpAdj = exitCost(pair, pos.dir, xp, isSL);
        trades.push({
          pair, dir: pos.dir, ep: pos.ep, xp: xpAdj,
          et: pos.et, xt: t, pnl: tradePnl(pos.dir, pos.ep, xpAdj), reason,
        });
        positions.delete(pair);
        closed.add(pair);
      }
    }

    // Check entries
    for (const pair of TRADE_PAIRS) {
      if (positions.has(pair) || closed.has(pair)) continue;
      const cs = h4Data.get(pair);
      if (!cs) continue;
      const barIdx = findLastIdx(cs, t);
      if (barIdx < 0) continue;
      const bar = cs[barIdx];
      if (bar.t !== t) continue;

      const atr = atr4hData.get(pair);
      if (!atr || barIdx >= atr.length || atr[barIdx] <= 0) continue;

      const vST = voteSupertrend(pair, t);
      const vG = voteGARCH(pair, t);
      const vD = voteDonchianTrend(pair, t);
      const vB = voteBTC(t);
      const score = vST + vG + vD + vB;
      const wScore = vST * 2 + vG * 2 + vD + vB;

      const dir = cfg.shouldEnter(score, wScore);
      if (!dir) continue;

      // Entry at bar open
      const ep = entryCost(pair, dir, bar.o);

      // SL: ATR(14)*2, capped at 3.5%
      const atrVal = atr[barIdx];
      const slDist = Math.min(atrVal * 2, ep * 0.035);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(pair, { pair, dir, ep, et: t, sl });
    }
  }

  // Close remaining positions at end
  for (const [pair, pos] of positions) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length === 0) continue;
    const lastBar = cs[cs.length - 1];
    const xpAdj = exitCost(pair, pos.dir, lastBar.c, false);
    trades.push({
      pair, dir: pos.dir, ep: pos.ep, xp: xpAdj,
      et: pos.et, xt: lastBar.t, pnl: tradePnl(pos.dir, pos.ep, xpAdj), reason: "EOD",
    });
  }

  return trades.sort((a, b) => a.xt - b.xt);
}

// ─── Standalone Supertrend (baseline) ───
function simSupertrend(startTs: number, endTs: number): Tr[] {
  const trades: Tr[] = [];

  for (const pair of TRADE_PAIRS) {
    const cs = h4Data.get(pair);
    const sd = stData.get(pair);
    const atr = atr4hData.get(pair);
    if (!cs || !sd || !atr) continue;

    let pos: Pos | null = null;

    for (let i = 15; i < cs.length; i++) {
      if (cs[i].t < startTs || cs[i].t >= endTs) continue;

      const prevDir2 = sd.dir[i - 2];
      const prevDir1 = sd.dir[i - 1];
      const flip = prevDir1 !== prevDir2 && i > 1;

      // Exit on flip or SL or max hold
      if (pos) {
        const bar = cs[i];
        let xp = 0;
        let isSL = false;
        let reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; reason = "SL"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; reason = "SL"; }

        if (!xp && cs[i].t - pos.et >= MAX_HOLD) { xp = bar.c; reason = "MaxHold"; }

        if (!xp && flip) { xp = cs[i].o; reason = "Flip"; }

        if (xp > 0) {
          const xpAdj = exitCost(pair, pos.dir, xp, isSL);
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp: xpAdj,
            et: pos.et, xt: cs[i].t, pnl: tradePnl(pos.dir, pos.ep, xpAdj), reason,
          });
          pos = null;
        }
      }

      // Enter on flip
      if (!pos && flip) {
        const dir: "long" | "short" = prevDir1 === 1 ? "long" : "short";
        const ep = entryCost(pair, dir, cs[i].o);
        const atrVal = atr[i - 1] > 0 ? atr[i - 1] : atr[i];
        const slDist = Math.min(atrVal * 2, ep * 0.035);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { pair, dir, ep, et: cs[i].t, sl };
      }
    }

    // Close remaining
    if (pos) {
      const lastBar = cs[cs.length - 1];
      const xpAdj = exitCost(pair, pos.dir, lastBar.c, false);
      trades.push({
        pair, dir: pos.dir, ep: pos.ep, xp: xpAdj,
        et: pos.et, xt: lastBar.t, pnl: tradePnl(pos.dir, pos.ep, xpAdj), reason: "EOD",
      });
    }
  }

  return trades.sort((a, b) => a.xt - b.xt);
}

// ─── Metrics ───
interface Metrics {
  label: string; n: number; wr: number; pf: number; sharpe: number;
  maxDD: number; total: number; perDay: number;
}

function calcMetrics(trades: Tr[], label: string, startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / DAY;
  if (trades.length === 0) return { label, n: 0, wr: 0, pf: 0, sharpe: 0, maxDD: 0, total: 0, perDay: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wr = wins.length / trades.length * 100;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let cum = 0, pk = 0, maxDD = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > pk) pk = cum;
    if (pk - cum > maxDD) maxDD = pk - cum;
  }

  const dpMap = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dpMap.set(d, (dpMap.get(d) || 0) + t.pnl);
  }
  const dpArr = [...dpMap.values()];
  const avg = dpArr.reduce((s, r) => s + r, 0) / Math.max(dpArr.length, 1);
  const std = Math.sqrt(dpArr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dpArr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  return { label, n: trades.length, wr, pf, sharpe, maxDD, total, perDay: total / days };
}

function printRow(m: Metrics) {
  const pnlStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
  console.log(
    `${m.label.padEnd(26)} ${String(m.n).padStart(6)}  ${m.wr.toFixed(1).padStart(5)}%  ${m.pf.toFixed(2).padStart(5)}  ${m.sharpe.toFixed(2).padStart(6)}  ${("$" + m.perDay.toFixed(2)).padStart(7)}  ${("$" + m.maxDD.toFixed(1)).padStart(8)}  ${pnlStr.padStart(10)}`
  );
}

// ─── Run ───
console.log("\n" + "=".repeat(95));
console.log("ENGINE VOTING BACKTEST");
console.log("Supertrend(14,1.75) + GARCH z(2/1.5) + Daily SMA20/50 + BTC EMA20/50");
console.log(`$${SIZE} margin, ${LEV}x leverage, ATR*2 SL (cap 3.5%), max hold 30d`);
console.log(`Pairs: ${TRADE_PAIRS.length} | Full: 2023-01 to 2026-03 | OOS: 2025-09-01+`);
console.log("Fee: 0.035% taker, spread map, 1.5x SL slippage");
console.log("=".repeat(95));

// Vote distribution analysis (OOS only)
console.log("\n--- Vote Distribution (OOS, sampled at each 4h bar) ---");
const voteCounts = new Map<number, number>();
let totalVotes = 0;
for (const pair of TRADE_PAIRS) {
  const cs = h4Data.get(pair);
  if (!cs) continue;
  for (const bar of cs) {
    if (bar.t < OOS_START || bar.t >= OOS_END) continue;
    const vST = voteSupertrend(pair, bar.t);
    const vG = voteGARCH(pair, bar.t);
    const vD = voteDonchianTrend(pair, bar.t);
    const vB = voteBTC(bar.t);
    const score = vST + vG + vD + vB;
    voteCounts.set(score, (voteCounts.get(score) || 0) + 1);
    totalVotes++;
  }
}
for (let s = -4; s <= 4; s++) {
  const cnt = voteCounts.get(s) || 0;
  const pct = (cnt / totalVotes * 100).toFixed(1);
  const bar = "#".repeat(Math.round(cnt / totalVotes * 100));
  console.log(`  Score ${s >= 0 ? "+" : ""}${s}: ${String(cnt).padStart(7)} (${pct.padStart(5)}%) ${bar}`);
}
console.log(`  Total samples: ${totalVotes}`);

// OOS results
console.log("\n--- OOS Results (2025-09-01 to 2026-03-25) ---");
console.log(`${"Strategy".padEnd(26)} ${"Trades".padStart(6)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"$/day".padStart(7)}  ${"MaxDD".padStart(8)}  ${"TotalPnL".padStart(10)}`);
console.log("-".repeat(95));

// Baseline: standalone Supertrend
const stTrades = simSupertrend(OOS_START, OOS_END);
const stMetrics = calcMetrics(stTrades, "Supertrend Standalone", OOS_START, OOS_END);
printRow(stMetrics);
console.log("-".repeat(95));

// Voting strategies
const voteResults: Metrics[] = [];
for (const cfg of strategies) {
  const tr = simulate(cfg, OOS_START, OOS_END);
  const m = calcMetrics(tr, cfg.name, OOS_START, OOS_END);
  printRow(m);
  voteResults.push(m);
}

// Full period results
console.log("\n--- Full Period (2023-01 to 2026-03) ---");
console.log(`${"Strategy".padEnd(26)} ${"Trades".padStart(6)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"Sharpe".padStart(6)}  ${"$/day".padStart(7)}  ${"MaxDD".padStart(8)}  ${"TotalPnL".padStart(10)}`);
console.log("-".repeat(95));

const stFullTrades = simSupertrend(FULL_START, OOS_END);
const stFullM = calcMetrics(stFullTrades, "Supertrend Standalone", FULL_START, OOS_END);
printRow(stFullM);
console.log("-".repeat(95));

for (const cfg of strategies) {
  const tr = simulate(cfg, FULL_START, OOS_END);
  const m = calcMetrics(tr, cfg.name, FULL_START, OOS_END);
  printRow(m);
}

// In-sample vs OOS comparison
console.log("\n--- In-Sample vs OOS Stability ---");
console.log(`${"Strategy".padEnd(26)} ${"IS $/day".padStart(8)}  ${"OOS $/day".padStart(9)}  ${"Decay%".padStart(7)}`);
console.log("-".repeat(55));

const stIS = simSupertrend(FULL_START, OOS_START);
const stISm = calcMetrics(stIS, "", FULL_START, OOS_START);
const stOOSm = stMetrics;
const stDecay = stISm.perDay !== 0 ? ((stISm.perDay - stOOSm.perDay) / Math.abs(stISm.perDay) * 100) : 0;
console.log(`${"Supertrend Standalone".padEnd(26)} ${("$" + stISm.perDay.toFixed(2)).padStart(8)}  ${("$" + stOOSm.perDay.toFixed(2)).padStart(9)}  ${stDecay.toFixed(1).padStart(6)}%`);

for (const cfg of strategies) {
  const isT = simulate(cfg, FULL_START, OOS_START);
  const oosT = simulate(cfg, OOS_START, OOS_END);
  const isM = calcMetrics(isT, "", FULL_START, OOS_START);
  const oosM = calcMetrics(oosT, cfg.name, OOS_START, OOS_END);
  const decay = isM.perDay !== 0 ? ((isM.perDay - oosM.perDay) / Math.abs(isM.perDay) * 100) : 0;
  console.log(`${cfg.name.padEnd(26)} ${("$" + isM.perDay.toFixed(2)).padStart(8)}  ${("$" + oosM.perDay.toFixed(2)).padStart(9)}  ${decay.toFixed(1).padStart(6)}%`);
}

// Per-pair breakdown for best voting strategy
console.log("\n--- Per-Pair OOS Breakdown: Majority (|s|>=3) ---");
console.log(`${"Pair".padEnd(10)} ${"Trades".padStart(6)}  ${"WR%".padStart(6)}  ${"PnL".padStart(8)}  ${"Avg".padStart(7)}`);
console.log("-".repeat(42));

const majTrades = simulate(strategies[1], OOS_START, OOS_END); // Majority
const pairGroups = new Map<string, Tr[]>();
for (const t of majTrades) {
  const arr = pairGroups.get(t.pair) || [];
  arr.push(t);
  pairGroups.set(t.pair, arr);
}
const pairResults = [...pairGroups.entries()]
  .map(([pair, trs]) => ({
    pair,
    n: trs.length,
    wr: trs.filter(t => t.pnl > 0).length / trs.length * 100,
    pnl: trs.reduce((s, t) => s + t.pnl, 0),
    avg: trs.reduce((s, t) => s + t.pnl, 0) / trs.length,
  }))
  .sort((a, b) => b.pnl - a.pnl);

for (const p of pairResults) {
  const pnlStr = p.pnl >= 0 ? `+$${p.pnl.toFixed(2)}` : `-$${Math.abs(p.pnl).toFixed(2)}`;
  console.log(`${p.pair.padEnd(10)} ${String(p.n).padStart(6)}  ${p.wr.toFixed(1).padStart(5)}%  ${pnlStr.padStart(8)}  ${("$" + p.avg.toFixed(2)).padStart(7)}`);
}
const majTotal = pairResults.reduce((s, p) => s + p.pnl, 0);
console.log("-".repeat(42));
console.log(`${"TOTAL".padEnd(10)} ${String(majTrades.length).padStart(6)}  ${(majTrades.filter(t => t.pnl > 0).length / majTrades.length * 100).toFixed(1).padStart(5)}%  ${(majTotal >= 0 ? "+$" : "-$") + Math.abs(majTotal).toFixed(2).padStart(7)}`);

// Exit reason breakdown
console.log("\n--- Exit Reasons (Majority OOS) ---");
const reasons = new Map<string, { count: number; pnl: number }>();
for (const t of majTrades) {
  const r = reasons.get(t.reason) || { count: 0, pnl: 0 };
  r.count++; r.pnl += t.pnl;
  reasons.set(t.reason, r);
}
for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
  console.log(`  ${reason.padEnd(12)} ${String(data.count).padStart(5)} trades  ${pnlStr.padStart(10)}`);
}

// Monthly OOS P&L for majority
console.log("\n--- Monthly OOS P&L: Majority (|s|>=3) ---");
const monthly = new Map<string, { pnl: number; trades: number }>();
for (const t of majTrades) {
  const m = new Date(t.xt).toISOString().slice(0, 7);
  const d = monthly.get(m) || { pnl: 0, trades: 0 };
  d.pnl += t.pnl; d.trades++;
  monthly.set(m, d);
}
for (const [m, d] of [...monthly.entries()].sort()) {
  const pnlStr = d.pnl >= 0 ? `+$${d.pnl.toFixed(2)}` : `-$${Math.abs(d.pnl).toFixed(2)}`;
  console.log(`  ${m}  ${String(d.trades).padStart(4)} trades  ${pnlStr.padStart(10)}`);
}

// Long/short split
console.log("\n--- Long/Short Split (Majority OOS) ---");
const longs = majTrades.filter(t => t.dir === "long");
const shorts = majTrades.filter(t => t.dir === "short");
const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
const longWR = longs.length > 0 ? longs.filter(t => t.pnl > 0).length / longs.length * 100 : 0;
const shortWR = shorts.length > 0 ? shorts.filter(t => t.pnl > 0).length / shorts.length * 100 : 0;
console.log(`  Long:  ${String(longs.length).padStart(4)} trades  WR=${longWR.toFixed(1)}%  ${longPnl >= 0 ? "+" : "-"}$${Math.abs(longPnl).toFixed(2)}`);
console.log(`  Short: ${String(shorts.length).padStart(4)} trades  WR=${shortWR.toFixed(1)}%  ${shortPnl >= 0 ? "+" : "-"}$${Math.abs(shortPnl).toFixed(2)}`);

console.log("\nDone.");
