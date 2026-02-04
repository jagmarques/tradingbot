import { Bot, Context, InputFile } from "grammy";
import { loadEnv } from "../../config/env.js";
import { exportTradersToPdf } from "./pdf-export.js";
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
import { getCopyStats, getOpenCopiedPositions } from "../polytraders/index.js";
import { getTopTraders, getTopTradersSorted, getTokenTrades, getTrader, type TraderSortBy } from "../traders/storage.js";
import { Chain } from "../traders/types.js";
import {
  getSettings,
  toggleAutoSnipe,
  toggleAutoCopy,
  updateSetting,
} from "../settings/settings.js";
import { callDeepSeek } from "../aibetting/deepseek.js";
import { getBettingStats, loadOpenPositions, getRecentBetOutcomes } from "../database/aibetting.js";
import { getAIBettingStatus } from "../aibetting/scheduler.js";

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = null;
let lastDataMessageId: number | null = null;
let lastTimezonePromptId: number | null = null;
let lastStatusUpdateId: number | null = null;
let lastPromptMessageId: number | null = null;
let currentTraderSort: TraderSortBy = "score";

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
  [{ text: "Settings", callback_data: "settings" }],
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
  bot.command("traderspdf", handleTradersPdf);
  bot.command("ai", handleAI);

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

  // Handle trader detail button clicks (format: trader_ADDRESS_CHAIN)
  bot.callbackQuery(/^trader_(.+)_(.+)$/, async (ctx) => {
    await handleTraderDetail(ctx);
    await ctx.answerCallbackQuery();
  });

  // Handle back to traders list
  bot.callbackQuery("back_to_traders", async (ctx) => {
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });

  // Trader sort callbacks
  bot.callbackQuery("sort_score", async (ctx) => {
    currentTraderSort = "score";
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("sort_pnl", async (ctx) => {
    currentTraderSort = "pnl";
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("sort_pnl_pct", async (ctx) => {
    currentTraderSort = "pnl_pct";
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });

  // Settings callbacks
  bot.callbackQuery("settings", async (ctx) => {
    await handleSettings(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("toggle_autosnipe", async (ctx) => {
    await handleToggleAutoSnipe(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("toggle_autocopy", async (ctx) => {
    await handleToggleAutoCopy(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_min_score", async (ctx) => {
    await handleSetMinScore(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_max_daily", async (ctx) => {
    await handleSetMaxDaily(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_copy_sol", async (ctx) => {
    await handleSetCopyAmount(ctx, "copy_sol");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_copy_eth", async (ctx) => {
    await handleSetCopyAmount(ctx, "copy_eth");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_copy_matic", async (ctx) => {
    await handleSetCopyAmount(ctx, "copy_matic");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_copy_default", async (ctx) => {
    await handleSetCopyAmount(ctx, "copy_default");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("set_copy_poly", async (ctx) => {
    await handleSetCopyAmount(ctx, "copy_poly");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("main_menu", async (ctx) => {
    await sendMainMenu();
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
    // Delete all tracked messages when returning to menu
    if (lastMenuMessageId) {
      await bot.api.deleteMessage(chatId, lastMenuMessageId).catch(() => {});
      lastMenuMessageId = null;
    }
    if (lastDataMessageId) {
      await bot.api.deleteMessage(chatId, lastDataMessageId).catch(() => {});
      lastDataMessageId = null;
    }
    if (lastPromptMessageId) {
      await bot.api.deleteMessage(chatId, lastPromptMessageId).catch(() => {});
      lastPromptMessageId = null;
    }
    if (lastTimezonePromptId) {
      await bot.api.deleteMessage(chatId, lastTimezonePromptId).catch(() => {});
      lastTimezonePromptId = null;
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
async function sendDataMessage(text: string, inlineKeyboard?: { text: string; callback_data: string }[][]): Promise<void> {
  if (!bot || !chatId) return;
  try {
    // Delete previous data message if exists
    if (lastDataMessageId) {
      await bot.api.deleteMessage(chatId, lastDataMessageId).catch(() => {});
    }
    const options: { parse_mode: "HTML"; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } = {
      parse_mode: "HTML",
    };
    if (inlineKeyboard) {
      options.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    const msg = await bot.api.sendMessage(chatId, text, options);
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
    const formatWei = (wei: bigint): string => (Number(wei) / 1e18).toFixed(4);

    // Fetch balances sequentially to avoid RPC batching issues
    const solBalance = await getSolBalanceFormatted().catch(() => "Error");
    const maticBalance = await getMaticBalanceFormatted().catch(() => "Error");
    const usdcBalance = await getUsdcBalanceFormatted().catch(() => "Error");
    const baseEthBalance = await getBaseEthBalance().catch(() => BigInt(0));
    const bnbBalance = await getBnbBalance().catch(() => BigInt(0));
    const arbitrumEthBalance = await getArbitrumEthBalance().catch(() => BigInt(0));
    const avaxBalance = await getAvaxBalance().catch(() => BigInt(0));

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
    await sendDataMessage("Failed to fetch balances");
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
    const topTradersList = getTopTradersSorted(10, currentTraderSort);

    // Sort label
    const sortLabels: Record<TraderSortBy, string> = {
      score: "Score",
      pnl: "Total PnL",
      pnl_pct: "PnL %",
    };

    let message = `<b>Trader Tracker</b>\n\n`;
    message += `Status: ${trackerRunning ? "Running" : "Stopped"}\n`;
    message += `Total Tracked: ${traderCount}\n`;
    message += `Sorted by: <b>${sortLabels[currentTraderSort]}</b>\n\n`;

    if (topTradersList.length === 0) {
      message += "No traders tracked yet";
      await sendDataMessage(message);
      await sendMainMenu();
      return;
    }

    message += "Click a trader to see details:";

    // Sort filter buttons at top
    const sortButtons: { text: string; callback_data: string }[][] = [[
      { text: currentTraderSort === "score" ? "* Score" : "Score", callback_data: "sort_score" },
      { text: currentTraderSort === "pnl" ? "* $ PnL" : "$ PnL", callback_data: "sort_pnl" },
      { text: currentTraderSort === "pnl_pct" ? "* % PnL" : "% PnL", callback_data: "sort_pnl_pct" },
    ]];

    // Create inline keyboard buttons for each trader
    const traderButtons: { text: string; callback_data: string }[][] = [];
    for (const trader of topTradersList) {
      const pnlSign = trader.totalPnlUsd >= 0 ? "+" : "";
      const pctSign = trader.pnlPct >= 0 ? "+" : "";
      const investedStr = trader.totalInvested > 0 ? `$${trader.totalInvested.toFixed(0)}` : "?";

      let buttonText: string;
      if (currentTraderSort === "pnl_pct") {
        // Show % prominently when sorted by %
        buttonText = `${pctSign}${trader.pnlPct.toFixed(0)}% | ${trader.chain.toUpperCase()} | ${pnlSign}$${trader.totalPnlUsd.toFixed(0)} from ${investedStr}`;
      } else if (currentTraderSort === "pnl") {
        // Show $ PnL prominently
        buttonText = `${pnlSign}$${trader.totalPnlUsd.toFixed(0)} | ${trader.chain.toUpperCase()} | ${trader.winRate.toFixed(0)}%W | ${pctSign}${trader.pnlPct.toFixed(0)}%`;
      } else {
        // Default: show score prominently
        buttonText = `${trader.score.toFixed(0)}pt | ${trader.chain.toUpperCase()} | ${trader.winRate.toFixed(0)}%W | ${pnlSign}$${trader.totalPnlUsd.toFixed(0)}`;
      }

      traderButtons.push([{
        text: buttonText,
        callback_data: `trader_${trader.address}_${trader.chain}`,
      }]);
    }

    // Combine sort buttons + trader buttons
    const allButtons = [...sortButtons, ...traderButtons];

    await sendDataMessage(message, allButtons);
    await sendMainMenu();
  } catch (err) {
    console.error("[Telegram] Traders error:", err);
  }
}

async function handleTraderDetail(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized trader detail from user ${ctx.from?.id}`);
    return;
  }

  try {
    // Extract address and chain from callback data (format: trader_ADDRESS_CHAIN)
    const match = ctx.callbackQuery?.data?.match(/^trader_(.+)_(.+)$/);
    if (!match) return;

    const [, address, chain] = match;
    const trader = getTrader(address, chain as Chain);

    if (!trader) {
      await sendDataMessage("Trader not found");
      return;
    }

    const tokenTrades = getTokenTrades(address, chain as Chain);

    let message = `<b>Trader Details</b>\n\n`;
    message += `<b>Chain:</b> ${trader.chain.toUpperCase()}\n`;
    message += `<b>Address:</b>\n<code>${trader.address}</code>\n\n`;
    message += `<b>Score:</b> ${trader.score.toFixed(0)}\n`;
    message += `<b>Win Rate:</b> ${trader.winRate.toFixed(0)}%\n`;
    message += `<b>Total Trades:</b> ${trader.totalTrades}\n`;
    message += `<b>Winning:</b> ${trader.winningTrades} | <b>Losing:</b> ${trader.losingTrades}\n`;
    const pnlSign = trader.totalPnlUsd >= 0 ? "+" : "";
    message += `<b>Total PnL:</b> ${pnlSign}$${trader.totalPnlUsd.toFixed(0)}\n\n`;

    if (tokenTrades.length === 0) {
      message += "<i>No detailed trade history available</i>";
    } else {
      message += `<b>Trade History (${tokenTrades.length} tokens):</b>\n\n`;

      for (const trade of tokenTrades.slice(0, 10)) {
        const tradePnlSign = trade.pnlUsd >= 0 ? "+" : "";
        const pnlPctSign = trade.pnlPct >= 0 ? "+" : "";
        const buyDate = new Date(trade.firstBuyTimestamp).toLocaleDateString();
        const sellDate = new Date(trade.lastSellTimestamp).toLocaleDateString();

        message += `<b>${trade.tokenSymbol}</b>\n`;
        message += `Buy: $${trade.buyAmountUsd.toFixed(0)} (${buyDate})\n`;
        message += `Sell: $${trade.sellAmountUsd.toFixed(0)} (${sellDate})\n`;
        message += `PnL: ${tradePnlSign}$${trade.pnlUsd.toFixed(0)} (${pnlPctSign}${trade.pnlPct.toFixed(0)}%)\n\n`;
      }

      if (tokenTrades.length > 10) {
        message += `<i>...and ${tokenTrades.length - 10} more trades</i>`;
      }
    }

    const backButton = [[{ text: "Back to Traders", callback_data: "back_to_traders" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] Trader detail error:", err);
  }
}

async function handleTradersPdf(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /traderspdf from user ${ctx.from?.id}`);
    return;
  }

  try {
    const allTraders = getTopTraders(100);

    if (allTraders.length === 0) {
      await sendDataMessage("No traders to export");
      return;
    }

    await sendDataMessage(`Generating PDF for ${allTraders.length} traders...`);

    const pdfBuffer = await exportTradersToPdf(allTraders);
    const filename = `traders_${new Date().toISOString().split("T")[0]}.pdf`;

    await ctx.replyWithDocument(new InputFile(pdfBuffer, filename), {
      caption: `Profitable Traders Report - ${allTraders.length} traders`,
    });

    console.log(`[Telegram] Exported ${allTraders.length} traders to PDF`);
  } catch (err) {
    console.error("[Telegram] Traders PDF error:", err);
    await sendDataMessage("Failed to generate PDF");
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

async function handleAI(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /ai from user ${ctx.from?.id}`);
    return;
  }

  const messageText = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  const question = (messageText || "").replace(/^\/ai\s*/i, "").trim();

  if (!question) {
    await ctx.reply(
      "Usage: /ai <question>\n\n" +
      "Examples:\n" +
      "- /ai how many bets did I win?\n" +
      "- /ai what's my total PnL?\n" +
      "- /ai which markets am I in?\n" +
      "- /ai what's the win rate?"
    );
    return;
  }

  await ctx.reply("Thinking...");

  try {
    // Gather ALL available context
    const stats = getBettingStats();
    const openPositions = loadOpenPositions();
    const recentOutcomes = getRecentBetOutcomes(10);
    const schedulerStatus = getAIBettingStatus();
    const riskStatus = await getRiskStatus();
    const dailyPnl = getDailyPnl();
    const dailyPnlPct = getDailyPnlPercentage();
    const todayTrades = getTodayTrades();
    const userId = ctx.from?.id?.toString() || "";
    const settings = getSettings(userId);
    const traderCount = getTrackedTraderCount();
    const trackerRunning = isTrackerRunning();
    const topTraders = getTopTradersSorted(5, "score");

    // Balances
    const solBalance = await getSolBalanceFormatted();
    const usdcBalance = await getUsdcBalanceFormatted();

    // Polymarket copy trading stats
    const copyStats = getCopyStats();
    const openCopiedPositions = getOpenCopiedPositions();

    // Build comprehensive context for AI
    const context = `
You are a helpful trading bot assistant. Answer questions about ANY bot data below.

=== RISK & STATUS ===
- Kill switch: ${riskStatus.killSwitchActive ? "ACTIVE" : "Off"}
- Trading enabled: ${riskStatus.tradingEnabled}
- Paper mode: ${riskStatus.isPaperMode}
- Daily PnL: $${dailyPnl.toFixed(2)} (${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(1)}%)
- SOL balance: ${solBalance}
- USDC balance: ${usdcBalance}

=== USER SETTINGS ===
- Auto-snipe (Pump.fun): ${settings.autoSnipeEnabled ? "ON" : "OFF"}
- Auto-copy (wallets): ${settings.autoCopyEnabled ? "ON" : "OFF"}
- Min trader score: ${settings.minTraderScore}
- Max copies/day: ${settings.maxCopyPerDay}
- Today's copies: ${settings.dailyCopyCount}

=== WALLET COPY TRADING ===
- Tracker running: ${trackerRunning}
- Total tracked wallets: ${traderCount}
- Top 5 traders by score:
${topTraders.map(t => `  - ${t.address.slice(0, 8)}... (${t.chain}) Score:${t.score} WR:${t.winRate.toFixed(0)}% PnL:$${t.totalPnlUsd.toFixed(0)}`).join("\n")}

=== POLYMARKET COPY TRADING ===
- Total copies: ${copyStats.totalCopies}
- Open copied positions: ${copyStats.openPositions}
- Closed: ${copyStats.closedPositions}
- Win rate: ${copyStats.winRate.toFixed(1)}%
- Total PnL: $${copyStats.totalPnl.toFixed(2)}
${openCopiedPositions.length > 0 ? `\nOpen copies:\n${openCopiedPositions.map(p => `  - ${p.marketTitle.slice(0, 40)}... $${p.size} @ ${(p.entryPrice * 100).toFixed(0)}c (copying ${p.traderName})`).join("\n")}` : ""}

=== AI BETTING (Polymarket) ===
- Running: ${schedulerStatus.running}
- Open positions: ${schedulerStatus.openPositions}
- Total exposure: $${schedulerStatus.totalExposure.toFixed(2)}
- Analysis cache: ${schedulerStatus.cacheSize} markets

=== BETTING STATS (all time) ===
- Total bets: ${stats.totalBets}
- Wins: ${stats.wins} | Losses: ${stats.losses}
- Win rate: ${stats.winRate.toFixed(1)}%
- Total PnL: $${stats.totalPnl.toFixed(2)}
- Avg EV: ${(stats.avgEdge * 100).toFixed(1)}%

=== OPEN POLYMARKET POSITIONS ===
${openPositions.length === 0 ? "None" : openPositions.map(p =>
  `- ${p.marketTitle.slice(0, 50)}...\n  ${p.side} @ ${(p.entryPrice * 100).toFixed(0)}c, $${p.size.toFixed(2)}, AI:${(p.aiProbability * 100).toFixed(0)}%`
).join("\n")}

=== RECENT BET OUTCOMES ===
${recentOutcomes.length === 0 ? "None yet" : recentOutcomes.slice(0, 5).map(o =>
  `- ${o.actualOutcome.toUpperCase()}: ${o.marketTitle.slice(0, 35)}... $${o.pnl.toFixed(2)}`
).join("\n")}

=== TODAY'S TRADES ===
- Count: ${todayTrades.length}
- Wins: ${todayTrades.filter(t => t.pnl > 0).length}
- Losses: ${todayTrades.filter(t => t.pnl < 0).length}

Be concise. Answer based on the data above. If asked about something not in the data, say so.`;

    const response = await callDeepSeek(
      `${context}\n\nUSER QUESTION: ${question}`,
      "deepseek-chat"
    );

    // Send response (telegram has 4096 char limit)
    const truncated = response.length > 4000 ? response.slice(0, 4000) + "..." : response;
    await ctx.reply(truncated);
  } catch (error) {
    console.error("[Telegram] AI query failed:", error);
    await ctx.reply("Failed to process AI query. Check logs.");
  }
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

  // Handle settings input mode
  if (settingsInputMode) {
    const numValue = parseFloat(input);

    if (isNaN(numValue)) {
      await ctx.reply("Please enter a valid number");
      return;
    }

    if (settingsInputMode === "min_score") {
      if (numValue < 0 || numValue > 100) {
        await ctx.reply("Min score must be between 0 and 100");
        return;
      }
      updateSetting(userId, "minTraderScore", numValue);
      console.log(`[Telegram] Min score set to ${numValue} by user ${userId}`);
    } else if (settingsInputMode === "max_daily") {
      if (numValue < 1 || numValue > 50) {
        await ctx.reply("Max daily must be between 1 and 50");
        return;
      }
      updateSetting(userId, "maxCopyPerDay", numValue);
      console.log(`[Telegram] Max daily set to ${numValue} by user ${userId}`);
    } else if (settingsInputMode === "copy_sol") {
      if (numValue <= 0 || numValue > 1) {
        await ctx.reply("SOL amount must be between 0 and 1");
        return;
      }
      updateSetting(userId, "copyAmountSol", numValue);
      console.log(`[Telegram] Copy SOL amount set to ${numValue} by user ${userId}`);
    } else if (settingsInputMode === "copy_eth") {
      if (numValue <= 0 || numValue > 0.1) {
        await ctx.reply("ETH amount must be between 0 and 0.1");
        return;
      }
      updateSetting(userId, "copyAmountEth", numValue);
      console.log(`[Telegram] Copy ETH amount set to ${numValue} by user ${userId}`);
    } else if (settingsInputMode === "copy_matic") {
      if (numValue <= 0 || numValue > 100) {
        await ctx.reply("MATIC amount must be between 0 and 100");
        return;
      }
      updateSetting(userId, "copyAmountMatic", numValue);
      console.log(`[Telegram] Copy MATIC amount set to ${numValue} by user ${userId}`);
    } else if (settingsInputMode === "copy_default") {
      if (numValue <= 0 || numValue > 1) {
        await ctx.reply("Default amount must be between 0 and 1");
        return;
      }
      updateSetting(userId, "copyAmountDefault", numValue);
      console.log(`[Telegram] Copy default amount set to ${numValue} by user ${userId}`);
    } else if (settingsInputMode === "copy_poly") {
      if (numValue <= 0 || numValue > 100) {
        await ctx.reply("Polymarket amount must be between $0 and $100");
        return;
      }
      updateSetting(userId, "polymarketCopyUsd", numValue);
      console.log(`[Telegram] Polymarket copy amount set to $${numValue} by user ${userId}`);
    }

    settingsInputMode = null;

    // Delete user's message and prompt message
    if (chatId) {
      await bot?.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
      if (lastPromptMessageId) {
        await bot?.api.deleteMessage(chatId, lastPromptMessageId).catch(() => {});
        lastPromptMessageId = null;
      }
    }

    // Create a mock context for handleSettings
    const settings = getSettings(userId);
    const snipeStatus = settings.autoSnipeEnabled ? "ON" : "OFF";
    const copyStatus = settings.autoCopyEnabled ? "ON" : "OFF";

    const message =
      `<b>Settings</b>\n\n` +
      `<b>AUTO-SNIPE [${snipeStatus}]</b>\n` +
      `Buy new Pump.fun launches automatically\n\n` +
      `<b>AUTO-COPY [${copyStatus}]</b>\n` +
      `Copy trades from profitable wallets (all chains)\n\n` +
      `Min Score: ${settings.minTraderScore}  |  Max/Day: ${settings.maxCopyPerDay}\n` +
      `Today: ${settings.dailyCopyCount}/${settings.maxCopyPerDay} copies\n\n` +
      `<b>Copy Amounts (fixed per trade):</b>\n` +
      `SOL: ${settings.copyAmountSol} | ETH: ${settings.copyAmountEth}\n` +
      `MATIC: ${settings.copyAmountMatic} | Other: ${settings.copyAmountDefault}\n` +
      `Polymarket: $${settings.polymarketCopyUsd}`;

    const keyboard = [
      [{ text: `Auto-Snipe: ${snipeStatus}`, callback_data: "toggle_autosnipe" }],
      [{ text: `Auto-Copy: ${copyStatus}`, callback_data: "toggle_autocopy" }],
      [
        { text: `Min Score: ${settings.minTraderScore}`, callback_data: "set_min_score" },
        { text: `Max/Day: ${settings.maxCopyPerDay}`, callback_data: "set_max_daily" },
      ],
      [
        { text: `SOL: ${settings.copyAmountSol}`, callback_data: "set_copy_sol" },
        { text: `ETH: ${settings.copyAmountEth}`, callback_data: "set_copy_eth" },
      ],
      [
        { text: `MATIC: ${settings.copyAmountMatic}`, callback_data: "set_copy_matic" },
        { text: `Other: ${settings.copyAmountDefault}`, callback_data: "set_copy_default" },
      ],
      [{ text: `Polymarket: $${settings.polymarketCopyUsd}`, callback_data: "set_copy_poly" }],
      [{ text: "Back", callback_data: "main_menu" }],
    ];

    await sendDataMessage(message, keyboard);
    return;
  }

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

// Settings state for multi-step input
let settingsInputMode: "min_score" | "max_daily" | "copy_sol" | "copy_eth" | "copy_matic" | "copy_default" | "copy_poly" | null = null;

async function handleSettings(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /settings from user ${ctx.from?.id}`);
    return;
  }

  const userId = ctx.from?.id?.toString();
  if (!userId) return;

  const settings = getSettings(userId);

  const snipeStatus = settings.autoSnipeEnabled ? "ON" : "OFF";
  const copyStatus = settings.autoCopyEnabled ? "ON" : "OFF";

  const message =
    `<b>Settings</b>\n\n` +
    `<b>AUTO-SNIPE [${snipeStatus}]</b>\n` +
    `Buy new Pump.fun launches automatically\n\n` +
    `<b>AUTO-COPY [${copyStatus}]</b>\n` +
    `Copy trades from profitable wallets (all chains)\n\n` +
    `Min Score: ${settings.minTraderScore}  |  Max/Day: ${settings.maxCopyPerDay}\n` +
    `Today: ${settings.dailyCopyCount}/${settings.maxCopyPerDay} copies\n\n` +
    `<b>Copy Amounts (fixed per trade):</b>\n` +
    `SOL: ${settings.copyAmountSol} | ETH: ${settings.copyAmountEth}\n` +
    `MATIC: ${settings.copyAmountMatic} | Other: ${settings.copyAmountDefault}\n` +
    `Polymarket: $${settings.polymarketCopyUsd}`;

  const keyboard = [
    [{ text: `Auto-Snipe: ${snipeStatus}`, callback_data: "toggle_autosnipe" }],
    [{ text: `Auto-Copy: ${copyStatus}`, callback_data: "toggle_autocopy" }],
    [
      { text: `Min Score: ${settings.minTraderScore}`, callback_data: "set_min_score" },
      { text: `Max/Day: ${settings.maxCopyPerDay}`, callback_data: "set_max_daily" },
    ],
    [
      { text: `SOL: ${settings.copyAmountSol}`, callback_data: "set_copy_sol" },
      { text: `ETH: ${settings.copyAmountEth}`, callback_data: "set_copy_eth" },
    ],
    [
      { text: `MATIC: ${settings.copyAmountMatic}`, callback_data: "set_copy_matic" },
      { text: `Other: ${settings.copyAmountDefault}`, callback_data: "set_copy_default" },
    ],
    [{ text: `Polymarket: $${settings.polymarketCopyUsd}`, callback_data: "set_copy_poly" }],
    [{ text: "Back", callback_data: "main_menu" }],
  ];

  await sendDataMessage(message, keyboard);
}

async function handleToggleAutoSnipe(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  const userId = ctx.from?.id?.toString();
  if (!userId) return;

  const newValue = toggleAutoSnipe(userId);
  console.log(`[Telegram] Auto-snipe toggled to ${newValue} by user ${userId}`);

  await handleSettings(ctx);
}

async function handleToggleAutoCopy(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  const userId = ctx.from?.id?.toString();
  if (!userId) return;

  const newValue = toggleAutoCopy(userId);
  console.log(`[Telegram] Auto-copy toggled to ${newValue} by user ${userId}`);

  await handleSettings(ctx);
}

async function handleSetMinScore(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  settingsInputMode = "min_score";
  const msg = await ctx.reply("Enter minimum trader score (0-100):");
  lastPromptMessageId = msg.message_id;
}

async function handleSetMaxDaily(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  settingsInputMode = "max_daily";
  const msg = await ctx.reply("Enter max copies per day (1-50):");
  lastPromptMessageId = msg.message_id;
}

async function handleSetCopyAmount(ctx: Context, mode: "copy_sol" | "copy_eth" | "copy_matic" | "copy_default" | "copy_poly"): Promise<void> {
  if (!isAuthorized(ctx)) return;

  settingsInputMode = mode;

  const prompts: Record<typeof mode, string> = {
    copy_sol: "Enter SOL amount per copy trade (e.g., 0.02):",
    copy_eth: "Enter ETH amount per copy trade (e.g., 0.001):",
    copy_matic: "Enter MATIC amount per copy trade (e.g., 2):",
    copy_default: "Enter default amount for other chains (e.g., 0.005):",
    copy_poly: "Enter Polymarket copy amount in USD (e.g., 5):",
  };

  const msg = await ctx.reply(prompts[mode]);
  lastPromptMessageId = msg.message_id;
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
