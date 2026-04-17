/**
 * Engine F Candidate Backtest - 6 Strategy Families
 *
 * 1. Bollinger Band Squeeze Breakout (4h)
 * 2. Ichimoku Cloud Breakout (daily)
 * 3. VWAP Deviation (4h)
 * 4. Keltner Channel Breakout (4h)
 * 5. Williams %R Extreme + Momentum (4h)
 * 6. Dual Momentum (absolute + relative, monthly rebalance)
 *
 * Cost model: 0.035% taker fee, pair-specific half-spreads, 1.5x SL slippage, ATR stops
 * BTC 4h EMA(12/21) filter for longs
 * $5 margin, 10x leverage ($50 notional)
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-new-entry-strategies.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const FEE = 0.000_35;          // 0.035% taker per side
const MARGIN = 5;              // $5 margin
const LEV = 10;
const NOTIONAL = MARGIN * LEV; // $50
const SL_SLIPPAGE = 1.5;
const MAX_SL_PCT = 0.035;      // 3.5% cap

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-28").getTime();

const PAIRS = [
  "OP","ARB","LDO","TRUMP","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","SOL",
];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SOL: 2.0e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";
interface Trade {
  pair: string; strategy: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
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

function aggregate(candles: C[], period: number): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: C[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function ema(vals: number[], period: number): number[] {
  const r = new Array(vals.length).fill(0);
  const k = 2 / (period + 1);
  // Seed with SMA
  if (vals.length < period) return r;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += vals[i];
  r[period - 1] = sum / period;
  for (let i = period; i < vals.length; i++) {
    r[i] = vals[i] * k + r[i - 1] * (1 - k);
  }
  return r;
}

function smaArr(vals: number[], period: number): number[] {
  const r = new Array(vals.length).fill(0);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= period) s -= vals[i - period];
    if (i >= period - 1) r[i] = s / period;
  }
  return r;
}

function calcATR(bars: C[], period: number): number[] {
  const r = new Array(bars.length).fill(0);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

function calcBB(closes: number[], period: number, mult: number): { upper: number[]; lower: number[]; mid: number[]; width: number[] } {
  const n = closes.length;
  const upper = new Array(n).fill(0);
  const lower = new Array(n).fill(0);
  const mid = new Array(n).fill(0);
  const width = new Array(n).fill(0);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += closes[j];
    const m = s / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - m) ** 2;
    const std = Math.sqrt(sqSum / period);
    mid[i] = m;
    upper[i] = m + mult * std;
    lower[i] = m - mult * std;
    width[i] = m > 0 ? (2 * mult * std) / m : 0; // normalized bandwidth
  }
  return { upper, lower, mid, width };
}

function calcWilliamsR(bars: C[], period: number): number[] {
  const n = bars.length;
  const r = new Array(n).fill(-50);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].h);
      ll = Math.min(ll, bars[j].l);
    }
    r[i] = hh === ll ? -50 : ((hh - bars[i].c) / (hh - ll)) * -100;
  }
  return r;
}

// Ichimoku components
function ichimoku(bars: C[], convPeriod: number = 9, basePeriod: number = 26, spanBPeriod: number = 52) {
  const n = bars.length;
  const tenkan = new Array(n).fill(0);  // conversion line
  const kijun = new Array(n).fill(0);   // base line
  const senkouA = new Array(n).fill(0); // leading span A (shifted forward)
  const senkouB = new Array(n).fill(0); // leading span B (shifted forward)

  function midHL(start: number, end: number): number {
    let hh = -Infinity, ll = Infinity;
    for (let j = start; j <= end; j++) {
      hh = Math.max(hh, bars[j].h);
      ll = Math.min(ll, bars[j].l);
    }
    return (hh + ll) / 2;
  }

  for (let i = 0; i < n; i++) {
    if (i >= convPeriod - 1) tenkan[i] = midHL(i - convPeriod + 1, i);
    if (i >= basePeriod - 1) kijun[i] = midHL(i - basePeriod + 1, i);
    // Senkou A = (tenkan + kijun) / 2, shifted forward by basePeriod
    // For backtesting we use current values (the "cloud" at current bar is from basePeriod bars ago)
    if (i >= basePeriod - 1) {
      senkouA[i] = (tenkan[i] + kijun[i]) / 2;
    }
    if (i >= spanBPeriod - 1) {
      senkouB[i] = midHL(i - spanBPeriod + 1, i);
    }
  }

  return { tenkan, kijun, senkouA, senkouB };
}

// ─── PnL Calculation ────────────────────────────────────────────────
function calcPnl(pair: string, ep: number, xp: number, dir: Dir, isSL: boolean): number {
  const spread = sp(pair);
  const entrySlip = ep * spread;
  const exitSlip = xp * spread * (isSL ? SL_SLIPPAGE : 1);
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOTIONAL
    : (ep / xp - 1) * NOTIONAL;
  const cost = entrySlip * (NOTIONAL / ep) + exitSlip * (NOTIONAL / xp) + NOTIONAL * FEE * 2;
  return rawPnl - cost;
}

function capSL(ep: number, slDist: number): number {
  const maxDist = ep * MAX_SL_PCT;
  return Math.min(slDist, maxDist);
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcStats(trades: Trade[]): Stats {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = wins.length / trades.length * 100;

  // Sharpe: daily buckets
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dayPnl.values()];
  const mean = dpVals.reduce((a, b) => a + b, 0) / dpVals.length;
  const std = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  // Max DD
  let equity = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return { n: trades.length, wr, pf, sharpe, dd: maxDD, total, perDay: days > 0 ? total / days : 0 };
}

// ─── Correlation between two trade streams (daily PnL) ──────────────
function dailyPnlSeries(trades: Trade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    m.set(d, (m.get(d) ?? 0) + t.pnl);
  }
  return m;
}

function pearsonCorr(a: Map<number, number>, b: Map<number, number>): number {
  // Align on all days where either has a value (missing = 0)
  const allDays = new Set([...a.keys(), ...b.keys()]);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of allDays) {
    xs.push(a.get(d) ?? 0);
    ys.push(b.get(d) ?? 0);
  }
  if (xs.length < 10) return 0;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  const denom = Math.sqrt(sx * sy);
  return denom > 0 ? cov / denom : 0;
}

// ─── Data Structures ────────────────────────────────────────────────
interface PairData {
  m5: C[];
  h4: C[];
  daily: C[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
}

interface BTCData {
  h4: C[];
  daily: C[];
  h4Ema12: number[];
  h4Ema21: number[];
  dailyEma20: number[];
  dailyEma50: number[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
}

// ─── Load Data ──────────────────────────────────────────────────────
console.log("Loading data...");

const btcRaw = load5m("BTC");
const btcH4 = aggregate(btcRaw, H4);
const btcDaily = aggregate(btcRaw, DAY);
const btcH4Closes = btcH4.map(b => b.c);
const btcDailyCloses = btcDaily.map(b => b.c);
const btc: BTCData = {
  h4: btcH4,
  daily: btcDaily,
  h4Ema12: ema(btcH4Closes, 12),
  h4Ema21: ema(btcH4Closes, 21),
  dailyEma20: ema(btcDailyCloses, 20),
  dailyEma50: ema(btcDailyCloses, 50),
  h4Map: new Map(btcH4.map((b, i) => [b.t, i])),
  dailyMap: new Map(btcDaily.map((b, i) => [b.t, i])),
};

const pairData = new Map<string, PairData>();
const available: string[] = [];
for (const p of PAIRS) {
  const m5 = load5m(p);
  if (m5.length < 500) continue;
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  pairData.set(p, {
    m5, h4, daily,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  });
  available.push(p);
  console.log(`  ${p}: ${m5.length} 5m, ${h4.length} 4h, ${daily.length} daily`);
}
console.log(`Loaded ${available.length} pairs\n`);

// ─── BTC filters ────────────────────────────────────────────────────
function btcH4Bullish(t: number): boolean {
  // Use previous completed bar
  const aligned = Math.floor(t / H4) * H4;
  let idx = btc.h4Map.get(aligned);
  if (idx === undefined) {
    // Search backward
    for (let dt = H4; dt <= 5 * H4; dt += H4) {
      idx = btc.h4Map.get(aligned - dt);
      if (idx !== undefined) break;
    }
  }
  if (idx === undefined || idx < 21) return false;
  const prevIdx = idx - 1;
  return btc.h4Ema12[prevIdx] > btc.h4Ema21[prevIdx] && btc.h4Ema12[prevIdx] > 0;
}

function btcDailyBullish(t: number): boolean {
  const aligned = Math.floor(t / DAY) * DAY;
  let idx = btc.dailyMap.get(aligned);
  if (idx === undefined) {
    for (let dt = DAY; dt <= 5 * DAY; dt += DAY) {
      idx = btc.dailyMap.get(aligned - dt);
      if (idx !== undefined) break;
    }
  }
  if (idx === undefined || idx < 50) return false;
  const prevIdx = idx - 1;
  return btc.dailyEma20[prevIdx] > btc.dailyEma50[prevIdx] && btc.dailyEma20[prevIdx] > 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY 1: Bollinger Band Squeeze Breakout (4h)
// ═══════════════════════════════════════════════════════════════════════
function stratBBSqueeze(): Trade[] {
  const trades: Trade[] = [];
  const BB_PERIOD = 20;
  const BB_MULT = 2;
  const SQUEEZE_PCTILE = 20; // width below 20th percentile
  const ATR_SL_MULT = 3;
  const MAX_HOLD = 30 * DAY;

  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.h4;
    if (bars.length < 120) continue;

    const closes = bars.map(b => b.c);
    const bb = calcBB(closes, BB_PERIOD, BB_MULT);
    const atrVals = calcATR(bars, 14);

    // Compute rolling percentile of BB width
    const widthHistory: number[] = [];
    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = BB_PERIOD; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;

      const bar = bars[i];
      const prevWidth = bb.width[i - 1];
      if (prevWidth <= 0) continue;

      // Maintain trailing width history for percentile
      widthHistory.push(prevWidth);
      if (widthHistory.length > 200) widthHistory.shift();

      // Manage existing position
      if (pos) {
        // ATR trailing stop
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          const trailSL = pos.peak - ATR_SL_MULT * pos.atr;
          pos.sl = Math.max(pos.sl, trailSL);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          const trailSL = pos.peak + ATR_SL_MULT * pos.atr;
          pos.sl = Math.min(pos.sl, trailSL);
        }

        let xp = 0, reason = "", isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        if (!xp && bar.t - pos.et >= MAX_HOLD) { xp = bar.c; reason = "mh"; }

        // Exit on BB mean reversion (close crosses back through midline)
        if (!xp) {
          if (pos.dir === "long" && bar.c < bb.mid[i]) { xp = bar.c; reason = "mid"; }
          else if (pos.dir === "short" && bar.c > bb.mid[i]) { xp = bar.c; reason = "mid"; }
        }

        if (xp) {
          trades.push({
            pair, strategy: "BB-Squeeze", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL),
          });
          pos = null;
        }
        continue; // no new entry while in position
      }

      // Entry logic: squeeze then breakout
      if (widthHistory.length < 50) continue;
      const sorted = [...widthHistory].sort((a, b) => a - b);
      const pctileThreshold = sorted[Math.floor(sorted.length * SQUEEZE_PCTILE / 100)];

      // Check: previous bar was in squeeze, current bar breaks out
      const prevBarInSqueeze = bb.width[i - 1] <= pctileThreshold;
      if (!prevBarInSqueeze) continue;

      const atrVal = atrVals[i - 1];
      if (atrVal <= 0) continue;

      let dir: Dir | null = null;
      if (bar.c > bb.upper[i - 1]) dir = "long";
      else if (bar.c < bb.lower[i - 1]) dir = "short";
      if (!dir) continue;

      // BTC filter for longs
      if (dir === "long" && !btcH4Bullish(bar.t)) continue;

      const sprd = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
      const slDist = capSL(ep, atrVal * ATR_SL_MULT);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      pos = { dir, ep, et: bar.t, sl, peak: ep, atr: atrVal };
    }

    // Close remaining
    if (pos) {
      const lastBar = bars[bars.length - 1];
      trades.push({
        pair, strategy: "BB-Squeeze", dir: pos.dir,
        ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
        pnl: calcPnl(pair, pos.ep, lastBar.c, pos.dir, false),
      });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY 2: Ichimoku Cloud Breakout (daily)
// ═══════════════════════════════════════════════════════════════════════
function stratIchimoku(): Trade[] {
  const trades: Trade[] = [];
  const ATR_SL_MULT = 3;
  const MAX_HOLD = 60 * DAY;

  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.daily;
    if (bars.length < 60) continue;

    const ich = ichimoku(bars, 9, 26, 52);
    const atrVals = calcATR(bars, 14);

    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = 52; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;
      const bar = bars[i];
      const prev = bars[i - 1];

      // Cloud boundaries at previous bar
      const cloudTop = Math.max(ich.senkouA[i - 1], ich.senkouB[i - 1]);
      const cloudBot = Math.min(ich.senkouA[i - 1], ich.senkouB[i - 1]);

      // Manage position
      if (pos) {
        // Trailing stop
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          const trailSL = pos.peak - ATR_SL_MULT * pos.atr;
          pos.sl = Math.max(pos.sl, trailSL);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          const trailSL = pos.peak + ATR_SL_MULT * pos.atr;
          pos.sl = Math.min(pos.sl, trailSL);
        }

        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && bar.t - pos.et >= MAX_HOLD) { xp = bar.c; }
        // Exit: price re-enters cloud
        if (!xp) {
          if (pos.dir === "long" && bar.c < cloudBot) { xp = bar.c; }
          else if (pos.dir === "short" && bar.c > cloudTop) { xp = bar.c; }
        }

        if (xp) {
          trades.push({
            pair, strategy: "Ichimoku", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL),
          });
          pos = null;
        }
        continue;
      }

      // Entry: price crosses above/below cloud
      const atrVal = atrVals[i - 1];
      if (atrVal <= 0) continue;

      let dir: Dir | null = null;
      // Long: prev close was below/in cloud, current close above cloud
      if (prev.c <= cloudTop && bar.c > cloudTop) {
        // Confirm: tenkan > kijun (trend confirmation)
        if (ich.tenkan[i - 1] > ich.kijun[i - 1]) dir = "long";
      }
      // Short: prev close was above/in cloud, current close below cloud
      if (prev.c >= cloudBot && bar.c < cloudBot) {
        if (ich.tenkan[i - 1] < ich.kijun[i - 1]) dir = "short";
      }
      if (!dir) continue;

      // BTC filter for longs
      if (dir === "long" && !btcDailyBullish(bar.t)) continue;

      const sprd = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
      const slDist = capSL(ep, atrVal * ATR_SL_MULT);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      pos = { dir, ep, et: bar.t, sl, peak: ep, atr: atrVal };
    }

    if (pos) {
      const lastBar = bars[bars.length - 1];
      trades.push({
        pair, strategy: "Ichimoku", dir: pos.dir,
        ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
        pnl: calcPnl(pair, pos.ep, lastBar.c, pos.dir, false),
      });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY 3: VWAP Deviation (4h) - Momentum Continuation
// ═══════════════════════════════════════════════════════════════════════
function stratVWAPDev(): Trade[] {
  const trades: Trade[] = [];
  const VWAP_PERIOD = 20; // 20 bars rolling VWAP
  const STD_MULT = 2.0;
  const ATR_SL_MULT = 3;
  const MAX_HOLD = 14 * DAY;

  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.h4;
    if (bars.length < 80) continue;

    const atrVals = calcATR(bars, 14);
    const closes = bars.map(b => b.c);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);

    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = VWAP_PERIOD + 1; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;
      const bar = bars[i];

      // Calculate rolling VWAP and std dev
      let sumPV = 0, sumV = 0;
      for (let j = i - VWAP_PERIOD; j < i; j++) {
        const typical = (bars[j].h + bars[j].l + bars[j].c) / 3;
        sumPV += typical * bars[j].v;
        sumV += bars[j].v;
      }
      if (sumV <= 0) continue;
      const vwap = sumPV / sumV;

      // Std dev of typical price from VWAP
      let sqSum = 0;
      for (let j = i - VWAP_PERIOD; j < i; j++) {
        const typical = (bars[j].h + bars[j].l + bars[j].c) / 3;
        sqSum += (typical - vwap) ** 2;
      }
      const stdDev = Math.sqrt(sqSum / VWAP_PERIOD);
      if (stdDev <= 0) continue;

      const deviation = (bar.c - vwap) / stdDev;

      // Manage position
      if (pos) {
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          const trailSL = pos.peak - ATR_SL_MULT * pos.atr;
          pos.sl = Math.max(pos.sl, trailSL);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          const trailSL = pos.peak + ATR_SL_MULT * pos.atr;
          pos.sl = Math.min(pos.sl, trailSL);
        }

        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && bar.t - pos.et >= MAX_HOLD) { xp = bar.c; }
        // Exit: deviation returns to zero
        if (!xp) {
          if (pos.dir === "long" && deviation < 0) { xp = bar.c; }
          else if (pos.dir === "short" && deviation > 0) { xp = bar.c; }
        }

        if (xp) {
          trades.push({
            pair, strategy: "VWAP-Dev", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL),
          });
          pos = null;
        }
        continue;
      }

      // Entry: momentum continuation (price > 2 std from VWAP + EMA confirmation)
      if (i < 22) continue;
      const atrVal = atrVals[i - 1];
      if (atrVal <= 0) continue;

      let dir: Dir | null = null;
      // Long: price > 2 std above VWAP, EMA9 > EMA21 (trend confirmed)
      if (deviation > STD_MULT && ema9[i - 1] > ema21[i - 1]) dir = "long";
      // Short: price < -2 std below VWAP, EMA9 < EMA21
      if (deviation < -STD_MULT && ema9[i - 1] < ema21[i - 1]) dir = "short";
      if (!dir) continue;

      if (dir === "long" && !btcH4Bullish(bar.t)) continue;

      const sprd = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
      const slDist = capSL(ep, atrVal * ATR_SL_MULT);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      pos = { dir, ep, et: bar.t, sl, peak: ep, atr: atrVal };
    }

    if (pos) {
      const lastBar = bars[bars.length - 1];
      trades.push({
        pair, strategy: "VWAP-Dev", dir: pos.dir,
        ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
        pnl: calcPnl(pair, pos.ep, lastBar.c, pos.dir, false),
      });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY 4: Keltner Channel Breakout (4h)
// ═══════════════════════════════════════════════════════════════════════
function stratKeltner(): Trade[] {
  const trades: Trade[] = [];
  const KC_PERIOD = 20;
  const KC_MULT = 1.5;
  const ATR_SL_MULT = 3;
  const MAX_HOLD = 30 * DAY;

  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.h4;
    if (bars.length < 80) continue;

    const closes = bars.map(b => b.c);
    const emaLine = ema(closes, KC_PERIOD);
    const atrVals = calcATR(bars, KC_PERIOD);

    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = KC_PERIOD + 1; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;
      const bar = bars[i];

      const emaVal = emaLine[i - 1];
      const atrVal = atrVals[i - 1];
      if (emaVal <= 0 || atrVal <= 0) continue;

      const kcUpper = emaVal + KC_MULT * atrVal;
      const kcLower = emaVal - KC_MULT * atrVal;

      // Manage position
      if (pos) {
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          const trailSL = pos.peak - ATR_SL_MULT * pos.atr;
          pos.sl = Math.max(pos.sl, trailSL);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          const trailSL = pos.peak + ATR_SL_MULT * pos.atr;
          pos.sl = Math.min(pos.sl, trailSL);
        }

        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && bar.t - pos.et >= MAX_HOLD) { xp = bar.c; }
        // Exit: close back inside Keltner channel
        if (!xp) {
          if (pos.dir === "long" && bar.c < emaVal) { xp = bar.c; }
          else if (pos.dir === "short" && bar.c > emaVal) { xp = bar.c; }
        }

        if (xp) {
          trades.push({
            pair, strategy: "Keltner", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL),
          });
          pos = null;
        }
        continue;
      }

      // Entry: close outside Keltner channel
      let dir: Dir | null = null;
      if (bars[i - 1].c > kcUpper) dir = "long";
      else if (bars[i - 1].c < kcLower) dir = "short";
      if (!dir) continue;

      if (dir === "long" && !btcH4Bullish(bar.t)) continue;

      const sprd = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
      const slDist = capSL(ep, atrVal * ATR_SL_MULT);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      pos = { dir, ep, et: bar.t, sl, peak: ep, atr: atrVal };
    }

    if (pos) {
      const lastBar = bars[bars.length - 1];
      trades.push({
        pair, strategy: "Keltner", dir: pos.dir,
        ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
        pnl: calcPnl(pair, pos.ep, lastBar.c, pos.dir, false),
      });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY 5: Williams %R Extreme + Momentum (4h)
// ═══════════════════════════════════════════════════════════════════════
function stratWilliamsR(): Trade[] {
  const trades: Trade[] = [];
  const WR_PERIOD = 14;
  const WR_OVERBOUGHT = -20;
  const WR_OVERSOLD = -80;
  const ATR_SL_MULT = 3;
  const MAX_HOLD = 14 * DAY;

  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.h4;
    if (bars.length < 60) continue;

    const wr = calcWilliamsR(bars, WR_PERIOD);
    const atrVals = calcATR(bars, 14);
    const closes = bars.map(b => b.c);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);

    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = WR_PERIOD + 1; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;
      const bar = bars[i];

      // Manage position
      if (pos) {
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          const trailSL = pos.peak - ATR_SL_MULT * pos.atr;
          pos.sl = Math.max(pos.sl, trailSL);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          const trailSL = pos.peak + ATR_SL_MULT * pos.atr;
          pos.sl = Math.min(pos.sl, trailSL);
        }

        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && bar.t - pos.et >= MAX_HOLD) { xp = bar.c; }
        // Exit: %R crosses back to extreme (profit target zone)
        if (!xp) {
          if (pos.dir === "long" && wr[i] > WR_OVERBOUGHT) { xp = bar.c; }
          else if (pos.dir === "short" && wr[i] < WR_OVERSOLD) { xp = bar.c; }
        }

        if (xp) {
          trades.push({
            pair, strategy: "WilliamsR", dir: pos.dir,
            ep: pos.ep, xp, et: pos.et, xt: bar.t,
            pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL),
          });
          pos = null;
        }
        continue;
      }

      // Entry: %R exits extreme zone + momentum confirmation
      const atrVal = atrVals[i - 1];
      if (atrVal <= 0 || i < 22) continue;

      let dir: Dir | null = null;
      // Long: %R was oversold, now crosses above -80, EMA9>EMA21
      if (wr[i - 2] < WR_OVERSOLD && wr[i - 1] >= WR_OVERSOLD && ema9[i - 1] > ema21[i - 1]) {
        dir = "long";
      }
      // Short: %R was overbought, now crosses below -20, EMA9<EMA21
      if (wr[i - 2] > WR_OVERBOUGHT && wr[i - 1] <= WR_OVERBOUGHT && ema9[i - 1] < ema21[i - 1]) {
        dir = "short";
      }
      if (!dir) continue;

      if (dir === "long" && !btcH4Bullish(bar.t)) continue;

      const sprd = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
      const slDist = capSL(ep, atrVal * ATR_SL_MULT);
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      pos = { dir, ep, et: bar.t, sl, peak: ep, atr: atrVal };
    }

    if (pos) {
      const lastBar = bars[bars.length - 1];
      trades.push({
        pair, strategy: "WilliamsR", dir: pos.dir,
        ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t,
        pnl: calcPnl(pair, pos.ep, lastBar.c, pos.dir, false),
      });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY 6: Dual Momentum (Absolute + Relative, Monthly Rebalance)
// ═══════════════════════════════════════════════════════════════════════
function stratDualMomentum(): Trade[] {
  const trades: Trade[] = [];
  const LOOKBACK_DAYS = 30;
  const TOP_N = 5;
  const MAX_HOLD = 35 * DAY; // rebalanced monthly, buffer

  // Build monthly rebalance dates
  const allDailyTs = new Set<number>();
  for (const [, pd] of pairData) {
    for (const b of pd.daily) {
      if (b.t >= FULL_START) allDailyTs.add(b.t);
    }
  }
  const sortedDays = [...allDailyTs].sort((a, b) => a - b);

  const rebalDates: number[] = [];
  let lastMonth = -1;
  for (const t of sortedDays) {
    const d = new Date(t);
    const m = d.getFullYear() * 12 + d.getMonth();
    if (m !== lastMonth) { rebalDates.push(t); lastMonth = m; }
  }

  const positions = new Map<string, { ep: number; et: number; dir: Dir }>();

  for (let ri = 0; ri < rebalDates.length; ri++) {
    const rebalTs = rebalDates[ri];

    // Close all existing positions
    for (const [pair, pos] of positions) {
      const pd = pairData.get(pair);
      if (!pd) continue;
      const di = pd.dailyMap.get(rebalTs);
      if (di === undefined) {
        // Find nearest bar
        let found = false;
        for (const b of pd.daily) {
          if (b.t >= rebalTs) {
            const pnl = calcPnl(pair, pos.ep, b.o, pos.dir, false);
            trades.push({ pair, strategy: "DualMom", dir: pos.dir, ep: pos.ep, xp: b.o, et: pos.et, xt: b.t, pnl });
            found = true;
            break;
          }
        }
        if (!found) continue;
      } else {
        const bar = pd.daily[di];
        const pnl = calcPnl(pair, pos.ep, bar.o, pos.dir, false);
        trades.push({ pair, strategy: "DualMom", dir: pos.dir, ep: pos.ep, xp: bar.o, et: pos.et, xt: rebalTs, pnl });
      }
    }
    positions.clear();

    // Rank pairs by 30d return
    const ranked: { pair: string; ret: number }[] = [];
    // Get BTC 30d return
    let btcRet = 0;
    {
      const bdi = btc.dailyMap.get(Math.floor(rebalTs / DAY) * DAY);
      if (bdi !== undefined && bdi >= LOOKBACK_DAYS) {
        btcRet = btc.daily[bdi].c / btc.daily[bdi - LOOKBACK_DAYS].c - 1;
      }
    }

    for (const pair of available) {
      const pd = pairData.get(pair);
      if (!pd) continue;
      // Find bar at or just before rebal
      let di = pd.dailyMap.get(Math.floor(rebalTs / DAY) * DAY);
      if (di === undefined) {
        // Search backward
        for (let dt = DAY; dt <= 5 * DAY; dt += DAY) {
          di = pd.dailyMap.get(Math.floor(rebalTs / DAY) * DAY - dt);
          if (di !== undefined) break;
        }
      }
      if (di === undefined || di < LOOKBACK_DAYS) continue;

      const ret = pd.daily[di].c / pd.daily[di - LOOKBACK_DAYS].c - 1;
      ranked.push({ pair, ret });
    }

    // Absolute momentum: positive return AND outperforming BTC
    const longCandidates = ranked
      .filter(r => r.ret > 0 && r.ret > btcRet)
      .sort((a, b) => b.ret - a.ret)
      .slice(0, TOP_N);

    // Short candidates: negative return AND underperforming BTC
    const shortCandidates = ranked
      .filter(r => r.ret < 0 && r.ret < btcRet)
      .sort((a, b) => a.ret - b.ret)
      .slice(0, 2); // fewer shorts

    // BTC filter for longs
    const btcBull = btcDailyBullish(rebalTs);

    for (const pick of longCandidates) {
      if (!btcBull) continue;
      const pd = pairData.get(pick.pair)!;
      let di = pd.dailyMap.get(Math.floor(rebalTs / DAY) * DAY);
      if (di === undefined) continue;
      const ep = pd.daily[di].o * (1 + sp(pick.pair));
      positions.set(pick.pair, { ep, et: rebalTs, dir: "long" });
    }

    for (const pick of shortCandidates) {
      const pd = pairData.get(pick.pair)!;
      let di = pd.dailyMap.get(Math.floor(rebalTs / DAY) * DAY);
      if (di === undefined) continue;
      const ep = pd.daily[di].o * (1 - sp(pick.pair));
      if (!positions.has(pick.pair)) {
        positions.set(pick.pair, { ep, et: rebalTs, dir: "short" });
      }
    }
  }

  // Close remaining
  for (const [pair, pos] of positions) {
    const pd = pairData.get(pair);
    if (!pd || pd.daily.length === 0) continue;
    const lastBar = pd.daily[pd.daily.length - 1];
    const pnl = calcPnl(pair, pos.ep, lastBar.c, pos.dir, false);
    trades.push({ pair, strategy: "DualMom", dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl });
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// Simulate existing engine daily P&L for correlation comparison
// ═══════════════════════════════════════════════════════════════════════
// Simplified proxies for existing engines to compute daily P&L correlation
function proxyDonchianDaily(): Trade[] {
  const trades: Trade[] = [];
  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.daily;
    if (bars.length < 65) continue;

    const closes = bars.map(b => b.c);
    const sma30 = smaArr(closes, 30);
    const sma60 = smaArr(closes, 60);
    const atrVals = calcATR(bars, 14);

    // Donchian channel exit on closes
    const donLo15: number[] = new Array(bars.length).fill(0);
    const donHi15: number[] = new Array(bars.length).fill(0);
    for (let i = 15; i < bars.length; i++) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i - 15; j < i; j++) { lo = Math.min(lo, closes[j]); hi = Math.max(hi, closes[j]); }
      donLo15[i] = lo;
      donHi15[i] = hi;
    }

    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = 61; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;
      const bar = bars[i];

      if (pos) {
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          pos.sl = Math.max(pos.sl, pos.peak - 3 * pos.atr);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          pos.sl = Math.min(pos.sl, pos.peak + 3 * pos.atr);
        }

        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && bar.t - pos.et >= 60 * DAY) { xp = bar.c; }
        if (!xp && pos.dir === "long" && bar.c < donLo15[i]) { xp = bar.c; }
        if (!xp && pos.dir === "short" && bar.c > donHi15[i]) { xp = bar.c; }

        if (xp) {
          trades.push({ pair, strategy: "ProxyDonch", dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL) });
          pos = null;
        }
        continue;
      }

      const atrVal = atrVals[i - 1];
      if (atrVal <= 0) continue;

      let dir: Dir | null = null;
      if (sma30[i - 2] <= sma60[i - 2] && sma30[i - 1] > sma60[i - 1]) {
        if (btcDailyBullish(bar.t)) dir = "long";
      }
      if (sma30[i - 2] >= sma60[i - 2] && sma30[i - 1] < sma60[i - 1]) dir = "short";
      if (!dir) continue;

      const sprd = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
      const slDist = capSL(ep, atrVal * 3);
      pos = { dir, ep, et: bar.t, sl: dir === "long" ? ep - slDist : ep + slDist, peak: ep, atr: atrVal };
    }

    if (pos) {
      const lb = bars[bars.length - 1];
      trades.push({ pair, strategy: "ProxyDonch", dir: pos.dir, ep: pos.ep, xp: lb.c, et: pos.et, xt: lb.t, pnl: calcPnl(pair, pos.ep, lb.c, pos.dir, false) });
    }
  }
  return trades;
}

function proxySupertrend4h(): Trade[] {
  const trades: Trade[] = [];
  for (const pair of available) {
    const pd = pairData.get(pair)!;
    const bars = pd.h4;
    if (bars.length < 30) continue;

    const atrVals = calcATR(bars, 14);
    // Supertrend inline
    const trend: (1 | -1)[] = new Array(bars.length).fill(1);
    let upperBand = 0, lowerBand = 0, prevTrend = 1;
    for (let i = 0; i < bars.length; i++) {
      if (atrVals[i] <= 0) continue;
      const hl2 = (bars[i].h + bars[i].l) / 2;
      let ub = hl2 + 2 * atrVals[i];
      let lb = hl2 - 2 * atrVals[i];
      if (i > 0) {
        if (lb <= lowerBand || bars[i - 1].c < lowerBand) { /* keep */ } else lb = lowerBand;
        if (ub >= upperBand || bars[i - 1].c > upperBand) { /* keep */ } else ub = upperBand;
      }
      let t: 1 | -1;
      if (prevTrend === 1) t = bars[i].c < lowerBand ? -1 : 1;
      else t = bars[i].c > upperBand ? 1 : -1;
      upperBand = ub; lowerBand = lb; prevTrend = t;
      trend[i] = t;
    }

    let pos: { dir: Dir; ep: number; et: number; sl: number; peak: number; atr: number } | null = null;

    for (let i = 15; i < bars.length; i++) {
      if (bars[i].t < FULL_START) continue;
      const bar = bars[i];

      if (pos) {
        if (pos.dir === "long") {
          pos.peak = Math.max(pos.peak, bar.h);
          pos.sl = Math.max(pos.sl, pos.peak - 3 * pos.atr);
        } else {
          pos.peak = Math.min(pos.peak, bar.l);
          pos.sl = Math.min(pos.sl, pos.peak + 3 * pos.atr);
        }

        let xp = 0, isSL = false;
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; isSL = true; }
        if (!xp && bar.t - pos.et >= 60 * DAY) { xp = bar.c; }
        // Supertrend flip exit
        if (!xp && pos.dir === "long" && trend[i] === -1) { xp = bar.c; }
        if (!xp && pos.dir === "short" && trend[i] === 1) { xp = bar.c; }

        if (xp) {
          trades.push({ pair, strategy: "ProxyST", dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pair, pos.ep, xp, pos.dir, isSL) });
          pos = null;
        }
        continue;
      }

      if (trend[i - 1] !== trend[i - 2]) {
        const dir: Dir = trend[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcH4Bullish(bar.t)) continue;
        const atrVal = atrVals[i - 1];
        if (atrVal <= 0) continue;
        const sprd = sp(pair);
        const ep = dir === "long" ? bar.o * (1 + sprd) : bar.o * (1 - sprd);
        const slDist = capSL(ep, atrVal * 3);
        pos = { dir, ep, et: bar.t, sl: dir === "long" ? ep - slDist : ep + slDist, peak: ep, atr: atrVal };
      }
    }

    if (pos) {
      const lb = bars[bars.length - 1];
      trades.push({ pair, strategy: "ProxyST", dir: pos.dir, ep: pos.ep, xp: lb.c, et: pos.et, xt: lb.t, pnl: calcPnl(pair, pos.ep, lb.c, pos.dir, false) });
    }
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════
// RUN ALL STRATEGIES
// ═══════════════════════════════════════════════════════════════════════
console.log("=".repeat(110));
console.log("  ENGINE F CANDIDATE BACKTEST - 6 Strategy Families");
console.log("  Cost: 0.035% taker, pair-specific spreads, 1.5x SL slippage, ATR stops");
console.log("  BTC 4h EMA(12/21) filter for longs, $5 margin, 10x leverage");
console.log("=".repeat(110));

