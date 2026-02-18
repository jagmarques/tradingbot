import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Trader, TraderTrade } from "../traders/types.js";
import type { BotSettings } from "../settings/settings.js";

import {
  filterCryptoCopy,
  filterPolyCopy,
  getApproxUsdValue,
} from "./filter.js";

function makeTrader(overrides: Partial<Trader> = {}): Trader {
  return {
    address: "0xTestTrader123456789",
    chain: "base",
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
    chain: "base",
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
    autoCopyEnabled: true,
    minTraderScore: 50,
    maxCopyPerDay: 10,
    dailyCopyCount: 0,
    copyAmountEth: 0.001,
    copyAmountMatic: 2,
    copyAmountDefault: 0.005,
    polymarketCopyUsd: 5,
    ...overrides,
  };
}

describe("Copy Filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("filterCryptoCopy", () => {
    it("rejects trader with score below threshold", () => {
      const trader = makeTrader({ score: 45 });
      const trade = makeTrade();
      const settings = makeSettings({ minTraderScore: 50 });

      const result = filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(false);
      expect(result.traderQualityMultiplier).toBe(0);
      expect(result.reason).toContain("below threshold");
    });

    it("rejects trader with score below 60", () => {
      const trader = makeTrader({ score: 55 });
      const trade = makeTrade();
      const settings = makeSettings({ minTraderScore: 50 });

      const result = filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(false);
      expect(result.traderQualityMultiplier).toBe(0);
      expect(result.reason).toContain("too low");
    });

    it("elite trader (score 95) gets 1.5x multiplier", () => {
      const trader = makeTrader({ score: 95 });
      const trade = makeTrade();
      const settings = makeSettings();

      const result = filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.5);
    });

    it("standard trader (score 75) gets 1.0x multiplier", () => {
      const trader = makeTrader({ score: 75 });
      const trade = makeTrade();
      const settings = makeSettings();

      const result = filterCryptoCopy(trader, trade, settings);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.0);
    });

    it("size is capped at 3x default", () => {
      const trader = makeTrader({ score: 95 }); // 1.5x
      const trade = makeTrade();
      const settings = makeSettings();

      const result = filterCryptoCopy(trader, trade, settings);

      const baseUsd = 0.005 * 3000; // $15
      expect(result.recommendedSizeUsd).toBeLessThanOrEqual(baseUsd * 3);
    });

    it("size has floor at 0.3x default", () => {
      const trader = makeTrader({ score: 65 }); // 0.7x
      const trade = makeTrade();
      const settings = makeSettings();

      const result = filterCryptoCopy(trader, trade, settings);

      const baseUsd = 0.005 * 3000; // $15
      expect(result.shouldCopy).toBe(true);
      expect(result.recommendedSizeUsd).toBeGreaterThanOrEqual(baseUsd * 0.3 - 0.01);
    });
  });

  describe("filterPolyCopy", () => {
    it("high conviction + high ROI: capped at $10", () => {
      const result = filterPolyCopy(0.418, 2741, 0.54);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.5);
      expect(result.recommendedSizeUsd).toBe(10);
    });

    it("medium conviction + high ROI", () => {
      const result = filterPolyCopy(0.418, 1080, 0.54);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.5);
      expect(result.recommendedSizeUsd).toBe(8.1);
    });

    it("low conviction: skip", () => {
      const result = filterPolyCopy(0.199, 43, 0.60);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("Conviction too low");
    });

    it("coin-flip price (50c) rejected", () => {
      const result = filterPolyCopy(0.418, 5000, 0.50);

      expect(result.shouldCopy).toBe(false);
      expect(result.reason).toContain("coin-flip");
    });

    it("standard ROI (10%) with decent conviction", () => {
      const result = filterPolyCopy(0.10, 1200, 0.55);

      expect(result.shouldCopy).toBe(true);
      expect(result.traderQualityMultiplier).toBe(1.0);
      expect(result.recommendedSizeUsd).toBe(6);
    });

    it("low ROI (< 5%) gets rejected", () => {
      const result = filterPolyCopy(0.03, 1000, 0.60);

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

  describe("getApproxUsdValue", () => {
    it("converts BASE ETH to USD", () => {
      expect(getApproxUsdValue(0.001, "base")).toBe(3);
    });

    it("converts ETH to USD", () => {
      expect(getApproxUsdValue(0.001, "ethereum")).toBe(3);
    });

    it("converts MATIC to USD", () => {
      expect(getApproxUsdValue(2, "polygon")).toBe(1.5);
    });
  });
});
