/**
 * Pullback Analysis: What separates normal pullbacks from reversals?
 *
 * Uses Donchian SMA(20/50) daily + Supertrend(14,1.75) 4h to generate trades,
 * then walks 1m bars within each trade to track every pullback from peak.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-pullback-analysis.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const CACHE_1M = "/tmp/bt-pair-cache-1m";
const M1 = 60_000;
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 5;
const NOT = MARGIN * LEV; // $50 notional
const SL_SLIP = 1.5;
const MAX_SL_PCT = 0.035;

const FULL_START = new Date("2023-06-01").getTime();
const FULL_END = new Date("2026-03-25").getTime();

const PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SOL: 2.0e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;
function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
type Dir = "long" | "short";

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number;
  pnl: number; slPrice: number;
}

interface Pullback {
  tradeIdx: number;
  depth: number;       // % from peak, LEVERAGED (so 10% means 10% of position value)
  peakPnlPct: number;  // peak P&L in leveraged % at time of pullback start
  recovered: boolean;  // did price make a new high after this pullback?
  terminal: boolean;   // was this the last pullback before exit?
  durationMs: number;  // how long the pullback lasted
  timeFromEntry: number; // ms from entry to pullback start
}

interface Position {
  pair: string; engine: string; dir: Dir;
  ep: number; et: number; sl: number;
  atr: number;
  bestPnlAtr: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function load1m(pair: string): C[] {
  const fp = path.join(CACHE_1M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

// ─── Aggregation ────────────────────────────────────────────────────
interface Bar { t: number; o: number; h: number; l: number; c: number; }

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
    let hi = -Infinity, lo = Infinity;
    for (const c of cs) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators (from scratch, no library needed) ───────────────────
function calcSMA(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function calcEMA(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  // Seed with SMA
  let v = 0;
  let seeded = false;
  for (let i = 0; i < vals.length; i++) {
    if (i < period - 1) continue;
    if (!seeded) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += vals[j];
      v = s / period;
      r[i] = v;
      seeded = true;
    } else {
      v = vals[i] * k + v * (1 - k);
      r[i] = v;
    }
  }
  return r;
}

function calcATR(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
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

function calcSupertrend(bars: Bar[], atrPeriod: number, mult: number): (1 | -1 | null)[] {
  const atrVals = calcATR(bars, atrPeriod);
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
    if (prevTrend === 1) { t = bars[i].c < lowerBand ? -1 : 1; }
    else { t = bars[i].c > upperBand ? 1 : -1; }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return trend;
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

// ─── Step 1: Generate All Trades ────────────────────────────────────
function generateTrades(): Trade[] {
  console.log("Loading 5m data and computing indicators...");

  // Load BTC for filter
  const btcRaw = load5m("BTC");
  const btcDaily = aggregate(btcRaw, DAY);
  const btcDailyCloses = btcDaily.map(b => b.c);
  const btcEma20 = calcEMA(btcDailyCloses, 20);
  const btcEma50 = calcEMA(btcDailyCloses, 50);
  const btcDailyMap = new Map(btcDaily.map((b, i) => [b.t, i]));

  function btcBullish(t: number): boolean {
    // Look at PREVIOUS day (no look-ahead)
    const dayTs = Math.floor(t / DAY) * DAY;
    // Find the daily bar at or before dayTs - DAY
    let bestIdx = -1;
    for (let dt = DAY; dt <= 5 * DAY; dt += DAY) {
      const idx = btcDailyMap.get(dayTs - dt);
      if (idx !== undefined) { bestIdx = idx; break; }
    }
    if (bestIdx < 0) return false;
    const e20 = btcEma20[bestIdx], e50 = btcEma50[bestIdx];
    return e20 !== null && e50 !== null && e20 > e50;
  }

  const allTrades: Trade[] = [];

  for (const pair of PAIRS) {
    const raw5m = load5m(pair);
    if (raw5m.length < 500) continue;

    const daily = aggregate(raw5m, DAY);
    const h4 = aggregate(raw5m, H4);

    // Engine A: Daily SMA(20/50) cross
    const dc = daily.map(b => b.c);
    const sma20 = calcSMA(dc, 20);
    const sma50 = calcSMA(dc, 50);
    const donLo15 = donchianLow(dc, 15);
    const donHi15 = donchianHigh(dc, 15);
    const atr14d = calcATR(daily, 14);
    const dailyMap = new Map(daily.map((b, i) => [b.t, i]));

    // Engine B: 4h Supertrend(14, 1.75)
    const st = calcSupertrend(h4, 14, 1.75);
    const atr14h4 = calcATR(h4, 14);
    const h4Map = new Map(h4.map((b, i) => [b.t, i]));

    // ── Engine A trades ──
    const posA: Position[] = [];
    for (let di = 52; di < daily.length; di++) {
      const dayT = daily[di].t;
      if (dayT < FULL_START || dayT >= FULL_END) continue;
      const bar = daily[di];

      // Check existing position exits first
      for (let pi = posA.length - 1; pi >= 0; pi--) {
        const pos = posA[pi];
        let exitPrice = 0;
        let reason = "";

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { exitPrice = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { exitPrice = pos.sl; reason = "sl"; }

        // Donchian exit
        if (!reason && donLo15[di] !== null && pos.dir === "long" && bar.c < donLo15[di]!) {
          exitPrice = bar.c; reason = "donch";
        }
        if (!reason && donHi15[di] !== null && pos.dir === "short" && bar.c > donHi15[di]!) {
          exitPrice = bar.c; reason = "donch";
        }

        // Max hold 60d
        if (!reason && dayT - pos.et >= 60 * DAY) { exitPrice = bar.c; reason = "maxhold"; }

        // ATR trailing stop management
        if (!reason && pos.atr > 0) {
          const unrealPnl = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.atr
            : (pos.ep - bar.c) / pos.atr;
          if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

          let newSl = pos.sl;
          if (pos.bestPnlAtr >= 3) {
            const trailPrice = pos.dir === "long"
              ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
              : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
          } else if (pos.bestPnlAtr >= 2) {
            const trailPrice = pos.dir === "long"
              ? bar.h - 2 * pos.atr
              : bar.l + 2 * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
          } else if (pos.bestPnlAtr >= 1) {
            newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
          }
          pos.sl = newSl;
        }

        if (exitPrice > 0) {
          const spv = sp(pair);
          const slipMult = reason === "sl" ? SL_SLIP : 1;
          const xp = pos.dir === "long" ? exitPrice * (1 - spv * slipMult) : exitPrice * (1 + spv * slipMult);
          const raw = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
          allTrades.push({
            pair, engine: "A", dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: dayT,
            pnl: raw - NOT * FEE * 2, slPrice: pos.sl,
          });
          posA.splice(pi, 1);
        }
      }

      // Entry
      if (posA.length > 0) continue; // one pos per pair per engine

      // Fix look-ahead: use i-1 and i-2
      const sma20now = sma20[di - 1], sma50now = sma50[di - 1];
      const sma20prev = sma20[di - 2], sma50prev = sma50[di - 2];
      if (sma20now === null || sma50now === null || sma20prev === null || sma50prev === null) continue;

      let dir: Dir | null = null;
      // BTC filter: use < not <= (fix)
      if (sma20prev < sma50prev && sma20now > sma50now) {
        if (btcBullish(dayT)) dir = "long";
      }
      if (sma20prev > sma50prev && sma20now < sma50now) {
        dir = "short";
      }
      if (!dir) continue;

      const atrVal = atr14d[di - 1]; // SMA ATR: use di-1, not di
      if (atrVal === null) continue;

      const spv = sp(pair);
      const ep = dir === "long" ? bar.o * (1 + spv) : bar.o * (1 - spv);
      let slDist = atrVal * 3;
      if (slDist / ep > MAX_SL_PCT) slDist = ep * MAX_SL_PCT;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      posA.push({ pair, engine: "A", dir, ep, et: dayT, sl, atr: atrVal, bestPnlAtr: 0 });
    }
    // Close remaining
    for (const pos of posA) {
      const lastBar = daily[daily.length - 1];
      const spv = sp(pair);
      const xp = pos.dir === "long" ? lastBar.c * (1 - spv) : lastBar.c * (1 + spv);
      const raw = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
      allTrades.push({
        pair, engine: "A", dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: lastBar.t,
        pnl: raw - NOT * FEE * 2, slPrice: pos.sl,
      });
    }

    // ── Engine B trades ──
    const posB: Position[] = [];
    for (let hi = 22; hi < h4.length; hi++) {
      const h4T = h4[hi].t;
      if (h4T < FULL_START || h4T >= FULL_END) continue;

      // Check exits first
      for (let pi = posB.length - 1; pi >= 0; pi--) {
        const pos = posB[pi];
        const bar = h4[hi];
        let exitPrice = 0;
        let reason = "";

        // SL
        if (pos.dir === "long" && bar.l <= pos.sl) { exitPrice = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { exitPrice = pos.sl; reason = "sl"; }

        // Supertrend flip (signal-based exit)
        if (!reason && st[hi] !== null && st[hi - 1] !== null && st[hi] !== st[hi - 1]) {
          if ((pos.dir === "long" && st[hi] === -1) || (pos.dir === "short" && st[hi] === 1)) {
            exitPrice = bar.c; reason = "stflip";
          }
        }

        // Max hold 60d
        if (!reason && h4T - pos.et >= 60 * DAY) { exitPrice = bar.c; reason = "maxhold"; }

        // ATR trailing stop management
        if (!reason && pos.atr > 0) {
          const unrealPnl = pos.dir === "long"
            ? (bar.c - pos.ep) / pos.atr
            : (pos.ep - bar.c) / pos.atr;
          if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

          let newSl = pos.sl;
          if (pos.bestPnlAtr >= 3) {
            const trailPrice = pos.dir === "long"
              ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
              : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
          } else if (pos.bestPnlAtr >= 2) {
            const trailPrice = pos.dir === "long"
              ? bar.h - 2 * pos.atr
              : bar.l + 2 * pos.atr;
            newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
          } else if (pos.bestPnlAtr >= 1) {
            newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
          }
          pos.sl = newSl;
        }

        if (exitPrice > 0) {
          const spv = sp(pair);
          const slipMult = reason === "sl" ? SL_SLIP : 1;
          const xp = pos.dir === "long" ? exitPrice * (1 - spv * slipMult) : exitPrice * (1 + spv * slipMult);
          const raw = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
          allTrades.push({
            pair, engine: "B", dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: h4T,
            pnl: raw - NOT * FEE * 2, slPrice: pos.sl,
          });
          posB.splice(pi, 1);
        }
      }

      // Entry: Supertrend flip
      if (posB.length > 0) continue;

      const stNow = st[hi - 1];
      const stPrev = st[hi - 2];
      if (stNow === null || stPrev === null || stNow === stPrev) continue;

      const dir: Dir = stNow === 1 ? "long" : "short";

      // BTC filter for longs (use < not <=)
      if (dir === "long" && !btcBullish(h4T)) continue;

      const atrVal = atr14h4[hi - 1];
      if (atrVal === null) continue;

      const spv = sp(pair);
      const ep = dir === "long" ? h4[hi].o * (1 + spv) : h4[hi].o * (1 - spv);
      let slDist = atrVal * 3;
      if (slDist / ep > MAX_SL_PCT) slDist = ep * MAX_SL_PCT;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      posB.push({ pair, engine: "B", dir, ep, et: h4T, sl, atr: atrVal, bestPnlAtr: 0 });
    }
    // Close remaining
    for (const pos of posB) {
      const lastBar = h4[h4.length - 1];
      const spv = sp(pair);
      const xp = pos.dir === "long" ? lastBar.c * (1 - spv) : lastBar.c * (1 + spv);
      const raw = pos.dir === "long" ? (xp / pos.ep - 1) * NOT : (pos.ep / xp - 1) * NOT;
      allTrades.push({
        pair, engine: "B", dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: lastBar.t,
        pnl: raw - NOT * FEE * 2, slPrice: pos.sl,
      });
    }

    console.log(`  ${pair}: ${allTrades.filter(t => t.pair === pair).length} trades so far`);
  }

  return allTrades;
}

// ─── Step 2-3: Walk 1m bars and analyze pullbacks ───────────────────
interface TradeWithPullbacks {
  trade: Trade;
  pullbacks: Pullback[];
  peakLevPct: number;     // highest leveraged P&L % reached
  exitLevPct: number;     // leveraged P&L % at exit
  givebackPct: number;    // (peak - exit) as % of peak, if peak > 0
  timeToPeakMs: number;   // time from entry to peak
  timeFromPeakMs: number; // time from peak to exit
  lastNewHighAge: number; // at exit, how long since last new high (ms)
}

function analyzePullbacks(trades: Trade[]): TradeWithPullbacks[] {
  console.log("\nAnalyzing pullbacks with 1m data...");

  // Load 1m data per pair (memory-intensive, do one pair at a time)
  const results: TradeWithPullbacks[] = [];
  const pairsNeeded = [...new Set(trades.map(t => t.pair))];

  for (const pair of pairsNeeded) {
    const pairTrades = trades.filter(t => t.pair === pair);
    if (pairTrades.length === 0) continue;

    console.log(`  Loading 1m data for ${pair} (${pairTrades.length} trades)...`);
    const bars1m = load1m(pair);
    if (bars1m.length === 0) {
      console.log(`    No 1m data, skipping`);
      continue;
    }

    // Build time->index map for binary search
    const times = bars1m.map(b => b.t);

    function findBarIdx(t: number): number {
      let lo = 0, hi = times.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < t) lo = mid + 1;
        else if (times[mid] > t) hi = mid - 1;
        else return mid;
      }
      return lo < times.length ? lo : times.length - 1;
    }

    for (const trade of pairTrades) {
      const startIdx = findBarIdx(trade.et);
      const endIdx = findBarIdx(trade.xt);
      if (startIdx >= endIdx) {
        // Very short trade, skip
        results.push({
          trade,
          pullbacks: [],
          peakLevPct: 0,
          exitLevPct: trade.pnl / NOT * 100,
          givebackPct: 0,
          timeToPeakMs: 0,
          timeFromPeakMs: 0,
          lastNewHighAge: 0,
        });
        continue;
      }

      const pullbacks: Pullback[] = [];
      let peakPrice = trade.ep;
      let peakTime = trade.et;
      let peakLevPct = 0;
      let lastNewHighTime = trade.et;

      // Track pullback state
      let inPullback = false;
      let pullbackStartPeakPct = 0;
      let pullbackStartTime = 0;
      let pullbackMaxDepth = 0;

      // Threshold for counting as a pullback: 5% leveraged from peak
      const PB_THRESHOLD = 5;

      for (let i = startIdx; i <= endIdx && i < bars1m.length; i++) {
        const bar = bars1m[i];
        const price = bar.c;

        // Current leveraged P&L %
        const levPct = trade.dir === "long"
          ? (price - trade.ep) / trade.ep * LEV * 100
          : (trade.ep - price) / trade.ep * LEV * 100;

        // Update peak
        const isNewHigh = trade.dir === "long" ? price > peakPrice : price < peakPrice;
        if (isNewHigh) {
          peakPrice = trade.dir === "long" ? price : price;
          peakTime = bar.t;
          lastNewHighTime = bar.t;

          const newPeakLev = trade.dir === "long"
            ? (peakPrice - trade.ep) / trade.ep * LEV * 100
            : (trade.ep - peakPrice) / trade.ep * LEV * 100;
          if (newPeakLev > peakLevPct) peakLevPct = newPeakLev;

          // If we were in a pullback, it just recovered
          if (inPullback && pullbackMaxDepth >= PB_THRESHOLD) {
            pullbacks.push({
              tradeIdx: results.length,
              depth: pullbackMaxDepth,
              peakPnlPct: pullbackStartPeakPct,
              recovered: true,
              terminal: false,
              durationMs: bar.t - pullbackStartTime,
              timeFromEntry: pullbackStartTime - trade.et,
            });
          }
          inPullback = false;
          pullbackMaxDepth = 0;
        } else {
          // Calculate drawdown from peak in leveraged %
          const peakLev = trade.dir === "long"
            ? (peakPrice - trade.ep) / trade.ep * LEV * 100
            : (trade.ep - peakPrice) / trade.ep * LEV * 100;
          const currentDD = peakLev - levPct; // always positive when pulling back

          if (currentDD >= PB_THRESHOLD) {
            if (!inPullback) {
              inPullback = true;
              pullbackStartPeakPct = peakLev;
              pullbackStartTime = bar.t;
            }
            if (currentDD > pullbackMaxDepth) pullbackMaxDepth = currentDD;
          }
        }
      }

      // If still in pullback at exit, it's terminal
      if (inPullback && pullbackMaxDepth >= PB_THRESHOLD) {
        pullbacks.push({
          tradeIdx: results.length,
          depth: pullbackMaxDepth,
          peakPnlPct: pullbackStartPeakPct,
          recovered: false,
          terminal: true,
          durationMs: trade.xt - pullbackStartTime,
          timeFromEntry: pullbackStartTime - trade.et,
        });
      }
      // Mark the last pullback as terminal if it existed
      if (pullbacks.length > 0) {
        pullbacks[pullbacks.length - 1].terminal = true;
      }

      const exitLevPct = trade.pnl / NOT * 100;
      const givebackPct = peakLevPct > 0 ? (peakLevPct - exitLevPct) / peakLevPct * 100 : 0;

      results.push({
        trade,
        pullbacks,
        peakLevPct,
        exitLevPct,
        givebackPct,
        timeToPeakMs: peakTime - trade.et,
        timeFromPeakMs: trade.xt - peakTime,
        lastNewHighAge: trade.xt - lastNewHighTime,
      });
    }

    // Help GC
    console.log(`    Done (${results.filter(r => r.trade.pair === pair).length} analyzed)`);
  }

  return results;
}

// ─── Step 3: Build Pullback Distribution ────────────────────────────
function buildPullbackDistribution(data: TradeWithPullbacks[]) {
  console.log("\n" + "=".repeat(100));
  console.log("STEP 3: PULLBACK DISTRIBUTION");
  console.log("=".repeat(100));

  const winners = data.filter(d => d.trade.pnl > 0);
  const losers = data.filter(d => d.trade.pnl <= 0);

  console.log(`\nTotal trades: ${data.length} (${winners.length} winners, ${losers.length} losers)`);
  console.log(`Avg peak leveraged P&L: Winners ${(winners.reduce((s, d) => s + d.peakLevPct, 0) / winners.length).toFixed(1)}%, Losers ${(losers.reduce((s, d) => s + d.peakLevPct, 0) / Math.max(losers.length, 1)).toFixed(1)}%`);
  console.log(`Avg giveback: Winners ${(winners.reduce((s, d) => s + d.givebackPct, 0) / winners.length).toFixed(1)}%, Losers N/A`);

  const depths = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60];

  // For winning trades
  console.log("\n--- WINNING TRADES: Pullback Recovery Analysis ---");
  console.log("Depth(lev%)  Total PBs  Recovered  Terminal  Recovery%  Avg Duration(h)");
  console.log("-".repeat(80));

  for (const depth of depths) {
    const winPBs = winners.flatMap(d => d.pullbacks).filter(p => p.depth >= depth);
    const recovered = winPBs.filter(p => p.recovered);
    const terminal = winPBs.filter(p => !p.recovered);
    const avgDurH = winPBs.length > 0
      ? winPBs.reduce((s, p) => s + p.durationMs, 0) / winPBs.length / H1
      : 0;
    const recoveryPct = winPBs.length > 0 ? recovered.length / winPBs.length * 100 : 0;

    console.log(
      `  >= ${String(depth).padStart(3)}%` +
      `    ${String(winPBs.length).padStart(8)}` +
      `    ${String(recovered.length).padStart(8)}` +
      `    ${String(terminal.length).padStart(8)}` +
      `    ${recoveryPct.toFixed(1).padStart(8)}%` +
      `    ${avgDurH.toFixed(1).padStart(12)}`
    );
  }

  // For losing trades
  console.log("\n--- LOSING TRADES: Pullback Analysis ---");
  console.log("Depth(lev%)  Total PBs  Recovered  Terminal  Recovery%  Avg Duration(h)");
  console.log("-".repeat(80));

  for (const depth of depths) {
    const losePBs = losers.flatMap(d => d.pullbacks).filter(p => p.depth >= depth);
    const recovered = losePBs.filter(p => p.recovered);
    const terminal = losePBs.filter(p => !p.recovered);
    const avgDurH = losePBs.length > 0
      ? losePBs.reduce((s, p) => s + p.durationMs, 0) / losePBs.length / H1
      : 0;
    const recoveryPct = losePBs.length > 0 ? recovered.length / losePBs.length * 100 : 0;

    console.log(
      `  >= ${String(depth).padStart(3)}%` +
      `    ${String(losePBs.length).padStart(8)}` +
      `    ${String(recovered.length).padStart(8)}` +
      `    ${String(terminal.length).padStart(8)}` +
      `    ${recoveryPct.toFixed(1).padStart(8)}%` +
      `    ${avgDurH.toFixed(1).padStart(12)}`
    );
  }

  // Combined: what's the probability a pullback of depth X recovers (across ALL trades)?
  console.log("\n--- ALL TRADES: Recovery Probability by Depth ---");
  console.log("Depth(lev%)  Total PBs  Recovery%  |  Win-trade PBs  Recovery%  |  Lose-trade PBs  Recovery%");
  console.log("-".repeat(105));

  for (const depth of depths) {
    const allPBs = data.flatMap(d => d.pullbacks).filter(p => p.depth >= depth);
    const allRec = allPBs.filter(p => p.recovered);
    const winPBs = winners.flatMap(d => d.pullbacks).filter(p => p.depth >= depth);
    const winRec = winPBs.filter(p => p.recovered);
    const losePBs = losers.flatMap(d => d.pullbacks).filter(p => p.depth >= depth);
    const loseRec = losePBs.filter(p => p.recovered);

    console.log(
      `  >= ${String(depth).padStart(3)}%` +
      `    ${String(allPBs.length).padStart(8)}` +
      `    ${(allPBs.length > 0 ? allRec.length / allPBs.length * 100 : 0).toFixed(1).padStart(8)}%` +
      `  |  ${String(winPBs.length).padStart(12)}` +
      `    ${(winPBs.length > 0 ? winRec.length / winPBs.length * 100 : 0).toFixed(1).padStart(8)}%` +
      `  |  ${String(losePBs.length).padStart(13)}` +
      `    ${(losePBs.length > 0 ? loseRec.length / losePBs.length * 100 : 0).toFixed(1).padStart(8)}%`
    );
  }

  // Giveback analysis for winners
  console.log("\n--- WINNER GIVEBACK DISTRIBUTION ---");
  const givebackBuckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  console.log("Giveback %   Count   Avg PeakLev%   Avg ExitLev%   Avg PnL");
  console.log("-".repeat(70));
  for (let i = 0; i < givebackBuckets.length - 1; i++) {
    const lo = givebackBuckets[i], hi = givebackBuckets[i + 1];
    const bucket = winners.filter(d => d.givebackPct >= lo && d.givebackPct < hi);
    if (bucket.length === 0) continue;
    console.log(
      `  ${String(lo).padStart(3)}-${String(hi).padStart(3)}%` +
      `    ${String(bucket.length).padStart(5)}` +
      `    ${(bucket.reduce((s, d) => s + d.peakLevPct, 0) / bucket.length).toFixed(1).padStart(12)}%` +
      `    ${(bucket.reduce((s, d) => s + d.exitLevPct, 0) / bucket.length).toFixed(1).padStart(12)}%` +
      `    $${(bucket.reduce((s, d) => s + d.trade.pnl, 0) / bucket.length).toFixed(2).padStart(7)}`
    );
  }
}

// ─── Step 4: Find Optimal Exit Threshold ────────────────────────────
function findOptimalExitThreshold(data: TradeWithPullbacks[], trades: Trade[]) {
  console.log("\n" + "=".repeat(100));
  console.log("STEP 4: OPTIMAL PULLBACK EXIT THRESHOLD");
  console.log("=".repeat(100));

  // Baseline stats
  const basePnl = trades.reduce((s, t) => s + t.pnl, 0);
  const baseDays = (FULL_END - FULL_START) / DAY;
  const basePerDay = basePnl / baseDays;
  const baseWins = trades.filter(t => t.pnl > 0).length;
  const baseWR = baseWins / trades.length * 100;
  let baseCum = 0, basePk = 0, baseDD = 0;
  for (const t of trades.sort((a, b) => a.xt - b.xt)) {
    baseCum += t.pnl;
    if (baseCum > basePk) basePk = baseCum;
    if (basePk - baseCum > baseDD) baseDD = basePk - baseCum;
  }
  const baseGiveback = data.filter(d => d.trade.pnl > 0).reduce((s, d) => s + d.givebackPct, 0) /
    Math.max(data.filter(d => d.trade.pnl > 0).length, 1);

  console.log(`\nBaseline: $${basePerDay.toFixed(2)}/day, WR ${baseWR.toFixed(1)}%, MaxDD $${baseDD.toFixed(0)}, N=${trades.length}, Avg Giveback ${baseGiveback.toFixed(1)}%`);

  // Test: at each pullback depth, if we exited when the pullback reached X%...
  // This requires re-simulating: for each trade, if any pullback reached threshold X before recovery,
  // we would have exited at that pullback depth (approximate exit price from the pullback).
  console.log("\n--- PULLBACK EXIT OVERLAY: No minimum profit ---");
  console.log("PB Exit Thr  Correctly  Incorrectly  Untouched  New$/day  NewWR%  NewMaxDD  NewGiveback%  vs Baseline");
  console.log("-".repeat(115));

  const thresholds = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

  interface ExitResult {
    threshold: number;
    minPeak: number;
    perDay: number;
    wr: number;
    dd: number;
    giveback: number;
    n: number;
  }

  const allResults: ExitResult[] = [];

  for (const threshold of thresholds) {
    // For each trade, simulate with the pullback exit
    let newTotalPnl = 0;
    let newWins = 0;
    let newCount = 0;
    const newTrades: { pnl: number; xt: number }[] = [];
    let correctExits = 0; // pullback was terminal, we saved profit
    let incorrectExits = 0; // pullback recovered, we missed continuation
    let untouched = 0; // no pullback reached threshold

    for (const d of data) {
      const t = d.trade;
      // Did any pullback reach the threshold?
      const reachedPB = d.pullbacks.find(p => p.depth >= threshold);

      if (!reachedPB) {
        // Trade unaffected
        untouched++;
        newTotalPnl += t.pnl;
        if (t.pnl > 0) newWins++;
        newCount++;
        newTrades.push({ pnl: t.pnl, xt: t.xt });
        continue;
      }

      // We would have exited at approximately: peak - threshold% of move
      // The exit P&L is approximately: peakLevPct - threshold (in leveraged %)
      const exitLevPct = reachedPB.peakPnlPct - threshold;
      const approxPnl = (exitLevPct / 100) * NOT - NOT * FEE * 2;

      // Was the pullback terminal (didn't recover)?
      if (!reachedPB.recovered) {
        correctExits++;
      } else {
        incorrectExits++;
      }

      newTotalPnl += approxPnl;
      if (approxPnl > 0) newWins++;
      newCount++;
      // Approximate exit time
      const approxXt = t.et + reachedPB.timeFromEntry + reachedPB.durationMs / 2;
      newTrades.push({ pnl: approxPnl, xt: approxXt });
    }

    const newPerDay = newTotalPnl / baseDays;
    const newWR = newCount > 0 ? newWins / newCount * 100 : 0;

    // Calculate new MaxDD
    newTrades.sort((a, b) => a.xt - b.xt);
    let cum = 0, pk = 0, dd = 0;
    for (const nt of newTrades) {
      cum += nt.pnl;
      if (cum > pk) pk = cum;
      if (pk - cum > dd) dd = pk - cum;
    }

    // Calculate new giveback
    // For untouched winning trades, giveback stays same
    // For pullback-exited trades, giveback is exactly threshold%
    const newGiveback = threshold; // simplified: we exit AT the threshold

    const vs = newPerDay - basePerDay;
    console.log(
      `  >= ${String(threshold).padStart(3)}%` +
      `      ${String(correctExits).padStart(6)}` +
      `       ${String(incorrectExits).padStart(6)}` +
      `     ${String(untouched).padStart(6)}` +
      `    $${newPerDay.toFixed(2).padStart(6)}` +
      `    ${newWR.toFixed(1).padStart(5)}%` +
      `     $${dd.toFixed(0).padStart(5)}` +
      `       ${newGiveback.toFixed(0).padStart(6)}%` +
      `      ${(vs >= 0 ? "+" : "")}$${vs.toFixed(2)}/day`
    );

    allResults.push({ threshold, minPeak: 0, perDay: newPerDay, wr: newWR, dd, giveback: newGiveback, n: newCount });
  }

  // Step 4b: Only apply after minimum profit level
  console.log("\n--- PULLBACK EXIT OVERLAY: Only after minimum peak profit ---");
  const minPeaks = [10, 15, 20, 25, 30];

  for (const minPeak of minPeaks) {
    console.log(`\n  [Min Peak >= ${minPeak}% leveraged before applying pullback exit]`);
    console.log("  PB Exit Thr  $/day   WR%    MaxDD   vs Baseline   Correct/Incorrect/Untouched");
    console.log("  " + "-".repeat(90));

    for (const threshold of thresholds) {
      let newTotalPnl = 0;
      let newWins = 0;
      let newCount = 0;
      const newTrades: { pnl: number; xt: number }[] = [];
      let correctExits = 0, incorrectExits = 0, untouched = 0;

      for (const d of data) {
        const t = d.trade;

        // Only apply pullback exit if peak reached minPeak
        if (d.peakLevPct < minPeak) {
          untouched++;
          newTotalPnl += t.pnl;
          if (t.pnl > 0) newWins++;
          newCount++;
          newTrades.push({ pnl: t.pnl, xt: t.xt });
          continue;
        }

        const reachedPB = d.pullbacks.find(p => p.depth >= threshold && p.peakPnlPct >= minPeak);

        if (!reachedPB) {
          untouched++;
          newTotalPnl += t.pnl;
          if (t.pnl > 0) newWins++;
          newCount++;
          newTrades.push({ pnl: t.pnl, xt: t.xt });
          continue;
        }

        const exitLevPct = reachedPB.peakPnlPct - threshold;
        const approxPnl = (exitLevPct / 100) * NOT - NOT * FEE * 2;

        if (!reachedPB.recovered) correctExits++;
        else incorrectExits++;

        newTotalPnl += approxPnl;
        if (approxPnl > 0) newWins++;
        newCount++;
        newTrades.push({ pnl: approxPnl, xt: t.et + reachedPB.timeFromEntry + reachedPB.durationMs / 2 });
      }

      const newPerDay = newTotalPnl / baseDays;
      const newWR = newCount > 0 ? newWins / newCount * 100 : 0;

      newTrades.sort((a, b) => a.xt - b.xt);
      let cum = 0, pk = 0, dd = 0;
      for (const nt of newTrades) {
        cum += nt.pnl; if (cum > pk) pk = cum; if (pk - cum > dd) dd = pk - cum;
      }

      const vs = newPerDay - basePerDay;
      console.log(
        `    >= ${String(threshold).padStart(3)}%` +
        `   $${newPerDay.toFixed(2).padStart(6)}` +
        `  ${newWR.toFixed(1).padStart(5)}%` +
        `   $${dd.toFixed(0).padStart(5)}` +
        `    ${(vs >= 0 ? "+" : "")}$${vs.toFixed(2).padStart(6)}/day` +
        `     ${correctExits}/${incorrectExits}/${untouched}`
      );

      allResults.push({ threshold, minPeak, perDay: newPerDay, wr: newWR, dd, giveback: threshold, n: newCount });
    }
  }

  return allResults;
}

// ─── Step 5: Full Backtest with Optimal Exit ────────────────────────
function fullBacktestWithPullbackExit(data: TradeWithPullbacks[], bestThreshold: number, bestMinPeak: number) {
  console.log("\n" + "=".repeat(100));
  console.log(`STEP 5: FULL BACKTEST WITH PULLBACK EXIT (threshold=${bestThreshold}%, minPeak=${bestMinPeak}%)`);
  console.log("=".repeat(100));

  // Reconstruct trades with the exit overlay
  const baseDays = (FULL_END - FULL_START) / DAY;
  const baselineTrades: { pnl: number; xt: number }[] = [];
  const overlayTrades: { pnl: number; xt: number }[] = [];

  for (const d of data) {
    const t = d.trade;
    baselineTrades.push({ pnl: t.pnl, xt: t.xt });

    if (d.peakLevPct >= bestMinPeak) {
      const reachedPB = d.pullbacks.find(p => p.depth >= bestThreshold && p.peakPnlPct >= bestMinPeak);
      if (reachedPB) {
        const exitLevPct = reachedPB.peakPnlPct - bestThreshold;
        const approxPnl = (exitLevPct / 100) * NOT - NOT * FEE * 2;
        overlayTrades.push({ pnl: approxPnl, xt: t.et + reachedPB.timeFromEntry + reachedPB.durationMs / 2 });
        continue;
      }
    }
    overlayTrades.push({ pnl: t.pnl, xt: t.xt });
  }

  function calcStats(trades: { pnl: number; xt: number }[], label: string) {
    trades.sort((a, b) => a.xt - b.xt);
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    let cum = 0, pk = 0, dd = 0;
    for (const t of trades) {
      cum += t.pnl; if (cum > pk) pk = cum; if (pk - cum > dd) dd = pk - cum;
    }
    const dayPnl = new Map<number, number>();
    for (const t of trades) {
      const d = Math.floor(t.xt / DAY);
      dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
    }
    const returns = [...dayPnl.values()];
    const mean = returns.reduce((s, r) => s + r, 0) / Math.max(returns.length, 1);
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    console.log(`  ${label}:`);
    console.log(`    $/day: $${(pnl / baseDays).toFixed(2)}, Total: $${pnl.toFixed(0)}`);
    console.log(`    WR: ${(wins / trades.length * 100).toFixed(1)}%, MaxDD: $${dd.toFixed(0)}, Sharpe: ${sharpe.toFixed(2)}`);
    console.log(`    Trades: ${trades.length}, Wins: ${wins}, Losses: ${trades.length - wins}`);
  }

  calcStats(baselineTrades, "Baseline (no pullback exit)");
  calcStats(overlayTrades, `With pullback exit (${bestThreshold}% from peak, min ${bestMinPeak}% peak)`);
}

// ─── Step 6: Time Dimension Analysis ────────────────────────────────
function analyzeTimeDimension(data: TradeWithPullbacks[]) {
  console.log("\n" + "=".repeat(100));
  console.log("STEP 6: TIME DIMENSION - Time Since Last New High");
  console.log("=".repeat(100));

  const winners = data.filter(d => d.trade.pnl > 0);
  const losers = data.filter(d => d.trade.pnl <= 0);

  console.log("\n--- Time from Peak to Exit ---");
  console.log("Category      Avg(h)   Median(h)   P25(h)   P75(h)");
  console.log("-".repeat(60));

  function timeStats(items: TradeWithPullbacks[], label: string) {
    const times = items.map(d => d.lastNewHighAge / H1).sort((a, b) => a - b);
    if (times.length === 0) return;
    const avg = times.reduce((s, t) => s + t, 0) / times.length;
    const median = times[Math.floor(times.length / 2)];
    const p25 = times[Math.floor(times.length * 0.25)];
    const p75 = times[Math.floor(times.length * 0.75)];
    console.log(
      `  ${label.padEnd(12)}` +
      `  ${avg.toFixed(1).padStart(6)}` +
      `      ${median.toFixed(1).padStart(6)}` +
      `    ${p25.toFixed(1).padStart(6)}` +
      `    ${p75.toFixed(1).padStart(6)}`
    );
  }

  timeStats(winners, "Winners");
  timeStats(losers, "Losers");
  timeStats(data, "All");

  // What's the probability of reversal at each "time since new high" threshold?
  console.log("\n--- Time Since Last New High vs Outcome ---");
  console.log("Hours since new high  N(win still going)  N(lose never came back)  P(reversal)");
  console.log("-".repeat(80));

  const timeThresholds = [1, 2, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96, 120, 168];

  for (const hours of timeThresholds) {
    const threshMs = hours * H1;
    // Trades where last new high was >= threshold ago at exit
    const exceeds = data.filter(d => d.lastNewHighAge >= threshMs);
    const exceedWin = exceeds.filter(d => d.trade.pnl > 0).length;
    const exceedLose = exceeds.filter(d => d.trade.pnl <= 0).length;
    const pReversal = exceeds.length > 0 ? exceedLose / exceeds.length * 100 : 0;

    console.log(
      `  >= ${String(hours).padStart(4)}h` +
      `         ${String(exceedWin).padStart(10)}` +
      `             ${String(exceedLose).padStart(10)}` +
      `         ${pReversal.toFixed(1).padStart(6)}%`
    );
  }

  // Pullback duration analysis
  console.log("\n--- Pullback Duration: Recovered vs Terminal ---");
  console.log("Duration bucket(h)  N(recovered)  Avg depth%  N(terminal)  Avg depth%");
  console.log("-".repeat(80));

  const allPBs = data.flatMap(d => d.pullbacks);
  const durBuckets = [0, 1, 2, 4, 8, 16, 24, 48, 96, 200, Infinity];

  for (let i = 0; i < durBuckets.length - 1; i++) {
    const lo = durBuckets[i] * H1, hi = durBuckets[i + 1] * H1;
    const bucket = allPBs.filter(p => p.durationMs >= lo && p.durationMs < hi);
    if (bucket.length === 0) continue;
    const recovered = bucket.filter(p => p.recovered);
    const terminal = bucket.filter(p => !p.recovered);

    const label = durBuckets[i + 1] === Infinity
      ? `  >= ${durBuckets[i]}h`
      : `  ${durBuckets[i]}-${durBuckets[i + 1]}h`;

    console.log(
      `${label.padEnd(20)}` +
      `  ${String(recovered.length).padStart(10)}` +
      `    ${(recovered.length > 0 ? recovered.reduce((s, p) => s + p.depth, 0) / recovered.length : 0).toFixed(1).padStart(8)}%` +
      `  ${String(terminal.length).padStart(10)}` +
      `    ${(terminal.length > 0 ? terminal.reduce((s, p) => s + p.depth, 0) / terminal.length : 0).toFixed(1).padStart(8)}%`
    );
  }

  // Combined: time + depth analysis
  console.log("\n--- COMBINED: Time Since Peak + Pullback Depth ---");
  console.log("(Probability that a trade ending with X hours since new high AND Y% pullback was a loser)");
  console.log("");
  const depthBins = [5, 10, 15, 20, 30, 40];
  const timeBins = [4, 8, 16, 24, 48, 96];

  console.log("             " + timeBins.map(t => `>=${t}h`.padStart(8)).join(""));
  console.log("-".repeat(60));

  for (const depth of depthBins) {
    let row = `  >=${String(depth).padStart(2)}% pb  `;
    for (const hours of timeBins) {
      const threshMs = hours * H1;
      // Trades that had a pullback >= depth AND last new high >= hours ago
      const matching = data.filter(d =>
        d.pullbacks.some(p => p.depth >= depth) && d.lastNewHighAge >= threshMs
      );
      if (matching.length < 3) {
        row += "   N/A  ";
      } else {
        const losers2 = matching.filter(d => d.trade.pnl <= 0).length;
        row += `  ${(losers2 / matching.length * 100).toFixed(0).padStart(4)}%  `;
      }
    }
    console.log(row + `  (n=${data.filter(d => d.pullbacks.some(p => p.depth >= depth)).length})`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();

  // Step 1: Generate trades
  const trades = generateTrades();
  console.log(`\nTotal trades generated: ${trades.length}`);
  console.log(`  Engine A (Donchian SMA): ${trades.filter(t => t.engine === "A").length}`);
  console.log(`  Engine B (Supertrend): ${trades.filter(t => t.engine === "B").length}`);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const days = (FULL_END - FULL_START) / DAY;
  console.log(`  Total PnL: $${totalPnl.toFixed(0)}, $/day: $${(totalPnl / days).toFixed(2)}, WR: ${(wins / trades.length * 100).toFixed(1)}%`);

  // Step 2-3: Analyze pullbacks
  const data = analyzePullbacks(trades);
  buildPullbackDistribution(data);

  // Step 4: Find optimal threshold
  const allResults = findOptimalExitThreshold(data, trades);

  // Find best config by $/day improvement
  const baseline = allResults.find(r => r.threshold === 60 && r.minPeak === 0);
  const basePerDay = totalPnl / days;

  // Find best (highest $/day)
  let bestResult = allResults[0];
  for (const r of allResults) {
    if (r.perDay > bestResult.perDay) bestResult = r;
  }
  console.log(`\nBest config: threshold=${bestResult.threshold}%, minPeak=${bestResult.minPeak}%, $/day=$${bestResult.perDay.toFixed(2)}`);

  // Step 5: Full backtest
  fullBacktestWithPullbackExit(data, bestResult.threshold, bestResult.minPeak);

  // Also test a few notable configs
  const notableConfigs = [
    { thr: 20, mp: 20 },
    { thr: 25, mp: 15 },
    { thr: 30, mp: 20 },
    { thr: 35, mp: 25 },
  ];
  for (const nc of notableConfigs) {
    if (nc.thr === bestResult.threshold && nc.mp === bestResult.minPeak) continue;
    fullBacktestWithPullbackExit(data, nc.thr, nc.mp);
  }

  // Step 6: Time dimension
  analyzeTimeDimension(data);

  // Summary table
  console.log("\n" + "=".repeat(100));
  console.log("SUMMARY: KEY FINDINGS");
  console.log("=".repeat(100));

  const wData = data.filter(d => d.trade.pnl > 0);
  const lData = data.filter(d => d.trade.pnl <= 0);

  console.log(`\nTrade statistics:`);
  console.log(`  Winners: ${wData.length}, avg peak ${(wData.reduce((s, d) => s + d.peakLevPct, 0) / wData.length).toFixed(1)}% lev, avg exit ${(wData.reduce((s, d) => s + d.exitLevPct, 0) / wData.length).toFixed(1)}% lev`);
  console.log(`  Losers:  ${lData.length}, avg peak ${(lData.reduce((s, d) => s + d.peakLevPct, 0) / Math.max(lData.length, 1)).toFixed(1)}% lev, avg exit ${(lData.reduce((s, d) => s + d.exitLevPct, 0) / Math.max(lData.length, 1)).toFixed(1)}% lev`);
  console.log(`  Avg giveback (winners): ${(wData.reduce((s, d) => s + d.givebackPct, 0) / wData.length).toFixed(1)}%`);
  console.log(`  Avg time to peak (winners): ${(wData.reduce((s, d) => s + d.timeToPeakMs, 0) / wData.length / H1).toFixed(1)}h`);
  console.log(`  Avg time from peak to exit (winners): ${(wData.reduce((s, d) => s + d.timeFromPeakMs, 0) / wData.length / H1).toFixed(1)}h`);

  console.log(`\nBest pullback exit overlay: threshold=${bestResult.threshold}%, minPeak=${bestResult.minPeak}%`);
  console.log(`  $/day: $${bestResult.perDay.toFixed(2)} (baseline: $${basePerDay.toFixed(2)}, delta: ${((bestResult.perDay - basePerDay) >= 0 ? "+" : "")}$${(bestResult.perDay - basePerDay).toFixed(2)})`);
  console.log(`  WR: ${bestResult.wr.toFixed(1)}%, MaxDD: $${bestResult.dd.toFixed(0)}`);

  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
