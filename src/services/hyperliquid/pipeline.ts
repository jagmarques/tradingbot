import { fetchAllCandles } from "./candles.js";
import { fetchMarketContext } from "./market-data.js";
import { computeIndicators } from "./indicators.js";
import { classifyRegime } from "./regime.js";
import type { CandleInterval, PairAnalysis } from "./types.js";
import {
  QUANT_TRADING_PAIRS,
  QUANT_CANDLE_LOOKBACK_COUNT,
  QUANT_PIPELINE_TIMEOUT_MS,
} from "../../config/constants.js";

const REGIME_INTERVAL: CandleInterval = "1h";

export async function analyzePair(pair: string): Promise<PairAnalysis> {
  const fetchTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Pipeline timeout for ${pair}`)), QUANT_PIPELINE_TIMEOUT_MS),
  );

  const analysis = await Promise.race([
    _analyzePairInternal(pair),
    fetchTimeout,
  ]);

  return analysis;
}

async function _analyzePairInternal(pair: string): Promise<PairAnalysis> {
  // Fetch candles for all intervals and market context in parallel
  const [candlesByInterval, marketCtx] = await Promise.all([
    fetchAllCandles(pair, QUANT_CANDLE_LOOKBACK_COUNT),
    fetchMarketContext(pair),
  ]);

  // Compute indicators for each interval
  const indicatorsByInterval: Record<CandleInterval, ReturnType<typeof computeIndicators>> = {
    "15m": computeIndicators(candlesByInterval["15m"]),
    "1h": computeIndicators(candlesByInterval["1h"]),
    "4h": computeIndicators(candlesByInterval["4h"]),
  };

  // Classify regime from 1h indicators (most balanced timeframe)
  const regimeIndicators = indicatorsByInterval[REGIME_INTERVAL];
  const regime = classifyRegime(regimeIndicators, `${pair} ${REGIME_INTERVAL}`);

  console.log(
    `[Pipeline] ${pair}: regime=${regime}, mark=$${marketCtx.markPrice.toFixed(2)}, oi=${marketCtx.openInterest.toFixed(0)}, funding=${(marketCtx.fundingRate * 100).toFixed(4)}%`,
  );

  return {
    pair,
    interval: REGIME_INTERVAL,
    indicators: regimeIndicators,
    regime,
    analyzedAt: new Date().toISOString(),
  };
}

export async function runMarketDataPipeline(): Promise<PairAnalysis[]> {
  console.log(`[Pipeline] Starting market data pipeline for ${QUANT_TRADING_PAIRS.join(", ")}`);
  const results: PairAnalysis[] = [];

  // Sequential processing to avoid rate limiting
  for (const pair of QUANT_TRADING_PAIRS) {
    try {
      const analysis = await analyzePair(pair);
      results.push(analysis);
      console.log(`[Pipeline] ${pair} complete: regime=${analysis.regime}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Failed to analyze ${pair}: ${msg}`);
    }
  }

  console.log(`[Pipeline] Pipeline complete: ${results.length}/${QUANT_TRADING_PAIRS.length} pairs analyzed`);
  return results;
}
