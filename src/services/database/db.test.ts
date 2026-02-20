import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock env module
vi.mock("../../config/env.js", () => ({
  loadEnv: (): { TRADING_MODE: string } => ({
    TRADING_MODE: "paper",
  }),
  isPaperMode: (): boolean => true,
}));

import { initDb, closeDb, getDb, isDbInitialized } from "./db.js";
import {
  insertTrade,
  insertPosition,
  getOpenPositions,
  closePosition,
} from "./trades.js";

describe("Database", () => {
  beforeAll(() => {
    // Use in-memory database for tests
    initDb(":memory:");
  });

  afterAll(() => {
    closeDb();
  });

  describe("Database initialization", () => {
    it("should initialize database", () => {
      expect(isDbInitialized()).toBe(true);
    });

    it("should return database instance", () => {
      const db = getDb();
      expect(db).not.toBeNull();
    });
  });

  describe("Trade operations", () => {
    it("should insert a trade", () => {
      const trade = insertTrade({
        strategy: "polymarket",
        type: "BUY",
        tokenSymbol: "TEST",
        tokenAddress: "abc123",
        amountUsd: 10,
        amountTokens: 1000,
        price: 0.01,
        pnl: 0,
        pnlPercentage: 0,
        fees: 0.001,
        status: "completed",
      });

      expect(trade.id).toBeDefined();
      expect(trade.strategy).toBe("polymarket");
      expect(trade.type).toBe("BUY");
      expect(trade.amountUsd).toBe(10);
    });

  });

  describe("Position operations", () => {
    it("should insert a position", () => {
      const position = insertPosition({
        strategy: "polymarket",
        tokenAddress: "xyz789",
        tokenSymbol: "POS",
        entryPrice: 0.01,
        amountTokens: 500,
        amountUsd: 5,
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: "open",
      });

      expect(position.id).toBeDefined();
      expect(position.status).toBe("open");
    });

    it("should get open positions", () => {
      const positions = getOpenPositions();
      expect(Array.isArray(positions)).toBe(true);
    });

    it("should close position", () => {
      const position = insertPosition({
        strategy: "polymarket",
        tokenAddress: "market1",
        entryPrice: 0.5,
        amountTokens: 100,
        amountUsd: 50,
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: "open",
      });

      const closed = closePosition(position.id, 10);
      expect(closed?.status).toBe("closed");
      expect(closed?.realizedPnl).toBe(10);
    });
  });

});