console.log("\nRunning strategies...\n");

const results: { name: string; trades: Trade[]; stats: Stats }[] = [];

const strategies: [string, () => Trade[]][] = [
  ["BB-Squeeze (4h)", stratBBSqueeze],
  ["Ichimoku Cloud (daily)", stratIchimoku],
  ["VWAP Deviation (4h)", stratVWAPDev],
  ["Keltner Breakout (4h)", stratKeltner],
  ["Williams %R + Mom (4h)", stratWilliamsR],
  ["Dual Momentum (monthly)", stratDualMomentum],
];

for (const [name, fn] of strategies) {
  const t0 = Date.now();
  const trades = fn();
  const stats = calcStats(trades);
  results.push({ name, trades, stats });
  console.log(`  ${name}: ${trades.length} trades (${Date.now() - t0}ms)`);
}

// Proxy engines for correlation
console.log("\nRunning proxy engines for correlation...");
const proxyDonchTrades = proxyDonchianDaily();
const proxySTTrades = proxySupertrend4h();
console.log(`  ProxyDonchian: ${proxyDonchTrades.length} trades`);
console.log(`  ProxySupertrend: ${proxySTTrades.length} trades`);

const proxyDonchPnl = dailyPnlSeries(proxyDonchTrades);
const proxySTpnl = dailyPnlSeries(proxySTTrades);

