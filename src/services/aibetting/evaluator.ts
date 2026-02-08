import type {
  PolymarketEvent,
  AIAnalysis,
  BetDecision,
  AIBettingConfig,
  AIBettingPosition,
} from "./types.js";
import { hoursUntil } from "../../utils/dates.js";
import { isPaperMode } from "../../config/env.js";
import { fetchMarketByConditionId } from "./scanner.js";
import { fetchNewsForMarket } from "./news.js";
import { analyzeMarket } from "./analyzer.js";

const CATEGORY_EDGE_BONUS: Record<string, number> = {
  entertainment: 0.03,
  other: 0.02,
  politics: 0.01,
  sports: 0,
  business: 0,
  crypto: -0.03,
  science: 0,
};

const NO_SIDE_EDGE_BONUS = 0.015;

function calculateKellyFraction(
  winProbability: number,
  odds: number
): number {
  const q = 1 - winProbability;
  const kelly = (odds * winProbability - q) / odds;
  return Math.max(0, kelly);
}

function getPriceZoneMultiplier(marketPrice: number): number {
  // Markets near 50% are hardest to find edge - require full edge
  // Markets near extremes have structural edge compression
  if (marketPrice >= 0.30 && marketPrice <= 0.70) return 1.0;   // No change
  if (marketPrice >= 0.10 && marketPrice <= 0.90) return 0.7;   // 10-30% or 70-90%
  return 0.4;                                                     // <10% or >90%
}

export function calculateEV(aiProbability: number, currentPrice: number, side: "YES" | "NO"): number {
  if (side === "YES") {
    return aiProbability - currentPrice;
  } else {
    return currentPrice - aiProbability;
  }
}

function calculatePnlPercent(entryPrice: number, currentPrice: number): number {
  return (currentPrice - entryPrice) / entryPrice;
}

function calculateBetSize(
  aiProbability: number,
  marketPrice: number,
  side: "YES" | "NO",
  bankroll: number,
  maxBet: number,
  kellyMultiplier: number = 0.25 // 1/4 Kelly
): number {
  const price = side === "YES" ? marketPrice : 1 - marketPrice;
  const odds = (1 - price) / price;

  const winProb = side === "YES" ? aiProbability : 1 - aiProbability;

  const kelly = calculateKellyFraction(winProb, odds);
  const rawSize = bankroll * kelly * kellyMultiplier;

  return Math.min(rawSize, maxBet);
}

const MAX_BETS_PER_GROUP = 1;
const MAX_MARKET_DISAGREEMENT = 0.30;
const DYNAMIC_EDGE_THRESHOLD = 0.20;
const DYNAMIC_CONFIDENCE_FLOOR = 0.50;

