import type { PolymarketEvent, NewsItem, AIAnalysis, EnsembleResult, MarketCategory } from "./types.js";
import { analyzeMarket } from "./analyzer.js";
import { getTrustScore } from "../database/calibration.js";

const ENSEMBLE_SIZE = 1;
const DISAGREEMENT_VARIANCE_THRESHOLD = 0.04;

// Load trust score with fallback if calibration unavailable
function loadTrustScore(category: MarketCategory): number {
  try {
    return getTrustScore(category);
  } catch {
    return 1.0;
  }
}

// Detect disagreement via weighted variance
export function detectDisagreement(
  probabilities: number[],
  weights: number[]
): { disagreement: number; highDisagreement: boolean } {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return { disagreement: 0, highDisagreement: false };

  const weightedMean =
    probabilities.reduce((sum, p, i) => sum + p * weights[i], 0) / totalWeight;

  const weightedVariance =
    probabilities.reduce(
      (sum, p, i) => sum + weights[i] * (p - weightedMean) ** 2,
      0
    ) / totalWeight;

  return {
    disagreement: weightedVariance,
    highDisagreement: weightedVariance > DISAGREEMENT_VARIANCE_THRESHOLD,
  };
}

// Calculate weighted consensus from multiple analyses
export function calculateWeightedConsensus(
  analyses: AIAnalysis[],
  marketCategory: MarketCategory
): EnsembleResult {
  const trustScore = loadTrustScore(marketCategory);
  const weights = analyses.map(() => trustScore);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Weighted average probability and confidence
  const probability =
    analyses.reduce((sum, a, i) => sum + a.probability * weights[i], 0) /
    totalWeight;
  const confidence =
    analyses.reduce((sum, a, i) => sum + a.confidence * weights[i], 0) /
    totalWeight;

  // Combine reasoning
  const reasoning = analyses.map((a) => a.reasoning).join(" | ");

  // Deduplicate key factors
  const allFactors = analyses.flatMap((a) => a.keyFactors);
  const uniqueFactors = [...new Set(allFactors)];

  const individualEstimates = analyses.map((a) => a.probability);
  const { disagreement, highDisagreement } = detectDisagreement(
    individualEstimates,
    weights
  );

  const consensus: AIAnalysis = {
    marketId: analyses[0].marketId,
    probability: Math.max(0.01, Math.min(0.99, probability)),
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning,
    keyFactors: uniqueFactors,
    timestamp: Date.now(),
    evidenceCited: analyses.flatMap((a) => a.evidenceCited || []),
    consistencyNote: `Ensemble of ${analyses.length} analyses`,
  };

  return {
    consensus,
    individualEstimates,
    weights,
    disagreement,
    highDisagreement,
    ensembleSize: analyses.length,
  };
}

// Run parallel analyses and return ensemble result
export async function analyzeMarketEnsemble(
  market: PolymarketEvent,
  news: NewsItem[]
): Promise<EnsembleResult | null> {
  console.log(`[Ensemble] Running ${ENSEMBLE_SIZE} parallel analyses for: ${market.title}`);

  const promises = Array.from({ length: ENSEMBLE_SIZE }, () =>
    analyzeMarket(market, news)
  );
  const settled = await Promise.allSettled(promises);

  const successful = settled
    .filter(
      (r): r is PromiseFulfilledResult<AIAnalysis | null> =>
        r.status === "fulfilled"
    )
    .map((r) => r.value)
    .filter((a): a is AIAnalysis => a !== null);

  console.log(`[Ensemble] ${successful.length}/${ENSEMBLE_SIZE} analyses succeeded`);

  if (successful.length === 0) return null;

  if (successful.length < 2) {
    return {
      consensus: successful[0],
      individualEstimates: [successful[0].probability],
      weights: [1.0],
      disagreement: 0,
      highDisagreement: false,
      ensembleSize: 1,
    };
  }

  return calculateWeightedConsensus(
    successful,
    market.category as MarketCategory
  );
}
