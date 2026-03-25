// SR-07: Order Flow Imbalance via Candle Delta Proxy
// LOW confidence strategy: candle delta is a rough proxy for true order flow
// Signal: bearish divergence (price up but cumulative delta negative) => SHORT
//         bullish divergence (price down but cumulative delta positive) => LONG
//
// Pattern: per-pair walk-forward (correct multi-pair approach from 35-04).

import * as fs from "node:fs";
import * as path from "node:path";
import { runWalkForward, formatMetricsDashboard } from "../src/services/backtest/index.js";
import { computeMetrics } from "../src/services/backtest/metrics.js";
import { DEFAULT_COST_CONFIG } from "../src/services/backtest/costs.js";
import type { Candle, Signal, SignalGenerator, Trade } from "../src/services/backtest/types.js";

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

// Candle delta proxy: (close - open) / (high - low), range -1 to +1
// Positive = buyers dominated; negative = sellers dominated
// Returns 0 if range is 0 (flat candle)
function candleDelta(bar: Candle): number {
  const range = bar.h - bar.l;
  if (range === 0) return 0;
  return (bar.c - bar.o) / range;
}

interface SR07Params {
  divergenceWindow: number;
  divergenceThreshold: number;
  maxHoldBars: number;
}

function makeSR07Generator(params: SR07Params): SignalGenerator {
  return (candles: Candle[], barIndex: number, _pair: string): Signal | null => {
    // Anti-look-ahead: only use candles[0..barIndex-1]
    if (barIndex < params.divergenceWindow + 1) return null;

    // Take the last divergenceWindow bars
    const windowStart = barIndex - params.divergenceWindow;
    const windowEnd = barIndex;

    // Cumulative delta over the window
    let cumDelta = 0;
    for (let i = windowStart; i < windowEnd; i++) {
      cumDelta += candleDelta(candles[i]);
    }

    // Price change over the window
    const priceChange = candles[windowEnd - 1].c - candles[windowStart].c;

    const entryPrice = candles[barIndex].o;

    // Bearish divergence: price made net gain but sellers dominated
    if (priceChange > 0 && cumDelta < -params.divergenceThreshold) {
      return {
        pair: _pair,
        direction: "short",
        entryPrice,
        stopLoss: entryPrice * 1.02, // SL 2% above for short
        takeProfit: entryPrice * 0.97, // TP 3% below for short
        barIndex,
      };
    }

    // Bullish divergence: price made net loss but buyers dominated
    if (priceChange < 0 && cumDelta > params.divergenceThreshold) {
      return {
        pair: _pair,
        direction: "long",
        entryPrice,
        stopLoss: entryPrice * 0.98, // SL 2% below for long
        takeProfit: entryPrice * 1.03, // TP 3% above for long
        barIndex,
      };
    }

    return null;
  };
}

// Plan parameters: divergenceWindow (12,24,48), divergenceThreshold (0.5,1.0,1.5), maxHoldBars (4,8,12)
function buildParamGrid(thresholds: number[]): Array<Record<string, number>> {
  const grid: Array<Record<string, number>> = [];
  for (const divergenceWindow of [12, 24, 48]) {
    for (const divergenceThreshold of thresholds) {
      for (const maxHoldBars of [4, 8, 12]) {
        grid.push({ divergenceWindow, divergenceThreshold, maxHoldBars });
      }
    }
  }
  return grid;
}

async function runAllPairs(
  pairs: string[],
  candleMap: Record<string, Candle[]>,
  paramGrid: Array<Record<string, number>>,
): Promise<{ trades: Trade[]; windows: number; isSum: number }> {
  const allOOSTrades: Trade[] = [];
  let totalWindows = 0;
  let totalIsSum = 0;

  for (const pair of pairs) {
    const candles = candleMap[pair];
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
        makeSR07Generator({
          divergenceWindow: params.divergenceWindow,
          divergenceThreshold: params.divergenceThreshold,
          maxHoldBars: params.maxHoldBars,
        }),
      config,
    );

    const pairTrades = result.windows.flatMap((w) => w.validateTrades);
    allOOSTrades.push(...pairTrades);
    totalWindows = Math.max(totalWindows, result.windows.length);
    totalIsSum += result.windows.reduce((s, w) => s + w.trainSharpe, 0);

    console.log(`  ${pair}: ${pairTrades.length} OOS trades, ${result.windows.length} windows`);
  }

  return { trades: allOOSTrades, windows: totalWindows, isSum: totalIsSum };
}

