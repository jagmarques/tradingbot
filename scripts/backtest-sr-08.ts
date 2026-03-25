/**
 * SR-08: Anchored VWAP Deviation Mean-Reversion
 *
 * Fades price deviations from an anchored VWAP on 5m candles.
 * Anchor: most recent swing high/low within anchorLookback bars.
 * Signal: price >= vwap + deviationSd*sd (short) or <= vwap - deviationSd*sd (long)
 * TP at VWAP, SL 1.5%
 *
 * npx tsx scripts/backtest-sr-08.ts
 */

import * as fs from "fs";
import * as path from "path";
import type { Candle, Signal, SignalGenerator } from "../src/services/backtest/types.js";
import {
  runWalkForward,
  formatMetricsDashboard,
  DEFAULT_COST_CONFIG,
} from "../src/services/backtest/index.js";

const CANDLE_DIR_5M = "/tmp/bt-pair-cache-5m";
const FUNDING_DIR = "/tmp/bt-funding-cache";

// Use 5 liquid pairs for feasibility on 5m data (340k bars/pair is too large for full sweep)
const PAIRS_5M = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

const CAPITAL = 50;
const LEVERAGE = 5;

// Use last 90 days of 5m data for feasibility
const NINETY_DAYS_MS = 90 * 24 * 3_600_000;

// ---------------------------------------------------------------------------
// 5m candle loader
// ---------------------------------------------------------------------------

function load5mCandles(pair: string, dir: string): Candle[] {
  const filePath = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as Candle[];
  return data.slice().sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Anchored VWAP helpers
// ---------------------------------------------------------------------------

/**
 * Find anchor bar index: most recent swing high or low within lookback bars.
 * Returns the later of the max-high and min-low bars.
 */
function findAnchorBar(candles: Candle[], endIdx: number, lookback: number): number {
  const start = Math.max(0, endIdx - lookback);
  const window = candles.slice(start, endIdx);
  if (window.length === 0) return start;

  let maxIdx = 0;
  let minIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].h > window[maxIdx].h) maxIdx = i;
    if (window[i].l < window[minIdx].l) minIdx = i;
  }
  // Most recent significant swing
  return start + Math.max(maxIdx, minIdx);
}

/**
 * Compute anchored VWAP and volume-weighted std dev from candles[from..to-1].
 */
function anchoredVwap(candles: Candle[], from: number, to: number): { vwap: number; sd: number } {
  if (from >= to) return { vwap: 0, sd: 0 };
  let sumVTP = 0;
  let sumVol = 0;
  for (let i = from; i < to; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const vol = candles[i].v != null && candles[i].v! > 0 ? candles[i].v! : 1;
    sumVTP += tp * vol;
    sumVol += vol;
  }
  if (sumVol === 0) return { vwap: 0, sd: 0 };

  const vwap = sumVTP / sumVol;

  let sumVarVol = 0;
  for (let i = from; i < to; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const vol = candles[i].v != null && candles[i].v! > 0 ? candles[i].v! : 1;
    sumVarVol += vol * (tp - vwap) ** 2;
  }
  return { vwap, sd: Math.sqrt(sumVarVol / sumVol) };
}

// ---------------------------------------------------------------------------
// SR-08 signal generator factory
// ---------------------------------------------------------------------------

interface SR08Params {
  anchorLookback: number;
  deviationSd: number;
  maxHoldBars: number;
}

