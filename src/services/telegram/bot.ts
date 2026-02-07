import { Bot, Context, InputFile } from "grammy";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { exportTradersToPdf } from "./pdf-export.js";
import {
  getRiskStatus,
  activateKillSwitch,
  deactivateKillSwitch,
  getDailyPnl,
  getDailyPnlPercentage,
  getDailyPnlBreakdown,
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
import { getCopyStats, getOpenCopiedPositions, getOpenPositionsWithValues, getTrackedTraders } from "../polytraders/index.js";
import { getTopTraders, getTopTradersSorted, getTokenTrades, getTrader, clearAllTraders, type TraderSortBy, type TimeFilter } from "../traders/storage.js";
import { Chain } from "../traders/types.js";
import {
  getSettings,
  toggleAutoSnipe,
  toggleAutoCopy,
  updateSetting,
} from "../settings/settings.js";
import { callDeepSeek } from "../aibetting/deepseek.js";
import { getBettingStats, loadOpenPositions, loadClosedPositions, getRecentBetOutcomes, deleteAllPositions, deleteAllAnalyses } from "../database/aibetting.js";
import { getAIBettingStatus, clearAnalysisCache, getEnsembleResult } from "../aibetting/scheduler.js";
import { getCurrentPrice as getAIBetCurrentPrice, clearAllPositions } from "../aibetting/executor.js";
import { getPositions as getPumpfunPositions } from "../pumpfun/executor.js";
import { getOpenCryptoCopyPositions as getCryptoCopyPositions } from "../copy/executor.js";
import { loadOpenTokenPositions, getTokenAIPaperStats } from "../database/tokenai.js";
import { getTokenAIStatus } from "../tokenai/scheduler.js";

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = null;
let lastDataMessageId: number | null = null;
let lastTimezonePromptId: number | null = null;
let lastStatusUpdateId: number | null = null;
let lastPromptMessageId: number | null = null;
let currentTraderSort: TraderSortBy = "score";
let currentTimeFilter: TimeFilter = 12; // Default: 1 year
const alertMessageIds: number[] = []; // Track all alert messages for cleanup

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
  [
    { text: "🔄 Trades", callback_data: "trades" },
    { text: "🎯 Bets", callback_data: "bets" },
  ],
  [
    { text: "📋 Traders", callback_data: "traders" },
    { text: "🎲 Bettors", callback_data: "bettors" },
  ],
  [{ text: "Settings", callback_data: "settings" }],
  [
    { text: "⏸️ Stop", callback_data: "stop" },
    { text: "▶️ Resume", callback_data: "resume" },
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
  bot.command("traderspdf", handleTradersPdf);
  bot.command("ai", handleAI);
  bot.command("clearcopies", handleClearCopies);
  bot.command("cleartraders", handleClearTraders);
  bot.command("resetpaper", handleReset);
  bot.command("tokenai", handleTokenAI);

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
  bot.callbackQuery("traders", async (ctx) => {
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("bettors", async (ctx) => {
    await handleBettors(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("bets", async (ctx) => {
    await handleBets(ctx, "open");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("bets_open", async (ctx) => {
    await handleBets(ctx, "open");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("bets_closed", async (ctx) => {
    await handleBets(ctx, "closed");
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

  // Time filter callbacks
  bot.callbackQuery("time_1", async (ctx) => {
    currentTimeFilter = 1;
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("time_3", async (ctx) => {
    currentTimeFilter = 3;
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("time_6", async (ctx) => {
    currentTimeFilter = 6;
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("time_12", async (ctx) => {
    currentTimeFilter = 12;
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("time_0", async (ctx) => {
    currentTimeFilter = 0;
    await handleTraders(ctx);
    await ctx.answerCallbackQuery();
  });

  // Clear chat callback
  bot.callbackQuery("clear_chat", async (ctx) => {
    // Delete all tracked alert messages
    for (const msgId of alertMessageIds) {
      await bot?.api.deleteMessage(chatId!, msgId).catch(() => {});
    }
    alertMessageIds.length = 0; // Clear the array
    await sendMainMenu();
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
  bot.callbackQuery("confirm_resetpaper", async (ctx) => {
    await handleResetConfirm(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("cancel_resetpaper", async (ctx) => {
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Reset cancelled.", backButton);
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

// Track last alert with button
let lastAlertWithButtonId: number | null = null;

// Send message to configured chat (only last alert has Clear Chat button)
export async function sendMessage(text: string): Promise<void> {
  if (!bot || !chatId) {
    console.warn("[Telegram] Bot not initialized, cannot send message");
    return;
  }

  try {
    // Remove button from previous alert (fire and forget)
    if (lastAlertWithButtonId) {
      bot.api.editMessageReplyMarkup(chatId, lastAlertWithButtonId, {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }

    // Send new alert with button
    const msg = await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Clear", callback_data: "clear_chat" }]],
      },
    });
    alertMessageIds.push(msg.message_id);
    lastAlertWithButtonId = msg.message_id;
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
    // Collect all message IDs to delete
    const toDelete: number[] = [];
    if (lastMenuMessageId) toDelete.push(lastMenuMessageId);
    if (lastDataMessageId) toDelete.push(lastDataMessageId);
    if (lastPromptMessageId) toDelete.push(lastPromptMessageId);
    if (lastTimezonePromptId) toDelete.push(lastTimezonePromptId);
    toDelete.push(...alertMessageIds);

    // Delete all in parallel (fire and forget)
    const currentChatId = chatId;
    const currentBot = bot;
    Promise.all(toDelete.map(id => currentBot.api.deleteMessage(currentChatId, id).catch(() => {})));

    // Reset tracking
    lastMenuMessageId = null;
    lastDataMessageId = null;
    lastPromptMessageId = null;
    lastTimezonePromptId = null;
    alertMessageIds.length = 0;
    lastAlertWithButtonId = null;

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
  }

  // Delete the /start command message itself
  if (ctx.message?.message_id && chatId) {
    await bot?.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
  }

  // Just show the menu (don't duplicate - sendMainMenu handles cleanup)
  await sendMainMenu();
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
    const todayTrades = getTodayTrades();

    // AI Betting data
    const aiBettingStats = getBettingStats();
    const openAIBets = loadOpenPositions();

    // Pumpfun positions
    const pumpfunPositions = getPumpfunPositions();

    // Crypto copy positions
    const cryptoCopyPositions = getCryptoCopyPositions();

    // Polymarket copy positions
    const polymarketCopyStats = getCopyStats();

    const statusEmoji = status.tradingEnabled ? "🟢" : "🔴";
    const modeEmoji = status.isPaperMode ? "📝" : "💰";
    const killEmoji = status.killSwitchActive ? "⛔" : "✅";
    const trackerEmoji = trackerActive ? "🟢" : "🔴";

    let message =
      `<b>Bot Status</b>\n\n` +
      `${statusEmoji} Trading: ${status.tradingEnabled ? "Enabled" : "Disabled"}\n` +
      `${modeEmoji} Mode: ${status.isPaperMode ? "Paper" : "Live"}\n` +
      `${killEmoji} Kill Switch: ${status.killSwitchActive ? "ACTIVE" : "Off"}\n\n`;

    // Daily P&L
    const pnlEmoji = status.dailyPnl >= 0 ? "📈" : "📉";
    message += `<b>Daily P&L</b>\n` +
      `${pnlEmoji} $${status.dailyPnl.toFixed(2)} (${status.dailyPnlPercentage >= 0 ? "+" : ""}${status.dailyPnlPercentage.toFixed(1)}%)\n` +
      `Trades: ${todayTrades.length} | Wins: ${todayTrades.filter(t => t.pnl > 0).length} | Losses: ${todayTrades.filter(t => t.pnl < 0).length}\n\n`;

    // Crypto Copy Trading Section
    message += `<b>Crypto Copy</b>\n` +
      `Open: ${cryptoCopyPositions.length}\n`;
    if (cryptoCopyPositions.length > 0) {
      for (const pos of cryptoCopyPositions.slice(0, 3)) {
        message += `  - ${pos.tokenSymbol} (${pos.chain}): ${pos.entryAmountNative.toFixed(4)} native\n`;
      }
      if (cryptoCopyPositions.length > 3) message += `  ...and ${cryptoCopyPositions.length - 3} more\n`;
    }
    message += `\n`;

    // Pumpfun Section
    message += `<b>Pump.fun</b>\n` +
      `Open positions: ${pumpfunPositions.size}\n`;
    if (pumpfunPositions.size > 0) {
      for (const [, pos] of Array.from(pumpfunPositions).slice(0, 3)) {
        const mult = pos.peakPrice / pos.entryPrice;
        message += `  - ${pos.symbol}: ${mult.toFixed(1)}x from entry\n`;
      }
      if (pumpfunPositions.size > 3) message += `  ...and ${pumpfunPositions.size - 3} more\n`;
    }
    message += `\n`;

    // Polymarket Copy Section
    const positionsWithValues = await getOpenPositionsWithValues();
    const positionsWithPrices = positionsWithValues.filter(p => p.currentPrice !== null);
    const totalInvested = positionsWithPrices.reduce((sum, p) => sum + p.size, 0);
    const totalCurrentValue = positionsWithPrices.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
    const totalPnl = totalCurrentValue - totalInvested;
    const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    message += `<b>Polymarket Copy</b>\n` +
      `Open: ${polymarketCopyStats.openPositions} | Total: ${polymarketCopyStats.totalCopies}\n` +
      `Win rate: ${polymarketCopyStats.winRate.toFixed(0)}% | Realized PnL: $${polymarketCopyStats.totalPnl.toFixed(2)}\n`;

    if (positionsWithValues.length > 0) {
      for (const pos of positionsWithValues) {
        if (pos.currentPrice !== null) {
          const currentVal = pos.currentValue ?? 0;
          const pnlPct = pos.unrealizedPnlPct ?? 0;
          const sign = pnlPct >= 0 ? "+" : "";
          message += `  - ${pos.marketTitle.slice(0, 22)}...: $${pos.size.toFixed(0)} -> $${currentVal.toFixed(2)} (${sign}${pnlPct.toFixed(0)}%)\n`;
        } else {
          message += `  - ${pos.marketTitle.slice(0, 22)}...: $${pos.size.toFixed(0)} (?)\n`;
        }
      }
      if (positionsWithPrices.length > 0) {
        const totalSign = totalPnlPct >= 0 ? "+" : "";
        message += `  <b>Total: $${totalInvested.toFixed(0)} -> $${totalCurrentValue.toFixed(2)} (${totalSign}${totalPnlPct.toFixed(0)}%)</b>\n`;
      }
    }
    message += `\n`;

    // AI Betting Section
    let openInvested = 0;
    let totalUnrealized = 0;

    for (const bet of openAIBets) {
      openInvested += bet.size;
      const currentPrice = await getAIBetCurrentPrice(bet.tokenId);
      if (currentPrice !== null) {
        const priceDiff = bet.side === "YES"
          ? currentPrice - bet.entryPrice
          : bet.entryPrice - currentPrice;
        const shares = bet.size / bet.entryPrice;
        totalUnrealized += shares * priceDiff;
      }
    }

    const totalInvestedAI = openInvested + aiBettingStats.totalInvested;
    const realizedSign = aiBettingStats.totalPnl >= 0 ? "+" : "";
    const unrealizedSign = totalUnrealized >= 0 ? "+" : "";

    const schedulerStatus = getAIBettingStatus();
    message += `<b>AI Betting</b>\n` +
      `Open: ${openAIBets.length} | Closed: ${aiBettingStats.totalBets} | Invested: $${totalInvestedAI.toFixed(0)}\n` +
      `Realized: ${realizedSign}$${aiBettingStats.totalPnl.toFixed(2)}\n` +
      `Unrealized: ${unrealizedSign}$${totalUnrealized.toFixed(2)}\n` +
      `Ensemble cache: ${schedulerStatus.ensembleCacheSize} markets\n\n`;

    // Token AI Section
    const tokenAIPositions = loadOpenTokenPositions();
    message += `<b>Token AI</b>\n` +
      `Open: ${tokenAIPositions.length}\n`;
    if (tokenAIPositions.length > 0) {
      let tokenTotalInvested = 0;
      let tokenTotalCurrentValue = 0;
      let tokenHasPrices = false;

      for (const pos of tokenAIPositions.slice(0, 3)) {
        const label = pos.tokenSymbol || pos.tokenAddress.slice(0, 8);
        message += `  - ${label} (${pos.chain}): $${pos.sizeUsd.toFixed(2)} @ $${pos.entryPrice.toFixed(6)} | Conf: ${(pos.confidence * 100).toFixed(0)}%\n`;
        if (pos.currentPrice !== undefined) {
          const posPnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd;
          const posPnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
          const posSign = posPnl >= 0 ? "+" : "";
          message += `    Now: $${pos.currentPrice.toFixed(6)} | P&L: ${posSign}$${posPnl.toFixed(2)} (${posSign}${posPnlPct.toFixed(0)}%)\n`;
        }
      }
      if (tokenAIPositions.length > 3) {
        message += `  ...and ${tokenAIPositions.length - 3} more\n`;
      }

      for (const pos of tokenAIPositions) {
        tokenTotalInvested += pos.sizeUsd;
        if (pos.currentPrice !== undefined) {
          tokenHasPrices = true;
          const currentVal = (pos.currentPrice / pos.entryPrice) * pos.sizeUsd;
          tokenTotalCurrentValue += currentVal;
        }
      }
      if (tokenHasPrices) {
        const tokenTotalPnlPct = tokenTotalInvested > 0 ? ((tokenTotalCurrentValue - tokenTotalInvested) / tokenTotalInvested) * 100 : 0;
        const tokenSign = tokenTotalPnlPct >= 0 ? "+" : "";
        message += `  Total: $${tokenTotalInvested.toFixed(0)} -> $${tokenTotalCurrentValue.toFixed(2)} (${tokenSign}${tokenTotalPnlPct.toFixed(0)}%)\n`;
      }
    }
    message += `\n`;

    // Trader Tracker
    message += `<b>Trader Tracker</b>\n` +
      `${trackerEmoji} ${trackerActive ? "Running" : "Stopped"} | ${traderCount} wallets`;

    if (status.pauseReason) {
      message += `\n\n⚠️ Pause: ${status.pauseReason}`;
    }

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
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

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] Balance error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch balances", backButton);
  }
}

async function handlePnl(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /pnl from user ${ctx.from?.id}`);
    return;
  }

  try {
    const breakdown = getDailyPnlBreakdown();
    const pnlPct = getDailyPnlPercentage();
    const trades = getTodayTrades();

    const emoji = breakdown.total >= 0 ? "📈" : "📉";

    let message = `<b>Daily P&L</b>\n\n`;
    message += `${emoji} Total: $${breakdown.total.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n`;
    message += `Trades: ${trades.length} | Wins: ${trades.filter((t) => t.pnl > 0).length} | Losses: ${trades.filter((t) => t.pnl < 0).length}\n\n`;

    message += `<b>Breakdown by Source</b>\n`;

    if (breakdown.cryptoCopy !== 0) {
      const sign = breakdown.cryptoCopy >= 0 ? "+" : "";
      message += `Crypto Copy: ${sign}$${breakdown.cryptoCopy.toFixed(2)}\n`;
    }

    if (breakdown.pumpfun !== 0) {
      const sign = breakdown.pumpfun >= 0 ? "+" : "";
      message += `Pump.fun: ${sign}$${breakdown.pumpfun.toFixed(2)}\n`;
    }

    if (breakdown.polyCopy !== 0) {
      const sign = breakdown.polyCopy >= 0 ? "+" : "";
      message += `Poly Copy: ${sign}$${breakdown.polyCopy.toFixed(2)}\n`;
    }

    if (breakdown.aiBetting !== 0) {
      const sign = breakdown.aiBetting >= 0 ? "+" : "";
      message += `AI Betting: ${sign}$${breakdown.aiBetting.toFixed(2)}\n`;
    }

    if (breakdown.tokenAi !== 0) {
      const sign = breakdown.tokenAi >= 0 ? "+" : "";
      message += `Token AI: ${sign}$${breakdown.tokenAi.toFixed(2)}\n`;
    }

    if (breakdown.cryptoCopy === 0 && breakdown.pumpfun === 0 && breakdown.polyCopy === 0 && breakdown.aiBetting === 0 && breakdown.tokenAi === 0) {
      message += `<i>No closed positions today</i>\n`;
    }

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
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
      const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage("No trades today", backButton);
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

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
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
    const topTradersList = getTopTradersSorted(10, currentTraderSort, undefined, currentTimeFilter);

    // Labels
    const sortLabels: Record<TraderSortBy, string> = {
      score: "Score",
      pnl: "Total PnL",
      pnl_pct: "PnL %",
    };
    const timeLabels: Record<TimeFilter, string> = {
      1: "1M",
      3: "3M",
      6: "6M",
      12: "1Y",
      0: "All",
    };

    let message = `<b>Trader Tracker</b>\n\n`;
    message += `Status: ${trackerRunning ? "Running" : "Stopped"}\n`;
    message += `Total Tracked: ${traderCount}\n`;
    message += `Period: <b>${timeLabels[currentTimeFilter]}</b> | Sort: <b>${sortLabels[currentTraderSort]}</b>\n\n`;

    // Time filter buttons
    const timeButtons: { text: string; callback_data: string }[][] = [[
      { text: currentTimeFilter === 1 ? "* 1M" : "1M", callback_data: "time_1" },
      { text: currentTimeFilter === 3 ? "* 3M" : "3M", callback_data: "time_3" },
      { text: currentTimeFilter === 6 ? "* 6M" : "6M", callback_data: "time_6" },
      { text: currentTimeFilter === 12 ? "* 1Y" : "1Y", callback_data: "time_12" },
      { text: currentTimeFilter === 0 ? "* All" : "All", callback_data: "time_0" },
    ]];

    // Sort filter buttons
    const sortButtons: { text: string; callback_data: string }[][] = [[
      { text: currentTraderSort === "score" ? "* Score" : "Score", callback_data: "sort_score" },
      { text: currentTraderSort === "pnl" ? "* $ PnL" : "$ PnL", callback_data: "sort_pnl" },
      { text: currentTraderSort === "pnl_pct" ? "* % PnL" : "% PnL", callback_data: "sort_pnl_pct" },
    ]];

    if (topTradersList.length === 0) {
      message += "No traders with activity in this period\n\nTry a different time filter:";
      const allButtons = [...timeButtons, ...sortButtons, [{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage(message, allButtons);
      return;
    }

    message += "Click a trader to see details:";

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

    // Combine: time filter + sort filter + trader buttons + back button
    const allButtons = [...timeButtons, ...sortButtons, ...traderButtons, [{ text: "Back", callback_data: "main_menu" }]];

    await sendDataMessage(message, allButtons);
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
        const firstDate = new Date(trade.firstBuyTimestamp).toLocaleDateString();
        const lastDate = new Date(trade.lastSellTimestamp).toLocaleDateString();

        message += `<b>${trade.tokenSymbol}</b>\n`;
        message += `Bought: $${trade.buyAmountUsd.toFixed(0)} | Sold: $${trade.sellAmountUsd.toFixed(0)}\n`;
        message += `Period: ${firstDate} - ${lastDate}\n`;
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

async function handleBettors(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /bettors from user ${ctx.from?.id}`);
    return;
  }

  try {
    const trackedBettors = getTrackedTraders();
    const copyStats = getCopyStats();

    // Only show bettors we copy (10%+ ROI)
    const copiedBettors = trackedBettors.filter(b => b.roi >= 0.10).sort((a, b) => b.roi - a.roi);

    let message = `<b>Copied Bettors</b>\n\n`;
    message += `Open: ${copyStats.openPositions} | Closed: ${copyStats.closedPositions}\n`;
    message += `Win Rate: ${copyStats.winRate.toFixed(0)}% | PnL: $${copyStats.totalPnl.toFixed(2)}\n\n`;

    if (copiedBettors.length === 0) {
      message += "No bettors with 10%+ ROI found.";
      const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage(message, backButton);
      return;
    }

    for (const bettor of copiedBettors) {
      const roiPct = (bettor.roi * 100).toFixed(1);
      const pnlSign = bettor.pnl >= 0 ? "+" : "";
      message += `<b>${bettor.name}</b>\n`;
      message += `ROI: ${roiPct}% | PnL: ${pnlSign}$${bettor.pnl.toFixed(0)} | Vol: $${(bettor.vol / 1000).toFixed(0)}k\n\n`;
    }

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] Bettors error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch bettors", backButton);
  }
}

async function handleBets(ctx: Context, tab: "open" | "closed"): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /bets from user ${ctx.from?.id}`);
    return;
  }

  try {
    const openBets = loadOpenPositions();

    // Compute unrealized P&L for header (and cache prices for open tab)
    let openInvested = 0;
    let totalUnrealized = 0;
    const priceCache = new Map<string, { currentPrice: number | null; pnl: number }>();

    for (const bet of openBets) {
      openInvested += bet.size;
      const currentPrice = await getAIBetCurrentPrice(bet.tokenId);
      let pnl = 0;

      if (currentPrice !== null) {
        const priceDiff = bet.side === "YES"
          ? currentPrice - bet.entryPrice
          : bet.entryPrice - currentPrice;
        const shares = bet.size / bet.entryPrice;
        pnl = shares * priceDiff;
        totalUnrealized += pnl;
      }

      priceCache.set(bet.id, { currentPrice, pnl });
    }

    // Build message with just title
    let message = `<b>AI Bets</b>\n\n`;

    const tabButtons = [[
      { text: tab === "open" ? "* Open" : "Open", callback_data: "bets_open" },
      { text: tab === "closed" ? "* Closed" : "Closed", callback_data: "bets_closed" },
    ]];

    if (tab === "open") {
      if (openBets.length === 0) {
        message += "No open bets.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      for (const bet of openBets) {
        const cached = priceCache.get(bet.id);
        const currentPrice = cached?.currentPrice ?? null;
        const pnl = cached?.pnl ?? 0;

        const entryDate = new Date(bet.entryTimestamp).toLocaleDateString();
        const titleShort = bet.marketTitle.length > 35
          ? bet.marketTitle.slice(0, 35) + "..."
          : bet.marketTitle;

        message += `<b>${titleShort}</b>\n`;
        message += `${bet.side} $${bet.size.toFixed(0)} @ ${(bet.entryPrice * 100).toFixed(0)}c`;

        if (currentPrice !== null) {
          const pnlPct = (pnl / bet.size) * 100;
          const sign = pnl >= 0 ? "+" : "";
          message += ` | Now: ${(currentPrice * 100).toFixed(0)}c`;
          message += `\nP&L: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(0)}%)`;
        }

        message += `\nConf: ${(bet.confidence * 100).toFixed(0)}% | EV: ${(bet.expectedValue * 100).toFixed(0)}% | ${entryDate}\n`;

        const ensemble = getEnsembleResult(bet.marketId);
        if (ensemble && ensemble.ensembleSize > 1) {
          const estimates = ensemble.individualEstimates
            .map(e => `${(e * 100).toFixed(0)}%`)
            .join('/');
          message += `Ens: ${estimates} (d=${ensemble.disagreement.toFixed(2)})\n`;
        }
        message += `\n`;
      }

    } else {
      const closedBets = loadClosedPositions(10);

      if (closedBets.length === 0) {
        message += "No closed bets yet.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      for (const bet of closedBets) {
        const titleShort = bet.marketTitle.length > 35
          ? bet.marketTitle.slice(0, 35) + "..."
          : bet.marketTitle;
        const pnl = bet.pnl ?? 0;
        const pnlPct = bet.size > 0 ? (pnl / bet.size) * 100 : 0;
        const pnlSign = pnl >= 0 ? "+" : "";
        const exitDate = bet.exitTimestamp
          ? new Date(bet.exitTimestamp).toLocaleDateString()
          : "?";

        message += `<b>${titleShort}</b>\n`;
        message += `${bet.side} $${bet.size.toFixed(0)} @ ${(bet.entryPrice * 100).toFixed(0)}c`;
        if (bet.exitPrice !== undefined) {
          message += ` -> ${(bet.exitPrice * 100).toFixed(0)}c`;
        }
        message += `\nP&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(0)}%)`;
        if (bet.exitReason) {
          message += ` | ${bet.exitReason}`;
        }
        message += ` | ${exitDate}\n\n`;
      }
    }

    const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, allButtons);
  } catch (err) {
    console.error("[Telegram] Bets error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch bets", backButton);
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

  activateKillSwitch();
  console.log("[Telegram] All trading stopped by user");
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
  await sendDataMessage("All trading stopped", backButton);
}

async function handleResume(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /resume from user ${ctx.from?.id}`);
    return;
  }

  deactivateKillSwitch();
  console.log("[Telegram] All trading resumed by user");
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
  await sendDataMessage("All trading resumed", backButton);
}

async function handleTimezone(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /timezone from user ${ctx.from?.id}`);
    return;
  }

  const msg = await ctx.reply("What is your current time? (format: HH:MM, e.g., 14:30)");
  lastTimezonePromptId = msg.message_id;
}

// Track AI conversation message IDs for cleanup
let lastAIQuestionId: number | null = null;

// Shows animated "..." while processing
async function showThinking(ctx: Context): Promise<() => Promise<void>> {
  const currentChatId = ctx.chat?.id;
  if (!currentChatId || !bot) return async () => {};

  try {
    const frames = [".", "..", "..."];
    let frameIndex = 0;

    const msg = await ctx.reply(frames[0]);

    const interval = setInterval(async () => {
      frameIndex = (frameIndex + 1) % frames.length;
      try {
        await bot?.api.editMessageText(currentChatId, msg.message_id, frames[frameIndex]);
      } catch {
        // Ignore edit errors
      }
    }, 400);

    return async () => {
      clearInterval(interval);
      try {
        await bot?.api.deleteMessage(currentChatId, msg.message_id);
      } catch {
        // Ignore delete errors
      }
    };
  } catch {
    return async () => {};
  }
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

  // Store user's question message ID for cleanup
  lastAIQuestionId = ctx.message?.message_id || null;

  // Start thinking animation
  const hideThinking = await showThinking(ctx);

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

IMPORTANT: Respond in plain text only. NO JSON, NO code blocks, NO markdown formatting. Just natural language sentences.
Be concise. Answer based on the data above. If asked about something not in the data, say so.`;

    const response = await callDeepSeek(
      `${context}\n\nUSER QUESTION: ${question}`,
      "deepseek-chat",
      "You are a helpful trading bot assistant. Answer questions concisely in plain text only. NO JSON, NO code blocks, NO markdown.",
      undefined,
      "telegram"
    );

    // Stop thinking animation
    await hideThinking();

    // Delete user's question message
    if (lastAIQuestionId && chatId) {
      await bot?.api.deleteMessage(chatId, lastAIQuestionId).catch(() => {});
      lastAIQuestionId = null;
    }

    // Send response with Back button (telegram has 4096 char limit)
    const truncated = response.length > 4000 ? response.slice(0, 4000) + "..." : response;
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(truncated, backButton);
  } catch (error) {
    // Always stop animation on error
    await hideThinking();

    console.error("[Telegram] AI query failed:", error);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to process AI query. Check logs.", backButton);
  }
}

async function handleClearCopies(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  try {
    // Just delete all data silently - no closing, no notifications
    const { clearAllCopiedPositions } = await import("../polytraders/index.js");
    const deleted = clearAllCopiedPositions();

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(`Deleted ${deleted} records. Stats reset.`, backButton);
  } catch (err) {
    console.error("[Telegram] Clear copies error:", err);
    await sendDataMessage("Failed to clear copies. Check logs.");
  }
}

async function handleClearTraders(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  try {
    const count = clearAllTraders();
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(`Cleared ${count} traders and their trades.\n\nDiscovery will find new traders from scratch.`, backButton);
  } catch (err) {
    console.error("[Telegram] Clear traders error:", err);
    await sendDataMessage("Failed to clear traders. Check logs.");
  }
}

async function handleReset(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /resetpaper from user ${ctx.from?.id}`);
    return;
  }

  if (!isPaperMode()) {
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Reset is only available in paper mode.", backButton);
    return;
  }

  // Count what will be deleted
  const openAIBets = loadOpenPositions();
  const closedStats = getBettingStats();
  const pumpPositions = getPumpfunPositions();
  const cryptoCopy = getCryptoCopyPositions();
  const polyStats = getCopyStats();

  let message = "<b>RESET - Paper Trading Data</b>\n\n";
  message += "This will permanently delete:\n\n";
  message += `  AI Bets: ${openAIBets.length} open + ${closedStats.totalBets} closed\n`;
  message += `  Pump.fun: ${pumpPositions.size} positions\n`;
  message += `  Crypto Copy: ${cryptoCopy.length} positions\n`;
  message += `  Poly Copy: ${polyStats.totalCopies} copies\n`;
  message += `  Trades + daily stats: all\n`;
  message += `  AI analysis cache: all\n\n`;
  message += "<b>This cannot be undone.</b>";

  const buttons = [
    [{ text: "Confirm Reset", callback_data: "confirm_resetpaper" }],
    [{ text: "Cancel", callback_data: "cancel_resetpaper" }],
  ];

  await sendDataMessage(message, buttons);
}

async function handleResetConfirm(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  if (!isPaperMode()) {
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Reset is only available in paper mode.", backButton);
    return;
  }

  try {
    const db = (await import("../database/db.js")).getDb();

    // 1. AI Betting - DB + memory
    const aiBetsDeleted = deleteAllPositions();
    const aiAnalysesDeleted = deleteAllAnalyses();
    clearAllPositions();
    clearAnalysisCache();

    // 2. Pumpfun positions - DB
    const pumpResult = db.prepare("DELETE FROM pumpfun_positions").run();

    // 3. Polymarket copy trades - use existing clear function
    const { clearAllCopiedPositions } = await import("../polytraders/index.js");
    const polyCopiesDeleted = clearAllCopiedPositions();

    // 4. Crypto copy positions - DB + memory
    const cryptoResult = db.prepare("DELETE FROM crypto_copy_positions").run();

    // 5. General trades table
    const tradesResult = db.prepare("DELETE FROM trades").run();

    // 6. General positions table
    const positionsResult = db.prepare("DELETE FROM positions").run();

    // 7. Daily stats
    const dailyResult = db.prepare("DELETE FROM daily_stats").run();

    // 8. Arbitrage positions
    const arbResult = db.prepare("DELETE FROM arbitrage_positions").run();

    const totalDeleted = aiBetsDeleted + aiAnalysesDeleted + pumpResult.changes
      + polyCopiesDeleted + cryptoResult.changes + tradesResult.changes
      + positionsResult.changes + dailyResult.changes + arbResult.changes;

    console.log(`[ResetPaper] Paper trading data wiped: ${totalDeleted} total records`);

    let message = "<b>Reset Complete</b>\n\n";
    message += `AI bets: ${aiBetsDeleted} positions + ${aiAnalysesDeleted} analyses\n`;
    message += `Pump.fun: ${pumpResult.changes} positions\n`;
    message += `Poly copies: ${polyCopiesDeleted} records\n`;
    message += `Crypto copies: ${cryptoResult.changes} records\n`;
    message += `Trades: ${tradesResult.changes} records\n`;
    message += `Positions: ${positionsResult.changes} records\n`;
    message += `Daily stats: ${dailyResult.changes} records\n`;
    message += `Arbitrage: ${arbResult.changes} records\n\n`;
    message += `<b>Total: ${totalDeleted} records deleted</b>\n`;
    message += "Paper trading is ready to start fresh.";

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[ResetPaper] Failed:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Reset failed. Check logs.", backButton);
  }
}

async function handleTokenAI(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /tokenai from user ${ctx.from?.id}`);
    return;
  }

  try {
    const aiStatus = getTokenAIStatus();
    const stats = getTokenAIPaperStats();

    let message = `<b>TOKEN AI STATUS</b>\n\n`;
    message += `<b>Scheduler:</b> ${aiStatus.running ? "Running" : "Stopped"}\n`;
    message += `Open Positions: ${aiStatus.openPositions}\n`;
    message += `Total Exposure: $${aiStatus.totalExposure.toFixed(2)}\n`;
    message += `Cache Size: ${aiStatus.cacheSize}\n\n`;

    if (stats.totalTrades === 0) {
      message += `No Token AI trades yet.\nEnsure TOKENAI_ENABLED=true in config.`;
    } else {
      message += `<b>PAPER TRADING RESULTS</b> (${stats.daysSinceFirstTrade} days)\n\n`;
      message += `Total Trades: ${stats.totalTrades} (${stats.openPositions} open, ${stats.closedPositions} closed)\n`;
      message += `Win Rate: ${(stats.winRate * 100).toFixed(0)}% (${stats.wins}W / ${stats.losses}L)\n`;

      const pnlSign = stats.totalPnlUsd >= 0 ? "+" : "";
      message += `Total P&L: ${pnlSign}$${stats.totalPnlUsd.toFixed(2)}\n`;
      message += `Avg Return: ${stats.avgReturnPct >= 0 ? "+" : ""}${stats.avgReturnPct.toFixed(1)}%\n`;
      message += `Avg Hold: ${stats.avgHoldTimeHours.toFixed(1)}h\n\n`;

      if (stats.bestTrade) {
        message += `Best: ${stats.bestTrade.symbol} +$${stats.bestTrade.pnl.toFixed(2)}\n`;
      }
      if (stats.worstTrade) {
        message += `Worst: ${stats.worstTrade.symbol} $${stats.worstTrade.pnl.toFixed(2)}\n`;
      }

      message += `\n`;

      // Go-live readiness check
      const readyDays = stats.daysSinceFirstTrade >= 30;
      const readyWinRate = stats.winRate > 0.5;
      const readyReturn = stats.avgReturnPct > 10;

      if (readyDays && readyWinRate && readyReturn) {
        message += `<b>READY FOR LIVE</b>\nSet TRADING_MODE=live to enable real trading`;
      } else {
        const remaining = Math.max(0, 30 - stats.daysSinceFirstTrade);
        message += `<b>PAPER MODE</b>\n`;
        if (!readyDays) message += `${remaining} days remaining\n`;
        if (!readyWinRate) message += `Need >50% win rate (current: ${(stats.winRate * 100).toFixed(0)}%)\n`;
        if (!readyReturn) message += `Need >10% avg return (current: ${stats.avgReturnPct.toFixed(1)}%)\n`;
      }
    }

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] TokenAI error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch Token AI status", backButton);
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