function extractSignificantWords(title: string): string[] {
  const stopWords = new Set([
    "will", "does", "is", "has", "can", "the", "and", "for", "are", "but",
    "not", "you", "all", "was", "one", "our", "his", "her", "its", "they",
    "been", "have", "some", "them", "than", "this", "that", "from", "with",
    "more", "less", "about", "before", "after", "during", "between", "into",
    "over", "such", "each", "make", "like", "any", "who", "what", "when",
    "where", "how", "which", "too", "very", "just", "there", "would",
    "could", "should", "their", "being", "other", "these", "those",
  ]);

  return title
    .toLowerCase()
    .replace(/[?!.,]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
}

function wordOverlapRatio(words1: string[], words2: string[]): number {
  if (words1.length === 0 || words2.length === 0) return 0;
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  let overlap = 0;
  for (const w of set1) {
    if (set2.has(w)) overlap++;
  }
  const minSize = Math.min(set1.size, set2.size);
  return minSize > 0 ? overlap / minSize : 0;
}

function limitCorrelatedBets(
  decisions: BetDecision[],
  markets: PolymarketEvent[]
): BetDecision[] {
  const titleMap = new Map<string, string>();
  for (const m of markets) {
    titleMap.set(m.conditionId, m.title);
  }

  const wordsMap = new Map<string, string[]>();
  for (const d of decisions) {
    wordsMap.set(d.marketId, extractSignificantWords(titleMap.get(d.marketId) || ""));
  }

  // Group correlated markets by word overlap
  const groups: BetDecision[][] = [];
  const assigned = new Set<string>();

  for (const d of decisions) {
    if (assigned.has(d.marketId)) continue;

    const group = [d];
    assigned.add(d.marketId);
    const words1 = wordsMap.get(d.marketId)!;

    for (const other of decisions) {
      if (assigned.has(other.marketId)) continue;
      const words2 = wordsMap.get(other.marketId)!;

      if (wordOverlapRatio(words1, words2) > 0.5) {
        group.push(other);
        assigned.add(other.marketId);
      }
    }

    groups.push(group);
  }

  // Keep top N by EV from each group (already sorted by caller)
  const result: BetDecision[] = [];
  for (const group of groups) {
    const kept = group.slice(0, MAX_BETS_PER_GROUP);
    const dropped = group.length - kept.length;
    if (dropped > 0) {
      const title = titleMap.get(group[0].marketId) || "unknown";
      console.log(
        `[Evaluator] Correlation guard: kept ${kept.length}/${group.length} from "${title.substring(0, 60)}"`
      );
    }
    result.push(...kept);
  }

  return result;
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

  // analysis.probability is already Bayesian-weighted (0.67*market + 0.33*R1)
  const aiProbability = analysis.probability;

  const edge = aiProbability - marketPrice;
  const absEdge = Math.abs(edge);

  const side: "YES" | "NO" = edge > 0 ? "YES" : "NO";

  const categoryBonus = CATEGORY_EDGE_BONUS[market.category] ?? 0;
  const sideBonus = side === "NO" ? NO_SIDE_EDGE_BONUS : -NO_SIDE_EDGE_BONUS;
  const effectiveEdge = absEdge + categoryBonus + sideBonus;

  const priceZoneMultiplier = getPriceZoneMultiplier(marketPrice);
  const adjustedMinEdge = config.minEdge * priceZoneMultiplier;

  console.log(
    `[Evaluator] SHADOW: ${market.title} | market=${(marketPrice * 100).toFixed(0)}c ai=${(aiProbability * 100).toFixed(0)}% ` +
    `edge=${(absEdge * 100).toFixed(1)}% cat=${(categoryBonus * 100).toFixed(1)}% side=${(sideBonus * 100).toFixed(1)}% effective=${(effectiveEdge * 100).toFixed(1)}% zone=${priceZoneMultiplier}x minEdge=${(adjustedMinEdge * 100).toFixed(1)}%`
  );

  const expectedValue = calculateEV(aiProbability, marketPrice, side);

  const availableBankroll = isPaperMode() ? bankroll : bankroll - currentExposure;
  const maxAllowedBet = Math.min(
    config.maxBetSize,
    config.maxTotalExposure - currentExposure
  );

  const recommendedSize = calculateBetSize(
    aiProbability,
    marketPrice,
    side,
    availableBankroll,
    maxAllowedBet
  );

  const roundedConfidence = Math.round(analysis.confidence * 100) / 100;
  const effectiveMinConfidence = absEdge >= DYNAMIC_EDGE_THRESHOLD ? DYNAMIC_CONFIDENCE_FLOOR : config.minConfidence;
  const isDynamicThreshold = absEdge >= DYNAMIC_EDGE_THRESHOLD && effectiveMinConfidence < config.minConfidence;
  const meetsConfidence = roundedConfidence >= effectiveMinConfidence;
  const meetsEdge = effectiveEdge >= adjustedMinEdge;
  const withinDisagreement = absEdge <= MAX_MARKET_DISAGREEMENT;
  const hasBudget = recommendedSize >= 1; // At least $1 bet
  const hasTokenId = tokenId !== "";

  const shouldBet = meetsConfidence && meetsEdge && withinDisagreement && hasBudget && hasTokenId;

  let reason: string;
  if (shouldBet) {
    reason = `Edge ${(effectiveEdge * 100).toFixed(1)}% (raw ${(absEdge * 100).toFixed(1)}% ${categoryBonus >= 0 ? '+' : ''}${(categoryBonus * 100).toFixed(1)}% cat ${sideBonus >= 0 ? '+' : ''}${(sideBonus * 100).toFixed(1)}% ${side}), Confidence ${(analysis.confidence * 100).toFixed(0)}%`;
    if (isDynamicThreshold) {
      reason += ` (dynamic: ${(effectiveMinConfidence * 100).toFixed(0)}% floor)`;
    }
  } else if (!meetsConfidence) {
    reason = `Confidence too low: ${(analysis.confidence * 100).toFixed(0)}% < ${(effectiveMinConfidence * 100).toFixed(0)}%`;
  } else if (!withinDisagreement) {
    reason = `Market disagreement too high: ${(absEdge * 100).toFixed(0)}pp > ${(MAX_MARKET_DISAGREEMENT * 100).toFixed(0)}pp (market is likely right)`;
  } else if (!meetsEdge) {
    reason = `Edge too small: ${(effectiveEdge * 100).toFixed(1)}% < ${(adjustedMinEdge * 100).toFixed(1)}% (${priceZoneMultiplier}x zone)`;
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
    aiProbability: aiProbability,
    confidence: analysis.confidence,
    edge,
    expectedValue,
    recommendedSize: Math.floor(recommendedSize * 100) / 100,
    reason,
    dynamicThreshold: isDynamicThreshold && shouldBet,
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

  const currentExposure = currentPositions
    .filter((p) => p.status === "open")
    .reduce((sum, p) => sum + p.size, 0);

  const openPositionCount = currentPositions.filter(
    (p) => p.status === "open"
  ).length;

  if (!isPaperMode() && openPositionCount >= config.maxPositions) {
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
        `[Evaluator] BET: ${market.title} - ${decision.side} @ $${decision.recommendedSize.toFixed(2)} (${decision.reason})`
      );
    } else {
      console.log(
        `[Evaluator] SKIP: ${market.title} - AI=${(decision.aiProbability * 100).toFixed(0)}% Market=${(decision.marketPrice * 100).toFixed(0)}% Edge=${(Math.abs(decision.edge) * 100).toFixed(1)}% C=${(decision.confidence * 100).toFixed(0)}% | ${decision.reason}`
      );
    }
  }

  // Sort by EV, return only positive decisions
  const approved = decisions
    .filter((d) => d.shouldBet)
    .sort((a, b) => Math.abs(b.expectedValue) - Math.abs(a.expectedValue));

  // Limit correlated bets (max 2 per event group)
  return limitCorrelatedBets(approved, markets);
}

