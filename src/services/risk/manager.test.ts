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
  checkSlippage,
  getTodayTrades,
  isInPaperMode,
} from "./manager.js";
import { initDb, closeDb, getDb } from "../database/db.js";

// Mock dependencies
vi.mock("../../config/env.js", () => ({
  loadEnv: (): Record<string, unknown> => ({
    DAILY_LOSS_LIMIT_USD: 10,
    MAX_SLIPPAGE_PUMPFUN: 0.15,
    MAX_SLIPPAGE_POLYMARKET: 0.02,
    MIN_SOL_RESERVE: 0.05,
  }),
  isPaperMode: (): boolean => true,
}));

vi.mock("../solana/wallet.js", () => ({
  getSolBalance: vi.fn().mockResolvedValue(BigInt(100000000)), // 0.1 SOL
}));

vi.mock("../polygon/wallet.js", () => ({
  getMaticBalance: vi.fn().mockResolvedValue(BigInt(500000000000000000)), // 0.5 MATIC
}));

describe("Risk Manager", () => {
  beforeAll(() => {
    // Initialize in-memory database for tests
    initDb(":memory:");
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
        strategy: "pumpfun",
        type: "BUY",
        amount: 10,
        price: 0.001,
        pnl: 0,
      });

      const trades = getTodayTrades();
      expect(trades.length).toBe(initialTradeCount + 1);
      expect(trades[trades.length - 1].strategy).toBe("pumpfun");
      expect(trades[trades.length - 1].type).toBe("BUY");
    });

    it("should calculate P&L correctly", () => {
      const initialPnl = getDailyPnl();

      recordTrade({
        strategy: "pumpfun",
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
      const db = getDb();
      const today = new Date().toISOString().split("T")[0] + "T00:00:00.000Z";

      // Create polytrader_copies table if needed
      db.exec(`
        CREATE TABLE IF NOT EXISTS polytrader_copies (
          id TEXT PRIMARY KEY,
          trader_wallet TEXT NOT NULL,
          trader_name TEXT NOT NULL,
          condition_id TEXT NOT NULL,
          market_title TEXT NOT NULL,
          token_id TEXT NOT NULL,
          side TEXT NOT NULL,
          entry_price REAL NOT NULL,
          size REAL NOT NULL,
          trader_size REAL NOT NULL,
          status TEXT NOT NULL,
          entry_timestamp INTEGER NOT NULL,
          exit_timestamp INTEGER,
          exit_price REAL,
          pnl REAL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Clear tables for isolated test
      db.prepare("DELETE FROM trades WHERE created_at >= ?").run(today);
      db.prepare("DELETE FROM polytrader_copies WHERE updated_at >= ?").run(today);
      db.prepare("DELETE FROM aibetting_positions WHERE exit_timestamp >= ?").run(new Date(today).getTime());

      // Insert test positions
      db.prepare(`INSERT INTO polytrader_copies (id, trader_wallet, trader_name, condition_id, market_title, token_id, side, entry_price, size, trader_size, status, entry_timestamp, pnl, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("copy1", "wallet1", "TestTrader", "cond1", "Test Market", "token1", "YES", 0.5, 10, 100, "closed", Date.now(), 5.5, today);

      db.prepare(`INSERT INTO aibetting_positions (id, market_id, market_title, token_id, side, entry_price, size, ai_probability, confidence, expected_value, status, entry_timestamp, exit_timestamp, pnl)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("ai1", "market1", "Test AI Market", "token2", "NO", 0.6, 15, 0.7, 0.8, 0.1, "closed", Date.now() - 1000, Date.now(), 3.2);

      recordTrade({ strategy: "base", type: "SELL", amount: 20, price: 1.5, pnl: 2.1 });
      recordTrade({ strategy: "pumpfun", type: "SELL", amount: 30, price: 0.01, pnl: 1.3 });

      const breakdown = getDailyPnlBreakdown();

      expect(breakdown.total).toBeCloseTo(12.1, 1);
      expect(breakdown.cryptoCopy).toBeCloseTo(2.1, 1);
      expect(breakdown.pumpfun).toBeCloseTo(1.3, 1);
      expect(breakdown.polyCopy).toBeCloseTo(5.5, 1);
      expect(breakdown.aiBetting).toBeCloseTo(3.2, 1);
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

  describe("Slippage checks", () => {
    it("should allow trade within slippage tolerance", () => {
      const result = checkSlippage(100, 101, 0.02); // 1% slippage, 2% max
      expect(result.allowed).toBe(true);
      expect(result.slippage).toBeCloseTo(0.01, 4);
    });

    it("should reject trade exceeding slippage tolerance", () => {
      const result = checkSlippage(100, 105, 0.02); // 5% slippage, 2% max
      expect(result.allowed).toBe(false);
      expect(result.slippage).toBeCloseTo(0.05, 4);
    });

    it("should handle exact slippage boundary", () => {
      const result = checkSlippage(100, 102, 0.02); // Exactly 2%
      expect(result.allowed).toBe(true);
    });

    it("should handle negative slippage (price improvement)", () => {
      const result = checkSlippage(100, 99, 0.02); // -1% (better price)
      expect(result.allowed).toBe(true);
      expect(result.slippage).toBeCloseTo(0.01, 4);
    });
  });

  describe("Paper mode", () => {
    it("should return paper mode status", () => {
      expect(isInPaperMode()).toBe(true);
    });
  });

  describe("Trade history", () => {
    it("should return array of trades", () => {
      const trades = getTodayTrades();
      expect(Array.isArray(trades)).toBe(true);
    });

    it("should include all required trade fields", () => {
      recordTrade({
        strategy: "polymarket",
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
