import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateBetOpportunity, evaluateAllOpportunities, shouldExitPosition, calculateEV } from "./evaluator.js";
import type { PolymarketEvent, AIAnalysis, AIBettingConfig, AIBettingPosition } from "./types.js";

vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn(() => true),
}));

vi.mock("../../utils/dates.js", () => ({
  hoursUntil: vi.fn(() => 48),
}));

vi.mock("./scanner.js", () => ({
  fetchMarketByConditionId: vi.fn(),
}));

vi.mock("./news.js", () => ({
  fetchNewsForMarket: vi.fn(() => []),
}));

vi.mock("./analyzer.js", () => ({
  analyzeMarket: vi.fn(),
}));

import { fetchMarketByConditionId } from "./scanner.js";
import { fetchNewsForMarket } from "./news.js";
import { analyzeMarket } from "./analyzer.js";

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
    evidenceCited: ["test evidence"],
    consistencyNote: "first analysis",
    citationAccuracy: 1.0,
    timeline: null,
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

describe("calculateEV", () => {
  it("should return positive EV for YES bet with AI > market", () => {
    const ev = calculateEV(0.7, 0.5, "YES");
    expect(ev).toBeCloseTo(0.2);
  });

  it("should return negative EV for YES bet with AI < market", () => {
    const ev = calculateEV(0.3, 0.5, "YES");
    expect(ev).toBeCloseTo(-0.2);
  });

  it("should return positive EV for NO bet with market > AI", () => {
    const ev = calculateEV(0.3, 0.5, "NO");
    expect(ev).toBeCloseTo(0.2);
  });

  it("should return zero EV when AI equals market", () => {
    const ev = calculateEV(0.5, 0.5, "YES");
    expect(ev).toBeCloseTo(0);
  });
});