export async function shouldExitPosition(
  position: AIBettingPosition,
  currentPrice: number,
  newAnalysis: AIAnalysis | null
): Promise<{ shouldExit: boolean; reason: string }> {
  const SETTLEMENT_RISK_HOURS = 6;
  const STOP_LOSS_THRESHOLD = -0.25;

  if (position.marketEndDate) {
    const hours = hoursUntil(position.marketEndDate);

    if (hours !== null && hours < SETTLEMENT_RISK_HOURS && hours > 0) {
      return {
        shouldExit: true,
        reason: `Settlement risk: ${hours.toFixed(1)}h until market resolution`,
      };
    }
  }

  const pnlPercent = calculatePnlPercent(position.entryPrice, currentPrice);

  if (pnlPercent < STOP_LOSS_THRESHOLD) {
    return {
      shouldExit: true,
      reason: `Stop-loss: P&L ${(pnlPercent * 100).toFixed(1)}% exceeded -25% limit`,
    };
  }

  const yesPrice = position.side === "YES" ? currentPrice : 1 - currentPrice;

  const priceDiff = currentPrice - position.entryPrice;
  const priceChangePercent = priceDiff / position.entryPrice;

  if (priceChangePercent < -0.15) {
    console.log(
      `[Evaluator] Price moved ${(priceChangePercent * 100).toFixed(1)}% against ${position.marketTitle} - triggering AI re-analysis`
    );

    const market = await fetchMarketByConditionId(position.marketId, position.tokenId);
    if (!market) {
      console.log(`[Evaluator] Cannot fetch market data for re-analysis, keeping position`);
      return { shouldExit: false, reason: "" };
    }

    const freshNews = await fetchNewsForMarket(market);

    const freshAnalysis = await analyzeMarket(market, freshNews, undefined, undefined, yesPrice);

    if (!freshAnalysis) {
      console.log(`[Evaluator] AI re-analysis failed, keeping position`);
      return { shouldExit: false, reason: "" };
    }

    const ev = calculateEV(freshAnalysis.probability, yesPrice, position.side);

    if (ev <= 0) {
      return {
        shouldExit: true,
        reason: `EV negative: AI ${(freshAnalysis.probability * 100).toFixed(0)}% vs market ${(yesPrice * 100).toFixed(0)}% = ${(ev * 100).toFixed(1)}% EV`,
      };
    }

    const aiNowFavorsOpposite =
      (position.side === "YES" && freshAnalysis.probability < 0.40) ||
      (position.side === "NO" && freshAnalysis.probability > 0.60);

    if (aiNowFavorsOpposite) {
      const oppositeSide = position.side === "YES" ? "NO" : "YES";
      return {
        shouldExit: true,
        reason: `Conviction flip: AI now ${(freshAnalysis.probability * 100).toFixed(0)}% (favors ${oppositeSide})`,
      };
    }

    console.log(
      `[Evaluator] Holding: EV ${(ev * 100).toFixed(1)}%, AI ${(freshAnalysis.probability * 100).toFixed(0)}% vs market ${(yesPrice * 100).toFixed(0)}%`
    );
    return { shouldExit: false, reason: "" };
  }

  if (newAnalysis) {
    const ev = calculateEV(newAnalysis.probability, yesPrice, position.side);

    if (ev <= 0 && newAnalysis.confidence >= 0.5) {
      return {
        shouldExit: true,
        reason: `Edge reversed: EV ${(ev * 100).toFixed(1)}% (AI ${(newAnalysis.probability * 100).toFixed(0)}% vs market ${(yesPrice * 100).toFixed(0)}%)`,
      };
    }
  }

  return { shouldExit: false, reason: "" };
}
