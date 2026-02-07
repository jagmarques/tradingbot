import { describe, it, expect } from "vitest";
import {
  evaluateToken,
  calculateTokenKelly,
  DEFAULT_TOKEN_AI_CONFIG,
} from "./evaluator.js";
import type { TokenAIConfig } from "./evaluator.js";
import type { TokenAnalysisResult } from "./types.js";
import type { TokenPosition } from "../database/tokenai.js";

const baseAnalysis: TokenAnalysisResult = {
  tokenAddress: "0xabc123def456",
  chain: "solana",
  successProbability: 0.35,
  confidence: "medium",
  confidenceScore: 0.6,
  reasoning: "Strong social buzz with decent liquidity",
  keyFactors: ["high volume", "trending narrative"],
  riskFactors: ["whale concentration", "no audit"],
  evidenceCited: ["24h volume $500k"],
  analyzedAt: new Date().toISOString(),
};

function makePosition(overrides: Partial<TokenPosition> = {}): TokenPosition {
  return {
    id: `pos_${Math.random().toString(36).slice(2, 8)}`,
    tokenAddress: "0xother",
    chain: "solana",
    side: "long",
    entryPrice: 0.001,
    sizeUsd: 10,
    amountTokens: 10000,
    aiProbability: 0.3,
    confidence: 0.6,
    kellyFraction: 0.1,
    status: "open",
    entryTimestamp: Date.now(),
    ...overrides,
  };
}

describe("calculateTokenKelly", () => {
  it("returns positive fraction when probability > 0.5 for 2x payoff", () => {
    const kelly = calculateTokenKelly(0.6, 2.0);
    // Kelly = (1*0.6 - 0.4) / 1 = 0.2
    expect(kelly).toBeCloseTo(0.2, 4);
  });

  it("returns zero when probability equals breakeven", () => {
    const kelly = calculateTokenKelly(0.5, 2.0);
    // Kelly = (1*0.5 - 0.5) / 1 = 0
    expect(kelly).toBeCloseTo(0, 4);
  });

  it("returns zero for negative EV (probability < 0.5)", () => {
    const kelly = calculateTokenKelly(0.3, 2.0);
    expect(kelly).toBe(0);
  });

  it("works with different payoff multiples", () => {
    // 3x payoff: b=2, Kelly = (2*0.4 - 0.6) / 2 = 0.1
    const kelly = calculateTokenKelly(0.4, 3.0);
    expect(kelly).toBeCloseTo(0.1, 4);
  });
});

// Config with larger bankroll proxy to test sizing without hitting min bet floor
const sizingConfig: TokenAIConfig = {
  ...DEFAULT_TOKEN_AI_CONFIG,
  maxExposureUsd: 200,
  maxBetUsd: 50,
  minBetUsd: 1,
};

