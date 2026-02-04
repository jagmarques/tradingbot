import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPosition,
  closePosition,
  shouldExitPosition,
  getActivePositions,
  getActivePositionCount,
  getPosition,
} from "./positions.js";

// Helper to assert non-null and return typed value
function assertDefined<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  return value as T;
}

// Mock database functions
vi.mock("../database/arbitrage-positions.js", () => ({
  savePosition: vi.fn(),
  markPositionClosed: vi.fn(),
  loadOpenPositions: vi.fn(() => []),
}));

describe("Positions", () => {
  beforeEach(() => {
    // Clear any active positions before each test
    const positions = getActivePositions();
    positions.forEach((position) => {
      closePosition(position.id, position.entryPrice);
    });
  });

  describe("createPosition", () => {
    it("should create a valid position with correct calculations", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      expect(position.id).toMatch(/^pos_/);
      expect(position.polymarketTokenId).toBe("token123");
      expect(position.side).toBe("BUY");
      expect(position.entryPrice).toBe(0.6);
      expect(position.size).toBe(100);
      expect(position.status).toBe("pending");
      expect(position.targetProfit).toBeGreaterThan(0);
      expect(position.estimatedFees).toBeGreaterThan(0);
    });

    it("should add position to active positions list", () => {
      const initialCount = getActivePositionCount();
      createPosition("token123", "BUY", 0.6, 100);
      expect(getActivePositionCount()).toBe(initialCount + 1);
    });
  });

  describe("shouldExitPosition", () => {
    it("should exit when profit target is reached", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.5,
        100
      );

      // Simulate profitable price movement
      // BUY at 0.5, now worth 0.7 (+0.2 per share)
      const { shouldExit, reason } = shouldExitPosition(position, 0.7);

      expect(shouldExit).toBe(true);
      expect(reason).toContain("Profit target reached");
    });

    it("should exit on timeout", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      // Manually set entry timestamp to 6 minutes ago
      position.entryTimestamp = Date.now() - 6 * 60 * 1000;

      const { shouldExit, reason } = shouldExitPosition(position, 0.6);

      expect(shouldExit).toBe(true);
      expect(reason).toContain("Timeout reached");
    });

    it("should exit on stale position (>24h)", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      // Manually set entry timestamp to 25 hours ago
      position.entryTimestamp = Date.now() - 25 * 60 * 60 * 1000;

      const { shouldExit, reason } = shouldExitPosition(position, 0.6);

      expect(shouldExit).toBe(true);
      expect(reason).toContain("Stale position");
    });

    it("should exit on stop loss", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      // Simulate large losing price movement
      // BUY at 0.6, now worth 0.1 (-0.5 per share)
      const { shouldExit, reason } = shouldExitPosition(position, 0.1);

      expect(shouldExit).toBe(true);
      expect(reason).toContain("Stop loss hit");
    });

    it("should not exit when conditions not met", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      // Small price change, not enough to trigger exit
      // Price needs to be close enough to entry that P&L doesn't trigger profit/loss thresholds
      const { shouldExit } = shouldExitPosition(position, 0.605);

      expect(shouldExit).toBe(false);
    });
  });

  describe("closePosition", () => {
    it("should calculate positive P&L correctly for BUY", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.5,
        100
      );

      // Profitable exit: price went up
      const result = assertDefined(closePosition(position.id, 0.6));

      expect(result.pnl).toBeGreaterThan(0);
      expect(result.pnlPercentage).toBeGreaterThan(0);
      expect(result.fees).toBeGreaterThan(0);
      expect(result.holdTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should calculate negative P&L correctly for BUY", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      // Losing exit: price went down
      const result = assertDefined(closePosition(position.id, 0.4));

      expect(result.pnl).toBeLessThan(0);
      expect(result.pnlPercentage).toBeLessThan(0);
    });

    it("should calculate positive P&L correctly for SELL", () => {
      const position = createPosition(
        "token123",
        "SELL",
        0.7,
        100
      );

      // Profitable exit: price went down
      const result = assertDefined(closePosition(position.id, 0.5));

      expect(result.pnl).toBeGreaterThan(0);
      expect(result.pnlPercentage).toBeGreaterThan(0);
    });

    it("should remove position from active positions after close", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100
      );

      const beforeCount = getActivePositionCount();
      closePosition(position.id, 0.6);
      const afterCount = getActivePositionCount();

      expect(afterCount).toBe(beforeCount - 1);
      expect(getPosition(position.id)).toBeNull();
    });

    it("should return null for non-existent position", () => {
      const result = closePosition("nonexistent", 0.5);
      expect(result).toBeNull();
    });
  });

  describe("getActivePositionCount", () => {
    it("should track multiple positions", () => {
      // Create multiple positions
      createPosition("token1", "BUY", 0.6, 100);
      createPosition("token2", "SELL", 0.7, 100);
      createPosition("token3", "BUY", 0.5, 100);

      const count = getActivePositionCount();
      expect(count).toBe(3);
    });

    it("should decrease when positions are closed", () => {
      const pos1 = createPosition("token1", "BUY", 0.6, 100);
      const pos2 = createPosition("token2", "SELL", 0.7, 100);

      expect(getActivePositionCount()).toBe(2);

      closePosition(pos1.id, 0.6);
      expect(getActivePositionCount()).toBe(1);

      closePosition(pos2.id, 0.7);
      expect(getActivePositionCount()).toBe(0);
    });
  });

  describe("Spot hedge integration", () => {
    it("should create position with spot hedge", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.6,
        100,
        "BTCUSDT",
        50000
      );

      expect(position.spotSymbol).toBe("BTCUSDT");
      expect(position.spotEntryPrice).toBe(50000);
      expect(position.spotSide).toBe("SHORT"); // Opposite of BUY
      expect(position.spotSize).toBe(100); // Dollar-neutral
      expect(position.estimatedFees).toBeGreaterThan(0); // Should include spot fees
    });

    it("should calculate combined P&L for hedged position (profit scenario)", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.5,
        100,
        "BTCUSDT",
        50000
      );

      // BUY Polymarket at 0.5, exit at 0.6 (+$20 poly P&L)
      // SHORT spot at 50000, exit at 49000 (+$2 spot P&L)
      const result = assertDefined(closePosition(position.id, 0.6, 49000));

      expect(result.pnl).toBeGreaterThan(0);
      expect(result.pnlPercentage).toBeGreaterThan(0);
    });

    it("should calculate combined P&L for hedged position (loss scenario)", () => {
      const position = createPosition(
        "token123",
        "SELL",
        0.7,
        100,
        "BTCUSDT",
        50000
      );

      // SELL Polymarket at 0.7, exit at 0.8 (-$14 poly P&L)
      // LONG spot at 50000, exit at 49000 (-$2 spot P&L)
      const result = assertDefined(closePosition(position.id, 0.8, 49000));

      expect(result.pnl).toBeLessThan(0);
    });

    it("should include spot P&L in shouldExitPosition calculation", () => {
      const position = createPosition(
        "token123",
        "BUY",
        0.5,
        100,
        "BTCUSDT",
        50000
      );

      // Polymarket profit + spot profit should reach target
      const { shouldExit, reason } = shouldExitPosition(position, 0.6, 49000);

      expect(shouldExit).toBe(true);
      expect(reason).toContain("Profit target reached");
    });
  });
});
