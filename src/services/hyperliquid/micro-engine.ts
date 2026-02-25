import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  MICRO_IMBALANCE_LONG_THRESHOLD,
  MICRO_IMBALANCE_SHORT_THRESHOLD,
  MICRO_BASE_CONFIDENCE,
  MICRO_OI_SURGE_PCT,
  MICRO_OI_MIN_PCT,
  MICRO_STOP_ATR_MULTIPLIER,
  MICRO_REWARD_RISK_RATIO,
} from "../../config/constants.js";

function evaluateMicroPair(analysis: PairAnalysis): QuantAIDecision | null {
  const { pair, markPrice, microstructure } = analysis;

  if (!microstructure) return null;

  const { orderbookImbalance, longShortRatio, oiDeltaPct } = microstructure;

  // Orderbook imbalance required; L/S ratio and OI are optional boosters
  if (!orderbookImbalance) return null;

  const { imbalanceRatio, spreadBps } = orderbookImbalance;
  const globalTrend = longShortRatio?.globalTrend ?? null;

  // Skip if OI falling too hard (liquidation cascade)
  if (oiDeltaPct !== null && oiDeltaPct < MICRO_OI_MIN_PCT) return null;

  // No trade: imbalance in dead zone
  if (imbalanceRatio >= MICRO_IMBALANCE_SHORT_THRESHOLD && imbalanceRatio <= MICRO_IMBALANCE_LONG_THRESHOLD) {
    return null;
  }

  const atr = analysis.indicators["1h"].atr ?? markPrice * 0.01;

  let direction: "long" | "short" | null = null;
  let confidence = MICRO_BASE_CONFIDENCE;
  let reasoning = "";
  const oiStr = oiDeltaPct !== null ? `OI ${oiDeltaPct >= 0 ? "+" : ""}${oiDeltaPct.toFixed(1)}%` : "OI n/a";
  const lsStr = globalTrend ?? "n/a";

  // LONG: bid-heavy orderbook (L/S confirming is a bonus, not required)
  if (imbalanceRatio > MICRO_IMBALANCE_LONG_THRESHOLD) {
    const lsConfirms = !globalTrend || globalTrend === "falling" || globalTrend === "stable";
    if (!lsConfirms) {
      return null; // L/S rising = crowd is long, don't join
    }
    direction = "long";
    reasoning = `Micro: OB ${imbalanceRatio.toFixed(2)} bid-heavy, L/S ${lsStr}, ${oiStr}`;
  }

  // SHORT: ask-heavy orderbook
  if (imbalanceRatio < MICRO_IMBALANCE_SHORT_THRESHOLD) {
    const lsConfirms = !globalTrend || globalTrend === "rising" || globalTrend === "stable";
    if (!lsConfirms) {
      return null; // L/S falling = crowd is short, don't join
    }
    direction = "short";
    reasoning = `Micro: OB ${imbalanceRatio.toFixed(2)} ask-heavy, L/S ${lsStr}, ${oiStr}`;
  }

  if (direction === null) return null;

  // Confidence boosters
  if ((direction === "long" && imbalanceRatio > 0.75) || (direction === "short" && imbalanceRatio < 0.25)) {
    confidence += 10; // Extreme imbalance
  }
  if (spreadBps > 10) {
    confidence -= 5; // Thin book, less reliable
  }
  if (oiDeltaPct !== null && oiDeltaPct > MICRO_OI_SURGE_PCT) {
    confidence += 5; // OI surge
  }
  if (oiDeltaPct !== null && oiDeltaPct > 0) {
    confidence += 3; // OI rising (new money)
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