describe("evaluateBetOpportunity", () => {
  it("should recommend YES bet when AI probability > market price", () => {
    const market = makeMarket();
    // Raw 0.65 -> extremized 0.695 -> edge ~0.195, effective ~0.19 (politics +1%, YES -1.5%)
    const analysis = makeAnalysis({ probability: 0.65 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(true);
    expect(decision.side).toBe("YES");
    expect(decision.edge).toBeGreaterThan(0.1);
    expect(decision.tokenId).toBe("token-yes");
  });

  it("should recommend NO bet when AI probability < market price", () => {
    const market = makeMarket();
    // Raw 0.35 -> extremized 0.305 -> edge ~-0.195, effective ~0.22 (politics +1%, NO +1.5%)
    const analysis = makeAnalysis({ probability: 0.35 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(true);
    expect(decision.side).toBe("NO");
    expect(decision.edge).toBeLessThan(-0.1);
    expect(decision.tokenId).toBe("token-no");
  });

  it("should reject when confidence is too low", () => {
    const market = makeMarket();
    const analysis = makeAnalysis({ confidence: 0.4 }); // Below 60% min
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(false);
    expect(decision.reason).toContain("Confidence too low");
  });

  it("should handle floating point confidence near threshold", () => {
    const market = makeMarket();
    // Floating point edge case: 0.5999... should round to 0.60
    const analysis = makeAnalysis({ probability: 0.7, confidence: 0.5999999999999999 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    // Should round to 0.60 and pass the 0.60 threshold
    expect(decision.shouldBet).toBe(true);
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

  it("should reject when AI disagrees with market by more than 30pp", () => {
    const market = makeMarket(); // market price 50%
    const analysis = makeAnalysis({ probability: 0.85 }); // AI says 85% = 35pp disagreement
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(false);
    expect(decision.reason).toContain("Market disagreement too high");
  });

  it("should accept when AI disagrees with market within 30pp", () => {
    const market = makeMarket(); // market price 50%
    // Raw 0.70 -> extremized 0.76 -> absEdge 0.26 < 30pp cap
    const analysis = makeAnalysis({ probability: 0.70 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.shouldBet).toBe(true);
  });

  it("should cap bet size at maxBetSize", () => {
    const market = makeMarket();
    // Raw 0.70 -> extremized 0.76 -> absEdge 0.26 (within 30pp cap)
    const analysis = makeAnalysis({ probability: 0.70, confidence: 0.95 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 100000);

    expect(decision.recommendedSize).toBeLessThanOrEqual(mockConfig.maxBetSize);
  });

  it("should use NO token ID when betting NO", () => {
    const market = makeMarket();
    // Raw 0.35 -> extremized 0.305 -> edge -0.195 -> NO side
    const analysis = makeAnalysis({ probability: 0.35 });
    const decision = evaluateBetOpportunity(market, analysis, mockConfig, 0, 10000);

    expect(decision.side).toBe("NO");
    expect(decision.tokenId).toBe("token-no");
  });
});

describe("evaluateAllOpportunities", () => {
  it("should return only positive decisions sorted by EV", () => {
    const markets = [
      makeMarket({ conditionId: "m1", title: "Will Bitcoin reach 100k" }),
      makeMarket({ conditionId: "m2", title: "Will Ethereum flip Bitcoin" }),
      makeMarket({ conditionId: "m3", title: "Will Trump win election" }),
    ];

    const analyses = new Map<string, AIAnalysis>();
    // m1: raw 0.62 -> ext 0.656, edge ~15.6%
    analyses.set("m1", makeAnalysis({ marketId: "m1", probability: 0.62 }));
    // m2: raw 0.52 -> ext 0.526, edge ~2.6% (below min)
    analyses.set("m2", makeAnalysis({ marketId: "m2", probability: 0.52 }));
    // m3: raw 0.70 -> ext 0.76, edge ~26% (within 30pp cap)
    analyses.set("m3", makeAnalysis({ marketId: "m3", probability: 0.70 }));

    const decisions = evaluateAllOpportunities(markets, analyses, mockConfig, [], 10000);

    // Only m1 and m3 should pass (m2 edge too small)
    expect(decisions.length).toBe(2);
    // Sorted by EV descending - m3 (26%) first, m1 (15.6%) second
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
  beforeEach(() => {
    vi.mocked(fetchMarketByConditionId).mockReset();
    vi.mocked(fetchNewsForMarket).mockReset();
    vi.mocked(analyzeMarket).mockReset();
  });

  it("should not exit a healthy position", async () => {
    const position = makePosition({ entryPrice: 0.5 });
    const result = await shouldExitPosition(position, 0.55, null);

    expect(result.shouldExit).toBe(false);
  });

  it("should exit when price drops >15% and fresh AI shows negative EV", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5, aiProbability: 0.7 });
    const currentPrice = 0.40; // 20% drop against position

    // Mock successful market fetch
    vi.mocked(fetchMarketByConditionId).mockResolvedValue(makeMarket());

    // Mock AI re-analysis: probability 0.35, market at 0.40 -> EV = 0.35 - 0.40 = -0.05 (negative)
    vi.mocked(analyzeMarket).mockResolvedValue(
      makeAnalysis({ probability: 0.35, confidence: 0.7 })
    );

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("EV negative");
  });

  it("should stay in when price drops >15% but AI still confident", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5, aiProbability: 0.7 });
    const currentPrice = 0.40; // 20% drop against position

    // Mock successful market fetch
    vi.mocked(fetchMarketByConditionId).mockResolvedValue(makeMarket());

    // Mock AI re-analysis: probability 0.68, market at 0.40 -> EV = 0.68 - 0.40 = +0.28 (positive)
    vi.mocked(analyzeMarket).mockResolvedValue(
      makeAnalysis({ probability: 0.68, confidence: 0.75 })
    );

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(false);
    expect(vi.mocked(fetchMarketByConditionId)).toHaveBeenCalled();
    expect(vi.mocked(analyzeMarket)).toHaveBeenCalled();
  });

  it("should exit on stop-loss when P&L exceeds -25%", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    const currentPrice = 0.35; // 30% loss

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Stop-loss");
    // Should NOT call fetchMarketByConditionId (stop-loss fires before re-analysis)
    expect(vi.mocked(fetchMarketByConditionId)).not.toHaveBeenCalled();
  });

  it("should exit on conviction flip when AI favors opposite side", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5, aiProbability: 0.7 });
    const currentPrice = 0.40; // 20% drop

    // Mock successful market fetch
    vi.mocked(fetchMarketByConditionId).mockResolvedValue(makeMarket());

    // Mock AI re-analysis: probability 0.30 (AI now favors NO strongly)
    // EV = 0.30 - 0.40 = -0.10 (negative, will trigger "EV negative" before "Conviction flip")
    vi.mocked(analyzeMarket).mockResolvedValue(
      makeAnalysis({ probability: 0.30, confidence: 0.7 })
    );

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(true);
    // Both "EV negative" and "Conviction flip" are valid exit reasons here - either can fire
    expect(result.reason).toMatch(/EV negative|Conviction flip/);
  });

  it("should NOT exit when price drops exactly at stop-loss boundary", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    const currentPrice = 0.375; // exactly -25%

    const result = await shouldExitPosition(position, currentPrice, null);

    // Stop-loss is < -0.25, so exactly -25% should NOT trigger
    expect(result.shouldExit).toBe(false);
  });

  it("should stay in when price drops >15% but market data unavailable", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5, aiProbability: 0.7 });
    const currentPrice = 0.40; // 20% drop

    // Mock failed market fetch
    vi.mocked(fetchMarketByConditionId).mockResolvedValue(null);

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(false);
    expect(vi.mocked(fetchMarketByConditionId)).toHaveBeenCalled();
    expect(vi.mocked(analyzeMarket)).not.toHaveBeenCalled();
  });

  it("should stay in when price drops >15% but AI re-analysis fails", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5, aiProbability: 0.7 });
    const currentPrice = 0.40; // 20% drop

    // Mock successful market fetch
    vi.mocked(fetchMarketByConditionId).mockResolvedValue(makeMarket());

    // Mock failed AI re-analysis
    vi.mocked(analyzeMarket).mockResolvedValue(null);

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(false);
    expect(vi.mocked(fetchMarketByConditionId)).toHaveBeenCalled();
    expect(vi.mocked(analyzeMarket)).toHaveBeenCalled();
  });

  it("should NOT trigger re-analysis for small price moves", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5, aiProbability: 0.7 });
    const currentPrice = 0.45; // 10% drop - below 15% threshold

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(false);
    expect(vi.mocked(fetchMarketByConditionId)).not.toHaveBeenCalled();
  });

  it("should exit when price drops >15% against NO position and AI shows negative EV", async () => {
    const position = makePosition({ side: "NO", entryPrice: 0.5, aiProbability: 0.30 });
    const currentPrice = 0.40; // NO token price dropped 20% - bad for NO holder

    // Mock successful market fetch
    vi.mocked(fetchMarketByConditionId).mockResolvedValue(makeMarket());

    // AI re-analysis: probability 0.65, yesPrice = 1 - 0.40 = 0.60
    // NO EV = yesPrice - probability = 0.60 - 0.65 = -0.05 (negative -> exit)
    vi.mocked(analyzeMarket).mockResolvedValue(
      makeAnalysis({ probability: 0.65, confidence: 0.7 })
    );

    const result = await shouldExitPosition(position, currentPrice, null);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("EV negative");
  });

  it("should exit when AI edge reverses significantly", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    // AI now says probability is 0.4, current price 0.55 -> EV = 0.4 - 0.55 = -0.15 (negative)
    const analysis = makeAnalysis({ probability: 0.4, confidence: 0.8 });
    const result = await shouldExitPosition(position, 0.55, analysis);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Edge reversed");
    expect(result.reason).toContain("EV");
  });

  it("should not exit when AI edge is still positive", async () => {
    const position = makePosition({ side: "YES", entryPrice: 0.5 });
    const analysis = makeAnalysis({ probability: 0.65, confidence: 0.8 });
    const result = await shouldExitPosition(position, 0.55, analysis);

    // newEdge = 0.65 - 0.55 = 0.10 (positive, keep position)
    expect(result.shouldExit).toBe(false);
  });
});
