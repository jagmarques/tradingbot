/**
 * SR-02: 5m Bollinger Band / RSI mean-reversion with 1h ADX regime gate
 *
 * - Long: price <= bb.lower AND rsi < rsiOversold AND ADX < 20
 * - Short: price >= bb.upper AND rsi > rsiOverbought AND ADX < 20
 * - SL 1.5%, TP 1%
 * - Walk-forward: 7-day windows, 2-day steps
 * - Runs per-pair, aggregates OOS trades
 *
 * npx tsx scripts/backtest-sr-02.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ADX } from "technicalindicators";
import {
  runWalkForward,
  computeMetrics,
  formatMetricsDashboard,
  DEFAULT_COST_CONFIG,
} from "../src/services/backtest/index.js";
import type { Candle, Signal, SignalGenerator, Trade } from "../src/services/backtest/types.js";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const CACHE_1H = "/tmp/bt-pair-cache";
const FUNDING_DIR = "/tmp/bt-funding-cache";
const CAPITAL = 50;
const LEVERAGE = 5;
const SL_PCT = 0.015;
const TP_PCT = 0.01;

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

// Load 1h candles - handles both array and object format
function load1hCandles(pair: string): Candle[] {
  const filePath = path.join(CACHE_1H, `${pair}.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown[];
  return (raw as (number[] | Candle)[])
    .map((b): Candle => {
      if (Array.isArray(b)) return { t: b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      return b as Candle;
    })
    .sort((a, b) => a.t - b.t);
}

// Precompute 1h ADX as Map<hourTs, adxValue> for a pair
function buildAdxMap(pair: string): Map<number, number> | null {
  const candles = load1hCandles(pair);
  if (candles.length < 20) return null;

  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const close = candles.map((c) => c.c);

  const adxResults = ADX.calculate({ period: 14, high, low, close });
  const offset = candles.length - adxResults.length;

  const adxMap = new Map<number, number>();
  for (let i = 0; i < adxResults.length; i++) {
    adxMap.set(candles[offset + i].t, adxResults[i].adx);
  }
  return adxMap;
}

// Compute last Bollinger Band value from last bbPeriod closes only
function lastBB(
  closes: number[],
  period: number,
  stdDev: number,
): { lower: number; upper: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { lower: mean - stdDev * sd, upper: mean + stdDev * sd };
}

// Compute last RSI value using Wilder smoothing over a limited lookback
function lastRSI(closes: number[], period: number): number | null {
  const n = closes.length;
  if (n < period + 1) return null;

  // Use enough bars for Wilder smoothing to converge
  const startIdx = Math.max(0, n - period * 3);
  const sub = closes.slice(startIdx);

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period && i < sub.length; i++) {
    const diff = sub[i] - sub[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < sub.length; i++) {
    const diff = sub[i] - sub[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * SR-02 signal generator factory for a single pair.
 * adxMap: precomputed 1h ADX values keyed by hour timestamp (null = no regime gate)
 */
function makeSR02Generator(
  params: {
    bbPeriod: number;
    bbStdDev: number;
    rsiPeriod: number;
    rsiOversold: number;
    rsiOverbought: number;
    maxHoldBars: number;
  },
  adxMap: Map<number, number> | null,
): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    const minRequired = Math.max(params.bbPeriod, params.rsiPeriod * 3 + 2);
    if (barIndex < minRequired) return null;

    // Only use recent closes - avoid full array allocation
    const neededBars = Math.max(params.bbPeriod, params.rsiPeriod * 3 + 2);
    const start = Math.max(0, barIndex - neededBars);
    const closes: number[] = [];
    for (let i = start; i < barIndex; i++) {
      closes.push(candles[i].c);
    }

    // Bollinger Bands - only last value
    const bb = lastBB(closes, params.bbPeriod, params.bbStdDev);
    if (!bb) return null;

    // RSI - only last value
    const rsi = lastRSI(closes, params.rsiPeriod);
    if (rsi === null) return null;

    // ADX regime gate
    if (adxMap !== null) {
      const lastCandle = candles[barIndex - 1];
      const hourTs = Math.floor(lastCandle.t / 3_600_000) * 3_600_000;
      const adxVal = adxMap.get(hourTs);
      if (adxVal !== undefined && adxVal >= 20) return null;
    }

    const currentPrice = closes[closes.length - 1];
    let direction: "long" | "short";

    if (currentPrice <= bb.lower && rsi < params.rsiOversold) {
      direction = "long";
    } else if (currentPrice >= bb.upper && rsi > params.rsiOverbought) {
      direction = "short";
    } else {
      return null;
    }

    const entryPrice = candles[barIndex].o;
    const stopLoss =
      direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
    const takeProfit =
      direction === "long" ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);

    return { pair, direction, entryPrice, stopLoss, takeProfit, barIndex };
  };
}

