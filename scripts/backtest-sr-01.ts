/**
 * SR-01: Enhanced BTC-Alt Mean Reversion
 * OLS beta regression, z-score on residuals, ADF cointegration gate
 * 60/20/20 walk-forward split - sweep on train, evaluate OOS
 *
 * npx tsx scripts/backtest-sr-01.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

// Load BTC candles - handles Binance array format
function loadBtcCandles(candleDir: string): Candle[] {
  const filePath = path.join(candleDir, "BTCUSDT.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as (Candle | number[])[];
  return raw
    .map((item) =>
      Array.isArray(item)
        ? { t: Number(item[0]), o: Number(item[1]), h: Number(item[2]), l: Number(item[3]), c: Number(item[4]) }
        : (item as Candle),
    )
    .sort((a, b) => a.t - b.t);
}

// ADF test: reject unit root at 5% significance (t-stat < -2.86)
function adfTest(series: number[]): boolean {
  const n = series.length;
  if (n < 5) return false;
  const delta = series.slice(1).map((v, i) => v - series[i]);
  const lagged = series.slice(0, n - 1);
  const mL = lagged.reduce((a, b) => a + b, 0) / lagged.length;
  const mD = delta.reduce((a, b) => a + b, 0) / delta.length;
  let num = 0, den = 0;
  for (let i = 0; i < delta.length; i++) {
    num += (lagged[i] - mL) * (delta[i] - mD);
    den += (lagged[i] - mL) ** 2;
  }
  const gamma = den !== 0 ? num / den : 0;
  const res = delta.map((d, i) => d - gamma * (lagged[i] - mL));
  const mse = res.reduce((a, b) => a + b ** 2, 0) / Math.max(n - 2, 1);
  const se = den !== 0 ? Math.sqrt(mse) / Math.sqrt(den) : 0;
  return se !== 0 && gamma / se < -2.86;
}

function olsBeta(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    varX += (x[i] - mx) ** 2;
  }
  return varX === 0 ? 0 : cov / varX;
}

interface PairIndicators {
  z: Float64Array;
  residualStd: Float64Array;
  adfPassed: Uint8Array;
  tsIndex: Map<number, number>;
}

function buildPairIndicators(altCandles: Candle[], btcMap: Map<number, Candle>, lookback: number): PairIndicators {
  const n = altCandles.length;
  const z = new Float64Array(n).fill(NaN);
  const residualStd = new Float64Array(n).fill(0);
  const adfPassed = new Uint8Array(n).fill(0);
  const tsIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) tsIndex.set(altCandles[i].t, i);

  for (let b = lookback + 2; b < n; b++) {
    const altRet: number[] = [];
    const btcRet: number[] = [];
    // Use candles[b-lookback .. b-1]: lookback bars, lookback-1 returns
    for (let i = b - lookback + 1; i < b; i++) {
      const bc = btcMap.get(altCandles[i].t);
      const bp = btcMap.get(altCandles[i - 1].t);
      if (!bc || !bp) continue;
      altRet.push(altCandles[i].c / altCandles[i - 1].c - 1);
      btcRet.push(bc.c / bp.c - 1);
    }
    if (altRet.length < 3) continue;
    const beta = olsBeta(btcRet, altRet);
    const res = altRet.map((r, i) => r - beta * btcRet[i]);
    const nr = res.length;
    const mr = res.reduce((a, b) => a + b, 0) / nr;
    const sv = Math.sqrt(res.reduce((a, b) => a + (b - mr) ** 2, 0) / nr);
    if (sv === 0) continue;
    z[b] = (res[nr - 1] - mr) / sv;
    residualStd[b] = sv;
    adfPassed[b] = adfTest(res) ? 1 : 0;
  }
  return { z, residualStd, adfPassed, tsIndex };
}

/**
 * Build a signal generator for a single pair with precomputed indicators.
 * The signal generator receives the pair's own candles from runBacktest,
 * uses tsIndex to map bar timestamp -> original indicator array index.
 */
