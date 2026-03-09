import { EMA } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  ZLEMA_DAILY_SMA_PERIOD,
  ZLEMA_DAILY_ADX_MIN,
  ZLEMA_FAST,
  ZLEMA_SLOW,
  ZLEMA_STOP_ATR_MULT,
  ZLEMA_REWARD_RISK,
  ZLEMA_BASE_CONFIDENCE,
  ZLEMA_DAILY_LOOKBACK_DAYS,
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

export async function evaluateZlemaPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < ZLEMA_SLOW * 2 + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;
  const fastArr = computeZLEMA(closes4h, ZLEMA_FAST);
  const slowArr = computeZLEMA(closes4h, ZLEMA_SLOW);

  const currFast = fastArr[n - 1];
  const currSlow = slowArr[n - 1];
  const prevFast = fastArr[n - 2];
  const prevSlow = slowArr[n - 2];
  if (currFast === null || currSlow === null || prevFast === null || prevSlow === null) return null;

  const dailyCandles = await fetchDailyCandles(pair, ZLEMA_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < ZLEMA_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, ZLEMA_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < ZLEMA_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevFast <= prevSlow && currFast > currSlow) direction = "long";
  if (dailyDowntrend && prevFast >= prevSlow && currFast < currSlow) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * ZLEMA_STOP_ATR_MULT;
  const tpDistance = stopDistance * ZLEMA_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = ZLEMA_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "zlema-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `ZlemaCross: ZLEMA(${ZLEMA_FAST}) ${crossDir} ZLEMA(${ZLEMA_SLOW}), daily ${trend} (${smaDev}% vs SMA${ZLEMA_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runZlemaDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateZlemaPair(analysis);
      if (decision) {
        console.log(
          `[ZlemaEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ZlemaEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[ZlemaEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
