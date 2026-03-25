/**
 * SR-09: Volume Profile Point of Control Reversion
 *
 * Fades moves away from the volume profile POC on 1h candles.
 * Uses VolumeProfile from technicalindicators; falls back to price histogram if no volume.
 * Signal: price > poc + deviationAtr*ATR (short) or < poc - deviationAtr*ATR (long)
 * TP at POC, SL 3%
 *
 * npx tsx scripts/backtest-sr-09.ts
 */

import * as fs from "fs";
import * as path from "path";
import { VolumeProfile } from "technicalindicators";
import type { Candle, Signal, SignalGenerator } from "../src/services/backtest/types.js";
import {
  runWalkForward,
  formatMetricsDashboard,
  DEFAULT_COST_CONFIG,
} from "../src/services/backtest/index.js";

const CANDLE_DIR = "/tmp/bt-pair-cache";
const FUNDING_DIR = "/tmp/bt-funding-cache";

const PAIRS = [
  "SOL", "ETH", "BTC", "INJ", "AAVE", "NEAR", "RUNE", "TIA", "JUP",
  "PEPE", "BONK", "FLOKI", "MATIC", "BNB", "FIL", "FET", "TAO", "ONDO", "PENDLE",
];

const CAPITAL = 50;
const LEVERAGE = 5;

// ---------------------------------------------------------------------------
// 1h candle loader (array format: [t, o, h, l, c] or object {t,o,h,l,c})
// ---------------------------------------------------------------------------

