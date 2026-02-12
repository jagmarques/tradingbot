import { Bot, Context } from "grammy";
import { loadEnv, isPaperMode, setTradingMode, getTradingMode } from "../../config/env.js";
import {
  getRiskStatus,
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
import { getCopyStats, getOpenCopiedPositions, getClosedCopiedPositions, getOpenPositionsWithValues, getTrackedTraders } from "../polytraders/index.js";
import {
  getSettings,
  toggleAutoCopy,
  updateSetting,
} from "../settings/settings.js";
import { callDeepSeek } from "../aibetting/deepseek.js";
import { getBettingStats, loadOpenPositions, loadClosedPositions, getRecentBetOutcomes, deleteAllPositions, deleteAllAnalyses } from "../database/aibetting.js";
import { getAIBettingStatus, clearAnalysisCache, setLogOnlyMode, isLogOnlyMode } from "../aibetting/scheduler.js";
import { getCurrentPrice as getAIBetCurrentPrice, clearAllPositions } from "../aibetting/executor.js";
import { getOpenCryptoCopyPositions as getCryptoCopyPositions } from "../copy/executor.js";
import { getPnlForPeriod, getDailyPnlHistory, generatePnlChart } from "../pnl/snapshots.js";
import { getTopInsiders, getGemHitsForWallet, getAllHeldGemHits } from "../traders/storage.js";
import { getInsiderScannerStatus } from "../traders/index.js";

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = null;
let lastDataMessageId: number | null = null;
let lastTimezonePromptId: number | null = null;
let lastPromptMessageId: number | null = null;
let currentPnlPeriod: "today" | "7d" | "30d" | "all" = "today";
const alertMessageIds: number[] = []; // Track all alert messages for cleanup
let insiderGemCache: { text: string; cachedAt: number } | null = null;
const INSIDER_GEM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

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
  [
    { text: "📊 Status", callback_data: "status" },
    { text: "💰 Balance", callback_data: "balance" },
    { text: "📈 P&L", callback_data: "pnl" },
  ],
  [
    { text: "🔄 Trades", callback_data: "trades" },
    { text: "🎯 Bets", callback_data: "bets" },
  ],
  [
    { text: "🕵 Insiders", callback_data: "insiders" },
    { text: "🎲 Bettors", callback_data: "bettors" },
  ],
  [
    { text: "⚙️ Mode", callback_data: "mode" },
    { text: "🔧 Settings", callback_data: "settings" },
  ],
  [
    { text: "⏸️ Stop", callback_data: "stop" },
    { text: "▶️ Resume", callback_data: "resume" },
    { text: "🗂 Manage", callback_data: "manage" },
  ],
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
  bot.command("ai", handleAI);
  bot.command("clearcopies", handleClearCopies);
  bot.command("resetpaper", handleReset);
  bot.command("mode", handleMode);
  bot.command("insiders", async (ctx) => {
    await handleInsiders(ctx, "all");
  });

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
    currentPnlPeriod = "today";
    await handlePnl(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("pnl_today", async (ctx) => {
    currentPnlPeriod = "today";
    await handlePnl(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("pnl_7d", async (ctx) => {
    currentPnlPeriod = "7d";
    await handlePnl(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("pnl_30d", async (ctx) => {
    currentPnlPeriod = "30d";
    await handlePnl(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("pnl_all", async (ctx) => {
    currentPnlPeriod = "all";
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
  bot.callbackQuery("bettors", async (ctx) => {
    await handleBettors(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("insiders", async (ctx) => {
    await handleInsiders(ctx, "all");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("insiders_all", async (ctx) => {
    await handleInsiders(ctx, "all");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("insiders_hot", async (ctx) => {
    await handleInsiders(ctx, "hot");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("insiders_best", async (ctx) => {
    await handleInsiders(ctx, "best");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("insiders_holding", async (ctx) => {
    await handleInsiders(ctx, "holding");
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
  bot.callbackQuery("bets_copy", async (ctx) => {
    await handleBets(ctx, "copy");
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("bets_copy_closed", async (ctx) => {
    await handleBets(ctx, "copy_closed");
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
  bot.callbackQuery("manage", async (ctx) => {
    await handleManage(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("manage_close_bets", async (ctx) => {
    await handleCloseAllBets(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("manage_close_copies", async (ctx) => {
    await handleCloseAllCopies(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("manage_resetpaper", async (ctx) => {
    await handleReset(ctx);
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
  bot.callbackQuery("mode", async (ctx) => {
    await handleMode(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("mode_switch_live", async (ctx) => {
    await handleModeSwitchLive(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("mode_confirm_live", async (ctx) => {
    await handleModeConfirmLive(ctx);
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery("mode_switch_paper", async (ctx) => {
    await handleModeSwitchPaper(ctx);
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
    const todayTrades = getTodayTrades();
    const schedulerStatus = getAIBettingStatus();
    const polyStats = getCopyStats();
    const cryptoCopyPositions = getCryptoCopyPositions();

    const statusEmoji = status.tradingEnabled ? "🟢" : "🔴";
    const modeTag = status.isPaperMode ? "Paper" : "Live";
    const killTag = status.killSwitchActive ? "Kill: ON" : "";
    const pnlSign = status.dailyPnl >= 0 ? "+" : "";

    // Compute unrealized P&L for AI bets
    const openBets = loadOpenPositions();
    let aiBetUnrealized = 0;
    for (const bet of openBets) {
      const price = await getAIBetCurrentPrice(bet.tokenId);
      if (price !== null) {
        const diff = bet.side === "YES" ? price - bet.entryPrice : bet.entryPrice - price;
        aiBetUnrealized += (bet.size / bet.entryPrice) * diff;
      }
    }

    // Compute unrealized P&L for copy positions
    const copyPositions = await getOpenPositionsWithValues();
    let copyUnrealized = 0;
    for (const pos of copyPositions) {
      if (pos.currentValue !== null) {
        copyUnrealized += (pos.currentValue ?? 0) - pos.size;
      }
    }

    let message = `<b>Status</b>\n\n`;
    message += `${statusEmoji} ${modeTag}${killTag ? " | " + killTag : ""}\n`;
    message += `P&L: ${pnlSign}$${status.dailyPnl.toFixed(2)} (${todayTrades.length} trades)\n\n`;

    const logOnly = schedulerStatus.logOnly ? " | Log-only" : "";
    const aiPnlStr = openBets.length > 0 ? ` | ${aiBetUnrealized >= 0 ? "+" : ""}$${aiBetUnrealized.toFixed(2)}` : "";
    message += `AI Betting: ${schedulerStatus.analysisCacheSize} cached | ${openBets.length} open${aiPnlStr}${logOnly}\n`;
    const copyPnlStr = copyPositions.length > 0 ? ` | ${copyUnrealized >= 0 ? "+" : ""}$${copyUnrealized.toFixed(2)}` : "";
    message += `Poly Copy: ${polyStats.openPositions} open${copyPnlStr} | $${polyStats.totalPnl.toFixed(2)} realized\n`;
    message += `Crypto Copy: ${cryptoCopyPositions.length} open\n`;

    if (status.pauseReason) {
      message += `\n\n⚠️ ${status.pauseReason}`;
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
    const period = currentPnlPeriod;
    const periodLabels = { today: "Today", "7d": "7 Day", "30d": "30 Day", all: "All-Time" };

    let message = `<b>P&L - ${periodLabels[period]}</b>\n\n`;

    // Period tab buttons
    const tabButtons = [[
      { text: period === "today" ? "* Today" : "Today", callback_data: "pnl_today" },
      { text: period === "7d" ? "* 7D" : "7D", callback_data: "pnl_7d" },
      { text: period === "30d" ? "* 30D" : "30D", callback_data: "pnl_30d" },
      { text: period === "all" ? "* All" : "All", callback_data: "pnl_all" },
    ]];

    if (period === "today") {
      // Real-time today data
      const breakdown = getDailyPnlBreakdown();
      const pnlPct = getDailyPnlPercentage();
      const trades = getTodayTrades();

      const emoji = breakdown.total >= 0 ? "+" : "";
      message += `Total: ${emoji}$${breakdown.total.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n`;
      message += `Trades: ${trades.length} | W: ${trades.filter((t) => t.pnl > 0).length} | L: ${trades.filter((t) => t.pnl < 0).length}\n\n`;

      message += formatBreakdown(breakdown.cryptoCopy, breakdown.polyCopy, breakdown.aiBetting);
    } else {
      // Historical data from snapshots
      const days = period === "7d" ? 7 : period === "30d" ? 30 : null;
      const data = getPnlForPeriod(days);

      const sign = data.totalPnl >= 0 ? "+" : "";
      message += `Total: ${sign}$${data.totalPnl.toFixed(2)}\n\n`;

      message += formatBreakdown(data.cryptoCopyPnl, data.polyCopyPnl, data.aiBettingPnl);

      // Chart
      const history = getDailyPnlHistory(days);
      if (history.length > 1) {
        message += `\n<b>Cumulative P&L</b>\n`;
        message += generatePnlChart(history);
      }
    }

    const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, allButtons);
  } catch (err) {
    console.error("[Telegram] P&L error:", err);
  }
}

function formatBreakdown(cryptoCopy: number, polyCopy: number, aiBetting: number): string {
  let msg = "<b>By Source</b>\n";
  let hasAny = false;

  const sources = [
    { name: "Crypto Copy", value: cryptoCopy },
    { name: "Poly Copy", value: polyCopy },
    { name: "AI Betting", value: aiBetting },
  ];

  for (const source of sources) {
    if (source.value !== 0) {
      hasAny = true;
      const sign = source.value >= 0 ? "+" : "";
      msg += `${source.name}: ${sign}$${source.value.toFixed(2)}\n`;
    }
  }

  if (!hasAny) {
    msg += `<i>No closed positions</i>\n`;
  }

  return msg;
}

async function handleTrades(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /trades from user ${ctx.from?.id}`);
    return;
  }

  try {
    const trades = getTodayTrades();
    const cryptoCopyPositions = getCryptoCopyPositions();

    let message = `<b>Trades</b>\n\n`;

    // Crypto copy positions
    if (cryptoCopyPositions.length > 0) {
      message += `<b>Crypto Copy</b> (${cryptoCopyPositions.length} open)\n`;
      for (const pos of cryptoCopyPositions.slice(0, 5)) {
        message += `  ${pos.tokenSymbol} (${pos.chain}): ${pos.entryAmountNative.toFixed(4)} native\n`;
      }
      if (cryptoCopyPositions.length > 5) message += `  ...and ${cryptoCopyPositions.length - 5} more\n`;
      message += `\n`;
    }

    // Recent trades
    if (trades.length > 0) {
      const recentTrades = trades.slice(-10);
      message += `<b>Today</b> (${trades.length} trades)\n`;
      for (const trade of recentTrades) {
        const emoji = trade.pnl >= 0 ? "🟢" : "🔴";
        const time = new Date(trade.timestamp).toLocaleTimeString();
        message += `${emoji} ${trade.type} ${trade.strategy} $${trade.amount.toFixed(2)} | P&L: $${trade.pnl.toFixed(2)} | ${time}\n`;
      }
    } else if (cryptoCopyPositions.length === 0) {
      message += "No trades or positions.";
    }

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] Trades error:", err);
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

async function getAIGemAnalysis(): Promise<string | null> {
  // Return cached if fresh
  if (insiderGemCache && Date.now() - insiderGemCache.cachedAt < INSIDER_GEM_CACHE_TTL) {
    return insiderGemCache.text;
  }

  const heldGems = getAllHeldGemHits();
  if (heldGems.length === 0) return null;

  // Deduplicate by token address (same token held by multiple wallets)
  const uniqueTokens = new Map<string, { symbol: string; chain: string; pumpMultiple: number; holdersCount: number; buyDate: number }>();
  for (const gem of heldGems) {
    const key = `${gem.tokenAddress}_${gem.chain}`;
    const existing = uniqueTokens.get(key);
    if (existing) {
      existing.holdersCount++;
      existing.pumpMultiple = Math.max(existing.pumpMultiple, gem.pumpMultiple);
    } else {
      uniqueTokens.set(key, {
        symbol: gem.tokenSymbol,
        chain: gem.chain,
        pumpMultiple: gem.pumpMultiple,
        holdersCount: 1,
        buyDate: gem.buyDate || gem.buyTimestamp,
      });
    }
  }

  const tokenList = Array.from(uniqueTokens.values())
    .sort((a, b) => b.holdersCount - a.holdersCount || b.pumpMultiple - a.pumpMultiple)
    .slice(0, 20) // Cap at 20 tokens to keep prompt short
    .map((t) => {
      const daysHeld = Math.round((Date.now() - (t.buyDate || 0)) / 86400000);
      return `${t.symbol} (${t.chain}) - ${t.pumpMultiple.toFixed(1)}x pump, ${t.holdersCount} insider(s) holding, ${daysHeld}d held`;
    })
    .join("\n");

  const prompt = `These tokens are currently held by crypto insider wallets (smart money that finds gems early). Analyze which ones look most promising to buy now.

Tokens held by insiders:
${tokenList}

For each token you recommend (pick top 3-5 max), give:
1. Token symbol
2. Why it looks good (brief, 1 sentence)
3. Risk level (low/medium/high)

If none look worth buying, say so. Be concise. No markdown formatting - use plain text only.`;

  try {
    const response = await callDeepSeek(
      prompt,
      "deepseek-chat",
      "You are a crypto analyst. Be direct and concise. No fluff. Plain text only, no markdown.",
      0.3,
      "insider-gems"
    );

    // Format the AI response for Telegram
    const text = `<b>AI Gem Analysis</b>\n<i>(${uniqueTokens.size} tokens held by insiders)</i>\n\n${response}`;
    insiderGemCache = { text, cachedAt: Date.now() };
    return text;
  } catch (err) {
    console.error("[Telegram] AI gem analysis failed:", err);
    return null;
  }
}

async function handleInsiders(ctx: Context, tab: "all" | "hot" | "best" | "holding" = "all"): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /insiders from user ${ctx.from?.id}`);
    return;
  }

  try {
    const topInsiders = getTopInsiders(20);
    const status = getInsiderScannerStatus();

    // Tab buttons
    const tabButtons = [
      [
        { text: tab === "all" ? "* All" : "All", callback_data: "insiders_all" },
        { text: tab === "hot" ? "* Hot" : "Hot", callback_data: "insiders_hot" },
        { text: tab === "best" ? "* Best" : "Best", callback_data: "insiders_best" },
        { text: tab === "holding" ? "* Holding" : "Holding", callback_data: "insiders_holding" },
      ],
    ];

    if (topInsiders.length === 0) {
      const scannerStatus = status.running ? "Running" : "Stopped";
      const buttons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage(`<b>Insider Wallets</b>\n\nNo insider wallets detected yet.\nScanner: ${scannerStatus}`, buttons);
      return;
    }

    // Token-centric view for holding tab - handle separately
    if (tab === "holding") {
      const heldGems = getAllHeldGemHits();

      if (heldGems.length === 0) {
        const buttons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(`<b>Insider Wallets</b> - Currently Holding\n\nNo insiders currently holding gems.`, buttons);
        return;
      }

      // Group by tokenAddress+chain
      const tokenMap = new Map<string, { symbol: string; chain: string; gems: typeof heldGems }>();
      for (const gem of heldGems) {
        const key = `${gem.tokenAddress}_${gem.chain}`;
        if (!tokenMap.has(key)) {
          tokenMap.set(key, { symbol: gem.tokenSymbol, chain: gem.chain, gems: [] });
        }
        tokenMap.get(key)!.gems.push(gem);
      }

      // Build token blocks
      const tokenEntries = Array.from(tokenMap.values()).map((t) => {
        const holders = t.gems.length;
        const pumps = t.gems.map((g) => g.pumpMultiple || 0);
        const avgPump = pumps.reduce((a, b) => a + b, 0) / pumps.length;
        const minPump = Math.min(...pumps);
        const maxPump = Math.max(...pumps);
        const earliestBuy = Math.min(...t.gems.map((g) => g.buyDate || g.buyTimestamp || Date.now()));
        const launchStr = new Date(earliestBuy).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return { symbol: t.symbol, chain: t.chain, holders, avgPump, minPump, maxPump, launchStr, launchTs: earliestBuy, maxPumpVal: maxPump };
      });

      // Sort: most holders first, then lowest pump (undervalued), then most recent launch
      tokenEntries.sort((a, b) => b.holders - a.holders || a.avgPump - b.avgPump || b.launchTs - a.launchTs);

      const tokenBlocks = tokenEntries.slice(0, 20).map((t) => {
        const chainTag = t.chain.toUpperCase().slice(0, 3);
        return `<b>${t.symbol}</b> (${chainTag}) - Launched: ${t.launchStr}\nPump: ${t.maxPumpVal.toFixed(0)}x | Holders: ${t.holders}\nROI: avg ${t.avgPump.toFixed(0)}x | min ${t.minPump.toFixed(0)}x | max ${t.maxPumpVal.toFixed(0)}x`;
      });

      // Paginate and send
      const header = `<b>Insider Wallets</b> - Currently Holding\n\n`;
      const scannerStatus = status.running ? "Running" : "Stopped";
      const footer = `\nScanner: ${scannerStatus} | ${status.insiderCount} insiders found`;
      const maxLen = 3900;

      const messages: string[] = [];
      let current = header;
      for (const block of tokenBlocks) {
        if (current.length + block.length + 2 > maxLen) {
          messages.push(current);
          current = "";
        }
        current += (current && current !== header ? "\n\n" : "") + block;
      }
      current += footer;
      messages.push(current);

      const buttons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
      for (let i = 0; i < messages.length; i++) {
        const isLast = i === messages.length - 1;
        if (isLast) {
          await sendDataMessage(messages[i], buttons);
        } else {
          if (bot && chatId) {
            await bot.api.sendMessage(chatId, messages[i], { parse_mode: "HTML" });
          }
        }
      }

      // AI gem analysis at bottom
      try {
        const gemAnalysis = await getAIGemAnalysis();
        if (gemAnalysis && bot && chatId) {
          await bot.api.sendMessage(chatId, gemAnalysis, { parse_mode: "HTML" });
        }
      } catch (aiErr) {
        console.error("[Telegram] AI gem analysis message failed:", aiErr);
      }
      return;
    }

    // Enrich with gem hit details for other tabs
    const enriched = topInsiders.map((wallet) => {
      const hits = getGemHitsForWallet(wallet.address, wallet.chain);
      const totalPump = hits.reduce((sum, h) => sum + (h.pumpMultiple || 0), 0);
      const avgPump = hits.length > 0 ? totalPump / hits.length : 0;
      return { wallet, hits, totalPump, avgPump };
    });

    // Apply tab-specific filtering and sorting
    let filtered = enriched;
    let tabLabel = "All Wallets";
    let emptyMessage = "";

    if (tab === "hot") {
      const sevenDaysAgo = Date.now() - 7 * 86400000;
      filtered = enriched.filter((e) =>
        e.hits.some((h) => (h.buyDate || h.buyTimestamp) >= sevenDaysAgo)
      );
      filtered.sort((a, b) => b.totalPump - a.totalPump);
      tabLabel = "Recent Gems (7d)";
      emptyMessage = "No wallets found gems in the last 7 days.";
    } else if (tab === "best") {
      filtered.sort((a, b) => b.avgPump - a.avgPump);
      tabLabel = "Best Performers";
    } else {
      // "all" tab - default sorting by totalPump
      filtered.sort((a, b) => b.totalPump - a.totalPump);
    }

    // Check if filtering resulted in empty set
    if (filtered.length === 0 && emptyMessage) {
      const buttons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage(`<b>Insider Wallets</b> - ${tabLabel}\n\n${emptyMessage}`, buttons);
      return;
    }

    // Build per-wallet blocks with gems (show top 10)
    const walletBlocks: string[] = [];
    for (const { wallet, hits } of filtered.slice(0, 10)) {
      const shortAddr = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;

      const gemList = hits
        .sort((a, b) => (b.pumpMultiple || 0) - (a.pumpMultiple || 0))
        .map((h) => {
          const pump = h.pumpMultiple ? h.pumpMultiple.toFixed(0) + "x" : "?";
          const fmt = (ts: number | undefined) => ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
          const buyStr = fmt(h.buyDate || h.buyTimestamp);
          if (h.status === "transferred") {
            return `${h.tokenSymbol} (${pump}) - Buy: ${buyStr} | Transferred: ${fmt(h.sellDate)}`;
          }
          if (h.status === "sold" || h.status === "partial") {
            return `${h.tokenSymbol} (${pump}) - Buy: ${buyStr} | Sold: ${fmt(h.sellDate)}`;
          }
          return `${h.tokenSymbol} (${pump}) - Buy: ${buyStr}`;
        })
        .join("\n");

      walletBlocks.push(`<code>${shortAddr}</code> ${wallet.chain.toUpperCase()} | ${wallet.gemHitCount} gems\n${gemList}`);
    }

    // Split into messages that fit Telegram's 4096 char limit
    const header = `<b>Insider Wallets</b> - ${tabLabel}\n\n`;
    const scannerStatus = status.running ? "Running" : "Stopped";
    const footer = `\nScanner: ${scannerStatus} | ${status.insiderCount} insiders found`;
    const maxLen = 3900; // leave room for footer + buttons

    const messages: string[] = [];
    let current = header;
    for (const block of walletBlocks) {
      if (current.length + block.length + 2 > maxLen) {
        messages.push(current);
        current = "";
      }
      current += (current && current !== header ? "\n\n" : "") + block;
    }
    current += footer;
    messages.push(current);

    // Send all pages, only last gets buttons
    const buttons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
    for (let i = 0; i < messages.length; i++) {
      const isLast = i === messages.length - 1;
      if (isLast) {
        await sendDataMessage(messages[i], buttons);
      } else {
        if (bot && chatId) {
          await bot.api.sendMessage(chatId, messages[i], { parse_mode: "HTML" });
        }
      }
    }
  } catch (err) {
    console.error("[Telegram] Insiders error:", err);
    const tabButtons = [
      [
        { text: tab === "all" ? "* All" : "All", callback_data: "insiders_all" },
        { text: tab === "hot" ? "* Hot" : "Hot", callback_data: "insiders_hot" },
        { text: tab === "best" ? "* Best" : "Best", callback_data: "insiders_best" },
        { text: tab === "holding" ? "* Holding" : "Holding", callback_data: "insiders_holding" },
      ],
    ];
    const backButton = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch insiders", backButton);
  }
}

async function handleBets(ctx: Context, tab: "open" | "closed" | "copy" | "copy_closed"): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /bets from user ${ctx.from?.id}`);
    return;
  }

  try {
    let message = `<b>Bets</b>\n\n`;

    const tabButtons = [
      [
        { text: tab === "open" ? "* AI Open" : "AI Open", callback_data: "bets_open" },
        { text: tab === "closed" ? "* AI Closed" : "AI Closed", callback_data: "bets_closed" },
      ],
      [
        { text: tab === "copy" ? "* Copy Open" : "Copy Open", callback_data: "bets_copy" },
        { text: tab === "copy_closed" ? "* Copy Closed" : "Copy Closed", callback_data: "bets_copy_closed" },
      ],
    ];

    if (tab === "open") {
      const openBets = loadOpenPositions();
      const aiStats = getBettingStats();

      if (openBets.length === 0) {
        const rSign = aiStats.totalPnl >= 0 ? "+" : "";
        message += `<b>Unrealized: $0.00 | Realized: ${rSign}$${aiStats.totalPnl.toFixed(2)}</b>\n`;
        message += `0 open | $0 invested | ${aiStats.totalBets} closed | ${aiStats.winRate.toFixed(0)}% win\n\n`;
        message += "No open AI bets.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let totalInvested = 0;
      let totalPnl = 0;
      let positionLines = "";

      for (const bet of openBets) {
        const currentPrice = await getAIBetCurrentPrice(bet.tokenId);
        let pnl = 0;
        if (currentPrice !== null) {
          const priceDiff = bet.side === "YES"
            ? currentPrice - bet.entryPrice
            : bet.entryPrice - currentPrice;
          pnl = (bet.size / bet.entryPrice) * priceDiff;
          totalInvested += bet.size;
          totalPnl += pnl;
        }

        const titleShort = bet.marketTitle.length > 35
          ? bet.marketTitle.slice(0, 35) + "..."
          : bet.marketTitle;

        positionLines += `<b>${titleShort}</b>\n`;
        positionLines += `${bet.side} $${bet.size.toFixed(0)} @ ${(bet.entryPrice * 100).toFixed(0)}c`;

        if (currentPrice !== null) {
          const pnlPct = (pnl / bet.size) * 100;
          const sign = pnl >= 0 ? "+" : "";
          positionLines += ` | Now: ${(currentPrice * 100).toFixed(0)}c`;
          positionLines += `\nP&L: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(0)}%)`;
        }

        const entryDate = new Date(bet.entryTimestamp).toLocaleDateString();
        positionLines += `\nConf: ${(bet.confidence * 100).toFixed(0)}% | EV: ${(bet.expectedValue * 100).toFixed(0)}% | ${entryDate}\n\n`;
      }

      const uSign = totalPnl >= 0 ? "+" : "";
      const rSign = aiStats.totalPnl >= 0 ? "+" : "";
      message += `<b>Unrealized: ${uSign}$${totalPnl.toFixed(2)} | Realized: ${rSign}$${aiStats.totalPnl.toFixed(2)}</b>\n`;
      message += `${openBets.length} open | $${totalInvested.toFixed(0)} invested | ${aiStats.totalBets} closed | ${aiStats.winRate.toFixed(0)}% win\n\n`;
      message += positionLines;

    } else if (tab === "closed") {
      const closedBets = loadClosedPositions(10);
      const aiStats = getBettingStats();

      if (closedBets.length === 0) {
        message += `<b>Realized: $0.00</b>\n`;
        message += `0 closed\n\n`;
        message += "No closed AI bets yet.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let closedTotalInvested = 0;
      let closedTotalPnl = 0;
      let closedLines = "";

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

        closedTotalInvested += bet.size;
        closedTotalPnl += pnl;

        closedLines += `<b>${titleShort}</b>\n`;
        closedLines += `${bet.side} $${bet.size.toFixed(0)} @ ${(bet.entryPrice * 100).toFixed(0)}c`;
        if (bet.exitPrice !== undefined) {
          closedLines += ` -> ${(bet.exitPrice * 100).toFixed(0)}c`;
        }
        closedLines += `\nP&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(0)}%)`;
        if (bet.exitReason) {
          closedLines += ` | ${bet.exitReason}`;
        }
        closedLines += ` | ${exitDate}\n\n`;
      }

      const rSign = closedTotalPnl >= 0 ? "+" : "";
      message += `<b>Realized: ${rSign}$${closedTotalPnl.toFixed(2)}</b>\n`;
      message += `${aiStats.totalBets} closed | $${closedTotalInvested.toFixed(0)} invested | ${aiStats.winRate.toFixed(0)}% win\n\n`;
      message += closedLines;

    } else if (tab === "copy") {
      // Copy Open tab - Polymarket copy positions
      const positionsWithValues = await getOpenPositionsWithValues();
      const polyStats = getCopyStats();

      if (positionsWithValues.length === 0) {
        const rSign = polyStats.totalPnl >= 0 ? "+" : "";
        message += `<b>Unrealized: $0.00 | Realized: ${rSign}$${polyStats.totalPnl.toFixed(2)}</b>\n`;
        message += `0 open | $0 invested | ${polyStats.totalCopies} closed | ${polyStats.winRate.toFixed(0)}% win\n\n`;
        message += "No open copy positions.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let totalInvested = 0;
      let totalCurrentValue = 0;
      let copyLines = "";

      for (const pos of positionsWithValues) {
        const titleShort = pos.marketTitle.length > 35
          ? pos.marketTitle.slice(0, 35) + "..."
          : pos.marketTitle;

        copyLines += `<b>${titleShort}</b>\n`;
        copyLines += `$${pos.size.toFixed(0)} @ ${(pos.entryPrice * 100).toFixed(0)}c`;

        if (pos.currentPrice !== null) {
          const currentVal = pos.currentValue ?? 0;
          const pnlPct = pos.unrealizedPnlPct ?? 0;
          const sign = pnlPct >= 0 ? "+" : "";
          copyLines += ` | Now: ${(pos.currentPrice * 100).toFixed(0)}c`;
          copyLines += `\nP&L: ${sign}$${((pos.currentValue ?? 0) - pos.size).toFixed(2)} (${sign}${pnlPct.toFixed(0)}%)`;
          totalInvested += pos.size;
          totalCurrentValue += currentVal;
        }

        copyLines += `\n\n`;
      }

      const unrealizedPnl = totalCurrentValue - totalInvested;
      const uSign = unrealizedPnl >= 0 ? "+" : "";
      const rSign = polyStats.totalPnl >= 0 ? "+" : "";
      message += `<b>Unrealized: ${uSign}$${unrealizedPnl.toFixed(2)} | Realized: ${rSign}$${polyStats.totalPnl.toFixed(2)}</b>\n`;
      message += `${positionsWithValues.length} open | $${totalInvested.toFixed(0)} invested | ${polyStats.totalCopies} closed | ${polyStats.winRate.toFixed(0)}% win\n\n`;
      message += copyLines;

    } else {
      // Copy Closed tab
      const closedCopies = getClosedCopiedPositions(10);
      const polyStats = getCopyStats();

      if (closedCopies.length === 0) {
        const rSign = polyStats.totalPnl >= 0 ? "+" : "";
        message += `<b>Realized: ${rSign}$${polyStats.totalPnl.toFixed(2)}</b>\n`;
        message += `0 closed\n\n`;
        message += "No closed copy positions yet.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let copyClosedInvested = 0;
      let copyClosedPnl = 0;
      let copyClosedLines = "";

      for (const pos of closedCopies) {
        const titleShort = pos.marketTitle.length > 35
          ? pos.marketTitle.slice(0, 35) + "..."
          : pos.marketTitle;
        const pnl = pos.pnl ?? 0;
        const pnlPct = pos.size > 0 ? (pnl / pos.size) * 100 : 0;
        const pnlSign = pnl >= 0 ? "+" : "";
        const exitDate = pos.exitTimestamp
          ? new Date(pos.exitTimestamp).toLocaleDateString()
          : "?";

        copyClosedInvested += pos.size;
        copyClosedPnl += pnl;

        copyClosedLines += `<b>${titleShort}</b>\n`;
        copyClosedLines += `$${pos.size.toFixed(0)} @ ${(pos.entryPrice * 100).toFixed(0)}c`;
        if (pos.exitPrice !== undefined) {
          copyClosedLines += ` -> ${(pos.exitPrice * 100).toFixed(0)}c`;
        }
        copyClosedLines += `\nP&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(0)}%)`;
        copyClosedLines += ` | ${exitDate}\n\n`;
      }

      const rSign = copyClosedPnl >= 0 ? "+" : "";
      message += `<b>Realized: ${rSign}$${copyClosedPnl.toFixed(2)}</b>\n`;
      message += `${polyStats.closedPositions} closed | $${copyClosedInvested.toFixed(0)} invested | ${polyStats.winRate.toFixed(0)}% win\n\n`;
      message += copyClosedLines;
    }

    const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, allButtons);
  } catch (err) {
    console.error("[Telegram] Bets error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch bets", backButton);
  }
}

async function handleManage(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  const openBets = loadOpenPositions();
  const cryptoCopy = getCryptoCopyPositions();
  const polyStats = getCopyStats();

  let message = `<b>Manage Positions</b>\n\n`;
  message += `AI Bets: ${openBets.length} open\n`;
  message += `Crypto Copy: ${cryptoCopy.length} open\n`;
  message += `Poly Copy: ${polyStats.openPositions} open\n\n`;
  message += `Choose an action:`;

  const buttons = [
    [{ text: "Close All AI Bets", callback_data: "manage_close_bets" }],
    [{ text: "Close All Copy Bets", callback_data: "manage_close_copies" }],
    [{ text: "Reset Paper Trading", callback_data: "manage_resetpaper" }],
    [{ text: "Back", callback_data: "main_menu" }],
  ];

  await sendDataMessage(message, buttons);
}

async function handleCloseAllBets(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  const openBets = loadOpenPositions();
  if (openBets.length === 0) {
    const buttons = [[{ text: "Back", callback_data: "manage" }]];
    await sendDataMessage("No open AI bets to close.", buttons);
    return;
  }

  let closed = 0;
  for (const bet of openBets) {
    const currentPrice = await getAIBetCurrentPrice(bet.tokenId);
    if (currentPrice !== null) {
      const { exitPosition } = await import("../aibetting/executor.js");
      const { success } = await exitPosition(bet, currentPrice, "Manual close");
      if (success) closed++;
    }
  }

  const buttons = [[{ text: "Back", callback_data: "manage" }]];
  await sendDataMessage(`Closed ${closed}/${openBets.length} AI bets.`, buttons);
}

async function handleCloseAllCopies(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  const { clearAllCopiedPositions } = await import("../polytraders/index.js");
  const deleted = clearAllCopiedPositions();

  const buttons = [[{ text: "Back", callback_data: "manage" }]];
  await sendDataMessage(`Cleared ${deleted} copy bet records.`, buttons);
}

async function handleStop(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /stop from user ${ctx.from?.id}`);
    return;
  }

  setLogOnlyMode(true);
  console.log("[Telegram] Trading paused (log-only mode) by user");
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
  await sendDataMessage("Trading paused - analyzing only, no bets placed.", backButton);
}

async function handleResume(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /resume from user ${ctx.from?.id}`);
    return;
  }

  setLogOnlyMode(false);
  console.log("[Telegram] Trading resumed (log-only off) by user");
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
  await sendDataMessage("Trading resumed - bets will be placed.", backButton);
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
- Auto-copy (wallets): ${settings.autoCopyEnabled ? "ON" : "OFF"}
- Min trader score: ${settings.minTraderScore}
- Max copies/day: ${settings.maxCopyPerDay}
- Today's copies: ${settings.dailyCopyCount}


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
- Analysis cache: ${schedulerStatus.analysisCacheSize} markets

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
  const cryptoCopy = getCryptoCopyPositions();
  const polyStats = getCopyStats();

  let message = "<b>RESET - Paper Trading Data</b>\n\n";
  message += "This will permanently delete:\n\n";
  message += `  AI Bets: ${openAIBets.length} open + ${closedStats.totalBets} closed\n`;
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

    // 2. Polymarket copy trades - use existing clear function
    const { clearAllCopiedPositions } = await import("../polytraders/index.js");
    const polyCopiesDeleted = clearAllCopiedPositions();

    // 3. Crypto copy positions - DB + memory
    const cryptoResult = db.prepare("DELETE FROM crypto_copy_positions").run();

    // 4. General trades table
    const tradesResult = db.prepare("DELETE FROM trades").run();

    // 5. General positions table
    const positionsResult = db.prepare("DELETE FROM positions").run();

    // 6. Daily stats
    const dailyResult = db.prepare("DELETE FROM daily_stats").run();

    // 7. Arbitrage positions
    const arbResult = db.prepare("DELETE FROM arbitrage_positions").run();

    const totalDeleted = aiBetsDeleted + aiAnalysesDeleted
      + polyCopiesDeleted + cryptoResult.changes + tradesResult.changes
      + positionsResult.changes + dailyResult.changes + arbResult.changes;

    console.log(`[ResetPaper] Paper trading data wiped: ${totalDeleted} total records`);

    let message = "<b>Reset Complete</b>\n\n";
    message += `AI bets: ${aiBetsDeleted} positions + ${aiAnalysesDeleted} analyses\n`;
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

async function handleMode(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /mode from user ${ctx.from?.id}`);
    return;
  }

  const currentMode = getTradingMode().toUpperCase();
  const logOnly = isLogOnlyMode();

  let message = `<b>Trading Mode</b>\n\n`;
  message += `Mode: <b>${currentMode}</b>\n`;
  if (logOnly) {
    message += `Status: <b>Paused</b> (analyzing only)\n`;
  }

  const buttons: { text: string; callback_data: string }[][] = [];

  if (getTradingMode() === "paper") {
    buttons.push([{ text: "Switch to LIVE", callback_data: "mode_switch_live" }]);
  } else {
    buttons.push([{ text: "Switch to PAPER", callback_data: "mode_switch_paper" }]);
  }

  buttons.push([{ text: "Back", callback_data: "main_menu" }]);

  await sendDataMessage(message, buttons);
}

async function handleModeSwitchLive(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  let message = `<b>Switch to LIVE Mode</b>\n\n`;
  message += `WARNING: This will:\n`;
  message += `- Delete ALL paper trade data\n`;
  message += `- Start trading with REAL money\n\n`;
  message += `<b>Are you sure?</b>`;

  const buttons = [
    [{ text: "Confirm - Switch to LIVE", callback_data: "mode_confirm_live" }],
    [{ text: "Cancel", callback_data: "mode" }],
  ];

  await sendDataMessage(message, buttons);
}

async function handleModeConfirmLive(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  try {
    // Delete all paper positions/trades (same logic as handleResetConfirm)
    const db = (await import("../database/db.js")).getDb();

    deleteAllPositions();
    deleteAllAnalyses();
    clearAllPositions();
    clearAnalysisCache();

    const { clearAllCopiedPositions } = await import("../polytraders/index.js");
    clearAllCopiedPositions();

    db.prepare("DELETE FROM crypto_copy_positions").run();
    db.prepare("DELETE FROM trades").run();
    db.prepare("DELETE FROM positions").run();
    db.prepare("DELETE FROM daily_stats").run();
    db.prepare("DELETE FROM arbitrage_positions").run();

    // Switch to live mode
    setTradingMode("live");
    console.log("[Telegram] Switched to LIVE mode, paper data deleted");

    await handleMode(ctx);
  } catch (err) {
    console.error("[Telegram] Mode switch error:", err);
    const backButton = [[{ text: "Back", callback_data: "mode" }]];
    await sendDataMessage("Failed to switch mode. Check logs.", backButton);
  }
}

async function handleModeSwitchPaper(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  // No confirmation needed for switching to paper (safe)
  setTradingMode("paper");
  console.log("[Telegram] Switched to PAPER mode");

  await handleMode(ctx);
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
    const env = loadEnv();
    const copyStatus = settings.autoCopyEnabled ? "ON" : "OFF";

    const aiEnabled = env.AIBETTING_ENABLED === "true";
    const aiBettingSection = aiEnabled
      ? `\n\n<b>AI BETTING</b>\n` +
        `Max Bet: $${env.AIBETTING_MAX_BET} | Max Exposure: $${env.AIBETTING_MAX_EXPOSURE}\n` +
        `Min Edge: ${(env.AIBETTING_MIN_EDGE * 100).toFixed(0)}% | Min Confidence: ${(env.AIBETTING_MIN_CONFIDENCE * 100).toFixed(0)}%\n` +
        `Bayesian Weight: ${(env.AIBETTING_BAYESIAN_WEIGHT * 100).toFixed(0)}% market / ${((1 - env.AIBETTING_BAYESIAN_WEIGHT) * 100).toFixed(0)}% AI\n` +
        `Take Profit: +${(env.AIBETTING_TAKE_PROFIT * 100).toFixed(0)}% | Stop Loss: -${(env.AIBETTING_STOP_LOSS * 100).toFixed(0)}%\n` +
        `Hold to Resolution: ${env.AIBETTING_HOLD_RESOLUTION_DAYS} days`
      : `\n\n<b>AI BETTING</b>\nDisabled`;

    const message =
      `<b>Settings</b>\n\n` +
      `<b>AUTO-COPY [${copyStatus}]</b>\n` +
      `Copy trades from profitable wallets (all chains)\n\n` +
      `Min Score: ${settings.minTraderScore}  |  Max/Day: ${settings.maxCopyPerDay}\n` +
      `Today: ${settings.dailyCopyCount}/${settings.maxCopyPerDay} copies\n\n` +
      `<b>Copy Amounts (fixed per trade):</b>\n` +
      `SOL: ${settings.copyAmountSol} | ETH: ${settings.copyAmountEth}\n` +
      `MATIC: ${settings.copyAmountMatic} | Other: ${settings.copyAmountDefault}\n` +
      `Polymarket: $${settings.polymarketCopyUsd}` +
      aiBettingSection;

    const keyboard = [
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
      [{ text: "Timezone", callback_data: "timezone" }],
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
  const env = loadEnv();

  const copyStatus = settings.autoCopyEnabled ? "ON" : "OFF";

  const aiEnabled = env.AIBETTING_ENABLED === "true";
  const aiBettingSection = aiEnabled
    ? `\n\n<b>AI BETTING</b>\n` +
      `Max Bet: $${env.AIBETTING_MAX_BET} | Max Exposure: $${env.AIBETTING_MAX_EXPOSURE}\n` +
      `Min Edge: ${(env.AIBETTING_MIN_EDGE * 100).toFixed(0)}% | Min Confidence: ${(env.AIBETTING_MIN_CONFIDENCE * 100).toFixed(0)}%\n` +
      `Bayesian Weight: ${(env.AIBETTING_BAYESIAN_WEIGHT * 100).toFixed(0)}% market / ${((1 - env.AIBETTING_BAYESIAN_WEIGHT) * 100).toFixed(0)}% AI\n` +
      `Take Profit: +${(env.AIBETTING_TAKE_PROFIT * 100).toFixed(0)}% | Stop Loss: -${(env.AIBETTING_STOP_LOSS * 100).toFixed(0)}%\n` +
      `Hold to Resolution: ${env.AIBETTING_HOLD_RESOLUTION_DAYS} days`
    : `\n\n<b>AI BETTING</b>\nDisabled`;

  const message =
    `<b>Settings</b>\n\n` +
    `<b>AUTO-COPY [${copyStatus}]</b>\n` +
    `Copy trades from profitable wallets (all chains)\n\n` +
    `Min Score: ${settings.minTraderScore}  |  Max/Day: ${settings.maxCopyPerDay}\n` +
    `Today: ${settings.dailyCopyCount}/${settings.maxCopyPerDay} copies\n\n` +
    `<b>Copy Amounts (fixed per trade):</b>\n` +
    `SOL: ${settings.copyAmountSol} | ETH: ${settings.copyAmountEth}\n` +
    `MATIC: ${settings.copyAmountMatic} | Other: ${settings.copyAmountDefault}\n` +
    `Polymarket: $${settings.polymarketCopyUsd}` +
    aiBettingSection;

  const keyboard = [
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
    [{ text: "Timezone", callback_data: "timezone" }],
    [{ text: "Back", callback_data: "main_menu" }],
  ];

  await sendDataMessage(message, keyboard);
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
