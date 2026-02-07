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

// Kelly criterion: f* = (bp - q) / b
function calculateKellyFraction(
  winProbability: number,
  odds: number
): number {
  const q = 1 - winProbability;
  const kelly = (odds * winProbability - q) / odds;
  return Math.max(0, kelly);
}

// Calculate expected value: YES = aiProb - price, NO = price - aiProb
export function calculateEV(aiProbability: number, currentPrice: number, side: "YES" | "NO"): number {
  if (side === "YES") {
    return aiProbability - currentPrice;
  } else {
    return currentPrice - aiProbability;
  }
}

// Calculate P&L percentage (token price: current vs entry)
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
  // Calculate odds (payout ratio)
  const price = side === "YES" ? marketPrice : 1 - marketPrice;
  const odds = (1 - price) / price;

  const winProb = side === "YES" ? aiProbability : 1 - aiProbability;

  const kelly = calculateKellyFraction(winProb, odds);
  const rawSize = bankroll * kelly * kellyMultiplier;

  return Math.min(rawSize, maxBet);
}

const MAX_BETS_PER_GROUP = 1;
const MAX_MARKET_DISAGREEMENT = 0.30; // Skip if AI disagrees with market by >30pp

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

  const edge = analysis.probability - marketPrice;
  const absEdge = Math.abs(edge);

  const side: "YES" | "NO" = edge > 0 ? "YES" : "NO";

  const expectedValue = calculateEV(analysis.probability, marketPrice, side);

  const availableBankroll = isPaperMode() ? bankroll : bankroll - currentExposure;
  const maxAllowedBet = isPaperMode() ? config.maxBetSize : Math.min(
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

  // Round to 2 decimals to avoid floating point precision issues (e.g. 0.6999... failing >= 0.70)
  const roundedConfidence = Math.round(analysis.confidence * 100) / 100;
  const meetsConfidence = roundedConfidence >= config.minConfidence;
  const meetsEdge = absEdge >= config.minEdge;
  const withinDisagreement = absEdge <= MAX_MARKET_DISAGREEMENT;
  const hasBudget = recommendedSize >= 1; // At least $1 bet
  const hasTokenId = tokenId !== "";

  const shouldBet = meetsConfidence && meetsEdge && withinDisagreement && hasBudget && hasTokenId;

  let reason: string;
  if (shouldBet) {
    reason = `Edge ${(absEdge * 100).toFixed(1)}%, Confidence ${(analysis.confidence * 100).toFixed(0)}%`;
  } else if (!meetsConfidence) {
    reason = `Confidence too low: ${(analysis.confidence * 100).toFixed(0)}% < ${(config.minConfidence * 100).toFixed(0)}%`;
  } else if (!withinDisagreement) {
    reason = `Market disagreement too high: ${(absEdge * 100).toFixed(0)}pp > ${(MAX_MARKET_DISAGREEMENT * 100).toFixed(0)}pp (market is likely right)`;
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
    recommendedSize: Math.floor(recommendedSize * 100) / 100,
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

  // Settlement risk: exit if <6h until resolution
  if (position.marketEndDate) {
    const hours = hoursUntil(position.marketEndDate);

    if (hours !== null && hours < SETTLEMENT_RISK_HOURS && hours > 0) {
      return {
        shouldExit: true,
        reason: `Settlement risk: ${hours.toFixed(1)}h until market resolution`,
      };
    }
  }

  // Stop-loss: hard floor before AI re-analysis
  const pnlPercent = calculatePnlPercent(position.entryPrice, currentPrice);

  if (pnlPercent < STOP_LOSS_THRESHOLD) {
    return {
      shouldExit: true,
      reason: `Stop-loss: P&L ${(pnlPercent * 100).toFixed(1)}% exceeded -25% limit`,
    };
  }

  // Convert token price to YES price for EV calculations
  // currentPrice is the held token's price (NO price for NO positions)
  const yesPrice = position.side === "YES" ? currentPrice : 1 - currentPrice;

  // AI re-analysis on price move >15% against position
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

    const freshAnalysis = await analyzeMarket(market, freshNews);

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

    // Conviction flip check
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

    // Hold - AI still supports position with +EV
    console.log(
      `[Evaluator] Holding: EV ${(ev * 100).toFixed(1)}%, AI ${(freshAnalysis.probability * 100).toFixed(0)}% vs market ${(yesPrice * 100).toFixed(0)}%`
    );
    return { shouldExit: false, reason: "" };
  }

  // Periodic check with existing analysis
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
