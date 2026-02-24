import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  MICRO_IMBALANCE_LONG_THRESHOLD,
  MICRO_IMBALANCE_SHORT_THRESHOLD,
  MICRO_BASE_CONFIDENCE,
  MICRO_OI_SURGE_PCT,
  MICRO_STOP_ATR_MULTIPLIER,
  MICRO_REWARD_RISK_RATIO,
} from "../../config/constants.js";

function evaluateMicroPair(analysis: PairAnalysis): QuantAIDecision | null {
  const { pair, markPrice, microstructure } = analysis;

  if (!microstructure) return null;

  const { orderbookImbalance, longShortRatio, oiDelta, oiDeltaPct } = microstructure;

  // All microstructure data must be present
  if (!orderbookImbalance || !longShortRatio || oiDelta === null || oiDeltaPct === null) {
    return null;
  }

  const { imbalanceRatio, spreadBps } = orderbookImbalance;
  const { globalTrend } = longShortRatio;

  // No trade: OI falling (liquidation cascade)
  if (oiDelta <= 0) return null;

  // No trade: imbalance in dead zone
  if (imbalanceRatio >= MICRO_IMBALANCE_SHORT_THRESHOLD && imbalanceRatio <= MICRO_IMBALANCE_LONG_THRESHOLD) {
    return null;
  }

  const atr = analysis.indicators["1h"].atr ?? markPrice * 0.01;

  let direction: "long" | "short" | null = null;
  let confidence = MICRO_BASE_CONFIDENCE;
  let reasoning = "";

  // LONG: bid-heavy orderbook + shorts closing/stable + OI rising
  if (imbalanceRatio > MICRO_IMBALANCE_LONG_THRESHOLD && (globalTrend === "falling" || globalTrend === "stable")) {
    direction = "long";
    reasoning = `Micro: OB imbalance ${imbalanceRatio.toFixed(2)} bid-heavy, L/S ${globalTrend}, OI +${oiDeltaPct.toFixed(1)}%`;
  }

  // SHORT: ask-heavy orderbook + longs piling in (contrarian) + OI rising
  if (imbalanceRatio < MICRO_IMBALANCE_SHORT_THRESHOLD && globalTrend === "rising") {
    direction = "short";
    reasoning = `Micro: OB imbalance ${imbalanceRatio.toFixed(2)} ask-heavy, L/S ${globalTrend}, OI +${oiDeltaPct.toFixed(1)}%`;
  }

  if (direction === null) return null;

  // Confidence boosters
  if ((direction === "long" && imbalanceRatio > 0.75) || (direction === "short" && imbalanceRatio < 0.25)) {
    confidence += 10; // Extreme imbalance
  }
  if (spreadBps > 10) {
    confidence -= 5; // Thin book, less reliable
  }
  if (oiDeltaPct > MICRO_OI_SURGE_PCT) {
    confidence += 5; // OI surge
  }

  confidence = Math.min(90, Math.max(0, confidence));

  // Stop-loss and take-profit using ATR
  const stopDistance = atr * MICRO_STOP_ATR_MULTIPLIER;
  const tpDistance = stopDistance * MICRO_REWARD_RISK_RATIO;

  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);

  if (suggestedSizeUsd <= 0) return null;

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

export function runMicroDecisionEngine(analyses: PairAnalysis[]): QuantAIDecision[] {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = evaluateMicroPair(analysis);
      if (decision) {
        console.log(
          `[MicroEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MicroEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[MicroEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
