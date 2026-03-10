// DEAD CODE: This engine is no longer called at runtime (removed from scheduler).
// Kept for reference only.
import { ADX } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";

// Inlined constants (removed from constants.ts)
const HMA1H_HTF_SMA_PERIOD = 75;
const HMA1H_HTF_ADX_MIN = 10;
const HMA1H_FAST = 11;
const HMA1H_SLOW = 32;
const HMA1H_STOP_ATR_MULT = 0.75;
const HMA1H_REWARD_ATR_MULT = 50;
const HMA1H_BASE_CONFIDENCE = 65;

function computeWMA(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const result: (number | null)[] = new Array(n).fill(null);
  const weightSum = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - period + 1 + j] * (j + 1);
    result[i] = sum / weightSum;
  }
  return result;
}

// HMA(n) = WMA(2*WMA(n/2) - WMA(n), sqrt(n))
function computeHMA(closes: number[], period: number): (number | null)[] {
  const halfPeriod = Math.max(2, Math.floor(period / 2));
  const sqrtPeriod = Math.max(2, Math.round(Math.sqrt(period)));
  const wmaHalf = computeWMA(closes, halfPeriod);
  const wmaFull = computeWMA(closes, period);
  const diffStartIdx = period - 1;
  const diff: number[] = [];
  for (let i = diffStartIdx; i < closes.length; i++) {
    const h = wmaHalf[i];
    const f = wmaFull[i];
    diff.push(h === null || f === null ? 0 : 2 * h - f);
  }
  const hmaOnDiff = computeWMA(diff, sqrtPeriod);
  const result: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < hmaOnDiff.length; i++) {
    const origIdx = diffStartIdx + i;
    if (origIdx < closes.length) result[origIdx] = hmaOnDiff[i];
  }
  return result;
}

export async function evaluateHMA1hPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  // Signal candles: 1h
  const candles1h = analysis.candles?.["1h"];
  if (!candles1h || candles1h.length < HMA1H_SLOW + 10) return null;

  const closes1h = candles1h.map((c) => c.close);
  const n = closes1h.length;

  const fastArr = computeHMA(closes1h, HMA1H_FAST);
  const slowArr = computeHMA(closes1h, HMA1H_SLOW);

  const prevFast = fastArr[n - 2];
  const prevSlow = slowArr[n - 2];
  const currFast = fastArr[n - 1];
  const currSlow = slowArr[n - 1];
  if (prevFast === null || prevSlow === null || currFast === null || currSlow === null) return null;

  // HTF filter: 4h candles (SMA75 + ADX > 10)
  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < HMA1H_HTF_SMA_PERIOD + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const sma75 = closes4h.slice(-HMA1H_HTF_SMA_PERIOD).reduce((s, v) => s + v, 0) / HMA1H_HTF_SMA_PERIOD;

  const adxResult = ADX.calculate({
    high: candles4h.map((c) => c.high),
    low: candles4h.map((c) => c.low),
    close: closes4h,
    period: 14,
  });
  const adxVal = adxResult.length > 0 ? adxResult[adxResult.length - 1].adx : null;
  if (adxVal === null || adxVal === undefined || adxVal < HMA1H_HTF_ADX_MIN) return null;

  const htfClose = closes4h[closes4h.length - 1];
  const htfUptrend = htfClose > sma75;
  const htfDowntrend = htfClose < sma75;

  let direction: "long" | "short" | null = null;
  if (htfUptrend && prevFast <= prevSlow && currFast > currSlow) direction = "long";
  if (htfDowntrend && prevFast >= prevSlow && currFast < currSlow) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["1h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * HMA1H_STOP_ATR_MULT;
  const tpDistance = atr * HMA1H_REWARD_ATR_MULT;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = HMA1H_BASE_CONFIDENCE;
  if (adxVal > 30) confidence += 10;
  else if (adxVal > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((htfClose - sma75) / sma75 * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `HMA1h: HMA(${HMA1H_FAST}) ${crossDir} HMA(${HMA1H_SLOW}), 4h ${trend} (${smaDev}% vs SMA75, ADX ${adxVal.toFixed(0)})`;

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

export async function runHMA1hDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateHMA1hPair(analysis);
      if (decision) {
        console.log(
          `[HMA1hEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[HMA1hEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[HMA1hEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
