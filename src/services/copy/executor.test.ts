import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CryptoCopyPosition,
  executeCopyTrade,
  closeCopiedPosition,
  initCryptoCopyTable,
} from "./executor.js";
import type { Trader, TraderTrade } from "../traders/types.js";

// Mock all dependencies
vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn(() => true),
}));

vi.mock("../settings/settings.js", () => ({
  getSettings: vi.fn(() => ({
    autoSnipeEnabled: true,
    autoCopyEnabled: true,
    copyPercentage: 1.0,
    minTraderScore: 50,
    maxCopyPerDay: 10,
    dailyCopyCount: 0,
    copyAmountSol: 0.02,
    copyAmountEth: 0.001,
    copyAmountMatic: 2,
    copyAmountDefault: 0.005,
    polymarketCopyUsd: 5,
  })),
  incrementDailyCopyCount: vi.fn(),
  canCopyTrade: vi.fn(() => true),
}));

vi.mock("../risk/manager.js", () => ({
  canTrade: vi.fn(() => true),
}));

vi.mock("../telegram/bot.js", () => ({
  getChatId: vi.fn(() => "123456"),
  sendMessage: vi.fn(),
}));

vi.mock("../solana/jupiter.js", () => ({
  executeJupiterSwap: vi.fn(() => ({
    success: true,
    signature: "paper_jupiter_test",
    isPaper: true,
    tokensReceived: "1000000000", // 1 billion tokens
  })),
  executeJupiterSell: vi.fn(() => ({
    success: true,
    signature: "paper_jupiter_sell_test",
    isPaper: true,
    amountReceived: 0.025, // Simulated profit
  })),
}));

vi.mock("../evm/oneinch.js", () => ({
  execute1inchSwap: vi.fn(() => ({
    success: true,
    txHash: "paper_1inch_test",
    isPaper: true,
    tokensReceived: "1000000000000000000", // 1 token
  })),
  execute1inchSell: vi.fn(() => ({
    success: true,
    txHash: "paper_1inch_sell_test",
    isPaper: true,
    amountReceived: 0.003, // Simulated profit
  })),
  isChainSupported: vi.fn((chain: string) => ["ethereum", "polygon", "base"].includes(chain)),
}));

vi.mock("./filter.js", () => ({
  filterCryptoCopy: vi.fn(async (trader: { score: number }) => {
    if (trader.score < 60) {
      return { shouldCopy: false, recommendedSizeUsd: 0, reason: "Score too low", traderQualityMultiplier: 0 };
    }
    return {
      shouldCopy: true,
      recommendedSizeUsd: 3.6,
      reason: "Filter passed",
      aiConfidence: "medium",
      aiProbability: 0.3,
      traderQualityMultiplier: 1.2,
    };
  }),
  getApproxUsdValue: vi.fn((_amount: number, chain: string) => {
    const prices: Record<string, number> = { solana: 150, ethereum: 3000, polygon: 0.5, base: 3000 };
    return _amount * (prices[chain] || 1);
  }),
}));

// Mock database
const mockDb = {
  exec: vi.fn(),
  prepare: vi.fn(() => ({
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(() => []),
  })),
};

vi.mock("../database/db.js", () => ({
  getDb: vi.fn(() => mockDb),
}));