async function main() {
  console.log("[SR-07] Order Flow Imbalance (Candle Delta Proxy) - loading data...");
  console.log("[SR-07] NOTE: LOW confidence strategy - candle delta is a rough proxy for true order flow");

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
    console.error(`[SR-07] Need 3+ pairs but found ${validPairs.length}`);
    process.exit(1);
  }

  console.log(`[SR-07] Loaded ${validPairs.length} pairs: ${validPairs.join(", ")}`);

  // Primary param grid: plan thresholds (0.5, 1.0, 1.5)
  let paramGrid = buildParamGrid([0.5, 1.0, 1.5]);
  console.log(`[SR-07] Running walk-forward per pair with ${paramGrid.length} primary param combinations...`);

  const primaryRun = await runAllPairs(validPairs, candleMap, paramGrid);
  const primaryMetrics = computeMetrics(primaryRun.trades, CAPITAL);
  const primaryOOSCount = primaryMetrics.totalTrades;

  console.log(`\n[SR-07] OOS trades (primary): ${primaryOOSCount}, windows: ${primaryRun.windows}`);

  if (primaryOOSCount < 100) {
    console.log("[SR-07] WARNING: < 100 OOS trades. Relaxing divergenceThreshold to (0.3, 0.5, 1.0) as per plan fallback.");

    paramGrid = buildParamGrid([0.3, 0.5, 1.0]);
    console.log(`[SR-07] Running walk-forward with ${paramGrid.length} relaxed param combinations...`);

    const relaxedRun = await runAllPairs(validPairs, candleMap, paramGrid);
    const relaxedMetrics = computeMetrics(relaxedRun.trades, CAPITAL);
    const relaxedCount = relaxedMetrics.totalTrades;
    const avgIsSharpe = relaxedRun.windows > 0 ? relaxedRun.isSum / (relaxedRun.windows * validPairs.length) : 0;
    const oosIsRatio = avgIsSharpe !== 0 ? relaxedMetrics.sharpe / avgIsSharpe : 0;

    console.log(`\n[SR-07] OOS trades (relaxed): ${relaxedCount}, windows: ${relaxedRun.windows}`);

    if (relaxedCount < 100) {
      console.log(`[SR-07] WARNING: Still ${relaxedCount} OOS trades with relaxed thresholds. Delta divergence signals are rare.`);
    }

    if (relaxedMetrics.sharpe < 0.5) {
      console.log("[SR-07] NOTE: OOS Sharpe < 0.5 - LOW confidence strategy as expected. Candle delta proxy has weak predictive power.");
    }

    console.log(formatMetricsDashboard(relaxedMetrics, "SR-07 Order Flow Imbalance (relaxed)"));
    console.log(`OOS/IS ratio: ${oosIsRatio.toFixed(2)}`);
    console.log(`Windows: ${relaxedRun.windows}`);
  } else {
    const avgIsSharpe = primaryRun.windows > 0 ? primaryRun.isSum / (primaryRun.windows * validPairs.length) : 0;
    const oosIsRatio = avgIsSharpe !== 0 ? primaryMetrics.sharpe / avgIsSharpe : 0;

    if (primaryMetrics.sharpe < 0.5) {
      console.log("[SR-07] NOTE: OOS Sharpe < 0.5 - LOW confidence strategy as expected. Candle delta proxy has weak predictive power.");
    }

    console.log(formatMetricsDashboard(primaryMetrics, "SR-07 Order Flow Imbalance"));
    console.log(`OOS/IS ratio: ${oosIsRatio.toFixed(2)}`);
    console.log(`Windows: ${primaryRun.windows}`);
  }
}

main().catch((err) => {
  console.error("[SR-07] Fatal error:", err);
  process.exit(1);
});
