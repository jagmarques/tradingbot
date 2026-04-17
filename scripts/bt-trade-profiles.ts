/**
 * Trade Profile Analysis - Do different trade types need different exits?
 *
 * Generates Donchian (daily) + Supertrend (4h) trades using live config,
 * then classifies each trade by entry strength, hold duration, pair volatility,
 * direction, and time-since-peak to find exit optimizations.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-trade-profiles.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 5;
const SL_SLIP = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, BTC: 0.5e-4, TIA: 3.8e-4,
};

const TRADE_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI",
];

const HIGH_VOL_PAIRS = ["TRUMP","WIF","DOGE"];
const LOW_VOL_PAIRS = ["XRP","ADA","LINK"];
const MED_VOL_PAIRS = TRADE_PAIRS.filter(p => !HIGH_VOL_PAIRS.includes(p) && !LOW_VOL_PAIRS.includes(p));

const START = new Date("2023-06-01").getTime();
const END = new Date("2026-03-23").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface DetailedTrade {
  pair: string;
  engine: string;
  dir: Dir;
  ep: number;
  xp: number;
  et: number;
  xt: number;
  pnl: number;
  pnlPct: number;
  peakPct: number;        // max favorable excursion %
  troughPct: number;      // max adverse excursion %
  givebackPct: number;    // peak - exit
  holdBars: number;       // 5m bars
  holdDays: number;
  timeToPeakBars: number; // bars from entry to peak
  timeFromPeakBars: number; // bars from peak to exit
  barsNoNewHigh: number;  // longest streak of bars without new high before exit
  entryVolRatio: number;  // volume at entry vs 20-bar avg
  entrySmaGap: number;    // SMA gap at entry (for Donchian)
  entryMomentum: number;  // 20-bar return at entry
  entryAtr: number;       // ATR at entry (normalized)
  btcBullish: boolean;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; vol += c.v; }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function sma(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function emaCalc(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i === 0) { v = vals[i]; } else { v = vals[i] * k + v * (1 - k); }
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function atrCalc(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) { val += trs[i]; if (i === period - 1) { val /= period; r[i] = val; } }
    else { val = (val * (period - 1) + trs[i]) / period; r[i] = val; }
  }
  return r;
}

function donchianHigh(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, closes[j]);
    r[i] = mx;
  }
  return r;
}

function donchianLow(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, closes[j]);
    r[i] = mn;
  }
  return r;
}

function supertrendCalc(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrCalc(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;
  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;
    if (i > 0 && atrVals[i - 1] !== null) {
      if (lb <= lowerBand && bars[i - 1].c >= lowerBand) lb = lowerBand;
      if (ub >= upperBand && bars[i - 1].c <= upperBand) ub = upperBand;
    }
    let t: 1 | -1;
    if (prevTrend === 1) { t = bars[i].c < lowerBand ? -1 : 1; }
    else { t = bars[i].c > upperBand ? 1 : -1; }
    upperBand = ub; lowerBand = lb; prevTrend = t; trend[i] = t;
  }
  return { trend };
}

function sp(pair: string): number { return SPREAD[pair] ?? 4e-4; }

// ─── Load Data ──────────────────────────────────────────────────────
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of [...TRADE_PAIRS, "BTC"]) {
  const d = load5m(p);
  if (d.length > 0) raw5m.set(p, d);
  else console.log("  MISSING:", p);
}

// Aggregate
const dailyData = new Map<string, Bar[]>();
const h4Data = new Map<string, Bar[]>();
const m5Map = new Map<string, Map<number, number>>(); // 5m timestamp -> index

for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, DAY));
  h4Data.set(p, aggregate(bars, H4));
  const m = new Map<number, number>();
  bars.forEach((b, i) => m.set(b.t, i));
  m5Map.set(p, m);
}

// BTC daily EMA 20/50 for filter
const btcDaily = dailyData.get("BTC")!;
const btcEma20 = emaCalc(btcDaily.map(b => b.c), 20);
const btcEma50 = emaCalc(btcDaily.map(b => b.c), 50);
const btcDailyMap = new Map(btcDaily.map((b, i) => [b.t, i]));

function btcBullish(t: number): boolean {
  const dayT = Math.floor(t / DAY) * DAY;
  for (let dt = DAY; dt <= 5 * DAY; dt += DAY) {
    const idx = btcDailyMap.get(dayT - dt);
    if (idx !== undefined) {
      const e20 = btcEma20[idx], e50 = btcEma50[idx];
      return e20 !== null && e50 !== null && e20 > e50;
    }
  }
  return false;
}

// BTC 1h EMA for regime
const btcH1 = aggregate(raw5m.get("BTC")!, H1);
const btcH1Ema9 = emaCalc(btcH1.map(b => b.c), 9);
const btcH1Ema21 = emaCalc(btcH1.map(b => b.c), 21);

// Pre-compute indicators
interface PairIndicators {
  // Daily
  sma30: (number | null)[];
  sma60: (number | null)[];
  donLo15: (number | null)[];
  atrDaily: (number | null)[];
  dailyBars: Bar[];
  dailyMap: Map<number, number>;
  // 4h
  stTrend: (1 | -1 | null)[];
  atr4h: (number | null)[];
  h4Bars: Bar[];
  h4Map: Map<number, number>;
  // 5m
  m5Bars: C[];
}

const indicators = new Map<string, PairIndicators>();
for (const p of TRADE_PAIRS) {
  const daily = dailyData.get(p);
  const h4 = h4Data.get(p);
  const m5 = raw5m.get(p);
  if (!daily || !h4 || !m5 || daily.length < 70) continue;

  const dc = daily.map(b => b.c);
  indicators.set(p, {
    sma30: sma(dc, 30),
    sma60: sma(dc, 60),
    donLo15: donchianLow(dc, 15),
    atrDaily: atrCalc(daily, 14),
    dailyBars: daily,
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
    stTrend: supertrendCalc(h4, 14, 2).trend,
    atr4h: atrCalc(h4, 14),
    h4Bars: h4,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    m5Bars: m5,
  });
}

console.log(`Loaded ${indicators.size} pairs\n`);

// ─── Helper: trace trade path on 5m bars ────────────────────────────
function traceTrade(
  pair: string, dir: Dir, ep: number, et: number, sl: number,
  exitFn: (bar: C, idx: number, barsHeld: number, peakPrice: number) => boolean,
  engine: string
): DetailedTrade | null {
  const m5 = raw5m.get(pair);
  if (!m5) return null;
  const m5m = m5Map.get(pair)!;

  // Find entry bar index
  let startIdx = -1;
  for (let i = 0; i < m5.length; i++) {
    if (m5[i].t >= et) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;

  let peakPrice = ep;
  let troughPrice = ep;
  let peakIdx = startIdx;
  let barsNoNewHigh = 0;
  let maxBarsNoNewHigh = 0;
  let xp = 0;
  let xt = 0;
  let exitIdx = startIdx;

  // Walk 5m bars
  for (let i = startIdx; i < m5.length && i < startIdx + 288 * 90; i++) { // max ~90 days
    const bar = m5[i];
    const barsHeld = i - startIdx;

    // Update peak/trough
    if (dir === "long") {
      if (bar.h > peakPrice) { peakPrice = bar.h; peakIdx = i; barsNoNewHigh = 0; }
      else { barsNoNewHigh++; }
      if (bar.l < troughPrice) troughPrice = bar.l;
    } else {
      if (bar.l < peakPrice) { peakPrice = bar.l; peakIdx = i; barsNoNewHigh = 0; }
      else { barsNoNewHigh++; }
      if (bar.h > troughPrice) troughPrice = bar.h;
    }
    maxBarsNoNewHigh = Math.max(maxBarsNoNewHigh, barsNoNewHigh);

    // Check SL
    if (dir === "long" && bar.l <= sl) {
      xp = sl * (1 - sp(pair) * SL_SLIP);
      xt = bar.t; exitIdx = i; break;
    }
    if (dir === "short" && bar.h >= sl) {
      xp = sl * (1 + sp(pair) * SL_SLIP);
      xt = bar.t; exitIdx = i; break;
    }

    // Check engine-specific exit
    if (exitFn(bar, i, barsHeld, peakPrice)) {
      xp = dir === "long" ? bar.c * (1 - sp(pair)) : bar.c * (1 + sp(pair));
      xt = bar.t; exitIdx = i; break;
    }

    // Max hold 60 days
    if (bar.t - et >= 60 * DAY) {
      xp = dir === "long" ? bar.c * (1 - sp(pair)) : bar.c * (1 + sp(pair));
      xt = bar.t; exitIdx = i; break;
    }
  }

  if (xp === 0) return null; // never exited

  const notional = MARGIN * LEV;
  const rawPnl = dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional;
  const pnl = rawPnl - notional * FEE * 2;
  const pnlPct = dir === "long" ? (xp / ep - 1) * 100 : (ep / xp - 1) * 100;

  const peakPct = dir === "long"
    ? (peakPrice / ep - 1) * 100
    : (ep / peakPrice - 1) * 100;

  const troughPct = dir === "long"
    ? (ep / troughPrice - 1) * 100
    : (troughPrice / ep - 1) * 100;

  const givebackPct = peakPct - pnlPct;

  // Entry metrics (from 5m bars before entry)
  let entryVolRatio = 1;
  let entryMomentum = 0;
  if (startIdx >= 20) {
    let volSum = 0;
    for (let j = startIdx - 20; j < startIdx; j++) volSum += m5[j].v;
    const avgVol = volSum / 20;
    if (avgVol > 0) entryVolRatio = m5[startIdx].v / avgVol;
    entryMomentum = (m5[startIdx].c / m5[startIdx - 20].c - 1) * 100;
  }

  // SMA gap at entry (daily)
  const ind = indicators.get(pair);
  let entrySmaGap = 0;
  let entryAtr = 0;
  if (ind) {
    const dayT = Math.floor(et / DAY) * DAY;
    const di = ind.dailyMap.get(dayT);
    if (di !== undefined && di > 0) {
      const s30 = ind.sma30[di - 1], s60 = ind.sma60[di - 1];
      if (s30 !== null && s60 !== null && s60 > 0) entrySmaGap = ((s30 - s60) / s60) * 100;
      const a = ind.atrDaily[di - 1];
      if (a !== null && ep > 0) entryAtr = a / ep * 100;
    }
  }

  return {
    pair, engine, dir, ep, xp, et, xt, pnl, pnlPct, peakPct, troughPct,
    givebackPct, holdBars: exitIdx - startIdx,
    holdDays: (xt - et) / DAY,
    timeToPeakBars: peakIdx - startIdx,
    timeFromPeakBars: exitIdx - peakIdx,
    barsNoNewHigh: maxBarsNoNewHigh,
    entryVolRatio, entrySmaGap, entryMomentum, entryAtr,
    btcBullish: btcBullish(et),
  };
}

// ─── Generate Donchian Trades (Engine A) ────────────────────────────
console.log("Generating Engine A (Daily Donchian) trades...");
const allTrades: DetailedTrade[] = [];

for (const pair of TRADE_PAIRS) {
  const ind = indicators.get(pair);
  if (!ind) continue;
  const daily = ind.dailyBars;

  for (let i = 61; i < daily.length; i++) {
    if (daily[i].t < START || daily[i].t >= END) continue;
    const atrV = ind.atrDaily[i - 1];
    if (atrV === null || atrV <= 0) continue;

    const s30now = ind.sma30[i - 1], s60now = ind.sma60[i - 1];
    const s30prev = ind.sma30[i - 2], s60prev = ind.sma60[i - 2];
    if (s30now === null || s60now === null || s30prev === null || s60prev === null) continue;

    let dir: Dir | null = null;
    // Golden cross: SMA30 crosses above SMA60
    if (s30prev <= s60prev && s30now > s60now) {
      if (btcBullish(daily[i].t)) dir = "long";
    }
    // Death cross (shorts always allowed)
    if (s30prev >= s60prev && s30now < s60now) {
      dir = "short";
    }
    if (!dir) continue;

    const ep = dir === "long"
      ? daily[i].o * (1 + sp(pair))
      : daily[i].o * (1 - sp(pair));
    const slDist = Math.min(atrV * 3, ep * 0.035); // capped at 3.5%
    const sl = dir === "long" ? ep - slDist : ep + slDist;

    // Donchian exit function: check if close breaks 15-day channel
    const exitFn = (bar: C, idx: number, barsHeld: number): boolean => {
      // Only check at daily boundaries (every 288 5m bars)
      const barDayT = Math.floor(bar.t / DAY) * DAY;
      const di2 = ind.dailyMap.get(barDayT);
      if (di2 === undefined || di2 < 16) return false;

      // Only check at end of day (within last 5m bar of the day)
      if (bar.t % DAY > DAY - M5 * 2) {
        // Use current day's close to check against Donchian
        const dailyBar = ind.dailyBars[di2];
        const donLo = ind.donLo15[di2];
        if (dir === "long" && donLo !== null && dailyBar.c < donLo) return true;

        // For shorts, compute donchian high on closes
        if (dir === "short") {
          let mx = -Infinity;
          for (let j = Math.max(0, di2 - 15); j < di2; j++) mx = Math.max(mx, ind.dailyBars[j].c);
          if (dailyBar.c > mx) return true;
        }
      }
      return false;
    };

    const trade = traceTrade(pair, dir, ep, daily[i].t, sl, exitFn, "Donchian");
    if (trade) allTrades.push(trade);
  }
}

console.log(`  Donchian trades: ${allTrades.length}`);

// ─── Generate Supertrend Trades (Engine B) ──────────────────────────
console.log("Generating Engine B (4h Supertrend) trades...");
const stCountBefore = allTrades.length;

for (const pair of TRADE_PAIRS) {
  const ind = indicators.get(pair);
  if (!ind) continue;
  const h4 = ind.h4Bars;

  for (let i = 16; i < h4.length; i++) {
    if (h4[i].t < START || h4[i].t >= END) continue;
    const prevTrend = ind.stTrend[i - 1];
    const curTrend = ind.stTrend[i];
    if (prevTrend === null || curTrend === null || prevTrend === curTrend) continue;

    // Supertrend flip
    let dir: Dir | null = null;
    if (curTrend === 1 && prevTrend === -1) {
      if (btcBullish(h4[i].t)) dir = "long";
    }
    if (curTrend === -1 && prevTrend === 1) {
      dir = "short";
    }
    if (!dir) continue;

    const atrV = ind.atr4h[i - 1];
    if (atrV === null || atrV <= 0) continue;

    const ep = dir === "long"
      ? h4[i].o * (1 + sp(pair))
      : h4[i].o * (1 - sp(pair));
    const slDist = Math.min(atrV * 3, ep * 0.035);
    const sl = dir === "long" ? ep - slDist : ep + slDist;

    // Supertrend exit: flip back
    const exitFn = (bar: C, idx: number, barsHeld: number): boolean => {
      // Check at 4h boundaries
      const h4T = Math.floor(bar.t / H4) * H4;
      const h4i = ind.h4Map.get(h4T);
      if (h4i === undefined || h4i < 1) return false;

      // Only check at 4h boundary close
      if (bar.t % H4 > H4 - M5 * 2) {
        const curST = ind.stTrend[h4i];
        if (dir === "long" && curST === -1) return true;
        if (dir === "short" && curST === 1) return true;
      }
      return false;
    };

    const trade = traceTrade(pair, dir, ep, h4[i].t, sl, exitFn, "Supertrend");
    if (trade) allTrades.push(trade);
  }
}

console.log(`  Supertrend trades: ${allTrades.length - stCountBefore}`);
console.log(`  Total trades: ${allTrades.length}\n`);

// ─── Analysis Functions ─────────────────────────────────────────────
interface GroupStats {
  name: string;
  count: number;
  avgGiveback: number;
  avgPeak: number;
  avgPnl: number;
  avgPnlPct: number;
  winRate: number;
  avgHoldDays: number;
  avgTimeToPeakBars: number;
  avgTimeFromPeakBars: number;
  avgBarsNoNewHigh: number;
  totalPnl: number;
  medianGiveback: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeStats(name: string, trades: DetailedTrade[]): GroupStats {
  if (trades.length === 0) return {
    name, count: 0, avgGiveback: 0, avgPeak: 0, avgPnl: 0, avgPnlPct: 0,
    winRate: 0, avgHoldDays: 0, avgTimeToPeakBars: 0, avgTimeFromPeakBars: 0,
    avgBarsNoNewHigh: 0, totalPnl: 0, medianGiveback: 0,
  };
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  return {
    name, count: n,
    avgGiveback: trades.reduce((s, t) => s + t.givebackPct, 0) / n,
    medianGiveback: median(trades.map(t => t.givebackPct)),
    avgPeak: trades.reduce((s, t) => s + t.peakPct, 0) / n,
    avgPnl: trades.reduce((s, t) => s + t.pnl, 0) / n,
    avgPnlPct: trades.reduce((s, t) => s + t.pnlPct, 0) / n,
    winRate: wins / n * 100,
    avgHoldDays: trades.reduce((s, t) => s + t.holdDays, 0) / n,
    avgTimeToPeakBars: trades.reduce((s, t) => s + t.timeToPeakBars, 0) / n,
    avgTimeFromPeakBars: trades.reduce((s, t) => s + t.timeFromPeakBars, 0) / n,
    avgBarsNoNewHigh: trades.reduce((s, t) => s + t.barsNoNewHigh, 0) / n,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
  };
}

function printStats(stats: GroupStats[]) {
  console.log("Category                  N   AvgPeak%  AvgGiveback%  MedGiveback%  AvgPnl%  WR%    AvgHoldD  AvgBarsNoHigh  $Total");
  console.log("-".repeat(120));
  for (const s of stats) {
    if (s.count === 0) continue;
    console.log(
      `${s.name.padEnd(24)} ${String(s.count).padStart(4)}  ` +
      `${s.avgPeak.toFixed(2).padStart(9)}  ${s.avgGiveback.toFixed(2).padStart(12)}  ${s.medianGiveback.toFixed(2).padStart(12)}  ` +
      `${s.avgPnlPct.toFixed(2).padStart(7)}  ${s.winRate.toFixed(1).padStart(5)}  ` +
      `${s.avgHoldDays.toFixed(1).padStart(8)}  ${s.avgBarsNoNewHigh.toFixed(0).padStart(13)}  ` +
      `${(s.totalPnl >= 0 ? "+" : "")}$${s.totalPnl.toFixed(0)}`
    );
  }
}

// ─── 1. ENTRY STRENGTH ─────────────────────────────────────────────
console.log("=".repeat(120));
console.log("1. CLASSIFICATION BY ENTRY STRENGTH");
console.log("=".repeat(120));

// Score each trade's entry strength (composite of volume, SMA gap, momentum)
const volThresh = [...allTrades].sort((a, b) => a.entryVolRatio - b.entryVolRatio);
const vol33 = volThresh[Math.floor(volThresh.length * 0.33)]?.entryVolRatio ?? 1;
const vol66 = volThresh[Math.floor(volThresh.length * 0.66)]?.entryVolRatio ?? 1.5;

const momThresh = [...allTrades].sort((a, b) => Math.abs(a.entryMomentum) - Math.abs(b.entryMomentum));
const mom33 = Math.abs(momThresh[Math.floor(momThresh.length * 0.33)]?.entryMomentum ?? 0);
const mom66 = Math.abs(momThresh[Math.floor(momThresh.length * 0.66)]?.entryMomentum ?? 0);

const smaThresh = [...allTrades].sort((a, b) => Math.abs(a.entrySmaGap) - Math.abs(b.entrySmaGap));
const sma33 = Math.abs(smaThresh[Math.floor(smaThresh.length * 0.33)]?.entrySmaGap ?? 0);
const sma66 = Math.abs(smaThresh[Math.floor(smaThresh.length * 0.66)]?.entrySmaGap ?? 0);

function entryStrength(t: DetailedTrade): "strong" | "medium" | "weak" {
  let score = 0;
  if (t.entryVolRatio > vol66) score++; else if (t.entryVolRatio < vol33) score--;
  if (Math.abs(t.entryMomentum) > mom66) score++; else if (Math.abs(t.entryMomentum) < mom33) score--;
  if (Math.abs(t.entrySmaGap) > sma66) score++; else if (Math.abs(t.entrySmaGap) < sma33) score--;
  return score >= 2 ? "strong" : score <= -1 ? "weak" : "medium";
}

const strongEntries = allTrades.filter(t => entryStrength(t) === "strong");
const medEntries = allTrades.filter(t => entryStrength(t) === "medium");
const weakEntries = allTrades.filter(t => entryStrength(t) === "weak");

printStats([
  computeStats("Strong entries", strongEntries),
  computeStats("Medium entries", medEntries),
  computeStats("Weak entries", weakEntries),
]);

// Also break out by volume alone
console.log("\n  Sub-analysis: by volume ratio alone");
const hiVol = allTrades.filter(t => t.entryVolRatio > vol66);
const loVol = allTrades.filter(t => t.entryVolRatio < vol33);
const midVol = allTrades.filter(t => t.entryVolRatio >= vol33 && t.entryVolRatio <= vol66);
printStats([
  computeStats("High volume entry", hiVol),
  computeStats("Mid volume entry", midVol),
  computeStats("Low volume entry", loVol),
]);

// By SMA gap alone
console.log("\n  Sub-analysis: by SMA gap alone");
const hiSma = allTrades.filter(t => Math.abs(t.entrySmaGap) > sma66);
const loSma = allTrades.filter(t => Math.abs(t.entrySmaGap) < sma33);
const midSma = allTrades.filter(t => Math.abs(t.entrySmaGap) >= sma33 && Math.abs(t.entrySmaGap) <= sma66);
printStats([
  computeStats("Wide SMA gap", hiSma),
  computeStats("Mid SMA gap", midSma),
  computeStats("Narrow SMA gap", loSma),
]);

// ─── 2. HOLD DURATION ──────────────────────────────────────────────
console.log(`\n${"=".repeat(120)}`);
console.log("2. CLASSIFICATION BY HOLD DURATION");
console.log("=".repeat(120));

const shortHold = allTrades.filter(t => t.holdDays < 3);
const medHold = allTrades.filter(t => t.holdDays >= 3 && t.holdDays < 15);
const longHold = allTrades.filter(t => t.holdDays >= 15);

printStats([
  computeStats("Short (<3 days)", shortHold),
  computeStats("Medium (3-15 days)", medHold),
  computeStats("Long (15+ days)", longHold),
]);

// More granular
console.log("\n  Granular duration buckets:");
const dur1 = allTrades.filter(t => t.holdDays < 1);
const dur1_3 = allTrades.filter(t => t.holdDays >= 1 && t.holdDays < 3);
const dur3_7 = allTrades.filter(t => t.holdDays >= 3 && t.holdDays < 7);
const dur7_15 = allTrades.filter(t => t.holdDays >= 7 && t.holdDays < 15);
const dur15_30 = allTrades.filter(t => t.holdDays >= 15 && t.holdDays < 30);
const dur30p = allTrades.filter(t => t.holdDays >= 30);

printStats([
  computeStats("<1 day", dur1),
  computeStats("1-3 days", dur1_3),
  computeStats("3-7 days", dur3_7),
  computeStats("7-15 days", dur7_15),
  computeStats("15-30 days", dur15_30),
  computeStats("30+ days", dur30p),
]);

// ─── 3. PAIR VOLATILITY ────────────────────────────────────────────
console.log(`\n${"=".repeat(120)}`);
console.log("3. CLASSIFICATION BY PAIR VOLATILITY");
console.log("=".repeat(120));

const hiVolPairs = allTrades.filter(t => HIGH_VOL_PAIRS.includes(t.pair));
const loVolPairs = allTrades.filter(t => LOW_VOL_PAIRS.includes(t.pair));
const mdVolPairs = allTrades.filter(t => MED_VOL_PAIRS.includes(t.pair));

printStats([
  computeStats("High-vol (TRUMP/WIF/DOGE)", hiVolPairs),
  computeStats("Medium-vol", mdVolPairs),
  computeStats("Low-vol (XRP/ADA/LINK)", loVolPairs),
]);

// Per-pair breakdown
console.log("\n  Per-pair breakdown:");
const perPairStats: GroupStats[] = [];
for (const p of TRADE_PAIRS) {
  const pTrades = allTrades.filter(t => t.pair === p);
  if (pTrades.length > 0) perPairStats.push(computeStats(p, pTrades));
}
perPairStats.sort((a, b) => b.totalPnl - a.totalPnl);
printStats(perPairStats);

// ─── 4. DIRECTION ──────────────────────────────────────────────────
console.log(`\n${"=".repeat(120)}`);
console.log("4. CLASSIFICATION BY DIRECTION");
console.log("=".repeat(120));

const longs = allTrades.filter(t => t.dir === "long");
const shorts = allTrades.filter(t => t.dir === "short");

printStats([
  computeStats("Longs", longs),
  computeStats("Shorts", shorts),
]);

// Direction + BTC regime
console.log("\n  Direction x BTC regime:");
const longBull = longs.filter(t => t.btcBullish);
const longBear = longs.filter(t => !t.btcBullish);
const shortBull = shorts.filter(t => t.btcBullish);
const shortBear = shorts.filter(t => !t.btcBullish);

printStats([
  computeStats("Long + BTC bullish", longBull),
  computeStats("Long + BTC bearish", longBear),
  computeStats("Short + BTC bullish", shortBull),
  computeStats("Short + BTC bearish", shortBear),
]);

// Direction by engine
console.log("\n  Direction x Engine:");
const donLong = allTrades.filter(t => t.engine === "Donchian" && t.dir === "long");
const donShort = allTrades.filter(t => t.engine === "Donchian" && t.dir === "short");
const stLong = allTrades.filter(t => t.engine === "Supertrend" && t.dir === "long");
const stShort = allTrades.filter(t => t.engine === "Supertrend" && t.dir === "short");

printStats([
  computeStats("Donchian Long", donLong),
  computeStats("Donchian Short", donShort),
  computeStats("Supertrend Long", stLong),
  computeStats("Supertrend Short", stShort),
]);

// ─── 5. TIME SINCE PEAK ────────────────────────────────────────────
console.log(`\n${"=".repeat(120)}`);
console.log("5. TIME SINCE PEAK ANALYSIS");
console.log("=".repeat(120));

// Analyze: once trade peaks, how long before significant reversal?
console.log("\n  After-peak decay analysis (winning trades only):\n");

const winners = allTrades.filter(t => t.peakPct > 1); // at least 1% peak

// Bucket by time-from-peak
const peakBuckets = [
  { name: "Exit near peak (<1h)", filter: (t: DetailedTrade) => t.timeFromPeakBars < 12 },
  { name: "Exit 1-4h after peak", filter: (t: DetailedTrade) => t.timeFromPeakBars >= 12 && t.timeFromPeakBars < 48 },
  { name: "Exit 4-12h after peak", filter: (t: DetailedTrade) => t.timeFromPeakBars >= 48 && t.timeFromPeakBars < 144 },
  { name: "Exit 12-24h after peak", filter: (t: DetailedTrade) => t.timeFromPeakBars >= 144 && t.timeFromPeakBars < 288 },
  { name: "Exit 1-3d after peak", filter: (t: DetailedTrade) => t.timeFromPeakBars >= 288 && t.timeFromPeakBars < 864 },
  { name: "Exit 3-7d after peak", filter: (t: DetailedTrade) => t.timeFromPeakBars >= 864 && t.timeFromPeakBars < 2016 },
  { name: "Exit 7d+ after peak", filter: (t: DetailedTrade) => t.timeFromPeakBars >= 2016 },
];

for (const b of peakBuckets) {
  const subset = winners.filter(b.filter);
  if (subset.length === 0) continue;
  const avgGB = subset.reduce((s, t) => s + t.givebackPct, 0) / subset.length;
  const avgPk = subset.reduce((s, t) => s + t.peakPct, 0) / subset.length;
  const avgPnl = subset.reduce((s, t) => s + t.pnlPct, 0) / subset.length;
  const retained = avgPk > 0 ? ((avgPk - avgGB) / avgPk * 100) : 0;
  console.log(
    `  ${b.name.padEnd(28)} N=${String(subset.length).padStart(4)}  AvgPeak=${avgPk.toFixed(2).padStart(6)}%  AvgGiveback=${avgGB.toFixed(2).padStart(6)}%  Retained=${retained.toFixed(0).padStart(3)}%  AvgPnl=${avgPnl.toFixed(2).padStart(6)}%`
  );
}

// "No new high for N bars" analysis
console.log("\n  'No new high' exit analysis:\n");
console.log("  If we exited trades when they didn't make a new high for N hours, what would happen?\n");

const noNewHighThresholds = [2, 4, 6, 8, 12, 24, 36, 48, 72, 96, 120, 168];

for (const hours of noNewHighThresholds) {
  const bars = hours * 12; // 5m bars per hour
  // For each trade, simulate: would we have exited earlier?
  let improved = 0, worsened = 0, unchanged = 0;
  let totalImprovement = 0;
  let totalDamage = 0;
  let affectedCount = 0;

  for (const t of allTrades) {
    // If the trade's max no-new-high streak exceeded this threshold,
    // it means we would have exited earlier
    if (t.barsNoNewHigh >= bars) {
      affectedCount++;
      // Approximate: the exit would be at roughly peak - some giveback
      // We can't perfectly simulate without re-tracing, but we know:
      // If barsNoNewHigh >= bars AND the actual giveback was large,
      // catching it earlier could help
      // For the purpose of analysis, we compare giveback to the threshold
    }
  }

  // Re-trace to get accurate numbers
  let altTotalPnl = 0;
  let baseTotalPnl = 0;
  let tradeCount = 0;

  for (const t of allTrades) {
    baseTotalPnl += t.pnl;
    tradeCount++;

    // Check if this trade would have been caught by the no-new-high rule
    const m5 = raw5m.get(t.pair);
    if (!m5) { altTotalPnl += t.pnl; continue; }

    let startIdx = -1;
    for (let i = 0; i < m5.length; i++) {
      if (m5[i].t >= t.et) { startIdx = i; break; }
    }
    if (startIdx < 0) { altTotalPnl += t.pnl; continue; }

    let peakP = t.ep;
    let noNewHighCtr = 0;
    let altExit = false;

    for (let i = startIdx; i < m5.length && m5[i].t <= t.xt; i++) {
      const bar = m5[i];
      if (t.dir === "long") {
        if (bar.h > peakP) { peakP = bar.h; noNewHighCtr = 0; }
        else noNewHighCtr++;
      } else {
        if (bar.l < peakP) { peakP = bar.l; noNewHighCtr = 0; }
        else noNewHighCtr++;
      }

      if (noNewHighCtr >= bars) {
        // Would exit here
        const xp = t.dir === "long"
          ? bar.c * (1 - sp(t.pair))
          : bar.c * (1 + sp(t.pair));
        const notional = MARGIN * LEV;
        const rawPnl = t.dir === "long" ? (xp / t.ep - 1) * notional : (t.ep / xp - 1) * notional;
        const altPnl = rawPnl - notional * FEE * 2;
        altTotalPnl += altPnl;
        if (altPnl > t.pnl) improved++;
        else if (altPnl < t.pnl) worsened++;
        else unchanged++;
        totalImprovement += altPnl > t.pnl ? (altPnl - t.pnl) : 0;
        totalDamage += altPnl < t.pnl ? (t.pnl - altPnl) : 0;
        altExit = true;
        break;
      }
    }

    if (!altExit) {
      altTotalPnl += t.pnl;
      unchanged++;
    }
  }

  const delta = altTotalPnl - baseTotalPnl;
  console.log(
    `  NoNewHigh=${String(hours).padStart(3)}h: ` +
    `Improved=${String(improved).padStart(4)} Worsened=${String(worsened).padStart(4)} Same=${String(unchanged).padStart(4)} | ` +
    `Gains=+$${totalImprovement.toFixed(0).padStart(5)} Losses=-$${totalDamage.toFixed(0).padStart(5)} | ` +
    `Net=${delta >= 0 ? "+" : ""}$${delta.toFixed(0).padStart(5)} (base=$${baseTotalPnl.toFixed(0)})`
  );
}

// ─── 6. PROPOSED OPTIMIZATIONS ──────────────────────────────────────
console.log(`\n${"=".repeat(120)}`);
console.log("6. PROPOSED ADAPTIVE EXIT RULES & THEORETICAL IMPROVEMENT");
console.log("=".repeat(120));

// Test: adaptive exits based on findings
// We'll test several rule combinations and show the impact

interface AdaptiveRule {
  name: string;
  shouldModifyExit: (t: DetailedTrade) => boolean;
  modifiedExitFn: (t: DetailedTrade, m5: C[], startIdx: number) => { pnl: number; reason: string } | null;
}

function testAdaptiveRule(rule: AdaptiveRule): { name: string; basePnl: number; newPnl: number; affected: number; improved: number; worsened: number } {
  let basePnl = 0, newPnl = 0, affected = 0, improved = 0, worsened = 0;

  for (const t of allTrades) {
    basePnl += t.pnl;

    if (!rule.shouldModifyExit(t)) {
      newPnl += t.pnl;
      continue;
    }

    const m5 = raw5m.get(t.pair);
    if (!m5) { newPnl += t.pnl; continue; }

    let startIdx = -1;
    for (let i = 0; i < m5.length; i++) {
      if (m5[i].t >= t.et) { startIdx = i; break; }
    }
    if (startIdx < 0) { newPnl += t.pnl; continue; }

    const result = rule.modifiedExitFn(t, m5, startIdx);
    if (result) {
      affected++;
      newPnl += result.pnl;
      if (result.pnl > t.pnl) improved++;
      else if (result.pnl < t.pnl) worsened++;
    } else {
      newPnl += t.pnl;
    }
  }

  return { name: rule.name, basePnl, newPnl, affected, improved, worsened };
}

// Helper: re-simulate trade with tighter no-new-high exit
function simNoNewHigh(t: DetailedTrade, m5: C[], startIdx: number, threshBars: number): { pnl: number; reason: string } | null {
  let peakP = t.ep;
  let noNewHighCtr = 0;
  const sl = t.dir === "long" ? t.ep * (1 - 0.035) : t.ep * (1 + 0.035);

  for (let i = startIdx; i < m5.length && m5[i].t <= t.xt + DAY; i++) {
    const bar = m5[i];

    // SL check
    if (t.dir === "long" && bar.l <= sl) {
      const xp = sl * (1 - sp(t.pair) * SL_SLIP);
      const notional = MARGIN * LEV;
      return { pnl: (xp / t.ep - 1) * notional - notional * FEE * 2, reason: "sl" };
    }
    if (t.dir === "short" && bar.h >= sl) {
      const xp = sl * (1 + sp(t.pair) * SL_SLIP);
      const notional = MARGIN * LEV;
      return { pnl: (t.ep / xp - 1) * notional - notional * FEE * 2, reason: "sl" };
    }

    if (t.dir === "long") {
      if (bar.h > peakP) { peakP = bar.h; noNewHighCtr = 0; }
      else noNewHighCtr++;
    } else {
      if (bar.l < peakP) { peakP = bar.l; noNewHighCtr = 0; }
      else noNewHighCtr++;
    }

    if (noNewHighCtr >= threshBars) {
      const xp = t.dir === "long" ? bar.c * (1 - sp(t.pair)) : bar.c * (1 + sp(t.pair));
      const notional = MARGIN * LEV;
      const rawPnl = t.dir === "long" ? (xp / t.ep - 1) * notional : (t.ep / xp - 1) * notional;
      return { pnl: rawPnl - notional * FEE * 2, reason: "no-new-high" };
    }

    // Max hold
    if (bar.t - t.et >= 60 * DAY) {
      const xp = t.dir === "long" ? bar.c * (1 - sp(t.pair)) : bar.c * (1 + sp(t.pair));
      const notional = MARGIN * LEV;
      const rawPnl = t.dir === "long" ? (xp / t.ep - 1) * notional : (t.ep / xp - 1) * notional;
      return { pnl: rawPnl - notional * FEE * 2, reason: "max-hold" };
    }
  }
  return null;
}

// Rule 1: High-vol pairs get tighter exit (24h no-new-high)
const rule1 = testAdaptiveRule({
  name: "High-vol pairs: 24h no-new-high exit",
  shouldModifyExit: t => HIGH_VOL_PAIRS.includes(t.pair),
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 24 * 12),
});

// Rule 2: Weak entries get tighter exit (12h no-new-high)
const rule2 = testAdaptiveRule({
  name: "Weak entries: 12h no-new-high exit",
  shouldModifyExit: t => entryStrength(t) === "weak",
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 12 * 12),
});

// Rule 3: Shorts get tighter exit (36h no-new-high)
const rule3 = testAdaptiveRule({
  name: "Shorts: 36h no-new-high exit",
  shouldModifyExit: t => t.dir === "short",
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 36 * 12),
});

// Rule 4: All trades: 48h no-new-high exit
const rule4 = testAdaptiveRule({
  name: "All trades: 48h no-new-high exit",
  shouldModifyExit: () => true,
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 48 * 12),
});

// Rule 5: High-vol + short: 12h no-new-high
const rule5 = testAdaptiveRule({
  name: "High-vol shorts: 12h no-new-high",
  shouldModifyExit: t => HIGH_VOL_PAIRS.includes(t.pair) && t.dir === "short",
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 12 * 12),
});

// Rule 6: Supertrend trades: 24h no-new-high (faster engine)
const rule6 = testAdaptiveRule({
  name: "Supertrend: 24h no-new-high exit",
  shouldModifyExit: t => t.engine === "Supertrend",
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 24 * 12),
});

// Rule 7: Low-vol pairs get wider exit (72h no-new-high)
const rule7 = testAdaptiveRule({
  name: "Low-vol pairs: 72h no-new-high exit",
  shouldModifyExit: t => LOW_VOL_PAIRS.includes(t.pair),
  modifiedExitFn: (t, m5, startIdx) => simNoNewHigh(t, m5, startIdx, 72 * 12),
});

// Rule 8: Combined best: different thresholds per category
const rule8 = testAdaptiveRule({
  name: "Adaptive: vol-based thresholds",
  shouldModifyExit: () => true,
  modifiedExitFn: (t, m5, startIdx) => {
    let thresh: number;
    if (HIGH_VOL_PAIRS.includes(t.pair)) thresh = 24 * 12;
    else if (LOW_VOL_PAIRS.includes(t.pair)) thresh = 72 * 12;
    else thresh = 48 * 12;
    return simNoNewHigh(t, m5, startIdx, thresh);
  },
});

// Rule 9: Direction-adaptive
const rule9 = testAdaptiveRule({
  name: "Adaptive: dir-based (L=48h S=24h)",
  shouldModifyExit: () => true,
  modifiedExitFn: (t, m5, startIdx) => {
    const thresh = t.dir === "long" ? 48 * 12 : 24 * 12;
    return simNoNewHigh(t, m5, startIdx, thresh);
  },
});

// Rule 10: Combined best: vol + dir
const rule10 = testAdaptiveRule({
  name: "Adaptive: vol+dir combined",
  shouldModifyExit: () => true,
  modifiedExitFn: (t, m5, startIdx) => {
    let base: number;
    if (HIGH_VOL_PAIRS.includes(t.pair)) base = 24;
    else if (LOW_VOL_PAIRS.includes(t.pair)) base = 72;
    else base = 48;
    // Shorts get tighter
    if (t.dir === "short") base = Math.round(base * 0.75);
    return simNoNewHigh(t, m5, startIdx, base * 12);
  },
});

const rules = [rule1, rule2, rule3, rule4, rule5, rule6, rule7, rule8, rule9, rule10];

console.log("\n  Rule                                    Affected  Improved  Worsened  BasePnl    NewPnl     Delta      Delta%");
console.log("  " + "-".repeat(115));

for (const r of rules) {
  const delta = r.newPnl - r.basePnl;
  const deltaPct = r.basePnl !== 0 ? (delta / Math.abs(r.basePnl) * 100) : 0;
  console.log(
    `  ${r.name.padEnd(40)} ${String(r.affected).padStart(7)}  ${String(r.improved).padStart(8)}  ${String(r.worsened).padStart(8)}  ` +
    `$${r.basePnl.toFixed(0).padStart(8)}  $${r.newPnl.toFixed(0).padStart(8)}  ${delta >= 0 ? "+" : ""}$${delta.toFixed(0).padStart(7)}  ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`
  );
}

// ─── 7. SUMMARY ─────────────────────────────────────────────────────
console.log(`\n${"=".repeat(120)}`);
console.log("7. EXECUTIVE SUMMARY");
console.log("=".repeat(120));

const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
const totalWins = allTrades.filter(t => t.pnl > 0).length;
const avgGB = allTrades.reduce((s, t) => s + t.givebackPct, 0) / allTrades.length;
const avgPk = allTrades.reduce((s, t) => s + t.peakPct, 0) / allTrades.length;

console.log(`\n  Total trades: ${allTrades.length}`);
console.log(`  Donchian: ${allTrades.filter(t => t.engine === "Donchian").length}, Supertrend: ${allTrades.filter(t => t.engine === "Supertrend").length}`);
console.log(`  Longs: ${longs.length}, Shorts: ${shorts.length}`);
console.log(`  Win rate: ${(totalWins / allTrades.length * 100).toFixed(1)}%`);
console.log(`  Total PnL: $${totalPnl.toFixed(0)}`);
console.log(`  Avg peak excursion: ${avgPk.toFixed(2)}%`);
console.log(`  Avg giveback: ${avgGB.toFixed(2)}%`);
console.log(`  Avg retention: ${avgPk > 0 ? ((avgPk - avgGB) / avgPk * 100).toFixed(0) : "N/A"}%`);

// Best rule
const bestRule = rules.reduce((best, r) => (r.newPnl - r.basePnl) > (best.newPnl - best.basePnl) ? r : best, rules[0]);
const bestDelta = bestRule.newPnl - bestRule.basePnl;
console.log(`\n  Best adaptive rule: "${bestRule.name}"`);
console.log(`    Improvement: ${bestDelta >= 0 ? "+" : ""}$${bestDelta.toFixed(0)} (${(bestDelta / Math.abs(bestRule.basePnl) * 100).toFixed(1)}%)`);
console.log(`    Trades improved: ${bestRule.improved}, worsened: ${bestRule.worsened}`);

console.log("\n  Key findings:");
console.log(`    - Avg giveback across all trades: ${avgGB.toFixed(2)}% of the position`);
console.log(`    - That is ${avgPk > 0 ? (avgGB / avgPk * 100).toFixed(0) : "?"}% of peak gains given back`);
console.log(`    - High-vol pairs (TRUMP/WIF/DOGE) giveback: ${hiVolPairs.length > 0 ? (hiVolPairs.reduce((s, t) => s + t.givebackPct, 0) / hiVolPairs.length).toFixed(2) : "N/A"}%`);
console.log(`    - Low-vol pairs (XRP/ADA/LINK) giveback: ${loVolPairs.length > 0 ? (loVolPairs.reduce((s, t) => s + t.givebackPct, 0) / loVolPairs.length).toFixed(2) : "N/A"}%`);
console.log(`    - Longs giveback: ${longs.length > 0 ? (longs.reduce((s, t) => s + t.givebackPct, 0) / longs.length).toFixed(2) : "N/A"}%`);
console.log(`    - Shorts giveback: ${shorts.length > 0 ? (shorts.reduce((s, t) => s + t.givebackPct, 0) / shorts.length).toFixed(2) : "N/A"}%`);
