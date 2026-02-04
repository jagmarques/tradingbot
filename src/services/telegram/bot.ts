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
import { getEthBalance as getBaseEthBalance } from "../base/executor.js";
import { getBnbBalance } from "../bnb/executor.js";
import { getEthBalance as getArbitrumEthBalance } from "../arbitrum/executor.js";
import { getAvaxBalance } from "../avalanche/executor.js";
import { getTrackedTraderCount, isTrackerRunning } from "../traders/tracker.js";
import { getTopTraders } from "../traders/storage.js";

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = null;
let lastDataMessageId: number | null = null;
let lastTimezonePromptId: number | null = null;
let lastStatusUpdateId: number | null = null;

// Authorization check - strict security
// Only the authorized user (TELEGRAM_CHAT_ID) can send commands
// This works in both private chats and groups
function isAuthorized(ctx: Context): boolean {
  const fromId = ctx.from?.id?.toString();

  // Must have a sender
  if (!fromId) return false;

  // Only the configured user can send commands
  // TELEGRAM_CHAT_ID should be the user's ID, not a group ID
  return fromId === chatId;
}

const MAIN_MENU_BUTTONS = [
  [{ text: "📊 Status", callback_data: "status" }],
  [{ text: "💰 Balance", callback_data: "balance" }],
  [{ text: "📈 P&L", callback_data: "pnl" }],
  [{ text: "🔄 Trades", callback_data: "trades" }],
  [{ text: "📋 Traders", callback_data: "traders" }],
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
  bot.command("traders", handleTraders);
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
  bot.callbackQuery("traders", async (ctx) => {
    await handleTraders(ctx);
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
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /start from user ${ctx.from?.id}`);
    return;
  }

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


  const msg = await ctx.reply("🤖", {
    reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS },
  });
  lastMenuMessageId = msg.message_id;
}

async function handleStatus(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /status from user ${ctx.from?.id}`);
    return;
  }

  try {
    const status = await getRiskStatus();
    const traderCount = getTrackedTraderCount();
    const trackerActive = isTrackerRunning();

    const statusEmoji = status.tradingEnabled ? "🟢" : "🔴";
    const modeEmoji = status.isPaperMode ? "📝" : "💰";
    const killEmoji = status.killSwitchActive ? "⛔" : "✅";
    const trackerEmoji = trackerActive ? "🟢" : "🔴";

    const message =
      `<b>Bot Status</b>\n\n` +
      `${statusEmoji} Trading: ${status.tradingEnabled ? "Enabled" : "Disabled"}\n` +
      `${modeEmoji} Mode: ${status.isPaperMode ? "Paper" : "Live"}\n` +
      `${killEmoji} Kill Switch: ${status.killSwitchActive ? "ACTIVE" : "Off"}\n\n` +
      `<b>Balances</b>\n` +
      `SOL: ${status.solBalance.toFixed(4)}\n` +
      `MATIC: ${status.maticBalance.toFixed(4)}\n` +
      `Gas OK: ${status.hasMinGas ? "Yes" : "No"}\n\n` +
      `<b>Trader Tracker</b>\n` +
      `${trackerEmoji} Status: ${trackerActive ? "Running" : "Stopped"}\n` +
      `Tracked Traders: ${traderCount}\n\n` +
      `<b>Daily P&L</b>\n` +
      `$${status.dailyPnl.toFixed(2)} (${status.dailyPnlPercentage.toFixed(1)}%)` +
      (status.pauseReason ? `\n\n⚠️ Pause Reason: ${status.pauseReason}` : "");

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Status error:", err);
  }
}

