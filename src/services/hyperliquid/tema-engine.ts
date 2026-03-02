import { EMA } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  TEMA_DAILY_SMA_PERIOD,
  TEMA_DAILY_ADX_MIN,
  TEMA_FAST,
  TEMA_SLOW,
  TEMA_STOP_ATR_MULT,
  TEMA_REWARD_RISK,
  TEMA_BASE_CONFIDENCE,
  TEMA_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

// TEMA(n) = 3*EMA(n) - 3*EMA(EMA(n)) + EMA(EMA(EMA(n)))
function computeTEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const ema1 = EMA.calculate({ values: closes, period });
  const ema2 = EMA.calculate({ values: ema1, period });
  const ema3 = EMA.calculate({ values: ema2, period });
  const result: (number | null)[] = new Array(n).fill(null);
  const offset = (period - 1) * 3;
  ema3.forEach((e3, i) => {
    const idx = i + offset;
    if (idx >= n) return;
    const e2 = ema2[i + (period - 1)];
    const e1 = ema1[i + (period - 1) * 2];
    if (e2 === undefined || e1 === undefined) return;
    result[idx] = 3 * e1 - 3 * e2 + e3;
  });
  return result;
}

export async function evaluateTEMAPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < TEMA_SLOW * 3 + 5) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const fastArr = computeTEMA(closes4h, TEMA_FAST);
  const slowArr = computeTEMA(closes4h, TEMA_SLOW);

  const currFast = fastArr[n - 1], prevFast = fastArr[n - 2];
  const currSlow = slowArr[n - 1], prevSlow = slowArr[n - 2];
  if (currFast === null || prevFast === null || currSlow === null || prevSlow === null) return null;

  const dailyCandles = await fetchDailyCandles(pair, TEMA_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < TEMA_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, TEMA_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < TEMA_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevFast <= prevSlow && currFast > currSlow) direction = "long";
  if (dailyDowntrend && prevFast >= prevSlow && currFast < currSlow) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * TEMA_STOP_ATR_MULT;
  const tpDistance = stopDistance * TEMA_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = TEMA_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "tema-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `TEMA: TEMA(${TEMA_FAST}) crossed ${crossDir} TEMA(${TEMA_SLOW}), daily ${trend} (${smaDev}% vs SMA${TEMA_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runTEMADecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateTEMAPair(analysis);
      if (decision) {
        console.log(
          `[TEMAEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TEMAEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[TEMAEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
