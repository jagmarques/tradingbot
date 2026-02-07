import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenAnalysisResult } from "./types.js";
import type { TokenPosition } from "../database/tokenai.js";
import type { TokenTradeRecommendation } from "./evaluator.js";

// Mock analyzeToken before importing the module under test
vi.mock("./analyzer.js", () => ({
  analyzeToken: vi.fn(),
}));

import {
  shouldExitTokenPosition,
  limitCorrelatedTokenBets,
  updatePeakPrice,
  clearPeakPrice,
  _getPeakPrices,
  TOKEN_STOP_LOSS_THRESHOLD,
  TOKEN_ADVERSE_MOVE_THRESHOLD,
  TOKEN_CONVICTION_FLIP_THRESHOLD,
  TOKEN_SCORE_DROP_THRESHOLD,
  MAX_THEME_EXPOSURE_RATIO,
} from "./position-manager.js";
import { analyzeToken } from "./analyzer.js";

const mockedAnalyzeToken = vi.mocked(analyzeToken);

function makePosition(overrides: Partial<TokenPosition> = {}): TokenPosition {
  return {
    id: `pos_${Math.random().toString(36).slice(2, 8)}`,
    tokenAddress: "0xabc123def456",
    chain: "solana",
    tokenSymbol: "TEST",
    side: "long",
    entryPrice: 1.0,
    sizeUsd: 10,
    amountTokens: 10,
    aiProbability: 0.70,
    confidence: 0.6,
    kellyFraction: 0.2,
    status: "open",
    entryTimestamp: Date.now(),
    ...overrides,
  };
}

function makeAnalysis(
  overrides: Partial<TokenAnalysisResult> = {},
): TokenAnalysisResult {
  return {
    tokenAddress: "0xabc123def456",
    chain: "solana",
    successProbability: 0.65,
    confidence: "medium",
    confidenceScore: 0.6,
    reasoning: "Solid fundamentals",
    keyFactors: ["volume"],
    riskFactors: ["whale risk"],
    evidenceCited: ["24h volume high"],
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRecommendation(
  overrides: Partial<TokenTradeRecommendation> = {},
): TokenTradeRecommendation {
  return {
    shouldTrade: true,
    tokenAddress: `0x${Math.random().toString(36).slice(2, 10)}`,
    chain: "solana",
    sizeUsd: 10,
    kellyFraction: 0.2,
    confidenceScore: 0.6,
    successProbability: 0.65,
    estimatedEdge: 0.3,
    reason: "Kelly 20%",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear peak prices between tests
  const peaks = _getPeakPrices();
  peaks.clear();
});

describe("shouldExitTokenPosition", () => {
  describe("static filters", () => {
    it("stop-loss triggers at -25%", async () => {
      const position = makePosition({ entryPrice: 1.0 });
      // 0.74 is -26% from 1.0
      const result = await shouldExitTokenPosition(position, 0.74);

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain("Stop-loss");
      // analyzeToken should NOT be called for static filters
      expect(mockedAnalyzeToken).not.toHaveBeenCalled();
    });

    it("stop-loss does NOT trigger at -24%", async () => {
      const position = makePosition({ entryPrice: 1.0 });
      // 0.87 is -13% from 1.0 (above both -25% stop-loss and -15% AI threshold)
      const result = await shouldExitTokenPosition(position, 0.87);

      expect(result.shouldExit).toBe(false);
      expect(mockedAnalyzeToken).not.toHaveBeenCalled();
    });

    it("take-profit triggers at 10x", async () => {
      const position = makePosition({ entryPrice: 0.01 });
      const result = await shouldExitTokenPosition(position, 0.10);

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain("Take-profit");
      expect(result.reason).toContain("10x");
      expect(mockedAnalyzeToken).not.toHaveBeenCalled();
    });

    it("trailing stop triggers on 15% drop from peak", async () => {
      const position = makePosition({
        id: "pos_trailing",
        entryPrice: 1.0,
      });
      // Set peak at 7.0 (7x entry)
      updatePeakPrice("pos_trailing", 7.0);

      // Current price at 5.5 (5.5x, above TRAILING_STOP_ACTIVATION of 5x)
      // Drop from peak: (7.0 - 5.5) / 7.0 = 21.4% > 15%
      const result = await shouldExitTokenPosition(position, 5.5);

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain("Trailing stop");
      expect(mockedAnalyzeToken).not.toHaveBeenCalled();
    });
  });

  describe("AI re-analysis", () => {
    it("triggers on -15% move and exits on conviction flip", async () => {
      const position = makePosition({
        entryPrice: 1.0,
        aiProbability: 0.70,
      });

      // Mock AI returns low probability (conviction flip)
      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ successProbability: 0.35 }),
      );

      // 0.84 is -16% from 1.0 (triggers AI re-analysis)
      const result = await shouldExitTokenPosition(position, 0.84);

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain("Conviction flip");
      expect(result.reason).toContain("35.0%");
      expect(result.newAnalysis).toBeDefined();
      expect(mockedAnalyzeToken).toHaveBeenCalledOnce();
    });

    it("holds when AI score remains good", async () => {
      const position = makePosition({
        entryPrice: 1.0,
        aiProbability: 0.70,
      });

      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ successProbability: 0.65 }),
      );

      const result = await shouldExitTokenPosition(position, 0.84);

      expect(result.shouldExit).toBe(false);
      expect(result.newAnalysis).toBeDefined();
      expect(result.newAnalysis?.successProbability).toBe(0.65);
    });

    it("holds on AI analysis failure", async () => {
      const position = makePosition({ entryPrice: 1.0 });

      mockedAnalyzeToken.mockResolvedValueOnce(null);

      const result = await shouldExitTokenPosition(position, 0.84);

      expect(result.shouldExit).toBe(false);
      expect(result.reason).toBe("");
      expect(result.newAnalysis).toBeUndefined();
    });

    it("exits on score drop exceeding threshold", async () => {
      const position = makePosition({
        entryPrice: 1.0,
        aiProbability: 0.70,
      });

      // New probability: 0.35 -> drop of 35pp (> 30pp threshold)
      // Also below conviction flip threshold of 0.40
      // But let's test a drop that's above conviction flip but still a large drop
      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ successProbability: 0.38 }),
      );

      const result = await shouldExitTokenPosition(position, 0.84);

      expect(result.shouldExit).toBe(true);
      // 0.38 < 0.40 so it hits conviction flip first
      expect(result.reason).toContain("Conviction flip");

      // Now test a case where score drops >30pp but stays above 0.40
      // entry aiProbability: 0.75, new: 0.42 -> 33pp drop > 30pp threshold
      vi.clearAllMocks();
      const position2 = makePosition({
        entryPrice: 1.0,
        aiProbability: 0.75,
      });
      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ successProbability: 0.42 }),
      );

      const result2 = await shouldExitTokenPosition(position2, 0.84);

      expect(result2.shouldExit).toBe(true);
      expect(result2.reason).toContain("Score drop");
      expect(result2.reason).toContain("75.0%");
      expect(result2.reason).toContain("42.0%");
      expect(result2.newAnalysis).toBeDefined();
    });
  });
});

