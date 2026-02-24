import { fetchAllCandles } from "./candles.js";
import { fetchMarketContext, fetchBinanceLongShortRatio, fetchOrderbookDepth, computeOIDelta } from "./market-data.js";
import { computeIndicators } from "./indicators.js";
import { classifyRegime } from "./regime.js";
import type { CandleInterval, PairAnalysis, MicrostructureData } from "./types.js";
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
  const [candlesByInterval, marketCtx] = await Promise.all([
    fetchAllCandles(pair, QUANT_CANDLE_LOOKBACK_COUNT),
    fetchMarketContext(pair),
  ]);

  const indicatorsByInterval: Record<CandleInterval, ReturnType<typeof computeIndicators>> = {
    "15m": computeIndicators(candlesByInterval["15m"]),
    "1h": computeIndicators(candlesByInterval["1h"]),
    "4h": computeIndicators(candlesByInterval["4h"]),
  };

  // Classify regime from 1h indicators (most balanced timeframe)
  const regimeIndicators = indicatorsByInterval[REGIME_INTERVAL];
  const regime = classifyRegime(regimeIndicators, `${pair} ${REGIME_INTERVAL}`);

  // Fetch microstructure data (non-critical, failures return null)
  const [longShortRatio, orderbookImbalance] = await Promise.all([
    fetchBinanceLongShortRatio(pair),
    fetchOrderbookDepth(pair, marketCtx.markPrice),
  ]);

  const oiResult = computeOIDelta(pair, marketCtx.openInterest);

  const microstructure: MicrostructureData = {
    longShortRatio,
    orderbookImbalance,
    oiDelta: oiResult?.oiDelta ?? null,
    oiDeltaPct: oiResult?.oiDeltaPct ?? null,
  };

  console.log(
    `[Pipeline] ${pair}: regime=${regime}, mark=$${marketCtx.markPrice.toFixed(2)}, ` +
    `oi=${marketCtx.openInterest.toFixed(0)}, funding=${(marketCtx.fundingRate * 100).toFixed(4)}%, ` +
    `ls_ratio=${longShortRatio?.global?.toFixed(2) ?? 'n/a'}, ` +
    `ob_imbal=${orderbookImbalance?.imbalanceRatio?.toFixed(3) ?? 'n/a'}, ` +
    `oi_delta=${oiResult?.oiDeltaPct?.toFixed(2) ?? 'first_cycle'}%`,
  );

  return {
    pair,
    indicators: indicatorsByInterval,
    candles: candlesByInterval,
    regime,
    fundingRate: marketCtx.fundingRate,
    openInterest: marketCtx.openInterest,
    markPrice: marketCtx.markPrice,
    oraclePrice: marketCtx.oraclePrice,
    dayVolume: marketCtx.dayVolume,
    analyzedAt: new Date().toISOString(),
    microstructure,
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
