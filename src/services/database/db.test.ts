import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mock env module
vi.mock("../../config/env.js", () => ({
  loadEnv: () => ({
    TRADING_MODE: "paper",
  }),
  isPaperMode: () => true,
}));

import { initDb, closeDb, getDb, isDbInitialized } from "./db.js";
import {
  insertTrade,
  getTrade,
  getTrades,
  updateTrade,
  insertPosition,
  getOpenPositions,
  closePosition,
  updateDailyStats,
  getDailyStats,
} from "./trades.js";
import { exportTradesToCsv, exportStatsToCsv } from "./export.js";

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
        strategy: "pumpfun",
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
      expect(trade.strategy).toBe("pumpfun");
      expect(trade.type).toBe("BUY");
      expect(trade.amountUsd).toBe(10);
    });

    it("should get trade by ID", () => {
      const inserted = insertTrade({
        strategy: "polymarket",
        type: "SELL",
        amountUsd: 25,
        price: 0.65,
        pnl: 5,
        pnlPercentage: 20,
        fees: 0.01,
        status: "completed",
      });

      const retrieved = getTrade(inserted.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.strategy).toBe("polymarket");
      expect(retrieved?.pnl).toBe(5);
    });

    it("should get trades with filters", () => {
      // Insert some test trades
      insertTrade({
        strategy: "pumpfun",
        type: "BUY",
        amountUsd: 5,
        price: 0.001,
        pnl: 0,
        pnlPercentage: 0,
        fees: 0,
        status: "completed",
      });

      const pumpfunTrades = getTrades({ strategy: "pumpfun" });
      expect(pumpfunTrades.length).toBeGreaterThan(0);
      expect(pumpfunTrades.every((t) => t.strategy === "pumpfun")).toBe(true);
    });

    it("should update trade", () => {
      const trade = insertTrade({
        strategy: "pumpfun",
        type: "BUY",
        amountUsd: 10,
        price: 0.01,
        pnl: 0,
        pnlPercentage: 0,
        fees: 0,
        status: "pending",
      });

      const updated = updateTrade(trade.id, { pnl: 5, status: "completed" });
      expect(updated?.pnl).toBe(5);
      expect(updated?.status).toBe("completed");
    });
  });

  describe("Position operations", () => {
    it("should insert a position", () => {
      const position = insertPosition({
        strategy: "pumpfun",
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

  describe("Daily stats", () => {
    it("should update daily stats", () => {
      const today = new Date().toISOString().split("T")[0];
      const stats = updateDailyStats(today);

      expect(stats.date).toBe(today);
      expect(typeof stats.totalTrades).toBe("number");
      expect(typeof stats.totalPnl).toBe("number");
    });

    it("should get daily stats", () => {
      const today = new Date().toISOString().split("T")[0];
      updateDailyStats(today);

      const stats = getDailyStats(today);
      expect(stats).not.toBeNull();
      expect(stats?.date).toBe(today);
    });
  });

  describe("Export functionality", () => {
    beforeEach(() => {
      // Insert a few trades for export tests
      insertTrade({
        strategy: "pumpfun",
        type: "BUY",
        tokenSymbol: "EXPORT1",
        amountUsd: 10,
        price: 0.01,
        pnl: 2,
        pnlPercentage: 20,
        fees: 0.001,
        status: "completed",
      });
    });

    it("should export trades to CSV", () => {
      const csv = exportTradesToCsv({});
      expect(csv).toContain("Date,Time,Strategy");
      expect(csv).toContain("pumpfun");
    });

    it("should export stats to CSV", () => {
      const today = new Date().toISOString().split("T")[0];
      updateDailyStats(today);

      const csv = exportStatsToCsv({
        startDate: today,
        endDate: today,
      });

      expect(csv).toContain("Date,Total Trades");
    });

    it("should filter trades by strategy", () => {
      const csv = exportTradesToCsv({ strategy: "pumpfun" });
      expect(csv).toContain("pumpfun");
      expect(csv).not.toContain("polymarket,SELL"); // Should only have pumpfun
    });
  });
});