async function handleBalance(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /balance from user ${ctx.from?.id}`);
    return;
  }

  try {
    const [
      solBalance,
      maticBalance,
      usdcBalance,
      baseEthBalance,
      bnbBalance,
      arbitrumEthBalance,
      avaxBalance,
    ] = await Promise.all([
      getSolBalanceFormatted(),
      getMaticBalanceFormatted(),
      getUsdcBalanceFormatted(),
      getBaseEthBalance().catch(() => BigInt(0)),
      getBnbBalance().catch(() => BigInt(0)),
      getArbitrumEthBalance().catch(() => BigInt(0)),
      getAvaxBalance().catch(() => BigInt(0)),
    ]);

    // Format EVM balances (wei to native token with 4 decimals)
    const formatWei = (wei: bigint): string => (Number(wei) / 1e18).toFixed(4);

    const message =
      `<b>Wallet Balances</b>\n\n` +
      `<b>Solana</b>\n` +
      `SOL: ${solBalance}\n\n` +
      `<b>Polygon</b>\n` +
      `MATIC: ${maticBalance}\n` +
      `USDC: ${usdcBalance}\n\n` +
      `<b>Base</b>\n` +
      `ETH: ${formatWei(baseEthBalance)}\n\n` +
      `<b>BNB Chain</b>\n` +
      `BNB: ${formatWei(bnbBalance)}\n\n` +
      `<b>Arbitrum</b>\n` +
      `ETH: ${formatWei(arbitrumEthBalance)}\n\n` +
      `<b>Avalanche</b>\n` +
      `AVAX: ${formatWei(avaxBalance)}`;

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Balance error:", err);
  }
}

async function handlePnl(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /pnl from user ${ctx.from?.id}`);
    return;
  }

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

async function handleTrades(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /trades from user ${ctx.from?.id}`);
    return;
  }

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

async function handleTraders(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /traders from user ${ctx.from?.id}`);
    return;
  }

  try {
    const traderCount = getTrackedTraderCount();
    const trackerRunning = isTrackerRunning();
    const topTradersList = getTopTraders(10);

    let message = `<b>Trader Tracker</b>\n\n`;
    message += `Status: ${trackerRunning ? "Running" : "Stopped"}\n`;
    message += `Total Tracked: ${traderCount}\n\n`;

    if (topTradersList.length === 0) {
      message += "No traders tracked yet";
    } else {
      message += `<b>Top ${topTradersList.length} Traders</b>\n\n`;

      for (const trader of topTradersList) {
        const addr = trader.address.slice(0, 6) + "..." + trader.address.slice(-4);
        const winRate = trader.winRate.toFixed(0);
        message +=
          `${trader.chain.toUpperCase()} | ${addr}\n` +
          `   Score: ${trader.score.toFixed(0)} | Win: ${winRate}%\n` +
          `   Trades: ${trader.totalTrades} | PnL: $${trader.totalPnlUsd.toFixed(0)}\n\n`;
      }
    }

    await sendDataMessage(message);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Traders error:", err);
  }
}

async function handleStop(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /stop from user ${ctx.from?.id}`);
    return;
  }

  pauseTrading("Manual pause via Telegram");
  console.log("[Telegram] Trading paused by user");
  await sendDataMessage("Trading paused");
  await sendMainMenu();
}

async function handleResume(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /resume from user ${ctx.from?.id}`);
    return;
  }

  resumeTrading();
  console.log("[Telegram] Trading resumed by user");
  await sendDataMessage("Trading resumed");
  await sendMainMenu();
}

async function handleKill(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /kill from user ${ctx.from?.id}`);
    return;
  }

  activateKillSwitch();
  console.log("[Telegram] Kill switch activated by user");
  await sendDataMessage("Kill switch activated");
  await sendMainMenu();
}

async function handleUnkill(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /unkill from user ${ctx.from?.id}`);
    return;
  }

  deactivateKillSwitch();
  console.log("[Telegram] Kill switch deactivated by user");
  await sendDataMessage("Kill switch deactivated");
  await sendMainMenu();
}

async function handleTimezone(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /timezone from user ${ctx.from?.id}`);
    return;
  }

  const msg = await ctx.reply("What is your current time? (format: HH:MM, e.g., 14:30)");
  lastTimezonePromptId = msg.message_id;
}

async function handleTextInput(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    return;
  }

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
    if (chatId && lastTimezonePromptId) {
      await bot?.api.deleteMessage(chatId, lastTimezonePromptId).catch(() => {});
      lastTimezonePromptId = null;
    }
    if (chatId) {
      await bot?.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    }

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
