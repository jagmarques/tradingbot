import { MACD } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  MACD_CROSS_FAST,
  MACD_CROSS_SLOW,
  MACD_CROSS_SIGNAL,
  MACD_CROSS_DAILY_SMA_PERIOD,
  MACD_CROSS_DAILY_ADX_MIN,
  MACD_CROSS_STOP_ATR_MULT,
  MACD_CROSS_REWARD_RISK,
  MACD_CROSS_BASE_CONFIDENCE,
  MACD_CROSS_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

export async function evaluateMacdCrossPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < MACD_CROSS_SLOW + MACD_CROSS_SIGNAL + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const macdResult = MACD.calculate({
    values: closes4h,
    fastPeriod: MACD_CROSS_FAST,
    slowPeriod: MACD_CROSS_SLOW,
    signalPeriod: MACD_CROSS_SIGNAL,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const macdStartIdx = n - macdResult.length;
  const currMacdIdx = n - 1;
  const prevMacdIdx = n - 2;
  const cI = currMacdIdx - macdStartIdx;
  const pI = prevMacdIdx - macdStartIdx;
  if (cI < 0 || pI < 0) return null;

  const currMacd = macdResult[cI].MACD;
  const currSignal = macdResult[cI].signal;
  const prevMacd = macdResult[pI].MACD;
  const prevSignal = macdResult[pI].signal;
  if (currMacd == null || currSignal == null || prevMacd == null || prevSignal == null) return null;

  const dailyCandles = await fetchDailyCandles(pair, MACD_CROSS_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < MACD_CROSS_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, MACD_CROSS_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < MACD_CROSS_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevMacd <= prevSignal && currMacd > currSignal) direction = "long";
  if (dailyDowntrend && prevMacd >= prevSignal && currMacd < currSignal) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * MACD_CROSS_STOP_ATR_MULT;
  const tpDistance = stopDistance * MACD_CROSS_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = MACD_CROSS_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "macd-cross-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `MacdCross: MACD(${MACD_CROSS_FAST}/${MACD_CROSS_SLOW}) crossed ${crossDir} signal(${MACD_CROSS_SIGNAL}), daily ${trend} (${smaDev}% vs SMA${MACD_CROSS_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runMacdCrossDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateMacdCrossPair(analysis);
      if (decision) {
        console.log(
          `[MacdCrossEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MacdCrossEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[MacdCrossEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
