import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  VWAP_DEVIATION_LONG_PCT,
  VWAP_DEVIATION_SHORT_PCT,
  VWAP_TREND_CONFLICT_PCT,
  VWAP_BASE_CONFIDENCE,
  VWAP_STOP_ATR_MULTIPLIER,
  VWAP_REWARD_RISK_RATIO,
  RULE_BB_PROXIMITY_PCT,
} from "../../config/constants.js";

function evaluateVwapPair(analysis: PairAnalysis): QuantAIDecision | null {
  const { pair, markPrice, regime } = analysis;

  // Volatile regime: no trades
  if (regime === "volatile") return null;

  const ind1h = analysis.indicators["1h"];
  const ind15m = analysis.indicators["15m"];
  const ind4h = analysis.indicators["4h"];

  const vwap1h = ind1h.vwap;
  const vwap15m = ind15m.vwap;
  const vwap4h = ind4h.vwap;

  if (vwap1h === null) return null;

  // Deviation percentages
  const dev1h = ((markPrice - vwap1h) / vwap1h) * 100;
  const dev4h = vwap4h !== null ? ((markPrice - vwap4h) / vwap4h) * 100 : 0;
  const dev15m = vwap15m !== null ? ((markPrice - vwap15m) / vwap15m) * 100 : null;

  // Dead zone: no trade when deviation is between thresholds
  if (dev1h > VWAP_DEVIATION_LONG_PCT && dev1h < VWAP_DEVIATION_SHORT_PCT) return null;

  // Determine direction
  let direction: "long" | "short";
  if (dev1h <= VWAP_DEVIATION_LONG_PCT) {
    direction = "long"; // Price far below VWAP -> mean reversion up
  } else {
    direction = "short"; // Price far above VWAP -> mean reversion down
  }

  // 4h trend conflict filter: skip if 4h strongly confirms deviation (trend, not reversion)
  if (direction === "long" && dev4h < -VWAP_TREND_CONFLICT_PCT) return null;
  if (direction === "short" && dev4h > VWAP_TREND_CONFLICT_PCT) return null;

  // Confidence calculation
  let confidence = VWAP_BASE_CONFIDENCE;

  // Larger 1h deviation boost
  if (Math.abs(dev1h) >= 3) confidence += 10;
  else if (Math.abs(dev1h) >= 2) confidence += 5;

  // RSI confirmation from 1h
  const rsi = ind1h.rsi;
  if (direction === "long" && rsi !== null && rsi < 40) confidence += 10;
  if (direction === "short" && rsi !== null && rsi > 60) confidence += 10;

  // Bollinger Band alignment from 1h (near band = +5)
  const bb = ind1h.bollingerBands;
  if (bb !== null) {
    if (direction === "long" && bb.lower !== null) {
      const nearLower = (Math.abs(markPrice - bb.lower) / markPrice) * 100 <= RULE_BB_PROXIMITY_PCT;
      if (nearLower) confidence += 5;
    }
    if (direction === "short" && bb.upper !== null) {
      const nearUpper = (Math.abs(markPrice - bb.upper) / markPrice) * 100 <= RULE_BB_PROXIMITY_PCT;
      if (nearUpper) confidence += 5;
    }
  }

  // 4h trend conflicting for mean reversion (same direction deviation = trend, not reversion)
  if (direction === "long" && dev4h < 0) confidence -= 15;
  if (direction === "short" && dev4h > 0) confidence -= 15;

  // Tight BB width boost
  if (bb !== null && bb.width !== null && bb.width < 0.03) confidence += 5;

  // 15m entry timing bonus: tighter than 1h = approaching reversal
  if (dev15m !== null && Math.abs(dev15m) < Math.abs(dev1h)) confidence += 5;

  // Cap confidence
  confidence = Math.min(90, Math.max(0, confidence));

  // ATR-based stop/TP
  const atr = ind1h.atr ?? markPrice * 0.01;
  const stopDistance = atr * VWAP_STOP_ATR_MULTIPLIER;
  const tpDistance = stopDistance * VWAP_REWARD_RISK_RATIO;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  // Kelly sizing with isRuleBased=true (60% min confidence gate)
  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const reasoning = `VWAP: 1h dev ${dev1h.toFixed(1)}%, 4h dev ${dev4h.toFixed(1)}%, RSI ${rsi?.toFixed(0) ?? "n/a"}`;

  return {
    pair,
    direction,
    entryPrice: markPrice,
    stopLoss,
    takeProfit,
    confidence,
    reasoning,
    regime,
    suggestedSizeUsd,
    analyzedAt: new Date().toISOString(),
  };
}

export function runVwapDecisionEngine(analyses: PairAnalysis[]): QuantAIDecision[] {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = evaluateVwapPair(analysis);
      if (decision) {
        console.log(
          `[VwapEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[VwapEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[VwapEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
