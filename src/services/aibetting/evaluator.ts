import type {
  PolymarketEvent,
  AIAnalysis,
  BetDecision,
  AIBettingConfig,
  AIBettingPosition,
} from "./types.js";
import { hoursUntil } from "../../utils/dates.js";

// Kelly criterion for optimal bet sizing
// f* = (bp - q) / b where b = odds, p = win prob, q = lose prob
function calculateKellyFraction(
  winProbability: number,
  odds: number
): number {
  const q = 1 - winProbability;
  const kelly = (odds * winProbability - q) / odds;
  return Math.max(0, kelly);
}

function calculateBetSize(
  aiProbability: number,
  marketPrice: number,
  side: "YES" | "NO",
  bankroll: number,
  maxBet: number,
  kellyMultiplier: number = 0.25 // Conservative: use 1/4 Kelly
): number {
  // Calculate odds (payout ratio)
  // If betting YES at 0.40, you win 0.60 for every 0.40 risked = 1.5x odds
  const price = side === "YES" ? marketPrice : 1 - marketPrice;
  const odds = (1 - price) / price;

  // Win probability from AI perspective
  const winProb = side === "YES" ? aiProbability : 1 - aiProbability;

  const kelly = calculateKellyFraction(winProb, odds);
  const rawSize = bankroll * kelly * kellyMultiplier;

  // Cap at max bet
  return Math.min(rawSize, maxBet);
}

export function evaluateBetOpportunity(
  market: PolymarketEvent,
  analysis: AIAnalysis,
  config: AIBettingConfig,
  currentExposure: number,
  bankroll: number
): BetDecision {
  const yesOutcome = market.outcomes.find((o) => o.name === "Yes");
  const marketPrice = yesOutcome?.price || 0.5;
  const tokenId = yesOutcome?.tokenId || "";

  // Calculate edge (difference between AI estimate and market)
  const edge = analysis.probability - marketPrice;
  const absEdge = Math.abs(edge);

  // Determine side: positive edge = bet YES, negative edge = bet NO
  const side: "YES" | "NO" = edge > 0 ? "YES" : "NO";

  // Calculate expected value
  // EV = (P_win * Profit) - (P_lose * Loss)
  // For YES bet: EV = aiProb * (1 - marketPrice) - (1 - aiProb) * marketPrice
  // Simplified: EV = aiProb - marketPrice = edge
  const expectedValue = absEdge;

  // Calculate recommended bet size
  const availableBankroll = bankroll - currentExposure;
  const maxAllowedBet = Math.min(
    config.maxBetSize,
    config.maxTotalExposure - currentExposure
  );

  const recommendedSize = calculateBetSize(
    analysis.probability,
    marketPrice,
    side,
    availableBankroll,
    maxAllowedBet
  );

  // Decision criteria
  const meetsConfidence = analysis.confidence >= config.minConfidence;
  const meetsEdge = absEdge >= config.minEdge;
  const hasBudget = recommendedSize >= 1; // At least $1 bet
  const hasTokenId = tokenId !== "";

  const shouldBet = meetsConfidence && meetsEdge && hasBudget && hasTokenId;

  // Build reason string
  let reason: string;
  if (shouldBet) {
    reason = `Edge ${(absEdge * 100).toFixed(1)}%, Confidence ${(analysis.confidence * 100).toFixed(0)}%`;
  } else if (!meetsConfidence) {
    reason = `Confidence too low: ${(analysis.confidence * 100).toFixed(0)}% < ${(config.minConfidence * 100).toFixed(0)}%`;
  } else if (!meetsEdge) {
    reason = `Edge too small: ${(absEdge * 100).toFixed(1)}% < ${(config.minEdge * 100).toFixed(0)}%`;
  } else if (!hasBudget) {
    reason = "Insufficient bankroll or exposure limit reached";
  } else {
    reason = "Missing token ID";
  }

  return {
    shouldBet,
    marketId: market.conditionId,
    tokenId: side === "YES" ? tokenId : market.outcomes.find((o) => o.name === "No")?.tokenId || "",
    side,
    marketPrice,
    aiProbability: analysis.probability,
    confidence: analysis.confidence,
    edge,
    expectedValue,
    recommendedSize: Math.floor(recommendedSize * 100) / 100, // Round to cents
    reason,
  };
}

export function evaluateAllOpportunities(
  markets: PolymarketEvent[],
  analyses: Map<string, AIAnalysis>,
  config: AIBettingConfig,
  currentPositions: AIBettingPosition[],
  bankroll: number
): BetDecision[] {
  const decisions: BetDecision[] = [];

  // Calculate current exposure
  const currentExposure = currentPositions
    .filter((p) => p.status === "open")
    .reduce((sum, p) => sum + p.size, 0);

  // Check position count
  const openPositionCount = currentPositions.filter(
    (p) => p.status === "open"
  ).length;

  if (openPositionCount >= config.maxPositions) {
    console.log(
      `[Evaluator] Max positions reached (${openPositionCount}/${config.maxPositions})`
    );
    return decisions;
  }

  for (const market of markets) {
    const analysis = analyses.get(market.conditionId);
    if (!analysis) continue;

    const decision = evaluateBetOpportunity(
      market,
      analysis,
      config,
      currentExposure,
      bankroll
    );

    decisions.push(decision);

    if (decision.shouldBet) {
      console.log(
        `[Evaluator] Opportunity: ${market.title} - ${decision.side} @ ${decision.recommendedSize.toFixed(2)} (${decision.reason})`
      );
    }
  }

  // Sort by expected value, return only positive decisions
  return decisions
    .filter((d) => d.shouldBet)
    .sort((a, b) => b.expectedValue - a.expectedValue);
}

export function shouldExitPosition(
  position: AIBettingPosition,
  currentPrice: number,
  newAnalysis: AIAnalysis | null
): { shouldExit: boolean; reason: string } {
  // Settlement risk: exit if <6h until market resolution
  const SETTLEMENT_RISK_HOURS = 6;
  if (position.marketEndDate) {
    const hours = hoursUntil(position.marketEndDate);

    if (hours !== null && hours < SETTLEMENT_RISK_HOURS && hours > 0) {
      return {
        shouldExit: true,
        reason: `Settlement risk: ${hours.toFixed(1)}h until market resolution`,
      };
    }
  }

  // Check if price moved significantly against us
  const priceDiff =
    position.side === "YES"
      ? currentPrice - position.entryPrice
      : position.entryPrice - currentPrice;

  const priceChangePercent = priceDiff / position.entryPrice;

  // Stop loss: exit if price moved >25% against
  if (priceChangePercent < -0.25) {
    return {
      shouldExit: true,
      reason: `Stop loss triggered: ${(priceChangePercent * 100).toFixed(1)}% move against`,
    };
  }

  // Check if AI confidence dropped significantly
  if (newAnalysis && newAnalysis.confidence < 0.4) {
    return {
      shouldExit: true,
      reason: `Confidence dropped to ${(newAnalysis.confidence * 100).toFixed(0)}%`,
    };
  }

  // Check if AI changed its mind significantly
  if (newAnalysis) {
    const newEdge =
      position.side === "YES"
        ? newAnalysis.probability - currentPrice
        : currentPrice - newAnalysis.probability;

    // If edge reversed significantly, exit
    if (newEdge < -0.05) {
      return {
        shouldExit: true,
        reason: `AI edge reversed: now ${(newEdge * 100).toFixed(1)}%`,
      };
    }
  }

  return { shouldExit: false, reason: "" };
}
