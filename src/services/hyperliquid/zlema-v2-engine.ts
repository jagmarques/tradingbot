import { EMA } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  ZLEMAV2_DAILY_SMA_PERIOD,
  ZLEMAV2_DAILY_ADX_MIN,
  ZLEMAV2_FAST,
  ZLEMAV2_SLOW,
  ZLEMAV2_STOP_ATR_MULT,
  ZLEMAV2_REWARD_RISK,
  ZLEMAV2_BASE_CONFIDENCE,
  ZLEMAV2_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

// ZLEMA: lag-corrected EMA (reduces lag vs standard EMA)
function computeZLEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const lagOffset = Math.floor((period - 1) / 2);
  const corrected: number[] = [];
  for (let i = lagOffset; i < n; i++) {
    corrected.push(closes[i] + (closes[i] - closes[i - lagOffset]));
  }
  const emaValues = EMA.calculate({ values: corrected, period });
  const result: (number | null)[] = new Array(n).fill(null);
  // emaValues starts at index (period-1) within corrected, which maps to lagOffset + (period-1) in original
  const emaStartOrigIdx = lagOffset + (period - 1);
  for (let i = 0; i < emaValues.length; i++) {
    const origIdx = emaStartOrigIdx + i;
    if (origIdx < n) result[origIdx] = emaValues[i];
  }
  return result;
}

export async function evaluateZlemaV2Pair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < ZLEMAV2_SLOW * 2 + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;
  const fastArr = computeZLEMA(closes4h, ZLEMAV2_FAST);
  const slowArr = computeZLEMA(closes4h, ZLEMAV2_SLOW);

  const currFast = fastArr[n - 1];
  const currSlow = slowArr[n - 1];
  const prevFast = fastArr[n - 2];
  const prevSlow = slowArr[n - 2];
  if (currFast === null || currSlow === null || prevFast === null || prevSlow === null) return null;

  const dailyCandles = await fetchDailyCandles(pair, ZLEMAV2_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < ZLEMAV2_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, ZLEMAV2_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < ZLEMAV2_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevFast <= prevSlow && currFast > currSlow) direction = "long";
  if (dailyDowntrend && prevFast >= prevSlow && currFast < currSlow) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * ZLEMAV2_STOP_ATR_MULT;
  const tpDistance = stopDistance * ZLEMAV2_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = ZLEMAV2_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "zlemav2-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `ZlemaV2Cross: ZLEMA(${ZLEMAV2_FAST}) ${crossDir} ZLEMA(${ZLEMAV2_SLOW}), daily ${trend} (${smaDev}% vs SMA${ZLEMAV2_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runZlemaV2DecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateZlemaV2Pair(analysis);
      if (decision) {
        console.log(
          `[ZlemaV2Engine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ZlemaV2Engine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[ZlemaV2Engine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
