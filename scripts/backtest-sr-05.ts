/**
 * SR-05: GARCH Contrarian - fade z-score spikes
 * Opposite of live GARCH-chan: short on high z, long on low z
 * 60/20/20 walk-forward, sweep params on train, evaluate OOS
 *
 * npx tsx scripts/backtest-sr-05.ts
 */

import {
  runBacktest,
  loadCandles,
  formatMetricsDashboard,
  computeMetrics,
  DEFAULT_COST_CONFIG,
} from "../src/services/backtest/index.js";
import type { Candle, Signal, SignalGenerator } from "../src/services/backtest/types.js";

const CANDLE_DIR = "/tmp/bt-pair-cache";
const FUNDING_DIR = "/tmp/bt-funding-cache";
const CAPITAL = 50;
const LEVERAGE = 5;

const ALL_PAIRS = [
  "SOL", "ETH", "NEAR", "RENDER", "FIL", "AAVE", "INJ", "FET",
  "TAO", "ONDO", "PENDLE", "STX", "RUNE", "TIA", "JUP", "MATIC", "BNB",
];

interface GarchIndicators {
  // Per-bar z-score (GARCH-style momentum / volatility)
  z: Float64Array;
  tsIndex: Map<number, number>;
}

/**
 * Precompute GARCH-style z-scores for all bars in a candle array.
 * z = momentum / vol
 * momentum = close[b-1] / close[b-lookback-1] - 1  (lookback-bar return)
 * vol = sqrt(sum(ret^2) / volWindow)  over last volWindow bars
 *
 * Only uses data up to bar b-1 (no look-ahead).
 */
function buildGarchIndicators(
  candles: Candle[],
  lookback: number,
  volWindow: number,
): GarchIndicators {
  const n = candles.length;
  const z = new Float64Array(n).fill(NaN);
  const tsIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) tsIndex.set(candles[i].t, i);

  const minBars = Math.max(lookback, volWindow) + 2;

  for (let b = minBars; b < n; b++) {
    // Momentum: return over lookback bars ending at b-1
    const momentum = candles[b - 1].c / candles[b - 1 - lookback].c - 1;

    // Vol: RMS of 1-bar returns over last volWindow bars ending at b-1
    let sumSq = 0;
    let count = 0;
    for (let i = b - volWindow; i < b; i++) {
      if (i <= 0) continue;
      const ret = candles[i].c / candles[i - 1].c - 1;
      sumSq += ret * ret;
      count++;
    }
    if (count < 5) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;

    z[b] = momentum / vol;
  }

  return { z, tsIndex };
}

// Global cache: "(pair):(lookback):(volWindow)" -> GarchIndicators
const indicatorCache = new Map<string, GarchIndicators>();

function getIndicators(
  pair: string,
  lookback: number,
  volWindow: number,
  candleMap: Record<string, Candle[]>,
): GarchIndicators | undefined {
  const key = `${pair}:${lookback}:${volWindow}`;
  if (indicatorCache.has(key)) return indicatorCache.get(key);
  const candles = candleMap[pair];
  if (!candles) return undefined;
  const ind = buildGarchIndicators(candles, lookback, volWindow);
  indicatorCache.set(key, ind);
  return ind;
}

/**
 * Build per-pair contrarian signal function.
 * z > entryZ => SHORT (fade the spike up)
 * z < -entryZ => LONG (fade the drop)
 */
function buildPairSignalFn(
  ind: GarchIndicators,
  params: { entryZ: number; maxHoldBars: number },
): (candles: Candle[], barIndex: number, pair: string) => Signal | null {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    const t = candles[barIndex]?.t;
    if (t === undefined) return null;
    const origIdx = ind.tsIndex.get(t);
    if (origIdx === undefined || isNaN(ind.z[origIdx])) return null;
    const z = ind.z[origIdx];
    if (Math.abs(z) < params.entryZ) return null;

    // CONTRARIAN: short on high z (spike up), long on low z (spike down)
    const dir: "long" | "short" = z < -params.entryZ ? "long" : "short";
    const ep = candles[barIndex].o;

    // SL: 3% from entry (same as live GARCH config)
    // TP: entryZ * 1.5% from entry (reversion target)
    const slPct = 0.03;
    const tpPct = params.entryZ * 0.015;

    return {
      pair, direction: dir, entryPrice: ep, barIndex,
      stopLoss: dir === "long" ? ep * (1 - slPct) : ep * (1 + slPct),
      takeProfit: dir === "long" ? ep * (1 + tpPct) : ep * (1 - tpPct),
    };
  };
}