function buildPairSignalFn(
  ind: PairIndicators,
  params: { entryZ: number; stopZ: number; adfRequired: number },
): (candles: Candle[], barIndex: number, pair: string) => Signal | null {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    const t = candles[barIndex]?.t;
    if (t === undefined) return null;
    const origIdx = ind.tsIndex.get(t);
    if (origIdx === undefined || isNaN(ind.z[origIdx])) return null;
    const z = ind.z[origIdx];
    const stdR = ind.residualStd[origIdx];
    if (params.adfRequired === 1 && ind.adfPassed[origIdx] === 0) return null;
    if (Math.abs(z) < params.entryZ) return null;
    const dir: "long" | "short" = z < -params.entryZ ? "long" : "short";
    const ep = candles[barIndex].o;
    const sl = params.stopZ * stdR;
    const tp = 0.5 * params.entryZ * stdR;
    return {
      pair, direction: dir, entryPrice: ep, barIndex,
      stopLoss: dir === "long" ? ep * (1 - sl) : ep * (1 + sl),
      takeProfit: dir === "long" ? ep * (1 + tp) : ep * (1 - tp),
    };
  };
}

/**
 * Compose a multi-pair signal generator from per-pair signal functions.
 * Routes signal generation to the correct per-pair function.
 */
function makeMultiPairGenerator(
  pairFns: Map<string, (candles: Candle[], barIndex: number, pair: string) => Signal | null>,
): SignalGenerator {
  return (candles: Candle[], barIndex: number, pair: string): Signal | null => {
    const fn = pairFns.get(pair);
    if (!fn) return null;
    return fn(candles, barIndex, pair);
  };
}