export function makeSR08Generator(params: SR08Params): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    // Anti-look-ahead: only use candles[0..barIndex-1]
    if (barIndex < params.anchorLookback + 10) return null;

    // Find anchor bar within lookback window (use indices directly, no slice)
    const anchorIdx = findAnchorBar(candles, barIndex, params.anchorLookback);

    // Guard: need at least 10 bars between anchor and current bar
    const barsFromAnchor = barIndex - anchorIdx;
    if (barsFromAnchor < 10) return null;

    // Compute anchored VWAP from anchor to current bar (exclusive of barIndex)
    const { vwap, sd } = anchoredVwap(candles, anchorIdx, barIndex);
    if (vwap === 0 || sd === 0) return null;

    const price = candles[barIndex - 1].c;
    const upperBand = vwap + params.deviationSd * sd;
    const lowerBand = vwap - params.deviationSd * sd;

    const entryPrice = candles[barIndex].o;
    const slPct = 0.015; // 1.5%

    if (price <= lowerBand) {
      // Long: price below anchored VWAP band - fade downward deviation
      return {
        pair,
        direction: "long",
        entryPrice,
        stopLoss: entryPrice * (1 - slPct),
        takeProfit: vwap,
        barIndex,
      };
    }

    if (price >= upperBand) {
      // Short: price above anchored VWAP band - fade upward deviation
      return {
        pair,
        direction: "short",
        entryPrice,
        stopLoss: entryPrice * (1 + slPct),
        takeProfit: vwap,
        barIndex,
      };
    }

    return null;
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[SR-08] Anchored VWAP Deviation MR - loading 5m candles...");

  const candleMap: Record<string, Candle[]> = {};
  let loaded = 0;
  for (const pair of PAIRS_5M) {
    const raw = load5mCandles(pair, CANDLE_DIR_5M);
    if (raw.length > 0) {
      // Use last 90 days for feasibility (still ~26k bars per pair)
      const cutoff = raw[raw.length - 1].t - NINETY_DAYS_MS;
      candleMap[pair] = raw.filter((c) => c.t >= cutoff);
      loaded++;
    }
  }
  console.log(`[SR-08] Loaded ${loaded}/${PAIRS_5M.length} pairs (last 90 days of 5m data)`);

  if (loaded === 0) {
    console.error("[SR-08] No 5m candles found - run download-5m-candles.ts first");
    process.exit(1);
  }

  const totalBars = Object.values(candleMap).reduce((s, c) => s + c.length, 0);
  console.log(`[SR-08] Total 5m candles in window: ${totalBars}`);

  const paramGrid: SR08Params[] = [];
  for (const anchorLookback of [48, 96, 192]) {
    for (const deviationSd of [1.5, 2.0, 2.5]) {
      for (const maxHoldBars of [12, 24, 48]) {
        paramGrid.push({ anchorLookback, deviationSd, maxHoldBars });
      }
    }
  }
  console.log(`[SR-08] Param grid: ${paramGrid.length} combinations`);

  const config = {
    pairs: PAIRS_5M,
    capitalUsd: CAPITAL,
    leverage: LEVERAGE,
    costConfig: DEFAULT_COST_CONFIG,
    candleDir: CANDLE_DIR_5M,
    fundingDir: FUNDING_DIR,
  };

  // 7-day windows, 2-day steps for 5m timeframe
  const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
  const TWO_DAYS_MS = 2 * 24 * 3_600_000;

  // Run per-pair and aggregate
  const allOOSTrades: import("../src/services/backtest/types.js").Trade[] = [];
  const pairResults: { pair: string; trades: number; sharpe: number }[] = [];

  for (const pair of PAIRS_5M) {
    const candles = candleMap[pair];
    if (!candles || candles.length < 500) continue;

    console.log(`  [${pair}] Running walk-forward on ${candles.length} bars...`);

    const pairConfig = { ...config, pairs: [pair] };
    const result = await runWalkForward(candles, paramGrid, makeSR08Generator, pairConfig, {
      windowMs: SEVEN_DAYS_MS,
      stepMs: TWO_DAYS_MS,
      trainFrac: 0.6,
      warmupBars: 200,
    });

    allOOSTrades.push(...result.windows.flatMap((w) => w.validateTrades));
    pairResults.push({
      pair,
      trades: result.aggregateOOSMetrics.totalTrades,
      sharpe: result.aggregateOOSMetrics.sharpe,
    });

    console.log(
      `  ${pair.padEnd(10)} OOS trades: ${result.aggregateOOSMetrics.totalTrades}, Sharpe: ${result.aggregateOOSMetrics.sharpe.toFixed(3)}, OOS/IS: ${result.oosIsRatio.toFixed(2)}`,
    );
  }

  // Compute aggregate metrics across all pairs
  const { computeMetrics } = await import("../src/services/backtest/metrics.js");
  const aggregateMetrics = computeMetrics(allOOSTrades, CAPITAL);

  console.log("\n" + formatMetricsDashboard(aggregateMetrics, "SR-08 Anchored VWAP MR"));
  console.log(`\nPairs tested: ${pairResults.length}`);
}

main().catch((err) => {
  console.error("[SR-08] Fatal:", err);
  process.exit(1);
});
