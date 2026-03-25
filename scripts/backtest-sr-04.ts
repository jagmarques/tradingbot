// SR-04: Funding Rate Contrarian
// Fade crowded positions when funding is extreme
// Signal: funding > shortThreshold => SHORT, funding < longThreshold => LONG
// Uses closure to pass pre-loaded funding data to signal generator
//
// Hyperliquid funding rates are in raw fractions (not percentages).
// Example: ETH in Aug-Mar 2025/2026 ranges from -0.00038 to +0.0000383
// We use distribution-calibrated thresholds, not the plan's percentage notation.
//
// Plan thresholds (longThreshold: -0.01, shortThreshold: 0.015) are in percentage notation
// (1% = 0.01). Actual Hyperliquid data is much smaller. We calibrate accordingly.

import * as fs from "node:fs";
import * as path from "node:path";
import { runWalkForward, formatMetricsDashboard } from "../src/services/backtest/index.js";
import { DEFAULT_COST_CONFIG } from "../src/services/backtest/costs.js";
import type { Candle, Signal, SignalGenerator, FundingEntry } from "../src/services/backtest/types.js";

const CANDLE_DIR = "/tmp/bt-pair-cache";
const FUNDING_DIR = "/tmp/bt-funding-cache";
const CAPITAL = 50;
const LEVERAGE = 5;

// Pairs that have both 1h candle data (object format) and funding rate data
const PAIRS = ["ETH", "SOL", "TIA"];

// Load candles handling both {t,o,h,l,c} object and [t,o,h,l,c] array formats
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

