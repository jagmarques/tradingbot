// DEAD CODE: This engine is no longer called at runtime (removed from scheduler).
// Kept for reference only.
import { EMA } from "technicalindicators";
import { ADX } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";

// Inlined constants (removed from constants.ts)
const ZLEMA1H_HTF_SMA_PERIOD = 75;
const ZLEMA1H_HTF_ADX_MIN = 10;
const ZLEMA1H_FAST = 10;
const ZLEMA1H_SLOW = 21;
const ZLEMA1H_STOP_ATR_MULT = 0.75;
const ZLEMA1H_REWARD_ATR_MULT = 40;
const ZLEMA1H_BASE_CONFIDENCE = 65;

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

export async function evaluateZlema1hPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  // Signal candles: 1h
  const candles1h = analysis.candles?.["1h"];
  if (!candles1h || candles1h.length < ZLEMA1H_SLOW * 2 + 2) return null;

  const closes1h = candles1h.map((c) => c.close);
  const n = closes1h.length;
  const fastArr = computeZLEMA(closes1h, ZLEMA1H_FAST);
  const slowArr = computeZLEMA(closes1h, ZLEMA1H_SLOW);

  const currFast = fastArr[n - 1];
  const currSlow = slowArr[n - 1];
  const prevFast = fastArr[n - 2];
  const prevSlow = slowArr[n - 2];
  if (currFast === null || currSlow === null || prevFast === null || prevSlow === null) return null;

  // HTF filter: 4h candles (SMA75 + ADX > 10)
  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < ZLEMA1H_HTF_SMA_PERIOD + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const sma75 = closes4h.slice(-ZLEMA1H_HTF_SMA_PERIOD).reduce((s, v) => s + v, 0) / ZLEMA1H_HTF_SMA_PERIOD;

  const adxResult = ADX.calculate({
    high: candles4h.map((c) => c.high),
    low: candles4h.map((c) => c.low),
    close: closes4h,
    period: 14,
  });
  const adxVal = adxResult.length > 0 ? adxResult[adxResult.length - 1].adx : null;
  if (adxVal === null || adxVal === undefined || adxVal < ZLEMA1H_HTF_ADX_MIN) return null;

  const htfClose = closes4h[closes4h.length - 1];
  const htfUptrend = htfClose > sma75;
  const htfDowntrend = htfClose < sma75;

  let direction: "long" | "short" | null = null;
  if (htfUptrend && prevFast <= prevSlow && currFast > currSlow) direction = "long";
  if (htfDowntrend && prevFast >= prevSlow && currFast < currSlow) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["1h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * ZLEMA1H_STOP_ATR_MULT;
  const tpDistance = atr * ZLEMA1H_REWARD_ATR_MULT;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = ZLEMA1H_BASE_CONFIDENCE;
  if (adxVal > 30) confidence += 10;
  else if (adxVal > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((htfClose - sma75) / sma75 * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Zlema1hCross: ZLEMA(${ZLEMA1H_FAST}) ${crossDir} ZLEMA(${ZLEMA1H_SLOW}), 4h ${trend} (${smaDev}% vs SMA75, ADX ${adxVal.toFixed(0)})`;

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

export async function runZlema1hDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateZlema1hPair(analysis);
      if (decision) {
        console.log(
          `[Zlema1hEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Zlema1hEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[Zlema1hEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
