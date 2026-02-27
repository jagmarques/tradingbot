import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  RULE_RSI_OVERSOLD,
  RULE_RSI_OVERBOUGHT,
  RULE_RSI_PULLBACK_LOW,
  RULE_RSI_PULLBACK_HIGH,
  RULE_STOP_ATR_MULTIPLIER,
  RULE_REWARD_RISK_RATIO,
  RULE_BB_PROXIMITY_PCT,
  RULE_MIN_CONFIDENCE,
} from "../../config/constants.js";

export function evaluatePair(analysis: PairAnalysis): QuantAIDecision | null {
  const { pair, regime, markPrice } = analysis;
  const ind = analysis.indicators["1h"];

  // Volatile regime: no trades
  if (regime === "volatile") {
    return null;
  }

  const rsi = ind.rsi;
  const macd = ind.macd;
  const bb = ind.bollingerBands;
  const atr = ind.atr ?? markPrice * 0.01;
  const adx = ind.adx;

  let direction: "long" | "short" | null = null;
  let confidence = RULE_MIN_CONFIDENCE;
  let reasoning = "";

  if (regime === "trending") {
    if (rsi === null || macd === null || macd.histogram === null || macd.macd === null || macd.signal === null) {
      return null;
    }

    const histogram = macd.histogram;
    const macdLine = macd.macd;
    const signalLine = macd.signal;

    // Long: RSI in pullback zone (40-50), MACD histogram positive, MACD line just crossed above signal
    const longSignal =
      rsi >= RULE_RSI_PULLBACK_LOW &&
      rsi < 50 &&
      histogram > 0 &&
      macdLine > signalLine; // crossover happened or is happening

    // Short: RSI in pullback zone (50-60), MACD histogram negative, MACD line below signal
    const shortSignal =
      rsi > 50 &&
      rsi <= RULE_RSI_PULLBACK_HIGH &&
      histogram < 0 &&
      macdLine < signalLine;

    if (longSignal && !shortSignal) {
      direction = "long";
      reasoning = `Trending: RSI pullback ${rsi.toFixed(0)} + MACD crossover`;
    } else if (shortSignal && !longSignal) {
      direction = "short";
      reasoning = `Trending: RSI pullback ${rsi.toFixed(0)} + MACD crossover`;
    } else {
      return null;
    }

    // Confidence boosters for trending
    if (adx !== null && adx > 30) {
      confidence += 10;
      reasoning += `, ADX ${adx.toFixed(0)}`;
    }
    if (Math.abs(histogram) > Math.abs(signalLine)) {
      confidence += 10; // histogram magnitude growing
    }
    // Deeper pullback zone bonus
    if (direction === "long" && rsi < 45) {
      confidence += 5;
    } else if (direction === "short" && rsi > 55) {
      confidence += 5;
    }
  } else {
    // ranging
    if (rsi === null || bb === null || bb.lower === null || bb.upper === null) {
      return null;
    }

    const nearLower = bb.lower !== null && Math.abs(markPrice - bb.lower) / markPrice * 100 <= RULE_BB_PROXIMITY_PCT;
    const nearUpper = bb.upper !== null && Math.abs(markPrice - bb.upper) / markPrice * 100 <= RULE_BB_PROXIMITY_PCT;

    const longSignal = rsi < RULE_RSI_OVERSOLD && nearLower;
    const shortSignal = rsi > RULE_RSI_OVERBOUGHT && nearUpper;

    if (longSignal && !shortSignal) {
      direction = "long";
      reasoning = `Ranging: RSI oversold ${rsi.toFixed(0)} near lower BB`;
    } else if (shortSignal && !longSignal) {
      direction = "short";
      reasoning = `Ranging: RSI overbought ${rsi.toFixed(0)} near upper BB`;
    } else {
      return null;
    }

    // Confidence boosters for ranging
    if ((direction === "long" && rsi < 25) || (direction === "short" && rsi > 75)) {
      confidence += 10; // extreme RSI
    }
    if (bb.width !== null && bb.width < 0.03) {
      confidence += 10; // tight BB = stronger mean reversion
    }
    // Very near BB band
    const bandPrice = direction === "long" ? bb.lower : bb.upper;
    if (bandPrice !== null && Math.abs(markPrice - bandPrice) / markPrice * 100 <= 0.25) {
      confidence += 5;
    }
  }

  if (direction === null) return null;

  // Cap confidence at 90
  confidence = Math.min(90, confidence);

  // Stop-loss and take-profit using ATR
  const stopDistance = atr * RULE_STOP_ATR_MULTIPLIER;
  const tpDistance = stopDistance * RULE_REWARD_RISK_RATIO;

  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  // Kelly sizing (rule-based = lower confidence gate)
  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);

  if (suggestedSizeUsd <= 0) {
    return null;
  }

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

export function runRuleDecisionEngine(analyses: PairAnalysis[]): QuantAIDecision[] {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = evaluatePair(analysis);
      if (decision) {
        console.log(
          `[RuleEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RuleEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[RuleEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
