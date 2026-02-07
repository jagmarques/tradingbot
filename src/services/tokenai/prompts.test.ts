import { describe, it, expect } from "vitest";
import { buildTokenPrompt } from "./prompts.js";
import type {
  SecuritySignal,
  OnchainSignal,
  SocialSignal,
  TokenSignals,
} from "./types.js";
import type { TokenAnalysis } from "../database/tokenai.js";

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

function makeSignals(overrides?: Partial<TokenSignals>): TokenSignals {
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

describe("buildTokenPrompt", () => {
  it("should include Pump.fun context for Solana chain", () => {
    const signals = makeSignals();
    const prompt = buildTokenPrompt("0xabc123", "solana", "TEST", signals, []);

    expect(prompt).toContain("Pump.fun");
    expect(prompt).toContain("Bonding curve");
    expect(prompt).toContain("ULTRA-HIGH RISK");
    expect(prompt).toContain("~3%");
  });

  it("should include DEX context for EVM chains", () => {
    const signals = makeSignals({ chain: "base" });
    const prompt = buildTokenPrompt("0xabc123", "base", "TEST", signals, []);

    expect(prompt).toContain("DEX Token");
    expect(prompt).toContain("Contract verification");
    expect(prompt).toContain("HIGH RISK");
    expect(prompt).toContain("~5%");
  });

  it("should use uppercase chain name for Ethereum EVM template", () => {
    const signals = makeSignals({ chain: "ethereum" });
    const prompt = buildTokenPrompt("0xabc123", "ethereum", "TEST", signals, []);

    expect(prompt).toContain("ETHEREUM / DEX Token");
  });

  it("should include honeypot critical flag in security data", () => {
    const honeypotSecurity: SecuritySignal = {
      ...mockSecuritySignal,
      isHoneypot: true,
      riskScore: 85,
    };
    const signals = makeSignals({ security: honeypotSecurity });
    const prompt = buildTokenPrompt("0xhoney", "solana", "SCAM", signals, []);

    expect(prompt).toContain("YES (CRITICAL)");
  });

  it("should include previous analyses when history exists", () => {
    const signals = makeSignals();
    const history: TokenAnalysis[] = [
      {
        tokenAddress: "0xabc123",
        chain: "solana",
        tokenSymbol: "TEST",
        probability: 0.25,
        confidence: 0.6,
        reasoning: "Previous analysis showed moderate potential",
        keyFactors: ["factor1"],
        analyzedAt: "2026-02-06T10:00:00Z",
      },
      {
        tokenAddress: "0xabc123",
        chain: "solana",
        tokenSymbol: "TEST",
        probability: 0.15,
        confidence: 0.3,
        reasoning: "Earlier analysis was less optimistic",
        keyFactors: ["factor2"],
        analyzedAt: "2026-02-05T10:00:00Z",
      },
    ];

    const prompt = buildTokenPrompt("0xabc123", "solana", "TEST", signals, history);

    expect(prompt).toContain("PREVIOUS ANALYSES");
    expect(prompt).toContain("P=25%");
    expect(prompt).toContain("P=15%");
    expect(prompt).toContain("Previous analysis showed moderate potential");
    expect(prompt).toContain("Earlier analysis was less optimistic");
  });

  it("should include all signal sections when all signals provided", () => {
    const signals = makeSignals();
    const prompt = buildTokenPrompt("0xabc123", "solana", "TEST", signals, []);

    expect(prompt).toContain("SECURITY DATA:");
    expect(prompt).toContain("ON-CHAIN DATA:");
    expect(prompt).toContain("SOCIAL/NEWS DATA:");
    expect(prompt).toContain("Holder count:");
    expect(prompt).toContain("Tweet count (24h):");
    expect(prompt).toContain("Risk score:");
  });

  it("should show fallback text when all signals are null", () => {
    const signals = makeSignals({
      security: null,
      onchain: null,
      social: null,
    });
    const prompt = buildTokenPrompt("0xempty", "base", "EMPTY", signals, []);

    expect(prompt).toContain("No security data available");
    expect(prompt).toContain("No on-chain data available");
    expect(prompt).toContain("No social data available");
  });
});