describe("evaluateToken", () => {
  it("produces positive recommendation with medium confidence", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.85,
      confidence: "medium",
      confidenceScore: 0.6,
    };

    // P=0.85: Kelly=0.7, raw=0.7*0.25*50=8.75, medium=6.125 -> above $5
    const rec = evaluateToken(analysis);
    expect(rec.shouldTrade).toBe(true);
    expect(rec.sizeUsd).toBeGreaterThanOrEqual(DEFAULT_TOKEN_AI_CONFIG.minBetUsd);
    expect(rec.sizeUsd).toBeLessThanOrEqual(DEFAULT_TOKEN_AI_CONFIG.maxBetUsd);
    expect(rec.kellyFraction).toBeGreaterThan(0);
    expect(rec.tokenAddress).toBe(analysis.tokenAddress);
    expect(rec.chain).toBe(analysis.chain);
  });

  it("scales size by confidence (high > medium > low)", () => {
    const makeAnalysis = (
      conf: "low" | "medium" | "high",
      score: number
    ): TokenAnalysisResult => ({
      ...baseAnalysis,
      successProbability: 0.75,
      confidence: conf,
      confidenceScore: score,
    });

    const configAllowLow: TokenAIConfig = {
      ...sizingConfig,
      minConfidence: "low",
    };

    const highRec = evaluateToken(makeAnalysis("high", 0.85), configAllowLow);
    const medRec = evaluateToken(makeAnalysis("medium", 0.6), configAllowLow);
    const lowRec = evaluateToken(makeAnalysis("low", 0.3), configAllowLow);

    // All should trade with this config
    expect(highRec.shouldTrade).toBe(true);
    expect(medRec.shouldTrade).toBe(true);
    expect(lowRec.shouldTrade).toBe(true);
    expect(highRec.sizeUsd).toBeGreaterThan(medRec.sizeUsd);
    expect(medRec.sizeUsd).toBeGreaterThan(lowRec.sizeUsd);
  });

  it("skips low confidence when minConfidence is medium", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.65,
      confidence: "low",
      confidenceScore: 0.3,
    };

    const rec = evaluateToken(analysis, {
      ...DEFAULT_TOKEN_AI_CONFIG,
      minConfidence: "medium",
    });

    expect(rec.shouldTrade).toBe(false);
    expect(rec.reason).toContain("Confidence too low");
  });

  it("skips low probability below threshold", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.05,
      confidence: "medium",
      confidenceScore: 0.6,
    };

    const rec = evaluateToken(analysis);
    expect(rec.shouldTrade).toBe(false);
    expect(rec.reason).toContain("Probability too low");
  });

  it("skips negative EV (Kelly <= 0)", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.45,
      confidence: "medium",
      confidenceScore: 0.6,
    };

    const rec = evaluateToken(analysis);
    // P=0.45 with 2x payoff: Kelly = 2*0.45 - 1 = -0.1 -> clamped to 0
    expect(rec.shouldTrade).toBe(false);
    expect(rec.kellyFraction).toBe(0);
    expect(rec.reason).toContain("Negative EV");
  });

  it("respects max positions limit", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.65,
      confidence: "medium",
      confidenceScore: 0.6,
    };

    const positions = Array.from({ length: 5 }, () => makePosition());

    const rec = evaluateToken(analysis, DEFAULT_TOKEN_AI_CONFIG, positions);
    expect(rec.shouldTrade).toBe(false);
    expect(rec.reason).toContain("Position limit");
  });

  it("respects max exposure by capping size", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.65,
      confidence: "high",
      confidenceScore: 0.85,
    };

    // 4 positions at $11.25 each = $45 exposure, $5 remaining
    const positions = Array.from({ length: 4 }, () =>
      makePosition({ sizeUsd: 11.25 })
    );

    const rec = evaluateToken(analysis, DEFAULT_TOKEN_AI_CONFIG, positions);

    if (rec.shouldTrade) {
      expect(rec.sizeUsd).toBeLessThanOrEqual(5);
    } else {
      // If $5 remaining is below minBet threshold, skip is also valid
      expect(rec.reason).toMatch(/Size below minimum|Exposure limit/);
    }
  });

  it("respects daily loss limit", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.65,
      confidence: "medium",
      confidenceScore: 0.6,
    };

    const rec = evaluateToken(analysis, DEFAULT_TOKEN_AI_CONFIG, [], -26);
    expect(rec.shouldTrade).toBe(false);
    expect(rec.reason).toContain("Daily loss limit");
  });

  it("rejects high security risk tokens", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.65,
      confidence: "high",
      confidenceScore: 0.85,
      securityScore: 80,
    };

    const rec = evaluateToken(analysis);
    expect(rec.shouldTrade).toBe(false);
    expect(rec.reason).toContain("Security risk too high");
  });

  it("skips when size is below min bet floor", () => {
    // Low probability produces tiny Kelly fraction -> tiny size
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.52,
      confidence: "low",
      confidenceScore: 0.3,
    };

    const config: TokenAIConfig = {
      ...DEFAULT_TOKEN_AI_CONFIG,
      minConfidence: "low",
    };

    const rec = evaluateToken(analysis, config);
    // P=0.52: Kelly=0.04, raw=0.04*0.25*50=0.5, scaled by 0.4=0.2 -> below $5 min
    expect(rec.shouldTrade).toBe(false);
    expect(rec.reason).toContain("Size below minimum");
  });

  it("calculates estimated edge correctly", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.65,
      confidence: "medium",
      confidenceScore: 0.6,
    };

    const rec = evaluateToken(analysis);
    // Edge = 2 * 0.65 - 1 = 0.30
    expect(rec.estimatedEdge).toBeCloseTo(0.3, 4);
  });

  it("allows security score below 70", () => {
    const analysis: TokenAnalysisResult = {
      ...baseAnalysis,
      successProbability: 0.85,
      confidence: "medium",
      confidenceScore: 0.6,
      securityScore: 40,
    };

    const rec = evaluateToken(analysis);
    expect(rec.shouldTrade).toBe(true);
  });
});
