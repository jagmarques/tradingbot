// SR-06: Liquidity Sweep Reversal
// Detect wick-through-swing patterns (stop hunts at key levels) and fade the move
// Signal: bar wicks above swing high but closes below => SHORT; wick below swing low, closes above => LONG
// ATR-based stop placement. Must have 100+ OOS trades.
//
// Pattern: per-pair walk-forward (not merged candles), aggregated OOS trades.
// This avoids mixed-pair indicator computation errors (confirmed pattern from 35-04).

import * as fs from "node:fs";
import * as path from "node:path";
import { ADX } from "technicalindicators";
import { runWalkForward, formatMetricsDashboard } from "../src/services/backtest/index.js";
import { computeMetrics } from "../src/services/backtest/metrics.js";
import { DEFAULT_COST_CONFIG } from "../src/services/backtest/costs.js";
import type { Candle, Signal, SignalGenerator, Trade } from "../src/services/backtest/types.js";

const ADX_TREND_THRESHOLD = 25;

const CANDLE_DIR = "/tmp/bt-pair-cache";
const FUNDING_DIR = "/tmp/bt-funding-cache";
const CAPITAL = 50;
const LEVERAGE = 5;

// Pairs with 1h candle data (object format, Aug 2025 - Mar 2026)
const PAIRS = ["ETH", "SOL", "TIA", "AAVE", "INJ", "NEAR", "FIL", "FET", "ONDO", "PENDLE", "STX", "RUNE", "JUP", "TAO"];

// Load candles handling both {t,o,h,l,c} object format and [t,o,h,l,c] array format
function loadCandlesFlex(pair: string, candleDir: string): Candle[] {
  const filePath = path.join(candleDir, `${pair}USDT.json`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as unknown[];
  const candles: Candle[] = data.map((item) => {
    if (Array.isArray(item)) {
      return { t: item[0] as number, o: item[1] as number, h: item[2] as number, l: item[3] as number, c: item[4] as number };
    }
    return item as Candle;
  });
  return candles.filter((c) => c.t > 0).sort((a, b) => a.t - b.t);
}

// Compute ATR(14) for bar at barIndex using bars [barIndex-14..barIndex-1]
function computeATR(candles: Candle[], barIndex: number, period: number = 14): number {
  if (barIndex < period + 1) return 0;
  let sum = 0;
  for (let k = barIndex - period; k < barIndex; k++) {
    const prev = candles[k - 1];
    const curr = candles[k];
    const tr = Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c),
    );
    sum += tr;
  }
  return sum / period;
}

interface SR06Params {
  swingLookback: number;
  wickRatio: number;
  stopAtr: number;
  tpRatio: number;
  maxHoldBars: number;
}

// Precompute ADX(14) for the full candle array.
// Returns a Map<timestamp, adxValue> keyed by the timestamp of candles[i].
// adxMap.get(t) = ADX value at candle with timestamp t, using all candles up to and including t.
// Lookup in generator uses candles[barIndex-1].t to be index-independent (engine slices arrays).
function precomputeADX(candles: Candle[], period: number = 14): Map<number, number> {
  const adxMap = new Map<number, number>();
  const raw = ADX.calculate({
    high: candles.map((c) => c.h),
    low: candles.map((c) => c.l),
    close: candles.map((c) => c.c),
    period,
  });
  // ADX.calculate: first output corresponds to candle at index (2*period - 1)
  const offset = candles.length - raw.length;
  for (let i = 0; i < raw.length; i++) {
    adxMap.set(candles[offset + i].t, raw[i].adx);
  }
  return adxMap;
}

function makeSR06Generator(params: SR06Params, adxMap: Map<number, number>): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    // Anti-look-ahead: only use candles[0..barIndex-1]
    if (barIndex < params.swingLookback + 16) return null;

    // ADX regime gate: skip trending markets (ADX > 25 = trending, strategy needs ranging)
    // Look up ADX at candles[barIndex-1].t - no look-ahead (uses confirmed closed bar)
    const adxAtBar = adxMap.get(candles[barIndex - 1].t);
    if (adxAtBar !== undefined && adxAtBar > ADX_TREND_THRESHOLD) return null;

    const bar = candles[barIndex - 1]; // last confirmed bar

    // Swing high/low from prior bars (excluding last bar itself)
    const windowStart = barIndex - params.swingLookback - 1;
    const windowEnd = barIndex - 1;
    let swingHigh = -Infinity;
    let swingLow = Infinity;
    for (let i = windowStart; i < windowEnd; i++) {
      if (candles[i].h > swingHigh) swingHigh = candles[i].h;
      if (candles[i].l < swingLow) swingLow = candles[i].l;
    }

    const bodySize = Math.abs(bar.c - bar.o);
    const wickUp = bar.h - Math.max(bar.c, bar.o);
    const wickDown = Math.min(bar.c, bar.o) - bar.l;

    const atr = computeATR(candles, barIndex - 1);
    if (atr <= 0) return null;

    // Use ATR*0.01 as minimum body to avoid pure doji false signals
    const effectiveBody = Math.max(bodySize, atr * 0.01);

    const entryPrice = candles[barIndex].o;

    // Bearish sweep: wick punches above swing high, body closes back below it
    if (bar.h > swingHigh && bar.c < swingHigh && wickUp > effectiveBody * params.wickRatio) {
      const sl = entryPrice + atr * params.stopAtr;
      const tp = entryPrice - atr * params.stopAtr * params.tpRatio;
      if (tp <= 0 || sl <= entryPrice) return null;
      return { pair, direction: "short", entryPrice, stopLoss: sl, takeProfit: tp, barIndex };
    }

    // Bullish sweep: wick punches below swing low, body closes back above it
    if (bar.l < swingLow && bar.c > swingLow && wickDown > effectiveBody * params.wickRatio) {
      const sl = entryPrice - atr * params.stopAtr;
      const tp = entryPrice + atr * params.stopAtr * params.tpRatio;
      if (sl <= 0 || sl >= entryPrice) return null;
      return { pair, direction: "long", entryPrice, stopLoss: sl, takeProfit: tp, barIndex };
    }

    return null;
  };
}