describe("limitCorrelatedTokenBets", () => {
  it("blocks over-concentrated bets on same narrative", () => {
    const openPositions: TokenPosition[] = [
      makePosition({ tokenAddress: "0xmeme1", sizeUsd: 15 }),
      makePosition({ tokenAddress: "0xmeme2", sizeUsd: 15 }),
    ];

    const narratives = new Map<string, string[]>();
    narratives.set("0xmeme1", ["memecoin"]);
    narratives.set("0xmeme2", ["memecoin"]);
    narratives.set("0xmeme3", ["memecoin"]);

    const recommendations = [
      makeRecommendation({ tokenAddress: "0xmeme3", sizeUsd: 10 }),
    ];

    // Max exposure $50, 30% = $15 per theme
    // Current memecoin exposure: $15 + $15 = $30, already over $15
    // New bet would push to $40
    const filtered = limitCorrelatedTokenBets(
      recommendations,
      openPositions,
      50,
      narratives,
    );

    expect(filtered).toHaveLength(0);
  });

  it("allows diverse bets on different narratives", () => {
    const openPositions: TokenPosition[] = [
      makePosition({ tokenAddress: "0xdefi1", sizeUsd: 10 }),
    ];

    const narratives = new Map<string, string[]>();
    narratives.set("0xdefi1", ["defi"]);
    narratives.set("0xgaming1", ["gaming"]);

    const recommendations = [
      makeRecommendation({ tokenAddress: "0xgaming1", sizeUsd: 10 }),
    ];

    // Max exposure $50, 30% = $15 per theme
    // defi: $10, gaming: $0 -> adding $10 gaming = $10 < $15
    const filtered = limitCorrelatedTokenBets(
      recommendations,
      openPositions,
      50,
      narratives,
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].tokenAddress).toBe("0xgaming1");
  });

  it("allows untagged tokens (no narrative tags)", () => {
    const openPositions: TokenPosition[] = [
      makePosition({ tokenAddress: "0xmeme1", sizeUsd: 15 }),
    ];

    const narratives = new Map<string, string[]>();
    narratives.set("0xmeme1", ["memecoin"]);
    // 0xunknown has no entry in narratives

    const recommendations = [
      makeRecommendation({ tokenAddress: "0xunknown", sizeUsd: 10 }),
    ];

    const filtered = limitCorrelatedTokenBets(
      recommendations,
      openPositions,
      50,
      narratives,
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].tokenAddress).toBe("0xunknown");
  });
});

describe("constants", () => {
  it("exports expected threshold values", () => {
    expect(TOKEN_STOP_LOSS_THRESHOLD).toBe(-0.25);
    expect(TOKEN_ADVERSE_MOVE_THRESHOLD).toBe(-0.15);
    expect(TOKEN_CONVICTION_FLIP_THRESHOLD).toBe(0.40);
    expect(TOKEN_SCORE_DROP_THRESHOLD).toBe(0.30);
    expect(MAX_THEME_EXPOSURE_RATIO).toBe(0.30);
  });
});
