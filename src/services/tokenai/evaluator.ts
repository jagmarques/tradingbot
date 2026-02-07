import type { TokenAnalysisResult, SupportedChain } from "./types.js";
import type { TokenPosition } from "../database/tokenai.js";

export interface TokenAIConfig {
  maxBetUsd: number;
  minBetUsd: number;
  maxExposureUsd: number;
  maxPositions: number;
  dailyLossLimitUsd: number;
  kellyMultiplier: number;
  minConfidence: "low" | "medium" | "high";
  minSuccessProbability: number;
}

export interface TokenTradeRecommendation {
  shouldTrade: boolean;
  tokenAddress: string;
  chain: SupportedChain;
  sizeUsd: number;
  kellyFraction: number;
  confidenceScore: number;
  successProbability: number;
  estimatedEdge: number;
  reason: string;
}

export const DEFAULT_TOKEN_AI_CONFIG: TokenAIConfig = {
  maxBetUsd: 10,
  minBetUsd: 5,
  maxExposureUsd: 50,
  maxPositions: 5,
  dailyLossLimitUsd: 25,
  kellyMultiplier: 0.25,
  minConfidence: "medium",
  minSuccessProbability: 0.15,
};

// Confidence ordering for gate comparison
const CONFIDENCE_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

// Confidence scaling factors for position sizing
const CONFIDENCE_SCALE: Record<string, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.4,
};

// Kelly criterion for token trades: f* = (bp - q) / b
// b = payoff - 1 (net gain ratio), p = success probability, q = 1 - p
export function calculateTokenKelly(
  successProbability: number,
  payoffMultiple: number = 2.0
): number {
  const b = payoffMultiple - 1;
  const p = successProbability;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  return Math.max(0, kelly);
}

export function evaluateToken(
  analysis: TokenAnalysisResult,
  config: TokenAIConfig = DEFAULT_TOKEN_AI_CONFIG,
  currentPositions?: TokenPosition[],
  dailyPnl?: number
): TokenTradeRecommendation {
  const positions = currentPositions ?? [];
  const openPositions = positions.filter((p) => p.status === "open");

  const baseResult: TokenTradeRecommendation = {
    shouldTrade: false,
    tokenAddress: analysis.tokenAddress,
    chain: analysis.chain,
    sizeUsd: 0,
    kellyFraction: 0,
    confidenceScore: analysis.confidenceScore,
    successProbability: analysis.successProbability,
    estimatedEdge: 2 * analysis.successProbability - 1,
    reason: "",
  };

  // Gate 1: Confidence
  const analysisConfLevel = CONFIDENCE_ORDER[analysis.confidence] ?? 0;
  const minConfLevel = CONFIDENCE_ORDER[config.minConfidence] ?? 1;
  if (analysisConfLevel < minConfLevel) {
    baseResult.reason = `Confidence too low: ${analysis.confidence} < ${config.minConfidence}`;
    logResult(baseResult);
    return baseResult;
  }

  // Gate 2: Probability threshold
  if (analysis.successProbability < config.minSuccessProbability) {
    baseResult.reason = `Probability too low: ${(analysis.successProbability * 100).toFixed(1)}% < ${(config.minSuccessProbability * 100).toFixed(1)}%`;
    logResult(baseResult);
    return baseResult;
  }

  // Gate 3: Security score
  if (analysis.securityScore !== undefined && analysis.securityScore >= 70) {
    baseResult.reason = `Security risk too high: score ${analysis.securityScore}/100`;
    logResult(baseResult);
    return baseResult;
  }

  // Gate 4: Kelly criterion (negative EV check)
  const kelly = calculateTokenKelly(analysis.successProbability);
  baseResult.kellyFraction = kelly;
  if (kelly <= 0) {
    baseResult.reason = `Negative EV: Kelly fraction ${kelly.toFixed(4)}`;
    logResult(baseResult);
    return baseResult;
  }

  // Calculate raw position size using maxExposureUsd as bankroll proxy
  const rawSize = kelly * config.kellyMultiplier * config.maxExposureUsd;

  // Apply confidence scaling
  const confScale = CONFIDENCE_SCALE[analysis.confidence] ?? 0.4;
  let sizeUsd = rawSize * confScale;

  // Gate 5: Position count
  if (openPositions.length >= config.maxPositions) {
    baseResult.reason = `Position limit reached: ${openPositions.length}/${config.maxPositions}`;
    logResult(baseResult);
    return baseResult;
  }

  // Gate 6: Exposure limit
  const currentExposure = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
  const remainingExposure = config.maxExposureUsd - currentExposure;
  if (remainingExposure <= 0) {
    baseResult.reason = `Exposure limit reached: $${currentExposure.toFixed(2)}/$${config.maxExposureUsd}`;
    logResult(baseResult);
    return baseResult;
  }
  sizeUsd = Math.min(sizeUsd, remainingExposure);

  // Gate 7: Daily loss limit
  if (dailyPnl !== undefined && dailyPnl <= -config.dailyLossLimitUsd) {
    baseResult.reason = `Daily loss limit hit: $${dailyPnl.toFixed(2)} <= -$${config.dailyLossLimitUsd}`;
    logResult(baseResult);
    return baseResult;
  }

  // Gate 8: Max bet cap
  sizeUsd = Math.min(sizeUsd, config.maxBetUsd);

  // Gate 9: Min bet floor
  if (sizeUsd < config.minBetUsd) {
    baseResult.reason = `Size below minimum: $${sizeUsd.toFixed(2)} < $${config.minBetUsd}`;
    logResult(baseResult);
    return baseResult;
  }

  // All gates passed
  const result: TokenTradeRecommendation = {
    shouldTrade: true,
    tokenAddress: analysis.tokenAddress,
    chain: analysis.chain,
    sizeUsd: Math.floor(sizeUsd * 100) / 100,
    kellyFraction: kelly,
    confidenceScore: analysis.confidenceScore,
    successProbability: analysis.successProbability,
    estimatedEdge: 2 * analysis.successProbability - 1,
    reason: `Kelly ${(kelly * 100).toFixed(1)}%, confidence ${analysis.confidence}, edge ${((2 * analysis.successProbability - 1) * 100).toFixed(1)}%`,
  };

  logResult(result);
  return result;
}

function logResult(rec: TokenTradeRecommendation): void {
  const addr = rec.tokenAddress.slice(0, 8);
  const action = rec.shouldTrade ? "TRADE" : "SKIP";
  console.log(
    `[TokenEvaluator] ${addr} on ${rec.chain}: ${action} $${rec.sizeUsd.toFixed(2)} (kelly=${rec.kellyFraction.toFixed(4)}, confidence=${rec.confidenceScore.toFixed(2)}, reason=${rec.reason})`
  );
}