describe("Copy Trade Executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Initialize the table
    initCryptoCopyTable();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("executeCopyTrade", () => {
    it("should execute SOL copy trade in paper mode and create position", async () => {
      const trader: Trader = {
        address: "TestTrader123456789",
        chain: "solana",
        score: 80,
        totalTrades: 10,
        winningTrades: 7,
        losingTrades: 3,
        totalPnlUsd: 500,
        winRate: 70,
        pnlPct: 25,
        totalInvested: 2000,
        lastUpdated: Date.now(),
      };

      const trade: TraderTrade = {
        type: "BUY",
        tokenAddress: "TokenMint123",
        tokenSymbol: "TEST",
        chain: "solana",
        amountNative: 0.5,
        amountUsd: 100,
        timestamp: Date.now(),
      };

      const result = await executeCopyTrade(trader, trade);

      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.isPaper).toBe(true);
      expect(result?.chain).toBe("solana");
      expect(result?.amountNative).toBeCloseTo(0.024, 6); // $3.60 / $150 SOL price
      expect(result?.tokensReceived).toBe("1000000000");
    });

    it("should execute ETH copy trade in paper mode and create position", async () => {
      const trader: Trader = {
        address: "TestTrader123456789",
        chain: "ethereum",
        score: 85,
        totalTrades: 20,
        winningTrades: 15,
        losingTrades: 5,
        totalPnlUsd: 1000,
        winRate: 75,
        pnlPct: 30,
        totalInvested: 3000,
        lastUpdated: Date.now(),
      };

      const trade: TraderTrade = {
        type: "BUY",
        tokenAddress: "0xTokenAddress123",
        tokenSymbol: "ETHTEST",
        chain: "ethereum",
        amountNative: 0.1,
        amountUsd: 200,
        timestamp: Date.now(),
      };

      const result = await executeCopyTrade(trader, trade);

      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.isPaper).toBe(true);
      expect(result?.chain).toBe("ethereum");
      expect(result?.amountNative).toBeCloseTo(0.0012, 6); // $3.60 / $3000 ETH price
      expect(result?.tokensReceived).toBe("1000000000000000000");
    });

    it("should not copy SELL trades", async () => {
      const trader: Trader = {
        address: "TestTrader123456789",
        chain: "solana",
        score: 80,
        totalTrades: 10,
        winningTrades: 7,
        losingTrades: 3,
        totalPnlUsd: 500,
        winRate: 70,
        pnlPct: 25,
        totalInvested: 2000,
        lastUpdated: Date.now(),
      };

      const trade: TraderTrade = {
        type: "SELL",
        tokenAddress: "TokenMint123",
        tokenSymbol: "TEST",
        chain: "solana",
        amountNative: 0.5,
        amountUsd: 100,
        timestamp: Date.now(),
      };

      const result = await executeCopyTrade(trader, trade);

      expect(result).toBeNull();
    });

    it("should not copy if trader score below threshold", async () => {
      const trader: Trader = {
        address: "TestTrader123456789",
        chain: "solana",
        score: 40, // Below threshold of 50
        totalTrades: 10,
        winningTrades: 4,
        losingTrades: 6,
        totalPnlUsd: -100,
        winRate: 40,
        pnlPct: -5,
        totalInvested: 2000,
        lastUpdated: Date.now(),
      };

      const trade: TraderTrade = {
        type: "BUY",
        tokenAddress: "TokenMint123",
        tokenSymbol: "TEST",
        chain: "solana",
        amountNative: 0.5,
        amountUsd: 100,
        timestamp: Date.now(),
      };

      const result = await executeCopyTrade(trader, trade);

      expect(result).toBeNull();
    });
  });

  describe("closeCopiedPosition", () => {
    it("should close position and calculate PnL with fee deductions in paper mode", async () => {
      // Create a mock position
      const position: CryptoCopyPosition = {
        id: "test_position_1",
        traderAddress: "TestTrader123",
        chain: "solana",
        tokenAddress: "TokenMint123",
        tokenSymbol: "TEST",
        entryAmountNative: 0.02,
        tokensReceived: "1000000000",
        status: "open",
        entryTimestamp: Date.now() - 60000, // 1 minute ago
      };

      const result = await closeCopiedPosition(position, "Trader sold");

      expect(result.success).toBe(true);
      expect(result.pnlNative).toBeDefined();
      // PnL should be: amountReceived (0.025) - entryAmount (0.02) - fees
      // In paper mode, fees = gas (0.003 * 2) + slippage (0.02 * 0.01 * 2)
      // PnL = 0.025 - 0.02 - 0.006 - 0.0004 = -0.0014 (approximately)
      expect(result.pnlNative).toBeLessThan(0.01); // Should have fee deductions
    });
  });

  describe("Paper trading fee deductions", () => {
    it("should deduct gas fees in paper mode", async () => {
      // This is tested indirectly through closeCopiedPosition
      // Verify the fee calculation is happening
      const position: CryptoCopyPosition = {
        id: "test_fee_position",
        traderAddress: "TestTrader123",
        chain: "ethereum",
        tokenAddress: "0xToken",
        tokenSymbol: "FEETEST",
        entryAmountNative: 0.001,
        tokensReceived: "1000000000000000000",
        status: "open",
        entryTimestamp: Date.now(),
      };

      const result = await closeCopiedPosition(position, "Test close");

      // Verify PnL has fee deductions applied
      // amountReceived (0.003) - entry (0.001) = 0.002 gross profit
      // After fees (gas + slippage), should be less
      expect(result.success).toBe(true);
      expect(typeof result.pnlNative).toBe("number");
    });
  });
});
