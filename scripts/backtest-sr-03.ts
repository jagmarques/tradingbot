/**
 * SR-03: 5m VWAP Standard Deviation Mean-Reversion
 *
 * - Rolling VWAP with volume-weighted standard deviation bands
 * - Long: price <= vwap - sdMultiplier * sd
 * - Short: price >= vwap + sdMultiplier * sd
 * - TP at VWAP, SL 1.5%
 * - Walk-forward: 7-day windows, 2-day steps
 * - Runs per-pair, aggregates OOS trades
 *
 * npx tsx scripts/backtest-sr-03.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  runWalkForward,
  computeMetrics,
  formatMetricsDashboard,
  DEFAULT_COST_CONFIG,
} from "../src/services/backtest/index.js";
import type { Candle, Signal, SignalGenerator, Trade } from "../src/services/backtest/types.js";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const FUNDING_DIR = "/tmp/bt-funding-cache";
const CAPITAL = 50;
const LEVERAGE = 5;
const SL_PCT = 0.015;

// Run on 5 representative pairs to keep runtime manageable (5m has 300k+ candles/pair)
const PAIRS_5M = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT", "ADAUSDT",
];

// Load 5m candles - handles both array [t,o,h,l,c,v] and object format
function load5mCandles(pair: string): Candle[] {
  const filePath = path.join(CACHE_5M, `${pair}.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown[];
  return (raw as (number[] | Candle)[])
    .map((b): Candle => {
      if (Array.isArray(b)) return { t: b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] };
      return b as Candle;
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Compute rolling VWAP and volume-weighted standard deviation.
 * Takes last vwapWindow candles from the provided slice.
 * Returns { vwap, sd } or null if not enough data.
 */
function computeVwapSd(candles: Candle[], barIndex: number, vwapWindow: number): { vwap: number; sd: number } | null {
  if (barIndex < vwapWindow) return null;
  const start = barIndex - vwapWindow;

  let totalVol = 0;
  let sumTypVol = 0;
  const typicals: number[] = [];
  const vols: number[] = [];

  for (let i = start; i < barIndex; i++) {
    const c = candles[i];
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v != null && c.v > 0 ? c.v : 1;
    typicals.push(tp);
    vols.push(v);
    totalVol += v;
    sumTypVol += tp * v;
  }

  if (totalVol === 0) return null;
  const vwap = sumTypVol / totalVol;

  let sumVarVol = 0;
  for (let i = 0; i < typicals.length; i++) {
    sumVarVol += vols[i] * (typicals[i] - vwap) ** 2;
  }
  const sd = Math.sqrt(sumVarVol / totalVol);

  return { vwap, sd };
}

/**
 * SR-03 signal generator factory for a single pair.
 */
function makeSR03Generator(params: {
  vwapWindow: number;
  sdMultiplier: number;
  maxHoldBars: number;
}): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    // Anti-look-ahead: only use candles[0..barIndex-1]
    const result = computeVwapSd(candles, barIndex, params.vwapWindow);
    if (!result) return null;
    const { vwap, sd } = result;

    if (sd === 0) return null;

    const upperBand = vwap + params.sdMultiplier * sd;
    const lowerBand = vwap - params.sdMultiplier * sd;
    const currentPrice = candles[barIndex - 1].c;

    let direction: "long" | "short";
    if (currentPrice <= lowerBand) {
      direction = "long";
    } else if (currentPrice >= upperBand) {
      direction = "short";
    } else {
      return null;
    }

    const entryPrice = candles[barIndex].o;
    const stopLoss =
      direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
    // TP at VWAP (mean reversion target)
    const takeProfit = vwap;

    // If TP is already past entry, skip
    if (direction === "long" && takeProfit <= entryPrice) return null;
    if (direction === "short" && takeProfit >= entryPrice) return null;

    return { pair, direction, entryPrice, stopLoss, takeProfit, barIndex };
  };
}

async function main() {
  console.log("[SR-03] Loading 5m candles...");

  const candleMap: Record<string, Candle[]> = {};
  const loadedPairs: string[] = [];

  for (const pair of PAIRS_5M) {
    const candles = load5mCandles(pair);
    if (candles.length > 500) {
      candleMap[pair] = candles;
      loadedPairs.push(pair);
    } else {
      console.log(`[SR-03] Skipping ${pair}: only ${candles.length} 5m candles`);
    }
  }

  console.log(`[SR-03] Loaded ${loadedPairs.length} pairs with 5m data`);

  // Parameter grid: vwapWindow x sdMultiplier x maxHoldBars
  const paramGrid: Array<Record<string, number>> = [];
  for (const vwapWindow of [48, 78, 96]) {
    for (const sdMultiplier of [1.5, 2.0, 2.5]) {
      for (const maxHoldBars of [12, 24, 48]) {
        paramGrid.push({ vwapWindow, sdMultiplier, maxHoldBars });
      }
    }
  }

  console.log(`[SR-03] Parameter grid: ${paramGrid.length} combinations`);
  console.log("[SR-03] Running walk-forward per pair (7-day windows, 2-day steps)...\n");

  const allOOSTrades: Trade[] = [];
  const wfOptions = {
    windowMs: 7 * 24 * 3_600_000, // 7-day windows
    stepMs: 2 * 24 * 3_600_000, // 2-day steps
    trainFrac: 0.6,
    warmupBars: 100,
  };

  for (const pair of loadedPairs) {
    console.log(`[SR-03] Processing ${pair}...`);
    const pairCandles = candleMap[pair];

    const config = {
      pairs: [pair],
      capitalUsd: CAPITAL,
      leverage: LEVERAGE,
      costConfig: DEFAULT_COST_CONFIG,
      candleDir: CACHE_5M,
      fundingDir: FUNDING_DIR,
    };

    const signalGeneratorFactory = (params: Record<string, number>): SignalGenerator =>
      makeSR03Generator({
        vwapWindow: params.vwapWindow,
        sdMultiplier: params.sdMultiplier,
        maxHoldBars: params.maxHoldBars,
      });

    const result = await runWalkForward(pairCandles, paramGrid, signalGeneratorFactory, config, wfOptions);
    const pairOOSTrades = result.windows.flatMap((w) => w.validateTrades);
    allOOSTrades.push(...pairOOSTrades);
    console.log(`  ${pair}: ${result.windows.length} windows, ${pairOOSTrades.length} OOS trades`);
  }

  // Aggregate metrics across all pairs
  const aggregateMetrics = computeMetrics(allOOSTrades, CAPITAL);

  // Print results
  console.log("\n" + formatMetricsDashboard(aggregateMetrics, "SR-03 5m VWAP MR"));
  console.log(`OOS Trades:    ${aggregateMetrics.totalTrades}`);

  if (aggregateMetrics.totalTrades < 100) {
    console.log("\n[WARN] OOS trade count < 100. Consider relaxing sdMultiplier thresholds.");
  }
}

main().catch((e) => {
  console.error("[SR-03] Fatal error:", e);
  process.exit(1);
});
