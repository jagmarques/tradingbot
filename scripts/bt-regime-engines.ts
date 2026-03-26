/**
 * Regime Engine Search
 *
 * Classifies months as bull/bear/sideways by BTC monthly return,
 * then tests 6 candidate strategies to find the best per-regime specialist.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-regime-engines.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35; // taker 0.035%
const MARGIN = 5;
const LEV = 10;
const NOTIONAL = MARGIN * LEV; // $50

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";
type Regime = "BULL" | "BEAR" | "SIDEWAYS";

interface Trade {
  pair: string; dir: Dir;
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
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i === 0) { v = vals[i]; }
    else { v = vals[i] * k + v * (1 - k); }
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
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

function rsi(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return r;
}

function bollingerBands(closes: number[], period: number, stdMult: number): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    if (mid[i] === null) continue;
    let sum2 = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum2 += (closes[j] - mid[i]!) ** 2;
    }
    const std = Math.sqrt(sum2 / period);
    upper[i] = mid[i]! + stdMult * std;
    lower[i] = mid[i]! - stdMult * std;
  }
  return { upper, middle: mid, lower };
}

function adx(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return r;

  const trArr: number[] = [];
  const dmPlusArr: number[] = [];
  const dmMinusArr: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      trArr.push(bars[i].h - bars[i].l);
      dmPlusArr.push(0);
      dmMinusArr.push(0);
      continue;
    }
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    const dmPlus = upMove > downMove && upMove > 0 ? upMove : 0;
    const dmMinus = downMove > upMove && downMove > 0 ? downMove : 0;
    trArr.push(tr);
    dmPlusArr.push(dmPlus);
    dmMinusArr.push(dmMinus);
  }

  // Smooth with Wilder's
  let smoothTR = 0, smoothDMPlus = 0, smoothDMMinus = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trArr[i];
    smoothDMPlus += dmPlusArr[i];
    smoothDMMinus += dmMinusArr[i];
  }

  const dxArr: number[] = [];
  for (let i = period; i < bars.length; i++) {
    if (i === period) {
      // first smoothed
    } else {
      smoothTR = smoothTR - smoothTR / period + trArr[i];
      smoothDMPlus = smoothDMPlus - smoothDMPlus / period + dmPlusArr[i];
      smoothDMMinus = smoothDMMinus - smoothDMMinus / period + dmMinusArr[i];
    }
    const diPlus = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
    const diMinus = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;
    const diSum = diPlus + diMinus;
    const dx = diSum > 0 ? (Math.abs(diPlus - diMinus) / diSum) * 100 : 0;
    dxArr.push(dx);
  }

  // ADX = smoothed DX
  let adxVal = 0;
  for (let i = 0; i < dxArr.length; i++) {
    if (i < period) {
      adxVal += dxArr[i];
      if (i === period - 1) {
        adxVal /= period;
        r[i + period] = adxVal;
      }
    } else {
      adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
      r[i + period] = adxVal;
    }
  }
  return r;
}

function donchianHigh(highs: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(highs.length).fill(null);
  for (let i = period; i < highs.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, highs[j]);
    r[i] = mx;
  }
  return r;
}

function donchianLow(lows: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(lows.length).fill(null);
  for (let i = period; i < lows.length; i++) {
    let mn = Infinity;
    for (let j = i - period; j < i; j++) mn = Math.min(mn, lows[j]);
    r[i] = mn;
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): (1 | -1 | null)[] {
  const atrVals = atrFn(bars, atrPeriod);
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
  return trend;
}

// ─── Regime Classification ──────────────────────────────────────────
interface MonthRegime {
  year: number;
  month: number;
  start: number;
  end: number;
  btcReturn: number;
  regime: Regime;
}

function classifyMonths(btcDaily: Bar[]): MonthRegime[] {
  const months: MonthRegime[] = [];
  const startDate = new Date(FULL_START);
  const endDate = new Date(FULL_END);

  let y = startDate.getFullYear();
  let m = startDate.getMonth();

  while (true) {
    const mStart = new Date(y, m, 1).getTime();
    const mEnd = new Date(y, m + 1, 1).getTime();
    if (mStart >= FULL_END) break;

    // Find first and last BTC bar in this month
    let firstBar: Bar | null = null;
    let lastBar: Bar | null = null;
    for (const b of btcDaily) {
      if (b.t >= mStart && b.t < mEnd) {
        if (!firstBar) firstBar = b;
        lastBar = b;
      }
    }

    if (firstBar && lastBar && firstBar !== lastBar) {
      const ret = lastBar.c / firstBar.o - 1;
      let regime: Regime;
      if (ret > 0.05) regime = "BULL";
      else if (ret < -0.05) regime = "BEAR";
      else regime = "SIDEWAYS";

      months.push({
        year: y, month: m + 1,
        start: mStart, end: mEnd,
        btcReturn: ret, regime,
      });
    }

    m++;
    if (m >= 12) { m = 0; y++; }
    if (new Date(y, m, 1).getTime() > endDate.getTime()) break;
  }
  return months;
}

// ─── Pair Precomputed Data ──────────────────────────────────────────
interface PairIndicators {
  h4: Bar[];
  daily: Bar[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  // 4h indicators
  h4Closes: number[];
  h4RSI: (number | null)[];
  h4ATR: (number | null)[];
  h4ADX: (number | null)[];
  h4BBupper: (number | null)[];
  h4BBlower: (number | null)[];
  h4BBmid: (number | null)[];
  h4ST: (1 | -1 | null)[];
  // daily indicators
  dailyHighs: number[];
  dailyLows: number[];
  dailyCloses: number[];
  dailyEma20: (number | null)[];
  dailyDonHi20: (number | null)[];
  dailyDonLo20: (number | null)[];
  dailyATR: (number | null)[];
  dailyADX: (number | null)[];
}

// ─── BTC Indicators ─────────────────────────────────────────────────
interface BTCIndicators {
  daily: Bar[];
  h4: Bar[];
  dailyMap: Map<number, number>;
  h4Map: Map<number, number>;
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Strategy Interface ─────────────────────────────────────────────
interface Strategy {
  name: string;
  category: "BULL" | "SIDEWAYS";
  // Returns signal for a given pair at a given 4h bar index
  signal: (pair: string, pi: PairIndicators, h4i: number, btcInd: BTCIndicators) => { dir: Dir; sl: number; tp: number; maxHold: number } | null;
}

// ─── Strategy Definitions ───────────────────────────────────────────
function buildStrategies(): Strategy[] {
  return [
    // ─── BULL MARKET CANDIDATES ─────────────────────────────
    {
      name: "1. Long-Only Supertrend",
      category: "BULL",
      signal: (pair, pi, h4i, btcInd) => {
        if (h4i < 21) return null;
        const stNow = pi.h4ST[h4i - 1];
        const stPrev = pi.h4ST[h4i - 2];
        if (stNow === null || stPrev === null) return null;
        // Only long: supertrend flips to 1
        if (stNow !== 1 || stPrev !== -1) return null;

        const atr = pi.h4ATR[h4i - 1];
        if (atr === null) return null;
        const ep = pi.h4[h4i].o;
        let slDist = atr * 3;
        if (slDist / ep > 0.035) slDist = ep * 0.035;
        return {
          dir: "long",
          sl: ep - slDist,
          tp: 0, // no fixed TP, supertrend flip exit
          maxHold: 30 * DAY,
        };
      },
    },
    {
      name: "2. Breakout Momentum",
      category: "BULL",
      signal: (pair, pi, h4i, btcInd) => {
        // Daily timeframe: price breaks above 20-day high AND BTC bullish
        const barT = pi.h4[h4i].t;
        const dailyT = Math.floor(barT / DAY) * DAY;
        const di = pi.dailyMap.get(dailyT);
        if (di === undefined || di < 21) return null;

        // Only fire once per day (first 4h bar of the day)
        if (barT !== dailyT) return null;

        const prevClose = pi.dailyCloses[di - 1];
        const donHi = pi.dailyDonHi20[di - 1];
        if (donHi === null) return null;
        if (prevClose <= donHi) return null; // no breakout

        // BTC must be bullish (EMA20 > EMA50)
        const btcDi = getBarIdx(btcInd.daily, btcInd.dailyMap, barT - DAY, DAY);
        if (btcDi < 0) return null;
        const btcE20 = btcInd.dailyEma20[btcDi];
        const btcE50 = btcInd.dailyEma50[btcDi];
        if (btcE20 === null || btcE50 === null || btcE20 <= btcE50) return null;

        const ep = pi.daily[di].o;
        return {
          dir: "long" as Dir,
          sl: ep * (1 - 0.03),
          tp: ep * (1 + 0.10),
          maxHold: 14 * DAY,
        };
      },
    },
    {
      name: "3. Dip Buyer",
      category: "BULL",
      signal: (pair, pi, h4i, btcInd) => {
        if (h4i < 15) return null;
        const rsiVal = pi.h4RSI[h4i - 1];
        if (rsiVal === null || rsiVal >= 30) return null; // need oversold

        // BTC EMA bullish
        const barT = pi.h4[h4i].t;
        const btcDi = getBarIdx(btcInd.daily, btcInd.dailyMap, barT - DAY, DAY);
        if (btcDi < 0) return null;
        const btcE20 = btcInd.dailyEma20[btcDi];
        const btcE50 = btcInd.dailyEma50[btcDi];
        if (btcE20 === null || btcE50 === null || btcE20 <= btcE50) return null;

        const ep = pi.h4[h4i].o;
        // TP: when RSI > 60 (handled in sim via exit logic), or fixed 7%
        return {
          dir: "long" as Dir,
          sl: ep * (1 - 0.03),
          tp: ep * (1 + 0.07),
          maxHold: 10 * DAY,
        };
      },
    },

    // ─── SIDEWAYS MARKET CANDIDATES ─────────────────────────
    {
      name: "4. Mean Reversion BB",
      category: "SIDEWAYS",
      signal: (pair, pi, h4i, btcInd) => {
        if (h4i < 21) return null;
        const adxVal = pi.h4ADX[h4i - 1];
        if (adxVal === null || adxVal >= 20) return null; // only ranging

        const close = pi.h4Closes[h4i - 1];
        const upper = pi.h4BBupper[h4i - 1];
        const lower = pi.h4BBlower[h4i - 1];
        const mid = pi.h4BBmid[h4i - 1];
        if (upper === null || lower === null || mid === null) return null;

        const ep = pi.h4[h4i].o;
        if (close < lower) {
          return {
            dir: "long" as Dir,
            sl: ep * (1 - 0.02),
            tp: mid,
            maxHold: 5 * DAY,
          };
        }
        if (close > upper) {
          return {
            dir: "short" as Dir,
            sl: ep * (1 + 0.02),
            tp: mid,
            maxHold: 5 * DAY,
          };
        }
        return null;
      },
    },
    {
      name: "5. Range Trading",
      category: "SIDEWAYS",
      signal: (pair, pi, h4i, btcInd) => {
        // Compute 20-day range on daily bars
        const barT = pi.h4[h4i].t;
        const dailyT = Math.floor(barT / DAY) * DAY;
        const di = pi.dailyMap.get(dailyT);
        if (di === undefined || di < 21) return null;

        // Only fire once per day
        if (barT !== dailyT) return null;

        // ADX filter for sideways
        const adxDaily = pi.dailyADX[di - 1];
        if (adxDaily === null || adxDaily >= 25) return null;

        // Compute 20-day high and low
        let hi20 = -Infinity, lo20 = Infinity;
        for (let j = di - 20; j < di; j++) {
          if (j < 0) continue;
          hi20 = Math.max(hi20, pi.daily[j].h);
          lo20 = Math.min(lo20, pi.daily[j].l);
        }
        const range = hi20 - lo20;
        if (range <= 0) return null;

        const prevClose = pi.dailyCloses[di - 1];
        const pctInRange = (prevClose - lo20) / range;

        const ep = pi.daily[di].o;
        const mid = (hi20 + lo20) / 2;

        if (pctInRange < 0.25) {
          // Bottom 25% -> long
          return {
            dir: "long" as Dir,
            sl: ep * (1 - 0.02),
            tp: mid,
            maxHold: 7 * DAY,
          };
        }
        if (pctInRange > 0.75) {
          // Top 25% -> short
          return {
            dir: "short" as Dir,
            sl: ep * (1 + 0.02),
            tp: mid,
            maxHold: 7 * DAY,
          };
        }
        return null;
      },
    },
    {
      name: "6. Grid-Like",
      category: "SIDEWAYS",
      signal: (pair, pi, h4i, btcInd) => {
        if (h4i < 2) return null;

        // ADX filter
        const adxVal = pi.h4ADX[h4i - 1];
        if (adxVal === null || adxVal >= 20) return null;

        // Compute daily open for reference
        const barT = pi.h4[h4i].t;
        const dailyT = Math.floor(barT / DAY) * DAY;
        const di = pi.dailyMap.get(dailyT);
        if (di === undefined) return null;
        const dailyOpen = pi.daily[di].o;

        const prevClose = pi.h4Closes[h4i - 1];
        const pctFromOpen = (prevClose - dailyOpen) / dailyOpen;

        const ep = pi.h4[h4i].o;

        if (pctFromOpen <= -0.02) {
          // Dropped 2% from daily open -> long
          return {
            dir: "long" as Dir,
            sl: ep * (1 - 0.015),
            tp: ep * (1 + 0.015),
            maxHold: 2 * DAY,
          };
        }
        if (pctFromOpen >= 0.02) {
          // Rose 2% from daily open -> short
          return {
            dir: "short" as Dir,
            sl: ep * (1 + 0.015),
            tp: ep * (1 - 0.015),
            maxHold: 2 * DAY,
          };
        }
        return null;
      },
    },
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────
function getBarIdx(bars: Bar[], barMap: Map<number, number>, t: number, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

// ─── Simulation ─────────────────────────────────────────────────────
interface Position {
  pair: string; dir: Dir;
  ep: number; sl: number; tp: number;
  et: number; maxHold: number;
  stratName: string;
}

function simulate(
  strat: Strategy,
  pairDataMap: Map<string, PairIndicators>,
  btcInd: BTCIndicators,
  startT: number,
  endT: number,
): Trade[] {
  const trades: Trade[] = [];
  const positions = new Map<string, Position>(); // key = pair

  // Collect all 4h timestamps across all pairs in range
  const h4Set = new Set<number>();
  for (const [, pi] of pairDataMap) {
    for (const b of pi.h4) {
      if (b.t >= startT && b.t < endT) h4Set.add(b.t);
    }
  }
  const h4Times = [...h4Set].sort((a, b) => a - b);

  for (const t of h4Times) {
    // Check existing positions first
    for (const [key, pos] of [...positions.entries()]) {
      const pi = pairDataMap.get(pos.pair)!;
      const h4i = pi.h4Map.get(t);
      if (h4i === undefined) continue;
      const bar = pi.h4[h4i];

      let closed = false;

      // SL check
      if (pos.dir === "long" && bar.l <= pos.sl) {
        const xp = pos.sl * (1 - sp(pos.pair));
        const raw = (xp / pos.ep - 1) * NOTIONAL;
        const cost = NOTIONAL * FEE * 2;
        trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
        positions.delete(key);
        closed = true;
      } else if (pos.dir === "short" && bar.h >= pos.sl) {
        const xp = pos.sl * (1 + sp(pos.pair));
        const raw = (pos.ep / xp - 1) * NOTIONAL;
        const cost = NOTIONAL * FEE * 2;
        trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
        positions.delete(key);
        closed = true;
      }
      if (closed) continue;

      // TP check
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          const xp = pos.tp * (1 - sp(pos.pair));
          const raw = (xp / pos.ep - 1) * NOTIONAL;
          const cost = NOTIONAL * FEE * 2;
          trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
          positions.delete(key);
          continue;
        }
        if (pos.dir === "short" && bar.l <= pos.tp) {
          const xp = pos.tp * (1 + sp(pos.pair));
          const raw = (pos.ep / xp - 1) * NOTIONAL;
          const cost = NOTIONAL * FEE * 2;
          trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
          positions.delete(key);
          continue;
        }
      }

      // Supertrend exit for strategy 1
      if (pos.stratName === "1. Long-Only Supertrend") {
        const stNow = pi.h4ST[h4i - 1];
        if (stNow !== null && stNow === -1) {
          const xp = bar.c * (1 - sp(pos.pair));
          const raw = (xp / pos.ep - 1) * NOTIONAL;
          const cost = NOTIONAL * FEE * 2;
          trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
          positions.delete(key);
          continue;
        }
      }

      // RSI exit for Dip Buyer
      if (pos.stratName === "3. Dip Buyer") {
        const rsiVal = pi.h4RSI[h4i - 1];
        if (rsiVal !== null && rsiVal > 60) {
          const xp = bar.c * (1 - sp(pos.pair));
          const raw = (xp / pos.ep - 1) * NOTIONAL;
          const cost = NOTIONAL * FEE * 2;
          trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
          positions.delete(key);
          continue;
        }
      }

      // Max hold
      if (t - pos.et >= pos.maxHold) {
        const xp = pos.dir === "long"
          ? bar.c * (1 - sp(pos.pair))
          : bar.c * (1 + sp(pos.pair));
        const raw = pos.dir === "long"
          ? (xp / pos.ep - 1) * NOTIONAL
          : (pos.ep / xp - 1) * NOTIONAL;
        const cost = NOTIONAL * FEE * 2;
        trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: t, pnl: raw - cost });
        positions.delete(key);
        continue;
      }
    }

    // New signals
    for (const [pair, pi] of pairDataMap) {
      if (positions.has(pair)) continue;
      if (positions.size >= 10) break;

      const h4i = pi.h4Map.get(t);
      if (h4i === undefined || h4i < 30) continue;

      const sig = strat.signal(pair, pi, h4i, btcInd);
      if (!sig) continue;

      const rawEp = pi.h4[h4i].o;
      const ep = sig.dir === "long"
        ? rawEp * (1 + sp(pair))
        : rawEp * (1 - sp(pair));

      positions.set(pair, {
        pair,
        dir: sig.dir,
        ep,
        sl: sig.sl,
        tp: sig.tp,
        et: t,
        maxHold: sig.maxHold,
        stratName: strat.name,
      });
    }
  }

  // Close remaining positions at end
  for (const [key, pos] of positions) {
    const pi = pairDataMap.get(pos.pair);
    if (!pi || pi.h4.length === 0) continue;
    const lastBar = pi.h4[pi.h4.length - 1];
    const xp = pos.dir === "long"
      ? lastBar.c * (1 - sp(pos.pair))
      : lastBar.c * (1 + sp(pos.pair));
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * NOTIONAL
      : (pos.ep / xp - 1) * NOTIONAL;
    const cost = NOTIONAL * FEE * 2;
    trades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: lastBar.t, pnl: raw - cost });
  }

  return trades;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface RegimeStats {
  regime: Regime;
  trades: number;
  pnl: number;
  wins: number;
  pf: number;
  avgTrade: number;
  months: number;
  pnlPerMonth: number;
}

function computeRegimeStats(trades: Trade[], months: MonthRegime[]): { all: RegimeStats; byRegime: Map<Regime, RegimeStats> } {
  const regimeMap = new Map<Regime, { trades: Trade[]; months: number }>();
  regimeMap.set("BULL", { trades: [], months: 0 });
  regimeMap.set("BEAR", { trades: [], months: 0 });
  regimeMap.set("SIDEWAYS", { trades: [], months: 0 });

  for (const m of months) {
    regimeMap.get(m.regime)!.months++;
    for (const t of trades) {
      if (t.et >= m.start && t.et < m.end) {
        regimeMap.get(m.regime)!.trades.push(t);
      }
    }
  }

  const byRegime = new Map<Regime, RegimeStats>();

  for (const [regime, data] of regimeMap) {
    const trs = data.trades;
    const pnl = trs.reduce((s, t) => s + t.pnl, 0);
    const wins = trs.filter(t => t.pnl > 0).length;
    const grossProfit = trs.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trs.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    byRegime.set(regime, {
      regime,
      trades: trs.length,
      pnl,
      wins,
      pf,
      avgTrade: trs.length > 0 ? pnl / trs.length : 0,
      months: data.months,
      pnlPerMonth: data.months > 0 ? pnl / data.months : 0,
    });
  }

  const allTrades = trades;
  const allPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const allWins = allTrades.filter(t => t.pnl > 0).length;
  const allGP = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const allGL = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const allPF = allGL > 0 ? allGP / allGL : allGP > 0 ? 99 : 0;
  const totalMonths = months.length;

  return {
    all: {
      regime: "BULL", // placeholder
      trades: allTrades.length,
      pnl: allPnl,
      wins: allWins,
      pf: allPF,
      avgTrade: allTrades.length > 0 ? allPnl / allTrades.length : 0,
      months: totalMonths,
      pnlPerMonth: totalMonths > 0 ? allPnl / totalMonths : 0,
    },
    byRegime,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(90));
  console.log("  REGIME ENGINE SEARCH");
  console.log("  Finding bull and sideways specialists to complement GARCH v2 (bear specialist)");
  console.log("=".repeat(90));

  // Load BTC data
  console.log("\nLoading data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }

  const btcDaily = aggregate(btcRaw, DAY);
  const btcH4 = aggregate(btcRaw, H4);
  const btcInd: BTCIndicators = {
    daily: btcDaily,
    h4: btcH4,
    dailyMap: new Map(btcDaily.map((b, i) => [b.t, i])),
    h4Map: new Map(btcH4.map((b, i) => [b.t, i])),
    dailyEma20: ema(btcDaily.map(b => b.c), 20),
    dailyEma50: ema(btcDaily.map(b => b.c), 50),
  };

  // Classify months
  const months = classifyMonths(btcDaily);
  const bullMonths = months.filter(m => m.regime === "BULL");
  const bearMonths = months.filter(m => m.regime === "BEAR");
  const sideMonths = months.filter(m => m.regime === "SIDEWAYS");

  console.log(`\nBTC monthly returns classified: ${months.length} months total`);
  console.log(`  BULL:     ${bullMonths.length} months`);
  console.log(`  BEAR:     ${bearMonths.length} months`);
  console.log(`  SIDEWAYS: ${sideMonths.length} months`);

  console.log("\n--- Month Classification ---");
  for (const m of months) {
    const tag = m.regime === "BULL" ? "+++" : m.regime === "BEAR" ? "---" : "   ";
    console.log(`  ${m.year}-${String(m.month).padStart(2, "0")}  BTC: ${(m.btcReturn * 100).toFixed(1).padStart(6)}%  ${tag} ${m.regime}`);
  }

  // Load pair data
  const pairDataMap = new Map<string, PairIndicators>();
  let loaded = 0;
  for (const pair of WANTED_PAIRS) {
    const raw = load5m(pair);
    if (raw.length < 500) { console.log(`  Skip ${pair} (insufficient data)`); continue; }

    const h4 = aggregate(raw, H4);
    const daily = aggregate(raw, DAY);
    const h4c = h4.map(b => b.c);
    const dc = daily.map(b => b.c);
    const dh = daily.map(b => b.h);
    const dl = daily.map(b => b.l);

    const bb = bollingerBands(h4c, 20, 2);

    pairDataMap.set(pair, {
      h4, daily,
      h4Map: new Map(h4.map((b, i) => [b.t, i])),
      dailyMap: new Map(daily.map((b, i) => [b.t, i])),
      h4Closes: h4c,
      h4RSI: rsi(h4c, 14),
      h4ATR: atrFn(h4, 14),
      h4ADX: adx(h4, 14),
      h4BBupper: bb.upper,
      h4BBlower: bb.lower,
      h4BBmid: bb.middle,
      h4ST: supertrend(h4, 14, 1.75),
      dailyHighs: dh,
      dailyLows: dl,
      dailyCloses: dc,
      dailyEma20: ema(dc, 20),
      dailyDonHi20: donchianHigh(dh, 20),
      dailyDonLo20: donchianLow(dl, 20),
      dailyATR: atrFn(daily, 14),
      dailyADX: adx(daily, 14),
    });
    loaded++;
  }
  console.log(`\nLoaded ${loaded} pairs`);

  // Run strategies
  const strategies = buildStrategies();

  console.log("\n" + "=".repeat(90));
  console.log("  STRATEGY RESULTS");
  console.log("=".repeat(90));

  const results: { name: string; category: string; allStats: RegimeStats; byRegime: Map<Regime, RegimeStats> }[] = [];

  for (const strat of strategies) {
    console.log(`\n${"─".repeat(90)}`);
    console.log(`  ${strat.name}  [${strat.category} candidate]`);
    console.log(`${"─".repeat(90)}`);

    const trades = simulate(strat, pairDataMap, btcInd, FULL_START, FULL_END);
    const { all, byRegime } = computeRegimeStats(trades, months);

    results.push({ name: strat.name, category: strat.category, allStats: all, byRegime });

    // Print header
    console.log("                     Trades  Wins   WR%     PnL       PF    $/trade  Months  $/month");
    console.log("  " + "-".repeat(86));

    for (const regime of ["BULL", "BEAR", "SIDEWAYS"] as Regime[]) {
      const s = byRegime.get(regime)!;
      const wr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(1) : "0.0";
      const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
      const pmStr = s.pnlPerMonth >= 0 ? `+$${s.pnlPerMonth.toFixed(2)}` : `-$${Math.abs(s.pnlPerMonth).toFixed(2)}`;
      const tag = regime === strat.category ? " <-- target" : "";
      console.log(`  ${regime.padEnd(12)}  ${String(s.trades).padStart(6)}  ${String(s.wins).padStart(4)}  ${wr.padStart(5)}%  ${pnlStr.padStart(10)}  ${s.pf.toFixed(2).padStart(6)}  ${("$" + s.avgTrade.toFixed(3)).padStart(8)}  ${String(s.months).padStart(5)}  ${pmStr.padStart(8)}${tag}`);
    }
    console.log("  " + "-".repeat(86));
    const wr = all.trades > 0 ? (all.wins / all.trades * 100).toFixed(1) : "0.0";
    const pnlStr = all.pnl >= 0 ? `+$${all.pnl.toFixed(2)}` : `-$${Math.abs(all.pnl).toFixed(2)}`;
    const pmStr = all.pnlPerMonth >= 0 ? `+$${all.pnlPerMonth.toFixed(2)}` : `-$${Math.abs(all.pnlPerMonth).toFixed(2)}`;
    console.log(`  ${"ALL".padEnd(12)}  ${String(all.trades).padStart(6)}  ${String(all.wins).padStart(4)}  ${wr.padStart(5)}%  ${pnlStr.padStart(10)}  ${all.pf.toFixed(2).padStart(6)}  ${("$" + all.avgTrade.toFixed(3)).padStart(8)}  ${String(all.months).padStart(5)}  ${pmStr.padStart(8)}`);
  }

  // ─── Summary / Ranking ─────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  REGIME SPECIALIST RANKING");
  console.log("=".repeat(90));

  for (const regime of ["BULL", "SIDEWAYS"] as Regime[]) {
    console.log(`\n--- ${regime} REGIME (best $/month in ${regime} months) ---`);
    const ranked = results
      .filter(r => r.category === regime)
      .map(r => ({
        name: r.name,
        pnlPerMonth: r.byRegime.get(regime)!.pnlPerMonth,
        trades: r.byRegime.get(regime)!.trades,
        pf: r.byRegime.get(regime)!.pf,
        wr: r.byRegime.get(regime)!.trades > 0 ? r.byRegime.get(regime)!.wins / r.byRegime.get(regime)!.trades * 100 : 0,
        otherRegimePnl: (() => {
          let sum = 0;
          for (const [reg, s] of r.byRegime) {
            if (reg !== regime) sum += s.pnl;
          }
          return sum;
        })(),
      }))
      .sort((a, b) => b.pnlPerMonth - a.pnlPerMonth);

    console.log("  Rank  Strategy                        $/month   Trades    PF     WR%   Other PnL");
    console.log("  " + "-".repeat(84));
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      const pmStr = r.pnlPerMonth >= 0 ? `+$${r.pnlPerMonth.toFixed(2)}` : `-$${Math.abs(r.pnlPerMonth).toFixed(2)}`;
      const otherStr = r.otherRegimePnl >= 0 ? `+$${r.otherRegimePnl.toFixed(2)}` : `-$${Math.abs(r.otherRegimePnl).toFixed(2)}`;
      const medal = i === 0 ? " << BEST" : "";
      console.log(`  ${String(i + 1).padStart(4)}  ${r.name.padEnd(30)}  ${pmStr.padStart(8)}  ${String(r.trades).padStart(6)}  ${r.pf.toFixed(2).padStart(5)}  ${r.wr.toFixed(1).padStart(5)}%  ${otherStr.padStart(10)}${medal}`);
    }
  }

  // ─── Overall best per regime ───────────────────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  RECOMMENDED REGIME PORTFOLIO");
  console.log("=".repeat(90));

  const allRanked = new Map<Regime, { name: string; pnlPerMonth: number; pf: number }>();

  // BEAR is already known
  allRanked.set("BEAR", { name: "GARCH v2 MTF (known)", pnlPerMonth: 9.26, pf: 0 });

  for (const regime of ["BULL", "SIDEWAYS"] as Regime[]) {
    let best = { name: "(none)", pnlPerMonth: -Infinity, pf: 0 };
    for (const r of results) {
      if (r.category !== regime) continue;
      const s = r.byRegime.get(regime)!;
      if (s.pnlPerMonth > best.pnlPerMonth) {
        best = { name: r.name, pnlPerMonth: s.pnlPerMonth, pf: s.pf };
      }
    }
    allRanked.set(regime, best);
  }

  console.log("\n  Regime      Best Engine                       $/month    PF");
  console.log("  " + "-".repeat(68));
  for (const regime of ["BULL", "BEAR", "SIDEWAYS"] as Regime[]) {
    const r = allRanked.get(regime)!;
    const pmStr = r.pnlPerMonth >= 0 ? `+$${r.pnlPerMonth.toFixed(2)}` : `-$${Math.abs(r.pnlPerMonth).toFixed(2)}`;
    console.log(`  ${regime.padEnd(12)}  ${r.name.padEnd(33)}  ${pmStr.padStart(8)}  ${r.pf.toFixed(2).padStart(5)}`);
  }

  // Cross-check: how do bull candidates do in bear/sideways?
  console.log("\n\n" + "=".repeat(90));
  console.log("  CROSS-REGIME IMPACT (does the specialist HURT in other regimes?)");
  console.log("=".repeat(90));

  console.log("\n  Strategy                        BULL $/mo   BEAR $/mo   SIDE $/mo   TOTAL $/mo");
  console.log("  " + "-".repeat(82));
  for (const r of results) {
    const bull = r.byRegime.get("BULL")!;
    const bear = r.byRegime.get("BEAR")!;
    const side = r.byRegime.get("SIDEWAYS")!;
    const fmtPM = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    console.log(`  ${r.name.padEnd(30)}  ${fmtPM(bull.pnlPerMonth).padStart(10)}  ${fmtPM(bear.pnlPerMonth).padStart(10)}  ${fmtPM(side.pnlPerMonth).padStart(10)}  ${fmtPM(r.allStats.pnlPerMonth).padStart(10)}`);
  }

  console.log("\nDone.");
}

main();
