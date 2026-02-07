import { describe, it, expect, vi } from "vitest";
import { evaluateBetOpportunity, evaluateAllOpportunities, shouldExitPosition } from "./evaluator.js";
import type { PolymarketEvent, AIAnalysis, AIBettingConfig, AIBettingPosition } from "./types.js";

vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn(() => true),
}));

vi.mock("../../utils/dates.js", () => ({
  hoursUntil: vi.fn(() => 48),
}));

const mockConfig: AIBettingConfig = {
  maxBetSize: 10,
  maxTotalExposure: 50,
  maxPositions: 5,
  minEdge: 0.05,
  minConfidence: 0.6,
  scanIntervalMs: 300000,
  categoriesEnabled: ["politics", "crypto", "sports"],
};

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
    ...overrides,
  };
}

function makePosition(overrides: Partial<AIBettingPosition> = {}): AIBettingPosition {
  return {
    id: "pos-1",
    marketId: "market-1",
    marketTitle: "Test Market",
    marketEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    tokenId: "token-yes",
    side: "YES",
    entryPrice: 0.5,
    size: 10,
    aiProbability: 0.7,
    confidence: 0.8,
    expectedValue: 0.2,
    status: "open",
    entryTimestamp: Date.now() - 60000,
    ...overrides,
  };
}

describe("evaluateBetOpportunity", () => {
  it("should recommend YES bet when AI probability > market price", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ probability: 0.7 }); // AI says 70%, market says 50%
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(true);
    expect(decision.side).toBe("YES");
    expect(decision.edge).toBeCloseTo(0.2);
    expect(decision.tokenId).toBe("token-yes");
  });

  it("should recommend NO bet when AI probability < market price", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ probability: 0.3 }); // AI says 30%, market says 50%
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(true);
    expect(decision.side).toBe("NO");
    expect(decision.edge).toBeCloseTo(-0.2);
    expect(decision.tokenId).toBe("token-no");
  });

  it("should reject when confidence is too low", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ confidence: 0.4 }); // Below 60% min
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(false);
    expect(decision.reason).toContain("Confidence too low");
  });

  it("should reject when edge is too small", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ probability: 0.52 }); // Only 2% edge, below 5% min
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(false);
    expect(decision.reason).toContain("Edge too small");
  });

  it("should reject when bankroll is insufficient", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ probability: 0.7 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 0.5); // Only $0.50

    expect(decision.shouldBet).toBe(false);
    expect(decision.reason).toContain("Insufficient bankroll");
  });

  it("should cap bet size at maxBetSize", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ probability: 0.9, confidence: 0.95 }); // Very strong signal
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 100000);

    expect(decision.recommendedSize).toBeLessThanOrEqual(mockConfig.maxBetSize);
  });

  it("should use NO token ID when betting NO", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ probability: 0.2 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.side).toBe("NO");
    expect(decision.tokenId).toBe("token-no");
  });
});

describe("evaluateAllOpportunities", () => {
  it("should return only positive decisions sorted by EV", () => {
    const markets = [
      makeMarket({ conditionId: "m1" }),
      makeMarket({ conditionId: "m2" }),
      makeMarket({ conditionId: "m3" }),
    ];

    const analyses = new Map<string, AIAnalysis>();
    analyses.set("m1", makeAnalysis({ marketId: "m1", probability: 0.7 })); // 20% edge
    analyses.set("m2", makeAnalysis({ marketId: "m2", probability: 0.52 })); // 2% edge (below min)
    analyses.set("m3", makeAnalysis({ marketId: "m3", probability: 0.8 })); // 30% edge

    const decisions = evaluateAllOpportunities(markets, analyses, mockConfig, [], 10000);

    // Only m1 and m3 should pass (m2 edge too small)
    expect(decisions.length).toBe(2);
    // Sorted by EV descending - m3 (30%) first, m1 (20%) second
    expect(decisions[0].marketId).toBe("m3");
    expect(decisions[1].marketId).toBe("m1");
  });

  it("should skip markets without analysis", () => {
    const markets = [makeMarket({ conditionId: "m1" })];
    const analyses = new Map<string, AIAnalysis>(); // Empty

    const decisions = evaluateAllOpportunities(markets, analyses, mockConfig, [], 10000);
    expect(decisions.length).toBe(0);
  });
});

describe("shouldExitPosition", () => {
  it("should not exit a healthy position", () => {
    const position = makePosition({ entryPrice: 0.5 });
    const result = shouldExitPosition(position, 0.55, null);

    expect(result.shouldExit).toBe(false);
  });

  it("should trigger stop loss when price moves >25% against YES position", () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    const result = shouldExitPosition(position, 0.3, null); // 40% drop

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Stop loss");
  });

  it("should trigger stop loss when price moves >25% against NO position", () => {
    const position = makePosition({ side: "NO", entryPrice: 0.5 });
    const result = shouldExitPosition(position, 0.7, null); // Price went up 40% (bad for NO)

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Stop loss");
  });

  it("should exit when AI confidence drops below 0.4", () => {
    const position = makePosition();
    const analysis = makeAnalysis({ confidence: 0.3 });
    const result = shouldExitPosition(position, 0.5, analysis);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Confidence dropped");
  });

  it("should exit when AI edge reverses significantly", () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    // AI now says probability is 0.4, but position is YES - edge reversed
    const analysis = makeAnalysis({ probability: 0.4, confidence: 0.8 });
    const result = shouldExitPosition(position, 0.55, analysis);

    // newEdge = 0.4 - 0.55 = -0.15 (< -0.05 threshold)
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("edge reversed");
  });

  it("should not exit when AI edge is still positive", () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    const analysis = makeAnalysis({ probability: 0.65, confidence: 0.8 });
    const result = shouldExitPosition(position, 0.55, analysis);

    // newEdge = 0.65 - 0.55 = 0.10 (positive, keep position)
    expect(result.shouldExit).toBe(false);
  });
});
