/**
 * BTC EMA Filter Sensitivity Analysis
 *
 * Tests a grid of BTC filter parameters on the Donchian + Supertrend ensemble.
 * Grid: 3 timeframes (daily, 4h, 1h) x 5 fast EMA x 5 slow EMA = 75 combos.
 *
 * Donchian: SMA(20/50) crossover, Donchian 15d exit, ATR(14)x3 stop, 60d max hold, $7 margin
 * Supertrend: ST(14,1.75) flip, ST flip exit, ATR(14)x3 stop, 60d max hold, $5 margin
 * Both 10x leverage, max 10 positions total, BTC filter longs only.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-btc-filter-sensitivity.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const MAX_POS = 10;
const SL_SLIP = 1.5;

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA",
  "DOGE","APT","LINK","ADA","WLD","XRP",
];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};
const DFLT_SP = 4e-4;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-23").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";

interface Position {
  pair: string;
  engine: "A" | "B";
  dir: Dir;
  ep: number;
  et: number;
  sl: number;
  maxHold: number;
  margin: number;
  atr: number;
  bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
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
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c });
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

function ema(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  // Seed with SMA of first `period` values
  let seedSum = 0;
  for (let i = 0; i < vals.length && i < period; i++) seedSum += vals[i];
  if (vals.length < period) return r;
  let v = seedSum / period;
  r[period - 1] = v;
  const k = 2 / (period + 1);
  for (let i = period; i < vals.length; i++) {
    v = vals[i] * k + v * (1 - k);
    r[i] = v;
  }
  return r;
}

function atr(bars: C[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c),
        );
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

function donchianLow(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, closes[j]);
    r[i] = mn;
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

function supertrend(bars: C[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atr(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (!(lb > lowerBand || bars[i - 1].c < lowerBand)) lb = lowerBand;
      if (!(ub < upperBand || bars[i - 1].c > upperBand)) ub = upperBand;
    }

    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return { trend };
}

// ─── Precomputed data ───────────────────────────────────────────────
interface PairDaily {
  cs: C[];
  sma20: (number | null)[];
  sma50: (number | null)[];
  atr14: (number | null)[];
  donLo15: (number | null)[];
  donHi15: (number | null)[];
  tsMap: Map<number, number>;
}

interface PairH4 {
  cs: C[];
  stTrend: (1 | -1 | null)[];
  atr14: (number | null)[];
  tsMap: Map<number, number>;
}

interface BTCBars {
  daily: C[];
  h4: C[];
  h1: C[];
  dailyMap: Map<number, number>;
  h4Map: Map<number, number>;
  h1Map: Map<number, number>;
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SP; }

// ─── Precompute BTC EMA grids ───────────────────────────────────────
const FAST_EMAS = [5, 9, 12, 15, 20];
const SLOW_EMAS = [15, 21, 30, 40, 50];
type TF = "daily" | "4h" | "1h";
const TFS: TF[] = ["daily", "4h", "1h"];

interface BTCFilterCache {
  // For each TF x fast x slow: precomputed bullish array (indexed by bar index)
  // btcBullish[tf][fast][slow] => boolean[] aligned to BTCBars bars for that TF
  daily: Map<string, boolean[]>;
  h4: Map<string, boolean[]>;
  h1: Map<string, boolean[]>;
}

function precomputeBTCFilters(btc: BTCBars): BTCFilterCache {
  const cache: BTCFilterCache = { daily: new Map(), h4: new Map(), h1: new Map() };

  for (const tf of TFS) {
    const bars = tf === "daily" ? btc.daily : tf === "4h" ? btc.h4 : btc.h1;
    const closes = bars.map(b => b.c);
    const target = tf === "daily" ? cache.daily : tf === "4h" ? cache.h4 : cache.h1;

    for (const fast of FAST_EMAS) {
      for (const slow of SLOW_EMAS) {
        if (fast >= slow) continue; // skip invalid combos
        const key = `${fast}/${slow}`;
        const emaFast = ema(closes, fast);
        const emaSlow = ema(closes, slow);
        const bullish: boolean[] = new Array(bars.length).fill(false);
        for (let i = 0; i < bars.length; i++) {
          const f = emaFast[i], s = emaSlow[i];
          if (f !== null && s !== null) bullish[i] = f > s;
        }
        target.set(key, bullish);
      }
    }
  }
  return cache;
}

// ─── Simulation ─────────────────────────────────────────────────────
function simulate(
  dailyPairs: Map<string, PairDaily>,
  h4Pairs: Map<string, PairH4>,
  btc: BTCBars,
  btcFilter: BTCFilterCache,
  filterTf: TF,
  filterFast: number,
  filterSlow: number,
): Trade[] {
  const filterKey = `${filterFast}/${filterSlow}`;
  const trades: Trade[] = [];
  const positions = new Map<string, Position>(); // key = "A:PAIR" or "B:PAIR"

  // BTC filter lookup: is BTC bullish at time t?
  function btcBullish(t: number): boolean {
    let bars: C[];
    let barMap: Map<number, number>;
    let bullArr: boolean[] | undefined;
    let period: number;

    if (filterTf === "daily") {
      bars = btc.daily; barMap = btc.dailyMap; period = DAY;
      bullArr = btcFilter.daily.get(filterKey);
    } else if (filterTf === "4h") {
      bars = btc.h4; barMap = btc.h4Map; period = H4;
      bullArr = btcFilter.h4.get(filterKey);
    } else {
      bars = btc.h1; barMap = btc.h1Map; period = H1;
      bullArr = btcFilter.h1.get(filterKey);
    }
    if (!bullArr) return false;

    // Find the most recent COMPLETED bar at or before t - period
    // (using previous bar to avoid look-ahead)
    const aligned = Math.floor(t / period) * period;
    const prevBar = aligned - period; // previous completed bar
    let idx = barMap.get(prevBar);
    if (idx !== undefined) return bullArr[idx];
    // Search backwards
    for (let dt = period; dt <= 10 * period; dt += period) {
      idx = barMap.get(prevBar - dt);
      if (idx !== undefined) return bullArr[idx];
    }
    return false;
  }

  function totalPos(): number { return positions.size; }

  function closePos(key: string, exitPrice: number, exitTime: number, slipMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slipMult)
      : exitPrice * (1 + sp_ * slipMult);
    const notional = pos.margin * 10;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    trades.push({
      pair: pos.pair, engine: pos.engine, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl: raw - cost,
    });
    positions.delete(key);
  }

  // Build daily timestamps
  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) dailyTimestamps.push(t);

  // Previous cross state for Donchian
  const prevCross = new Map<string, Dir | null>();
  // Previous ST direction for Supertrend
  const prevStDir = new Map<string, number>();

  for (const dayT of dailyTimestamps) {

    // ─── EXIT CHECKS ────────────────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      if (pos.engine === "A") {
        // Check against daily bar
        const pd = dailyPairs.get(pos.pair);
        if (!pd) continue;
        const di = pd.tsMap.get(dayT);
        if (di === undefined) continue;
        const bar = pd.cs[di];

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { closePos(key, pos.sl, dayT, SL_SLIP); continue; }
        if (pos.dir === "short" && bar.h >= pos.sl) { closePos(key, pos.sl, dayT, SL_SLIP); continue; }

        // Max hold
        if (dayT - pos.et >= pos.maxHold) { closePos(key, bar.c, dayT); continue; }

        // ATR trailing stop
        if (pos.atr > 0) {
          const unrealAtr = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.atr
            : (pos.ep - bar.c) / pos.atr;
          if (unrealAtr > pos.bestPnlAtr) pos.bestPnlAtr = unrealAtr;

          let newSl = pos.sl;
          if (pos.bestPnlAtr >= 3) {
            const trail = pos.dir === "long"
              ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
              : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
          } else if (pos.bestPnlAtr >= 2) {
            const trail = pos.dir === "long" ? bar.h - 2 * pos.atr : bar.l + 2 * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
          } else if (pos.bestPnlAtr >= 1) {
            newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
          }
          pos.sl = newSl;
        }

        // Donchian channel exit
        if (pos.dir === "long" && pd.donLo15[di] !== null && bar.c < pd.donLo15[di]!) {
          closePos(key, bar.c, dayT); continue;
        }
        if (pos.dir === "short" && pd.donHi15[di] !== null && bar.c > pd.donHi15[di]!) {
          closePos(key, bar.c, dayT); continue;
        }
      }

      if (pos.engine === "B") {
        // Check at each 4h boundary within the day
        const pd4 = h4Pairs.get(pos.pair);
        if (!pd4) continue;

        let closed = false;
        for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
          const h4T = dayT + h4Off;
          const hi = pd4.tsMap.get(h4T);
          if (hi === undefined) continue;
          const bar = pd4.cs[hi];

          // SL
          if (pos.dir === "long" && bar.l <= pos.sl) { closePos(key, pos.sl, h4T, SL_SLIP); closed = true; break; }
          if (pos.dir === "short" && bar.h >= pos.sl) { closePos(key, pos.sl, h4T, SL_SLIP); closed = true; break; }

          // Max hold
          if (h4T - pos.et >= pos.maxHold) { closePos(key, bar.c, h4T); closed = true; break; }

          // ATR trailing
          if (pos.atr > 0) {
            const unrealAtr = pos.dir === "long"
              ? (bar.c - pos.ep) / pos.atr
              : (pos.ep - bar.c) / pos.atr;
            if (unrealAtr > pos.bestPnlAtr) pos.bestPnlAtr = unrealAtr;

            let newSl = pos.sl;
            if (pos.bestPnlAtr >= 3) {
              const trail = pos.dir === "long"
                ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
                : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
              newSl = pos.dir === "long" ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
            } else if (pos.bestPnlAtr >= 2) {
              const trail = pos.dir === "long" ? bar.h - 2 * pos.atr : bar.l + 2 * pos.atr;
              newSl = pos.dir === "long" ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
            } else if (pos.bestPnlAtr >= 1) {
              newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
            }
            pos.sl = newSl;
          }

          // Supertrend flip exit
          if (hi >= 1) {
            const stNow = pd4.stTrend[hi];
            const stPrev = pd4.stTrend[hi - 1];
            if (stNow !== null && stPrev !== null && stNow !== stPrev) {
              // Flip happened - close if wrong side
              if (pos.dir === "long" && stNow === -1) { closePos(key, bar.c, h4T); closed = true; break; }
              if (pos.dir === "short" && stNow === 1) { closePos(key, bar.c, h4T); closed = true; break; }
            }
          }
        }
        if (closed) continue;
      }
    }

    // ─── ENGINE A: Daily Donchian Trend ─────────────────────────
    for (const p of PAIRS) {
      if (totalPos() >= MAX_POS) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;

      const pd = dailyPairs.get(p);
      if (!pd) continue;
      const di = pd.tsMap.get(dayT);
      if (di === undefined || di < 51) continue;

      const bar = pd.cs[di];
      const sma20now = pd.sma20[di - 1], sma50now = pd.sma50[di - 1];
      const sma20prev = pd.sma20[di - 2], sma50prev = pd.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      // Golden cross
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        if (btcBullish(dayT)) dir = "long";
      }
      // Death cross (no BTC filter for shorts)
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = pd.atr14[di - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, engine: "A", dir, ep, et: dayT, sl,
        maxHold: 60 * DAY, margin: 7, atr: atrVal, bestPnlAtr: 0,
      });
    }

    // ─── ENGINE B: 4h Supertrend ────────────────────────────────
    for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
      const h4T = dayT + h4Off;
      for (const p of PAIRS) {
        if (totalPos() >= MAX_POS) break;
        const key = `B:${p}`;
        if (positions.has(key)) continue;

        const pd4 = h4Pairs.get(p);
        if (!pd4) continue;
        const hi = pd4.tsMap.get(h4T);
        if (hi === undefined || hi < 21) continue;

        // Supertrend flip
        const stNow = pd4.stTrend[hi - 1];
        const stPrev = pd4.stTrend[hi - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;

        const dir: Dir = stNow === 1 ? "long" : "short";

        // BTC filter for longs only
        if (dir === "long" && !btcBullish(h4T)) continue;

        const atrVal = pd4.atr14[hi - 1];
        if (atrVal === null) continue;

        const sp_ = sp(p);
        const ep = dir === "long" ? pd4.cs[hi].o * (1 + sp_) : pd4.cs[hi].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        positions.set(key, {
          pair: p, engine: "B", dir, ep, et: h4T, sl,
          maxHold: 60 * DAY, margin: 5, atr: atrVal, bestPnlAtr: 0,
        });
      }
    }
  }

  // Close remaining positions at last bar
  for (const [key, pos] of [...positions.entries()]) {
    const pd = dailyPairs.get(pos.pair);
    if (pd && pd.cs.length > 0) {
      closePos(key, pd.cs[pd.cs.length - 1].c, pd.cs[pd.cs.length - 1].t);
    }
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
function computeStats(trades: Trade[], startMs: number, endMs: number) {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return { trades: 0, perDay: 0, maxDd: 0, pf: 0, wr: 0, totalPnl: 0 };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const wr = filtered.length > 0 ? wins.length / filtered.length * 100 : 0;
  const days = (endMs - startMs) / DAY;
  const perDay = totalPnl / days;

  // Max drawdown
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: filtered.length,
    perDay: Math.round(perDay * 100) / 100,
    maxDd: Math.round(maxDd * 100) / 100,
    pf: Math.round(pf * 100) / 100,
    wr: Math.round(wr * 10) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m data...");

// Load BTC
const btcRaw = load5m("BTC");
if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }
const btcBars: BTCBars = {
  daily: aggregate(btcRaw, DAY),
  h4: aggregate(btcRaw, H4),
  h1: aggregate(btcRaw, H1),
  dailyMap: new Map(),
  h4Map: new Map(),
  h1Map: new Map(),
};
btcBars.daily.forEach((b, i) => btcBars.dailyMap.set(b.t, i));
btcBars.h4.forEach((b, i) => btcBars.h4Map.set(b.t, i));
btcBars.h1.forEach((b, i) => btcBars.h1Map.set(b.t, i));
console.log(`BTC: ${btcBars.daily.length} daily, ${btcBars.h4.length} 4h, ${btcBars.h1.length} 1h bars`);

// Precompute BTC filters
console.log("Precomputing BTC EMA grids (75 combos across 3 TFs)...");
const btcFilterCache = precomputeBTCFilters(btcBars);

// Load pairs
const dailyPairs = new Map<string, PairDaily>();
const h4Pairs = new Map<string, PairH4>();
let loaded = 0;

for (const p of PAIRS) {
  const raw = load5m(p);
  if (raw.length < 500) { console.log(`  ${p}: skipped (${raw.length} bars)`); continue; }
  loaded++;

  const daily = aggregate(raw, DAY);
  const closes = daily.map(b => b.c);
  dailyPairs.set(p, {
    cs: daily,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    atr14: atr(daily, 14),
    donLo15: donchianLow(closes, 15),
    donHi15: donchianHigh(closes, 15),
    tsMap: new Map(daily.map((b, i) => [b.t, i])),
  });

  const h4 = aggregate(raw, H4);
  h4Pairs.set(p, {
    cs: h4,
    stTrend: supertrend(h4, 14, 1.75).trend,
    atr14: atr(h4, 14),
    tsMap: new Map(h4.map((b, i) => [b.t, i])),
  });
}
console.log(`Loaded ${loaded}/${PAIRS.length} pairs\n`);

// ─── Run Grid ───────────────────────────────────────────────────────
interface Result {
  tf: TF;
  fast: number;
  slow: number;
  fullPerDay: number;
  fullMaxDd: number;
  fullTrades: number;
  fullPf: number;
  fullWr: number;
  oosPerDay: number;
  oosTrades: number;
}

const results: Result[] = [];
let done = 0;
const validCombos: number[] = [];
for (const fast of FAST_EMAS) {
  for (const slow of SLOW_EMAS) {
    if (fast < slow) validCombos.push(1);
  }
}
const totalCombos = validCombos.length * TFS.length;

console.log(`Running ${totalCombos} valid BTC filter combos...\n`);

for (const tf of TFS) {
  for (const fast of FAST_EMAS) {
    for (const slow of SLOW_EMAS) {
      if (fast >= slow) continue; // skip invalid

      done++;
      if (done % 10 === 0 || done === 1) {
        process.stdout.write(`  ${done}/${totalCombos}\r`);
      }

      const trades = simulate(dailyPairs, h4Pairs, btcBars, btcFilterCache, tf, fast, slow);
      const full = computeStats(trades, FULL_START, FULL_END);
      const oos = computeStats(trades, OOS_START, FULL_END);

      results.push({
        tf, fast, slow,
        fullPerDay: full.perDay,
        fullMaxDd: full.maxDd,
        fullTrades: full.trades,
        fullPf: full.pf,
        fullWr: full.wr,
        oosPerDay: oos.perDay,
        oosTrades: oos.trades,
      });
    }
  }
}

console.log(`\nDone. ${results.length} results.\n`);

// ─── Also run "no filter" baseline ──────────────────────────────────
// Simulate with a filter that's always bullish (fast=1/slow=2 effectively always true? no, use a special run)
// Instead just set a very fast EMA that will almost always show bullish: use daily 5/15 but invert logic
// Better: run a dedicated baseline where btcBullish always returns true.
// We'll do that by temporarily using an impossible filter (not clean but practical).
// Actually let's just run a baseline simulation inline.

function simulateNoFilter(
  dailyPs: Map<string, PairDaily>,
  h4Ps: Map<string, PairH4>,
): Trade[] {
  const trades: Trade[] = [];
  const positions = new Map<string, Position>();

  function totalPos(): number { return positions.size; }

  function closePos(key: string, exitPrice: number, exitTime: number, slipMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slipMult)
      : exitPrice * (1 + sp_ * slipMult);
    const notional = pos.margin * 10;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    trades.push({
      pair: pos.pair, engine: "A" as any, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl: raw - cost,
    });
    positions.delete(key);
  }

  const dailyTimestamps: number[] = [];
  for (let t = FULL_START; t < FULL_END; t += DAY) dailyTimestamps.push(t);

  for (const dayT of dailyTimestamps) {
    // Exits (same logic)
    for (const [key, pos] of [...positions.entries()]) {
      if (pos.engine === "A") {
        const pd = dailyPs.get(pos.pair);
        if (!pd) continue;
        const di = pd.tsMap.get(dayT);
        if (di === undefined) continue;
        const bar = pd.cs[di];
        if (pos.dir === "long" && bar.l <= pos.sl) { closePos(key, pos.sl, dayT, SL_SLIP); continue; }
        if (pos.dir === "short" && bar.h >= pos.sl) { closePos(key, pos.sl, dayT, SL_SLIP); continue; }
        if (dayT - pos.et >= pos.maxHold) { closePos(key, bar.c, dayT); continue; }
        if (pos.atr > 0) {
          const u = pos.dir === "long" ? (bar.c - pos.ep) / pos.atr : (pos.ep - bar.c) / pos.atr;
          if (u > pos.bestPnlAtr) pos.bestPnlAtr = u;
          let newSl = pos.sl;
          if (pos.bestPnlAtr >= 3) {
            const tr = pos.dir === "long" ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, tr) : Math.min(pos.sl, tr);
          } else if (pos.bestPnlAtr >= 2) {
            const tr = pos.dir === "long" ? bar.h - 2 * pos.atr : bar.l + 2 * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, tr) : Math.min(pos.sl, tr);
          } else if (pos.bestPnlAtr >= 1) {
            newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
          }
          pos.sl = newSl;
        }
        if (pos.dir === "long" && pd.donLo15[di] !== null && bar.c < pd.donLo15[di]!) { closePos(key, bar.c, dayT); continue; }
        if (pos.dir === "short" && pd.donHi15[di] !== null && bar.c > pd.donHi15[di]!) { closePos(key, bar.c, dayT); continue; }
      }
      if (pos.engine === "B") {
        const pd4 = h4Ps.get(pos.pair);
        if (!pd4) continue;
        let closed = false;
        for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
          const h4T = dayT + h4Off;
          const hi = pd4.tsMap.get(h4T);
          if (hi === undefined) continue;
          const bar = pd4.cs[hi];
          if (pos.dir === "long" && bar.l <= pos.sl) { closePos(key, pos.sl, h4T, SL_SLIP); closed = true; break; }
          if (pos.dir === "short" && bar.h >= pos.sl) { closePos(key, pos.sl, h4T, SL_SLIP); closed = true; break; }
          if (h4T - pos.et >= pos.maxHold) { closePos(key, bar.c, h4T); closed = true; break; }
          if (pos.atr > 0) {
            const u = pos.dir === "long" ? (bar.c - pos.ep) / pos.atr : (pos.ep - bar.c) / pos.atr;
            if (u > pos.bestPnlAtr) pos.bestPnlAtr = u;
            let newSl = pos.sl;
            if (pos.bestPnlAtr >= 3) {
              const tr = pos.dir === "long" ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
              newSl = pos.dir === "long" ? Math.max(pos.sl, tr) : Math.min(pos.sl, tr);
            } else if (pos.bestPnlAtr >= 2) {
              const tr = pos.dir === "long" ? bar.h - 2 * pos.atr : bar.l + 2 * pos.atr;
              newSl = pos.dir === "long" ? Math.max(pos.sl, tr) : Math.min(pos.sl, tr);
            } else if (pos.bestPnlAtr >= 1) {
              newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
            }
            pos.sl = newSl;
          }
          if (hi >= 1) {
            const stNow = pd4.stTrend[hi], stPrev = pd4.stTrend[hi - 1];
            if (stNow !== null && stPrev !== null && stNow !== stPrev) {
              if (pos.dir === "long" && stNow === -1) { closePos(key, bar.c, h4T); closed = true; break; }
              if (pos.dir === "short" && stNow === 1) { closePos(key, bar.c, h4T); closed = true; break; }
            }
          }
        }
        if (closed) continue;
      }
    }

    // Engine A entries - longs always allowed (no filter)
    for (const p of PAIRS) {
      if (totalPos() >= MAX_POS) break;
      const key = `A:${p}`;
      if (positions.has(key)) continue;
      const pd = dailyPs.get(p);
      if (!pd) continue;
      const di = pd.tsMap.get(dayT);
      if (di === undefined || di < 51) continue;
      const bar = pd.cs[di];
      const sma20now = pd.sma20[di - 1], sma50now = pd.sma50[di - 1];
      const sma20prev = pd.sma20[di - 2], sma50prev = pd.sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;
      let dir: Dir | null = null;
      if (sma20prev <= sma50prev && sma20now > sma50now) dir = "long";
      if (sma20prev >= sma50prev && sma20now < sma50now) dir = "short";
      if (!dir) continue;
      const atrVal = pd.atr14[di - 1];
      if (atrVal === null) continue;
      const sp_ = sp(p);
      const ep = dir === "long" ? bar.o * (1 + sp_) : bar.o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      positions.set(key, { pair: p, engine: "A", dir, ep, et: dayT, sl, maxHold: 60 * DAY, margin: 7, atr: atrVal, bestPnlAtr: 0 });
    }

    // Engine B entries - longs always allowed (no filter)
    for (let h4Off = 0; h4Off < DAY; h4Off += H4) {
      const h4T = dayT + h4Off;
      for (const p of PAIRS) {
        if (totalPos() >= MAX_POS) break;
        const key = `B:${p}`;
        if (positions.has(key)) continue;
        const pd4 = h4Ps.get(p);
        if (!pd4) continue;
        const hi = pd4.tsMap.get(h4T);
        if (hi === undefined || hi < 21) continue;
        const stNow = pd4.stTrend[hi - 1], stPrev = pd4.stTrend[hi - 2];
        if (stNow === null || stPrev === null || stNow === stPrev) continue;
        const dir: Dir = stNow === 1 ? "long" : "short";
        const atrVal = pd4.atr14[hi - 1];
        if (atrVal === null) continue;
        const sp_ = sp(p);
        const ep = dir === "long" ? pd4.cs[hi].o * (1 + sp_) : pd4.cs[hi].o * (1 - sp_);
        let slDist = atrVal * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        positions.set(key, { pair: p, engine: "B", dir, ep, et: h4T, sl, maxHold: 60 * DAY, margin: 5, atr: atrVal, bestPnlAtr: 0 });
      }
    }
  }

  for (const [key, pos] of [...positions.entries()]) {
    const pd = dailyPs.get(pos.pair);
    if (pd && pd.cs.length > 0) closePos(key, pd.cs[pd.cs.length - 1].c, pd.cs[pd.cs.length - 1].t);
  }
  return trades;
}

// Run baseline
console.log("Running no-filter baseline...");
const baselineTrades = simulateNoFilter(dailyPairs, h4Pairs);
const baseFull = computeStats(baselineTrades, FULL_START, FULL_END);
const baseOos = computeStats(baselineTrades, OOS_START, FULL_END);

// ─── Output ─────────────────────────────────────────────────────────
console.log("=".repeat(110));
console.log("  BTC EMA FILTER SENSITIVITY ANALYSIS");
console.log("  Donchian SMA(20/50) $7 + Supertrend(14,1.75) $5, 10x, 14 pairs");
console.log("  Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("=".repeat(110));

console.log(`\nBASELINE (no BTC filter): Full $${baseFull.perDay}/d MaxDD $${baseFull.maxDd} PF ${baseFull.pf} WR ${baseFull.wr}% | OOS $${baseOos.perDay}/d ${baseOos.trades}t`);

// Sort by full $/day descending
results.sort((a, b) => b.fullPerDay - a.fullPerDay);

// 1. Top 20 overall
console.log("\n" + "=".repeat(110));
console.log("  TOP 20 BY FULL-PERIOD $/DAY");
console.log("=".repeat(110));
console.log(
  "Rank  TF      Fast  Slow    $/day   MaxDD     PF    WR%   Trades  |  OOS $/day  OOS trades"
);
console.log("-".repeat(110));
for (let i = 0; i < Math.min(20, results.length); i++) {
  const r = results[i];
  const mark = (r.tf === "daily" && r.fast === 20 && r.slow === 50) ? " <<< LIVE"
    : (r.tf === "4h" && r.fast === 9 && r.slow === 21) ? " <<< ASKED"
    : "";
  console.log(
    `${String(i + 1).padStart(3)}   ${r.tf.padEnd(6)} ${String(r.fast).padStart(4)}  ${String(r.slow).padStart(4)}   ${("$" + r.fullPerDay.toFixed(2)).padStart(7)}  ${("$" + r.fullMaxDd.toFixed(0)).padStart(6)}  ${String(r.fullPf).padStart(5)}  ${String(r.fullWr).padStart(5)}   ${String(r.fullTrades).padStart(6)}  |  ${("$" + r.oosPerDay.toFixed(2)).padStart(8)}  ${String(r.oosTrades).padStart(10)}${mark}`
  );
}

// 2. Heatmaps per timeframe
for (const tf of TFS) {
  console.log("\n" + "=".repeat(80));
  console.log(`  HEATMAP: ${tf.toUpperCase()} - Full-period $/day`);
  console.log("=".repeat(80));

  // Header row: slow EMAs
  let header = "Fast\\Slow";
  for (const slow of SLOW_EMAS) header += `  ${String(slow).padStart(7)}`;
  console.log(header);
  console.log("-".repeat(50));

  for (const fast of FAST_EMAS) {
    let row = `   ${String(fast).padStart(3)}  `;
    for (const slow of SLOW_EMAS) {
      if (fast >= slow) {
        row += `       -`;
      } else {
        const r = results.find(x => x.tf === tf && x.fast === fast && x.slow === slow);
        if (r) {
          row += `  ${("$" + r.fullPerDay.toFixed(2)).padStart(7)}`;
        } else {
          row += `       ?`;
        }
      }
    }
    console.log(row);
  }
}

// 3. OOS heatmaps
for (const tf of TFS) {
  console.log("\n" + "=".repeat(80));
  console.log(`  HEATMAP: ${tf.toUpperCase()} - OOS $/day (2025-09+)`);
  console.log("=".repeat(80));

  let header = "Fast\\Slow";
  for (const slow of SLOW_EMAS) header += `  ${String(slow).padStart(7)}`;
  console.log(header);
  console.log("-".repeat(50));

  for (const fast of FAST_EMAS) {
    let row = `   ${String(fast).padStart(3)}  `;
    for (const slow of SLOW_EMAS) {
      if (fast >= slow) {
        row += `       -`;
      } else {
        const r = results.find(x => x.tf === tf && x.fast === fast && x.slow === slow);
        if (r) {
          row += `  ${("$" + r.oosPerDay.toFixed(2)).padStart(7)}`;
        } else {
          row += `       ?`;
        }
      }
    }
    console.log(row);
  }
}

// 4. MaxDD heatmaps
for (const tf of TFS) {
  console.log("\n" + "=".repeat(80));
  console.log(`  HEATMAP: ${tf.toUpperCase()} - MaxDD $`);
  console.log("=".repeat(80));

  let header = "Fast\\Slow";
  for (const slow of SLOW_EMAS) header += `  ${String(slow).padStart(7)}`;
  console.log(header);
  console.log("-".repeat(50));

  for (const fast of FAST_EMAS) {
    let row = `   ${String(fast).padStart(3)}  `;
    for (const slow of SLOW_EMAS) {
      if (fast >= slow) {
        row += `       -`;
      } else {
        const r = results.find(x => x.tf === tf && x.fast === fast && x.slow === slow);
        if (r) {
          row += `  ${("$" + r.fullMaxDd.toFixed(0)).padStart(7)}`;
        } else {
          row += `       ?`;
        }
      }
    }
    console.log(row);
  }
}

// 5. Analysis summary
console.log("\n" + "=".repeat(110));
console.log("  ANALYSIS SUMMARY");
console.log("=".repeat(110));

// Best per TF
for (const tf of TFS) {
  const tfResults = results.filter(r => r.tf === tf);
  if (tfResults.length === 0) continue;
  const best = tfResults[0]; // already sorted by fullPerDay
  const bestOos = [...tfResults].sort((a, b) => b.oosPerDay - a.oosPerDay)[0];
  console.log(`\n${tf.toUpperCase()} best full: EMA(${best.fast}/${best.slow}) $${best.fullPerDay}/d, MaxDD $${best.fullMaxDd}, OOS $${best.oosPerDay}/d`);
  console.log(`${tf.toUpperCase()} best OOS:  EMA(${bestOos.fast}/${bestOos.slow}) $${bestOos.oosPerDay}/d (full $${bestOos.fullPerDay}/d)`);
}

// TF comparison: avg $/day per TF
for (const tf of TFS) {
  const tfResults = results.filter(r => r.tf === tf);
  const avgFull = tfResults.reduce((s, r) => s + r.fullPerDay, 0) / tfResults.length;
  const avgOos = tfResults.reduce((s, r) => s + r.oosPerDay, 0) / tfResults.length;
  const avgDd = tfResults.reduce((s, r) => s + r.fullMaxDd, 0) / tfResults.length;
  console.log(`\n${tf.toUpperCase()} avg across all combos: $${avgFull.toFixed(2)}/d full, $${avgOos.toFixed(2)}/d OOS, $${avgDd.toFixed(0)} avgMaxDD`);
}

// Cliff-edge check: find live config (daily 20/50) and neighbors
console.log("\n--- Cliff-edge check around LIVE config: daily EMA(20/50) ---");
const liveResult = results.find(r => r.tf === "daily" && r.fast === 20 && r.slow === 50);
if (liveResult) {
  console.log(`LIVE: daily EMA(20/50) -> $${liveResult.fullPerDay}/d, OOS $${liveResult.oosPerDay}/d, MaxDD $${liveResult.fullMaxDd}`);
  // Nearby: daily 15/40, 15/50, 20/40
  for (const [f, s] of [[15, 40], [15, 50], [12, 40], [12, 50], [20, 40]]) {
    const nb = results.find(r => r.tf === "daily" && r.fast === f && r.slow === s);
    if (nb) console.log(`  EMA(${f}/${s}): $${nb.fullPerDay}/d, OOS $${nb.oosPerDay}/d, MaxDD $${nb.fullMaxDd}`);
  }
}

// Cliff-edge check: 4h 9/21 and neighbors
console.log("\n--- Cliff-edge check around 4h EMA(9/21) ---");
const asked = results.find(r => r.tf === "4h" && r.fast === 9 && r.slow === 21);
if (asked) {
  console.log(`4h EMA(9/21): $${asked.fullPerDay}/d, OOS $${asked.oosPerDay}/d, MaxDD $${asked.fullMaxDd}`);
  for (const [f, s] of [[5, 15], [5, 21], [9, 15], [9, 30], [12, 21], [12, 30], [15, 30]]) {
    const nb = results.find(r => r.tf === "4h" && r.fast === f && r.slow === s);
    if (nb) console.log(`  EMA(${f}/${s}): $${nb.fullPerDay}/d, OOS $${nb.oosPerDay}/d, MaxDD $${nb.fullMaxDd}`);
  }
}

// Q2: Timeframe vs periods disentangled
console.log("\n--- Q2: Timeframe vs Period importance ---");
// Same periods (e.g. 9/21) across all TFs
for (const [f, s] of [[9, 21], [12, 30], [20, 50], [5, 15]]) {
  if (f >= s) continue;
  console.log(`  EMA(${f}/${s}):`);
  for (const tf of TFS) {
    const r = results.find(x => x.tf === tf && x.fast === f && x.slow === s);
    if (r) console.log(`    ${tf.padEnd(6)}: $${r.fullPerDay}/d, OOS $${r.oosPerDay}/d, MaxDD $${r.fullMaxDd}`);
  }
}

// Q3: Absolute best combo
const absBest = results[0];
console.log(`\nAbsolute best: ${absBest.tf} EMA(${absBest.fast}/${absBest.slow}) -> $${absBest.fullPerDay}/d, MaxDD $${absBest.fullMaxDd}, OOS $${absBest.oosPerDay}/d`);
const absBestOos = [...results].sort((a, b) => b.oosPerDay - a.oosPerDay)[0];
console.log(`Best by OOS: ${absBestOos.tf} EMA(${absBestOos.fast}/${absBestOos.slow}) -> OOS $${absBestOos.oosPerDay}/d (full $${absBestOos.fullPerDay}/d, MaxDD $${absBestOos.fullMaxDd})`);

// Q4: Count how many combos are within 20% of best
const threshold = absBest.fullPerDay * 0.8;
const robustCount = results.filter(r => r.fullPerDay >= threshold).length;
console.log(`\n${robustCount}/${results.length} combos within 20% of best (robust zone)`);

// Profitable combos
const profitableCount = results.filter(r => r.fullPerDay > 0).length;
console.log(`${profitableCount}/${results.length} combos profitable`);
const oosProfitable = results.filter(r => r.oosPerDay > 0).length;
console.log(`${oosProfitable}/${results.length} combos OOS profitable`);
