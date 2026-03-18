/**
 * Probability Engine for Polymarket
 *
 * Tempered log-odds pooling: blends market price with R1 estimate.
 * NOT a true Bayesian conjugate update (R1's output is itself a posterior,
 * not a likelihood ratio). This is a principled heuristic, not Bayes' theorem.
 *
 * Architecture:
 *   Market Price -> Log-odds Prior -> R1 Signal (tempered) -> Posterior
 *
 *   prior_logodds = ln(alpha/beta)
 *   signal = weight * ln(r1prob / (1 - r1prob))
 *   posterior_logodds = prior_logodds + signal
 *   posterior_prob = sigmoid(posterior_logodds)
 *
 * The signalWeight parameter controls how much R1 can move the estimate.
 * It should be calibrated against R1's actual Brier score on historical
 * predictions. Until calibrated, use conservative values (0.15-0.25).
 */

// ─── Beta-Bernoulli Estimator ─────────────────────────────────────────────

export interface BayesianPrior {
  alpha: number;
  beta: number;
}

export interface BayesianPosterior {
  probability: number;
  alpha: number;
  beta: number;
  credibleLow: number;
  credibleHigh: number;
  priorProbability: number;
  signalStrength: number;
}

/**
 * Create a Beta prior from market price.
 * priorStrength controls how much we trust the market (equivalent sample size).
 * Higher strength = prior is harder to move.
 */
export function createPrior(marketPrice: number, priorStrength: number = 20): BayesianPrior {
  const clampedPrice = Math.max(0.01, Math.min(0.99, marketPrice));
  return {
    alpha: clampedPrice * priorStrength,
    beta: (1 - clampedPrice) * priorStrength,
  };
}

/**
 * Update prior with R1 signal using log-odds space.
 *
 * signalWeight combines:
 *   - R1 confidence (0-1)
 *   - Citation accuracy (0-1)
 *   - News recency decay
 *
 * Working in log-odds makes evidence aggregation additive:
 *   posterior_LO = prior_LO + signalWeight × evidence_LO
 */
export function updateWithSignal(
  prior: BayesianPrior,
  r1Probability: number,
  signalWeight: number
): BayesianPosterior {
  const clampedR1 = Math.max(0.01, Math.min(0.99, r1Probability));

  const priorProb = prior.alpha / (prior.alpha + prior.beta);
  const priorLogOdds = Math.log(prior.alpha / prior.beta);

  // Evidence in log-odds space
  const evidenceLogOdds = Math.log(clampedR1 / (1 - clampedR1));

  // Posterior = prior + weighted evidence
  const posteriorLogOdds = priorLogOdds + signalWeight * evidenceLogOdds;

  // Convert back to probability via sigmoid
  const posteriorProb = 1 / (1 + Math.exp(-posteriorLogOdds));

  // Update Beta parameters to match new probability while preserving total count
  const totalCount = prior.alpha + prior.beta;
  const newAlpha = posteriorProb * totalCount;
  const newBeta = (1 - posteriorProb) * totalCount;

  // Approximate credible interval (normal approximation to Beta)
  const [credibleLow, credibleHigh] = credibleInterval(newAlpha, newBeta);

  return {
    probability: Math.max(0.01, Math.min(0.99, posteriorProb)),
    alpha: newAlpha,
    beta: newBeta,
    credibleLow,
    credibleHigh,
    priorProbability: priorProb,
    signalStrength: signalWeight,
  };
}

/**
 * Compute signal weight from R1 confidence, citation accuracy, and news recency.
 *
 * Formula: weight = confidence × citationAcc × newsDecay × baseWeight
 *
 * baseWeight controls how much R1 can move the posterior (default 0.5).
 * This prevents a single R1 call from dominating the market prior.
 */
export function computeSignalWeight(
  r1Confidence: number,
  citationAccuracy: number = 1.0,
  newsRecencyFactor: number = 1.0,
  baseWeight: number = 0.5
): number {
  return baseWeight * r1Confidence * citationAccuracy * newsRecencyFactor;
}

/**
 * Exponential decay for news recency.
 * Returns 1.0 for fresh news, decays toward 0 for old news.
 *
 * halfLifeHours controls the decay rate:
 *   - 24h half-life: 1-day-old news has 50% weight
 *   - 48h half-life: 2-day-old news has 50% weight
 */
export function newsRecencyDecay(
  articleAgeHours: number,
  halfLifeHours: number = 24
): number {
  if (articleAgeHours <= 0) return 1.0;
  const lambda = Math.LN2 / halfLifeHours;
  return Math.exp(-lambda * articleAgeHours);
}

/**
 * Compute average news recency factor for a set of articles.
 * Returns 1.0 if no articles (falls back to R1 training data).
 */
export function averageNewsRecency(
  articleTimestamps: number[],
  halfLifeHours: number = 24
): number {
  if (articleTimestamps.length === 0) return 0.7; // Penalty for no news (R1 uses stale training data)

  const now = Date.now();
  let totalWeight = 0;

  for (const ts of articleTimestamps) {
    const ageHours = (now - ts) / (1000 * 60 * 60);
    totalWeight += newsRecencyDecay(ageHours, halfLifeHours);
  }

  return totalWeight / articleTimestamps.length;
}

// ─── Credible Interval ────────────────────────────────────────────────────

/**
 * 95% credible interval using Beta distribution variance.
 * Var(Beta) = alpha*beta / ((alpha+beta)^2 * (alpha+beta+1))
 */