function load1hCandles(pair: string, dir: string): Candle[] {
  const filePath = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  let data: (number[] | Candle)[] | null;
  try {
    data = JSON.parse(raw) as (number[] | Candle)[] | null;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((b) => b != null)
    .map((b): Candle => {
      if (Array.isArray(b)) {
        return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
      }
      return b as Candle;
    })
    .sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// ATR (manual, period 14)
// ---------------------------------------------------------------------------

function computeATR(candles: Candle[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ---------------------------------------------------------------------------
// Volume Profile POC finder
// ---------------------------------------------------------------------------

interface POCResult {
  poc: number;
  usedRealVolume: boolean;
}

function findPOC(candles: Candle[], noOfBars: number): POCResult | null {
  if (candles.length < 2) return null;

  const hasVolume = candles.some((c) => c.v != null && c.v > 0);

  const volumes = hasVolume
    ? candles.map((c) => (c.v != null && c.v > 0 ? c.v : 1))
    : candles.map(() => 1);

  try {
    const buckets = VolumeProfile.calculate({
      high: candles.map((c) => c.h),
      open: candles.map((c) => c.o),
      low: candles.map((c) => c.l),
      close: candles.map((c) => c.c),
      volume: volumes,
      noOfBars,
    });

    if (!buckets || buckets.length === 0) return null;

    // Find POC: bucket with maximum total volume
    let maxVol = -1;
    let pocBucket = buckets[0];
    for (const bucket of buckets) {
      const total = bucket.bullishVolume + bucket.bearishVolume;
      if (total > maxVol) {
        maxVol = total;
        pocBucket = bucket;
      }
    }

    const poc = (pocBucket.rangeStart + pocBucket.rangeEnd) / 2;
    return { poc, usedRealVolume: hasVolume };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SR-09 signal generator factory
// ---------------------------------------------------------------------------

interface SR09Params {
  pocWindow: number;
  deviationAtr: number;
  noOfBars: number;
  maxHoldBars: number;
}

export function makeSR09Generator(params: SR09Params): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    // Anti-look-ahead: only use candles[0..barIndex-1]
    if (barIndex < params.pocWindow + 14) return null;

    // Take last pocWindow bars before current bar
    const startIdx = Math.max(0, barIndex - params.pocWindow);
    const slice = candles.slice(startIdx, barIndex);

    if (slice.length < 10) return null;

    // Find POC
    const pocResult = findPOC(slice, params.noOfBars);
    if (!pocResult) return null;
    const { poc } = pocResult;

    // Compute ATR(14) on the slice
    const atr = computeATR(slice, 14);
    if (atr === 0) return null;

    const price = candles[barIndex - 1].c;
    const upperThreshold = poc + params.deviationAtr * atr;
    const lowerThreshold = poc - params.deviationAtr * atr;

    const entryPrice = candles[barIndex].o;
    const slPct = 0.03; // 3%

    if (price > upperThreshold) {
      // Short: price far above POC - fade upward move, TP at POC
      return {
        pair,
        direction: "short",
        entryPrice,
        stopLoss: entryPrice * (1 + slPct),
        takeProfit: poc,
        barIndex,
      };
    }

    if (price < lowerThreshold) {
      // Long: price far below POC - fade downward move, TP at POC
      return {
        pair,
        direction: "long",
        entryPrice,
        stopLoss: entryPrice * (1 - slPct),
        takeProfit: poc,
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
  console.log("[SR-09] Volume Profile POC Reversion - loading 1h candles...");

  const candleMap: Record<string, Candle[]> = {};
  let loaded = 0;
  let volumePairs = 0;
  for (const pair of PAIRS) {
    const candles = load1hCandles(pair, CANDLE_DIR);
    if (candles.length > 0) {
      candleMap[pair] = candles;
      loaded++;
      const hasVol = candles.some((c) => c.v != null && c.v > 0);
      if (hasVol) volumePairs++;
    }
  }
  console.log(`[SR-09] Loaded ${loaded}/${PAIRS.length} pairs`);
  console.log(
    `[SR-09] Volume data: ${volumePairs}/${loaded} pairs have real volume (others use price histogram fallback)`,
  );

  if (loaded === 0) {
    console.error("[SR-09] No 1h candles found");
    process.exit(1);
  }

  const totalBars = Object.values(candleMap).reduce((s, c) => s + c.length, 0);
  console.log(`[SR-09] Total 1h candles: ${totalBars}`);

  const paramGrid: SR09Params[] = [];
  for (const pocWindow of [48, 96, 168]) {
    for (const deviationAtr of [2.0, 3.0]) {
      for (const noOfBars of [20, 50]) {
        for (const maxHoldBars of [8, 24, 48]) {
          paramGrid.push({ pocWindow, deviationAtr, noOfBars, maxHoldBars });
        }
      }
    }
  }
  console.log(`[SR-09] Param grid: ${paramGrid.length} combinations`);

  const config = {
    pairs: PAIRS,
    capitalUsd: CAPITAL,
    leverage: LEVERAGE,
    costConfig: DEFAULT_COST_CONFIG,
    candleDir: CANDLE_DIR,
    fundingDir: FUNDING_DIR,
  };

  // Default 30-day walk-forward windows for 1h timeframe
  const allOOSTrades: import("../src/services/backtest/types.js").Trade[] = [];
  const pairResults: { pair: string; trades: number; sharpe: number }[] = [];

  for (const pair of PAIRS) {
    const candles = candleMap[pair];
    if (!candles || candles.length < 300) {
      console.log(`  Skipping ${pair} - insufficient candles (${candles?.length ?? 0})`);
      continue;
    }

    const hasVol = candles.some((c) => c.v != null && c.v > 0);
    process.stdout.write(
      `  [${pair}] ${candles.length} bars, volume: ${hasVol ? "real" : "histogram fallback"}...`,
    );

    const pairConfig = { ...config, pairs: [pair] };
    const result = await runWalkForward(candles, paramGrid, makeSR09Generator, pairConfig, {
      warmupBars: 200,
    });

    allOOSTrades.push(...result.windows.flatMap((w) => w.validateTrades));
    pairResults.push({
      pair,
      trades: result.aggregateOOSMetrics.totalTrades,
      sharpe: result.aggregateOOSMetrics.sharpe,
    });

    process.stdout.write(
      ` OOS trades: ${result.aggregateOOSMetrics.totalTrades}, Sharpe: ${result.aggregateOOSMetrics.sharpe.toFixed(3)}\n`,
    );
  }

  // Compute aggregate metrics across all pairs
  const { computeMetrics } = await import("../src/services/backtest/metrics.js");
  const aggregateMetrics = computeMetrics(allOOSTrades, CAPITAL);

  console.log("\n" + formatMetricsDashboard(aggregateMetrics, "SR-09 Volume POC Reversion"));
  console.log(`\nPairs tested: ${pairResults.length}`);
  console.log(`OOS trades: ${aggregateMetrics.totalTrades} (need 100+ for valid sample)`);

  if (aggregateMetrics.totalTrades < 100) {
    console.log("[SR-09] WARNING: Less than 100 OOS trades - results may not be statistically significant");
  }
}

main().catch((err) => {
  console.error("[SR-09] Fatal:", err);
  process.exit(1);
});
