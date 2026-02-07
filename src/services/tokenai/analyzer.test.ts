import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  SecuritySignal,
  OnchainSignal,
  SocialSignal,
  TokenSignals,
} from "./types.js";

// Mock dependencies before imports
vi.mock("../shared/llm.js", () => ({
  callDeepSeek: vi.fn(),
}));

vi.mock("./collect.js", () => ({
  collectAllSignals: vi.fn(),
}));

vi.mock("../database/tokenai.js", () => ({
  saveTokenAnalysis: vi.fn(),
  getTokenAnalysisHistory: vi.fn(),
}));

import { analyzeToken } from "./analyzer.js";
import { callDeepSeek } from "../shared/llm.js";
import { collectAllSignals } from "./collect.js";
import {
  saveTokenAnalysis,
  getTokenAnalysisHistory,
} from "../database/tokenai.js";

const mockCallDeepSeek = vi.mocked(callDeepSeek);
const mockCollectAllSignals = vi.mocked(collectAllSignals);
const mockSaveTokenAnalysis = vi.mocked(saveTokenAnalysis);
const mockGetTokenAnalysisHistory = vi.mocked(getTokenAnalysisHistory);

const mockSecuritySignal: SecuritySignal = {
  isHoneypot: false,
  hasScamFlags: false,
  isOpenSource: true,
  hasProxy: false,
  hasMintFunction: false,
  ownerCanChangeBalance: false,
  buyTax: 0.01,
  sellTax: 0.02,
  riskScore: 15,
  auditStatus: "unaudited",
  provider: "goplus",
  raw: {},
};

const mockOnchainSignal: OnchainSignal = {
  holderCount: 5200,
  whalePercentage: 22.5,
  liquidityUsd: 180000,
  volume24hUsd: 95000,
  priceChangePercent24h: 45.2,
  marketCapUsd: 1200000,
  provider: "birdeye",
  raw: {},
};

const mockSocialSignal: SocialSignal = {
  tweetCount24h: 340,
  sentiment: "bullish",
  newsItemCount: 3,
  topHeadlines: [
    "New DeFi token gains traction on Solana",
    "Whale accumulation spotted for SOL token",
  ],
  narrativeTags: ["defi", "solana"],
  provider: "twitter",
  raw: {},
};

function makeSignals(
  overrides?: Partial<TokenSignals>,
): TokenSignals {
  return {
    tokenAddress: "0xabc123",
    chain: "solana",
    security: mockSecuritySignal,
    onchain: mockOnchainSignal,
    social: mockSocialSignal,
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeepSeekResponse(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    successProbability: 0.35,
    confidence: "medium",
    reasoning:
      "Token shows moderate momentum with rising volume and social interest. Security profile is clean but unaudited.",
    keyFactors: [
      "45% price increase in 24h",
      "340 tweets showing bullish sentiment",
      "180k liquidity supports entry",
    ],
    riskFactors: [
      "Unaudited contract",
      "22.5% whale concentration",
      "No major exchange listings",
    ],
    evidenceCited: [
      "24h volume of $95,000",
      "holder count at 5,200",
      "risk score 15 out of 100",
    ],
    ...overrides,
  });
}

