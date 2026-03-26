/**
 * Range Expansion Strategy Validation
 *
 * 7 tests:
 *   1. Bootstrap CI (300 runs): 5th pct PF > 1.0?
 *   2. Random Entry (100 runs): Actual PF percentile vs random
 *   3. Quarterly Stationarity: All quarters profitable?
 *   4. Direction Split: Longs AND shorts profitable?
 *   5. Parameter Sensitivity: threshold [1.5,2.0,2.5,3.0] x exit [5,10,15]
 *   6. Per-pair Breakdown: Which pairs drive the edge?
 *   7. Correlation with existing engines: Supertrend + GARCH proxies
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-range-expansion-validate.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const DAY = 86_400_000;
const H = 3_600_000;
const FEE = 0.000_35; // 0.035% taker per side
const SIZE = 5;
const LEV = 10;
const NOT = SIZE * LEV; // $50 notional
const SL_SLIP = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4, TIA: 2.5e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4, BTC: 0.5e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const END = new Date("2026-03-26").getTime();

// Strategy defaults
const RANGE_THRESH = 2.0;
const EMA_FAST = 20;
const EMA_SLOW = 50;
const ATR_PERIOD = 14;
const ATR_MULT = 2;
const MAX_SL_PCT = 0.035;
const DONCH_EXIT = 10;
const MAX_HOLD_DAYS = 30;
const RANGE_LOOKBACK = 20;

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}
interface Stats {
  n: number; wr: number; pf: number; sharpe: number;
  pnl: number; perDay: number; maxDd: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c,
  })).sort((a: C, b: C) => a.t - b.t);
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
    if (bars.length < 200) continue; // need enough 5m bars for a valid day
    bars.sort((a, b) => a.t - b.t);
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

// ─── Indicators ─────────────────────────────────────────────────────
function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  ema[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c),
        );
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function donchLo(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let j = Math.max(0, idx - lb); j < idx; j++) mn = Math.min(mn, cs[j].l);
  return mn;
}

function donchHi(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let j = Math.max(0, idx - lb); j < idx; j++) mx = Math.max(mx, cs[j].h);
  return mx;
}

// ─── Range Expansion Strategy ───────────────────────────────────────
function simRangeExpansion(
  dailyData: Map<string, C[]>,
  btcDaily: C[],
  startMs: number,
  endMs: number,
  pairs: string[],
  opts: {
    rangeThresh?: number;
    donchExit?: number;
    maxHoldDays?: number;
  } = {},
): Trade[] {
  const THRESH = opts.rangeThresh ?? RANGE_THRESH;
  const EXIT_LB = opts.donchExit ?? DONCH_EXIT;
  const MAX_HOLD = opts.maxHoldDays ?? MAX_HOLD_DAYS;

  // BTC EMA filter
  const btcCloses = btcDaily.map(c => c.c);
  const btcEmaFast = calcEMA(btcCloses, EMA_FAST);
  const btcEmaSlow = calcEMA(btcCloses, EMA_SLOW);
  const btcTsMap = new Map<number, number>();
  btcDaily.forEach((c, i) => btcTsMap.set(c.t, i));

  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < RANGE_LOOKBACK + ATR_PERIOD + 5) continue;

    const atr = calcATR(cs, ATR_PERIOD);
    const sp = SPREAD[pair] ?? 4e-4;

    // Compute daily range ratio
    const rangeRatio: number[] = new Array(cs.length).fill(0);
    for (let i = 0; i < cs.length; i++) {
      rangeRatio[i] = cs[i].c > 0 ? (cs[i].h - cs[i].l) / cs[i].c : 0;
    }

    // Compute 20-day average range
    const avgRange: number[] = new Array(cs.length).fill(0);
    for (let i = RANGE_LOOKBACK; i < cs.length; i++) {
      let s = 0;
      for (let j = i - RANGE_LOOKBACK; j < i; j++) s += rangeRatio[j];
      avgRange[i] = s / RANGE_LOOKBACK;
    }

    const warmup = Math.max(RANGE_LOOKBACK + 1, ATR_PERIOD + 1, EMA_SLOW + 1);
    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; entryIdx: number } | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // Handle open position
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0;
        let reason = "";

        // SL check
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP);
          reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP);
          reason = "sl";
        }

        // Donchian exit
        if (!xp && i >= EXIT_LB + 1) {
          if (pos.dir === "long") {
            const lo = donchLo(cs, i, EXIT_LB);
            if (bar.c < lo) { xp = bar.c * (1 - sp); reason = "donch"; }
          } else {
            const hi = donchHi(cs, i, EXIT_LB);
            if (bar.c > hi) { xp = bar.c * (1 + sp); reason = "donch"; }
          }
        }

        // Max hold
        if (!xp && holdDays >= MAX_HOLD) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "maxhold";
        }

        if (xp > 0) {
          const fee = NOT * FEE * 2;
          const spreadCost = NOT * sp * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          trades.push({
            pair, dir: pos.dir, ep: pos.ep, xp,
            et: pos.et, xt: bar.t,
            pnl: raw - fee - spreadCost,
            reason,
          });
          pos = null;
        }
      }

      // Entry: check if previous day was an expansion day
      if (!pos && bar.t >= startMs && bar.t < endMs) {
        const prev = i - 1;
        if (prev < warmup) continue;
        if (avgRange[prev] <= 0) continue;

        const prevRange = rangeRatio[prev];
        const prevAvg = avgRange[prev];

        if (prevRange <= THRESH * prevAvg) continue;

        // Determine direction from previous day candle
        const prevBar = cs[prev];
        const bullish = prevBar.c > prevBar.o;
        const dir: "long" | "short" = bullish ? "long" : "short";

        // BTC EMA filter for longs only
        if (dir === "long") {
          const btcI = btcTsMap.get(bar.t);
          if (btcI !== undefined && btcI > 0 && btcEmaFast[btcI] <= btcEmaSlow[btcI]) continue;
        }

        // ATR stop
        const prevATR = atr[prev];
        if (prevATR <= 0) continue;
        const slDist = Math.min(ATR_MULT * prevATR, bar.o * MAX_SL_PCT);
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep - slDist : ep + slDist;

        pos = { dir, ep, et: bar.t, sl, entryIdx: i };
      }
    }
  }

  return trades;
}

// ─── Stats Utilities ────────────────────────────────────────────────
function calcStats(trades: Trade[], daySpan: number): Stats {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, pnl: 0, perDay: 0, maxDd: 0 };

  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const wr = (wins.length / trades.length) * 100;
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);

  let maxDd = 0, peak = 0, cum = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
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
}

function buildDailyPnl(trades: Trade[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.xt / DAY);
    m.set(day, (m.get(day) ?? 0) + t.pnl);
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

// ─── Proxy Engines for Correlation Test ─────────────────────────────

// Supertrend proxy on 4h
function simSupertrendProxy(
  h4Data: Map<string, C[]>,
  startTs: number, endTs: number, pairs: string[],
): Trade[] {
  const ST_PERIOD = 14;
  const ST_MULT = 2;
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_PERIOD + 30) continue;

    const atr = calcATR(cs, ST_PERIOD);
    const upperBand = new Array(cs.length).fill(0);
    const lowerBand = new Array(cs.length).fill(0);
    const stDir = new Array(cs.length).fill(1);

    for (let i = ST_PERIOD; i < cs.length; i++) {
      const mid = (cs[i].h + cs[i].l) / 2;
      const ub = mid + ST_MULT * atr[i];
      const lb = mid - ST_MULT * atr[i];

      upperBand[i] = i > ST_PERIOD && ub < upperBand[i - 1] && cs[i - 1].c > upperBand[i - 1]
        ? upperBand[i - 1] : ub;
      lowerBand[i] = i > ST_PERIOD && lb > lowerBand[i - 1] && cs[i - 1].c < lowerBand[i - 1]
        ? lowerBand[i - 1] : lb;

      if (i === ST_PERIOD) {
        stDir[i] = cs[i].c > upperBand[i] ? 1 : -1;
      } else {
        stDir[i] = stDir[i - 1] === 1
          ? (cs[i].c < lowerBand[i] ? -1 : 1)
          : (cs[i].c > upperBand[i] ? 1 : -1);
      }
    }

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;
    const warmup = ST_PERIOD + 2;
    const sp = SPREAD[pair] ?? 4e-4;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        let xp = 0;
        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP);
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP);
        }

        if (!xp) {
          if (pos.dir === "long" && stDir[i] === -1 && stDir[i - 1] === 1) {
            xp = bar.c * (1 - sp);
          } else if (pos.dir === "short" && stDir[i] === 1 && stDir[i - 1] === -1) {
            xp = bar.c * (1 + sp);
          }
        }

        if (xp > 0) {
          const fee = NOT * FEE * 2;
          const spreadCost = NOT * sp * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp,
              et: pos.et, xt: bar.t,
              pnl: raw - fee - spreadCost,
              reason: "st",
            });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= startTs && bar.t < endTs) {
        if (stDir[i] === 1 && stDir[i - 1] === -1) {
          const ep = bar.o * (1 + sp);
          const sl = ep * (1 - MAX_SL_PCT);
          pos = { dir: "long", ep, et: bar.t, sl };
        } else if (stDir[i] === -1 && stDir[i - 1] === 1) {
          const ep = bar.o * (1 - sp);
          const sl = ep * (1 + MAX_SL_PCT);
          pos = { dir: "short", ep, et: bar.t, sl };
        }
      }
    }
  }

  return trades;
}

// Z-score mean reversion proxy (GARCH-like)
function simZScoreProxy(
  dailyData: Map<string, C[]>,
  startTs: number, endTs: number, pairs: string[],
): Trade[] {
  const Z_PERIOD = 20;
  const Z_THRESH = 2.0;
  const trades: Trade[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < Z_PERIOD + ATR_PERIOD + 5) continue;

    const atr = calcATR(cs, ATR_PERIOD);
    const sp = SPREAD[pair] ?? 4e-4;

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;

    for (let i = Z_PERIOD + 1; i < cs.length; i++) {
      const bar = cs[i];

      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / DAY);
        let xp = 0;

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl * (1 - sp * SL_SLIP);
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl * (1 + sp * SL_SLIP);
        }

        // Mean reversion: exit when z-score returns to 0
        if (!xp) {
          let sum = 0;
          for (let j = i - Z_PERIOD; j < i; j++) sum += cs[j].c;
          const ma = sum / Z_PERIOD;
          let variance = 0;
          for (let j = i - Z_PERIOD; j < i; j++) variance += (cs[j].c - ma) ** 2;
          const sd = Math.sqrt(variance / Z_PERIOD);
          const z = sd > 0 ? (bar.c - ma) / sd : 0;

          if (pos.dir === "long" && z >= 0) xp = bar.c * (1 - sp);
          if (pos.dir === "short" && z <= 0) xp = bar.c * (1 + sp);
        }

        if (!xp && holdDays >= 30) {
          xp = pos.dir === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
        }

        if (xp > 0) {
          const fee = NOT * FEE * 2;
          const spreadCost = NOT * sp * 2;
          const raw = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT
            : (pos.ep / xp - 1) * NOT;
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({
              pair, dir: pos.dir, ep: pos.ep, xp,
              et: pos.et, xt: bar.t,
              pnl: raw - fee - spreadCost,
              reason: "z",
            });
          }
          pos = null;
        }
      }

      if (!pos && bar.t >= startTs && bar.t < endTs) {
        let sum = 0;
        for (let j = i - Z_PERIOD; j < i; j++) sum += cs[j].c;
        const ma = sum / Z_PERIOD;
        let variance = 0;
        for (let j = i - Z_PERIOD; j < i; j++) variance += (cs[j].c - ma) ** 2;
        const sd = Math.sqrt(variance / Z_PERIOD);
        const z = sd > 0 ? (bar.c - ma) / sd : 0;

        if (Math.abs(z) < Z_THRESH) continue;

        const dir: "long" | "short" = z < -Z_THRESH ? "long" : "short";
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const slDist = Math.min(ATR_MULT * prevATR, bar.o * MAX_SL_PCT);
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        pos = { dir, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// ─── Random Entry Simulation ────────────────────────────────────────
function simRandomEntry(
  dailyData: Map<string, C[]>,
  btcDaily: C[],
  startMs: number,
  endMs: number,
  pairs: string[],
  targetTradeCount: number,
): Trade[] {
  // Collect all valid entry days in the range
  const allDays: { pair: string; dayIdx: number }[] = [];

  for (const pair of pairs) {
    const cs = dailyData.get(pair);
    if (!cs) continue;
    const warmup = Math.max(RANGE_LOOKBACK + 1, ATR_PERIOD + 1);
    for (let i = warmup; i < cs.length; i++) {
      if (cs[i].t >= startMs && cs[i].t < endMs) {
        allDays.push({ pair, dayIdx: i });
      }
    }
  }

  // Randomly sample entry days matching target count
  const trades: Trade[] = [];
  const shuffled = [...allDays].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(targetTradeCount, shuffled.length));

  for (const { pair, dayIdx } of selected) {
    const cs = dailyData.get(pair)!;
    const bar = cs[dayIdx];
    const sp = SPREAD[pair] ?? 4e-4;
    const dir: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
    const atr = calcATR(cs, ATR_PERIOD);
    const prevATR = atr[dayIdx - 1];
    if (prevATR <= 0) continue;

    const slDist = Math.min(ATR_MULT * prevATR, bar.o * MAX_SL_PCT);
    const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
    const sl = dir === "long" ? ep - slDist : ep + slDist;

    // Simulate exit with same rules
    let xp = 0;
    let reason = "";
    for (let j = dayIdx + 1; j < cs.length; j++) {
      const b = cs[j];
      const holdDays = Math.round((b.t - bar.t) / DAY);

      if (dir === "long" && b.l <= sl) {
        xp = sl * (1 - sp * SL_SLIP); reason = "sl"; break;
      } else if (dir === "short" && b.h >= sl) {
        xp = sl * (1 + sp * SL_SLIP); reason = "sl"; break;
      }

      if (j >= DONCH_EXIT + 1) {
        if (dir === "long") {
          const lo = donchLo(cs, j, DONCH_EXIT);
          if (b.c < lo) { xp = b.c * (1 - sp); reason = "donch"; break; }
        } else {
          const hi = donchHi(cs, j, DONCH_EXIT);
          if (b.c > hi) { xp = b.c * (1 + sp); reason = "donch"; break; }
        }
      }

      if (holdDays >= MAX_HOLD_DAYS) {
        xp = dir === "long" ? b.c * (1 - sp) : b.c * (1 + sp);
        reason = "maxhold"; break;
      }
    }

    if (xp > 0) {
      const fee = NOT * FEE * 2;
      const spreadCost = NOT * sp * 2;
      const raw = dir === "long"
        ? (xp / ep - 1) * NOT
        : (ep / xp - 1) * NOT;
      trades.push({ pair, dir, ep, xp, et: bar.t, xt: 0, pnl: raw - fee - spreadCost, reason });
    }
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
function main(): void {
  console.log("=== Range Expansion Strategy Validation ===\n");
  console.log("Loading data...");

  // Load all data
  const dailyData = new Map<string, C[]>();
  const h4Data = new Map<string, C[]>();
  const raw5m = new Map<string, C[]>();

  for (const pair of [...PAIRS, "BTC"]) {
    const candles = load5m(pair);
    if (candles.length === 0) { console.log(`  WARN: No data for ${pair}`); continue; }
    raw5m.set(pair, candles);
    dailyData.set(pair, aggregateDaily(candles));
    h4Data.set(pair, aggregate4h(candles));
    const d = dailyData.get(pair)!;
    console.log(`  ${pair}: ${d.length} daily bars (${new Date(d[0].t).toISOString().slice(0, 10)} to ${new Date(d[d.length - 1].t).toISOString().slice(0, 10)})`);
  }

  const btcDaily = dailyData.get("BTC") ?? [];
  if (btcDaily.length === 0) { console.log("FATAL: No BTC data"); return; }

  // ─── Full + OOS baseline ──────────────────────────────────────────
  const fullTrades = simRangeExpansion(dailyData, btcDaily, FULL_START, END, PAIRS);
  const oosTrades = fullTrades.filter(t => t.et >= OOS_START);
  const isTrades = fullTrades.filter(t => t.et < OOS_START);

  const fullDays = (END - FULL_START) / DAY;
  const oosDays = (END - OOS_START) / DAY;
  const isDays = (OOS_START - FULL_START) / DAY;

  const fullStats = calcStats(fullTrades, fullDays);
  const oosStats = calcStats(oosTrades, oosDays);
  const isStats = calcStats(isTrades, isDays);

  printStats("\nFULL PERIOD (2023-01 to 2026-03):", fullStats);
  printStats("\nIN-SAMPLE (2023-01 to 2025-09):", isStats);
  printStats("\nOUT-OF-SAMPLE (2025-09 to 2026-03):", oosStats);

  // Exit reason breakdown
  console.log("\nExit reason breakdown (OOS):");
  const reasons = new Map<string, number>();
  for (const t of oosTrades) {
    reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  }
  for (const [r, c] of reasons) console.log(`  ${r}: ${c} (${((c / oosTrades.length) * 100).toFixed(1)}%)`);

  // ─── TEST 1: Bootstrap CI ─────────────────────────────────────────
  console.log("\n--- TEST 1: Bootstrap CI (300 runs) ---");
  const oosPnls = oosTrades.map(t => t.pnl);
  const bootPFs: number[] = [];
  const bootSharpes: number[] = [];
  const N_BOOT = 300;

  for (let b = 0; b < N_BOOT; b++) {
    const sample: number[] = [];
    for (let i = 0; i < oosPnls.length; i++) {
      sample.push(oosPnls[Math.floor(Math.random() * oosPnls.length)]);
    }
    const s = statsFromPnls(sample);
    bootPFs.push(s.pf);
    bootSharpes.push(s.sharpe);
  }

  bootPFs.sort((a, b) => a - b);
  bootSharpes.sort((a, b) => a - b);

  const pf5 = percentile(bootPFs, 5);
  const pf50 = percentile(bootPFs, 50);
  const pf95 = percentile(bootPFs, 95);
  const sh5 = percentile(bootSharpes, 5);
  const sh50 = percentile(bootSharpes, 50);
  const sh95 = percentile(bootSharpes, 95);

  console.log(`  PF  5th: ${pf5.toFixed(2)}  50th: ${pf50.toFixed(2)}  95th: ${pf95.toFixed(2)}`);
  console.log(`  Sharpe 5th: ${sh5.toFixed(2)}  50th: ${sh50.toFixed(2)}  95th: ${sh95.toFixed(2)}`);
  console.log(`  PASS: ${pf5 > 1.0 ? "YES (5th pct PF > 1.0)" : "NO (5th pct PF <= 1.0)"}`);

  // ─── TEST 2: Random Entry Benchmark ───────────────────────────────
  console.log("\n--- TEST 2: Random Entry Benchmark (100 runs) ---");
  const N_RAND = 100;
  const randPFs: number[] = [];

  for (let r = 0; r < N_RAND; r++) {
    const randTrades = simRandomEntry(dailyData, btcDaily, OOS_START, END, PAIRS, oosTrades.length);
    const randPnls = randTrades.map(t => t.pnl);
    const s = statsFromPnls(randPnls);
    randPFs.push(s.pf);
  }

  randPFs.sort((a, b) => a - b);
  const actualPF = oosStats.pf;
  const pctile = rankPct(actualPF, randPFs);

  console.log(`  Random PF median: ${percentile(randPFs, 50).toFixed(2)}  mean: ${(randPFs.reduce((a, b) => a + b, 0) / randPFs.length).toFixed(2)}`);
  console.log(`  Actual PF: ${actualPF.toFixed(2)}  Percentile: ${pctile.toFixed(1)}%`);
  console.log(`  PASS: ${pctile >= 95 ? "YES (>= 95th percentile)" : "NO (< 95th percentile)"}`);

  // ─── TEST 3: Quarterly Stationarity ───────────────────────────────
  console.log("\n--- TEST 3: Quarterly Stationarity ---");
  const quarters: { label: string; start: number; end: number }[] = [];
  // Generate quarters from 2023-Q1 to 2026-Q1
  for (let y = 2023; y <= 2026; y++) {
    for (let q = 0; q < 4; q++) {
      const qStart = new Date(`${y}-${String(q * 3 + 1).padStart(2, "0")}-01`).getTime();
      const qEnd = q < 3
        ? new Date(`${y}-${String((q + 1) * 3 + 1).padStart(2, "0")}-01`).getTime()
        : new Date(`${y + 1}-01-01`).getTime();
      if (qStart >= END) break;
      if (qEnd <= FULL_START) continue;
      quarters.push({
        label: `${y}-Q${q + 1}`,
        start: Math.max(qStart, FULL_START),
        end: Math.min(qEnd, END),
      });
    }
  }

  let allQProfitable = true;
  for (const q of quarters) {
    const qTrades = fullTrades.filter(t => t.et >= q.start && t.et < q.end);
    const qPnl = qTrades.reduce((s, t) => s + t.pnl, 0);
    const qPf = (() => {
      const gw = qTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const gl = Math.abs(qTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
      return gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
    })();
    const status = qPnl > 0 ? "+" : "-";
    if (qPnl <= 0) allQProfitable = false;
    console.log(`  ${q.label}: ${qTrades.length} trades  PnL: ${status}$${Math.abs(qPnl).toFixed(2)}  PF: ${qPf === Infinity ? "inf" : qPf.toFixed(2)}`);
  }
  console.log(`  PASS: ${allQProfitable ? "YES (all quarters profitable)" : "NO (some quarters negative)"}`);

  // ─── TEST 4: Direction Split ──────────────────────────────────────
  console.log("\n--- TEST 4: Direction Split ---");
  const longTrades = oosTrades.filter(t => t.dir === "long");
  const shortTrades = oosTrades.filter(t => t.dir === "short");
  const longStats = calcStats(longTrades, oosDays);
  const shortStats = calcStats(shortTrades, oosDays);
  printStats("  LONGS (OOS):", longStats);
  printStats("  SHORTS (OOS):", shortStats);
  const bothDirProfit = longStats.pnl > 0 && shortStats.pnl > 0;
  console.log(`  PASS: ${bothDirProfit ? "YES (both directions profitable)" : "NO (one direction negative)"}`);

  // ─── TEST 5: Parameter Sensitivity ────────────────────────────────
  console.log("\n--- TEST 5: Parameter Sensitivity ---");
  const thresholds = [1.5, 2.0, 2.5, 3.0];
  const exitPeriods = [5, 10, 15];
  let allCombosProfit = true;

  console.log("  Thresh  Exit  Trades  PnL        PF     $/day   MaxDD");
  for (const thresh of thresholds) {
    for (const exitP of exitPeriods) {
      const tr = simRangeExpansion(dailyData, btcDaily, OOS_START, END, PAIRS, {
        rangeThresh: thresh,
        donchExit: exitP,
      });
      const s = calcStats(tr, oosDays);
      if (s.pnl <= 0) allCombosProfit = false;
      const pfStr = s.pf === Infinity ? "  inf" : s.pf.toFixed(2).padStart(5);
      console.log(`  ${thresh.toFixed(1)}x   ${String(exitP).padStart(3)}d   ${String(s.n).padStart(5)}   ${(s.pnl >= 0 ? "+" : "") + "$" + Math.abs(s.pnl).toFixed(2).padStart(7)}  ${pfStr}  ${(s.perDay >= 0 ? "+" : "") + "$" + Math.abs(s.perDay).toFixed(2).padStart(5)}  $${s.maxDd.toFixed(2)}`);
    }
  }
  console.log(`  PASS: ${allCombosProfit ? "YES (all combos profitable)" : "NO (some combos negative)"}`);

  // ─── TEST 6: Per-Pair Breakdown ───────────────────────────────────
  console.log("\n--- TEST 6: Per-Pair Breakdown ---");
  console.log("  Pair    Trades  PnL        WR      PF     Avg$");
  const pairResults: { pair: string; pnl: number; n: number }[] = [];
  for (const pair of PAIRS) {
    const pTrades = oosTrades.filter(t => t.pair === pair);
    if (pTrades.length === 0) { console.log(`  ${pair.padEnd(6)}  0 trades`); continue; }
    const pPnl = pTrades.reduce((s, t) => s + t.pnl, 0);
    const pWr = (pTrades.filter(t => t.pnl > 0).length / pTrades.length) * 100;
    const gw = pTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(pTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pPf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
    const pfStr = pPf === Infinity ? "  inf" : pPf.toFixed(2).padStart(5);
    pairResults.push({ pair, pnl: pPnl, n: pTrades.length });
    console.log(`  ${pair.padEnd(6)}  ${String(pTrades.length).padStart(5)}   ${(pPnl >= 0 ? "+" : "") + "$" + Math.abs(pPnl).toFixed(2).padStart(7)}  ${pWr.toFixed(1).padStart(5)}%  ${pfStr}  ${(pPnl / pTrades.length >= 0 ? "+" : "") + "$" + Math.abs(pPnl / pTrades.length).toFixed(3)}`);
  }

  const profitablePairs = pairResults.filter(p => p.pnl > 0).length;
  const totalPairs = pairResults.filter(p => p.n > 0).length;
  console.log(`  Profitable pairs: ${profitablePairs}/${totalPairs}`);

  // Check concentration: does top pair dominate?
  pairResults.sort((a, b) => b.pnl - a.pnl);
  const totalOosPnl = oosStats.pnl;
  if (pairResults.length > 0 && totalOosPnl > 0) {
    const topPairPct = (pairResults[0].pnl / totalOosPnl) * 100;
    console.log(`  Top pair: ${pairResults[0].pair} (${topPairPct.toFixed(1)}% of total PnL) ${topPairPct > 50 ? "-- WARNING: concentrated" : "-- OK: diversified"}`);
  }

  // ─── TEST 7: Correlation with Existing Engines ────────────────────
  console.log("\n--- TEST 7: Correlation with Existing Engines ---");

  // Supertrend proxy
  const stTrades = simSupertrendProxy(h4Data, OOS_START, END, PAIRS);
  const stDaily = buildDailyPnl(stTrades);
  const reDaily = buildDailyPnl(oosTrades);

  const corrST = correlation(reDaily, stDaily);
  console.log(`  vs Supertrend (4h proxy): r = ${corrST.toFixed(3)}  (${Math.abs(corrST) < 0.3 ? "LOW - good addition" : Math.abs(corrST) < 0.5 ? "MODERATE" : "HIGH - overlapping"})`);

  // Z-score proxy (GARCH-like)
  const zTrades = simZScoreProxy(dailyData, OOS_START, END, PAIRS);
  const zDaily = buildDailyPnl(zTrades);
  const corrZ = correlation(reDaily, zDaily);
  console.log(`  vs Z-Score MR (GARCH proxy): r = ${corrZ.toFixed(3)}  (${Math.abs(corrZ) < 0.3 ? "LOW - good addition" : Math.abs(corrZ) < 0.5 ? "MODERATE" : "HIGH - overlapping"})`);

  // ─── Final Verdict ────────────────────────────────────────────────
  console.log("\n======================================");
  console.log("VALIDATION SUMMARY");
  console.log("======================================");

  const test1Pass = pf5 > 1.0;
  const test2Pass = pctile >= 95;
  const test3Pass = allQProfitable;
  const test4Pass = bothDirProfit;
  const test5Pass = allCombosProfit;
  const test6Pass = profitablePairs >= Math.ceil(totalPairs * 0.5);
  const test7Pass = Math.abs(corrST) < 0.3 && Math.abs(corrZ) < 0.3;

  console.log(`  1. Bootstrap CI:        ${test1Pass ? "PASS" : "FAIL"} (5th pct PF: ${pf5.toFixed(2)})`);
  console.log(`  2. Random Entry:        ${test2Pass ? "PASS" : "FAIL"} (percentile: ${pctile.toFixed(1)}%)`);
  console.log(`  3. Quarterly Stability: ${test3Pass ? "PASS" : "FAIL"}`);
  console.log(`  4. Direction Split:     ${test4Pass ? "PASS" : "FAIL"} (L: $${longStats.pnl.toFixed(2)}, S: $${shortStats.pnl.toFixed(2)})`);
  console.log(`  5. Param Sensitivity:   ${test5Pass ? "PASS" : "FAIL"}`);
  console.log(`  6. Per-Pair Spread:     ${test6Pass ? "PASS" : "FAIL"} (${profitablePairs}/${totalPairs} profitable)`);
  console.log(`  7. Low Correlation:     ${test7Pass ? "PASS" : "FAIL"} (ST: ${corrST.toFixed(3)}, Z: ${corrZ.toFixed(3)})`);

  const passCount = [test1Pass, test2Pass, test3Pass, test4Pass, test5Pass, test6Pass, test7Pass].filter(Boolean).length;
  const deploy = passCount >= 5 && test1Pass && test2Pass;

  console.log(`\n  Score: ${passCount}/7`);
  console.log(`  Trade count OOS: ${oosTrades.length} (${oosTrades.length < 50 ? "WARNING: low sample" : "OK"})`);
  console.log(`\n  >>> DEPLOY ${deploy ? "YES" : "NO"} <<<`);
}

main();
