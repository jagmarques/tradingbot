import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateWeightedConsensus, detectDisagreement, analyzeMarketEnsemble } from "./ensemble.js";
import type { PolymarketEvent, AIAnalysis, MarketCategory } from "./types.js";

vi.mock("./analyzer.js", () => ({
  analyzeMarket: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn(() => true),
}));

vi.mock("../database/calibration.js", () => ({
  getTrustScore: vi.fn(() => 0.8),
}));

import { analyzeMarket } from "./analyzer.js";
import { getTrustScore } from "../database/calibration.js";

function makeMarket(overrides: Partial<PolymarketEvent> = {}): PolymarketEvent {
  return {
    conditionId: "market-1",
    questionId: "q-1",
    slug: "test-market",
    title: "Test Market",
    description: "A test market",
    category: "politics",
    endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    volume24h: 50000,
    liquidity: 10000,
    outcomes: [
      { tokenId: "token-yes", name: "Yes", price: 0.5 },
      { tokenId: "token-no", name: "No", price: 0.5 },
    ],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AIAnalysis> = {}): AIAnalysis {
  return {
    marketId: "market-1",
    probability: 0.7,
    confidence: 0.8,
    reasoning: "Test reasoning",
    keyFactors: ["factor1"],
    timestamp: Date.now(),
    evidenceCited: ["test evidence"],
    consistencyNote: "first analysis",
    citationAccuracy: 1.0,
    timeline: null,
    ...overrides,
  };
}

describe("detectDisagreement", () => {
  it("should return low disagreement when estimates agree", () => {
    const result = detectDisagreement([0.7, 0.72, 0.68], [1, 1, 1]);

    expect(result.disagreement).toBeLessThan(0.04);
    expect(result.highDisagreement).toBe(false);
  });

  it("should flag high disagreement when estimates diverge", () => {
    const result = detectDisagreement([0.3, 0.8, 0.5], [1, 1, 1]);

    expect(result.disagreement).toBeGreaterThan(0.04);
    expect(result.highDisagreement).toBe(true);
  });

  it("should handle empty weights gracefully", () => {
    const result = detectDisagreement([], []);

    expect(result.disagreement).toBe(0);
    expect(result.highDisagreement).toBe(false);
  });

  it("should weight higher-trust estimates more in variance", () => {
    // Same probs, different weights -> different variance
    const equal = detectDisagreement([0.3, 0.8], [1, 1]);
    const weighted = detectDisagreement([0.3, 0.8], [0.2, 0.9]);

    expect(equal.disagreement).not.toEqual(weighted.disagreement);
  });
});

describe("calculateWeightedConsensus", () => {
  beforeEach(() => {
    vi.mocked(getTrustScore).mockReturnValue(1.0);
  });

  it("should calculate weighted average probability with equal weights", () => {
    const analyses = [
      makeAnalysis({ probability: 0.6 }),
      makeAnalysis({ probability: 0.8 }),
      makeAnalysis({ probability: 0.7 }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    expect(result.consensus.probability).toBeCloseTo(0.7);
    expect(result.ensembleSize).toBe(3);
  });

  it("should weight estimates by trust scores", () => {
    vi.mocked(getTrustScore).mockReturnValue(0.5);

    const analyses = [
      makeAnalysis({ probability: 0.6 }),
      makeAnalysis({ probability: 0.8 }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    // Equal weights (both get 0.5) -> simple average
    expect(result.consensus.probability).toBeCloseTo(0.7);
    expect(result.weights).toEqual([0.5, 0.5]);
  });

  it("should combine reasoning from all analyses", () => {
    const analyses = [
      makeAnalysis({ reasoning: "Point A" }),
      makeAnalysis({ reasoning: "Point B" }),
      makeAnalysis({ reasoning: "Point C" }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    expect(result.consensus.reasoning).toBe("Point A | Point B | Point C");
  });

  it("should deduplicate key factors", () => {
    const analyses = [
      makeAnalysis({ keyFactors: ["economy", "polls"] }),
      makeAnalysis({ keyFactors: ["polls", "incumbency"] }),
      makeAnalysis({ keyFactors: ["economy", "demographics"] }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    expect(result.consensus.keyFactors).toEqual([
      "economy",
      "polls",
      "incumbency",
      "demographics",
    ]);
  });

  it("should report low disagreement when estimates agree", () => {
    const analyses = [
      makeAnalysis({ probability: 0.70 }),
      makeAnalysis({ probability: 0.72 }),
      makeAnalysis({ probability: 0.68 }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    expect(result.highDisagreement).toBe(false);
    expect(result.disagreement).toBeLessThan(0.04);
  });

  it("should flag high disagreement when estimates diverge", () => {
    const analyses = [
      makeAnalysis({ probability: 0.3 }),
      makeAnalysis({ probability: 0.8 }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    expect(result.highDisagreement).toBe(true);
    expect(result.disagreement).toBeGreaterThan(0.04);
  });

  it("should handle 2-estimate edge case", () => {
    const analyses = [
      makeAnalysis({ probability: 0.6 }),
      makeAnalysis({ probability: 0.8 }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    expect(result.consensus.probability).toBeCloseTo(0.7);
    expect(result.ensembleSize).toBe(2);
    expect(result.individualEstimates).toEqual([0.6, 0.8]);
  });

  it("should fallback to 1.0 when getTrustScore throws", () => {
    vi.mocked(getTrustScore).mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    const analyses = [
      makeAnalysis({ probability: 0.6 }),
      makeAnalysis({ probability: 0.8 }),
    ];

    const result = calculateWeightedConsensus(analyses, "politics");

    // Falls back to weight 1.0 -> simple average
    expect(result.consensus.probability).toBeCloseTo(0.7);
    expect(result.weights).toEqual([1.0, 1.0]);
  });
});

describe("analyzeMarketEnsemble", () => {
  beforeEach(() => {
    vi.mocked(analyzeMarket).mockReset();
    vi.mocked(getTrustScore).mockReturnValue(1.0);
  });

  it("should run single analysis and return result", async () => {
    vi.mocked(analyzeMarket)
      .mockResolvedValueOnce(makeAnalysis({ probability: 0.7 }));

    const market = makeMarket();
    const result = await analyzeMarketEnsemble(market, []);

    expect(result).not.toBeNull();
    expect(result!.ensembleSize).toBe(1);
    expect(result!.consensus.probability).toBeCloseTo(0.7);
    expect(vi.mocked(analyzeMarket)).toHaveBeenCalledTimes(1);
  });

  it("should return null when analysis fails", async () => {
    vi.mocked(analyzeMarket)
      .mockRejectedValueOnce(new Error("fail"));

    const market = makeMarket();
    const result = await analyzeMarketEnsemble(market, []);

    expect(result).toBeNull();
  });

  it("should return null when analysis returns null", async () => {
    vi.mocked(analyzeMarket)
      .mockResolvedValueOnce(null);

    const market = makeMarket();
    const result = await analyzeMarketEnsemble(market, []);

    expect(result).toBeNull();
  });
});
