import { Bot, Context } from "grammy";
import { loadEnv } from "../../config/env.js";
import {
  getRiskStatus,
  activateKillSwitch,
  deactivateKillSwitch,
  pauseTrading,
  resumeTrading,
  getDailyPnl,
  getDailyPnlPercentage,
  getTodayTrades,
} from "../risk/manager.js";
import { getSolBalanceFormatted } from "../solana/wallet.js";
import { getMaticBalanceFormatted, getUsdcBalanceFormatted } from "../polygon/wallet.js";
import { getUserTimezone, setUserTimezone } from "../database/timezones.js";

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = null;
let lastDataMessageId: number | null = null;
let lastTimezonePromptId: number | null = null;
let lastStatusUpdateId: number | null = null;

const MAIN_MENU_BUTTONS = [
  [{ text: "📊 Status", callback_data: "status" }],
  [{ text: "💰 Balance", callback_data: "balance" }],
  [{ text: "📈 P&L", callback_data: "pnl" }],
  [{ text: "🔄 Trades", callback_data: "trades" }],
  [
    { text: "⏸️ Stop", callback_data: "stop" },
    { text: "▶️ Resume", callback_data: "resume" },
  ],
  [
    { text: "⛔ Kill", callback_data: "kill" },
    { text: "✅ Unkill", callback_data: "unkill" },
  ],
  [{ text: "⏱️ Timezone", callback_data: "timezone" }],
];