// ─── Results Table ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  RESULTS SUMMARY");
console.log("=".repeat(110));

function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }

console.log(
  `${"Strategy".padEnd(28)} ${pad("Trades", 7)} ${pad("WR%", 7)} ${pad("PF", 6)} ` +
  `${pad("Sharpe", 7)} ${pad("$/day", 10)} ${pad("Total", 11)} ${pad("MaxDD", 9)} ` +
  `${pad("CorrDonch", 10)} ${pad("CorrST", 8)}`
);
console.log("-".repeat(110));

for (const { name, trades, stats } of results) {
  const dpnl = dailyPnlSeries(trades);
  const corrDonch = pearsonCorr(dpnl, proxyDonchPnl);
  const corrST = pearsonCorr(dpnl, proxySTpnl);

  console.log(
    `${name.padEnd(28)} ${pad(String(stats.n), 7)} ${pad(stats.wr.toFixed(1), 7)} ${pad(stats.pf === Infinity ? "Inf" : stats.pf.toFixed(2), 6)} ` +
    `${pad(stats.sharpe.toFixed(2), 7)} ${pad(fmtPnl(stats.perDay), 10)} ${pad(fmtPnl(stats.total), 11)} ${pad("$" + stats.dd.toFixed(0), 9)} ` +
    `${pad(corrDonch.toFixed(3), 10)} ${pad(corrST.toFixed(3), 8)}`
  );
}

