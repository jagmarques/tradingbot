/**
 * HFT / Microstructure strategy backtest on 5m candles
 *
 * Tight-spread pairs only: XRP, DOGE, ETH, SOL, SUI
 * Full period: 2023-01 to 2026-03 | OOS: 2025-09-01
 *
 * Strategies:
 * 1. BB Mean Reversion (BB 20,2.5)
 * 2. Momentum Scalp (3-bar mom > 2x rolling std)
 * 3. Volume-Weighted MR (VWAP 100 + ATR)
 * 4. Range Breakout (1h range on 5m)
 * 5. RSI Divergence (14-period RSI on 5m)
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const MARGIN = 5;
const NOT = MARGIN * LEV; // $50 notional
const FEE_MAKER = 0.0001;
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;
const BAR_5M = 300000;

const OOS_START = new Date("2025-09-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ETH: 1.5e-4, SOL: 2.0e-4, SUI: 1.85e-4,
};

const PAIRS = ["XRP", "DOGE", "ETH", "SOL", "SUI"];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
    : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) }
  ).sort((a: C, b: C) => a.t - b.t);
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(
  pair: string, ep: number, xp: number, dir: "long" | "short",
  isSL: boolean, feeRate: number
): number {
  const sp = SPREAD[pair] ?? 2e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * feeRate * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcSMA(values: number[], period: number): number[] {
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    sma[i] = s / period;
  }
  return sma;
}

function calcStdDev(values: number[], period: number): number[] {
  const std = new Array(values.length).fill(0);
  const sma = calcSMA(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += (values[j] - sma[i]) ** 2;
    }
    std[i] = Math.sqrt(sumSq / period);
  }
  return std;
}

function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c)
    );
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
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss > 0) rsi[period] = 100 - 100 / (1 + avgGain / avgLoss);
  else rsi[period] = 100;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    if (avgLoss > 0) rsi[i] = 100 - 100 / (1 + avgGain / avgLoss);
    else rsi[i] = 100;
  }
  return rsi;
}

// ─── Metrics ────────────────────────────────────────────────────────
function metrics(trades: Tr[]): {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number; tradesPerDay: number;
} {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, tradesPerDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()].map(p => p / MARGIN);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = 0, equity = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const firstT = Math.min(...trades.map(t => t.et));
  const lastT = Math.max(...trades.map(t => t.xt));
  const days = (lastT - firstT) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    tradesPerDay: days > 0 ? trades.length / days : 0,
  };
}

function fmtRow(name: string, trades: Tr[]): string {
  const m = metrics(trades);
  const sign = m.total >= 0 ? "+" : "";
  return `  ${name.padEnd(42)} `
    + `N=${String(m.n).padStart(6)}  `
    + `PnL=${sign}$${m.total.toFixed(0).padStart(7)}  `
    + `PF=${(m.pf === Infinity ? "Inf" : m.pf.toFixed(2)).padStart(5)}  `
    + `Sh=${m.sharpe.toFixed(2).padStart(6)}  `
    + `WR=${m.wr.toFixed(1).padStart(5)}%  `
    + `$/d=${m.perDay.toFixed(2).padStart(7)}  `
    + `MaxDD=$${m.dd.toFixed(0).padStart(6)}  `
    + `t/d=${m.tradesPerDay.toFixed(1).padStart(5)}`;
}

// ─── STRATEGY 1: BB Mean Reversion ──────────────────────────────────
function strat1_bbMR(candles: C[], pair: string, feeRate: number): Tr[] {
  const trades: Tr[] = [];
  const closes = candles.map(c => c.c);
  const sma = calcSMA(closes, 20);
  const std = calcStdDev(closes, 20);
  const MULT = 2.5;
  const SL_PCT = 0.005;
  const MAX_HOLD = 24; // 2h = 24 bars

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; bars: number } | null = null;

  for (let i = 20; i < candles.length; i++) {
    const c = candles[i];
    const upper = sma[i] + MULT * std[i];
    const lower = sma[i] - MULT * std[i];

    if (pos) {
      pos.bars++;
      const hitSL = pos.dir === "long"
        ? c.l <= pos.sl
        : c.h >= pos.sl;
      const hitMid = pos.dir === "long"
        ? c.c >= sma[i]
        : c.c <= sma[i];
      const expired = pos.bars >= MAX_HOLD;

      if (hitSL) {
        const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: c.t, pnl, reason: "SL" });
        pos = null;
      } else if (hitMid || expired) {
        const pnl = tradePnl(pair, pos.ep, c.c, pos.dir, false, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: c.c, et: pos.et, xt: c.t, pnl, reason: expired ? "EXPIRE" : "MID" });
        pos = null;
      }
    }

    if (!pos && std[i] > 0) {
      if (c.c < lower) {
        pos = { dir: "long", ep: c.c, et: c.t, sl: c.c * (1 - SL_PCT), bars: 0 };
      } else if (c.c > upper) {
        pos = { dir: "short", ep: c.c, et: c.t, sl: c.c * (1 + SL_PCT), bars: 0 };
      }
    }
  }
  return trades;
}

// ─── STRATEGY 2: Momentum Scalp ────────────────────────────────────
function strat2_momScalp(candles: C[], pair: string, feeRate: number): Tr[] {
  const trades: Tr[] = [];
  const closes = candles.map(c => c.c);
  const SL_PCT = 0.003;
  const HOLD_BARS = 3; // 15 minutes

  // Compute 3-bar momentum and 20-bar rolling std of 3-bar momentum
  const mom3 = new Array(closes.length).fill(0);
  for (let i = 3; i < closes.length; i++) {
    mom3[i] = closes[i] - closes[i - 3];
  }

  const momStd = new Array(closes.length).fill(0);
  for (let i = 22; i < closes.length; i++) {
    let s = 0, s2 = 0;
    for (let j = i - 19; j <= i; j++) {
      s += mom3[j];
      s2 += mom3[j] ** 2;
    }
    const mean = s / 20;
    momStd[i] = Math.sqrt(s2 / 20 - mean ** 2);
  }

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; bars: number } | null = null;

  for (let i = 23; i < candles.length; i++) {
    const c = candles[i];

    if (pos) {
      pos.bars++;
      const hitSL = pos.dir === "long"
        ? c.l <= pos.sl
        : c.h >= pos.sl;
      const expired = pos.bars >= HOLD_BARS;

      if (hitSL) {
        const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: c.t, pnl, reason: "SL" });
        pos = null;
      } else if (expired) {
        const pnl = tradePnl(pair, pos.ep, c.c, pos.dir, false, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: c.c, et: pos.et, xt: c.t, pnl, reason: "EXPIRE" });
        pos = null;
      }
    }

    if (!pos && momStd[i] > 0) {
      if (mom3[i] > 2 * momStd[i]) {
        pos = { dir: "long", ep: c.c, et: c.t, sl: c.c * (1 - SL_PCT), bars: 0 };
      } else if (mom3[i] < -2 * momStd[i]) {
        pos = { dir: "short", ep: c.c, et: c.t, sl: c.c * (1 + SL_PCT), bars: 0 };
      }
    }
  }
  return trades;
}

// ─── STRATEGY 3: Volume-Weighted MR ────────────────────────────────
function strat3_vwapMR(candles: C[], pair: string, feeRate: number): Tr[] {
  const trades: Tr[] = [];
  const atr = calcATR(candles, 14);
  const VWAP_PERIOD = 100; // ~8h
  const ATR_MULT = 1.5;
  const MAX_HOLD = 48; // 4h = 48 bars

  // Compute rolling VWAP
  const vwap = new Array(candles.length).fill(0);
  for (let i = VWAP_PERIOD - 1; i < candles.length; i++) {
    let sumPV = 0, sumV = 0;
    for (let j = i - VWAP_PERIOD + 1; j <= i; j++) {
      const typical = (candles[j].h + candles[j].l + candles[j].c) / 3;
      const vol = candles[j].v || 1;
      sumPV += typical * vol;
      sumV += vol;
    }
    vwap[i] = sumV > 0 ? sumPV / sumV : candles[i].c;
  }

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; bars: number } | null = null;

  for (let i = VWAP_PERIOD; i < candles.length; i++) {
    const c = candles[i];
    if (atr[i] <= 0) continue;

    if (pos) {
      pos.bars++;
      const hitSL = pos.dir === "long"
        ? c.l <= pos.sl
        : c.h >= pos.sl;
      const hitVWAP = pos.dir === "long"
        ? c.c >= vwap[i]
        : c.c <= vwap[i];
      const expired = pos.bars >= MAX_HOLD;

      if (hitSL) {
        const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: c.t, pnl, reason: "SL" });
        pos = null;
      } else if (hitVWAP || expired) {
        const pnl = tradePnl(pair, pos.ep, c.c, pos.dir, false, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: c.c, et: pos.et, xt: c.t, pnl, reason: expired ? "EXPIRE" : "VWAP" });
        pos = null;
      }
    }

    if (!pos && vwap[i] > 0) {
      const lowerBand = vwap[i] - ATR_MULT * atr[i];
      const upperBand = vwap[i] + ATR_MULT * atr[i];
      if (c.c < lowerBand) {
        const sl = c.c - 2 * atr[i];
        pos = { dir: "long", ep: c.c, et: c.t, sl, bars: 0 };
      } else if (c.c > upperBand) {
        const sl = c.c + 2 * atr[i];
        pos = { dir: "short", ep: c.c, et: c.t, sl, bars: 0 };
      }
    }
  }
  return trades;
}

// ─── STRATEGY 4: Range Breakout ─────────────────────────────────────
function strat4_rangeBreakout(candles: C[], pair: string, feeRate: number): Tr[] {
  const trades: Tr[] = [];
  const RANGE_BARS = 12; // 1h = 12 bars

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; tp: number } | null = null;

  for (let i = RANGE_BARS; i < candles.length; i++) {
    const c = candles[i];

    // Compute 1h range from preceding 12 bars
    let rangeH = -Infinity, rangeL = Infinity;
    for (let j = i - RANGE_BARS; j < i; j++) {
      if (candles[j].h > rangeH) rangeH = candles[j].h;
      if (candles[j].l < rangeL) rangeL = candles[j].l;
    }
    const rangeSize = rangeH - rangeL;
    const rangeMid = (rangeH + rangeL) / 2;

    if (pos) {
      const hitSL = pos.dir === "long"
        ? c.l <= pos.sl
        : c.h >= pos.sl;
      const hitTP = pos.dir === "long"
        ? c.h >= pos.tp
        : c.l <= pos.tp;

      if (hitSL) {
        const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: c.t, pnl, reason: "SL" });
        pos = null;
      } else if (hitTP) {
        const pnl = tradePnl(pair, pos.ep, pos.tp, pos.dir, false, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.tp, et: pos.et, xt: c.t, pnl, reason: "TP" });
        pos = null;
      }
    }

    if (!pos && rangeSize > 0) {
      if (c.c > rangeH) {
        pos = {
          dir: "long", ep: c.c, et: c.t,
          sl: rangeMid,
          tp: c.c + 1.5 * rangeSize,
        };
      } else if (c.c < rangeL) {
        pos = {
          dir: "short", ep: c.c, et: c.t,
          sl: rangeMid,
          tp: c.c - 1.5 * rangeSize,
        };
      }
    }
  }
  return trades;
}

// ─── STRATEGY 5: RSI Divergence ─────────────────────────────────────
function strat5_rsiDiv(candles: C[], pair: string, feeRate: number): Tr[] {
  const trades: Tr[] = [];
  const closes = candles.map(c => c.c);
  const rsi = calcRSI(closes, 14);
  const SL_PCT = 0.005;
  const MAX_HOLD = 24; // 2h
  const LOOKBACK = 20;

  let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; bars: number } | null = null;

  for (let i = LOOKBACK + 14; i < candles.length; i++) {
    const c = candles[i];

    if (pos) {
      pos.bars++;
      const hitSL = pos.dir === "long"
        ? c.l <= pos.sl
        : c.h >= pos.sl;
      const rsiCross50 = pos.dir === "long"
        ? rsi[i] >= 50
        : rsi[i] <= 50;
      const expired = pos.bars >= MAX_HOLD;

      if (hitSL) {
        const pnl = tradePnl(pair, pos.ep, pos.sl, pos.dir, true, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: pos.sl, et: pos.et, xt: c.t, pnl, reason: "SL" });
        pos = null;
      } else if (rsiCross50 || expired) {
        const pnl = tradePnl(pair, pos.ep, c.c, pos.dir, false, feeRate);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: c.c, et: pos.et, xt: c.t, pnl, reason: expired ? "EXPIRE" : "RSI50" });
        pos = null;
      }
    }

    if (!pos) {
      // Check for bullish divergence: new 20-bar price low, but RSI not at new low
      let priceIsNewLow = true;
      let rsiIsNewLow = true;
      for (let j = i - LOOKBACK; j < i; j++) {
        if (closes[j] <= closes[i]) priceIsNewLow = false;
        if (rsi[j] <= rsi[i]) rsiIsNewLow = false;
      }
      // Bullish: price new low, RSI NOT new low
      if (priceIsNewLow && !rsiIsNewLow && rsi[i] < 35) {
        pos = { dir: "long", ep: c.c, et: c.t, sl: c.c * (1 - SL_PCT), bars: 0 };
      }

      // Check for bearish divergence: new 20-bar price high, but RSI not at new high
      if (!pos) {
        let priceIsNewHigh = true;
        let rsiIsNewHigh = true;
        for (let j = i - LOOKBACK; j < i; j++) {
          if (closes[j] >= closes[i]) priceIsNewHigh = false;
          if (rsi[j] >= rsi[i]) rsiIsNewHigh = false;
        }
        // Bearish: price new high, RSI NOT new high
        if (priceIsNewHigh && !rsiIsNewHigh && rsi[i] > 65) {
          pos = { dir: "short", ep: c.c, et: c.t, sl: c.c * (1 + SL_PCT), bars: 0 };
        }
      }
    }
  }
  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(140));
  console.log("  HFT / MICROSTRUCTURE BACKTEST  |  5m candles  |  Tight-spread pairs");
  console.log("  Pairs: XRP, DOGE, ETH, SOL, SUI  |  $5 margin, 10x lev, $50 notional");
  console.log("  Full: 2023-01 to 2026-03  |  OOS: 2025-09-01+");
  console.log("=".repeat(140));

  // Load data
  const data: Record<string, C[]> = {};
  for (const p of PAIRS) {
    data[p] = load5m(p);
    if (data[p].length === 0) {
      console.log(`  ${p}: NO DATA (skipping)`);
      continue;
    }
    const first = data[p][0];
    const last = data[p][data[p].length - 1];
    console.log(`  ${p}: ${data[p].length} bars [${new Date(first.t).toISOString().slice(0, 10)} -> ${new Date(last.t).toISOString().slice(0, 10)}]`);
  }
  console.log();

  type StratFn = (candles: C[], pair: string, feeRate: number) => Tr[];

  const strategies: { name: string; fn: StratFn; defaultFee: "maker" | "taker" }[] = [
    { name: "1. BB Mean Reversion (20,2.5)", fn: strat1_bbMR, defaultFee: "maker" },
    { name: "2. Momentum Scalp (3-bar)", fn: strat2_momScalp, defaultFee: "maker" },
    { name: "3. VWAP Mean Reversion", fn: strat3_vwapMR, defaultFee: "maker" },
    { name: "4. Range Breakout (1h)", fn: strat4_rangeBreakout, defaultFee: "taker" },
    { name: "5. RSI Divergence (14)", fn: strat5_rsiDiv, defaultFee: "maker" },
  ];

  for (const strat of strategies) {
    console.log("-".repeat(140));
    console.log(`  STRATEGY: ${strat.name}`);
    console.log("-".repeat(140));

    for (const feeLabel of ["MAKER (0.01%)", "TAKER (0.035%)"]) {
      const feeRate = feeLabel.startsWith("MAKER") ? FEE_MAKER : FEE_TAKER;
      console.log(`\n  Fees: ${feeLabel}`);
      console.log(`  ${"".padEnd(42)} ${"N".padStart(8)}  ${"PnL".padStart(12)}  ${"PF".padStart(7)}  ${"Sharpe".padStart(8)}  ${"WR".padStart(8)}  ${"$/day".padStart(9)}  ${"MaxDD".padStart(10)}  ${"t/day".padStart(7)}`);

      let allTradesFull: Tr[] = [];
      let allTradesOOS: Tr[] = [];

      for (const pair of PAIRS) {
        if (data[pair].length === 0) continue;
        const allTrades = strat.fn(data[pair], pair, feeRate);
        const full = allTrades;
        const oos = allTrades.filter(t => t.et >= OOS_START);

        allTradesFull.push(...full);
        allTradesOOS.push(...oos);

        console.log(fmtRow(`  ${pair} FULL`, full));
        console.log(fmtRow(`  ${pair} OOS`, oos));
      }

      console.log();
      console.log(fmtRow(`  ** PORTFOLIO FULL **`, allTradesFull));
      console.log(fmtRow(`  ** PORTFOLIO OOS  **`, allTradesOOS));

      // Exit reason breakdown
      if (allTradesFull.length > 0) {
        const reasons = new Map<string, number>();
        for (const t of allTradesFull) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
        const reasonStr = [...reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r}=${n}`)
          .join(", ");
        console.log(`  Exit reasons: ${reasonStr}`);
      }
    }
    console.log();
  }

  // ─── Summary Table ─────────────────────────────────────────────────
  console.log("=".repeat(140));
  console.log("  SUMMARY: OOS Performance (Maker fees) per strategy");
  console.log("=".repeat(140));
  console.log(`  ${"Strategy".padEnd(38)} ${"N".padStart(6)}  ${"PnL".padStart(10)}  ${"PF".padStart(6)}  ${"Sharpe".padStart(7)}  ${"WR".padStart(7)}  ${"$/day".padStart(8)}  ${"MaxDD".padStart(8)}  ${"t/day".padStart(6)}`);

  for (const strat of strategies) {
    let allOOS: Tr[] = [];
    for (const pair of PAIRS) {
      if (data[pair].length === 0) continue;
      const trades = strat.fn(data[pair], pair, FEE_MAKER);
      allOOS.push(...trades.filter(t => t.et >= OOS_START));
    }
    const m = metrics(allOOS);
    const sign = m.total >= 0 ? "+" : "";
    console.log(
      `  ${strat.name.padEnd(38)} `
      + `${String(m.n).padStart(6)}  `
      + `${sign}$${m.total.toFixed(0).padStart(8)}  `
      + `${(m.pf === Infinity ? "Inf" : m.pf.toFixed(2)).padStart(6)}  `
      + `${m.sharpe.toFixed(2).padStart(7)}  `
      + `${m.wr.toFixed(1).padStart(6)}%  `
      + `${m.perDay.toFixed(2).padStart(8)}  `
      + `$${m.dd.toFixed(0).padStart(6)}  `
      + `${m.tradesPerDay.toFixed(1).padStart(6)}`
    );
  }

  console.log();
  console.log("=".repeat(140));
  console.log("  SUMMARY: OOS Performance (Taker fees) per strategy");
  console.log("=".repeat(140));
  console.log(`  ${"Strategy".padEnd(38)} ${"N".padStart(6)}  ${"PnL".padStart(10)}  ${"PF".padStart(6)}  ${"Sharpe".padStart(7)}  ${"WR".padStart(7)}  ${"$/day".padStart(8)}  ${"MaxDD".padStart(8)}  ${"t/day".padStart(6)}`);

  for (const strat of strategies) {
    let allOOS: Tr[] = [];
    for (const pair of PAIRS) {
      if (data[pair].length === 0) continue;
      const trades = strat.fn(data[pair], pair, FEE_TAKER);
      allOOS.push(...trades.filter(t => t.et >= OOS_START));
    }
    const m = metrics(allOOS);
    const sign = m.total >= 0 ? "+" : "";
    console.log(
      `  ${strat.name.padEnd(38)} `
      + `${String(m.n).padStart(6)}  `
      + `${sign}$${m.total.toFixed(0).padStart(8)}  `
      + `${(m.pf === Infinity ? "Inf" : m.pf.toFixed(2)).padStart(6)}  `
      + `${m.sharpe.toFixed(2).padStart(7)}  `
      + `${m.wr.toFixed(1).padStart(6)}%  `
      + `${m.perDay.toFixed(2).padStart(8)}  `
      + `$${m.dd.toFixed(0).padStart(6)}  `
      + `${m.tradesPerDay.toFixed(1).padStart(6)}`
    );
  }

  console.log();
}

main();