export async function startBot(): Promise<void> {
  const env = loadEnv();
  chatId = env.TELEGRAM_CHAT_ID;

  bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Command handlers
  bot.command("start", handleStart);
  bot.command("status", handleStatus);
  bot.command("balance", handleBalance);
  bot.command("pnl", handlePnl);
  bot.command("trades", handleTrades);
  bot.command("timezone", handleTimezone);
  bot.command("stop", handleStop);
  bot.command("resume", handleResume);
  bot.command("kill", handleKill);
  bot.command("unkill", handleUnkill);

  // Inline button callback handlers
  bot.callbackQuery("status", async (ctx) => {
    await handleStatus(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("balance", async (ctx) => {
    await handleBalance(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("pnl", async (ctx) => {
    await handlePnl(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("trades", async (ctx) => {
    await handleTrades(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("timezone", async (ctx) => {
    await handleTimezone(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("stop", async (ctx) => {
    await handleStop(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("resume", async (ctx) => {
    await handleResume(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("kill", async (ctx) => {
    await handleKill(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("unkill", async (ctx) => {
    await handleUnkill(ctx);
    await ctx.answerCallbackQuery();
  });

  // Text handler for timezone detection during setup
  bot.on("message:text", handleTextInput);

  // Error handling
  bot.catch((err) => {
    console.error("[Telegram] Bot error:", err);
  });

  // Start polling in background (don't await - it's infinite)
  bot.start().catch((err) => {
    console.error("[Telegram] Bot start error:", err);
    process.exit(1);
  });
  console.log("[Telegram] Bot started");
}

export function stopBot(): void {
  if (bot) {
    bot.stop();
    bot = null;
    console.log("[Telegram] Bot stopped");
  }
}

export function getBot(): Bot | null {
  return bot;
}

export function getChatId(): string | null {
  return chatId;
}

// Send message to configured chat
export async function sendMessage(text: string): Promise<void> {
  if (!bot || !chatId) {
    console.warn("[Telegram] Bot not initialized, cannot send message");
    return;
  }

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[Telegram] Failed to send message:", err);
  }
}

export async function sendMainMenu(): Promise<void> {
  if (!bot || !chatId) {
    console.warn("[Telegram] Bot not initialized, cannot send menu");
    return;
  }

  try {
    // Delete previous menu if exists
    if (lastMenuMessageId) {
      await bot.api.deleteMessage(chatId, lastMenuMessageId).catch(() => {});
    }
    const msg = await bot.api.sendMessage(chatId, "🤖", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS },
    });
    lastMenuMessageId = msg.message_id;
  } catch (err) {
    console.error("[Telegram] Failed to send menu:", err);
  }
}

// Send data message and delete previous one to keep chat clean
async function sendDataMessage(text: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    // Delete previous data message if exists
    if (lastDataMessageId) {
      await bot.api.deleteMessage(chatId, lastDataMessageId).catch(() => {});
    }
    const msg = await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    lastDataMessageId = msg.message_id;
  } catch (err) {
    console.error("[Telegram] Failed to send data message:", err);
  }
}

// Send status message and delete previous one to keep chat clean
export async function sendStatusMessage(text: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    // Delete previous status message if exists
    if (lastStatusUpdateId) {
      await bot.api.deleteMessage(chatId, lastStatusUpdateId).catch(() => {});
    }
    const msg = await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    lastStatusUpdateId = msg.message_id;
  } catch (err) {
    console.error("[Telegram] Failed to send status message:", err);
  }
}

// Command handlers
async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    await ctx.reply("Could not identify user");
    return;
  }

  let userTz = getUserTimezone(userId);
  if (!userTz) {
    setUserTimezone(userId, "UTC");
    userTz = "UTC";
  }


  const msg = await ctx.reply("🤖 Trading Bot", {
    reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS },
  });
  lastMenuMessageId = msg.message_id;
}

async function handleStatus(_ctx: Context): Promise<void> {
  try {
    const status = await getRiskStatus();

    const statusEmoji = status.tradingEnabled ? "🟢" : "🔴";
    const modeEmoji = status.isPaperMode ? "📝" : "💰";
    const killEmoji = status.killSwitchActive ? "⛔" : "✅";

    const message =
      `<b>Bot Status</b>\n\n` +
      `${statusEmoji} Trading: ${status.tradingEnabled ? "Enabled" : "Disabled"}\n` +
      `${modeEmoji} Mode: ${status.isPaperMode ? "Paper" : "Live"}\n` +
      `${killEmoji} Kill Switch: ${status.killSwitchActive ? "ACTIVE" : "Off"}\n\n` +
      `<b>Balances</b>\n` +
      `SOL: ${status.solBalance.toFixed(4)}\n` +
      `MATIC: ${status.maticBalance.toFixed(4)}\n` +
      `Gas OK: ${status.hasMinGas ? "Yes" : "No"}\n\n` +
      `<b>Daily P&L</b>\n` +
      `$${status.dailyPnl.toFixed(2)} (${status.dailyPnlPercentage.toFixed(1)}%)` +
      (status.pauseReason ? `\n\n⚠️ Pause Reason: ${status.pauseReason}` : "");

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Status error:", err);
  }
}

async function handleBalance(_ctx: Context): Promise<void> {
  try {
    const [solBalance, maticBalance, usdcBalance] = await Promise.all([
      getSolBalanceFormatted(),
      getMaticBalanceFormatted(),
      getUsdcBalanceFormatted(),
    ]);

    const message =
      `<b>Wallet Balances</b>\n\n` +
      `<b>Solana</b>\n` +
      `SOL: ${solBalance}\n\n` +
      `<b>Polygon</b>\n` +
      `MATIC: ${maticBalance}\n` +
      `USDC: ${usdcBalance}`;

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Balance error:", err);
  }
}

async function handlePnl(_ctx: Context): Promise<void> {
  try {
    const pnl = getDailyPnl();
    const pnlPct = getDailyPnlPercentage();
    const trades = getTodayTrades();

    const emoji = pnl >= 0 ? "📈" : "📉";

    const message =
      `<b>Daily P&L</b>\n\n` +
      `${emoji} $${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n\n` +
      `Trades Today: ${trades.length}\n` +
      `Wins: ${trades.filter((t) => t.pnl > 0).length}\n` +
      `Losses: ${trades.filter((t) => t.pnl < 0).length}`;

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] P&L error:", err);
  }
}

async function handleTrades(_ctx: Context): Promise<void> {
  try {
    const trades = getTodayTrades();

    if (trades.length === 0) {
      await sendDataMessage("No trades today");
      await sendMainMenu();
      return;
    }

    const recentTrades = trades.slice(-10); // Last 10 trades

    let message = `<b>Recent Trades</b> (${trades.length} total)\n\n`;

    for (const trade of recentTrades) {
      const emoji = trade.pnl >= 0 ? "🟢" : "🔴";
      const time = new Date(trade.timestamp).toLocaleTimeString();
      message +=
        `${emoji} ${trade.type} ${trade.strategy}\n` +
        `   $${trade.amount.toFixed(2)} @ ${trade.price.toFixed(6)}\n` +
        `   P&L: $${trade.pnl.toFixed(2)} | ${time}\n\n`;
    }

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Trades error:", err);
  }
}

async function handleStop(_ctx: Context): Promise<void> {
  pauseTrading("Manual pause via Telegram");
  console.log("[Telegram] Trading paused by user");
  await sendDataMessage("⏸️ Trading paused");
  await sendMainMenu();
}

async function handleResume(_ctx: Context): Promise<void> {
  resumeTrading();
  console.log("[Telegram] Trading resumed by user");
  await sendDataMessage("▶️ Trading resumed");
  await sendMainMenu();
}

async function handleKill(_ctx: Context): Promise<void> {
  activateKillSwitch();
  console.log("[Telegram] Kill switch activated by user");
  await sendDataMessage("⛔ Kill switch activated");
  await sendMainMenu();
}

async function handleUnkill(_ctx: Context): Promise<void> {
  deactivateKillSwitch();
  console.log("[Telegram] Kill switch deactivated by user");
  await sendDataMessage("✅ Kill switch deactivated");
  await sendMainMenu();
}

async function handleTimezone(ctx: Context): Promise<void> {
  const msg = await ctx.reply("What is your current time? (format: HH:MM, e.g., 14:30)");
  lastTimezonePromptId = msg.message_id;
}

async function handleTextInput(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId || !ctx.message || !ctx.message.text) {
    return;
  }

  const input = ctx.message.text.trim();

  // Handle time input for timezone detection
  if (input.match(/^(\d{1,2}):(\d{2})$/)) {
    const timeMatch = input.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
      await ctx.reply("Invalid format. Use HH:MM (e.g., 14:30)");
      return;
    }

    const userHour = parseInt(timeMatch[1], 10);
    const userMinute = parseInt(timeMatch[2], 10);

    if (userHour > 23 || userMinute > 59) {
      await ctx.reply("Invalid time. Hours: 0-23, Minutes: 0-59");
      return;
    }

    const serverTime = new Date();
    const serverHour = serverTime.getHours();
    const serverMinute = serverTime.getMinutes();

    const userTimeMinutes = userHour * 60 + userMinute;
    const serverTimeMinutes = serverHour * 60 + serverMinute;
    let offsetMinutes = userTimeMinutes - serverTimeMinutes;

    if (offsetMinutes < -720) offsetMinutes += 1440;
    if (offsetMinutes > 720) offsetMinutes -= 1440;

    const offsetHours = Math.round(offsetMinutes / 60);
    const tz = findTimezoneForOffset(offsetHours);

    if (!tz) {
      await ctx.reply(
        `Offset: UTC${offsetHours > 0 ? "+" : ""}${offsetHours}\n\n` +
          "Could not auto-detect timezone"
      );
      return;
    }

    setUserTimezone(userId, tz);

    // Delete timezone prompt and user's message
    if (lastTimezonePromptId) {
      await bot?.api.deleteMessage(chatId!, lastTimezonePromptId).catch(() => {});
      lastTimezonePromptId = null;
    }
    await bot?.api.deleteMessage(chatId!, ctx.message.message_id).catch(() => {});

    // Show menu
    await sendMainMenu();
    return;
  }
}

function findTimezoneForOffset(offsetHours: number): string | null {
  const testDate = new Date();

  for (const tz of Intl.supportedValuesOf("timeZone")) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(testDate);
    const tzHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const serverHour = testDate.getUTCHours();

    let diff = tzHour - serverHour;
    if (diff < -12) diff += 24;
    if (diff > 12) diff -= 24;

    if (diff === offsetHours) {
      return tz;
    }
  }

  return null;
}
