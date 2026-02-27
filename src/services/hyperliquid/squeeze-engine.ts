import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  SQUEEZE_BB_PERIOD,
  SQUEEZE_PERCENTILE,
  SQUEEZE_STOP_ATR_MULT,
  SQUEEZE_REWARD_RISK_RATIO,
  SQUEEZE_VOLUME_THRESHOLD,
  SQUEEZE_STAGNATION_BARS,
  SQUEEZE_BASE_CONFIDENCE,
  SQUEEZE_PERCENTILE_WINDOW,
} from "../../config/constants.js";

export function evaluateSqueezePair(analysis: PairAnalysis): QuantAIDecision | null {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < SQUEEZE_PERCENTILE_WINDOW + SQUEEZE_BB_PERIOD + 2) return null;

  const ind4h = analysis.indicators["4h"];
  const n = candles4h.length;

  // Volume filter first (cheap)
  const volumes = candles4h.map((c) => c.volume);
  const volAvg = volumes.slice(n - 20).reduce((s, v) => s + v, 0) / 20;
  const curVol = volumes[n - 1];
  if (volAvg <= 0 || curVol / volAvg < SQUEEZE_VOLUME_THRESHOLD) return null;

  // Compute BB width for current bar and percentile window using closes
  const closes = candles4h.map((c) => c.close);

  // Compute BB for bars in the percentile window to get width history
  const bbWidths: number[] = [];
  for (let i = n - SQUEEZE_PERCENTILE_WINDOW - 1; i < n; i++) {
    if (i < SQUEEZE_BB_PERIOD - 1) continue;
    const slice = closes.slice(i - SQUEEZE_BB_PERIOD + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / SQUEEZE_BB_PERIOD;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / SQUEEZE_BB_PERIOD;
    const std = Math.sqrt(variance);
    // BB upper = mean + 2*std, lower = mean - 2*std, width = (upper-lower)/middle = 4*std/mean
    const bbWidth = mean > 0 ? (4 * std) / mean : 0;
    if (bbWidth > 0) bbWidths.push(bbWidth);
  }
  if (bbWidths.length < 20) return null;

  const currentWidth = bbWidths[bbWidths.length - 1];

  // Compute squeeze: current width below squeezePercentile% of recent widths
  const historicalWidths = bbWidths.slice(0, -1); // exclude current bar
  const sorted = [...historicalWidths].sort((a, b) => a - b);
  const thresholdIdx = Math.floor((SQUEEZE_PERCENTILE / 100) * sorted.length);
  const widthThreshold = sorted[Math.min(thresholdIdx, sorted.length - 1)];
  const squeezeActive = currentWidth <= widthThreshold;
  if (!squeezeActive) return null;

  // Current BB upper/lower from pipeline
  const bb = ind4h.bollingerBands;
  if (!bb || bb.upper === null || bb.lower === null) return null;

  const lastClose = closes[n - 1];
  let direction: "long" | "short" | null = null;
  if (lastClose > bb.upper) direction = "long";
  else if (lastClose < bb.lower) direction = "short";

  if (direction === null) return null;

  const atr = ind4h.atr ?? markPrice * 0.02;
  const stopDistance = atr * SQUEEZE_STOP_ATR_MULT;
  const tpDistance = stopDistance * SQUEEZE_REWARD_RISK_RATIO;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = SQUEEZE_BASE_CONFIDENCE;
  // Tighter squeeze = stronger signal
  if (currentWidth < widthThreshold * 0.7) confidence += 10;
  else if (currentWidth < widthThreshold * 0.85) confidence += 5;
  // Volume spike booster
  if (volAvg > 0 && curVol / volAvg > 2.5) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const reasoning = `Squeeze: ${direction} breakout from BB${SQUEEZE_BB_PERIOD} squeeze (width at ${SQUEEZE_PERCENTILE}th pct), vol ${(curVol / volAvg).toFixed(1)}x avg, stag ${SQUEEZE_STAGNATION_BARS * 4}h`;

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

export function runSqueezeDecisionEngine(analyses: PairAnalysis[]): QuantAIDecision[] {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = evaluateSqueezePair(analysis);
      if (decision) {
        console.log(
          `[SqueezeEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SqueezeEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[SqueezeEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
