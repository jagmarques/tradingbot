import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  BREAKOUT_LOOKBACK_BARS,
  BREAKOUT_STOP_ATR_MULT,
  BREAKOUT_REWARD_RISK_RATIO,
  BREAKOUT_VOLUME_THRESHOLD,
  BREAKOUT_STAGNATION_BARS,
  BREAKOUT_ADX_MIN,
  BREAKOUT_BASE_CONFIDENCE,
} from "../../config/constants.js";

export function evaluateBreakoutPair(analysis: PairAnalysis): QuantAIDecision | null {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < BREAKOUT_LOOKBACK_BARS + 2) return null;

  const ind4h = analysis.indicators["4h"];
  const adx = ind4h.adx;

  // ADX filter: must have trend momentum
  if (adx === null || adx < BREAKOUT_ADX_MIN) return null;

  // Volume filter: current bar must have a spike vs 20-bar average
  const n = candles4h.length;
  if (n < 20) return null;
  const volumes = candles4h.map((c) => c.volume);
  const volAvg = volumes.slice(n - 20).reduce((s, v) => s + v, 0) / 20;
  const curVol = volumes[n - 1];
  if (volAvg <= 0 || curVol / volAvg < BREAKOUT_VOLUME_THRESHOLD) return null;

  // Channel high/low from previous lookback bars (exclude current bar)
  const lookbackStart = n - 1 - BREAKOUT_LOOKBACK_BARS;
  if (lookbackStart < 0) return null;
  let channelHigh = -Infinity;
  let channelLow = Infinity;
  for (let k = lookbackStart; k < n - 1; k++) {
    if (candles4h[k].high > channelHigh) channelHigh = candles4h[k].high;
    if (candles4h[k].low < channelLow) channelLow = candles4h[k].low;
  }

  const lastClose = candles4h[n - 1].close;
  let direction: "long" | "short" | null = null;
  if (lastClose > channelHigh) direction = "long";
  else if (lastClose < channelLow) direction = "short";

  if (direction === null) return null;

  const atr = ind4h.atr ?? markPrice * 0.02;
  const stopDistance = atr * BREAKOUT_STOP_ATR_MULT;
  const tpDistance = stopDistance * BREAKOUT_REWARD_RISK_RATIO;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = BREAKOUT_BASE_CONFIDENCE;
  // ADX strength booster
  if (adx > 30) confidence += 10;
  else if (adx > 25) confidence += 5;
  // Volume spike booster
  if (volAvg > 0 && curVol / volAvg > 3) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const breakoutPct = direction === "long"
    ? ((lastClose - channelHigh) / channelHigh * 100).toFixed(2)
    : ((channelLow - lastClose) / channelLow * 100).toFixed(2);

  const reasoning = `Breakout: ${direction} breakout ${breakoutPct}% beyond ${BREAKOUT_LOOKBACK_BARS}-bar channel, ADX ${adx.toFixed(0)}, vol ${(curVol / volAvg).toFixed(1)}x avg, stag ${BREAKOUT_STAGNATION_BARS * 4}h`;

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

export function runBreakoutDecisionEngine(analyses: PairAnalysis[]): QuantAIDecision[] {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = evaluateBreakoutPair(analysis);
      if (decision) {
        console.log(
          `[BreakoutEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BreakoutEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[BreakoutEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