function makeMultiPairGenerator(
  pairFns: Map<string, (c: Candle[], b: number, p: string) => Signal | null>,
): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    const fn = pairFns.get(pair);
    if (!fn) return null;
    return fn(candles, barIndex, pair);
  };
}

async function main() {
  console.log("[SR-05] Loading candles...");

  const candleMap: Record<string, Candle[]> = {};
  const pairs: string[] = [];
  for (const p of ALL_PAIRS) {
    try {
      const cs = loadCandles(p, CANDLE_DIR);
      if (cs.length > 200) {
        candleMap[p] = cs;
        pairs.push(p);
      }
    } catch {
      // Not in cache
    }
  }

  if (pairs.length < 3) {
    console.error("[SR-05] Need at least 3 pairs. Found:", pairs.length);
    process.exit(1);
  }

  console.log(`[SR-05] Loaded ${pairs.length} pairs: ${pairs.join(", ")}`);

  // Determine time range
  const dataStart = Math.min(...pairs.map((p) => candleMap[p][0].t));
  const dataEnd = Math.max(...pairs.map((p) => candleMap[p][candleMap[p].length - 1].t));
  const span = dataEnd - dataStart;
  const trainEnd = dataStart + span * 0.6;
  const validateEnd = dataStart + span * 0.8;

  console.log(`[SR-05] Data: ${new Date(dataStart).toISOString().split("T")[0]} to ${new Date(dataEnd).toISOString().split("T")[0]}`);
  console.log(`[SR-05] Train:..${new Date(trainEnd).toISOString().split("T")[0]}  Val:..${new Date(validateEnd).toISOString().split("T")[0]}  Test:..${new Date(dataEnd).toISOString().split("T")[0]}`);

  // Precompute all indicator sets
  console.log("[SR-05] Precomputing GARCH z-scores...");
  for (const lookback of [3, 4, 6]) {
    for (const volWindow of [20, 30, 40]) {
      for (const pair of pairs) {
        getIndicators(pair, lookback, volWindow, candleMap);
      }
    }
  }
  console.log(`[SR-05] Precomputed ${indicatorCache.size} indicator sets.`);

  // Build per-period candle maps
  const trainMap: Record<string, Candle[]> = {};
  const valMap: Record<string, Candle[]> = {};
  const testMap: Record<string, Candle[]> = {};
  for (const p of pairs) {
    trainMap[p] = candleMap[p].filter((c) => c.t < trainEnd);
    valMap[p] = candleMap[p].filter((c) => c.t >= trainEnd && c.t < validateEnd);
    testMap[p] = candleMap[p].filter((c) => c.t >= validateEnd);
  }

  const baseConfig = {
    pairs,
    capitalUsd: CAPITAL,
    leverage: LEVERAGE,
    costConfig: DEFAULT_COST_CONFIG,
    candleDir: CANDLE_DIR,
    fundingDir: FUNDING_DIR,
  };

  // Parameter grid
  const paramGrid: Array<{
    lookback: number;
    volWindow: number;
    entryZ: number;
    maxHoldBars: number;
  }> = [];
  for (const lookback of [3, 4, 6]) {
    for (const volWindow of [20, 30, 40]) {
      for (const entryZ of [2.5, 3.0, 3.5]) {
        for (const maxHoldBars of [4, 8, 12, 24]) {
          paramGrid.push({ lookback, volWindow, entryZ, maxHoldBars });
        }
      }
    }
  }

  console.log(`[SR-05] Sweeping ${paramGrid.length} param combos on train set...\n`);

  // Build signal generator
  function buildGenerator(params: {
    lookback: number;
    volWindow: number;
    entryZ: number;
    maxHoldBars: number;
  }): SignalGenerator {
    const pairFns = new Map<string, (c: Candle[], b: number, p: string) => Signal | null>();
    for (const pair of pairs) {
      const ind = getIndicators(pair, params.lookback, params.volWindow, candleMap);
      if (ind) {
        pairFns.set(pair, buildPairSignalFn(ind, params));
      }
    }
    return makeMultiPairGenerator(pairFns);
  }

  // Sweep params on train set - select by Sharpe with min trade filter
  const MIN_TRAIN_TRADES = 50;
  let bestParams = paramGrid[0];
  let bestTrainSharpe = -Infinity;
  let bestTrainTrades = 0;

  for (const params of paramGrid) {
    const gen = buildGenerator(params);
    const r = runBacktest(
      { ...baseConfig, startTime: dataStart, endTime: trainEnd, maxHoldBars: params.maxHoldBars },
      gen,
      { candles: trainMap, warmupBars: 50 },
    );
    if (r.metrics.totalTrades >= MIN_TRAIN_TRADES && r.metrics.sharpe > bestTrainSharpe) {
      bestTrainSharpe = r.metrics.sharpe;
      bestParams = params;
      bestTrainTrades = r.metrics.totalTrades;
    }
  }

  // Fallback: if no params met minimum, pick by max trades
  if (bestTrainTrades === 0) {
    for (const params of paramGrid) {
      const gen = buildGenerator(params);
      const r = runBacktest(
        { ...baseConfig, startTime: dataStart, endTime: trainEnd, maxHoldBars: params.maxHoldBars },
        gen,
        { candles: trainMap, warmupBars: 50 },
      );
      if (r.metrics.totalTrades > bestTrainTrades) {
        bestTrainTrades = r.metrics.totalTrades;
        bestParams = params;
        bestTrainSharpe = r.metrics.sharpe;
      }
    }
  }

  console.log(
    `Best IS params: lookback=${bestParams.lookback}, volWindow=${bestParams.volWindow}, ` +
    `entryZ=${bestParams.entryZ}, maxHoldBars=${bestParams.maxHoldBars}`,
  );
  console.log(`Best IS Sharpe: ${bestTrainSharpe.toFixed(3)}, IS Trades: ${bestTrainTrades}\n`);

  // Evaluate best params on OOS
  const bestGen = buildGenerator(bestParams);

  const valResult = runBacktest(
    { ...baseConfig, startTime: trainEnd, endTime: validateEnd, maxHoldBars: bestParams.maxHoldBars },
    bestGen,
    { candles: valMap, warmupBars: 50 },
  );

  const testResult = runBacktest(
    { ...baseConfig, startTime: validateEnd, endTime: dataEnd, maxHoldBars: bestParams.maxHoldBars },
    bestGen,
    { candles: testMap, warmupBars: 50 },
  );

  const allOosTrades = [...valResult.trades, ...testResult.trades];
  const aggregateOOS = computeMetrics(allOosTrades, CAPITAL);
  const oosIsRatio = bestTrainSharpe !== 0 ? aggregateOOS.sharpe / bestTrainSharpe : 0;

  // Results
  console.log(formatMetricsDashboard(valResult.metrics, "SR-05 Validation (OOS-1)"));
  console.log();
  console.log(formatMetricsDashboard(testResult.metrics, "SR-05 Test (OOS-2)"));
  console.log();
  console.log(formatMetricsDashboard(aggregateOOS, "SR-05 GARCH Contrarian (Aggregate OOS)"));
  console.log(`\nOOS/IS Ratio:  ${oosIsRatio.toFixed(3)}`);
  console.log(`OOS Trades:    ${aggregateOOS.totalTrades}`);
  console.log(`  Val trades:  ${valResult.metrics.totalTrades}`);
  console.log(`  Test trades: ${testResult.metrics.totalTrades}`);

  // Per-pair breakdown
  const pairCounts = new Map<string, number>();
  for (const t of valResult.trades) pairCounts.set(t.pair, (pairCounts.get(t.pair) ?? 0) + 1);
  if (pairCounts.size > 0) {
    console.log("\nPer-pair OOS-1 trade count:");
    for (const [p, n] of [...pairCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${p.padEnd(10)}: ${n}`);
    }
  }

  // Auto-relax if OOS trades < 100
  if (aggregateOOS.totalTrades < 100) {
    console.log("\n[WARN] OOS trade count < 100. Relaxing entryZ...");
    for (const lowZ of [2.0, 1.5, 1.0]) {
      const relaxed = { ...bestParams, entryZ: lowZ };
      const rg = buildGenerator(relaxed);
      const rv = runBacktest(
        { ...baseConfig, startTime: trainEnd, endTime: validateEnd, maxHoldBars: relaxed.maxHoldBars },
        rg,
        { candles: valMap, warmupBars: 50 },
      );
      const rt = runBacktest(
        { ...baseConfig, startTime: validateEnd, endTime: dataEnd, maxHoldBars: relaxed.maxHoldBars },
        rg,
        { candles: testMap, warmupBars: 50 },
      );
      const oos = computeMetrics([...rv.trades, ...rt.trades], CAPITAL);
      console.log(`  entryZ=${lowZ}: OOS trades=${oos.totalTrades}`);
      if (oos.totalTrades >= 100) {
        console.log(formatMetricsDashboard(oos, `SR-05 Relaxed (entryZ=${lowZ})`));
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error("[SR-05] Fatal error:", e);
  process.exit(1);
});
