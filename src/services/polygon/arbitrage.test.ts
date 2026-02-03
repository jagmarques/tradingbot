import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./orderbook.js", () => ({
  getMidPrice: vi.fn().mockReturnValue(0.55),
  getSpread: vi.fn().mockReturnValue(0.02),
  getBestBid: vi.fn().mockReturnValue({ price: 0.54, size: 100 }),
  getBestAsk: vi.fn().mockReturnValue({ price: 0.56, size: 100 }),
  onOrderbookUpdate: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("./polymarket.js", () => ({
  placeFokOrder: vi.fn().mockResolvedValue({ id: "order-123" }),
}));

vi.mock("../pricefeeds/manager.js", () => ({
  getPrice: vi.fn().mockReturnValue(0.60),
}));

vi.mock("../../config/env.js", () => ({
  isPaperMode: vi.fn().mockReturnValue(true),
  loadEnv: vi.fn(() => ({
    MAX_POLYMARKET_BET_USDC: 20,
  })),
}));

vi.mock("../database/arbitrage-positions.js", () => ({
  savePosition: vi.fn(),
  markPositionClosed: vi.fn(),
  loadOpenPositions: vi.fn(() => []),
}));

vi.mock("../database/trades.js", () => ({
  insertTrade: vi.fn(),
}));

describe("Polymarket Arbitrage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("registerMarket", () => {
    it("should register a market", async () => {
      const { registerMarket, getRegisteredMarkets } = await import("./arbitrage.js");

      registerMarket("token-123", "BTCUSDT", true);

      const markets = getRegisteredMarkets();
      expect(markets.has("token-123")).toBe(true);
      expect(markets.get("token-123")?.symbol).toBe("BTCUSDT");
    });
  });

  describe("startMonitoring", () => {
    it("should start monitoring", async () => {
      const { startMonitoring, isMonitoring, stopMonitoring } = await import("./arbitrage.js");

      startMonitoring();
      expect(isMonitoring()).toBe(true);

      stopMonitoring();
      expect(isMonitoring()).toBe(false);
    });
  });

  describe("executeArbitrage", () => {
    it("should execute arbitrage in paper mode", async () => {
      const { executeArbitrage } = await import("./arbitrage.js");

      const opportunity = {
        tokenId: "token-123",
        marketSymbol: "BTCUSDT",
        direction: "BUY" as const,
        polymarketPrice: 0.55,
        spotPrice: 0.60,
        priceDiff: 0.05,
        confidence: 90,
        timestamp: Date.now(),
      };

      const result = await executeArbitrage(opportunity, 10);

      expect(result.success).toBe(true);
      expect(result.isPaper).toBe(true);
      expect(result.orderId).toContain("paper_");
    });

    it("should reject low confidence opportunities", async () => {
      const { executeArbitrage } = await import("./arbitrage.js");

      const opportunity = {
        tokenId: "token-123",
        marketSymbol: "BTCUSDT",
        direction: "BUY" as const,
        polymarketPrice: 0.55,
        spotPrice: 0.56,
        priceDiff: 0.01,
        confidence: 50, // Below threshold
        timestamp: Date.now(),
      };

      const result = await executeArbitrage(opportunity, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Confidence");
    });

    it("should record spot hedge price when executing", async () => {
      const { executeArbitrage } = await import("./arbitrage.js");

      const opportunity = {
        tokenId: "token-123",
        marketSymbol: "BTCUSDT",
        direction: "BUY" as const,
        polymarketPrice: 0.55,
        spotPrice: 0.60,
        priceDiff: 0.05,
        confidence: 90,
        timestamp: Date.now(),
      };

      const result = await executeArbitrage(opportunity, 10);

      expect(result.success).toBe(true);
      expect(result.spotHedgePrice).toBe(0.60); // From mocked getPrice
      expect(result.pairId).toBeDefined();
    });
  });

  describe("onOpportunity", () => {
    it("should register callback", async () => {
      const { onOpportunity } = await import("./arbitrage.js");

      const callback = vi.fn();
      const unsubscribe = onOpportunity(callback);

      expect(typeof unsubscribe).toBe("function");

      // Cleanup
      unsubscribe();
    });
  });
});