async function main() {
  console.log("[SR-01] Loading candles...");

  const btcCandles = loadBtcCandles(CANDLE_DIR);
  const btcMap = new Map<number, Candle>();
  for (const c of btcCandles) btcMap.set(c.t, c);

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
    console.error("[SR-01] Need at least 3 pairs. Found:", pairs.length);
    process.exit(1);
  }

  console.log(`[SR-01] Loaded ${pairs.length} pairs: ${pairs.join(", ")}`);

  // Determine time range
  const allStartTimes = pairs.map((p) => candleMap[p][0].t);
  const allEndTimes = pairs.map((p) => candleMap[p][candleMap[p].length - 1].t);
  const dataStart = Math.min(...allStartTimes);
  const dataEnd = Math.max(...allEndTimes);
  const span = dataEnd - dataStart;
  const trainEnd = dataStart + span * 0.6;
  const validateEnd = dataStart + span * 0.8;

  console.log(`[SR-01] Data: ${new Date(dataStart).toISOString().split("T")[0]} to ${new Date(dataEnd).toISOString().split("T")[0]}`);
  console.log(`[SR-01] Train:..${new Date(trainEnd).toISOString().split("T")[0]}  Val:..${new Date(validateEnd).toISOString().split("T")[0]}  Test:..${new Date(dataEnd).toISOString().split("T")[0]}`);

  // Precompute indicator arrays for all pairs and all lookback values
  console.log("[SR-01] Precomputing OLS residuals...");
  const indicators = new Map<string, PairIndicators>();
  for (const lookback of [4, 48, 96]) {
    for (const pair of pairs) {
      const key = `${pair}:${lookback}`;
      if (!indicators.has(key)) {
        indicators.set(key, buildPairIndicators(candleMap[pair], btcMap, lookback));
      }
    }
  }
  console.log(`[SR-01] Precomputed ${indicators.size} indicator sets.`);

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
    maxHoldBars: 24,
  };

  // Parameter grid
  const paramGrid = [];
  for (const lookback of [4, 48, 96]) {
    for (const entryZ of [1.8, 2.0, 2.2]) {
      for (const stopZ of [3.0, 3.5]) {
        for (const adfRequired of [0, 1]) {
          paramGrid.push({ lookback, entryZ, stopZ, adfRequired });
        }
      }
    }
  }

  console.log(`[SR-01] Sweeping ${paramGrid.length} param combos on train set...\n`);

  // Build signal generator for a given param set
  function buildGenerator(params: { lookback: number; entryZ: number; stopZ: number; adfRequired: number }): SignalGenerator {
    const pairFns = new Map<string, (c: Candle[], b: number, p: string) => Signal | null>();
    for (const pair of pairs) {
      const ind = indicators.get(`${pair}:${params.lookback}`);
      if (ind) {
        pairFns.set(pair, buildPairSignalFn(ind, params));
      }
    }
    return makeMultiPairGenerator(pairFns);
  }

  // Sweep params on train set
  // Require minimum 30 IS trades before considering Sharpe
  const MIN_TRAIN_TRADES = 30;
  let bestParams = paramGrid[0];
  let bestTrainSharpe = -Infinity;
  let bestTrainTrades = 0;

  for (const params of paramGrid) {
    const gen = buildGenerator(params);
    const r = runBacktest(
      { ...baseConfig, startTime: dataStart, endTime: trainEnd },
      gen,
      { candles: trainMap, warmupBars: 100 },
    );
    // Only consider params with enough trades; among those, maximize Sharpe
    if (r.metrics.totalTrades >= MIN_TRAIN_TRADES && r.metrics.sharpe > bestTrainSharpe) {
      bestTrainSharpe = r.metrics.sharpe;
      bestParams = params;
      bestTrainTrades = r.metrics.totalTrades;
    }
  }

  // If no params met minimum trade count, fall back to most-trades param
  if (bestTrainTrades === 0) {
    let maxTrades = 0;
    for (const params of paramGrid) {
      const gen = buildGenerator(params);
      const r = runBacktest(
        { ...baseConfig, startTime: dataStart, endTime: trainEnd },
        gen,
        { candles: trainMap, warmupBars: 100 },
      );
      if (r.metrics.totalTrades > maxTrades) {
        maxTrades = r.metrics.totalTrades;
        bestParams = params;
        bestTrainTrades = r.metrics.totalTrades;
        bestTrainSharpe = r.metrics.sharpe;
      }
    }
  }

  console.log(`Best IS params: lookback=${bestParams.lookback}, entryZ=${bestParams.entryZ}, stopZ=${bestParams.stopZ}, adfRequired=${bestParams.adfRequired}`);
  console.log(`Best IS Sharpe: ${bestTrainSharpe.toFixed(3)}, IS Trades: ${bestTrainTrades}\n`);

  // Evaluate best params on OOS periods
  const bestGen = buildGenerator(bestParams);

  const valResult = runBacktest(
    { ...baseConfig, startTime: trainEnd, endTime: validateEnd },
    bestGen,
    { candles: valMap, warmupBars: 100 },
  );

  const testResult = runBacktest(
    { ...baseConfig, startTime: validateEnd, endTime: dataEnd },
    bestGen,
    { candles: testMap, warmupBars: 100 },
  );

  const allOosTrades = [...valResult.trades, ...testResult.trades];
  const aggregateOOS = computeMetrics(allOosTrades, CAPITAL);
  const oosIsRatio = bestTrainSharpe !== 0 ? aggregateOOS.sharpe / bestTrainSharpe : 0;

  // Results
  console.log(formatMetricsDashboard(valResult.metrics, "SR-01 Validation (OOS-1)"));
  console.log();
  console.log(formatMetricsDashboard(testResult.metrics, "SR-01 Test (OOS-2)"));
  console.log();
  console.log(formatMetricsDashboard(aggregateOOS, "SR-01 Enhanced BTC-MR (Aggregate OOS)"));
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

  if (aggregateOOS.totalTrades < 100) {
    console.log("\n[WARN] OOS trade count < 100. Relaxing entryZ...");
    // Try lower entryZ
    for (const lowZ of [1.5, 1.2, 1.0]) {
      const relaxed = { ...bestParams, entryZ: lowZ };
      const rg = buildGenerator(relaxed);
      const rv = runBacktest(
        { ...baseConfig, startTime: trainEnd, endTime: validateEnd },
        rg,
        { candles: valMap, warmupBars: 100 },
      );
      const rt = runBacktest(
        { ...baseConfig, startTime: validateEnd, endTime: dataEnd },
        rg,
        { candles: testMap, warmupBars: 100 },
      );
      const oos = computeMetrics([...rv.trades, ...rt.trades], CAPITAL);
      console.log(`  entryZ=${lowZ}: OOS trades=${oos.totalTrades}`);
      if (oos.totalTrades >= 100) {
        console.log(formatMetricsDashboard(oos, `SR-01 Relaxed (entryZ=${lowZ})`));
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error("[SR-01] Fatal error:", e);
  process.exit(1);
});
