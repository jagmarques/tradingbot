import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  AROON_DAILY_SMA_PERIOD,
  AROON_DAILY_ADX_MIN,
  AROON_PERIOD,
  AROON_STOP_ATR_MULT,
  AROON_REWARD_RISK,
  AROON_BASE_CONFIDENCE,
  AROON_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

interface Candle4h {
  high: number;
  low: number;
  close: number;
}

function computeAroon(candles: Candle4h[], period: number, endIdx: number): { up: number; down: number } | null {
  if (endIdx < period) return null;
  const slice = candles.slice(endIdx - period, endIdx + 1);
  let highestIdx = 0;
  let lowestIdx = 0;
  for (let i = 1; i <= period; i++) {
    if (slice[i].high >= slice[highestIdx].high) highestIdx = i;
    if (slice[i].low <= slice[lowestIdx].low) lowestIdx = i;
  }
  const barsSinceHighest = period - highestIdx;
  const barsSinceLowest = period - lowestIdx;
  return {
    up: ((period - barsSinceHighest) / period) * 100,
    down: ((period - barsSinceLowest) / period) * 100,
  };
}

export async function evaluateAroonPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < AROON_PERIOD + 5) return null;

  const n = candles4h.length;
  const prev = computeAroon(candles4h, AROON_PERIOD, n - 2);
  const curr = computeAroon(candles4h, AROON_PERIOD, n - 1);
  if (prev === null || curr === null) return null;

  const dailyCandles = await fetchDailyCandles(pair, AROON_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < AROON_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, AROON_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < AROON_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prev.up <= prev.down && curr.up > curr.down) direction = "long";
  if (dailyDowntrend && prev.down <= prev.up && curr.down > curr.up) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * AROON_STOP_ATR_MULT;
  const tpDistance = stopDistance * AROON_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = AROON_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "aroon-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "Up crosses above Down" : "Down crosses above Up";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Aroon: ${crossDir} (Up ${curr.up.toFixed(0)}, Down ${curr.down.toFixed(0)}), daily ${trend} (${smaDev}% vs SMA${AROON_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runAroonDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateAroonPair(analysis);
      if (decision) {
        console.log(
          `[AroonEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AroonEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[AroonEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
