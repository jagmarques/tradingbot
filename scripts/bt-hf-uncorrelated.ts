/**
 * High-Frequency Uncorrelated Engine Backtest
 *
 * 5 strategies on 1h candles (aggregated from 5m cache), tight-spread pairs only.
 * Goal: 5-10 trades/day to smooth equity curve alongside existing 4h Supertrend.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-hf-uncorrelated.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CD = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 3; // $3 margin
const NOT = SIZE * LEV; // $30 notional
const H = 3_600_000;
const DAY = 86_400_000;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// Tight-spread pairs only
const PAIRS = ["XRP", "DOGE", "ETH", "SOL", "ARB", "ENA"];

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, BTC: 0.5e-4,
};

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; engine: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CD, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo1h(candles: C[]): C[] {
  const barsPerGroup = 12; // 12 x 5m = 1h
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const hourTs = Math.floor(c.t / H) * H;
    const arr = groups.get(hourTs) ?? [];
    arr.push(c);
    groups.set(hourTs, arr);
  }
  const result: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < barsPerGroup * 0.8) continue;
    result.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(g => g.h)),
      l: Math.min(...bars.map(g => g.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

function aggregateTo4h(candles1h: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles1h) {
    const fourHTs = Math.floor(c.t / (4 * H)) * (4 * H);
    const arr = groups.get(fourHTs) ?? [];
    arr.push(c);
    groups.set(fourHTs, arr);
  }
  const result: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 3) continue;
    result.push({
      t: ts,
      o: bars[0].o,
      h: Math.max(...bars.map(g => g.h)),
      l: Math.min(...bars.map(g => g.l)),
      c: bars[bars.length - 1].c,
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
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

function calcRSI(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  if (period < closes.length) {
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcWilliamsR(cs: C[], period: number): number[] {
  const wr = new Array(cs.length).fill(-50);
  for (let i = period - 1; i < cs.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (cs[j].h > hh) hh = cs[j].h;
      if (cs[j].l < ll) ll = cs[j].l;
    }
    wr[i] = hh === ll ? -50 : ((hh - cs[i].c) / (hh - ll)) * -100;
  }
  return wr;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i - 1].h + cs[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (cs[i - 1].h + cs[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = st[i - 1] > 0 && dirs[i - 1] === -1 ? st[i - 1] : prevUpper;
      const prevFinalLower = st[i - 1] > 0 && dirs[i - 1] === 1 ? st[i - 1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i - 1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i - 1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }
  return { st, dir: dirs };
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", fee: number): number {
  const sp = SPREAD[pair] ?? 3e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp;
  const fees = NOT * fee * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number; tradesPerDay: number;
}

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, tradesPerDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

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
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    tradesPerDay: days > 0 ? trades.length / days : 0,
  };
}

// ─── Strategy 1: Micro-Trend Following (EMA 5/13 cross) ─────────────
function stratEMACross(
  pair: string, cs: C[], fee: number, startTs: number, endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const closes = cs.map(c => c.c);
  const ema5 = calcEMA(closes, 5);
  const ema13 = calcEMA(closes, 13);

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; barCount: number } | null = null;

  for (let i = 14; i < cs.length; i++) {
    if (cs[i].t < startTs) continue;
    if (cs[i].t > endTs && !pos) continue;

    const bar = cs[i];

    // Check exits
    if (pos) {
      pos.barCount++;
      // SL check
      const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
      // Reverse cross
      const reverseCross = pos.dir === "long"
        ? (ema5[i - 1] < ema13[i - 1])
        : (ema5[i - 1] > ema13[i - 1]);
      // Max hold 4 bars
      const maxHold = pos.barCount >= 4;

      if (slHit) {
        const xp = pos.dir === "long" ? pos.sl : pos.sl;
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, xp, pos.dir, fee), reason: "sl", engine: "EMA-Cross" });
        pos = null;
      } else if (reverseCross || maxHold) {
        const xp = bar.o;
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, xp, pos.dir, fee), reason: reverseCross ? "flip" : "maxhold", engine: "EMA-Cross" });
        pos = null;
      }
    }

    // Entry: EMA(5) crosses EMA(13) - look at previous bar's cross
    if (!pos && cs[i].t >= startTs && cs[i].t < endTs && ema5[i - 1] !== 0 && ema13[i - 1] !== 0 && ema5[i - 2] !== 0 && ema13[i - 2] !== 0) {
      const crossUp = ema5[i - 2] <= ema13[i - 2] && ema5[i - 1] > ema13[i - 1];
      const crossDown = ema5[i - 2] >= ema13[i - 2] && ema5[i - 1] < ema13[i - 1];

      if (crossUp) {
        const ep = bar.o;
        pos = { dir: "long", ep, et: bar.t, sl: ep * (1 - 0.015), barCount: 0 };
      } else if (crossDown) {
        const ep = bar.o;
        pos = { dir: "short", ep, et: bar.t, sl: ep * (1 + 0.015), barCount: 0 };
      }
    }
  }
  return trades;
}

// ─── Strategy 2: Momentum Burst (3 consecutive same-direction bars > ATR) ───
function stratMomentumBurst(
  pair: string, cs: C[], fee: number, startTs: number, endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const atr = calcATR(cs, 14);

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; barCount: number; tpPrice: number } | null = null;

  for (let i = 15; i < cs.length; i++) {
    if (cs[i].t < startTs) continue;
    if (cs[i].t > endTs && !pos) continue;

    const bar = cs[i];

    // Check exits
    if (pos) {
      pos.barCount++;
      const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
      const tpHit = pos.dir === "long" ? bar.h >= pos.tpPrice : bar.l <= pos.tpPrice;
      const maxHold = pos.barCount >= 2;

      if (slHit) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, pos.sl, pos.dir, fee), reason: "sl", engine: "MomBurst" });
        pos = null;
      } else if (tpHit) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.tpPrice, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, pos.tpPrice, pos.dir, fee), reason: "tp", engine: "MomBurst" });
        pos = null;
      } else if (maxHold) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: bar.o, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, bar.o, pos.dir, fee), reason: "maxhold", engine: "MomBurst" });
        pos = null;
      }
    }

    // Entry
    if (!pos && cs[i].t >= startTs && cs[i].t < endTs && i >= 3 && atr[i - 1] > 0) {
      // Check last 3 bars (i-3, i-2, i-1) all same direction
      const b1 = cs[i - 3], b2 = cs[i - 2], b3 = cs[i - 1];
      const allGreen = b1.c > b1.o && b2.c > b2.o && b3.c > b3.o;
      const allRed = b1.c < b1.o && b2.c < b2.o && b3.c < b3.o;

      if (allGreen || allRed) {
        const totalMove = Math.abs(b3.c - b1.o);
        if (totalMove > 1.0 * atr[i - 1]) {
          const dir: "long" | "short" = allGreen ? "long" : "short";
          const ep = bar.o;
          const sl = dir === "long" ? ep * (1 - 0.01) : ep * (1 + 0.01);
          const tp = dir === "long" ? ep * (1 + 0.01) : ep * (1 - 0.01);
          pos = { dir, ep, et: bar.t, sl, barCount: 0, tpPrice: tp };
        }
      }
    }
  }
  return trades;
}

// ─── Strategy 3: RSI Bounce with EMA Trend + BTC Filter ─────────────
function stratRSIBounce(
  pair: string, cs: C[], btcCs: C[], fee: number, startTs: number, endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const closes = cs.map(c => c.c);
  const rsi = calcRSI(closes, 7);
  const ema50 = calcEMA(closes, 50);

  // BTC trend: EMA(20) vs EMA(50) on 1h
  const btcCloses = btcCs.map(c => c.c);
  const btcEma20 = calcEMA(btcCloses, 20);
  const btcEma50 = calcEMA(btcCloses, 50);
  const btcTm = new Map<number, number>();
  btcCs.forEach((c, idx) => btcTm.set(c.t, idx));

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;

  for (let i = 51; i < cs.length; i++) {
    if (cs[i].t < startTs) continue;
    if (cs[i].t > endTs && !pos) continue;

    const bar = cs[i];

    // Check exits
    if (pos) {
      const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
      // RSI crosses 50
      const rsiExit = pos.dir === "long"
        ? (rsi[i - 2] < 50 && rsi[i - 1] >= 50)  // was below, crossed up
        : (rsi[i - 2] > 50 && rsi[i - 1] <= 50); // was above, crossed down
      // Actually: exit when RSI crosses 50 (reaches neutral)
      const rsiNeutral = pos.dir === "long" ? rsi[i - 1] >= 50 : rsi[i - 1] <= 50;

      if (slHit) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, pos.sl, pos.dir, fee), reason: "sl", engine: "RSI-Bounce" });
        pos = null;
      } else if (rsiNeutral) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: bar.o, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, bar.o, pos.dir, fee), reason: "rsi50", engine: "RSI-Bounce" });
        pos = null;
      }
    }

    // Entry
    if (!pos && cs[i].t >= startTs && cs[i].t < endTs && ema50[i - 1] > 0) {
      // BTC trend filter
      const btcIdx = btcTm.get(cs[i].t);
      let btcTrend: "long" | "short" | null = null;
      if (btcIdx !== undefined && btcIdx >= 50 && btcEma20[btcIdx] > 0 && btcEma50[btcIdx] > 0) {
        btcTrend = btcEma20[btcIdx] > btcEma50[btcIdx] ? "long" : "short";
      }

      const longSig = rsi[i - 1] < 25 && cs[i - 1].c > ema50[i - 1];
      const shortSig = rsi[i - 1] > 75 && cs[i - 1].c < ema50[i - 1];

      if (longSig && btcTrend === "long") {
        const ep = bar.o;
        pos = { dir: "long", ep, et: bar.t, sl: ep * (1 - 0.015) };
      } else if (shortSig && btcTrend === "short") {
        const ep = bar.o;
        pos = { dir: "short", ep, et: bar.t, sl: ep * (1 + 0.015) };
      }
    }
  }
  return trades;
}

// ─── Strategy 4: Doji Reversal ──────────────────────────────────────
function stratDojiReversal(
  pair: string, cs: C[], fee: number, startTs: number, endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; barCount: number } | null = null;

  for (let i = 5; i < cs.length; i++) {
    if (cs[i].t < startTs) continue;
    if (cs[i].t > endTs && !pos) continue;

    const bar = cs[i];

    // Check exits
    if (pos) {
      pos.barCount++;
      const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
      const maxHold = pos.barCount >= 3;

      if (slHit) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, pos.sl, pos.dir, fee), reason: "sl", engine: "Doji-Rev" });
        pos = null;
      } else if (maxHold) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: bar.o, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, bar.o, pos.dir, fee), reason: "maxhold", engine: "Doji-Rev" });
        pos = null;
      }
    }

    // Entry: detect doji at i-1, enter at i
    if (!pos && cs[i].t >= startTs && cs[i].t < endTs) {
      const doji = cs[i - 1];
      const body = Math.abs(doji.c - doji.o);
      const range = doji.h - doji.l;
      if (range <= 0) continue;
      const isDoji = body < 0.2 * range;

      if (isDoji) {
        // Check 3+ bars trending before the doji
        let upCount = 0, downCount = 0;
        for (let j = i - 4; j < i - 1; j++) {
          if (j < 0) continue;
          if (cs[j].c > cs[j].o) upCount++;
          else if (cs[j].c < cs[j].o) downCount++;
        }

        if (upCount >= 3) {
          // Was trending UP -> reversal SHORT
          const ep = bar.o;
          const sl = doji.h; // SL at doji high
          pos = { dir: "short", ep, et: bar.t, sl, barCount: 0 };
        } else if (downCount >= 3) {
          // Was trending DOWN -> reversal LONG
          const ep = bar.o;
          const sl = doji.l; // SL at doji low
          pos = { dir: "long", ep, et: bar.t, sl, barCount: 0 };
        }
      }
    }
  }
  return trades;
}

// ─── Strategy 5: Williams %R Extreme ────────────────────────────────
function stratWilliamsR(
  pair: string, cs: C[], fee: number, startTs: number, endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const wr = calcWilliamsR(cs, 14);

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;

  for (let i = 15; i < cs.length; i++) {
    if (cs[i].t < startTs) continue;
    if (cs[i].t > endTs && !pos) continue;

    const bar = cs[i];

    // Check exits
    if (pos) {
      const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
      // %R crosses -50
      const wrNeutral = pos.dir === "long" ? wr[i - 1] >= -50 : wr[i - 1] <= -50;

      if (slHit) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, pos.sl, pos.dir, fee), reason: "sl", engine: "WilliamsR" });
        pos = null;
      } else if (wrNeutral) {
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: bar.o, et: pos.et, xt: bar.t, pnl: tradePnl(pair, pos.ep, bar.o, pos.dir, fee), reason: "wr50", engine: "WilliamsR" });
        pos = null;
      }
    }

    // Entry
    if (!pos && cs[i].t >= startTs && cs[i].t < endTs) {
      if (wr[i - 1] < -95) {
        const ep = bar.o;
        pos = { dir: "long", ep, et: bar.t, sl: ep * (1 - 0.015) };
      } else if (wr[i - 1] > -5) {
        const ep = bar.o;
        pos = { dir: "short", ep, et: bar.t, sl: ep * (1 + 0.015) };
      }
    }
  }
  return trades;
}

// ─── Supertrend Reference (for correlation) ─────────────────────────
function stratSupertrendRef(
  pair: string, cs4h: C[], startTs: number, endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  if (cs4h.length < 30) return trades;
  const { dir } = calcSupertrend(cs4h, 14, 2);
  let pos: { dir: "long" | "short"; ep: number; et: number } | null = null;

  for (let i = 16; i < cs4h.length; i++) {
    if (cs4h[i].t > endTs && !pos) continue;

    const prevDir = dir[i - 1];
    const prevPrevDir = dir[i - 2];
    const flipped = prevDir !== prevPrevDir;

    if (pos && flipped) {
      const xp = cs4h[i].o;
      if (pos.et >= startTs && pos.et < endTs) {
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, 0.00035);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: cs4h[i].t, pnl, reason: "flip", engine: "ST-Ref" });
      }
      pos = null;
    }

    if (!pos && flipped && cs4h[i].t >= startTs && cs4h[i].t < endTs) {
      const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";
      pos = { dir: newDir, ep: cs4h[i].o, et: cs4h[i].t };
    }
  }
  return trades;
}

// ─── Correlation ────────────────────────────────────────────────────
function dailyPnlMap(trades: Tr[]): Map<number, number> {
  const dp = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dp.set(d, (dp.get(d) ?? 0) + t.pnl);
  }
  return dp;
}

function pearsonCorrelation(a: Map<number, number>, b: Map<number, number>): number {
  const allDays = new Set([...a.keys(), ...b.keys()]);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of allDays) {
    xs.push(a.get(d) ?? 0);
    ys.push(b.get(d) ?? 0);
  }
  if (xs.length < 10) return 0;

  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading 5m data and aggregating to 1h...");

const data1h = new Map<string, C[]>();
const data4h = new Map<string, C[]>();
let btc1h: C[] = [];
let btc4h: C[] = [];

for (const pair of [...PAIRS, "BTC"]) {
  const raw = load5m(pair);
  const h1 = aggregateTo1h(raw);
  const h4 = aggregateTo4h(h1);
  data1h.set(pair, h1);
  data4h.set(pair, h4);
  if (pair === "BTC") {
    btc1h = h1;
    btc4h = h4;
  }
  console.log(`  ${pair}: ${raw.length} 5m -> ${h1.length} 1h -> ${h4.length} 4h`);
}

// Generate Supertrend reference daily P&L for correlation
const stRefTrades: Tr[] = [];
for (const pair of PAIRS) {
  const cs4h = data4h.get(pair);
  if (cs4h) {
    stRefTrades.push(...stratSupertrendRef(pair, cs4h, OOS_START, FULL_END));
  }
}
const stRefDaily = dailyPnlMap(stRefTrades);

const FEE_MAKER = 0.0001;
const FEE_TAKER = 0.00035;
const feeLabels = ["MAKER(0.01%)", "TAKER(0.035%)"];
const fees = [FEE_MAKER, FEE_TAKER];

console.log(`\n${"=".repeat(120)}`);
console.log(`HIGH-FREQUENCY 1h ENGINE BACKTEST`);
console.log(`Pairs: ${PAIRS.join(", ")} | Size: $${SIZE}x${LEV} = $${NOT} notional`);
console.log(`Full: 2023-01 to 2026-03 | OOS: 2025-09-01+`);
console.log(`${"=".repeat(120)}`);

type StratFn = (pair: string, cs: C[], fee: number, startTs: number, endTs: number) => Tr[];
type StratFnBtc = (pair: string, cs: C[], btcCs: C[], fee: number, startTs: number, endTs: number) => Tr[];

interface StratDef {
  name: string;
  fn: StratFn | null;
  fnBtc: StratFnBtc | null;
  needsBtc: boolean;
}

const strats: StratDef[] = [
  { name: "1. EMA Cross (5/13)", fn: stratEMACross, fnBtc: null, needsBtc: false },
  { name: "2. Momentum Burst", fn: stratMomentumBurst, fnBtc: null, needsBtc: false },
  { name: "3. RSI Bounce + BTC", fn: null, fnBtc: stratRSIBounce, needsBtc: true },
  { name: "4. Doji Reversal", fn: stratDojiReversal, fnBtc: null, needsBtc: false },
  { name: "5. Williams %R", fn: stratWilliamsR, fnBtc: null, needsBtc: false },
];

for (const strat of strats) {
  console.log(`\n--- ${strat.name} ---`);
  console.log(`${"Fee Model".padEnd(17)} ${"Trades".padStart(7)} ${"T/day".padStart(7)} ${"WR%".padStart(7)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"$/day".padStart(8)} ${"MaxDD".padStart(8)} ${"Total".padStart(9)} ${"Corr-ST".padStart(8)}`);
  console.log("-".repeat(95));

  for (let fi = 0; fi < fees.length; fi++) {
    const fee = fees[fi];

    // OOS trades
    const allOOS: Tr[] = [];
    for (const pair of PAIRS) {
      const cs = data1h.get(pair);
      if (!cs || cs.length < 100) continue;
      let trades: Tr[];
      if (strat.needsBtc) {
        trades = strat.fnBtc!(pair, cs, btc1h, fee, OOS_START, FULL_END);
      } else {
        trades = strat.fn!(pair, cs, fee, OOS_START, FULL_END);
      }
      allOOS.push(...trades);
    }

    const m = calcMetrics(allOOS, OOS_START, FULL_END);
    const corr = pearsonCorrelation(dailyPnlMap(allOOS), stRefDaily);

    console.log(
      `${feeLabels[fi].padEnd(17)} ${String(m.n).padStart(7)} ${m.tradesPerDay.toFixed(1).padStart(7)} ${m.wr.toFixed(1).padStart(7)} ${m.pf.toFixed(2).padStart(7)} ${m.sharpe.toFixed(2).padStart(8)} ${("$" + m.perDay.toFixed(2)).padStart(8)} ${("$" + m.dd.toFixed(0)).padStart(8)} ${(m.total >= 0 ? "+$" + m.total.toFixed(0) : "-$" + Math.abs(m.total).toFixed(0)).padStart(9)} ${corr.toFixed(3).padStart(8)}`
    );
  }

  // Per-pair breakdown (OOS, maker fees)
  console.log(`\n  Per-pair OOS (maker fees):`);
  for (const pair of PAIRS) {
    const cs = data1h.get(pair);
    if (!cs || cs.length < 100) continue;
    let trades: Tr[];
    if (strat.needsBtc) {
      trades = strat.fnBtc!(pair, cs, btc1h, FEE_MAKER, OOS_START, FULL_END);
    } else {
      trades = strat.fn!(pair, cs, FEE_MAKER, OOS_START, FULL_END);
    }
    const m = calcMetrics(trades, OOS_START, FULL_END);
    if (m.n > 0) {
      console.log(`    ${pair.padEnd(6)} ${String(m.n).padStart(5)} trades  ${m.tradesPerDay.toFixed(1).padStart(5)} t/d  WR=${m.wr.toFixed(1)}%  PF=${m.pf.toFixed(2)}  $${m.perDay.toFixed(2)}/day  DD=$${m.dd.toFixed(0)}`);
    }
  }
}

// ─── Full-period IS vs OOS comparison ───────────────────────────────
console.log(`\n\n${"=".repeat(120)}`);
console.log(`IN-SAMPLE vs OUT-OF-SAMPLE (Maker Fees Only)`);
console.log(`${"=".repeat(120)}`);
console.log(`${"Strategy".padEnd(25)} ${"IS Trades".padStart(10)} ${"IS T/d".padStart(8)} ${"IS $/d".padStart(8)} ${"IS Sharpe".padStart(10)} | ${"OOS Trades".padStart(10)} ${"OOS T/d".padStart(8)} ${"OOS $/d".padStart(8)} ${"OOS Sharpe".padStart(10)}`);
console.log("-".repeat(115));

for (const strat of strats) {
  const allIS: Tr[] = [];
  const allOOS: Tr[] = [];
  for (const pair of PAIRS) {
    const cs = data1h.get(pair);
    if (!cs || cs.length < 100) continue;
    if (strat.needsBtc) {
      allIS.push(...strat.fnBtc!(pair, cs, btc1h, FEE_MAKER, FULL_START, OOS_START));
      allOOS.push(...strat.fnBtc!(pair, cs, btc1h, FEE_MAKER, OOS_START, FULL_END));
    } else {
      allIS.push(...strat.fn!(pair, cs, FEE_MAKER, FULL_START, OOS_START));
      allOOS.push(...strat.fn!(pair, cs, FEE_MAKER, OOS_START, FULL_END));
    }
  }
  const isM = calcMetrics(allIS, FULL_START, OOS_START);
  const oosM = calcMetrics(allOOS, OOS_START, FULL_END);
  console.log(
    `${strat.name.padEnd(25)} ${String(isM.n).padStart(10)} ${isM.tradesPerDay.toFixed(1).padStart(8)} ${("$" + isM.perDay.toFixed(2)).padStart(8)} ${isM.sharpe.toFixed(2).padStart(10)} | ${String(oosM.n).padStart(10)} ${oosM.tradesPerDay.toFixed(1).padStart(8)} ${("$" + oosM.perDay.toFixed(2)).padStart(8)} ${oosM.sharpe.toFixed(2).padStart(10)}`
  );
}

// ─── Combined HF Engine (all strategies together) ───────────────────
console.log(`\n\n${"=".repeat(120)}`);
console.log(`COMBINED HF ENGINE (all 5 strategies together)`);
console.log(`${"=".repeat(120)}`);

for (let fi = 0; fi < fees.length; fi++) {
  const fee = fees[fi];
  const allCombined: Tr[] = [];

  for (const strat of strats) {
    for (const pair of PAIRS) {
      const cs = data1h.get(pair);
      if (!cs || cs.length < 100) continue;
      if (strat.needsBtc) {
        allCombined.push(...strat.fnBtc!(pair, cs, btc1h, fee, OOS_START, FULL_END));
      } else {
        allCombined.push(...strat.fn!(pair, cs, fee, OOS_START, FULL_END));
      }
    }
  }

  const m = calcMetrics(allCombined, OOS_START, FULL_END);
  const corr = pearsonCorrelation(dailyPnlMap(allCombined), stRefDaily);

  console.log(`\n${feeLabels[fi]}:`);
  console.log(`  Trades: ${m.n}  |  Trades/day: ${m.tradesPerDay.toFixed(1)}  |  WR: ${m.wr.toFixed(1)}%  |  PF: ${m.pf.toFixed(2)}`);
  console.log(`  Sharpe: ${m.sharpe.toFixed(2)}  |  $/day: $${m.perDay.toFixed(2)}  |  MaxDD: $${m.dd.toFixed(0)}  |  Total: ${m.total >= 0 ? "+$" + m.total.toFixed(0) : "-$" + Math.abs(m.total).toFixed(0)}`);
  console.log(`  Correlation with Supertrend daily P&L: ${corr.toFixed(3)}`);

  // Engine breakdown
  const byEngine = new Map<string, Tr[]>();
  for (const t of allCombined) {
    const arr = byEngine.get(t.engine) ?? [];
    arr.push(t);
    byEngine.set(t.engine, arr);
  }
  console.log(`\n  Engine breakdown:`);
  for (const [eng, trades] of byEngine) {
    const em = calcMetrics(trades, OOS_START, FULL_END);
    console.log(`    ${eng.padEnd(15)} ${String(em.n).padStart(6)} trades  ${em.tradesPerDay.toFixed(1).padStart(5)} t/d  WR=${em.wr.toFixed(1)}%  PF=${em.pf.toFixed(2)}  $${em.perDay.toFixed(2)}/day`);
  }
}

// ─── Monthly OOS Breakdown (Maker, combined) ────────────────────────
console.log(`\n\n${"=".repeat(120)}`);
console.log(`MONTHLY OOS BREAKDOWN (Maker Fees, Combined)`);
console.log(`${"=".repeat(120)}`);

const allCombinedMaker: Tr[] = [];
for (const strat of strats) {
  for (const pair of PAIRS) {
    const cs = data1h.get(pair);
    if (!cs || cs.length < 100) continue;
    if (strat.needsBtc) {
      allCombinedMaker.push(...strat.fnBtc!(pair, cs, btc1h, FEE_MAKER, OOS_START, FULL_END));
    } else {
      allCombinedMaker.push(...strat.fn!(pair, cs, FEE_MAKER, OOS_START, FULL_END));
    }
  }
}

const monthlyPnl = new Map<string, { pnl: number; trades: number; wins: number }>();
for (const t of allCombinedMaker) {
  const d = new Date(t.xt);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const cur = monthlyPnl.get(key) ?? { pnl: 0, trades: 0, wins: 0 };
  cur.pnl += t.pnl;
  cur.trades++;
  if (t.pnl > 0) cur.wins++;
  monthlyPnl.set(key, cur);
}

console.log(`${"Month".padEnd(10)} ${"Trades".padStart(8)} ${"WR%".padStart(7)} ${"PnL".padStart(10)}`);
console.log("-".repeat(40));
for (const [month, data] of [...monthlyPnl.entries()].sort()) {
  const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
  console.log(`${month.padEnd(10)} ${String(data.trades).padStart(8)} ${(data.wins / data.trades * 100).toFixed(1).padStart(7)} ${pnlStr.padStart(10)}`);
}

console.log("\nDone.");