// ─── Cross-Correlation Matrix ────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  CROSS-CORRELATION MATRIX (daily P&L)");
console.log("=".repeat(110));

const allSeries: { name: string; pnl: Map<number, number> }[] = [
  { name: "ProxyDonch", pnl: proxyDonchPnl },
  { name: "ProxyST", pnl: proxySTpnl },
  ...results.map(r => ({ name: r.name.slice(0, 14), pnl: dailyPnlSeries(r.trades) })),
];

// Header
const colWidth = 12;
process.stdout.write("".padEnd(16));
for (const s of allSeries) process.stdout.write(s.name.slice(0, colWidth).padStart(colWidth));
console.log();

for (const row of allSeries) {
  process.stdout.write(row.name.slice(0, 15).padEnd(16));
  for (const col of allSeries) {
    const corr = pearsonCorr(row.pnl, col.pnl);
    process.stdout.write(corr.toFixed(3).padStart(colWidth));
  }
  console.log();
}

// ─── Long/Short Breakdown ────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  LONG/SHORT BREAKDOWN");
console.log("=".repeat(110));
console.log(
  `${"Strategy".padEnd(28)} ${"Longs".padStart(7)} ${"LongWR%".padStart(8)} ${"LongPnL".padStart(10)} ` +
  `${"Shorts".padStart(7)} ${"ShortWR%".padStart(9)} ${"ShortPnL".padStart(10)}`
);
console.log("-".repeat(82));