function credibleInterval(alpha: number, beta: number, z: number = 1.96): [number, number] {
  const n = alpha + beta;
  const mean = alpha / n;
  // Correct Beta variance (not binomial approximation)
  const variance = (alpha * beta) / (n * n * (n + 1));
  const se = Math.sqrt(variance);
  return [
    Math.max(0.01, mean - z * se),
    Math.min(0.99, mean + z * se),
  ];
}

// ─── KL Divergence for Cross-Market Analysis ──────────────────────────────

/**
 * Binary KL divergence: KL(P || Q) for Bernoulli distributions.
 * Measures how much distribution P diverges from Q.
 * Returns Infinity if distributions have incompatible support.
 */
export function klDivergence(p: number, q: number): number {
  const pClamped = Math.max(0.001, Math.min(0.999, p));
  const qClamped = Math.max(0.001, Math.min(0.999, q));

  return (
    pClamped * Math.log(pClamped / qClamped) +
    (1 - pClamped) * Math.log((1 - pClamped) / (1 - qClamped))
  );
}

/**
 * Symmetric KL divergence (Jeffreys divergence / 2).
 * Better for detecting bidirectional mispricings.
 * Note: This is NOT Jensen-Shannon divergence (which uses the midpoint distribution).
 */
export function symmetricKL(p: number, q: number): number {
  return (klDivergence(p, q) + klDivergence(q, p)) / 2;
}

export interface CrossMarketSignal {
  marketIdA: string;
  marketIdB: string;
  titleA: string;
  titleB: string;
  probA: number;
  probB: number;
  impliedConditional: number;
  klDiv: number;
  direction: "buy" | "sell";
  edgeBoost: number;
}

/**
 * Detect cross-market mispricing using conditional probability analysis.
 *
 * Given two related markets A and B where B logically depends on A:
 *   P(B) = P(B|A) × P(A) + P(B|¬A) × P(¬A)
 *
 * If P(B|¬A) ≈ 0 (B can't happen without A):
 *   P(B|A) = P(B) / P(A)
 *
 * If implied P(B|A) is unreasonable, there's a mispricing.
 *
 * Example: "Trump wins primary" = 80%, "Trump wins general" = 70%
 *   Implied P(general | primary) = 0.70 / 0.80 = 87.5%
 *   If model says conditional should be 95%, market underprices general.
 */
export function detectCrossMarketMispricing(
  probA: number,
  probB: number,
  modelConditionalBGivenA: number,
  probBGivenNotA: number = 0,
  klThreshold: number = 0.02
): { mispriced: boolean; impliedConditional: number; klDiv: number; edgeBoost: number } {
  // Implied P(B|A) from market prices
  const impliedConditional = probA > 0.01
    ? (probB - probBGivenNotA * (1 - probA)) / probA
    : 0;

  const clampedImplied = Math.max(0.01, Math.min(0.99, impliedConditional));
  const clampedModel = Math.max(0.01, Math.min(0.99, modelConditionalBGivenA));

  const klDiv = symmetricKL(clampedModel, clampedImplied);

  // Edge boost = difference between model and implied conditional, scaled down
  const edgeBoost = Math.abs(clampedModel - clampedImplied) * 0.3;

  return {
    mispriced: klDiv > klThreshold,
    impliedConditional: clampedImplied,
    klDiv,
    edgeBoost: klDiv > klThreshold ? edgeBoost : 0,
  };
}

/**
 * Scan a group of sibling markets for internal inconsistencies.
 * Returns signals for markets that are mispriced relative to their siblings.
 *
 * For multi-outcome markets (A, B, C candidates):
 *   Sum of probabilities should ≈ 1.0
 *   If sum > 1.05, all are overpriced → short the weakest
 *   If sum < 0.95, all are underpriced → buy the strongest
 */
export function scanSiblingConsistency(
  siblings: Array<{ id: string; title: string; probability: number; marketPrice: number }>
): CrossMarketSignal[] {
  const signals: CrossMarketSignal[] = [];

  if (siblings.length < 2) return signals;

  const sumMarket = siblings.reduce((s, m) => s + m.marketPrice, 0);
  if (sumMarket <= 0) return signals; // Guard division by zero

  // Check if market prices sum deviates from 1.0 (mutually exclusive outcomes)
  const marketDeviation = Math.abs(sumMarket - 1.0);
  if (marketDeviation < 0.03) return signals; // Markets are consistent

  // Market sum != 1.0: find which siblings are most mispriced
  for (const market of siblings) {
    // Fair share: if outcomes are exclusive, each price should be its fraction of 1.0
    const fairPrice = market.marketPrice / sumMarket; // Normalized to sum=1
    const rawPrice = market.marketPrice;

    // Mispricing: difference between raw price and fair share of total
    const mispricing = Math.abs(rawPrice - fairPrice);
    if (mispricing < 0.02) continue;

    const klDiv = symmetricKL(
      Math.max(0.01, Math.min(0.99, fairPrice)),
      Math.max(0.01, Math.min(0.99, rawPrice))
    );

    if (klDiv > 0.01) {
      signals.push({
        marketIdA: market.id,
        marketIdB: market.id,
        titleA: market.title,
        titleB: `sibling-group (sum=${sumMarket.toFixed(3)})`,
        probA: fairPrice,
        probB: rawPrice,
        impliedConditional: fairPrice,
        klDiv,
        direction: fairPrice > rawPrice ? "buy" : "sell",
        edgeBoost: mispricing * 0.2,
      });
    }
  }

  return signals;
}
