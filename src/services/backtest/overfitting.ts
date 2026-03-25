import type { Trade, BacktestConfig, Candle, SignalGenerator } from "./types.js";
import { computeMetrics } from "./metrics.js";
import { runBacktest } from "./engine.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface MonteCarloResult {
  actualSharpe: number;
  p_value: number;
  medianShuffledSharpe: number;
  percentile95: number;
  isSignificant: boolean; // p_value < 0.01
  runs: number;
}

export interface SensitivityVariationResult {
  params: Record<string, number>;
  sharpe: number;
  pf: number;
  pnl: number;
}

export interface SensitivityResult {
  results: SensitivityVariationResult[];
  pctProfitable: number;
  isRobust: boolean; // pctProfitable >= 70
}

export interface OverfittingReport {
  monteCarlo: MonteCarloResult;
  oosIsRatio: number;
  oosIsPass: boolean; // oosIsRatio >= 0.5
  overallPass: boolean; // monteCarlo.isSignificant AND oosIsPass
  summary: string;
}

// ── Fisher-Yates shuffle (in-place) ────────────────────────────────────────

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j] as T;
    arr[j] = tmp as T;
  }
}

// ── monteCarloShuffle ───────────────────────────────────────────────────────

/**
 * Shuffles trade P&Ls 1000 times (default) to test if actual Sharpe is statistically
 * significant. Uses p < 0.01 threshold (stricter than 0.05 for multiple testing with
 * ~19 pairs).
 *
 * Algorithm: shuffle PnL values, assign sequential daily timestamps, compute Sharpe.
 * p_value = fraction of shuffled sequences with Sharpe >= actual Sharpe.
 */
export function monteCarloShuffle(
  trades: Trade[],
  capitalUsd: number,
  runs = 1000,
): MonteCarloResult {
  // Edge case: no trades
  if (trades.length === 0) {
    return {
      actualSharpe: 0,
      p_value: 1,
      medianShuffledSharpe: 0,
      percentile95: 0,
      isSignificant: false,
      runs,
    };
  }

  const actualMetrics = computeMetrics(trades, capitalUsd);
  const actualSharpe = actualMetrics.sharpe;

  // Extract PnL values once
  const pnls = trades.map((t) => t.pnl);

  const DAY_MS = 86_400_000;
  const shuffledSharpes: number[] = [];
  let countBetter = 0;

  for (let r = 0; r < runs; r++) {
    // Shuffle PnL values (Fisher-Yates)
    const shuffledPnls = [...pnls];
    shuffleInPlace(shuffledPnls);

    // Create synthetic trades with sequential daily timestamps
    const syntheticTrades: Trade[] = shuffledPnls.map((pnl, i) => ({
      id: `mc_${r}_${i}`,
      pair: "BTC",
      direction: "long" as const,
      entryPrice: 100,
      exitPrice: 100,
      entryTime: i * DAY_MS,
      exitTime: (i + 1) * DAY_MS,
      pnl,
      pnlPct: (pnl / capitalUsd) * 100,
      exitReason: "mc",
      fees: 0,
      slippage: 0,
      fundingCost: 0,
    }));

    const shuffledMetrics = computeMetrics(syntheticTrades, capitalUsd);
    const shuffledSharpe = shuffledMetrics.sharpe;
    shuffledSharpes.push(shuffledSharpe);

    if (shuffledSharpe >= actualSharpe) {
      countBetter++;
    }
  }

  const p_value = countBetter / runs;

  // Compute median and 95th percentile of shuffled distribution
  const sorted = [...shuffledSharpes].sort((a, b) => a - b);
  const midIdx = Math.floor(sorted.length / 2);
  const medianShuffledSharpe =
    sorted.length % 2 === 0
      ? ((sorted[midIdx - 1] ?? 0) + (sorted[midIdx] ?? 0)) / 2
      : (sorted[midIdx] ?? 0);

  const p95Idx = Math.floor(sorted.length * 0.95);
  const percentile95 = sorted[Math.min(p95Idx, sorted.length - 1)] ?? 0;

  return {
    actualSharpe,
    p_value,
    medianShuffledSharpe,
    percentile95,
    isSignificant: p_value < 0.01,
    runs,
  };
}

// ── sensitivitySweep ────────────────────────────────────────────────────────

/**
 * Tests strategy robustness by running the backtest with N parameter variations.
 * Reports % of variations that are profitable (profitFactor > 1.0).
 * isRobust = pctProfitable >= 70 (70% threshold).
 */
export function sensitivitySweep(
  baseParams: Record<string, number>,
  variations: Record<string, number>[],
  signalGeneratorFactory: (params: Record<string, number>) => SignalGenerator,
  candles: Candle[],
  config: BacktestConfig,
): SensitivityResult {
  void baseParams; // kept for API consistency (documents the baseline)
  void candles; // candles are provided via config.candleDir or pre-loaded in options

  const results: SensitivityVariationResult[] = [];

  for (const variation of variations) {
    const signalGenerator = signalGeneratorFactory(variation);
    const backtestResult = runBacktest(config, signalGenerator);

    results.push({
      params: variation,
      sharpe: backtestResult.metrics.sharpe,
      pf: backtestResult.metrics.profitFactor,
      pnl: backtestResult.metrics.totalPnl,
    });
  }

  const profitable = results.filter((r) => r.pf > 1.0).length;
  const pctProfitable = variations.length > 0 ? (profitable / variations.length) * 100 : 0;

  return {
    results,
    pctProfitable,
    isRobust: pctProfitable >= 70,
  };
}

// ── overfittingReport ───────────────────────────────────────────────────────

/**
 * Combined overfitting report:
 * - Monte Carlo shuffle test (p < 0.01 required)
 * - OOS/IS Sharpe ratio >= 0.5 required
 * Both must pass for overallPass = true.
 */
export function overfittingReport(
  trades: Trade[],
  capitalUsd: number,
  oosIsRatio: number,
  monteCarloRuns = 1000,
): OverfittingReport {
  const monteCarlo = monteCarloShuffle(trades, capitalUsd, monteCarloRuns);
  const oosIsPass = oosIsRatio >= 0.5;
  const overallPass = monteCarlo.isSignificant && oosIsPass;

  const mcStatus = monteCarlo.isSignificant
    ? `PASS (p=${monteCarlo.p_value.toFixed(4)})`
    : `FAIL (p=${monteCarlo.p_value.toFixed(4)}, need < 0.01)`;

  const oosStatus = oosIsPass
    ? `PASS (ratio=${oosIsRatio.toFixed(2)})`
    : `FAIL (ratio=${oosIsRatio.toFixed(2)}, need >= 0.5)`;

  const overallStatus = overallPass ? "PASS" : "FAIL";

  const summary = [
    `Overfitting check: ${overallStatus}`,
    `  Monte Carlo (${monteCarlo.runs} runs): ${mcStatus}`,
    `    Actual Sharpe: ${monteCarlo.actualSharpe.toFixed(3)}`,
    `    Median shuffled: ${monteCarlo.medianShuffledSharpe.toFixed(3)}`,
    `    95th pct shuffled: ${monteCarlo.percentile95.toFixed(3)}`,
    `  OOS/IS ratio: ${oosStatus}`,
  ].join("\n");

  return {
    monteCarlo,
    oosIsRatio,
    oosIsPass,
    overallPass,
    summary,
  };
}
