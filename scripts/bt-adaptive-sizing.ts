/**
 * Adaptive Position Sizing Backtest
 *
 * Base engine: Supertrend(14, 1.75) + volume filter on 5m candles aggregated to 4h.
 * Tests 6 sizing strategies vs flat $3 baseline.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;
const ST_PERIOD = 14;
const ST_MULT = 1.75;

const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE",
  "APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long"|"short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; size: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => Array.isArray(b)
    ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
    : b
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48; // 48 × 5m = 4h
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j-1].c), Math.abs(cs[j].l - cs[j-1].c));
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

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
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
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
      const prevUpper = (cs[i-1].h + cs[i-1].l) / 2 + mult * atr[i-1];
      const prevLower = (cs[i-1].h + cs[i-1].l) / 2 - mult * atr[i-1];
      const prevFinalUpper = st[i-1] > 0 && dirs[i-1] === -1 ? st[i-1] : prevUpper;
      const prevFinalLower = st[i-1] > 0 && dirs[i-1] === 1 ? st[i-1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i-1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i-1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i-1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

function calcADX(cs: C[], period: number): number[] {
  const adx = new Array(cs.length).fill(0);
  const dxArr: number[] = [];
  let plusDmSmooth = 0, minusDmSmooth = 0, trSmooth = 0;

  for (let i = 1; i < cs.length; i++) {
    const upMove = cs[i].h - cs[i-1].h;
    const downMove = cs[i-1].l - cs[i].l;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));

    if (i <= period) {
      plusDmSmooth += plusDm;
      minusDmSmooth += minusDm;
      trSmooth += tr;
      if (i === period) {
        plusDmSmooth /= period;
        minusDmSmooth /= period;
        trSmooth /= period;
      }
    } else {
      plusDmSmooth = plusDmSmooth - plusDmSmooth / period + plusDm;
      minusDmSmooth = minusDmSmooth - minusDmSmooth / period + minusDm;
      trSmooth = trSmooth - trSmooth / period + tr;
    }

    if (i >= period && trSmooth > 0) {
      const plusDI = (plusDmSmooth / trSmooth) * 100;
      const minusDI = (minusDmSmooth / trSmooth) * 100;
      const sumDI = plusDI + minusDI;
      const dx = sumDI > 0 ? Math.abs(plusDI - minusDI) / sumDI * 100 : 0;
      dxArr.push(dx);

      if (dxArr.length === period) {
        adx[i] = dxArr.reduce((a, b) => a + b, 0) / period;
      } else if (dxArr.length > period) {
        adx[i] = (adx[i-1] * (period - 1) + dx) / period;
      }
    }
  }
  return adx;
}

function calcRSI(cs: C[], period: number): number[] {
  const rsi = new Array(cs.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < cs.length; i++) {
    const change = cs[i].c - cs[i-1].c;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
        rsi[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
      rsi[i] = 100 - 100 / (1 + rs);
    }
  }
  return rsi;
}

// Pseudo-volume from 5m bar data: sum of (h-l)/c for each 5m bar in each 4h group
function calcVolumes(raw5m: C[], cs4h: C[]): number[] {
  const vols = new Array(cs4h.length).fill(0);
  const barsPerGroup = 48;
  for (let g = 0; g < cs4h.length; g++) {
    const startIdx = g * barsPerGroup;
    const endIdx = Math.min(startIdx + barsPerGroup, raw5m.length);
    let rangeSum = 0;
    for (let j = startIdx; j < endIdx; j++) {
      rangeSum += (raw5m[j].h - raw5m[j].l) / raw5m[j].c;
    }
    vols[g] = rangeSum;
  }
  return vols;
}

function calcVolSMA(vols: number[], period: number): number[] {
  const sma = new Array(vols.length).fill(0);
  for (let i = period - 1; i < vols.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += vols[j];
    sma[i] = s / period;
  }
  return sma;
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long"|"short", isSL: boolean, size: number): number {
  const notional = size * LEV;
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = notional * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * notional
    : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number; avgSize: number;
}

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0, avgSize: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avgSize = trades.reduce((s, t) => s + t.size, 0) / trades.length;

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
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    avgSize,
  };
}

// ─── Pair Data ──────────────────────────────────────────────────────
interface PairData {
  raw5m: C[];
  cs: C[];        // 4h bars
  atr14: number[];
  adx14: number[];
  rsi14: number[];
  vol: number[];
  volSMA20: number[];
  stDir: number[];
}

function preparePair(pair: string): PairData | null {
  const raw5m = load5m(pair);
  if (raw5m.length < 2000) return null;
  const cs = aggregateTo4h(raw5m);
  if (cs.length < 200) return null;

  const atr14 = calcATR(cs, 14);
  const adx14 = calcADX(cs, 14);
  const rsi14 = calcRSI(cs, 14);
  const vol = calcVolumes(raw5m, cs);
  const volSMA20 = calcVolSMA(vol, 20);
  const { dir: stDir } = calcSupertrend(cs, ST_PERIOD, ST_MULT);

  return { raw5m, cs, atr14, adx14, rsi14, vol, volSMA20, stDir };
}

// ─── Sizing Strategies ──────────────────────────────────────────────
type SizeFn = (
  pair: string, dir: "long"|"short", barIdx: number,
  pd: PairData, btcPd: PairData | null,
  recentTrades: Tr[], allPairATRs: Map<string, number>,
  equityCurve: number[], equitySMA: number[],
) => number;

const sizingStrategies: { name: string; fn: SizeFn }[] = [
  // 0: Flat $3 baseline
  {
    name: "Flat $3 Baseline",
    fn: () => 3,
  },

  // 1: Volume-Scaled
  {
    name: "Volume-Scaled",
    fn: (_pair, _dir, barIdx, pd) => {
      const v = pd.vol[barIdx] ?? 0;
      const avg = pd.volSMA20[barIdx] ?? 0;
      if (avg <= 0) return 3;
      const ratio = v / avg;
      if (ratio > 3) return 7;
      if (ratio > 2) return 5;
      return 3;
    },
  },

  // 2: ATR-Inverse (volatility parity)
  {
    name: "ATR-Inverse (Vol Parity)",
    fn: (pair, _dir, barIdx, pd, _btc, _rt, allPairATRs) => {
      const pairATR = pd.atr14[barIdx];
      if (!pairATR || pairATR <= 0) return 3;
      const pairATRPct = pairATR / pd.cs[barIdx].c;
      const allATRs = [...allPairATRs.values()].filter(v => v > 0);
      if (allATRs.length === 0) return 3;
      const sorted = [...allATRs].sort((a, b) => a - b);
      const medianATR = sorted[Math.floor(sorted.length / 2)];
      const raw = 3 * (medianATR / pairATRPct);
      return Math.max(1, Math.min(10, Math.round(raw * 10) / 10));
    },
  },

  // 3: Trend Strength Scaled (ADX)
  {
    name: "Trend Strength (ADX)",
    fn: (_pair, _dir, barIdx, pd) => {
      const adx = pd.adx14[barIdx] ?? 0;
      if (adx > 40) return 7;
      if (adx > 30) return 5;
      return 3;
    },
  },

  // 4: Multi-Signal Confidence
  {
    name: "Multi-Signal Confidence",
    fn: (pair, dir, barIdx, pd, btcPd) => {
      let size = 3;

      // BTC trend agrees
      if (btcPd) {
        const btcBar = findClosestBarIdx(btcPd.cs, pd.cs[barIdx].t);
        if (btcBar >= 50) {
          const btcEma20 = calcEMA(btcPd.cs.map(c => c.c), 20);
          const btcEma50 = calcEMA(btcPd.cs.map(c => c.c), 50);
          const btcTrend = btcEma20[btcBar] > btcEma50[btcBar] ? "long" : "short";
          if (btcTrend === dir) size += 1;
        }
      }

      // Volume > 1.5x avg
      const v = pd.vol[barIdx] ?? 0;
      const avg = pd.volSMA20[barIdx] ?? 0;
      if (avg > 0 && v > 1.5 * avg) size += 1;

      // ADX > 25
      if ((pd.adx14[barIdx] ?? 0) > 25) size += 1;

      // RSI confirms
      const rsi = pd.rsi14[barIdx] ?? 50;
      if ((dir === "long" && rsi > 50) || (dir === "short" && rsi < 50)) size += 1;

      return Math.min(7, size);
    },
  },

  // 5: Recent Win-Rate Adaptive
  {
    name: "Recent WR Adaptive",
    fn: (_pair, _dir, _barIdx, _pd, _btc, recentTrades) => {
      if (recentTrades.length < 5) return 3;
      const last10 = recentTrades.slice(-10);
      const wr = last10.filter(t => t.pnl > 0).length / last10.length;
      if (wr > 0.5) return 5;
      if (wr < 0.3) return 2;
      return 3;
    },
  },

  // 6: Equity Curve Sizing
  {
    name: "Equity Curve Sizing",
    fn: (_pair, _dir, _barIdx, _pd, _btc, _rt, _apm, equityCurve, equitySMA) => {
      if (equityCurve.length < 20) return 3;
      const curEquity = equityCurve[equityCurve.length - 1];
      const curSMA = equitySMA[equitySMA.length - 1];
      if (curEquity > curSMA) return 5;
      return 2;
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────
function findClosestBarIdx(cs: C[], ts: number): number {
  for (let i = cs.length - 1; i >= 0; i--) {
    if (cs[i].t <= ts) return i;
  }
  return -1;
}

// Pre-compute BTC EMA arrays (avoid recalculating per trade for strategy 4)
let btcEma20Cache: number[] = [];
let btcEma50Cache: number[] = [];

// ─── Simulation ─────────────────────────────────────────────────────
function simulate(
  pairDataMap: Map<string, PairData>,
  btcPd: PairData | null,
  sizeFn: SizeFn,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const allTradesForWR: Tr[] = []; // for win-rate strategy
  const equityCurve: number[] = [0];
  const equitySMA: number[] = [0];

  // Compute per-pair ATR percentages at a mid-range point for vol parity
  const allPairATRs = new Map<string, number>();
  for (const [pair, pd] of pairDataMap) {
    const midIdx = Math.floor(pd.cs.length * 0.5);
    if (midIdx > 0 && pd.atr14[midIdx] > 0) {
      allPairATRs.set(pair, pd.atr14[midIdx] / pd.cs[midIdx].c);
    }
  }

  // Simulate per-pair (no cross-pair interaction needed for Supertrend flip-based)
  for (const pair of PAIRS) {
    const pd = pairDataMap.get(pair);
    if (!pd) continue;

    const { stDir, cs } = pd;
    let pos: { dir: "long"|"short"; ep: number; et: number; barIdx: number; size: number } | null = null;

    for (let i = ST_PERIOD + 1; i < cs.length; i++) {
      if (cs[i].t > endTs && !pos) continue;

      const prevDir = stDir[i - 1];
      const prevPrevDir = i >= 2 ? stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Volume filter on flip bar: require vol > 1.0x avg (basic noise filter)
      const volOK = (pd.volSMA20[i] ?? 0) > 0 && (pd.vol[i] ?? 0) >= pd.volSMA20[i];

      if (pos && flipped) {
        const xp = cs[i].o;
        const pnl = tradePnl(pair, pos.ep, xp, pos.dir, false, pos.size);
        if (pos.et >= startTs && pos.et < endTs) {
          const tr: Tr = { pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: cs[i].t, pnl, reason: "flip", size: pos.size };
          trades.push(tr);
          allTradesForWR.push(tr);
          // Update equity curve
          const newEq = equityCurve[equityCurve.length - 1] + pnl;
          equityCurve.push(newEq);
          // Update equity SMA (20-trade)
          if (equityCurve.length >= 20) {
            let s = 0;
            for (let k = equityCurve.length - 20; k < equityCurve.length; k++) s += equityCurve[k];
            equitySMA.push(s / 20);
          } else {
            equitySMA.push(equityCurve.reduce((a, b) => a + b, 0) / equityCurve.length);
          }
        }
        pos = null;
      }

      if (!pos && flipped && volOK && cs[i].t >= startTs && cs[i].t < endTs) {
        const newDir: "long"|"short" = prevDir === 1 ? "long" : "short";

        // Update allPairATRs with current values for vol parity
        if (pd.atr14[i] > 0) {
          allPairATRs.set(pair, pd.atr14[i] / cs[i].c);
        }

        const size = sizeFn(
          pair, newDir, i, pd, btcPd,
          allTradesForWR, allPairATRs,
          equityCurve, equitySMA,
        );

        pos = { dir: newDir, ep: cs[i].o, et: cs[i].t, barIdx: i, size };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false, pos.size);
      const tr: Tr = { pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end", size: pos.size };
      trades.push(tr);
      allTradesForWR.push(tr);
      const newEq = equityCurve[equityCurve.length - 1] + pnl;
      equityCurve.push(newEq);
      if (equityCurve.length >= 20) {
        let s = 0;
        for (let k = equityCurve.length - 20; k < equityCurve.length; k++) s += equityCurve[k];
        equitySMA.push(s / 20);
      } else {
        equitySMA.push(equityCurve.reduce((a, b) => a + b, 0) / equityCurve.length);
      }
    }
  }

  return trades;
}

// Override multi-signal confidence to use cached BTC EMA
const origMultiSignalFn = sizingStrategies[4].fn;
sizingStrategies[4].fn = (pair, dir, barIdx, pd, btcPd, rt, apm, ec, esma) => {
  let size = 3;

  // BTC trend agrees
  if (btcPd && btcEma20Cache.length > 0) {
    const btcBar = findClosestBarIdx(btcPd.cs, pd.cs[barIdx].t);
    if (btcBar >= 50 && btcBar < btcEma20Cache.length && btcBar < btcEma50Cache.length) {
      const btcTrend = btcEma20Cache[btcBar] > btcEma50Cache[btcBar] ? "long" : "short";
      if (btcTrend === dir) size += 1;
    }
  }

  // Volume > 1.5x avg
  const v = pd.vol[barIdx] ?? 0;
  const avg = pd.volSMA20[barIdx] ?? 0;
  if (avg > 0 && v > 1.5 * avg) size += 1;

  // ADX > 25
  if ((pd.adx14[barIdx] ?? 0) > 25) size += 1;

  // RSI confirms
  const rsi = pd.rsi14[barIdx] ?? 50;
  if ((dir === "long" && rsi > 50) || (dir === "short" && rsi < 50)) size += 1;

  return Math.min(7, size);
};

// ─── Main ───────────────────────────────────────────────────────────
console.log("Loading and preparing data...");
const pairDataMap = new Map<string, PairData>();
for (const pair of [...PAIRS, "BTC"]) {
  const pd = preparePair(pair);
  if (pd) {
    pairDataMap.set(pair, pd);
    if (pair !== "BTC") {
      console.log(`  ${pair}: ${pd.cs.length} 4h bars (${pd.raw5m.length} 5m bars)`);
    }
  } else {
    console.log(`  ${pair}: MISSING or insufficient data`);
  }
}

const btcPd = pairDataMap.get("BTC") ?? null;
if (btcPd) {
  btcEma20Cache = calcEMA(btcPd.cs.map(c => c.c), 20);
  btcEma50Cache = calcEMA(btcPd.cs.map(c => c.c), 50);
  console.log(`  BTC: ${btcPd.cs.length} 4h bars (reference)`);
}

const oosDays = (FULL_END - OOS_START) / DAY;

console.log(`\nFull period: 2023-01 to 2026-03`);
console.log(`OOS period:  2025-09-01 to 2026-03-26 (${oosDays.toFixed(0)} days)`);
console.log(`Engine:      Supertrend(${ST_PERIOD}, ${ST_MULT}) + volume filter`);
console.log(`Cost model:  Taker ${FEE_TAKER*100}%, spread map, 1.5x SL slip, ${LEV}x leverage`);

// ─── Run All Strategies ─────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("ADAPTIVE POSITION SIZING - OOS RESULTS (2025-09-01 to 2026-03-26)");
console.log("=".repeat(110));
console.log(
  "Strategy".padEnd(28) +
  "Trades".padStart(7) +
  "AvgSz".padStart(7) +
  "WR%".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(9) +
  "Total".padStart(10) +
  "MaxDD".padStart(9)
);
console.log("-".repeat(110));

interface StratResult {
  name: string;
  metrics: Metrics;
  trades: Tr[];
}

const results: StratResult[] = [];

for (const strat of sizingStrategies) {
  const oosTrades = simulate(pairDataMap, btcPd, strat.fn, OOS_START, FULL_END);
  const m = calcMetrics(oosTrades, OOS_START, FULL_END);

  results.push({ name: strat.name, metrics: m, trades: oosTrades });

  const totalStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
  const pdStr = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;

  console.log(
    strat.name.padEnd(28) +
    String(m.n).padStart(7) +
    `$${m.avgSize.toFixed(1)}`.padStart(7) +
    m.wr.toFixed(1).padStart(7) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    pdStr.padStart(9) +
    totalStr.padStart(10) +
    `$${m.dd.toFixed(1)}`.padStart(9)
  );
}

// ─── Delta vs Baseline ──────────────────────────────────────────────
const baseMetrics = results[0].metrics;
console.log("\n" + "=".repeat(90));
console.log("DELTA vs FLAT $3 BASELINE");
console.log("=".repeat(90));
console.log(
  "Strategy".padEnd(28) +
  "dTrades".padStart(8) +
  "dWR%".padStart(8) +
  "dPF".padStart(8) +
  "dSharpe".padStart(9) +
  "d$/day".padStart(10) +
  "dMaxDD".padStart(10)
);
console.log("-".repeat(90));

for (let i = 1; i < results.length; i++) {
  const m = results[i].metrics;
  const dTrades = m.n - baseMetrics.n;
  const dWR = m.wr - baseMetrics.wr;
  const dPF = m.pf - baseMetrics.pf;
  const dSharpe = m.sharpe - baseMetrics.sharpe;
  const dPD = m.perDay - baseMetrics.perDay;
  const dDD = m.dd - baseMetrics.dd;

  const sign = (v: number) => v >= 0 ? "+" : "";

  console.log(
    results[i].name.padEnd(28) +
    `${sign(dTrades)}${dTrades}`.padStart(8) +
    `${sign(dWR)}${dWR.toFixed(1)}%`.padStart(8) +
    `${sign(dPF)}${dPF.toFixed(2)}`.padStart(8) +
    `${sign(dSharpe)}${dSharpe.toFixed(2)}`.padStart(9) +
    `${sign(dPD)}$${Math.abs(dPD).toFixed(2)}`.padStart(10) +
    `${sign(dDD)}$${Math.abs(dDD).toFixed(1)}`.padStart(10)
  );
}

// ─── Full Period Results ────────────────────────────────────────────
console.log("\n" + "=".repeat(110));
console.log("FULL PERIOD RESULTS (2023-01 to 2026-03) - for context");
console.log("=".repeat(110));
console.log(
  "Strategy".padEnd(28) +
  "Trades".padStart(7) +
  "AvgSz".padStart(7) +
  "WR%".padStart(7) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(9) +
  "Total".padStart(10) +
  "MaxDD".padStart(9)
);
console.log("-".repeat(110));

for (const strat of sizingStrategies) {
  const fullTrades = simulate(pairDataMap, btcPd, strat.fn, FULL_START, FULL_END);
  const m = calcMetrics(fullTrades, FULL_START, FULL_END);

  const totalStr = m.total >= 0 ? `+$${m.total.toFixed(1)}` : `-$${Math.abs(m.total).toFixed(1)}`;
  const pdStr = m.perDay >= 0 ? `+$${m.perDay.toFixed(2)}` : `-$${Math.abs(m.perDay).toFixed(2)}`;

  console.log(
    strat.name.padEnd(28) +
    String(m.n).padStart(7) +
    `$${m.avgSize.toFixed(1)}`.padStart(7) +
    m.wr.toFixed(1).padStart(7) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    pdStr.padStart(9) +
    totalStr.padStart(10) +
    `$${m.dd.toFixed(1)}`.padStart(9)
  );
}

// ─── Per-Strategy Size Distribution (OOS) ───────────────────────────
console.log("\n" + "=".repeat(70));
console.log("SIZE DISTRIBUTION (OOS)");
console.log("=".repeat(70));

for (let i = 0; i < results.length; i++) {
  const { name, trades } = results[i];
  const sizes = new Map<string, number>();
  for (const t of trades) {
    const key = `$${t.size.toFixed(1)}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const entries = [...sizes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dist = entries.map(([k, v]) => `${k}:${v}`).join("  ");
  console.log(`${name.padEnd(28)} ${dist}`);
}

// ─── Per-Pair OOS Breakdown for Best Strategy ───────────────────────
// Find best strategy by $/day
const bestIdx = results.reduce((best, r, idx) =>
  r.metrics.perDay > results[best].metrics.perDay ? idx : best, 0);
const bestResult = results[bestIdx];

console.log(`\n${"=".repeat(80)}`);
console.log(`PER-PAIR BREAKDOWN: ${bestResult.name} (OOS)`);
console.log("=".repeat(80));
console.log(
  "Pair".padEnd(8) +
  "Trades".padStart(7) +
  "AvgSz".padStart(7) +
  "WR%".padStart(7) +
  "PnL".padStart(10) +
  "$/day".padStart(9)
);
console.log("-".repeat(80));

for (const pair of PAIRS) {
  const pt = bestResult.trades.filter(t => t.pair === pair);
  if (pt.length === 0) continue;
  const pnl = pt.reduce((s, t) => s + t.pnl, 0);
  const wins = pt.filter(t => t.pnl > 0).length;
  const avgSz = pt.reduce((s, t) => s + t.size, 0) / pt.length;
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(1)}` : `-$${Math.abs(pnl).toFixed(1)}`;
  const pdStr = pnl / oosDays;
  const pdFmt = pdStr >= 0 ? `+$${pdStr.toFixed(3)}` : `-$${Math.abs(pdStr).toFixed(3)}`;

  console.log(
    pair.padEnd(8) +
    String(pt.length).padStart(7) +
    `$${avgSz.toFixed(1)}`.padStart(7) +
    (wins / pt.length * 100).toFixed(1).padStart(7) +
    pnlStr.padStart(10) +
    pdFmt.padStart(9)
  );
}

console.log("\nDone.");
