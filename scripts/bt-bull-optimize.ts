/**
 * Bull Market Strategy Optimization
 *
 * Tests 7 bull-specific strategies (including optimized Supertrend variants)
 * to beat the baseline Long-Only Supertrend(14,1.75) +$45/mo in bull months.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-bull-optimize.ts
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
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const PAIRS = [
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

interface MonthRegime {
  year: number; month: number;
  start: number; end: number;
  btcReturn: number; regime: Regime;
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
function calcEMA(values: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) v = values[i];
    else v = values[i] * k + v * (1 - k);
    if (i >= period - 1) r[i] = v;
  }
  return r;
}

function calcATR(bars: Bar[], period: number): (number | null)[] {
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

function calcRSI(closes: number[], period: number): (number | null)[] {
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

function donchianHigh(highs: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(highs.length).fill(null);
  for (let i = period; i < highs.length; i++) {
    let mx = -Infinity;
    for (let j = i - period; j < i; j++) mx = Math.max(mx, highs[j]);
    r[i] = mx;
  }
  return r;
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Regime Classification ──────────────────────────────────────────
function classifyMonths(btcDaily: Bar[]): MonthRegime[] {
  const months: MonthRegime[] = [];
  let y = new Date(FULL_START).getFullYear();
  let m = new Date(FULL_START).getMonth();

  while (true) {
    const mStart = new Date(y, m, 1).getTime();
    const mEnd = new Date(y, m + 1, 1).getTime();
    if (mStart >= FULL_END) break;

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
      months.push({ year: y, month: m + 1, start: mStart, end: mEnd, btcReturn: ret, regime });
    }

    m++;
    if (m >= 12) { m = 0; y++; }
    if (new Date(y, m, 1).getTime() > FULL_END) break;
  }
  return months;
}

// ─── Precomputed Pair Data ──────────────────────────────────────────
interface PairData {
  h4: Bar[];
  daily: Bar[];
  h4Map: Map<number, number>;
  dailyMap: Map<number, number>;
  h4Closes: number[];
  h4RSI: (number | null)[];
  h4ATR: (number | null)[];
  h4ST_14_175: (1 | -1 | null)[];  // baseline
  h4ST_10_15: (1 | -1 | null)[];   // tighter
  dailyCloses: number[];
  dailyHighs: number[];
  dailyATR: (number | null)[];
}

interface BTCData {
  daily: Bar[];
  h4: Bar[];
  dailyMap: Map<number, number>;
  h4Map: Map<number, number>;
  dailyEma20: (number | null)[];
  dailyEma50: (number | null)[];
  dailyCloses: number[];
}

// ─── Cost Model ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: Dir, notional: number = NOTIONAL): number {
  const spread = sp(pair);
  const entrySlip = ep * spread;
  const exitSlip = xp * spread;
  const fees = notional * FEE * 2;
  const raw = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return raw - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; wins: number; wr: number; pf: number;
  sharpe: number; maxDD: number; total: number; perDay: number;
}

function calcStats(trades: Trade[], startTs: number, endTs: number): Stats {
  if (trades.length === 0) return { trades: 0, wins: 0, wr: 0, pf: 0, sharpe: 0, maxDD: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const std = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;
  return {
    trades: trades.length, wins: wins.length,
    wr: wins.length / trades.length * 100,
    pf, sharpe, maxDD, total,
    perDay: days > 0 ? total / days : 0,
  };
}

// ─── Helper: find nearest BTC daily idx ─────────────────────────────
function btcDailyIdx(btc: BTCData, t: number): number {
  const aligned = Math.floor(t / DAY) * DAY;
  let idx = btc.dailyMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = DAY; dt <= 10 * DAY; dt += DAY) {
    idx = btc.dailyMap.get(aligned - dt);
    if (idx !== undefined) return idx;
  }
  return -1;
}

function btcBullish(btc: BTCData, t: number): boolean {
  const di = btcDailyIdx(btc, t - DAY);
  if (di < 0) return false;
  const e20 = btc.dailyEma20[di];
  const e50 = btc.dailyEma50[di];
  return e20 !== null && e50 !== null && e20 > e50;
}

// ─── Strategy Simulators ────────────────────────────────────────────

// Strategy 1: Long-Only Supertrend(14, 1.75) - baseline
function stratSupertrend(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  atrPeriod: number, mult: number,
  stKey: "h4ST_14_175" | "h4ST_10_15",
  startTs: number, endTs: number,
  volumeFilter: boolean = false,
): Trade[] {
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd || pd.h4.length < 30) continue;

    const st = pd[stKey];
    let pos: { ep: number; et: number } | null = null;

    for (let i = 1; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t > endTs && !pos) continue;

      const stNow = st[i - 1];
      const stPrev = i >= 2 ? st[i - 2] : null;

      // Exit: supertrend flips bearish
      if (pos && stNow !== null && stNow === -1) {
        const xp = bar.o;
        const pnl = tradePnl(pair, pos.ep, xp, "long");
        if (pos.et >= startTs && pos.et < endTs) {
          trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
        }
        pos = null;
      }

      // Entry: supertrend flips bullish (long only)
      if (!pos && stNow === 1 && stPrev === -1 && bar.t >= startTs && bar.t < endTs) {
        // Volume filter: require above-average volume in last bar
        if (volumeFilter && i >= 21) {
          let volSum = 0;
          for (let j = i - 20; j < i; j++) volSum += pd.h4[j].v;
          const avgVol = volSum / 20;
          if (pd.h4[i - 1].v < avgVol * 1.2) continue;
        }

        const ep = bar.o * (1 + sp(pair));
        pos = { ep, et: bar.t };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = pd.h4[pd.h4.length - 1];
      const xp = lastBar.c;
      const pnl = tradePnl(pair, pos.ep, xp, "long");
      trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: lastBar.t, pnl });
    }
  }
  return trades;
}

// Strategy 3: Dip Buyer + Trend
function stratDipBuyer(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd || pd.h4.length < 30) continue;

    let pos: { ep: number; et: number; sl: number } | null = null;

    for (let i = 15; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t > endTs && !pos) continue;

      // Manage position
      if (pos) {
        // SL check
        if (bar.l <= pos.sl) {
          const xp = pos.sl;
          const pnl = tradePnl(pair, pos.ep, xp, "long");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }
        // RSI > 60 exit
        const rsiVal = pd.h4RSI[i - 1];
        if (rsiVal !== null && rsiVal > 60) {
          const xp = bar.o;
          const pnl = tradePnl(pair, pos.ep, xp, "long");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }
        // 48h max hold
        if (bar.t - pos.et >= 48 * H1) {
          const xp = bar.o;
          const pnl = tradePnl(pair, pos.ep, xp, "long");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }
      }

      // Entry: RSI(14) < 35 AND BTC EMA(20) > EMA(50)
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const rsiVal = pd.h4RSI[i - 1];
        if (rsiVal === null || rsiVal >= 35) continue;
        if (!btcBullish(btc, bar.t)) continue;

        const ep = bar.o * (1 + sp(pair));
        const sl = ep * (1 - 0.03);
        pos = { ep, et: bar.t, sl };
      }
    }

    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = pd.h4[pd.h4.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, "long");
      trades.push({ pair, dir: "long", ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl });
    }
  }
  return trades;
}

// Strategy 4: Breakout + Pyramiding
function stratBreakoutPyramid(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd || pd.daily.length < 25) continue;

    // Precompute 20-day high on daily
    const donHi = donchianHigh(pd.dailyHighs, 20);
    const dailyATR = pd.dailyATR;

    interface Pyramid { ep: number; et: number; margin: number }
    let positions: Pyramid[] = [];
    let trailStop = 0;
    let entryATR = 0;

    for (let di = 21; di < pd.daily.length; di++) {
      const bar = pd.daily[di];
      if (bar.t > endTs && positions.length === 0) continue;

      const prevClose = pd.dailyCloses[di - 1];
      const prevDonHi = donHi[di - 1];
      const curATR = dailyATR[di - 1];

      // Manage open positions
      if (positions.length > 0 && curATR !== null) {
        // Update trailing stop (2x ATR from highest close)
        let maxPrice = 0;
        for (let j = Math.max(0, di - 5); j <= di; j++) {
          maxPrice = Math.max(maxPrice, pd.daily[j].h);
        }
        const newTrail = maxPrice - 2 * curATR;
        if (newTrail > trailStop) trailStop = newTrail;

        // Check trail stop
        if (bar.l <= trailStop) {
          const xp = trailStop;
          for (const p of positions) {
            const notional = p.margin * LEV;
            const pnl = tradePnl(pair, p.ep, xp, "long", notional);
            if (p.et >= startTs && p.et < endTs) {
              trades.push({ pair, dir: "long", ep: p.ep, xp, et: p.et, xt: bar.t, pnl });
            }
          }
          positions = [];
          trailStop = 0;
          continue;
        }

        // Pyramid: add $3 more when up 1x ATR from last entry
        if (positions.length < 3 && positions.length > 0 && curATR > 0 && bar.t >= startTs && bar.t < endTs) {
          const lastEntry = positions[positions.length - 1].ep;
          if (bar.c >= lastEntry + entryATR) {
            const ep = bar.c * (1 + sp(pair));
            positions.push({ ep, et: bar.t, margin: 3 });
          }
        }
      }

      // Entry: close breaks above 20-day high
      if (positions.length === 0 && bar.t >= startTs && bar.t < endTs && prevDonHi !== null && curATR !== null) {
        if (prevClose > prevDonHi) {
          const ep = bar.o * (1 + sp(pair));
          entryATR = curATR;
          trailStop = ep - 2 * curATR;
          positions.push({ ep, et: bar.t, margin: MARGIN });
        }
      }
    }

    // Close remaining
    if (positions.length > 0) {
      const lastBar = pd.daily[pd.daily.length - 1];
      for (const p of positions) {
        const notional = p.margin * LEV;
        const pnl = tradePnl(pair, p.ep, lastBar.c, "long", notional);
        if (p.et >= startTs && p.et < endTs) {
          trades.push({ pair, dir: "long", ep: p.ep, xp: lastBar.c, et: p.et, xt: lastBar.t, pnl });
        }
      }
    }
  }
  return trades;
}

// Strategy 5: Momentum Continuation
function stratMomentum(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const LOOKBACK = 7 * 6; // 7 days in 4h bars (6 bars/day)

  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd || pd.h4.length < LOOKBACK + 10) continue;

    let pos: { ep: number; et: number; sl: number } | null = null;

    for (let i = LOOKBACK + 1; i < pd.h4.length; i++) {
      const bar = pd.h4[i];
      if (bar.t > endTs && !pos) continue;

      const ret7d = pd.h4Closes[i - 1] / pd.h4Closes[i - 1 - LOOKBACK] - 1;
      const atr = pd.h4ATR[i - 1];

      // Manage position
      if (pos) {
        // SL check
        if (bar.l <= pos.sl) {
          const xp = pos.sl;
          const pnl = tradePnl(pair, pos.ep, xp, "long");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }
        // Exit when 7d return turns negative
        if (ret7d < 0) {
          const xp = bar.o;
          const pnl = tradePnl(pair, pos.ep, xp, "long");
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: "long", ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl });
          }
          pos = null;
          continue;
        }
      }

      // Entry: 7d return > 5% AND BTC bullish
      if (!pos && bar.t >= startTs && bar.t < endTs && ret7d > 0.05 && atr !== null) {
        if (!btcBullish(btc, bar.t)) continue;

        const ep = bar.o * (1 + sp(pair));
        const sl = ep - 2 * atr;
        // Cap SL at 3.5%
        if ((ep - sl) / ep > 0.035) {
          pos = { ep, et: bar.t, sl: ep * (1 - 0.035) };
        } else {
          pos = { ep, et: bar.t, sl };
        }
      }
    }

    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = pd.h4[pd.h4.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, "long");
      trades.push({ pair, dir: "long", ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl });
    }
  }
  return trades;
}

// Strategy 6: Alt Rotation Bull
function stratAltRotation(
  pairs: string[], pdm: Map<string, PairData>, btc: BTCData,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  const ROTATION_BARS = 18; // 3 days in 4h bars
  const TOP_N = 5;

  // Collect all unique daily timestamps in range
  const dailyTs = new Set<number>();
  for (const pair of pairs) {
    const pd = pdm.get(pair);
    if (!pd) continue;
    for (const b of pd.daily) {
      if (b.t >= startTs && b.t < endTs) dailyTs.add(b.t);
    }
  }
  const sortedDays = [...dailyTs].sort((a, b) => a - b);

  // Every 3 days, rank and trade
  for (let d = 0; d < sortedDays.length; d += 3) {
    const dayT = sortedDays[d];
    if (dayT < startTs || dayT >= endTs) continue;

    // Rank pairs by 3-day return
    const ranked: { pair: string; ret: number }[] = [];
    for (const pair of pairs) {
      const pd = pdm.get(pair);
      if (!pd) continue;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined || di < 4) continue;
      const ret3d = pd.dailyCloses[di - 1] / pd.dailyCloses[Math.max(0, di - 4)] - 1;
      ranked.push({ pair, ret: ret3d });
    }
    ranked.sort((a, b) => b.ret - a.ret);

    // Long top 5
    const topPairs = ranked.slice(0, TOP_N);
    for (const { pair } of topPairs) {
      const pd = pdm.get(pair)!;
      const di = pd.dailyMap.get(dayT);
      if (di === undefined) continue;

      const ep = pd.daily[di].o * (1 + sp(pair));
      // Exit after 3 days
      const exitDi = Math.min(di + 3, pd.daily.length - 1);
      const xp = pd.daily[exitDi].c;
      const pnl = tradePnl(pair, ep, xp, "long");
      trades.push({ pair, dir: "long", ep, xp, et: dayT, xt: pd.daily[exitDi].t, pnl });
    }
  }

  return trades;
}

// Strategy 7: Combined Supertrend + Dip Buyer (run both, merge trades)
// Just merges results of strategy 1 and strategy 3

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(90));
  console.log("  BULL MARKET STRATEGY OPTIMIZATION");
  console.log("  Goal: beat baseline Long-Only Supertrend(14,1.75) +$45/mo in bull months");
  console.log("=".repeat(90));

  // Load BTC
  console.log("\nLoading data...");
  const btcRaw = load5m("BTC");
  if (btcRaw.length === 0) { console.log("No BTC data!"); process.exit(1); }

  const btcDaily = aggregate(btcRaw, DAY);
  const btcH4 = aggregate(btcRaw, H4);
  const btcDailyCloses = btcDaily.map(b => b.c);
  const btc: BTCData = {
    daily: btcDaily,
    h4: btcH4,
    dailyMap: new Map(btcDaily.map((b, i) => [b.t, i])),
    h4Map: new Map(btcH4.map((b, i) => [b.t, i])),
    dailyEma20: calcEMA(btcDailyCloses, 20),
    dailyEma50: calcEMA(btcDailyCloses, 50),
    dailyCloses: btcDailyCloses,
  };

  // Classify months
  const months = classifyMonths(btcDaily);
  const bullMonths = months.filter(m => m.regime === "BULL");
  const bearMonths = months.filter(m => m.regime === "BEAR");
  const sideMonths = months.filter(m => m.regime === "SIDEWAYS");

  console.log(`\nBTC monthly returns: ${months.length} months total`);
  console.log(`  BULL:     ${bullMonths.length} months`);
  console.log(`  BEAR:     ${bearMonths.length} months`);
  console.log(`  SIDEWAYS: ${sideMonths.length} months`);

  console.log("\n--- Month Classification ---");
  for (const m of months) {
    const tag = m.regime === "BULL" ? "+++" : m.regime === "BEAR" ? "---" : "   ";
    console.log(`  ${m.year}-${String(m.month).padStart(2, "0")}  BTC: ${(m.btcReturn * 100).toFixed(1).padStart(6)}%  ${tag} ${m.regime}`);
  }

  // Load pairs
  const pdm = new Map<string, PairData>();
  let loaded = 0;
  for (const pair of PAIRS) {
    const raw = load5m(pair);
    if (raw.length < 500) { console.log(`  Skip ${pair} (insufficient data)`); continue; }

    const h4 = aggregate(raw, H4);
    const daily = aggregate(raw, DAY);
    const h4c = h4.map(b => b.c);
    const dc = daily.map(b => b.c);
    const dh = daily.map(b => b.h);

    pdm.set(pair, {
      h4, daily,
      h4Map: new Map(h4.map((b, i) => [b.t, i])),
      dailyMap: new Map(daily.map((b, i) => [b.t, i])),
      h4Closes: h4c,
      h4RSI: calcRSI(h4c, 14),
      h4ATR: calcATR(h4, 14),
      h4ST_14_175: calcSupertrend(h4, 14, 1.75),
      h4ST_10_15: calcSupertrend(h4, 10, 1.5),
      dailyCloses: dc,
      dailyHighs: dh,
      dailyATR: calcATR(daily, 14),
    });
    loaded++;
  }
  console.log(`\nLoaded ${loaded} pairs`);

  // ─── Run all strategies ─────────────────────────────────────────────
  interface StratResult {
    name: string;
    bullTrades: Trade[];
    bearTrades: Trade[];
    sideTrades: Trade[];
    allTrades: Trade[];
  }

  function filterByRegime(trades: Trade[], regimeMonths: MonthRegime[]): Trade[] {
    return trades.filter(t => regimeMonths.some(m => t.et >= m.start && t.et < m.end));
  }

  const strategies: { name: string; run: () => Trade[] }[] = [
    {
      name: "1. Long-Only ST(14,1.75) + vol filter [BASELINE]",
      run: () => stratSupertrend(PAIRS, pdm, btc, 14, 1.75, "h4ST_14_175", FULL_START, FULL_END, true),
    },
    {
      name: "2. Long-Only ST(10,1.5) tighter params",
      run: () => stratSupertrend(PAIRS, pdm, btc, 10, 1.5, "h4ST_10_15", FULL_START, FULL_END, false),
    },
    {
      name: "3. Dip Buyer (RSI<35 + BTC bullish)",
      run: () => stratDipBuyer(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "4. Breakout + Pyramiding (20d high)",
      run: () => stratBreakoutPyramid(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "5. Momentum Continuation (7d >5%)",
      run: () => stratMomentum(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "6. Alt Rotation (top 5 by 3d return)",
      run: () => stratAltRotation(PAIRS, pdm, btc, FULL_START, FULL_END),
    },
    {
      name: "7. Combined: ST(14,1.75) + Dip Buyer",
      run: () => {
        const st = stratSupertrend(PAIRS, pdm, btc, 14, 1.75, "h4ST_14_175", FULL_START, FULL_END, true);
        const dip = stratDipBuyer(PAIRS, pdm, btc, FULL_START, FULL_END);
        return [...st, ...dip];
      },
    },
  ];

  const results: StratResult[] = [];

  console.log("\n" + "=".repeat(90));
  console.log("  STRATEGY RESULTS (all months, then regime breakdown)");
  console.log("=".repeat(90));

  for (const strat of strategies) {
    const allTrades = strat.run();
    const bullTrades = filterByRegime(allTrades, bullMonths);
    const bearTrades = filterByRegime(allTrades, bearMonths);
    const sideTrades = filterByRegime(allTrades, sideMonths);

    results.push({ name: strat.name, bullTrades, bearTrades, sideTrades, allTrades });

    console.log(`\n${"─".repeat(90)}`);
    console.log(`  ${strat.name}`);
    console.log(`${"─".repeat(90)}`);
    console.log("                 Trades  Wins    WR%      PF   Sharpe   $/day    MaxDD    Total");
    console.log("  " + "-".repeat(84));

    for (const [label, trs, regime] of [
      ["BULL", bullTrades, bullMonths] as const,
      ["BEAR", bearTrades, bearMonths] as const,
      ["SIDEWAYS", sideTrades, sideMonths] as const,
    ]) {
      // Compute total days in this regime
      let totalDays = 0;
      for (const m of regime) {
        totalDays += (Math.min(m.end, FULL_END) - m.start) / DAY;
      }
      const stats = calcStats(trs, FULL_START, FULL_END);
      // Override perDay with regime-specific days
      const regimePerDay = totalDays > 0 ? stats.total / totalDays : 0;
      const tag = label === "BULL" ? " <--" : "";
      const totalStr = stats.total >= 0 ? `+$${stats.total.toFixed(2)}` : `-$${Math.abs(stats.total).toFixed(2)}`;
      const pdStr = regimePerDay >= 0 ? `+$${regimePerDay.toFixed(2)}` : `-$${Math.abs(regimePerDay).toFixed(2)}`;
      console.log(`  ${label.padEnd(12)} ${String(stats.trades).padStart(6)}  ${String(stats.wins).padStart(4)}  ${stats.wr.toFixed(1).padStart(5)}%  ${stats.pf.toFixed(2).padStart(6)}  ${stats.sharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(7)}  $${stats.maxDD.toFixed(0).padStart(5)}  ${totalStr.padStart(10)}${tag}`);
    }

    // All combined
    const allStats = calcStats(allTrades, FULL_START, FULL_END);
    const totalStr = allStats.total >= 0 ? `+$${allStats.total.toFixed(2)}` : `-$${Math.abs(allStats.total).toFixed(2)}`;
    const pdStr = allStats.perDay >= 0 ? `+$${allStats.perDay.toFixed(2)}` : `-$${Math.abs(allStats.perDay).toFixed(2)}`;
    console.log("  " + "-".repeat(84));
    console.log(`  ${"ALL".padEnd(12)} ${String(allStats.trades).padStart(6)}  ${String(allStats.wins).padStart(4)}  ${allStats.wr.toFixed(1).padStart(5)}%  ${allStats.pf.toFixed(2).padStart(6)}  ${allStats.sharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(7)}  $${allStats.maxDD.toFixed(0).padStart(5)}  ${totalStr.padStart(10)}`);
  }

  // ─── Bull-Only Ranking ────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  BULL MONTH RANKING (sorted by $/day in bull months)");
  console.log("=".repeat(90));

  // Calculate total bull days
  let totalBullDays = 0;
  for (const m of bullMonths) {
    totalBullDays += (Math.min(m.end, FULL_END) - m.start) / DAY;
  }

  const ranked = results.map(r => {
    const bs = calcStats(r.bullTrades, FULL_START, FULL_END);
    const bearS = calcStats(r.bearTrades, FULL_START, FULL_END);
    const sideS = calcStats(r.sideTrades, FULL_START, FULL_END);
    const bullPerDay = totalBullDays > 0 ? bs.total / totalBullDays : 0;
    const bullPerMonth = bullMonths.length > 0 ? bs.total / bullMonths.length : 0;
    return {
      name: r.name,
      bullTrades: bs.trades,
      bullWR: bs.wr,
      bullPF: bs.pf,
      bullSharpe: bs.sharpe,
      bullPerDay,
      bullPerMonth,
      bullMaxDD: bs.maxDD,
      bullTotal: bs.total,
      bearTotal: bearS.total,
      sideTotal: sideS.total,
    };
  }).sort((a, b) => b.bullPerDay - a.bullPerDay);

  console.log(`\n  Total bull days: ${totalBullDays.toFixed(0)} across ${bullMonths.length} months\n`);
  console.log("  Rank  Strategy                                       Trades   WR%     PF   Sharpe  $/day   $/mo   MaxDD  Bear$  Side$");
  console.log("  " + "-".repeat(108));

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const medal = i === 0 ? " << BEST" : "";
    const pdStr = r.bullPerDay >= 0 ? `+${r.bullPerDay.toFixed(2)}` : `${r.bullPerDay.toFixed(2)}`;
    const pmStr = r.bullPerMonth >= 0 ? `+${r.bullPerMonth.toFixed(1)}` : `${r.bullPerMonth.toFixed(1)}`;
    const bearStr = r.bearTotal >= 0 ? `+${r.bearTotal.toFixed(0)}` : `${r.bearTotal.toFixed(0)}`;
    const sideStr = r.sideTotal >= 0 ? `+${r.sideTotal.toFixed(0)}` : `${r.sideTotal.toFixed(0)}`;
    console.log(`  ${String(i + 1).padStart(4)}  ${r.name.padEnd(47)}  ${String(r.bullTrades).padStart(5)}  ${r.bullWR.toFixed(1).padStart(5)}%  ${r.bullPF.toFixed(2).padStart(5)}  ${r.bullSharpe.toFixed(2).padStart(6)}  ${pdStr.padStart(6)}  ${pmStr.padStart(5)}  $${r.bullMaxDD.toFixed(0).padStart(4)}  ${bearStr.padStart(5)}  ${sideStr.padStart(5)}${medal}`);
  }

  // ─── Per-Pair Breakdown for Top Strategy ──────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  PER-PAIR BREAKDOWN (top strategy in bull months)");
  console.log("=".repeat(90));

  const topStrat = ranked[0];
  const topResult = results.find(r => r.name === topStrat.name)!;
  const pairStats = new Map<string, { trades: number; pnl: number; wins: number }>();

  for (const t of topResult.bullTrades) {
    const p = pairStats.get(t.pair) ?? { trades: 0, pnl: 0, wins: 0 };
    p.trades++;
    p.pnl += t.pnl;
    if (t.pnl > 0) p.wins++;
    pairStats.set(t.pair, p);
  }

  const pairRanked = [...pairStats.entries()]
    .map(([pair, s]) => ({ pair, ...s, wr: s.trades > 0 ? s.wins / s.trades * 100 : 0 }))
    .sort((a, b) => b.pnl - a.pnl);

  console.log(`\n  ${topStrat.name}`);
  console.log("  Pair       Trades  Wins    WR%      PnL");
  console.log("  " + "-".repeat(48));
  for (const p of pairRanked) {
    const pnlStr = p.pnl >= 0 ? `+$${p.pnl.toFixed(2)}` : `-$${Math.abs(p.pnl).toFixed(2)}`;
    console.log(`  ${p.pair.padEnd(8)}  ${String(p.trades).padStart(6)}  ${String(p.wins).padStart(4)}  ${p.wr.toFixed(1).padStart(5)}%  ${pnlStr.padStart(10)}`);
  }

  // ─── Monthly PnL for Top Strategy (bull months only) ──────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  MONTHLY PnL - TOP STRATEGY (bull months)");
  console.log("=".repeat(90));

  console.log(`\n  ${topStrat.name}\n`);
  for (const m of bullMonths) {
    const mTrades = topResult.bullTrades.filter(t => t.et >= m.start && t.et < m.end);
    const mPnl = mTrades.reduce((s, t) => s + t.pnl, 0);
    const pnlStr = mPnl >= 0 ? `+$${mPnl.toFixed(2)}` : `-$${Math.abs(mPnl).toFixed(2)}`;
    const bar = mPnl >= 0 ? "#".repeat(Math.min(40, Math.round(mPnl / 5))) : "-".repeat(Math.min(40, Math.round(Math.abs(mPnl) / 5)));
    console.log(`  ${m.year}-${String(m.month).padStart(2, "0")}  ${String(mTrades.length).padStart(4)} trades  ${pnlStr.padStart(10)}  ${bar}`);
  }

  // ─── Summary ────────────────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(90));
  console.log("  VERDICT");
  console.log("=".repeat(90));

  const baseline = ranked.find(r => r.name.includes("BASELINE"));
  const best = ranked[0];

  if (baseline && best.name !== baseline.name) {
    const improvement = best.bullPerMonth - (baseline?.bullPerMonth ?? 0);
    console.log(`\n  Baseline: ${baseline.name}`);
    console.log(`    Bull $/mo: $${baseline.bullPerMonth.toFixed(1)}, WR: ${baseline.bullWR.toFixed(1)}%, PF: ${baseline.bullPF.toFixed(2)}`);
    console.log(`\n  Best:     ${best.name}`);
    console.log(`    Bull $/mo: $${best.bullPerMonth.toFixed(1)}, WR: ${best.bullWR.toFixed(1)}%, PF: ${best.bullPF.toFixed(2)}`);
    console.log(`    Improvement: +$${improvement.toFixed(1)}/mo over baseline`);
    console.log(`    Bear months bleed: $${best.bearTotal.toFixed(1)} (regime-gate this off)`);
    console.log(`    Sideways bleed: $${best.sideTotal.toFixed(1)} (regime-gate this off)`);
  } else {
    console.log(`\n  Winner: ${best.name}`);
    console.log(`    Bull $/mo: $${best.bullPerMonth.toFixed(1)}, WR: ${best.bullWR.toFixed(1)}%, PF: ${best.bullPF.toFixed(2)}`);
    console.log(`    Bear months bleed: $${best.bearTotal.toFixed(1)} (regime-gate this off)`);
    console.log(`    Sideways bleed: $${best.sideTotal.toFixed(1)} (regime-gate this off)`);
  }

  console.log("\n" + "=".repeat(90));
}

main();
