import type {
  Candle,
  BacktestConfig,
  Trade,
  WalkForwardWindow,
  WalkForwardWindowResult,
  WalkForwardResult,
  SignalGenerator,
} from "./types.js";
import { runBacktest } from "./engine.js";
import { computeMetrics } from "./metrics.js";

// Re-export shared types for convenience
export type { WalkForwardWindowResult, WalkForwardResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkForwardSplitConfig {
  trainFrac: number;
  validateFrac: number;
  testFrac: number;
}

export interface WalkForwardOptions {
  /** Size of each rolling window in ms. Default: 30 days. */
  windowMs?: number;
  /** Step between windows in ms. Default: 10% of windowMs. */
  stepMs?: number;
  /** Fraction of window used for training. Default: 0.6. */
  trainFrac?: number;
  /** Number of bars to skip at start of each sub-backtest for indicator warmup. Default: 100. */
  warmupBars?: number;
}

// ---------------------------------------------------------------------------
// buildWalkForwardWindows
// ---------------------------------------------------------------------------

/**
 * Single-pass 60/20/20 walk-forward split.
 * Returns a single WalkForwardWindow with train/validate/test boundaries.
 */
export function buildWalkForwardWindows(
  dataStart: number,
  dataEnd: number,
  config: WalkForwardSplitConfig,
): WalkForwardWindow[] {
  const span = dataEnd - dataStart;
  const trainEnd = dataStart + span * config.trainFrac;
  const validateEnd = dataStart + span * (config.trainFrac + config.validateFrac);

  return [
    {
      trainStart: dataStart,
      trainEnd,
      validateStart: trainEnd,
      validateEnd,
      testStart: validateEnd,
      testEnd: dataEnd,
    },
  ];
}

// ---------------------------------------------------------------------------
// buildRollingWindows
// ---------------------------------------------------------------------------

/**
 * Rolling walk-forward windows.
 * Each window has size windowMs split into trainFrac (train) and (1-trainFrac) (validate).
 * Windows step forward by stepMs each iteration.
 * Stops when start + windowMs > dataEnd.
 */
export function buildRollingWindows(
  dataStart: number,
  dataEnd: number,
  windowMs: number,
  stepMs: number,
  trainFrac: number,
): WalkForwardWindow[] {
  if (stepMs <= 0) {
    throw new Error("stepMs must be > 0 to prevent infinite loop");
  }

  const windows: WalkForwardWindow[] = [];
  let start = dataStart;

  while (start + windowMs <= dataEnd) {
    const trainEnd = start + windowMs * trainFrac;
    const validateEnd = start + windowMs;

    windows.push({
      trainStart: start,
      trainEnd,
      validateStart: trainEnd,
      validateEnd,
    });

    start += stepMs;
  }

  return windows;
}

// ---------------------------------------------------------------------------
// runWalkForward
// ---------------------------------------------------------------------------

/**
 * Walk-forward optimization runner.
 *
 * For each rolling window:
 *   1. Sweep paramGrid on train candles - pick best by Sharpe
 *   2. Evaluate best params on validate candles
 *
 * Returns aggregate OOS metrics and OOS/IS Sharpe ratio.
 */
export async function runWalkForward(
  candles: Candle[],
  paramGrid: Array<Record<string, number>>,
  signalGeneratorFactory: (params: Record<string, number>) => SignalGenerator,
  config: Omit<BacktestConfig, "startTime" | "endTime">,
  options: WalkForwardOptions = {},
): Promise<WalkForwardResult> {
  if (candles.length === 0) {
    return {
      windows: [],
      aggregateOOSMetrics: computeMetrics([], config.capitalUsd),
      oosIsRatio: 0,
    };
  }

  const sortedCandles = [...candles].sort((a, b) => a.t - b.t);
  const dataStart = sortedCandles[0].t;
  const dataEnd = sortedCandles[sortedCandles.length - 1].t;

  const DEFAULT_WINDOW_MS = 30 * 24 * 3_600_000; // 30 days
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const stepMs = options.stepMs ?? Math.floor(windowMs * 0.1);
  const trainFrac = options.trainFrac ?? 0.6;
  const warmupBars = options.warmupBars ?? 100;

  const rollingWindows = buildRollingWindows(dataStart, dataEnd, windowMs, stepMs, trainFrac);

  const windowResults: WalkForwardWindowResult[] = [];

  for (let wi = 0; wi < rollingWindows.length; wi++) {
    const window = rollingWindows[wi];

    // Filter candles to train period using binary search for performance
    const trainCandles = sliceByTime(sortedCandles, window.trainStart, window.trainEnd);

    // Sweep params on train window
    let bestParams: Record<string, number> = paramGrid[0];
    let bestTrainSharpe = -Infinity;

    for (const params of paramGrid) {
      if (trainCandles.length < warmupBars + 2) {
        // Not enough bars to run backtest - use zero Sharpe
        continue;
      }

      const trainResult = runBacktest(
        {
          ...config,
          startTime: window.trainStart,
          endTime: window.trainEnd,
        },
        signalGeneratorFactory(params),
        {
          candles: buildCandleMap(config.pairs, trainCandles),
          fundingData: {},
          warmupBars,
        },
      );

      const trainSharpe = trainResult.metrics.sharpe;
      if (trainSharpe > bestTrainSharpe) {
        bestTrainSharpe = trainSharpe;
        bestParams = params;
      }
    }

    // If we never updated bestTrainSharpe (no candles), set to 0
    if (bestTrainSharpe === -Infinity) {
      bestTrainSharpe = 0;
    }

    // Evaluate best params on validate window using binary search
    const validateCandles = sliceByTime(sortedCandles, window.validateStart, window.validateEnd);

    let validateSharpe = 0;
    let validateTrades: Trade[] = [];

    if (validateCandles.length >= warmupBars + 2) {
      const validateResult = runBacktest(
        {
          ...config,
          startTime: window.validateStart,
          endTime: window.validateEnd,
        },
        signalGeneratorFactory(bestParams),
        {
          candles: buildCandleMap(config.pairs, validateCandles),
          fundingData: {},
          warmupBars,
        },
      );

      validateSharpe = validateResult.metrics.sharpe;
      validateTrades = validateResult.trades;
    }

    windowResults.push({
      windowIndex: wi,
      bestParams,
      trainSharpe: bestTrainSharpe,
      validateSharpe,
      validateTrades,
    });
  }

  // Aggregate all OOS (validate) trades
  const allOOSTrades = windowResults.flatMap((w) => w.validateTrades);
  const aggregateOOSMetrics = computeMetrics(allOOSTrades, config.capitalUsd);

  // OOS/IS ratio: aggregate OOS Sharpe / mean IS Sharpe
  const avgIsSharpe =
    windowResults.length > 0
      ? windowResults.reduce((sum, w) => sum + w.trainSharpe, 0) / windowResults.length
      : 0;

  let oosIsRatio: number;
  if (avgIsSharpe === 0) {
    oosIsRatio = 0;
  } else {
    oosIsRatio = aggregateOOSMetrics.sharpe / avgIsSharpe;
  }

  return {
    windows: windowResults,
    aggregateOOSMetrics,
    oosIsRatio,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Efficiently slice a sorted candles array by timestamp range using binary search.
 * O(log n + k) where k is the number of matching candles.
 * Assumes candles is sorted ascending by t.
 */
function sliceByTime(candles: Candle[], startMs: number, endMs: number): Candle[] {
  const n = candles.length;
  if (n === 0) return [];

  // Binary search for first index >= startMs
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < startMs) lo = mid + 1;
    else hi = mid;
  }
  const firstIdx = lo;

  // Binary search for first index >= endMs
  lo = firstIdx;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < endMs) lo = mid + 1;
    else hi = mid;
  }
  const lastIdx = lo;

  return candles.slice(firstIdx, lastIdx);
}

/** Build a candles map for a single pair (the engine expects Record<string, Candle[]>). */
function buildCandleMap(pairs: string[], candles: Candle[]): Record<string, Candle[]> {
  const map: Record<string, Candle[]> = {};
  for (const pair of pairs) {
    map[pair] = candles;
  }
  return map;
}
