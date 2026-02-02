import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to create mock before hoisting
const mockSendMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Mock the bot module
vi.mock("./bot.js", () => ({
  sendMessage: mockSendMessage,
}));

// Mock env
vi.mock("../../config/env.js", () => ({
  isPaperMode: () => true,
  loadEnv: () => ({
    TIMEZONE: "UTC",
  }),
}));

// Mock database timezones
vi.mock("../database/timezones.js", () => ({
  getUserTimezone: () => null,
}));

// Mock risk manager
vi.mock("../risk/manager.js", () => ({
  getDailyPnl: () => 25.5,
  getDailyPnlPercentage: () => 25.5,
  getTodayTrades: () => [
    { id: "1", strategy: "pumpfun", type: "BUY", amount: 10, price: 0.001, pnl: 15, timestamp: Date.now() },
    { id: "2", strategy: "polymarket", type: "SELL", amount: 20, price: 0.65, pnl: 10.5, timestamp: Date.now() },
  ],
}));

import {
  notifyTrade,
  notifyBuy,
  notifySell,
  notifyError,
  notifyCriticalError,
  notifyBotStarted,
  notifyBotStopped,
  notifyKillSwitch,
  notifyDailySummary,
  notifyLowBalance,
  notifyOpportunity,
} from "./notifications.js";

describe("Telegram Notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("notifyTrade", () => {
    it("should send trade notification", async () => {
      await notifyTrade({
        strategy: "pumpfun",
        type: "BUY",
        amount: 10,
        price: 0.001,
        pnl: 0,
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("[PAPER]"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("BUY"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("PUMPFUN"));
    });
  });

  describe("notifyBuy", () => {
    it("should send buy notification with TX link", async () => {
      await notifyBuy({
        strategy: "pumpfun",
        symbol: "TEST",
        amount: 10,
        price: 0.001,
        txHash: "abc123",
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("BUY"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("TEST"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("solscan.io"));
    });
  });

  describe("notifySell", () => {
    it("should send sell notification with P&L", async () => {
      await notifySell({
        strategy: "polymarket",
        amount: 20,
        price: 0.65,
        pnl: 5,
        pnlPercentage: 25,
        reason: "Take profit",
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("SELL"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("$5.00"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Take profit"));
    });
  });

  describe("notifyError", () => {
    it("should send error notification", async () => {
      await notifyError("Connection failed", "WebSocket");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("ERROR"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Connection failed"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("WebSocket"));
    });
  });

  describe("notifyCriticalError", () => {
    it("should send critical error notification", async () => {
      await notifyCriticalError("Wallet drained");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Check immediately"));
    });
  });

  describe("notifyBotStarted", () => {
    it("should send bot started notification", async () => {
      await notifyBotStarted();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Bot Started"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Paper"));
    });
  });

  describe("notifyBotStopped", () => {
    it("should send bot stopped notification with reason", async () => {
      await notifyBotStopped("Manual shutdown");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Bot Stopped"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Manual shutdown"));
    });
  });

  describe("notifyKillSwitch", () => {
    it("should send kill switch activated notification", async () => {
      await notifyKillSwitch(true, "Manual trigger");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("KILL SWITCH ACTIVATED"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Manual trigger"));
    });

    it("should send kill switch deactivated notification", async () => {
      await notifyKillSwitch(false);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("deactivated"));
    });
  });

  describe("notifyDailySummary", () => {
    it("should send daily summary with stats", async () => {
      await notifyDailySummary();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Daily Summary"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("$25.50"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Pump.fun"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Polymarket"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Win Rate"));
    });
  });

  describe("notifyLowBalance", () => {
    it("should send low balance warning", async () => {
      await notifyLowBalance("SOL", 0.02, 0.05);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Low Balance"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("SOL"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("0.0200"));
    });
  });

  describe("notifyOpportunity", () => {
    it("should send opportunity notification", async () => {
      await notifyOpportunity({
        strategy: "polymarket",
        confidence: 92.5,
        details: "Price discrepancy detected",
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Opportunity"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("92.5%"));
    });
  });
});