for (const { name, trades } of results) {
  const longs = trades.filter(t => t.dir === "long");
  const shorts = trades.filter(t => t.dir === "short");
  const lwins = longs.filter(t => t.pnl > 0).length;
  const swins = shorts.filter(t => t.pnl > 0).length;
  const lpnl = longs.reduce((s, t) => s + t.pnl, 0);
  const spnl = shorts.reduce((s, t) => s + t.pnl, 0);

  console.log(
    `${name.padEnd(28)} ${pad(String(longs.length), 7)} ${pad(longs.length > 0 ? (lwins / longs.length * 100).toFixed(1) : "N/A", 8)} ${pad(fmtPnl(lpnl), 10)} ` +
    `${pad(String(shorts.length), 7)} ${pad(shorts.length > 0 ? (swins / shorts.length * 100).toFixed(1) : "N/A", 9)} ${pad(fmtPnl(spnl), 10)}`
  );
}

// ─── Per-Year Breakdown ──────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  PER-YEAR P&L");
console.log("=".repeat(110));

process.stdout.write("Strategy".padEnd(28));
for (const year of [2023, 2024, 2025, 2026]) process.stdout.write(pad(String(year), 12));
console.log();
console.log("-".repeat(76));

for (const { name, trades } of results) {
  process.stdout.write(name.padEnd(28));
  for (const year of [2023, 2024, 2025, 2026]) {
    const ys = new Date(`${year}-01-01`).getTime();
    const ye = new Date(`${year + 1}-01-01`).getTime();
    const yearTrades = trades.filter(t => t.xt >= ys && t.xt < ye);
    const pnl = yearTrades.reduce((s, t) => s + t.pnl, 0);
    process.stdout.write(pad(fmtPnl(pnl), 12));
  }
  console.log();
}