describe("analyzeToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTokenAnalysisHistory.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should analyze token with all signals and save to database", async () => {
    const signals = makeSignals();
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(makeDeepSeekResponse());

    const result = await analyzeToken("0xabc123", "solana", "TEST");

    expect(result).not.toBeNull();
    expect(result!.tokenAddress).toBe("0xabc123");
    expect(result!.chain).toBe("solana");
    expect(result!.successProbability).toBe(0.35);
    expect(result!.confidence).toBe("medium");
    expect(result!.confidenceScore).toBe(0.6);
    expect(result!.reasoning).toContain("moderate momentum");
    expect(result!.keyFactors).toHaveLength(3);
    expect(result!.riskFactors).toHaveLength(3);
    expect(result!.evidenceCited).toHaveLength(3);
    expect(result!.analyzedAt).toBeDefined();

    // Verify collectAllSignals called correctly
    expect(mockCollectAllSignals).toHaveBeenCalledWith(
      "0xabc123",
      "solana",
      "TEST",
    );

    // Verify callDeepSeek called with correct params
    expect(mockCallDeepSeek).toHaveBeenCalledWith(
      expect.any(String),
      "deepseek-chat",
      expect.stringContaining("crypto token analyst"),
      0.4,
      "tokenai",
    );

    // Verify saved to database
    expect(mockSaveTokenAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: "0xabc123",
        chain: "solana",
        tokenSymbol: "TEST",
        probability: 0.35,
        confidence: 0.6,
      }),
    );
  });

  it("should handle missing security signal with high risk warning", async () => {
    const signals = makeSignals({ security: null });
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(
      makeDeepSeekResponse({ successProbability: 0.1, confidence: "low" }),
    );

    const result = await analyzeToken("0xnosec", "base");

    expect(result).not.toBeNull();
    expect(result!.successProbability).toBe(0.1);
    expect(result!.confidence).toBe("low");
    expect(result!.confidenceScore).toBe(0.3);
    expect(result!.securityScore).toBeUndefined();

    // Verify prompt includes high risk warning
    const prompt = mockCallDeepSeek.mock.calls[0][0];
    expect(prompt).toContain("No security data available - treat as HIGH RISK");
  });

  it("should handle all signals null and still produce a result", async () => {
    const signals = makeSignals({
      security: null,
      onchain: null,
      social: null,
    });
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(
      makeDeepSeekResponse({ successProbability: 0.05, confidence: "low" }),
    );

    const result = await analyzeToken("0xempty", "ethereum");

    expect(result).not.toBeNull();
    expect(result!.successProbability).toBe(0.05);

    const prompt = mockCallDeepSeek.mock.calls[0][0];
    expect(prompt).toContain("No security data available - treat as HIGH RISK");
    expect(prompt).toContain("No on-chain data available");
    expect(prompt).toContain("No social data available");
  });

  it("should include honeypot=true in prompt for honeypot tokens", async () => {
    const honeypotSecurity: SecuritySignal = {
      ...mockSecuritySignal,
      isHoneypot: true,
      riskScore: 85,
    };
    const signals = makeSignals({ security: honeypotSecurity });
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(
      makeDeepSeekResponse({ successProbability: 0.02, confidence: "low" }),
    );

    const result = await analyzeToken("0xhoneypot", "bnb", "SCAM");

    expect(result).not.toBeNull();
    expect(result!.successProbability).toBe(0.02);
    expect(result!.securityScore).toBe(85);

    const prompt = mockCallDeepSeek.mock.calls[0][0];
    expect(prompt).toContain("Honeypot: YES (CRITICAL)");
  });

  it("should return null when DeepSeek returns invalid JSON", async () => {
    const signals = makeSignals();
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue("I cannot analyze this token");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await analyzeToken("0xinvalid", "solana", "BAD");

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("should warn on low citation accuracy", async () => {
    const signals = makeSignals();
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(
      makeDeepSeekResponse({
        evidenceCited: [
          "completely fabricated data point about Mars",
          "another hallucinated claim about unicorns",
        ],
      }),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await analyzeToken("0xcitation", "solana", "CITE");

    expect(result).not.toBeNull();
    expect(result!.citationAccuracy).toBeDefined();
    expect(result!.citationAccuracy!).toBeLessThan(0.5);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Low citation accuracy"),
    );

    warnSpy.mockRestore();
  });

  it("should include previous analyses in prompt when history exists", async () => {
    mockGetTokenAnalysisHistory.mockReturnValue([
      {
        tokenAddress: "0xhistory",
        chain: "solana",
        tokenSymbol: "HIST",
        probability: 0.25,
        confidence: 0.6,
        reasoning: "Previous analysis showed moderate potential",
        keyFactors: ["factor1"],
        analyzedAt: "2026-02-06T10:00:00Z",
      },
    ]);

    const signals = makeSignals();
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(makeDeepSeekResponse());

    const result = await analyzeToken("0xhistory", "solana", "HIST");

    expect(result).not.toBeNull();

    const prompt = mockCallDeepSeek.mock.calls[0][0];
    expect(prompt).toContain("PREVIOUS ANALYSES:");
    expect(prompt).toContain("P=25%");
    expect(prompt).toContain("Previous analysis showed moderate potential");
    expect(prompt).toContain("Your previous estimate was 25%");
  });

  it("should return null when collectAllSignals throws", async () => {
    mockCollectAllSignals.mockRejectedValue(new Error("Network failure"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await analyzeToken("0xfail", "arbitrum");

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("should clamp successProbability to valid range", async () => {
    const signals = makeSignals();
    mockCollectAllSignals.mockResolvedValue(signals);
    mockCallDeepSeek.mockResolvedValue(
      makeDeepSeekResponse({ successProbability: 1.5 }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await analyzeToken("0xclamp", "solana", "CLAMP");

    expect(result).not.toBeNull();
    expect(result!.successProbability).toBe(1.0);
  });
});
