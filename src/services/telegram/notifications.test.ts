import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to create mock before hoisting
const mockSendMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Mock the bot module
vi.mock("./bot.js", () => ({
  sendMessage: mockSendMessage,
}));

// Mock env
vi.mock("../../config/env.js", () => ({
  isPaperMode: (): boolean => true,
  loadEnv: (): Record<string, string> => ({
    TIMEZONE: "UTC",
  }),
}));

// Mock database timezones
vi.mock("../database/timezones.js", () => ({
  getUserTimezone: (): null => null,
}));

// Mock risk manager
vi.mock("../risk/manager.js", () => ({
  getDailyPnl: (): number => 25.5,
  getDailyPnlPercentage: (): number => 25.5,
  getTodayTrades: (): Array<Record<string, unknown>> => [
    { id: "1", strategy: "polymarket", type: "BUY", amount: 10, price: 0.001, pnl: 15, timestamp: Date.now() },
    { id: "2", strategy: "polymarket", type: "SELL", amount: 20, price: 0.65, pnl: 10.5, timestamp: Date.now() },
  ],
}));

import {
  notifyCriticalError,
  notifyBotStarted,
  notifyBotStopped,
  notifyKillSwitch,
  notifyDailySummary,
} from "./notifications.js";

describe("Telegram Notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Total Trades"));
      expect(mockSendMessage).toHaveBeenCalledWith(expect.stringContaining("Win Rate"));
    });
  });
});