// ─── Top Pair Contributions ──────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  TOP PAIR CONTRIBUTIONS (per strategy)");
console.log("=".repeat(110));

for (const { name, trades } of results) {
  if (trades.length === 0) continue;
  const pairPnl = new Map<string, number>();
  const pairCount = new Map<string, number>();
  for (const t of trades) {
    pairPnl.set(t.pair, (pairPnl.get(t.pair) ?? 0) + t.pnl);
    pairCount.set(t.pair, (pairCount.get(t.pair) ?? 0) + 1);
  }
  const sorted = [...pairPnl.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${name}:`);
  for (const [pair, pnl] of sorted.slice(0, 5)) {
    const n = pairCount.get(pair) ?? 0;
    console.log(`    ${pair.padEnd(8)} ${fmtPnl(pnl).padStart(10)}  (${n} trades)`);
  }
  if (sorted.length > 5) {
    console.log(`    ...`);
    for (const [pair, pnl] of sorted.slice(-3)) {
      const n = pairCount.get(pair) ?? 0;
      console.log(`    ${pair.padEnd(8)} ${fmtPnl(pnl).padStart(10)}  (${n} trades)`);
    }
  }
}

// ─── Recommendation ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("  RECOMMENDATION");
console.log("=".repeat(110));

// Sort by $/day, filter positive PF
const viable = results
  .filter(r => r.stats.pf > 1.0 && r.stats.n >= 20)
  .sort((a, b) => b.stats.perDay - a.stats.perDay);

if (viable.length === 0) {
  console.log("\n  No strategies pass minimum viability threshold (PF>1.0, N>=20).");
  console.log("  All 6 families lose money or have insufficient trades after costs.\n");
} else {
  console.log(`\n  Viable candidates (PF>1.0, N>=20, sorted by $/day):\n`);
  for (const { name, stats } of viable) {
    const dpnl = dailyPnlSeries(results.find(r => r.name === name)!.trades);
    const corrD = pearsonCorr(dpnl, proxyDonchPnl);
    const corrS = pearsonCorr(dpnl, proxySTpnl);
    const lowCorr = Math.abs(corrD) < 0.15 && Math.abs(corrS) < 0.15;
    console.log(
      `  ${lowCorr ? "[LOW CORR]" : "[         ]"} ${name.padEnd(28)} ` +
      `PF=${stats.pf.toFixed(2)}  $/day=${fmtPnl(stats.perDay)}  WR=${stats.wr.toFixed(1)}%  ` +
      `MaxDD=$${stats.dd.toFixed(0)}  rDonch=${corrD.toFixed(3)}  rST=${corrS.toFixed(3)}`
    );
  }

  const best = viable[0];
  const bestDpnl = dailyPnlSeries(results.find(r => r.name === best.name)!.trades);
  const bestCorrD = pearsonCorr(bestDpnl, proxyDonchPnl);
  const bestCorrS = pearsonCorr(bestDpnl, proxySTpnl);
  console.log(`\n  Best candidate for Engine F: ${best.name}`);
  console.log(`    PF=${best.stats.pf.toFixed(2)}, $/day=${fmtPnl(best.stats.perDay)}, WR=${best.stats.wr.toFixed(1)}%, MaxDD=$${best.stats.dd.toFixed(0)}`);
  console.log(`    Correlation with Donchian: ${bestCorrD.toFixed(3)}, Supertrend: ${bestCorrS.toFixed(3)}`);
}

console.log("\n" + "=".repeat(110));
console.log("  DONE");
console.log("=".repeat(110));
