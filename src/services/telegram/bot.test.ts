import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Create mock functions that will be shared
const mockCommand = vi.fn();
const mockCallbackQuery = vi.fn();
const mockCatch = vi.fn();
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue({});
const mockOn = vi.fn();

// Mock Grammy - must use class syntax for constructors
vi.mock("grammy", () => {
  return {
    Bot: class MockBot {
      command = mockCommand;
      callbackQuery = mockCallbackQuery;
      catch = mockCatch;
      start = mockStart;
      stop = mockStop;
      on = mockOn;
      api = { sendMessage: mockSendMessage };
    },
    InlineKeyboard: class MockInlineKeyboard {
      text(): this { return this; }
      row(): this { return this; }
    },
  };
});

// Mock env
vi.mock("../../config/env.js", () => ({
  loadEnv: (): Record<string, string> => ({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "123456789",
  }),
  isPaperMode: (): boolean => true,
}));

// Mock risk manager
vi.mock("../risk/manager.js", () => ({
  getRiskStatus: vi.fn().mockResolvedValue({
    tradingEnabled: true,
    killSwitchActive: false,
    dailyPnl: 5.5,
    dailyPnlPercentage: 5.5,
    maticBalance: 0.5,
    hasMinGas: true,
    isPaperMode: true,
  }),
  activateKillSwitch: vi.fn(),
  deactivateKillSwitch: vi.fn(),
  getDailyPnl: vi.fn().mockReturnValue(5.5),
  getDailyPnlPercentage: vi.fn().mockReturnValue(5.5),
  getTodayTrades: vi.fn().mockReturnValue([]),
}));

// Mock wallets
vi.mock("../polygon/wallet.js", () => ({
  getMaticBalanceFormatted: vi.fn().mockResolvedValue("0.5000"),
  getUsdcBalanceFormatted: vi.fn().mockResolvedValue("50.00"),
}));

// Mock timezone database
vi.mock("../database/timezones.js", () => ({
  getUserTimezone: vi.fn().mockReturnValue("UTC"),
  setUserTimezone: vi.fn(),
  isValidTimezone: vi.fn().mockReturnValue(true),
}));

import { startBot, stopBot, getBot, getChatId, sendMessage } from "./bot.js";

describe("Telegram Bot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopBot();
  });

  describe("startBot", () => {
    it("should start the bot", async () => {
      await startBot();
      expect(getBot()).not.toBeNull();
      expect(getChatId()).toBe("123456789");
    });

    it("should register command handlers", async () => {
      await startBot();
      expect(mockCommand).toHaveBeenCalledWith("start", expect.any(Function));
      expect(mockCommand).toHaveBeenCalledWith("status", expect.any(Function));
      expect(mockCommand).toHaveBeenCalledWith("balance", expect.any(Function));
      expect(mockCommand).toHaveBeenCalledWith("stop", expect.any(Function));
    });
  });

  describe("stopBot", () => {
    it("should stop the bot", async () => {
      await startBot();
      expect(getBot()).not.toBeNull();
      stopBot();
      expect(getBot()).toBeNull();
    });
  });

  describe("sendMessage", () => {
    it("should send message when bot is initialized", async () => {
      await startBot();
      await sendMessage("Test message");

      expect(mockSendMessage).toHaveBeenCalledWith("123456789", "Test message", {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "Clear", callback_data: "clear_chat" }]],
        },
      });
    });

    it("should not throw when bot is not initialized", async () => {
      stopBot();
      await expect(sendMessage("Test message")).resolves.not.toThrow();
    });
  });
});
