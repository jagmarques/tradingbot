import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  SUPERTREND_DAILY_SMA_PERIOD,
  SUPERTREND_DAILY_ADX_MIN,
  SUPERTREND_PERIOD,
  SUPERTREND_MULT,
  SUPERTREND_STOP_ATR_MULT,
  SUPERTREND_REWARD_RISK,
  SUPERTREND_BASE_CONFIDENCE,
  SUPERTREND_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

interface SupertrendResult {
  directions: boolean[]; // true = bullish
}

function computeSupertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
  multiplier: number,
): SupertrendResult | null {
  const n = closes.length;
  if (n < period + 1) return null;

  const trueRanges: number[] = [0];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trueRanges.push(tr);
  }

  const atr: number[] = new Array(n).fill(0);
  let sumTr = 0;
  for (let i = 1; i <= period; i++) sumTr += trueRanges[i];
  atr[period] = sumTr / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trueRanges[i]) / period;
  }

  const directions: boolean[] = new Array(n).fill(true);
  let finalUpperBand = 0;
  let finalLowerBand = 0;

  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    if (i === period) {
      finalUpperBand = basicUpper;
      finalLowerBand = basicLower;
      directions[i] = closes[i] >= finalLowerBand;
      continue;
    }

    const prevClose = closes[i - 1];
    const prevFinalUpper = finalUpperBand;
    const prevFinalLower = finalLowerBand;

    finalUpperBand = basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
    finalLowerBand = basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;

    if (directions[i - 1]) {
      directions[i] = closes[i] >= finalLowerBand;
    } else {
      directions[i] = closes[i] > finalUpperBand;
    }
  }

  return { directions };
}

export async function evaluateSupertrendPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < SUPERTREND_PERIOD + 5) return null;

  const highs4h = candles4h.map((c) => c.high);
  const lows4h = candles4h.map((c) => c.low);
  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const result = computeSupertrend(highs4h, lows4h, closes4h, SUPERTREND_PERIOD, SUPERTREND_MULT);
  if (!result) return null;

  const currIdx = n - 1;
  const prevIdx = n - 2;

  if (currIdx < SUPERTREND_PERIOD || prevIdx < SUPERTREND_PERIOD) return null;

  const currBullish = result.directions[currIdx];
  const prevBullish = result.directions[prevIdx];

  const dailyCandles = await fetchDailyCandles(pair, SUPERTREND_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < SUPERTREND_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, SUPERTREND_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < SUPERTREND_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && !prevBullish && currBullish) direction = "long";
  if (dailyDowntrend && prevBullish && !currBullish) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * SUPERTREND_STOP_ATR_MULT;
  const tpDistance = stopDistance * SUPERTREND_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = SUPERTREND_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "supertrend-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const flipDir = direction === "long" ? "bearish->bullish flip" : "bullish->bearish flip";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Supertrend: ${flipDir}, daily ${trend} (${smaDev}% vs SMA${SUPERTREND_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runSupertrendDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateSupertrendPair(analysis);
      if (decision) {
        console.log(
          `[SupertrendEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SupertrendEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[SupertrendEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
