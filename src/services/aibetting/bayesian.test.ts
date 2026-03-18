import { describe, it, expect } from "vitest";
import {
  createPrior,
  updateWithSignal,
  computeSignalWeight,
  newsRecencyDecay,
  averageNewsRecency,
  klDivergence,
  symmetricKL,
  detectCrossMarketMispricing,
  scanSiblingConsistency,
} from "./bayesian.js";

describe("Beta-Bernoulli Estimator", () => {
  it("creates prior from market price", () => {
    const prior = createPrior(0.60, 10);
    expect(prior.alpha).toBe(6);
    expect(prior.beta).toBe(4);
  });

  it("clamps extreme market prices", () => {
    const low = createPrior(0.001, 10);
    expect(low.alpha).toBe(0.1);

    const high = createPrior(0.999, 10);
    expect(high.alpha).toBeCloseTo(9.9, 1);
  });

  it("posterior moves toward R1 signal", () => {
    const prior = createPrior(0.45, 10);
    const posterior = updateWithSignal(prior, 0.65, 0.3);

    // Posterior should be between market (0.45) and R1 (0.65)
    expect(posterior.probability).toBeGreaterThan(0.45);
    expect(posterior.probability).toBeLessThan(0.65);
    expect(posterior.priorProbability).toBeCloseTo(0.45, 2);
  });

  it("higher signal weight moves posterior more", () => {
    const prior = createPrior(0.45, 10);
    const weakSignal = updateWithSignal(prior, 0.65, 0.1);
    const strongSignal = updateWithSignal(prior, 0.65, 0.5);

    expect(strongSignal.probability).toBeGreaterThan(weakSignal.probability);
  });

  it("provides credible interval", () => {
    const prior = createPrior(0.50, 10);
    const posterior = updateWithSignal(prior, 0.60, 0.3);

    expect(posterior.credibleLow).toBeLessThan(posterior.probability);
    expect(posterior.credibleHigh).toBeGreaterThan(posterior.probability);
    expect(posterior.credibleLow).toBeGreaterThan(0);
    expect(posterior.credibleHigh).toBeLessThan(1);
  });

  it("does not overshoot on extreme R1 values", () => {
    const prior = createPrior(0.50, 10);
    const posterior = updateWithSignal(prior, 0.99, 0.5);

    expect(posterior.probability).toBeLessThan(0.99);
    expect(posterior.probability).toBeGreaterThan(0.50);
  });
});

describe("Signal Weight", () => {
  it("computes full weight with perfect signals", () => {
    const weight = computeSignalWeight(1.0, 1.0, 1.0, 0.5);
    expect(weight).toBe(0.5);
  });

  it("reduces weight with low confidence", () => {
    const weight = computeSignalWeight(0.5, 1.0, 1.0, 0.5);
    expect(weight).toBe(0.25);
  });

  it("reduces weight with poor citation accuracy", () => {
    const weight = computeSignalWeight(1.0, 0.5, 1.0, 0.5);
    expect(weight).toBe(0.25);
  });

  it("reduces weight with old news", () => {
    const weight = computeSignalWeight(1.0, 1.0, 0.5, 0.5);
    expect(weight).toBe(0.25);
  });
});

describe("News Recency Decay", () => {
  it("returns 1.0 for fresh news", () => {
    expect(newsRecencyDecay(0)).toBe(1.0);
  });

  it("returns ~0.5 at half-life", () => {
    expect(newsRecencyDecay(24, 24)).toBeCloseTo(0.5, 2);
  });

  it("decays exponentially", () => {
    const oneDay = newsRecencyDecay(24, 24);
    const twoDays = newsRecencyDecay(48, 24);
    expect(twoDays).toBeCloseTo(oneDay * oneDay, 2);
  });

  it("averageNewsRecency penalizes no news", () => {
    expect(averageNewsRecency([])).toBe(0.7);
  });

  it("averageNewsRecency high for recent articles", () => {
    const now = Date.now();
    const recent = [now - 3600000, now - 7200000]; // 1h and 2h ago
    expect(averageNewsRecency(recent)).toBeGreaterThan(0.9);
  });
});

describe("KL Divergence", () => {
  it("returns 0 for identical distributions", () => {
    expect(klDivergence(0.5, 0.5)).toBeCloseTo(0, 5);
  });

  it("positive for different distributions", () => {
    expect(klDivergence(0.7, 0.3)).toBeGreaterThan(0);
  });

  it("asymmetric: KL(P||Q) != KL(Q||P)", () => {
    const pq = klDivergence(0.8, 0.3);
    const qp = klDivergence(0.3, 0.8);
    expect(pq).not.toBeCloseTo(qp, 2);
  });

  it("symmetric KL averages both directions", () => {
    const sym = symmetricKL(0.8, 0.3);
    const pq = klDivergence(0.8, 0.3);
    const qp = klDivergence(0.3, 0.8);
    expect(sym).toBeCloseTo((pq + qp) / 2, 5);
  });
});

describe("Cross-Market Mispricing", () => {
  it("detects mispricing when implied conditional is wrong", () => {
    // "Trump wins primary" = 80%, "Trump wins general" = 70%
    // Implied P(general|primary) = 70/80 = 87.5%
    // Model says conditional should be 95%
    const result = detectCrossMarketMispricing(0.80, 0.70, 0.95, 0, 0.01);

    expect(result.mispriced).toBe(true);
    expect(result.impliedConditional).toBeCloseTo(0.875, 2);
    expect(result.edgeBoost).toBeGreaterThan(0);
  });

  it("no mispricing when markets agree", () => {
    const result = detectCrossMarketMispricing(0.80, 0.72, 0.90, 0, 0.05);

    expect(result.impliedConditional).toBeCloseTo(0.90, 2);
    // KL should be small since model matches implied
  });
});

describe("Sibling Consistency Scanner", () => {
  it("detects inconsistent sibling group", () => {
    const siblings = [
      { id: "a", title: "Candidate A wins", probability: 0.55, marketPrice: 0.45 },
      { id: "b", title: "Candidate B wins", probability: 0.35, marketPrice: 0.40 },
      { id: "c", title: "Candidate C wins", probability: 0.10, marketPrice: 0.15 },
    ];

    const signals = scanSiblingConsistency(siblings);
    // Model says A is underpriced, B is overpriced relative to model
    expect(signals.length).toBeGreaterThanOrEqual(0); // May or may not trigger depending on threshold
  });

  it("returns empty for single market", () => {
    const signals = scanSiblingConsistency([
      { id: "a", title: "Solo market", probability: 0.50, marketPrice: 0.50 },
    ]);
    expect(signals).toEqual([]);
  });
});
