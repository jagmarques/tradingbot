/**
 * Carry + Momentum Strategy Validation (Engine D candidate)
 *
 * 6 tests:
 *   1. Bootstrap CI (300 runs): 5th pct PF > 1.0?
 *   2. Random Entry (100 runs): Actual PF percentile vs random
 *   3. Quarterly Stationarity: All quarters profitable?
 *   4. Direction Split: Longs AND shorts profitable?
 *   5. Parameter Sensitivity: lookback [3,7,14,21] x top [2,3,4]
 *   6. Combined 4-engine portfolio vs 3-engine
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-carry-validate.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const FUNDING_DIR = "/tmp/hl-funding";
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const DAY = 86_400_000;
const FEE = 0.000_35; // 0.035% taker per side
const SIZE = 5;
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};

const PAIRS = [
  "APT", "ARB", "DASH", "DOT", "ENA", "ETH", "LINK",
  "OP", "TRUMP", "UNI", "WIF", "WLD", "XRP",
];

const FULL_START = new Date("2024-03-01").getTime(); // 2-month warmup from funding start
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface FR { coin: string; fundingRate: string; premium: string; time: number; }
interface C { t: number; o: number; h: number; l: number; c: number; }
interface HBar { t: number; o: number; h: number; l: number; c: number; funding: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pricePnl: number; fundingPnl: number; totalPnl: number;
}
interface Stats {
  n: number; wr: number; pf: number; sharpe: number;
  pnl: number; perDay: number; maxDd: number; avgFundPnl: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function loadFunding(coin: string): FR[] {
  const fp = path.join(FUNDING_DIR, `${coin}_funding.json`);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateHourly(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const hTs = Math.floor(c.t / H) * H;
    const arr = groups.get(hTs) ?? [];
    arr.push(c);
    groups.set(hTs, arr);
  }
  const hourly: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 8) continue;
    hourly.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return hourly;
}

function aggregateDaily(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const dTs = Math.floor(c.t / DAY) * DAY;
    const arr = groups.get(dTs) ?? [];
    arr.push(c);
    groups.set(dTs, arr);
  }
  const daily: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 200) continue;
    daily.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return daily;
}

function aggregate4h(candles: C[]): C[] {
  const H4 = 4 * H;
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const bucket = Math.floor(c.t / H4) * H4;
    const arr = groups.get(bucket) ?? [];
    arr.push(c);
    groups.set(bucket, arr);
  }
  const result: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 40) continue;
    bars.sort((a, b) => a.t - b.t);
    result.push({
      t: ts, o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

function buildHourlyBars(pair: string, funding: FR[], candles: C[]): HBar[] {
  const hourly = aggregateHourly(candles);
  const fMap = new Map<number, number>();
  for (const f of funding) {
    const hTs = Math.floor(f.time / H) * H;
    fMap.set(hTs, parseFloat(f.fundingRate));
  }
  return hourly.map(c => ({ ...c, funding: fMap.get(c.t) ?? 0 }));
}

// ─── Carry + Momentum Strategy ─────────────────────────────────────
function simCarryMomentum(
  pairBars: Map<string, HBar[]>,
  dailyBars: Map<string, C[]>,
  startMs: number, endMs: number,
  pairs: string[],
  opts: { lookbackDays?: number; topN?: number; } = {},
): Trade[] {
  const LOOKBACK_D = opts.lookbackDays ?? 7;
  const TOP_N = opts.topN ?? 3;
  const REBAL_H = 7 * 24; // always hold 7 days
  const LOOKBACK_H = LOOKBACK_D * 24;

  const trades: Trade[] = [];

  // Index bars by timestamp per pair
  const pairBarMap = new Map<string, Map<number, HBar>>();
  for (const p of pairs) {
    const bars = pairBars.get(p);
    if (!bars) continue;
    const m = new Map<number, HBar>();
    for (const b of bars) m.set(b.t, b);
    pairBarMap.set(p, m);
  }

  // Get all unique hourly timestamps in range
  const allTimes = new Set<number>();
  for (const p of pairs) {
    const bars = pairBars.get(p);
    if (!bars) continue;
    for (const b of bars) {
      if (b.t >= startMs && b.t < endMs) allTimes.add(b.t);
    }
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b);
  if (sortedTimes.length === 0) return trades;

  // Get 7d price momentum
  function getMomentum(pair: string, t: number): number | null {
    const daily = dailyBars.get(pair);
    if (!daily) return null;
    const dayTs = Math.floor(t / DAY) * DAY;
    // Find closest daily bar to today and lookbackDays ago
    let todayBar: C | null = null;
    let pastBar: C | null = null;
    for (const d of daily) {
      if (Math.abs(d.t - dayTs) <= 2 * DAY) todayBar = d;
      if (Math.abs(d.t - (dayTs - LOOKBACK_D * DAY)) <= 2 * DAY) pastBar = d;
    }
    if (!todayBar || !pastBar) return null;
    return (todayBar.c / pastBar.c) - 1;
  }

  let nextRebal = startMs;
  const positions = new Map<string, { pair: string; dir: "long" | "short"; ep: number; et: number }>();

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
      const bars = pairBars.get(pos.pair) ?? [];
      for (const b of bars) {
        if (b.t >= pos.et && b.t < t) {
          // Shorts collect positive funding, longs pay positive funding
          if (pos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }

      const sp = SPREAD[pos.pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      trades.push({
        pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
        et: pos.et, xt: t, pricePnl, fundingPnl: fundPnl,
        totalPnl: pricePnl + fundPnl - cost,
      });
    }
    positions.clear();

    // Rank pairs by trailing avg funding
    const rankings: { pair: string; avgFunding: number }[] = [];
    for (const pair of pairs) {
      const bars = pairBars.get(pair);
      if (!bars) continue;
      let sum = 0, cnt = 0;
      for (const b of bars) {
        if (b.t >= t - LOOKBACK_H * H && b.t < t && b.funding !== 0) {
          sum += b.funding;
          cnt++;
        }
      }
      if (cnt < 20) continue; // need enough funding data
      rankings.push({ pair, avgFunding: sum / cnt });
    }
    rankings.sort((a, b) => b.avgFunding - a.avgFunding);

    // SHORT: highest funding + negative momentum (top N)
    let shortCount = 0;
    for (const { pair, avgFunding } of rankings) {
      if (shortCount >= TOP_N) break;
      if (avgFunding <= 0) break;
      const mom = getMomentum(pair, t);
      if (mom === null || mom >= 0) continue;
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      positions.set(pair + "_S", { pair, dir: "short", ep: bar.o, et: t });
      shortCount++;
    }

    // LONG: lowest/negative funding + positive momentum (bottom N)
    let longCount = 0;
    for (let i = rankings.length - 1; i >= 0; i--) {
      if (longCount >= TOP_N) break;
      const { pair, avgFunding } = rankings[i];
      if (avgFunding >= 0) break;
      const mom = getMomentum(pair, t);
      if (mom === null || mom <= 0) continue;
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      if (positions.has(pair + "_S")) continue;
      positions.set(pair + "_L", { pair, dir: "long", ep: bar.o, et: t });
      longCount++;
    }

    nextRebal = t + REBAL_H * H;
  }

  return trades;
}

// ─── Random Carry (same frequency, random pairs) ────────────────────
function simRandomCarry(
  pairBars: Map<string, HBar[]>,
  dailyBars: Map<string, C[]>,
  startMs: number, endMs: number,
  pairs: string[],
  topN: number,
): Trade[] {
  const REBAL_H = 7 * 24;
  const trades: Trade[] = [];

  const pairBarMap = new Map<string, Map<number, HBar>>();
  for (const p of pairs) {
    const bars = pairBars.get(p);
    if (!bars) continue;
    const m = new Map<number, HBar>();
    for (const b of bars) m.set(b.t, b);
    pairBarMap.set(p, m);
  }

  const allTimes = new Set<number>();
  for (const p of pairs) {
    const bars = pairBars.get(p);
    if (!bars) continue;
    for (const b of bars) {
      if (b.t >= startMs && b.t < endMs) allTimes.add(b.t);
    }
  }
  const sortedTimes = [...allTimes].sort((a, b) => a - b);

  let nextRebal = startMs;
  const positions = new Map<string, { pair: string; dir: "long" | "short"; ep: number; et: number }>();

  for (const t of sortedTimes) {
    if (t < nextRebal) continue;

    // Close
    for (const [, pos] of positions) {
      const bm = pairBarMap.get(pos.pair);
      if (!bm) continue;
      const bar = bm.get(t);
      if (!bar) continue;
      const xp = bar.o;
      const pricePnl = pos.dir === "long"
        ? (xp / pos.ep - 1) * NOT
        : (pos.ep / xp - 1) * NOT;
      let fundPnl = 0;
      const bars = pairBars.get(pos.pair) ?? [];
      for (const b of bars) {
        if (b.t >= pos.et && b.t < t) {
          if (pos.dir === "short") fundPnl += NOT * b.funding;
          else fundPnl -= NOT * b.funding;
        }
      }
      const sp = SPREAD[pos.pair] ?? 4e-4;
      const cost = NOT * FEE * 2 + NOT * sp * 2;
      trades.push({
        pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
        et: pos.et, xt: t, pricePnl, fundingPnl: fundPnl,
        totalPnl: pricePnl + fundPnl - cost,
      });
    }
    positions.clear();

    // Random selection: pick topN pairs for shorts and topN for longs
    const available = pairs.filter(p => pairBarMap.get(p)?.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);

    let count = 0;
    for (const pair of shuffled) {
      if (count >= topN * 2) break;
      const dir: "long" | "short" = count < topN ? "short" : "long";
      const bm = pairBarMap.get(pair);
      const bar = bm?.get(t);
      if (!bar) continue;
      if (positions.has(pair + "_S") || positions.has(pair + "_L")) continue;
      positions.set(pair + "_" + (dir === "short" ? "S" : "L"), { pair, dir, ep: bar.o, et: t });
      count++;
    }

    nextRebal = t + REBAL_H * H;
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
function calcStats(trades: Trade[], daySpan: number): Stats {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, pnl: 0, perDay: 0, maxDd: 0, avgFundPnl: 0 };

  const pnl = trades.reduce((s, t) => s + t.totalPnl, 0);
  const wins = trades.filter(t => t.totalPnl > 0);
  const losses = trades.filter(t => t.totalPnl <= 0);
  const wr = (wins.length / trades.length) * 100;
  const gw = wins.reduce((s, t) => s + t.totalPnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.totalPnl, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);

  let maxDd = 0, peak = 0, cum = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.totalPnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  const dailyMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.totalPnl);
  }
  const dr = Array.from(dailyMap.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const avgFundPnl = trades.reduce((s, t) => s + t.fundingPnl, 0) / trades.length;

  return { n: trades.length, wr, pf, sharpe, pnl, perDay: daySpan > 0 ? pnl / daySpan : 0, maxDd, avgFundPnl };
}

function statsFromPnls(pnls: number[]): { pf: number; sharpe: number; total: number; maxDd: number; wr: number } {
  if (pnls.length === 0) return { pf: 0, sharpe: 0, total: 0, maxDd: 0, wr: 0 };
  const total = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const gw = wins.reduce((s, p) => s + p, 0);
  const gl = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  const wr = (wins.length / pnls.length) * 100;
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
  }
  const mean = total / pnls.length;
  const sd = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  return { pf, sharpe, total, maxDd, wr };
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function rankPct(value: number, sorted: number[]): number {
  let count = 0;
  for (const v of sorted) { if (v < value) count++; }
  return (count / sorted.length) * 100;
}

function printStats(label: string, s: Stats): void {
  console.log(label);
  console.log(`  Trades: ${s.n}  WR: ${s.wr.toFixed(1)}%  PF: ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}`);
  console.log(`  PnL: ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}  $/day: ${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}  Sharpe: ${s.sharpe.toFixed(2)}  MaxDD: $${s.maxDd.toFixed(2)}`);
  console.log(`  Avg funding P&L/trade: ${s.avgFundPnl >= 0 ? "+" : ""}$${s.avgFundPnl.toFixed(4)}`);
}

function buildDailyPnl(trades: Trade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    m.set(day, (m.get(day) ?? 0) + t.totalPnl);
  }
  return m;
}

function correlation(mapA: Map<number, number>, mapB: Map<number, number>): number {
  const allDays = new Set<number>([...mapA.keys(), ...mapB.keys()]);
  const aVals: number[] = [];
  const bVals: number[] = [];
  for (const d of allDays) {
    aVals.push(mapA.get(d) ?? 0);
    bVals.push(mapB.get(d) ?? 0);
  }
  if (aVals.length < 2) return 0;
  const aMean = aVals.reduce((s, v) => s + v, 0) / aVals.length;
  const bMean = bVals.reduce((s, v) => s + v, 0) / bVals.length;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < aVals.length; i++) {
    const da = aVals[i] - aMean;
    const db = bVals[i] - bMean;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// ─── Proxy Engines for Portfolio Test ───────────────────────────────

// Engine A proxy: Donchian - SMA 30/60 cross daily, 15d exit, ATR*3 stop, $5
function calcSMAArr(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcATRManual(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
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

interface SimpleTrade { pair: string; dir: "long"|"short"; et: number; xt: number; pnl: number; }

function simDonchianProxy(
  dailyData: Map<string, C[]>, btcDaily: C[],
  startTs: number, endTs: number, pairs: string[],
): SimpleTrade[] {
  const ENTRY_LB = 30;
  const EXIT_LB = 15;
  const ATR_MULT = 3;
  const ATR_PER = 14;
  const MAX_HOLD = 60;
  const FAST = 30, SLOW = 60;
  const SL_SLIP = 1.5;

  const btcCloses = btcDaily.map(c => c.c);
  const btcFast = calcSMAArr(btcCloses, FAST);
  const btcSlow = calcSMAArr(btcCloses, SLOW);
  const btcTsMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTsMap.set(c.t, i));

  const trades: SimpleTrade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < SLOW + ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMAArr(closes, FAST);
    const slow = calcSMAArr(closes, SLOW);
    const atr = calcATRManual(cs, ATR_PER);
    const warmup = SLOW + 1;

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      const sp = SPREAD[pair] ?? 4e-4;

      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP); reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP); reason = "sl";
        }

        if (!xp && i >= EXIT_LB + 1) {
          if (pos.dir === "long") {
            const lo = donchLo(cs, i, EXIT_LB);
            if (bar.c < lo) { xp = bar.c * (1 - sp); reason = "ch"; }
          } else {
            const hi = donchHi(cs, i, EXIT_LB);
            if (bar.c > hi) { xp = bar.c * (1 + sp); reason = "ch"; }
          }
        }

        if (!xp && holdDays >= MAX_HOLD) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }

        if (xp > 0) {
          const fee = NOT * FEE * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, et: pos.et, xt: bar.t, pnl: raw - fee });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        let dir: "long"|"short"|null = null;
        if (fast[prev] <= slow[prev] && fast[i] > slow[i]) dir = "long";
        else if (fast[prev] >= slow[prev] && fast[i] < slow[i]) dir = "short";
        if (!dir) continue;

        if (dir === "long") {
          const btcI = btcTsMap.get(bar.t);
          if (btcI !== undefined && btcI > 0 && btcFast[btcI] <= btcSlow[btcI]) continue;
        }

        const prevATR = atr[i-1];
        if (prevATR <= 0) continue;
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep - ATR_MULT * prevATR : ep + ATR_MULT * prevATR;
        pos = { dir, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// Engine B proxy: Supertrend(14,2) on 4h, $5
function simSupertrendProxy(
  h4Data: Map<string, C[]>,
  startTs: number, endTs: number, pairs: string[],
): SimpleTrade[] {
  const ST_PERIOD = 14;
  const ST_MULT = 2;
  const ST_SL_PCT = 0.035;
  const ST_MAX_HOLD_BARS = 360; // ~60 days in 4h bars
  const SL_SLIP = 1.5;
  const trades: SimpleTrade[] = [];

  for (const pair of pairs) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_PERIOD + 30) continue;

    const atr = calcATRManual(cs, ST_PERIOD);
    const upperBand = new Array(cs.length).fill(0);
    const lowerBand = new Array(cs.length).fill(0);
    const stDir = new Array(cs.length).fill(1);

    for (let i = ST_PERIOD; i < cs.length; i++) {
      const mid = (cs[i].h + cs[i].l) / 2;
      const ub = mid + ST_MULT * atr[i];
      const lb = mid - ST_MULT * atr[i];

      upperBand[i] = i > ST_PERIOD && ub < upperBand[i-1] && cs[i-1].c > upperBand[i-1]
        ? upperBand[i-1] : ub;
      lowerBand[i] = i > ST_PERIOD && lb > lowerBand[i-1] && cs[i-1].c < lowerBand[i-1]
        ? lowerBand[i-1] : lb;

      if (i === ST_PERIOD) {
        stDir[i] = cs[i].c > upperBand[i] ? 1 : -1;
      } else {
        stDir[i] = stDir[i-1] === 1
          ? (cs[i].c < lowerBand[i] ? -1 : 1)
          : (cs[i].c > upperBand[i] ? 1 : -1);
      }
    }

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;
    const warmup = ST_PERIOD + 2;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];
      const sp = SPREAD[pair] ?? 4e-4;

      if (pos) {
        const barsHeld = i - Math.round((pos.et - cs[0].t) / (4 * H));
        let xp = 0;

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP);
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP);
        }

        if (!xp) {
          if (pos.dir === "long" && stDir[i] === -1 && stDir[i-1] === 1) {
            xp = bar.c * (1 - sp);
          } else if (pos.dir === "short" && stDir[i] === 1 && stDir[i-1] === -1) {
            xp = bar.c * (1 + sp);
          }
        }

        if (!xp && barsHeld >= ST_MAX_HOLD_BARS) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }

        if (xp > 0) {
          const fee = NOT * FEE * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, et: pos.et, xt: bar.t, pnl: raw - fee });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= startTs && bar.t < endTs) {
        let dir: "long"|"short"|null = null;
        if (stDir[i-1] === 1 && stDir[i-2] === -1) dir = "long";
        else if (stDir[i-1] === -1 && stDir[i-2] === 1) dir = "short";
        if (!dir) continue;

        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep * (1 - ST_SL_PCT) : ep * (1 + ST_SL_PCT);
        pos = { dir, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// Engine C proxy: GARCH v2 MTF - 1h z>4.5 + 4h z>3.0, $5
function computeZScores(candles: C[], momLb: number, volWin: number): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin + 1); j <= i; j++) {
      const r = candles[j].c / candles[j-1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function simGarchMTFProxy(
  h1Data: Map<string, C[]>,
  h4Data: Map<string, C[]>,
  startTs: number, endTs: number, pairs: string[],
): SimpleTrade[] {
  const Z_LONG_1H = 4.5, Z_SHORT_1H = -3.0;
  const Z_LONG_4H = 3.0, Z_SHORT_4H = -3.0;
  const SL_PCT = 0.04;
  const MAX_HOLD_H = 168;
  const MOM_LB = 3, VOL_WIN = 20;
  const SL_SLIP = 1.5;

  const trades: SimpleTrade[] = [];

  for (const pair of pairs) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || !h4 || h1.length < 200 || h4.length < 200) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: { dir: "long"|"short"; ep: number; et: number; sl: number } | null = null;

    for (let i = VOL_WIN + MOM_LB + 1; i < h1.length; i++) {
      const ts = h1[i].t;
      if (ts < startTs || ts >= endTs) continue;
      const sp = SPREAD[pair] ?? 4e-4;

      // Exit
      if (pos) {
        const bar = h1[i];
        let xp = 0;

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP);
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP);
        }

        if (!xp) {
          const barsHeld = Math.floor((ts - pos.et) / H);
          if (barsHeld >= MAX_HOLD_H) {
            xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          }
        }

        if (xp > 0) {
          const fee = NOT * FEE * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          trades.push({ pair, dir: pos.dir, et: pos.et, xt: ts, pnl: raw - fee });
          pos = null;
        }
      }

      // Entry
      if (!pos) {
        const prev = i - 1;
        if (prev < VOL_WIN + MOM_LB) continue;
        const zVal = z1h[prev];
        if (isNaN(zVal) || zVal === 0) continue;

        const goLong = zVal > Z_LONG_1H;
        const goShort = zVal < Z_SHORT_1H;
        if (!goLong && !goShort) continue;

        // 4h confirmation
        const H4 = 4 * H;
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
        const z4hVal = z4h[idx4h];
        if (goLong && z4hVal <= Z_LONG_4H) continue;
        if (goShort && z4hVal >= Z_SHORT_4H) continue;

        const bar = h1[i];
        const dir: "long"|"short" = goLong ? "long" : "short";
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
        pos = { dir, ep, et: ts, sl };
      }
    }
  }

  return trades;
}

// ─── Simple trade stats helper ──────────────────────────────────────
interface SimpleStats {
  n: number; wr: number; pf: number; sharpe: number;
  pnl: number; perDay: number; maxDd: number;
}

function calcSimpleStats(trades: SimpleTrade[], daySpan: number): SimpleStats {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, pnl: 0, perDay: 0, maxDd: 0 };
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr = (wins.length / trades.length) * 100;
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  let maxDd = 0, peak = 0, cum = 0;
  for (const t of [...trades].sort((a, b) => a.xt - b.xt)) {
    cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
  }
  const dailyMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.pnl);
  }
  const dr = Array.from(dailyMap.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
  return { n: trades.length, wr, pf, sharpe, pnl, perDay: daySpan > 0 ? pnl / daySpan : 0, maxDd };
}

function buildSimpleDailyPnl(trades: SimpleTrade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    m.set(day, (m.get(day) ?? 0) + t.pnl);
  }
  return m;
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

console.log("=".repeat(80));
console.log("  CARRY + MOMENTUM STRATEGY VALIDATION (Engine D candidate)");
console.log("  Weekly rebalance: short high-funding+neg-mom, long low-funding+pos-mom");
console.log("  Top 3 each side, 7d hold, $5 margin, 10x leverage");
console.log("  P&L = price change + cumulative funding payments");
console.log("=".repeat(80));

// ─── Load Data ──────────────────────────────────────────────────────
console.log("\nLoading data...");

const pairBars = new Map<string, HBar[]>();
const dailyBars = new Map<string, C[]>();
const h1Bars = new Map<string, C[]>();
const h4Bars = new Map<string, C[]>();

// Load all pairs including BTC for proxy engines
const allPairsToLoad = [...new Set([...PAIRS, "BTC", "ADA", "DOGE", "LDO", "SOL"])];

for (const p of allPairsToLoad) {
  const raw5m = load5m(p);
  if (raw5m.length === 0) { console.log(`  [SKIP] ${p} - no 5m data`); continue; }

  const hourly = aggregateHourly(raw5m);
  const daily = aggregateDaily(raw5m);
  const h4 = aggregate4h(raw5m);

  dailyBars.set(p, daily);
  h1Bars.set(p, hourly);
  h4Bars.set(p, h4);

  // Only build HBar (with funding) for carry pairs
  if (PAIRS.includes(p)) {
    const funding = loadFunding(p);
    if (funding.length === 0) { console.log(`  [SKIP] ${p} - no funding data`); continue; }
    const hBars = buildHourlyBars(p, funding, raw5m);
    pairBars.set(p, hBars);
    console.log(`  ${p}: ${hBars.length} hourly bars, ${funding.length} funding records`);
  }
}

const btcDaily = dailyBars.get("BTC");
if (!btcDaily) { console.error("BTC daily data missing."); process.exit(1); }

const availPairs = PAIRS.filter(p => pairBars.has(p));
console.log(`\nLoaded: ${availPairs.length} carry pairs, ${dailyBars.size} daily pairs`);

// ─── Baseline ───────────────────────────────────────────────────────
const fullDays = (END - FULL_START) / DAY;
const oosDays = (END - OOS_START) / DAY;

console.log("\n" + "=".repeat(80));
console.log("  BASELINE: Carry + Momentum");
console.log("=".repeat(80));

const fullTrades = simCarryMomentum(pairBars, dailyBars, FULL_START, END, availPairs);
const oosTrades = simCarryMomentum(pairBars, dailyBars, OOS_START, END, availPairs);

printStats(`\nFull Period (2024-03 to 2026-03, ${fullDays.toFixed(0)} days)`, calcStats(fullTrades, fullDays));
printStats(`\nOOS (2025-09 to 2026-03, ${oosDays.toFixed(0)} days)`, calcStats(oosTrades, oosDays));

const fullPnls = fullTrades.map(t => t.totalPnl);
const actualStats = calcStats(fullTrades, fullDays);
const oosStats = calcStats(oosTrades, oosDays);

let testsPassed = 0;
let totalTests = 0;

// ════════════════════════════════════════════════════════════════════
// TEST 1: BOOTSTRAP CI (300 runs)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 1: BOOTSTRAP CONFIDENCE INTERVALS (300 runs)");
console.log("  Resample trades with replacement. 5th pct PF > 1.0?");
console.log("=".repeat(80));
totalTests++;

const BS_ITERS = 300;
const bsPFs: number[] = [];
const bsSharpes: number[] = [];
const bsTotals: number[] = [];

for (let i = 0; i < BS_ITERS; i++) {
  const sample: number[] = [];
  for (let j = 0; j < fullPnls.length; j++) {
    sample.push(fullPnls[Math.floor(Math.random() * fullPnls.length)]);
  }
  const m = statsFromPnls(sample);
  bsPFs.push(m.pf);
  bsSharpes.push(m.sharpe);
  bsTotals.push(m.total);
}

bsPFs.sort((a, b) => a - b);
bsSharpes.sort((a, b) => a - b);
bsTotals.sort((a, b) => a - b);

console.log("\nMetric        5th pct    50th pct   95th pct");
console.log("-".repeat(55));
console.log(`PF            ${percentile(bsPFs, 5).toFixed(2).padStart(8)}  ${percentile(bsPFs, 50).toFixed(2).padStart(8)}  ${percentile(bsPFs, 95).toFixed(2).padStart(8)}`);
console.log(`Sharpe        ${percentile(bsSharpes, 5).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 50).toFixed(2).padStart(8)}  ${percentile(bsSharpes, 95).toFixed(2).padStart(8)}`);
console.log(`Total PnL     $${percentile(bsTotals, 5).toFixed(0).padStart(6)}  $${percentile(bsTotals, 50).toFixed(0).padStart(6)}  $${percentile(bsTotals, 95).toFixed(0).padStart(6)}`);

const pf5th = percentile(bsPFs, 5);
const bs1Verdict = pf5th > 1.0 ? "PASS" : pf5th > 0.8 ? "WARNING" : "FAIL";
console.log(`\n5th percentile PF: ${pf5th.toFixed(2)} -- ${pf5th > 1.0 ? "profitable even in worst-case bootstrap" : "NOT profitable in worst case"}`);
console.log(`95% CI for PF: [${percentile(bsPFs, 2.5).toFixed(2)}, ${percentile(bsPFs, 97.5).toFixed(2)}]`);
console.log(`Verdict: ${bs1Verdict}`);
if (bs1Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 2: RANDOM ENTRY (100 runs)
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 2: RANDOM ENTRY TEST (100 runs)");
console.log("  Same weekly rebalance, random pair selection. Actual PF percentile?");
console.log("=".repeat(80));
totalTests++;

const RAND_ITERS = 100;
const randPFs: number[] = [];
const randSharpes: number[] = [];
const randPnls: number[] = [];

for (let i = 0; i < RAND_ITERS; i++) {
  const rt = simRandomCarry(pairBars, dailyBars, FULL_START, END, availPairs, 3);
  const m = calcStats(rt, fullDays);
  randPFs.push(m.pf);
  randSharpes.push(m.sharpe);
  randPnls.push(m.pnl);
}

randPFs.sort((a, b) => a - b);
randSharpes.sort((a, b) => a - b);

const actualPFrank = rankPct(actualStats.pf, randPFs);
const actualShRank = rankPct(actualStats.sharpe, randSharpes);

console.log(`\nActual PF: ${actualStats.pf.toFixed(2)} | Percentile vs random: ${actualPFrank.toFixed(1)}%`);
console.log(`Actual Sharpe: ${actualStats.sharpe.toFixed(2)} | Percentile vs random: ${actualShRank.toFixed(1)}%`);
console.log(`Random PF dist: 5th=${percentile(randPFs, 5).toFixed(2)}, 50th=${percentile(randPFs, 50).toFixed(2)}, 95th=${percentile(randPFs, 95).toFixed(2)}`);
console.log(`Random PnL dist: 5th=$${percentile(randPnls.sort((a,b)=>a-b), 5).toFixed(0)}, 50th=$${percentile(randPnls, 50).toFixed(0)}, 95th=$${percentile(randPnls, 95).toFixed(0)}`);
console.log(`p-value (entry edge): ${((100 - actualPFrank) / 100).toFixed(3)}`);

const re2Verdict = actualPFrank >= 90 ? "PASS" : actualPFrank >= 75 ? "WARNING" : "FAIL";
console.log(`Verdict: ${re2Verdict}`);
if (re2Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 3: QUARTERLY STATIONARITY
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 3: QUARTERLY STATIONARITY");
console.log("  All quarters must be profitable.");
console.log("=".repeat(80));
totalTests++;

const sortedTrades = [...fullTrades].sort((a, b) => a.et - b.et);
const firstEntry = sortedTrades[0]?.et ?? FULL_START;
const lastExit = sortedTrades[sortedTrades.length - 1]?.xt ?? END;
const qLen = (lastExit - firstEntry) / 4;

console.log(`\n${"Quarter".padEnd(10)} ${"Period".padEnd(25)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Sharpe".padStart(7)} ${"PnL".padStart(10)} ${"$/day".padStart(8)}`);
console.log("-".repeat(85));

let stableQ = 0;
const qPFs: number[] = [];

for (let q = 0; q < 4; q++) {
  const qStart = firstEntry + q * qLen;
  const qEnd = firstEntry + (q + 1) * qLen;
  const qTrades = sortedTrades.filter(t => t.et >= qStart && t.et < qEnd);
  const qDays = qLen / DAY;
  const qS = calcStats(qTrades, qDays);
  qPFs.push(qS.pf);
  if (qS.pnl > 0) stableQ++;

  const startLabel = new Date(qStart).toISOString().slice(0, 10);
  const endLabel = new Date(qEnd).toISOString().slice(0, 10);
  const pfStr = qS.pf === Infinity ? "inf" : qS.pf.toFixed(2);
  console.log(`Q${q + 1}        ${(startLabel + " - " + endLabel).padEnd(25)} ${String(qS.n).padStart(7)} ${qS.wr.toFixed(1).padStart(6)} ${pfStr.padStart(6)} ${qS.sharpe.toFixed(2).padStart(7)} ${(qS.pnl >= 0 ? "+" : "") + "$" + qS.pnl.toFixed(2).padStart(8)} ${(qS.perDay >= 0 ? "+" : "") + "$" + qS.perDay.toFixed(2).padStart(6)}`);
}

const st3Verdict = stableQ === 4 ? "PASS" : stableQ >= 3 ? "WARNING" : "FAIL";
console.log(`\nProfitable quarters: ${stableQ}/4`);
console.log(`Verdict: ${st3Verdict}`);
if (st3Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 4: DIRECTION SPLIT
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 4: DIRECTION SPLIT");
console.log("  Longs AND shorts must both be profitable.");
console.log("=".repeat(80));
totalTests++;

const longTrades = fullTrades.filter(t => t.dir === "long");
const shortTrades = fullTrades.filter(t => t.dir === "short");

const longStats = calcStats(longTrades, fullDays);
const shortStats = calcStats(shortTrades, fullDays);

printStats("\nLONGS", longStats);
printStats("SHORTS", shortStats);

// Funding breakdown
const longFundTotal = longTrades.reduce((s, t) => s + t.fundingPnl, 0);
const shortFundTotal = shortTrades.reduce((s, t) => s + t.fundingPnl, 0);
const longPriceTotal = longTrades.reduce((s, t) => s + t.pricePnl, 0);
const shortPriceTotal = shortTrades.reduce((s, t) => s + t.pricePnl, 0);

console.log(`\nFunding breakdown:`);
console.log(`  Longs:  price=${longPriceTotal >= 0 ? "+" : ""}$${longPriceTotal.toFixed(2)}, funding=${longFundTotal >= 0 ? "+" : ""}$${longFundTotal.toFixed(2)}`);
console.log(`  Shorts: price=${shortPriceTotal >= 0 ? "+" : ""}$${shortPriceTotal.toFixed(2)}, funding=${shortFundTotal >= 0 ? "+" : ""}$${shortFundTotal.toFixed(2)}`);

const longProfit = longStats.pnl > 0;
const shortProfit = shortStats.pnl > 0;
const dir4Verdict = longProfit && shortProfit ? "PASS" : (longProfit || shortProfit) ? "WARNING" : "FAIL";
console.log(`\nLongs profitable: ${longProfit ? "YES" : "NO"} | Shorts profitable: ${shortProfit ? "YES" : "NO"}`);
console.log(`Verdict: ${dir4Verdict}`);
if (dir4Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 5: PARAMETER SENSITIVITY
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 5: PARAMETER SENSITIVITY");
console.log("  Lookback [3, 7, 14, 21 days] x Top [2, 3, 4 pairs]. Is 7d/3 robust?");
console.log("=".repeat(80));
totalTests++;

const lookbacks = [3, 7, 14, 21];
const tops = [2, 3, 4];

console.log(`\n${"LB\\Top".padEnd(8)} ${tops.map(n => `top=${n}`.padStart(18)).join("")}`);
console.log("-".repeat(8 + tops.length * 18));

let neighborsProfitable = 0;
let neighborsTotal = 0;

for (const lb of lookbacks) {
  const row: string[] = [];
  for (const top of tops) {
    neighborsTotal++;
    const trades = simCarryMomentum(pairBars, dailyBars, FULL_START, END, availPairs, { lookbackDays: lb, topN: top });
    const s = calcStats(trades, fullDays);
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(0)}` : `-$${Math.abs(s.pnl).toFixed(0)}`;
    const pfStr = s.pf === Infinity ? "inf" : s.pf.toFixed(2);
    row.push(`${pnlStr} PF=${pfStr}`.padStart(18));
    if (s.pnl > 0) neighborsProfitable++;
  }
  console.log(`${lb}d      ${row.join("")}`);
}

const pn5Pct = (neighborsProfitable / neighborsTotal) * 100;
const pn5Verdict = pn5Pct >= 75 ? "PASS" : pn5Pct >= 50 ? "WARNING" : "FAIL";
console.log(`\nProfitable combos: ${neighborsProfitable}/${neighborsTotal} (${pn5Pct.toFixed(0)}%)`);
console.log(`Verdict: ${pn5Verdict}`);
if (pn5Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// TEST 6: COMBINED 4-ENGINE PORTFOLIO
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  TEST 6: COMBINED 4-ENGINE PORTFOLIO");
console.log("  Donchian + Supertrend + GARCH v2 MTF + Carry");
console.log("  Compare 3-engine (no carry) vs 4-engine (with carry)");
console.log("=".repeat(80));
totalTests++;

// All pairs for proxy engines
const proxyPairs = [...new Set([...PAIRS, "ADA", "DOGE", "LDO", "SOL"])].filter(p => dailyBars.has(p));

console.log("\nRunning proxy engines...");

// Engine A: Donchian
const donchTrades = simDonchianProxy(dailyBars, btcDaily, OOS_START, END, proxyPairs);
const donchStats = calcSimpleStats(donchTrades, oosDays);
console.log(`  Donchian:     ${donchStats.n} trades, PF=${donchStats.pf === Infinity ? "inf" : donchStats.pf.toFixed(2)}, $${donchStats.perDay.toFixed(2)}/day`);

// Engine B: Supertrend
const stTrades = simSupertrendProxy(h4Bars, OOS_START, END, proxyPairs);
const stStats = calcSimpleStats(stTrades, oosDays);
console.log(`  Supertrend:   ${stStats.n} trades, PF=${stStats.pf === Infinity ? "inf" : stStats.pf.toFixed(2)}, $${stStats.perDay.toFixed(2)}/day`);

// Engine C: GARCH v2 MTF
const garchPairs = proxyPairs.filter(p => h1Bars.has(p) && h4Bars.has(p));
const garchTrades = simGarchMTFProxy(h1Bars, h4Bars, OOS_START, END, garchPairs);
const garchStats = calcSimpleStats(garchTrades, oosDays);
console.log(`  GARCH v2 MTF: ${garchStats.n} trades, PF=${garchStats.pf === Infinity ? "inf" : garchStats.pf.toFixed(2)}, $${garchStats.perDay.toFixed(2)}/day`);

// Engine D: Carry (OOS only)
const carryOOS = calcStats(oosTrades, oosDays);
console.log(`  Carry+Mom:    ${carryOOS.n} trades, PF=${carryOOS.pf === Infinity ? "inf" : carryOOS.pf.toFixed(2)}, $${carryOOS.perDay.toFixed(2)}/day`);

// Combine: 3-engine (A+B+C)
const combo3: { pnl: number; day: number }[] = [];
const combo4: { pnl: number; day: number }[] = [];

const donchDaily = buildSimpleDailyPnl(donchTrades);
const stDaily = buildSimpleDailyPnl(stTrades);
const garchDaily = buildSimpleDailyPnl(garchTrades);
const carryDaily = buildDailyPnl(oosTrades);

const allDays = new Set<number>([
  ...donchDaily.keys(), ...stDaily.keys(), ...garchDaily.keys(), ...carryDaily.keys(),
]);

for (const d of allDays) {
  const dPnl = (donchDaily.get(d) ?? 0) + (stDaily.get(d) ?? 0) + (garchDaily.get(d) ?? 0);
  combo3.push({ pnl: dPnl, day: d });
  combo4.push({ pnl: dPnl + (carryDaily.get(d) ?? 0), day: d });
}

combo3.sort((a, b) => a.day - b.day);
combo4.sort((a, b) => a.day - b.day);

function portfolioStats(dailyPnls: { pnl: number; day: number }[]): SimpleStats {
  if (dailyPnls.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, pnl: 0, perDay: 0, maxDd: 0 };
  const pnls = dailyPnls.map(d => d.pnl);
  const total = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const gw = wins.reduce((s, p) => s + p, 0);
  const gl = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  const wr = (wins.length / pnls.length) * 100;
  let maxDd = 0, peak = 0, cum = 0;
  for (const p of pnls) {
    cum += p; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
  }
  const mean = total / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / Math.max(pnls.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const days = dailyPnls.length;
  return { n: days, wr, pf, sharpe, pnl: total, perDay: total / Math.max(days, 1), maxDd };
}

const stats3 = portfolioStats(combo3);
const stats4 = portfolioStats(combo4);

console.log(`\n${"Portfolio".padEnd(20)} ${"Days".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"Sharpe".padStart(7)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MaxDD".padStart(8)}`);
console.log("-".repeat(75));

function printPortRow(label: string, s: SimpleStats): void {
  const pfStr = s.pf === Infinity ? "inf" : s.pf.toFixed(2);
  console.log(`${label.padEnd(20)} ${String(s.n).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${pfStr.padStart(6)} ${s.sharpe.toFixed(2).padStart(7)} ${(s.pnl >= 0 ? "+" : "") + "$" + s.pnl.toFixed(2).padStart(8)} ${(s.perDay >= 0 ? "+" : "") + "$" + s.perDay.toFixed(2).padStart(6)} $${s.maxDd.toFixed(2).padStart(6)}`);
}

printPortRow("3-engine (A+B+C)", stats3);
printPortRow("4-engine (+Carry)", stats4);

// Correlations between engines (OOS)
const corrDC = correlation(donchDaily, carryDaily);
const corrSC = correlation(stDaily, carryDaily);
const corrGC = correlation(garchDaily, carryDaily);
const corrDS = correlation(donchDaily, stDaily);
const corrDG = correlation(donchDaily, garchDaily);
const corrSG = correlation(stDaily, garchDaily);

console.log(`\nDaily PnL Correlation Matrix (OOS):`);
console.log(`  Donch-ST:     ${corrDS.toFixed(3)}`);
console.log(`  Donch-GARCH:  ${corrDG.toFixed(3)}`);
console.log(`  ST-GARCH:     ${corrSG.toFixed(3)}`);
console.log(`  Donch-Carry:  ${corrDC.toFixed(3)}`);
console.log(`  ST-Carry:     ${corrSC.toFixed(3)}`);
console.log(`  GARCH-Carry:  ${corrGC.toFixed(3)}`);

const sharpeImproved = stats4.sharpe > stats3.sharpe;
const ddImproved = stats4.maxDd <= stats3.maxDd * 1.1; // allow 10% DD increase
const pnlImproved = stats4.pnl > stats3.pnl;
const lowCorrCarry = Math.abs(corrDC) < 0.3 && Math.abs(corrSC) < 0.3 && Math.abs(corrGC) < 0.3;

console.log(`\nSharpe improved: ${sharpeImproved ? "YES" : "NO"} (${stats3.sharpe.toFixed(2)} -> ${stats4.sharpe.toFixed(2)})`);
console.log(`MaxDD acceptable: ${ddImproved ? "YES" : "NO"} ($${stats3.maxDd.toFixed(2)} -> $${stats4.maxDd.toFixed(2)})`);
console.log(`PnL improved: ${pnlImproved ? "YES" : "NO"} ($${stats3.pnl.toFixed(2)} -> $${stats4.pnl.toFixed(2)})`);
console.log(`Low correlation: ${lowCorrCarry ? "YES" : "NO"}`);

const port6Verdict = (pnlImproved && (sharpeImproved || lowCorrCarry)) ? "PASS"
  : pnlImproved ? "WARNING" : "FAIL";
console.log(`Verdict: ${port6Verdict}`);
if (port6Verdict === "PASS") testsPassed++;

// ════════════════════════════════════════════════════════════════════
// FINAL VERDICT
// ════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(80));
console.log("  FINAL VERDICT");
console.log("=".repeat(80));

const verdicts = [
  { name: "Bootstrap CI (300 runs)", result: bs1Verdict },
  { name: "Random Entry (100 runs)", result: re2Verdict },
  { name: "Quarterly Stationarity", result: st3Verdict },
  { name: "Direction Split", result: dir4Verdict },
  { name: "Parameter Sensitivity", result: pn5Verdict },
  { name: "4-Engine Portfolio", result: port6Verdict },
];

console.log("");
for (const v of verdicts) {
  console.log(`  ${v.result.padEnd(8)} ${v.name}`);
}

const passed = verdicts.filter(v => v.result === "PASS").length;
const warned = verdicts.filter(v => v.result === "WARNING").length;
const failed = verdicts.filter(v => v.result === "FAIL").length;

console.log(`\nPASS: ${passed}  WARNING: ${warned}  FAIL: ${failed}`);
console.log(`OOS: $${oosStats.perDay.toFixed(2)}/day, Sharpe ${oosStats.sharpe.toFixed(2)}, PF ${oosStats.pf.toFixed(2)}, WR ${oosStats.wr.toFixed(1)}%, MaxDD $${oosStats.maxDd.toFixed(2)}`);

const deploy = passed >= 4 && failed === 0;
console.log(`\nDEPLOY AS ENGINE D: ${deploy ? "YES" : "NO"}`);
if (!deploy) {
  console.log("Reason: " + (failed > 0 ? `${failed} test(s) failed` : `Only ${passed} tests passed (need 4+)`));
}
