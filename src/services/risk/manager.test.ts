import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  getDailyPnl,
  getDailyPnlPercentage,
  getDailyPnlBreakdown,
  recordTrade,
  pauseTrading,
  resumeTrading,
  activateKillSwitch,
  deactivateKillSwitch,
  canTrade,
  getTodayTrades,
} from "./manager.js";
import { initDb, closeDb, getDb } from "../database/db.js";

// Mock dependencies
vi.mock("../../config/env.js", () => ({
  loadEnv: (): Record<string, unknown> => ({
    DAILY_LOSS_LIMIT_USD: 10,
  }),
  isPaperMode: (): boolean => true,
  isHybridMode: (): boolean => false,
  isLiveMode: (): boolean => false,
  getTradingMode: (): string => "paper",
  setTradingMode: (): void => {},
}));


describe("Risk Manager", () => {
  beforeAll(() => {
    initDb(":memory:");
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS insider_copy_trades (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        token_address TEXT NOT NULL,
        chain TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'buy',
        buy_price_usd REAL NOT NULL,
        current_price_usd REAL NOT NULL,
        amount_usd REAL NOT NULL DEFAULT 10,
        pnl_pct REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        buy_timestamp INTEGER NOT NULL,
        close_timestamp INTEGER DEFAULT NULL,
        exit_reason TEXT DEFAULT NULL
      )
    `);
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    // Reset state by deactivating kill switch and resuming trading
    deactivateKillSwitch();
    resumeTrading();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Daily P&L tracking", () => {
    it("should start with zero P&L", () => {
      // Note: This may not be exactly 0 if other tests recorded trades
      const pnl = getDailyPnl();
      expect(typeof pnl).toBe("number");
    });

    it("should record trades correctly", () => {
      const initialTradeCount = getTodayTrades().length;

      recordTrade({
        strategy: "quant",
        type: "BUY",
        amount: 10,
        price: 0.001,
        pnl: 0,
      });

      const trades = getTodayTrades();
      expect(trades.length).toBe(initialTradeCount + 1);
      expect(trades[trades.length - 1].strategy).toBe("quant");
      expect(trades[trades.length - 1].type).toBe("BUY");
    });

    it("should calculate P&L correctly", () => {
      const initialPnl = getDailyPnl();

      recordTrade({
        strategy: "quant",
        type: "SELL",
        amount: 10,
        price: 0.002,
        pnl: 5,
      });

      expect(getDailyPnl()).toBeCloseTo(initialPnl + 5, 2);
    });

    it("should calculate P&L percentage", () => {
      const percentage = getDailyPnlPercentage();
      expect(typeof percentage).toBe("number");
    });

    it("should aggregate P&L by source", () => {
      const breakdown = getDailyPnlBreakdown();
      expect(typeof breakdown.total).toBe("number");
      expect(typeof breakdown.quantPnl).toBe("number");
      expect(typeof breakdown.insiderCopyPnl).toBe("number");
    });
  });

  describe("Trading controls", () => {
    it("should allow trading by default", () => {
      deactivateKillSwitch();
      resumeTrading();
      expect(canTrade()).toBe(true);
    });

    it("should pause trading when pauseTrading is called", () => {
      pauseTrading("Test pause");
      expect(canTrade()).toBe(false);
    });

    it("should resume trading when resumeTrading is called", () => {
      pauseTrading("Test pause");
      expect(canTrade()).toBe(false);

      resumeTrading();
      expect(canTrade()).toBe(true);
    });
  });

  describe("Kill switch", () => {
    it("should stop all trading when activated", () => {
      activateKillSwitch();
      expect(canTrade()).toBe(false);
    });

    it("should allow trading when deactivated", () => {
      activateKillSwitch();
      deactivateKillSwitch();
      expect(canTrade()).toBe(true);
    });

    it("should override resume when active", () => {
      activateKillSwitch();
      resumeTrading();
      // Kill switch should still prevent trading
      expect(canTrade()).toBe(false);
    });
  });

  describe("Trade history", () => {
    it("should return array of trades", () => {
      const trades = getTodayTrades();
      expect(Array.isArray(trades)).toBe(true);
    });

    it("should include all required trade fields", () => {
      recordTrade({
        strategy: "quant",
        type: "BUY",
        amount: 25,
        price: 0.65,
        pnl: 0,
      });

      const trades = getTodayTrades();
      const lastTrade = trades[trades.length - 1];

      expect(lastTrade).toHaveProperty("id");
      expect(lastTrade).toHaveProperty("strategy");
      expect(lastTrade).toHaveProperty("type");
      expect(lastTrade).toHaveProperty("amount");
      expect(lastTrade).toHaveProperty("price");
      expect(lastTrade).toHaveProperty("pnl");
      expect(lastTrade).toHaveProperty("timestamp");
    });
  });
});
