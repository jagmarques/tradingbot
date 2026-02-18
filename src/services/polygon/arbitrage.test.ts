import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./orderbook.js", () => ({
  getMidPrice: vi.fn().mockReturnValue(0.55),
  getBestBid: vi.fn().mockReturnValue({ price: 0.54, size: 100 }),
  getBestAsk: vi.fn().mockReturnValue({ price: 0.56, size: 100 }),
  onOrderbookUpdate: vi.fn().mockReturnValue((): void => {}),
  disconnect: vi.fn(),
}));

vi.mock("./polymarket.js", () => ({
  placeFokOrder: vi.fn().mockResolvedValue({ id: "order-123" }),
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

describe("Polymarket Trading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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

  describe("executeTrade", () => {
    it("should execute trade in paper mode", async () => {
      const { executeTrade } = await import("./arbitrage.js");

      const opportunity = {
        tokenId: "token-123",
        direction: "BUY" as const,
        price: 0.55,
        timestamp: Date.now(),
      };

      const result = await executeTrade(opportunity, 10);

      expect(result.success).toBe(true);
      expect(result.isPaper).toBe(true);
      expect(result.orderId).toContain("paper_");
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
