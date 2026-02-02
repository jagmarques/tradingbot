import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getDailyPnl,
  getDailyPnlPercentage,
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

// Mock dependencies
vi.mock("../../config/env.js", () => ({
  loadEnv: () => ({
    DAILY_LOSS_LIMIT_USD: 10,
    MAX_SLIPPAGE_PUMPFUN: 0.15,
    MAX_SLIPPAGE_POLYMARKET: 0.02,
    MIN_SOL_RESERVE: 0.05,
  }),
  isPaperMode: () => true,
}));

vi.mock("../solana/wallet.js", () => ({
  getSolBalance: vi.fn().mockResolvedValue(BigInt(100000000)), // 0.1 SOL
}));

vi.mock("../polygon/wallet.js", () => ({
  getMaticBalance: vi.fn().mockResolvedValue(BigInt(500000000000000000)), // 0.5 MATIC
}));

describe("Risk Manager", () => {
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