// Load funding data from {fundingDir}/{pair}_funding.json
function loadFundingData(pair: string, fundingDir: string): FundingEntry[] {
  const filePath = path.join(fundingDir, `${pair}_funding.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as FundingEntry[];
}

// Build a sorted array of [timestamp, rate] for fast binary-search lookup
// Entries must be sorted by time ascending
function buildFundingIndex(entries: FundingEntry[]): { times: number[]; rates: number[] } {
  const sorted = [...entries].sort((a, b) => a.time - b.time);
  return {
    times: sorted.map((e) => e.time),
    rates: sorted.map((e) => e.rate),
  };
}

// Binary search: find last entry where entry.time <= ts
function getFundingAtTimeBS(
  times: number[],
  rates: number[],
  ts: number,
): number | null {
  if (times.length === 0) return null;
  let lo = 0;
  let hi = times.length - 1;
  if (ts < times[0]) return null;
  if (ts >= times[hi]) return rates[hi];

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ts) lo = mid;
    else hi = mid;
  }
  return rates[lo];
}

interface SR04Params {
  longThreshold: number;
  shortThreshold: number;
  maxHoldBars: number;
}

type FundingIndex = { times: number[]; rates: number[] };

function makeSR04Generator(
  params: SR04Params,
  fundingIndex: Record<string, FundingIndex>,
): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    // Anti-look-ahead: only use candles[0..barIndex-1]
    if (barIndex < 1) return null;
    const bar = candles[barIndex - 1]; // last confirmed bar
    const barTs = bar.t;

    const idx = fundingIndex[pair];
    if (!idx || idx.times.length === 0) return null;

    const fundingRate = getFundingAtTimeBS(idx.times, idx.rates, barTs);
    if (fundingRate === null) return null;

    const entryPrice = candles[barIndex].o;

    if (fundingRate > params.shortThreshold) {
      // Longs are crowded - fade SHORT
      return {
        pair,
        direction: "short",
        entryPrice,
        stopLoss: entryPrice * 1.03,
        takeProfit: entryPrice * 0.95,
        barIndex,
      };
    }

    if (fundingRate < params.longThreshold) {
      // Shorts are crowded - fade LONG
      return {
        pair,
        direction: "long",
        entryPrice,
        stopLoss: entryPrice * 0.97,
        takeProfit: entryPrice * 1.05,
        barIndex,
      };
    }

    return null;
  };
}

// Build param grid
function buildParamGrid(
  longThresholds: number[],
  shortThresholds: number[],
  maxHoldBarsList: number[],
): Array<Record<string, number>> {
  const grid: Array<Record<string, number>> = [];
  for (const longThreshold of longThresholds) {
    for (const shortThreshold of shortThresholds) {
      for (const maxHoldBars of maxHoldBarsList) {
        grid.push({ longThreshold, shortThreshold, maxHoldBars });
      }
    }
  }
  return grid;
}

async function main() {
  console.log("[SR-04] Funding Rate Contrarian - loading data...");

  // Load and index funding data
  const fundingIndex: Record<string, FundingIndex> = {};
  for (const pair of PAIRS) {
    const entries = loadFundingData(pair, FUNDING_DIR);
    if (entries.length > 0) {
      fundingIndex[pair] = buildFundingIndex(entries);
      const rates = entries.map((e) => e.rate);
      const maxR = Math.max(...rates);
      const minR = Math.min(...rates);
      console.log(`[SR-04] Funding indexed: ${pair} - ${entries.length} entries, range: [${minR.toFixed(7)}, ${maxR.toFixed(7)}]`);
    } else {
      console.warn(`[SR-04] WARNING: No funding data for ${pair}`);
    }
  }

  // Load 1h candles
  const candleMap: Record<string, Candle[]> = {};
  for (const pair of PAIRS) {
    try {
      candleMap[pair] = loadCandlesFlex(pair, CANDLE_DIR);
      const c = candleMap[pair];
      console.log(`[SR-04] Candles loaded: ${pair} - ${c.length} bars (${new Date(c[0].t).toISOString().slice(0, 10)} to ${new Date(c[c.length - 1].t).toISOString().slice(0, 10)})`);
    } catch {
      console.warn(`[SR-04] WARNING: No candle data for ${pair}, skipping`);
    }
  }

  const validPairs = PAIRS.filter((p) => candleMap[p] && candleMap[p].length > 0 && fundingIndex[p]);
  if (validPairs.length === 0) {
    console.error("[SR-04] No valid pairs with both candle and funding data");
    process.exit(1);
  }

  const allCandles = validPairs.flatMap((p) => candleMap[p]);
  console.log(`[SR-04] Total candles across ${validPairs.length} pairs: ${allCandles.length}`);

  const config = {
    pairs: validPairs,
    capitalUsd: CAPITAL,
    leverage: LEVERAGE,
    costConfig: DEFAULT_COST_CONFIG,
    candleDir: CANDLE_DIR,
    fundingDir: FUNDING_DIR,
  };

  // Primary thresholds: plan's -0.01/-0.015 long, 0.015/0.02/0.025 short
  // Hyperliquid rates are in raw fraction format, not percent.
  // 1% = 0.01, so the plan's thresholds apply as-is in fraction units.
  // However, actual Aug-2025 data max is ~0.0001, so we use distribution-calibrated values.
  let paramGrid = buildParamGrid(
    [-0.0001, -0.00015],
    [0.0001, 0.00015, 0.0002],
    [8, 24, 48],
  );

  console.log(`[SR-04] Running walk-forward with ${paramGrid.length} param combinations (primary thresholds)...`);

  const result = await runWalkForward(
    allCandles,
    paramGrid,
    (params) =>
      makeSR04Generator(
        {
          longThreshold: params.longThreshold,
          shortThreshold: params.shortThreshold,
          maxHoldBars: params.maxHoldBars,
        },
        fundingIndex,
      ),
    config,
  );

  const oosTradeCount = result.aggregateOOSMetrics.totalTrades;
  console.log(`[SR-04] OOS trade count (primary): ${oosTradeCount}, windows: ${result.windows.length}`);

  if (oosTradeCount < 100) {
    // Relax: use 1.5 bps threshold (0.000015) - plan fallback equivalent
    console.log("[SR-04] WARNING: < 100 OOS trades. Relaxing thresholds (plan fallback: longThreshold: -0.000015, shortThreshold: 0.000015)");

    paramGrid = buildParamGrid(
      [-0.000015, -0.00002, -0.000025],
      [0.000015, 0.00002, 0.000025],
      [8, 24, 48],
    );

    const relaxedResult = await runWalkForward(
      allCandles,
      paramGrid,
      (params) =>
        makeSR04Generator(
          {
            longThreshold: params.longThreshold,
            shortThreshold: params.shortThreshold,
            maxHoldBars: params.maxHoldBars,
          },
          fundingIndex,
        ),
      config,
    );

    const relaxedCount = relaxedResult.aggregateOOSMetrics.totalTrades;
    console.log(`[SR-04] OOS trade count (relaxed): ${relaxedCount}, windows: ${relaxedResult.windows.length}`);

    if (relaxedCount < 100) {
      console.log(`[SR-04] WARNING: ${relaxedCount} OOS trades with relaxed thresholds. Funding signal is low frequency on 3 pairs for 7-month period.`);
    }

    console.log(formatMetricsDashboard(relaxedResult.aggregateOOSMetrics, "SR-04 Funding Contrarian (relaxed)"));
    console.log(`OOS/IS ratio: ${relaxedResult.oosIsRatio.toFixed(2)}`);
    console.log(`Windows: ${relaxedResult.windows.length}`);
  } else {
    console.log(formatMetricsDashboard(result.aggregateOOSMetrics, "SR-04 Funding Contrarian"));
    console.log(`OOS/IS ratio: ${result.oosIsRatio.toFixed(2)}`);
    console.log(`Windows: ${result.windows.length}`);
  }
}

main().catch((err) => {
  console.error("[SR-04] Fatal error:", err);
  process.exit(1);
});
