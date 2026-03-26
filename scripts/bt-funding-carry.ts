/**
 * Enhanced Carry Strategy Backtest -- REAL Hyperliquid Funding Rates
 *
 * Downloads actual hourly funding data from HL API.
 * Tests 4 strategies:
 *   A. Simple Carry (weekly rebalance, rank by 7d avg funding)
 *   B. Carry + Momentum Filter (funding rank + 7d price momentum alignment)
 *   C. Extreme Funding Contrarian (2-sigma deviation from 30d mean)
 *   D. Funding Rate Change Momentum (3-day funding delta)
 *
 * P&L = price change + cumulative funding collected/paid
 * Cost: taker 0.035% entry/exit, spread map, 10x lev, $5 margin
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const FUNDING_DIR = "/tmp/hl-funding";
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const H = 3600000;
const DAY = 86400000;
const FEE = 0.00035;
const SIZE = 5;
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA",
  "DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

const DL_START = new Date("2024-01-01").getTime();
const FULL_START = new Date("2024-03-01").getTime(); // allow 2 months warmup for 30d stats
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface FR { coin: string; fundingRate: string; premium: string; time: number; }
interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface HourlyBar { t: number; o: number; h: number; l: number; c: number; funding: number; }
interface Trade {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pricePnl: number; fundingPnl: number; totalPnl: number;
}
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number; dd: number;
  total: number; perDay: number; avgFundPnl: number;
}

// ─── Step 1: Download Funding Rates ─────────────────────────────────
async function downloadFunding(coin: string): Promise<FR[]> {
  const cacheFile = path.join(FUNDING_DIR, `${coin}_funding.json`);
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  }

  console.log(`  Downloading ${coin} funding...`);
  const all: FR[] = [];
  let startTime = DL_START;
  const batchSize = 500; // HL returns max 500 per request

  while (startTime < Date.now()) {
    const body = JSON.stringify({ type: "fundingHistory", coin, startTime });
    const resp = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!resp.ok) {
      console.log(`    ${coin} API error: ${resp.status} ${resp.statusText}`);
      break;
    }

    const batch: FR[] = await resp.json() as FR[];
    if (batch.length === 0) break;

    all.push(...batch);
    const lastTime = batch[batch.length - 1].time;

    if (batch.length < batchSize || lastTime >= Date.now()) break;
    startTime = lastTime + 1;

    // delay to avoid rate limiting (HL has aggressive 429 limits)
    await new Promise(r => setTimeout(r, 500));
  }

  if (all.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify(all));
  }
  console.log(`    ${coin}: ${all.length} funding records (${all.length > 0 ? new Date(all[0].time).toISOString().slice(0,10) : "none"} to ${all.length > 0 ? new Date(all[all.length-1].time).toISOString().slice(0,10) : "none"})`);
  return all;
}

// ─── Step 2: Load & Aggregate Price Data ────────────────────────────
function load5m(pair: string): Candle[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: Candle, b: Candle) => a.t - b.t);
}

function aggregateToHourly(candles: Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const c of candles) {
    const hourTs = Math.floor(c.t / H) * H;
    const arr = groups.get(hourTs) ?? [];
    arr.push(c);
    groups.set(hourTs, arr);
  }
  const hourly: Candle[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 8) continue; // need at least 8 of 12 5m bars
    hourly.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return hourly;
}

function aggregateToDaily(candles: Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const c of candles) {
    const dayTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dayTs) ?? [];
    arr.push(c);
    groups.set(dayTs, arr);
  }
  const daily: Candle[] = [];
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

// ─── Build Hourly Data with Funding ─────────────────────────────────
function buildHourlyBars(pair: string, funding: FR[], candles: Candle[]): HourlyBar[] {
  const hourlyCandles = aggregateToHourly(candles);
  const fundingMap = new Map<number, number>();
  for (const f of funding) {
    const hTs = Math.floor(f.time / H) * H;
    fundingMap.set(hTs, parseFloat(f.fundingRate));
  }

  const bars: HourlyBar[] = [];
  for (const c of hourlyCandles) {
    bars.push({
      ...c,
      funding: fundingMap.get(c.t) ?? 0,
    });
  }
  return bars;
}

// ─── Cost Helpers ───────────────────────────────────────────────────
function entryCost(pair: string, price: number): number {
  const sp = SPREAD[pair] ?? 4e-4;
  return price * sp + price * FEE;
}

function exitCost(pair: string, price: number): number {
  const sp = SPREAD[pair] ?? 4e-4;
  return price * sp + price * FEE;
}

// ─── Metrics ────────────────────────────────────────────────────────
function calcMetrics(trades: Trade[], startMs: number, endMs: number): Metrics {
  const n = trades.length;
  if (n === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgFundPnl: 0 };

  const wins = trades.filter(t => t.totalPnl > 0);
  const losses = trades.filter(t => t.totalPnl <= 0);
  const wr = wins.length / n * 100;
  const grossWin = wins.reduce((s, t) => s + t.totalPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.totalPnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const total = trades.reduce((s, t) => s + t.totalPnl, 0);
  const days = (endMs - startMs) / DAY;
  const perDay = total / days;

  // Sharpe from daily returns
  const dailyPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.totalPnl);
  }
  const dr = [...dailyPnl.values()];
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // MaxDD
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades.sort((a, b) => a.xt - b.xt)) {
    cum += t.totalPnl;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  const avgFundPnl = trades.reduce((s, t) => s + t.fundingPnl, 0) / n;

  return { n, wr, pf, sharpe, dd, total, perDay, avgFundPnl };
}

// ─── Strategy A: Simple Carry (Weekly Rebalance) ────────────────────
function simpleCarry(
  pairData: Map<string, HourlyBar[]>,
  startMs: number, endMs: number
): Trade[] {
  const trades: Trade[] = [];
  const REBAL_PERIOD = 7 * 24; // 7 days in hours
  const LOOKBACK = 7 * 24; // 7-day trailing avg
  const TOP_N = 3;

  // Build daily close map for each pair for quick lookups
  // We iterate through time in weekly steps
  const allTimes = new Set<number>();
  for (const bars of pairData.values()) {
    for (const b of bars) {
      if (b.t >= startMs && b.t < endMs) allTimes.add(b.t);
    }
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b);
  if (sortedTimes.length === 0) return trades;

  // Index bars by timestamp for each pair
  const pairBarMap = new Map<string, Map<number, HourlyBar>>();
  for (const [pair, bars] of pairData) {
    const m = new Map<number, HourlyBar>();
    for (const b of bars) m.set(b.t, b);
    pairBarMap.set(pair, m);
  }

  // Rebalance weekly
  let nextRebal = startMs;
  const positions = new Map<string, { pair: string; dir: "long"|"short"; ep: number; et: number }>();

  for (const t of sortedTimes) {
    if (t < nextRebal) continue;

    // Close existing positions
    for (const [key, pos] of positions) {
      const bm = pairBarMap.get(pos.pair);
      if (!bm) continue;
      const bar = bm.get(t);
      if (!bar) continue;
      const xp = bar.o;
      const pricePnl = pos.dir === "long"
        ? (xp / pos.ep - 1) * NOT
        : (pos.ep / xp - 1) * NOT;

      // Accumulate funding P&L over hold period
      let fundPnl = 0;
      const bars = pairData.get(pos.pair) ?? [];
      for (const b of bars) {
        if (b.t >= pos.et && b.t < t) {
          if (pos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }

      const sp = SPREAD[pos.pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      const totalPnl = pricePnl + fundPnl - cost;
      trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pricePnl, fundingPnl: fundPnl, totalPnl });
    }
    positions.clear();

    // Rank pairs by trailing 7d avg funding (only count hours WITH funding data)
    const rankings: { pair: string; avgFunding: number }[] = [];
    for (const pair of PAIRS) {
      const bars = pairData.get(pair);
      if (!bars) continue;
      let sum = 0, cnt = 0;
      for (const b of bars) {
        if (b.t >= t - LOOKBACK * H && b.t < t && b.funding !== 0) {
          sum += b.funding;
          cnt++;
        }
      }
      if (cnt < 20) continue; // need at least 20 non-zero funding entries in 7d
      rankings.push({ pair, avgFunding: sum / cnt });
    }
    rankings.sort((a, b) => b.avgFunding - a.avgFunding);

    // Short top N (highest funding -- shorts collect)
    for (let i = 0; i < Math.min(TOP_N, rankings.length); i++) {
      const { pair } = rankings[i];
      const bm = pairBarMap.get(pair);
      if (!bm) continue;
      const bar = bm.get(t);
      if (!bar) continue;
      positions.set(pair + "_S", { pair, dir: "short", ep: bar.o, et: t });
    }

    // Long bottom N (lowest/negative funding -- longs collect)
    for (let i = Math.max(0, rankings.length - TOP_N); i < rankings.length; i++) {
      const { pair } = rankings[i];
      const bm = pairBarMap.get(pair);
      if (!bm) continue;
      const bar = bm.get(t);
      if (!bar) continue;
      if (positions.has(pair + "_S")) continue;
      positions.set(pair + "_L", { pair, dir: "long", ep: bar.o, et: t });
    }

    nextRebal = t + REBAL_PERIOD * H;
  }

  return trades;
}

// ─── Strategy B: Carry + Momentum Filter ────────────────────────────
function carryMomentum(
  pairData: Map<string, HourlyBar[]>,
  dailyData: Map<string, Candle[]>,
  startMs: number, endMs: number
): Trade[] {
  const trades: Trade[] = [];
  const REBAL_PERIOD = 7 * 24;
  const LOOKBACK = 7 * 24;
  const TOP_N = 3;

  const pairBarMap = new Map<string, Map<number, HourlyBar>>();
  for (const [pair, bars] of pairData) {
    const m = new Map<number, HourlyBar>();
    for (const b of bars) m.set(b.t, b);
    pairBarMap.set(pair, m);
  }

  // Get 7d price momentum at a given time
  function getMomentum(pair: string, t: number): number | null {
    const daily = dailyData.get(pair);
    if (!daily) return null;
    const dayTs = Math.floor(t / DAY) * DAY;
    const today = daily.find(d => d.t === dayTs || d.t === dayTs - DAY);
    const weekAgo = daily.find(d => Math.abs(d.t - (dayTs - 7 * DAY)) < 2 * DAY);
    if (!today || !weekAgo) return null;
    return (today.c / weekAgo.c) - 1;
  }

  const allTimes = new Set<number>();
  for (const bars of pairData.values()) {
    for (const b of bars) {
      if (b.t >= startMs && b.t < endMs) allTimes.add(b.t);
    }
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b);

  let nextRebal = startMs;
  const positions = new Map<string, { dir: "long"|"short"; ep: number; et: number }>();

  for (const t of sortedTimes) {
    if (t < nextRebal) continue;

    // Close positions
    for (const [key, pos] of positions) {
      const pair = key.replace(/_[LS]$/, "");
      const bm = pairBarMap.get(pair);
      if (!bm) continue;
      const bar = bm.get(t);
      if (!bar) continue;
      const xp = bar.o;
      const pricePnl = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
      let fundPnl = 0;
      const bars = pairData.get(pair) ?? [];
      for (const b of bars) {
        if (b.t >= pos.et && b.t < t) {
          if (pos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }
      const sp = SPREAD[pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pricePnl, fundingPnl: fundPnl, totalPnl: pricePnl + fundPnl - cost });
    }
    positions.clear();

    // Rank by funding (only count hours with actual funding data)
    const rankings: { pair: string; avgFunding: number }[] = [];
    for (const pair of PAIRS) {
      const bars = pairData.get(pair);
      if (!bars) continue;
      let sum = 0, cnt = 0;
      for (const b of bars) {
        if (b.t >= t - LOOKBACK * H && b.t < t && b.funding !== 0) { sum += b.funding; cnt++; }
      }
      if (cnt < 20) continue;
      rankings.push({ pair, avgFunding: sum / cnt });
    }
    rankings.sort((a, b) => b.avgFunding - a.avgFunding);

    // Short top N only if funding > 0 AND 7d momentum is negative
    let shortCount = 0;
    for (const { pair, avgFunding } of rankings) {
      if (shortCount >= TOP_N) break;
      if (avgFunding <= 0) break;
      const mom = getMomentum(pair, t);
      if (mom === null || mom >= 0) continue; // need negative momentum
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      positions.set(pair + "_S", { dir: "short", ep: bar.o, et: t });
      shortCount++;
    }

    // Long bottom N only if funding < 0 AND 7d momentum is positive
    let longCount = 0;
    for (let i = rankings.length - 1; i >= 0; i--) {
      if (longCount >= TOP_N) break;
      const { pair, avgFunding } = rankings[i];
      if (avgFunding >= 0) break;
      const mom = getMomentum(pair, t);
      if (mom === null || mom <= 0) continue; // need positive momentum
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      if (positions.has(pair + "_S")) continue;
      positions.set(pair + "_L", { dir: "long", ep: bar.o, et: t });
      longCount++;
    }

    nextRebal = t + REBAL_PERIOD * H;
  }

  return trades;
}

// ─── Strategy C: Extreme Funding Contrarian (Daily) ─────────────────
function extremeContrarian(
  pairData: Map<string, HourlyBar[]>,
  startMs: number, endMs: number
): Trade[] {
  const trades: Trade[] = [];
  const LOOKBACK_H = 30 * 24; // 30 days for mean/std
  const ENTRY_SIGMA = 2.0;
  const EXIT_SIGMA = 1.0;
  const MAX_HOLD = 72 * H;

  // Build hourly funding series per pair
  const pairBarMap = new Map<string, Map<number, HourlyBar>>();
  for (const [pair, bars] of pairData) {
    const m = new Map<number, HourlyBar>();
    for (const b of bars) m.set(b.t, b);
    pairBarMap.set(pair, m);
  }

  // For each pair, scan daily for extreme funding
  for (const pair of PAIRS) {
    const bars = pairData.get(pair);
    if (!bars || bars.length < LOOKBACK_H) continue;

    const positions: { dir: "long"|"short"; ep: number; et: number }[] = [];

    for (let i = LOOKBACK_H; i < bars.length; i++) {
      const t = bars[i].t;
      if (t < startMs || t >= endMs) continue;

      // Only check every 24h (daily check, not every hour)
      if (Math.floor(t / DAY) !== Math.floor(t / DAY) || t % DAY !== 0) {
        // Check at midnight UTC roughly
        const hourInDay = (t % DAY) / H;
        if (hourInDay !== 0) continue;
      }

      // Check if we already have a position
      if (positions.length > 0) {
        const pos = positions[0];
        // Check exit: funding normalized or max hold
        const holdTime = t - pos.et;
        const recentFunding: number[] = [];
        for (let j = Math.max(0, i - LOOKBACK_H); j < i; j++) {
          recentFunding.push(bars[j].funding);
        }
        const mean = recentFunding.reduce((s, v) => s + v, 0) / recentFunding.length;
        const std = Math.sqrt(recentFunding.reduce((s, v) => s + (v - mean) ** 2, 0) / recentFunding.length);
        const currentZ = std > 0 ? (bars[i].funding - mean) / std : 0;

        const shouldExit = holdTime >= MAX_HOLD || Math.abs(currentZ) < EXIT_SIGMA;

        if (shouldExit) {
          const xp = bars[i].c;
          const pricePnl = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
          let fundPnl = 0;
          for (const b of bars) {
            if (b.t >= pos.et && b.t < t) {
              if (pos.dir === "short") fundPnl += NOT * b.funding;
              else fundPnl -= NOT * b.funding;
            }
          }
          const sp = SPREAD[pair] ?? 4e-4;
          const cost = NOT * FEE * 2 + NOT * sp * 2;
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pricePnl, fundingPnl: fundPnl, totalPnl: pricePnl + fundPnl - cost });
          positions.length = 0;
        }
        continue;
      }

      // Calculate rolling 30d stats
      const recentFunding: number[] = [];
      for (let j = Math.max(0, i - LOOKBACK_H); j < i; j++) {
        recentFunding.push(bars[j].funding);
      }
      if (recentFunding.length < LOOKBACK_H * 0.5) continue;

      const mean = recentFunding.reduce((s, v) => s + v, 0) / recentFunding.length;
      const std = Math.sqrt(recentFunding.reduce((s, v) => s + (v - mean) ** 2, 0) / recentFunding.length);
      if (std === 0) continue;

      const currentZ = (bars[i].funding - mean) / std;

      if (currentZ > ENTRY_SIGMA) {
        // Extremely positive funding -> short (crowded longs)
        positions.push({ dir: "short", ep: bars[i].c, et: t });
      } else if (currentZ < -ENTRY_SIGMA) {
        // Extremely negative funding -> long (crowded shorts)
        positions.push({ dir: "long", ep: bars[i].c, et: t });
      }
    }

    // Close any remaining open position at end
    if (positions.length > 0 && bars.length > 0) {
      const pos = positions[0];
      const lastBar = bars[bars.length - 1];
      const xp = lastBar.c;
      const pricePnl = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
      let fundPnl = 0;
      for (const b of bars) {
        if (b.t >= pos.et && b.t < lastBar.t) {
          if (pos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }
      const sp = SPREAD[pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: lastBar.t, pricePnl, fundingPnl: fundPnl, totalPnl: pricePnl + fundPnl - cost });
    }
  }

  return trades.sort((a, b) => a.et - b.et);
}

// ─── Strategy D: Funding Rate Change Momentum ───────────────────────
function fundingDelta(
  pairData: Map<string, HourlyBar[]>,
  startMs: number, endMs: number
): Trade[] {
  const trades: Trade[] = [];
  const DELTA_PERIOD = 3 * 24; // 3 days in hours
  const HOLD_PERIOD = 24 * H; // 24h hold
  const CHECK_INTERVAL = 4 * H; // check every 4h

  for (const pair of PAIRS) {
    const bars = pairData.get(pair);
    if (!bars || bars.length < DELTA_PERIOD * 2) continue;

    const pairBarMap = new Map<number, HourlyBar>();
    for (const b of bars) pairBarMap.set(b.t, b);

    let openPos: { dir: "long"|"short"; ep: number; et: number } | null = null;

    for (let i = DELTA_PERIOD; i < bars.length; i++) {
      const t = bars[i].t;
      if (t < startMs || t >= endMs) continue;

      // Only act on 4h intervals
      if ((t % (4 * H)) !== 0) continue;

      // Check exit first
      if (openPos) {
        if (t - openPos.et >= HOLD_PERIOD) {
          const xp = bars[i].c;
          const pricePnl = openPos.dir === "long" ? (xp / openPos.ep - 1) * NOT : (openPos.ep / xp - 1) * NOT;
          let fundPnl = 0;
          for (const b of bars) {
            if (b.t >= openPos.et && b.t < t) {
              if (openPos.dir === "short") fundPnl += NOT * b.funding;
              else fundPnl -= NOT * b.funding;
            }
          }
          const sp = SPREAD[pair] ?? 4e-4;
          const cost = NOT * FEE * 2 + NOT * sp * 2;
          trades.push({ pair, dir: openPos.dir, ep: openPos.ep, xp, et: openPos.et, xt: t, pricePnl, fundingPnl: fundPnl, totalPnl: pricePnl + fundPnl - cost });
          openPos = null;
        }
        continue;
      }

      // Calculate 3-day funding rate change
      // Current avg (last 24h) vs 3 days ago avg (24h window 3 days back)
      let recentSum = 0, recentCnt = 0;
      let oldSum = 0, oldCnt = 0;
      for (let j = Math.max(0, i - 24); j < i; j++) {
        recentSum += bars[j].funding;
        recentCnt++;
      }
      for (let j = Math.max(0, i - DELTA_PERIOD); j < Math.max(0, i - DELTA_PERIOD + 24); j++) {
        oldSum += bars[j].funding;
        oldCnt++;
      }
      if (recentCnt < 12 || oldCnt < 12) continue;

      const recentAvg = recentSum / recentCnt;
      const oldAvg = oldSum / oldCnt;
      const delta = recentAvg - oldAvg;

      // Need meaningful delta -- use absolute threshold
      const threshold = 5e-6; // ~0.0005% per hour, or ~0.012% daily
      if (Math.abs(delta) < threshold) continue;

      if (delta > threshold) {
        // Funding increasing rapidly -> short (late longs entering)
        openPos = { dir: "short", ep: bars[i].c, et: t };
      } else if (delta < -threshold) {
        // Funding decreasing rapidly -> long (shorts capitulating)
        openPos = { dir: "long", ep: bars[i].c, et: t };
      }
    }

    // Close remaining
    if (openPos && bars.length > 0) {
      const lastBar = bars[bars.length - 1];
      const xp = lastBar.c;
      const pricePnl = openPos.dir === "long" ? (xp / openPos.ep - 1) * NOT : (openPos.ep / xp - 1) * NOT;
      let fundPnl = 0;
      for (const b of bars) {
        if (b.t >= openPos.et && b.t < lastBar.t) {
          if (openPos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }
      const sp = SPREAD[pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      trades.push({ pair, dir: openPos.dir, ep: openPos.ep, xp, et: openPos.et, xt: lastBar.t, pricePnl, fundingPnl: fundPnl, totalPnl: pricePnl + fundPnl - cost });
    }
  }

  return trades.sort((a, b) => a.et - b.et);
}

// ─── Correlation with Trend Following ───────────────────────────────
function trendFollowingProxy(dailyData: Map<string, Candle[]>, startMs: number, endMs: number): Map<number, number> {
  // Simple SMA 30/60 crossover daily returns as a proxy
  const dailyReturns = new Map<number, number>();

  for (const [_pair, daily] of dailyData) {
    for (let i = 60; i < daily.length; i++) {
      const t = daily[i].t;
      if (t < startMs || t >= endMs) continue;

      let sma30 = 0, sma60 = 0;
      for (let j = i - 29; j <= i; j++) sma30 += daily[j].c;
      sma30 /= 30;
      for (let j = i - 59; j <= i; j++) sma60 += daily[j].c;
      sma60 /= 60;

      const signal = sma30 > sma60 ? 1 : -1;
      const ret = (daily[i].c / daily[i - 1].c - 1) * signal;
      const d = Math.floor(t / DAY);
      dailyReturns.set(d, (dailyReturns.get(d) ?? 0) + ret);
    }
  }
  return dailyReturns;
}

function calcCorrelation(a: Map<number, number>, b: Map<number, number>): number {
  const keys = [...a.keys()].filter(k => b.has(k));
  if (keys.length < 10) return 0;
  const va = keys.map(k => a.get(k)!);
  const vb = keys.map(k => b.get(k)!);
  const ma = va.reduce((s, v) => s + v, 0) / va.length;
  const mb = vb.reduce((s, v) => s + v, 0) / vb.length;
  let cov = 0, sa = 0, sb = 0;
  for (let i = 0; i < keys.length; i++) {
    cov += (va[i] - ma) * (vb[i] - mb);
    sa += (va[i] - ma) ** 2;
    sb += (vb[i] - mb) ** 2;
  }
  return sa > 0 && sb > 0 ? cov / Math.sqrt(sa * sb) : 0;
}

function strategyDailyReturns(trades: Trade[]): Map<number, number> {
  const dr = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dr.set(d, (dr.get(d) ?? 0) + t.totalPnl);
  }
  return dr;
}

// ─── Funding Stats ──────────────────────────────────────────────────
function printFundingStats(pairData: Map<string, HourlyBar[]>) {
  console.log("\n=== Funding Rate Statistics (annualized) ===");
  console.log("Pair     Records  Avg/h        Ann%     StdDev/h     Median/h");
  console.log("-".repeat(70));

  for (const pair of PAIRS.sort()) {
    const bars = pairData.get(pair);
    if (!bars) { console.log(`${pair.padEnd(8)} NO DATA`); continue; }
    const rates = bars.filter(b => b.funding !== 0).map(b => b.funding);
    if (rates.length === 0) { console.log(`${pair.padEnd(8)} NO FUNDING`); continue; }
    const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
    const ann = avg * 8760 * 100; // annualized %
    const std = Math.sqrt(rates.reduce((s, r) => s + (r - avg) ** 2, 0) / rates.length);
    const sorted = [...rates].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `${pair.padEnd(8)} ${String(rates.length).padStart(7)}  ${avg.toExponential(3).padStart(12)}  ${ann.toFixed(2).padStart(7)}%  ${std.toExponential(3).padStart(12)}  ${med.toExponential(3).padStart(12)}`
    );
  }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  // Create funding cache directory
  if (!fs.existsSync(FUNDING_DIR)) fs.mkdirSync(FUNDING_DIR, { recursive: true });

  // Step 1: Download funding rates
  console.log("=== Step 1: Downloading Hyperliquid Funding Rates ===\n");
  const fundingData = new Map<string, FR[]>();
  for (const pair of PAIRS) {
    const data = await downloadFunding(pair);
    fundingData.set(pair, data);
    // Inter-coin delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  // Summary
  let totalRecords = 0;
  for (const [pair, data] of fundingData) {
    totalRecords += data.length;
  }
  console.log(`\nTotal funding records: ${totalRecords}`);

  // Step 2: Load price data
  console.log("\n=== Step 2: Loading Price Data ===\n");
  const pairData = new Map<string, HourlyBar[]>();
  const dailyData = new Map<string, Candle[]>();
  let pairsLoaded = 0;

  for (const pair of PAIRS) {
    const candles = load5m(pair);
    if (candles.length === 0) {
      console.log(`  ${pair}: no candle data, skipping`);
      continue;
    }
    const funding = fundingData.get(pair) ?? [];
    const hourly = buildHourlyBars(pair, funding, candles);
    const daily = aggregateToDaily(candles);
    pairData.set(pair, hourly);
    dailyData.set(pair, daily);
    const fundBars = hourly.filter(b => b.funding !== 0).length;
    console.log(`  ${pair}: ${candles.length} 5m candles -> ${hourly.length} hourly bars, ${fundBars} with funding`);
    pairsLoaded++;
  }
  console.log(`\nPairs loaded: ${pairsLoaded}/${PAIRS.length}`);

  // Print funding stats
  printFundingStats(pairData);

  // Step 3: Run strategies
  console.log("\n\n=== Step 3: Strategy Results ===\n");

  const strategies: { name: string; fn: () => Trade[] }[] = [
    { name: "A. Simple Carry (7d rebal)", fn: () => simpleCarry(pairData, FULL_START, END) },
    { name: "B. Carry + Momentum", fn: () => carryMomentum(pairData, dailyData, FULL_START, END) },
    { name: "C. Extreme Contrarian (2sig)", fn: () => extremeContrarian(pairData, FULL_START, END) },
    { name: "D. Funding Delta Momentum", fn: () => fundingDelta(pairData, FULL_START, END) },
  ];

  // Trend following proxy for correlation
  const tfReturns = trendFollowingProxy(dailyData, FULL_START, END);

  const allResults: { name: string; trades: Trade[]; fullM: Metrics; oosM: Metrics }[] = [];

  for (const strat of strategies) {
    const allTrades = strat.fn();
    const fullTrades = allTrades.filter(t => t.et >= FULL_START && t.xt <= END);
    const oosTrades = allTrades.filter(t => t.et >= OOS_START && t.xt <= END);

    const fullM = calcMetrics(fullTrades, FULL_START, END);
    const oosM = calcMetrics(oosTrades, OOS_START, END);

    allResults.push({ name: strat.name, trades: allTrades, fullM, oosM });
  }

  // Print results table
  console.log("                               --- FULL PERIOD (2024-03 to now) ---              --- OOS (2025-09+) ---");
  console.log("Strategy                    Trades  WR%    PF   Sharpe  Total     $/day   MaxDD  Trades  WR%    PF   Sharpe  Total     $/day   MaxDD  Corr(TF)");
  console.log("-".repeat(165));

  for (const r of allResults) {
    const f = r.fullM;
    const o = r.oosM;
    const corr = calcCorrelation(strategyDailyReturns(r.trades), tfReturns);

    const fTotal = f.total >= 0 ? `+$${f.total.toFixed(0)}` : `-$${Math.abs(f.total).toFixed(0)}`;
    const oTotal = o.total >= 0 ? `+$${o.total.toFixed(0)}` : `-$${Math.abs(o.total).toFixed(0)}`;

    console.log(
      `${r.name.padEnd(27)} ` +
      `${String(f.n).padStart(6)}  ${f.wr.toFixed(1).padStart(5)}  ${f.pf.toFixed(2).padStart(5)}  ${f.sharpe.toFixed(2).padStart(6)}  ${fTotal.padStart(8)}  ${("$" + f.perDay.toFixed(2)).padStart(7)}  ${("$" + f.dd.toFixed(0)).padStart(6)}  ` +
      `${String(o.n).padStart(6)}  ${o.wr.toFixed(1).padStart(5)}  ${o.pf.toFixed(2).padStart(5)}  ${o.sharpe.toFixed(2).padStart(6)}  ${oTotal.padStart(8)}  ${("$" + o.perDay.toFixed(2)).padStart(7)}  ${("$" + o.dd.toFixed(0)).padStart(6)}  ${corr.toFixed(3).padStart(7)}`
    );
  }

  // Detailed breakdown per strategy
  for (const r of allResults) {
    console.log(`\n--- ${r.name} ---`);

    // Funding P&L breakdown
    const totalFundPnl = r.trades.reduce((s, t) => s + t.fundingPnl, 0);
    const totalPricePnl = r.trades.reduce((s, t) => s + t.pricePnl, 0);
    console.log(`  Price P&L: $${totalPricePnl.toFixed(2)}, Funding P&L: $${totalFundPnl.toFixed(2)}, Combined: $${r.fullM.total.toFixed(2)}`);
    console.log(`  Avg funding P&L per trade: $${r.fullM.avgFundPnl.toFixed(4)}`);

    // Direction breakdown
    const longs = r.trades.filter(t => t.dir === "long");
    const shorts = r.trades.filter(t => t.dir === "short");
    const longPnl = longs.reduce((s, t) => s + t.totalPnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.totalPnl, 0);
    const longWr = longs.length > 0 ? longs.filter(t => t.totalPnl > 0).length / longs.length * 100 : 0;
    const shortWr = shorts.length > 0 ? shorts.filter(t => t.totalPnl > 0).length / shorts.length * 100 : 0;
    console.log(`  Longs: ${longs.length} trades, WR ${longWr.toFixed(1)}%, P&L $${longPnl.toFixed(2)}`);
    console.log(`  Shorts: ${shorts.length} trades, WR ${shortWr.toFixed(1)}%, P&L $${shortPnl.toFixed(2)}`);

    // Per-pair breakdown (top 5 and bottom 5)
    const pairPnl = new Map<string, number>();
    for (const t of r.trades) {
      pairPnl.set(t.pair, (pairPnl.get(t.pair) ?? 0) + t.totalPnl);
    }
    const sorted = [...pairPnl.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      console.log(`  Best pairs:  ${sorted.slice(0, 3).map(([p, v]) => `${p}=$${v.toFixed(1)}`).join(", ")}`);
      console.log(`  Worst pairs: ${sorted.slice(-3).map(([p, v]) => `${p}=$${v.toFixed(1)}`).join(", ")}`);
    }

    // Avg hold time
    const avgHold = r.trades.length > 0 ? r.trades.reduce((s, t) => s + (t.xt - t.et), 0) / r.trades.length / H : 0;
    console.log(`  Avg hold: ${avgHold.toFixed(1)}h`);
  }

  // Summary
  console.log("\n=== SUMMARY ===\n");
  console.log("Strategy                      OOS $/day   OOS Sharpe   Verdict");
  console.log("-".repeat(70));
  for (const r of allResults) {
    const o = r.oosM;
    let verdict = "SKIP";
    if (o.perDay > 0 && o.sharpe > 0.5 && o.pf > 1.2) verdict = "PROMISING";
    if (o.perDay > 0.5 && o.sharpe > 1.0 && o.pf > 1.5) verdict = "STRONG";
    if (o.perDay < 0) verdict = "UNPROFITABLE";
    console.log(
      `${r.name.padEnd(30)} ${("$" + o.perDay.toFixed(2)).padStart(9)}   ${o.sharpe.toFixed(2).padStart(10)}   ${verdict}`
    );
  }
}

main().catch(console.error);
