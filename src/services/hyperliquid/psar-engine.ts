import { PSAR } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  PSAR_DAILY_SMA_PERIOD,
  PSAR_DAILY_ADX_MIN,
  PSAR_STEP,
  PSAR_MAX,
  PSAR_STOP_ATR_MULT,
  PSAR_REWARD_RISK,
  PSAR_BASE_CONFIDENCE,
  PSAR_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

export async function evaluatePsarPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < 30) return null;

  const highs4h = candles4h.map((c) => c.high);
  const lows4h = candles4h.map((c) => c.low);
  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const psarValues = PSAR.calculate({ high: highs4h, low: lows4h, step: PSAR_STEP, max: PSAR_MAX });
  const psarStartIdx = n - psarValues.length;

  const currIdx = n - 1;
  const prevIdx = n - 2;
  if (prevIdx - psarStartIdx < 0) return null;

  const prevSar = psarValues[prevIdx - psarStartIdx];
  const prevClose = closes4h[prevIdx];
  const currSar = psarValues[currIdx - psarStartIdx];
  const currClose = closes4h[currIdx];

  const dailyCandles = await fetchDailyCandles(pair, PSAR_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < PSAR_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, PSAR_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < PSAR_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  // Crossover: SAR flips from above to below close (long) or below to above (short)
  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevSar > prevClose && currSar < currClose) direction = "long";
  if (dailyDowntrend && prevSar < prevClose && currSar > currClose) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * PSAR_STOP_ATR_MULT;
  const tpDistance = stopDistance * PSAR_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = PSAR_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "psar-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const sarPos = direction === "long" ? "below" : "above";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Psar: SAR ${sarPos} close, daily ${trend} (${smaDev}% vs SMA${PSAR_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

  return {
    pair,
    direction,
    entryPrice: markPrice,
    stopLoss,
    takeProfit,
    confidence,
    reasoning,
    regime: analysis.regime,
    suggestedSizeUsd,
    analyzedAt: new Date().toISOString(),
  };
}

export async function runPsarDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluatePsarPair(analysis);
      if (decision) {
        console.log(
          `[PsarEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PsarEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[PsarEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