async function main() {
  console.log("[SR-02] Loading 5m candles...");

  const candleMap: Record<string, Candle[]> = {};
  const loadedPairs: string[] = [];

  for (const pair of PAIRS_5M) {
    const candles = load5mCandles(pair);
    if (candles.length > 500) {
      candleMap[pair] = candles;
      loadedPairs.push(pair);
    } else {
      console.log(`[SR-02] Skipping ${pair}: only ${candles.length} 5m candles`);
    }
  }

  console.log(`[SR-02] Loaded ${loadedPairs.length} pairs with 5m data`);

  // Build ADX maps for pairs that have 1h data
  console.log("[SR-02] Building 1h ADX maps...");
  const adxMaps = new Map<string, Map<number, number> | null>();
  let adxPairCount = 0;
  for (const pair of loadedPairs) {
    const adxMap = buildAdxMap(pair);
    adxMaps.set(pair, adxMap);
    if (adxMap !== null) {
      adxPairCount++;
      console.log(`  ${pair}: ${adxMap.size} ADX values loaded`);
    }
  }
  console.log(`[SR-02] ADX regime gate active for ${adxPairCount}/${loadedPairs.length} pairs`);

  // Parameter grid: fixed bbPeriod=20, rsiPeriod=14, sweep the rest
  const paramGrid: Array<Record<string, number>> = [];
  for (const bbStdDev of [1.5, 2.0, 2.5]) {
    for (const rsiOversold of [25, 30]) {
      for (const rsiOverbought of [70, 75]) {
        for (const maxHoldBars of [6, 12, 24]) {
          paramGrid.push({
            bbPeriod: 20,
            bbStdDev,
            rsiPeriod: 14,
            rsiOversold,
            rsiOverbought,
            maxHoldBars,
          });
        }
      }
    }
  }

  console.log(`[SR-02] Parameter grid: ${paramGrid.length} combinations`);
  console.log("[SR-02] Running walk-forward per pair (7-day windows, 2-day steps)...\n");

  // Run per-pair walk-forward and aggregate OOS trades
  const allOOSTrades: Trade[] = [];
  const wfOptions = {
    windowMs: 7 * 24 * 3_600_000, // 7-day windows
    stepMs: 2 * 24 * 3_600_000, // 2-day steps
    trainFrac: 0.6,
    warmupBars: 50,
  };

  for (const pair of loadedPairs) {
    console.log(`[SR-02] Processing ${pair}...`);
    const pairCandles = candleMap[pair];
    const adxMap = adxMaps.get(pair) ?? null;

    const config = {
      pairs: [pair],
      capitalUsd: CAPITAL,
      leverage: LEVERAGE,
      costConfig: DEFAULT_COST_CONFIG,
      candleDir: CACHE_5M,
      fundingDir: FUNDING_DIR,
    };

    const signalGeneratorFactory = (params: Record<string, number>) =>
      makeSR02Generator(
        {
          bbPeriod: params.bbPeriod,
          bbStdDev: params.bbStdDev,
          rsiPeriod: params.rsiPeriod,
          rsiOversold: params.rsiOversold,
          rsiOverbought: params.rsiOverbought,
          maxHoldBars: params.maxHoldBars,
        },
        adxMap,
      );

    const result = await runWalkForward(pairCandles, paramGrid, signalGeneratorFactory, config, wfOptions);
    const pairOOSTrades = result.windows.flatMap((w) => w.validateTrades);
    allOOSTrades.push(...pairOOSTrades);
    console.log(`  ${pair}: ${result.windows.length} windows, ${pairOOSTrades.length} OOS trades`);
  }

  // Aggregate metrics across all pairs
  const aggregateMetrics = computeMetrics(allOOSTrades, CAPITAL);

  // Print results
  console.log("\n" + formatMetricsDashboard(aggregateMetrics, "SR-02 5m BB/RSI MR"));
  console.log(`Windows (per pair): ~${Math.round(allOOSTrades.length > 0 ? allOOSTrades.length / loadedPairs.length : 0)} OOS trades/pair`);
  console.log(`OOS Trades:    ${aggregateMetrics.totalTrades}`);

  if (aggregateMetrics.totalTrades < 100) {
    console.log("\n[WARN] OOS trade count < 100. Consider relaxing BB/RSI thresholds.");
  }
}

main().catch((e) => {
  console.error("[SR-02] Fatal error:", e);
  process.exit(1);
});
