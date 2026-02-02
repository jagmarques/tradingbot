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
import { getUserTimezone, setUserTimezone, isValidTimezone } from "../database/timezones.js";

let bot: Bot | null = null;
let chatId: string | null = null;

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

  // Callback query handler for timezone selection
  bot.callbackQuery(/^tz:/, handleTimezoneCallback);

  // Text handler for timezone detection from user time input
  bot.on("message:text", handleTimeInput);

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

// Command handlers
async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    await ctx.reply("Could not identify user");
    return;
  }

  const userTz = getUserTimezone(userId);
  if (!userTz) {
    await ctx.reply("What is your current time? (format: HH:MM, e.g., 14:30)");
    return;
  }

  await ctx.reply(
    "Trading Bot Active\n\n" +
      "Commands:\n" +
      "/status - Current bot status\n" +
      "/balance - Wallet balances\n" +
      "/pnl - Daily P&L\n" +
      "/trades - Today's trades\n" +
      "/timezone - Change timezone\n" +
      "/stop - Pause trading\n" +
      "/resume - Resume trading\n" +
      "/kill - Emergency stop all\n" +
      "/unkill - Deactivate kill switch\n" +
      ""
  );
}

async function handleStatus(ctx: Context): Promise<void> {
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

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply("Error fetching status");
    console.error("[Telegram] Status error:", err);
  }
}

async function handleBalance(ctx: Context): Promise<void> {
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

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply("Error fetching balances");
    console.error("[Telegram] Balance error:", err);
  }
}

async function handlePnl(ctx: Context): Promise<void> {
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

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply("Error fetching P&L");
    console.error("[Telegram] P&L error:", err);
  }
}

async function handleTrades(ctx: Context): Promise<void> {
  try {
    const trades = getTodayTrades();

    if (trades.length === 0) {
      await ctx.reply("No trades today");
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

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply("Error fetching trades");
    console.error("[Telegram] Trades error:", err);
  }
}

async function handleStop(ctx: Context): Promise<void> {
  pauseTrading("Manual pause via Telegram");
  await ctx.reply("⏸️ Trading paused");
  console.log("[Telegram] Trading paused by user");
}

async function handleResume(ctx: Context): Promise<void> {
  resumeTrading();
  await ctx.reply("▶️ Trading resumed");
  console.log("[Telegram] Trading resumed by user");
}

async function handleKill(ctx: Context): Promise<void> {
  activateKillSwitch();
  await ctx.reply("⛔ KILL SWITCH ACTIVATED\nAll trading stopped immediately");
  console.log("[Telegram] Kill switch activated by user");
}

async function handleUnkill(ctx: Context): Promise<void> {
  deactivateKillSwitch();
  await ctx.reply("✅ Kill switch deactivated\nTrading can resume");
  console.log("[Telegram] Kill switch deactivated by user");
}

async function handleTimezone(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    await ctx.reply("Could not identify user");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.split(/\s+/).slice(1);

  if (args.length === 0) {
    const current = getUserTimezone(userId);
    if (current) {
      await ctx.reply(`Your timezone: ${current}`);
    } else {
      await ctx.reply("No timezone set. Usage: /timezone Europe/Amsterdam");
    }
    return;
  }

  const tz = args[0];
  if (!isValidTimezone(tz)) {
    await ctx.reply(`Invalid timezone: ${tz}\n\nExamples:\n- Europe/Amsterdam\n- America/New_York\n- Asia/Tokyo\n- UTC`);
    return;
  }

  setUserTimezone(userId, tz);
  await ctx.reply(`Timezone set to: ${tz}`);
}

async function handleTimezoneCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    await ctx.answerCallbackQuery({ text: "Could not identify user" });
    return;
  }

  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData || !callbackData.startsWith("tz:")) {
    await ctx.answerCallbackQuery({ text: "Invalid timezone selection" });
    return;
  }

  const timezone = callbackData.substring(3);
  if (!isValidTimezone(timezone)) {
    await ctx.answerCallbackQuery({ text: "Invalid timezone" });
    return;
  }

  setUserTimezone(userId, timezone);
  await ctx.answerCallbackQuery({ text: `Timezone set to ${timezone}` });
  await ctx.editMessageText(
    "Trading Bot Active\n\n" +
      "Commands:\n" +
      "/status - Current bot status\n" +
      "/balance - Wallet balances\n" +
      "/pnl - Daily P&L\n" +
      "/trades - Today's trades\n" +
      "/timezone - Change timezone\n" +
      "/stop - Pause trading\n" +
      "/resume - Resume trading\n" +
      "/kill - Emergency stop all\n" +
      "/unkill - Deactivate kill switch\n" +
      ""
  );
}

async function handleTimeInput(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();
  if (!userId || !ctx.message || !ctx.message.text) {
    return;
  }

  const userTz = getUserTimezone(userId);
  if (userTz) {
    return;
  }

  const input = ctx.message.text.trim();
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
        "Could not auto-detect. Enter: /timezone Europe/London"
    );
    return;
  }

  setUserTimezone(userId, tz);

  await ctx.reply(
    "Trading Bot Active\n\n" +
      "Commands:\n" +
      "/status - Current bot status\n" +
      "/balance - Wallet balances\n" +
      "/pnl - Daily P&L\n" +
      "/trades - Today's trades\n" +
      "/timezone - Change timezone\n" +
      "/stop - Pause trading\n" +
      "/resume - Resume trading\n" +
      "/kill - Emergency stop all\n" +
      "/unkill - Deactivate kill switch"
  );
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