// Plan parameters: swingLookback (10,20,30), wickRatio (1.5,2.0), stopAtr (1.5,2.0), tpRatio (1.5,2.0), maxHoldBars (4,8,12,24)
function buildParamGrid(): Array<Record<string, number>> {
  const grid: Array<Record<string, number>> = [];
  for (const swingLookback of [10, 20, 30]) {
    for (const wickRatio of [1.5, 2.0]) {
      for (const stopAtr of [1.5, 2.0]) {
        for (const tpRatio of [1.5, 2.0]) {
          for (const maxHoldBars of [4, 8, 12, 24]) {
            grid.push({ swingLookback, wickRatio, stopAtr, tpRatio, maxHoldBars });
          }
        }
      }
    }
  }
  return grid;
}

async function main() {
  console.log("[SR-06] Liquidity Sweep Reversal - loading data...");

  const candleMap: Record<string, Candle[]> = {};
  for (const pair of PAIRS) {
    try {
      const candles = loadCandlesFlex(pair, CANDLE_DIR);
      if (candles.length > 0) {
        candleMap[pair] = candles;
      }
    } catch {
      // pair not in cache
    }
  }

  const validPairs = Object.keys(candleMap);
  if (validPairs.length < 3) {
    console.error(`[SR-06] Need 3+ pairs but found ${validPairs.length}`);
    process.exit(1);
  }

  console.log(`[SR-06] Loaded ${validPairs.length} pairs: ${validPairs.join(", ")}`);

  const paramGrid = buildParamGrid();
  console.log(`[SR-06] Running walk-forward per pair with ${paramGrid.length} param combinations...`);

  // Per-pair walk-forward (correct pattern for multi-pair: avoids mixed-pair indicator errors)
  const allOOSTrades: Trade[] = [];
  let totalWindows = 0;
  let totalIsSum = 0;

  for (const pair of validPairs) {
    const candles = candleMap[pair];
    // Precompute ADX once per pair - reused across all param combinations and walk-forward windows
    const adxMap = precomputeADX(candles);
    const config = {
      pairs: [pair],
      capitalUsd: CAPITAL,
      leverage: LEVERAGE,
      costConfig: DEFAULT_COST_CONFIG,
      candleDir: CANDLE_DIR,
      fundingDir: FUNDING_DIR,
    };

    const result = await runWalkForward(
      candles,
      paramGrid,
      (params) =>
        makeSR06Generator(
          {
            swingLookback: params.swingLookback,
            wickRatio: params.wickRatio,
            stopAtr: params.stopAtr,
            tpRatio: params.tpRatio,
            maxHoldBars: params.maxHoldBars,
          },
          adxMap,
        ),
      config,
    );

    const pairOOSTrades = result.windows.flatMap((w) => w.validateTrades);
    allOOSTrades.push(...pairOOSTrades);
    totalWindows = Math.max(totalWindows, result.windows.length);
    totalIsSum += result.windows.reduce((s, w) => s + w.trainSharpe, 0);

    console.log(`  ${pair}: ${pairOOSTrades.length} OOS trades, ${result.windows.length} windows`);
  }

  const aggregateOOSMetrics = computeMetrics(allOOSTrades, CAPITAL);
  const avgIsSharpe = totalWindows > 0 ? totalIsSum / (totalWindows * validPairs.length) : 0;
  const oosIsRatio = avgIsSharpe !== 0 ? aggregateOOSMetrics.sharpe / avgIsSharpe : 0;

  const oosTradeCount = aggregateOOSMetrics.totalTrades;
  console.log(`\n[SR-06] Total OOS trades: ${oosTradeCount}, windows: ${totalWindows}`);

  if (oosTradeCount < 100) {
    console.log(`[SR-06] WARNING: Only ${oosTradeCount} OOS trades (need 100+). Liquidity sweep patterns are infrequent in 7-month period.`);
  }

  console.log(formatMetricsDashboard(aggregateOOSMetrics, "SR-06 Liquidity Sweep Reversal"));
  console.log(`OOS/IS ratio: ${oosIsRatio.toFixed(2)}`);
  console.log(`Windows: ${totalWindows}`);
}

main().catch((err) => {
  console.error("[SR-06] Fatal error:", err);
  process.exit(1);
});
