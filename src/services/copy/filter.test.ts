import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Trader, TraderTrade } from "../traders/types.js";
import type { BotSettings } from "../settings/settings.js";
import type { TokenAnalysisResult } from "../tokenai/types.js";

// Mock analyzeToken
vi.mock("../tokenai/analyzer.js", () => ({
  analyzeToken: vi.fn(),
}));

import { analyzeToken } from "../tokenai/analyzer.js";
import {
  filterCryptoCopy,
  filterPolyCopy,
  mapChainToSupported,
  getApproxUsdValue,
  CopyFilterResult,
} from "./filter.js";

const mockedAnalyzeToken = vi.mocked(analyzeToken);

function makeTrader(overrides: Partial<Trader> = {}): Trader {
  return {
    address: "0xTestTrader123456789",
    chain: "solana",
    score: 80,
    winRate: 0.7,
    profitFactor: 2.0,
    consistency: 0.8,
    totalTrades: 50,
    winningTrades: 35,
    losingTrades: 15,
    totalPnlUsd: 5000,
    avgHoldTimeMs: 3600000,
    largestWinPct: 150,
    discoveredAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTrade(overrides: Partial<TraderTrade> = {}): TraderTrade {
  return {
    id: "trade_1",
    walletAddress: "0xTestTrader123456789",
    chain: "solana",
    tokenAddress: "TokenMint123",
    tokenSymbol: "TEST",
    type: "BUY",
    amountUsd: 100,
    price: 0.001,
    txHash: "0xabc123",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeSettings(overrides: Partial<BotSettings> = {}): BotSettings {
  return {
    autoSnipeEnabled: true,
    autoCopyEnabled: true,
    minTraderScore: 50,
    maxCopyPerDay: 10,
    dailyCopyCount: 0,
    copyAmountSol: 0.02,
    copyAmountEth: 0.001,
    copyAmountMatic: 2,
    copyAmountDefault: 0.005,
    polymarketCopyUsd: 5,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<TokenAnalysisResult> = {}): TokenAnalysisResult {
  return {
    tokenAddress: "TokenMint123",
    chain: "solana",
    successProbability: 0.65,
    confidence: "high",
    confidenceScore: 0.85,
    reasoning: "Strong token with good metrics",
    keyFactors: ["High liquidity", "Low whale concentration"],
    riskFactors: ["New token"],
    evidenceCited: ["Liquidity >$1M"],
    securityScore: 20,
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Copy Filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("filterCryptoCopy", () => {
    it("rejects trader with score below 60", async () => {
      const trader = makeTrader({ score: 45 });
      const trade = makeTrade();
      const settings = makeSettings({ minTraderScore: 50 });

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(false);
      expect(result.traderQualityMultiplier).toBe(0);
      expect(result.reason).toContain("below threshold");
    });

    it("elite trader (score 95) gets 1.5x multiplier", async () => {
      const trader = makeTrader({ score: 95 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockResolvedValueOnce(makeAnalysis());

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.5);
    });

    it("standard trader (score 75) gets 1.0x multiplier", async () => {
      const trader = makeTrader({ score: 75 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockResolvedValueOnce(makeAnalysis());

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.0);
    });

    it("AI rejects token with high security score (>= 70)", async () => {
      const trader = makeTrader({ score: 80 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ securityScore: 75 }),
      );

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("security score");
    });

    it("AI rejects token with low probability (< 0.15)", async () => {
      const trader = makeTrader({ score: 80 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ successProbability: 0.10, confidence: "medium" }),
      );

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("probability");
    });

    it("AI rejects token with low confidence", async () => {
      const trader = makeTrader({ score: 80 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ confidence: "low", confidenceScore: 0.3, successProbability: 0.50, securityScore: 10 }),
      );

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("low confidence");
    });

    it("AI analysis failure falls back to trader-quality-only sizing", async () => {
      const trader = makeTrader({ score: 80 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockResolvedValueOnce(null);

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.reason).toContain("AI analysis unavailable");
      expect(result.aiConfidence).toBeUndefined();
      expect(result.recommendedSizeUsd).toBeGreaterThan(0);
    });

    it("unsupported chain (polygon) skips AI, uses trader-quality-only sizing", async () => {
      const trader = makeTrader({ score: 80 });
      const trade = makeTrade({ chain: "polygon" });
      const settings = makeSettings();

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.reason).toContain("not supported for AI analysis");
      // analyzeToken should NOT have been called
      expect(mockedAnalyzeToken).not.toHaveBeenCalled();
    });

    it("size is capped at 3x default", async () => {
      // Elite trader + high confidence = high multiplier
      const trader = makeTrader({ score: 95 }); // 1.5x
      const trade = makeTrade();
      // copyAmountSol=0.02 * 150 USD/SOL = $3 base
      const settings = makeSettings({ copyAmountSol: 0.02 });

      // Even with 1.5x quality * 1.0 confidence scale, size should not exceed 3x
      mockedAnalyzeToken.mockResolvedValueOnce(makeAnalysis());

      const result = await filterCryptoCopy(trader, trade, settings);

      const baseUsd = 0.02 * 150; // $3
      expect(result.recommendedSizeUsd).toBeLessThanOrEqual(baseUsd * 3);
    });

    it("size has floor at 0.3x default", async () => {
      // Marginal trader + medium confidence = low multiplier
      const trader = makeTrader({ score: 65 }); // 0.7x
      const trade = makeTrade();
      const settings = makeSettings({ copyAmountSol: 0.02 });

      // 0.7x quality * 0.7 medium scale = 0.49x -> should floor at 0.3x
      mockedAnalyzeToken.mockResolvedValueOnce(
        makeAnalysis({ confidence: "medium", confidenceScore: 0.6 }),
      );

      const result = await filterCryptoCopy(trader, trade, settings);

      const baseUsd = 0.02 * 150; // $3
      expect(result.shouldCopy).toBe(true);
      expect(result.recommendedSizeUsd).toBeGreaterThanOrEqual(baseUsd * 0.3 - 0.01); // small float tolerance
    });

    it("AI analysis exception falls back to trader-quality sizing", async () => {
      const trader = makeTrader({ score: 80 });
      const trade = makeTrade();
      const settings = makeSettings();

      mockedAnalyzeToken.mockRejectedValueOnce(new Error("DeepSeek timeout"));

      const result = await filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.reason).toContain("AI analysis unavailable");
    });
  });

  describe("filterPolyCopy", () => {
    it("high conviction + high ROI: Melody626 $2741 Darnold", () => {
      // ROI 41.8% -> 1.5x, $2741 * 0.005 * 1.5 = $20.56 -> capped at $10
      const result = filterPolyCopy(0.418, 2741, 0.54);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.5);
      expect(result.recommendedSizeUsd).toBe(10); // capped at MAX_COPY_BET
    });

    it("medium conviction + high ROI: Melody626 $1080 Olympics", () => {
      // ROI 41.8% -> 1.5x, $1080 * 0.005 * 1.5 = $8.10
      const result = filterPolyCopy(0.418, 1080, 0.54);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.5);
      expect(result.recommendedSizeUsd).toBe(8.1);
    });

    it("low conviction: ScottyNooo $43 tariffs -> skip", () => {
      // ROI 19.9% -> 1.0x, $43 * 0.005 * 1.0 = $0.22 -> below $2 min
      const result = filterPolyCopy(0.199, 43, 0.50);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("Conviction too low");
    });

    it("standard ROI (10%) with decent conviction", () => {
      // ROI 10% -> 1.0x, $800 * 0.005 * 1.0 = $4.00
      const result = filterPolyCopy(0.10, 800, 0.55);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.0);
      expect(result.recommendedSizeUsd).toBe(4);
    });

    it("low ROI (< 5%) gets rejected", () => {
      const result = filterPolyCopy(0.03, 1000, 0.50);

      expect(result.shouldCopy).toBe(false);
      expect(result.traderQualityMultiplier).toBe(0);
      expect(result.reason).toContain("too low");
    });

    it("extreme price rejected", () => {
      const result = filterPolyCopy(0.30, 1000, 0.97);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("too extreme");
    });
  });

  describe("mapChainToSupported", () => {
    it("solana -> solana", () => {
      expect(mapChainToSupported("solana")).toBe("solana");
    });

    it("bsc -> bnb", () => {
      expect(mapChainToSupported("bsc")).toBe("bnb");
    });

    it("polygon -> null", () => {
      expect(mapChainToSupported("polygon")).toBeNull();
    });

    it("sonic -> null", () => {
      expect(mapChainToSupported("sonic")).toBeNull();
    });

    it("ethereum -> ethereum", () => {
      expect(mapChainToSupported("ethereum")).toBe("ethereum");
    });

    it("base -> base", () => {
      expect(mapChainToSupported("base")).toBe("base");
    });

    it("arbitrum -> arbitrum", () => {
      expect(mapChainToSupported("arbitrum")).toBe("arbitrum");
    });

    it("avalanche -> avalanche", () => {
      expect(mapChainToSupported("avalanche")).toBe("avalanche");
    });

    it("optimism -> null", () => {
      expect(mapChainToSupported("optimism")).toBeNull();
    });
  });

  describe("getApproxUsdValue", () => {
    it("converts SOL to USD", () => {
      expect(getApproxUsdValue(0.02, "solana")).toBe(3);
    });

    it("converts ETH to USD", () => {
      expect(getApproxUsdValue(0.001, "ethereum")).toBe(3);
    });

    it("converts MATIC to USD", () => {
      expect(getApproxUsdValue(2, "polygon")).toBe(1.5);
    });
  });
});
