import { Bot, Context } from "grammy";
import { loadEnv, isPaperMode, setTradingMode, getTradingMode } from "../../config/env.js";
import { STARTING_CAPITAL_USD, CAPITAL_PER_STRATEGY_USD, QUANT_DAILY_DRAWDOWN_LIMIT, QUANT_PAPER_VALIDATION_DAYS } from "../../config/constants.js";
import {
  getRiskStatus,
  getDailyPnl,
  getDailyPnlPercentage,
  getTodayTrades,
} from "../risk/manager.js";
import { getMaticBalanceFormatted, getUsdcBalanceFormatted } from "../polygon/wallet.js";
import { getUserTimezone, setUserTimezone } from "../database/timezones.js";
import { getEthBalance as getBaseEthBalance } from "../base/executor.js";
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
import { getPnlForPeriod } from "../pnl/snapshots.js";
import { getOpenCopyTrades, getClosedCopyTrades, getRugStats, getHoldComparison } from "../traders/storage.js";
import { refreshCopyTradePrices } from "../traders/gem-analyzer.js";
import { getVirtualBalance, getOpenQuantPositions, setQuantKilled, isQuantKilled, getDailyLossTotal } from "../hyperliquid/index.js";
import { getClient } from "../hyperliquid/client.js";
import { getQuantStats, getFundingIncome, getQuantValidationMetrics } from "../database/quant.js";

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = null;
const dataMessageIds: number[] = [];
let lastTimezonePromptId: number | null = null;
let lastPromptMessageId: number | null = null;
const alertMessageIds: number[] = [];
const insiderExtraMessageIds: number[] = [];

// Only TELEGRAM_CHAT_ID user can send commands
function isAuthorized(ctx: Context): boolean {
  const fromId = ctx.from?.id?.toString();

  if (!fromId) return false;
  return fromId === chatId;
}



const MAIN_MENU_BUTTONS = [
  [
    { text: "📊 Status", callback_data: "pnl" },
    { text: "💰 Balance", callback_data: "balance" },
  ],
  [
    { text: "🔄 Trades", callback_data: "trades" },
    { text: "🎯 Bets", callback_data: "bets" },
    { text: "⚛️ Quant", callback_data: "quant" },
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
    try {
      await handleInsiders(ctx, "wallets");
    } catch (err) {
      console.error("[Telegram] Command error (insiders):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
    }
  });

  // Callback handlers
  bot.callbackQuery("balance", async (ctx) => {
    try {
      await handleBalance(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (balance):", err);
      await ctx.reply("Failed to load balance. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("pnl", async (ctx) => {
    try {
      await handlePnl(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (pnl):", err);
      await ctx.reply("Failed to load P&L. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("pnl_all", async (ctx) => {
    try {
      await handlePnl(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (pnl_all):", err);
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("trades", async (ctx) => {
    try {
      await handleTrades(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (trades):", err);
      await ctx.reply("Failed to load trades. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("timezone", async (ctx) => {
    try {
      await handleTimezone(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (timezone):", err);
      await ctx.reply("Failed to update timezone. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("stop", async (ctx) => {
    try {
      await handleStop(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (stop):", err);
      await ctx.reply("Failed to stop bot. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("resume", async (ctx) => {
    try {
      await handleResume(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (resume):", err);
      await ctx.reply("Failed to resume bot. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("bettors", async (ctx) => {
    try {
      await handleBettors(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bettors):", err);
      await ctx.reply("Failed to load bettors. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("insiders", async (ctx) => {
    try {
      await handleInsiders(ctx, "wallets");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("insiders_holding", async (ctx) => {
    try {
      await handleInsiders(ctx, "holding");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders_holding):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
bot.callbackQuery("insiders_wallets", async (ctx) => {
    try {
      await handleInsiders(ctx, "wallets");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders_wallets):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery(/^insiders_chain_([a-z]+)_([a-z]+)$/, async (ctx) => {
    try {
      const match = ctx.match;
      if (!match) return;
      const chainVal = match[1];
      const tabVal = match[2] as "holding" | "wallets";
      const resolvedChain = chainVal === "all" ? undefined : chainVal;
      await handleInsiders(ctx, tabVal, resolvedChain);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders_chain):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("bets", async (ctx) => {
    try {
      await handleBets(ctx, "open");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("bets_open", async (ctx) => {
    try {
      await handleBets(ctx, "open");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_open):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("bets_closed", async (ctx) => {
    try {
      await handleBets(ctx, "closed");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_closed):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("bets_copy", async (ctx) => {
    try {
      await handleBets(ctx, "copy");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_copy):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("bets_copy_closed", async (ctx) => {
    try {
      await handleBets(ctx, "copy_closed");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_copy_closed):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });

  bot.callbackQuery("clear_chat", async (ctx) => {
    try {
      for (const msgId of alertMessageIds) {
        if (chatId) await bot?.api.deleteMessage(chatId, msgId).catch(() => {});
      }
      alertMessageIds.length = 0;
      await sendMainMenu();
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (clear_chat):", err);
      await ctx.reply("Failed to clear chat. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });

  // Settings
  bot.callbackQuery("settings", async (ctx) => {
    try {
      await handleSettings(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (settings):", err);
      await ctx.reply("Failed to load settings. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("toggle_autocopy", async (ctx) => {
    try {
      await handleToggleAutoCopy(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (toggle_autocopy):", err);
      await ctx.reply("Failed to toggle auto-copy. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("set_min_score", async (ctx) => {
    try {
      await handleSetMinScore(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (set_min_score):", err);
      await ctx.reply("Failed to update min score. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("set_max_daily", async (ctx) => {
    try {
      await handleSetMaxDaily(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (set_max_daily):", err);
      await ctx.reply("Failed to update max daily. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("set_copy_eth", async (ctx) => {
    try {
      await handleSetCopyAmount(ctx, "copy_eth");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (set_copy_eth):", err);
      await ctx.reply("Failed to update ETH copy amount. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("set_copy_matic", async (ctx) => {
    try {
      await handleSetCopyAmount(ctx, "copy_matic");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (set_copy_matic):", err);
      await ctx.reply("Failed to update MATIC copy amount. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("set_copy_default", async (ctx) => {
    try {
      await handleSetCopyAmount(ctx, "copy_default");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (set_copy_default):", err);
      await ctx.reply("Failed to update default copy amount. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("set_copy_poly", async (ctx) => {
    try {
      await handleSetCopyAmount(ctx, "copy_poly");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (set_copy_poly):", err);
      await ctx.reply("Failed to update Polymarket copy amount. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("main_menu", async (ctx) => {
    try {
      await sendMainMenu();
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (main_menu):", err);
      await ctx.reply("Failed to load menu. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("manage", async (ctx) => {
    try {
      await handleManage(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage):", err);
      await ctx.reply("Failed to load management panel. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("manage_close_bets", async (ctx) => {
    try {
      await handleCloseAllBets(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage_close_bets):", err);
      await ctx.reply("Failed to close bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("manage_close_copies", async (ctx) => {
    try {
      await handleCloseAllCopies(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage_close_copies):", err);
      await ctx.reply("Failed to close copies. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("manage_resetpaper", async (ctx) => {
    try {
      await handleReset(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage_resetpaper):", err);
      await ctx.reply("Failed to reset paper trading. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("confirm_resetpaper", async (ctx) => {
    try {
      await handleResetConfirm(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (confirm_resetpaper):", err);
      await ctx.reply("Failed to confirm reset. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("cancel_resetpaper", async (ctx) => {
    try {
      const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage("Reset cancelled.", backButton);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (cancel_resetpaper):", err);
      await ctx.reply("Failed to cancel reset. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("mode", async (ctx) => {
    try {
      await handleMode(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (mode):", err);
      await ctx.reply("Failed to load mode settings. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("mode_switch_live", async (ctx) => {
    try {
      await handleModeSwitchLive(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (mode_switch_live):", err);
      await ctx.reply("Failed to switch to live mode. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("mode_confirm_live", async (ctx) => {
    try {
      await handleModeConfirmLive(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (mode_confirm_live):", err);
      await ctx.reply("Failed to confirm live mode. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("mode_switch_paper", async (ctx) => {
    try {
      await handleModeSwitchPaper(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (mode_switch_paper):", err);
      await ctx.reply("Failed to switch to paper mode. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("quant", async (ctx) => {
    try {
      await handleQuant(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (quant):", err);
      await ctx.reply("Failed to load quant panel. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });

  bot.callbackQuery("quant_go_live", async (ctx) => {
    if (!isAuthorized(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      const validation = getQuantValidationMetrics();
      if (validation.paperDaysElapsed >= QUANT_PAPER_VALIDATION_DAYS) {
        setTradingMode("live");
        await sendDataMessage(
          "Quant trading switched to LIVE mode with $10 capital. Use /stop to halt if needed.",
          [[{ text: "Back", callback_data: "quant" }]],
        );
      } else {
        const daysRemaining = Math.max(0, QUANT_PAPER_VALIDATION_DAYS - Math.floor(validation.paperDaysElapsed));
        await sendDataMessage(
          `Paper validation incomplete. ${daysRemaining} days remaining.`,
          [[{ text: "Back", callback_data: "quant" }]],
        );
      }
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (quant_go_live):", err);
      await ctx.reply("Failed to go live. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    }
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

let lastAlertWithButtonId: number | null = null;

export async function sendMessage(text: string): Promise<void> {
  if (!bot || !chatId) {
    console.warn("[Telegram] Bot not initialized, cannot send message");
    return;
  }

  try {
    if (lastAlertWithButtonId) {
      await bot.api.editMessageReplyMarkup(chatId, lastAlertWithButtonId, {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }

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
    const toDelete: number[] = [];
    if (lastMenuMessageId) toDelete.push(lastMenuMessageId);
    toDelete.push(...dataMessageIds);
    if (lastPromptMessageId) toDelete.push(lastPromptMessageId);
    if (lastTimezonePromptId) toDelete.push(lastTimezonePromptId);
    toDelete.push(...alertMessageIds);
    toDelete.push(...insiderExtraMessageIds);

    const currentChatId = chatId;
    const currentBot = bot;
    await Promise.all(toDelete.map(id => currentBot.api.deleteMessage(currentChatId, id).catch(() => {})));

    lastMenuMessageId = null;
    dataMessageIds.length = 0;
    lastPromptMessageId = null;
    lastTimezonePromptId = null;
    alertMessageIds.length = 0;
    insiderExtraMessageIds.length = 0;
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

function splitLongMessage(text: string): string[] {
  const MAX_LEN = 4096;
  if (text.length <= MAX_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within the limit
    let splitAt = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitAt <= 0) {
      // No newline found, hard-split at limit
      splitAt = MAX_LEN;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n/, "");

    // Handle unclosed <b> tags: count opens vs closes
    const opens = (chunk.match(/<b>/g) || []).length;
    const closes = (chunk.match(/<\/b>/g) || []).length;
    if (opens > closes) {
      chunk += "</b>";
      remaining = "<b>" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

async function sendDataMessage(text: string, inlineKeyboard?: { text: string; callback_data: string }[][]): Promise<void> {
  if (!bot || !chatId) return;
  try {
    const chunks = splitLongMessage(text);

    // Edit in-place when we have exactly one existing message and one new chunk
    if (dataMessageIds.length === 1 && chunks.length === 1) {
      try {
        await bot.api.editMessageText(chatId, dataMessageIds[0], chunks[0], {
          parse_mode: "HTML",
          reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
        });
        return;
      } catch {
        // Edit failed (message too old, deleted, etc.) - fall through to delete+send
      }
    }

    // Delete all previous data messages
    for (const id of dataMessageIds) {
      await bot.api.deleteMessage(chatId, id).catch(() => {});
    }
    dataMessageIds.length = 0;

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const options: { parse_mode: "HTML"; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } = {
        parse_mode: "HTML",
      };
      if (isLast && inlineKeyboard) {
        options.reply_markup = { inline_keyboard: inlineKeyboard };
      }
      const msg = await bot.api.sendMessage(chatId, chunks[i], options);
      dataMessageIds.push(msg.message_id);
    }
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

  const userTz = getUserTimezone(userId);
  if (!userTz) {
    setUserTimezone(userId, "UTC");
  }

  if (ctx.message?.message_id && chatId) {
    await bot?.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
  }

  await sendMainMenu();
}

async function handleBalance(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /balance from user ${ctx.from?.id}`);
    return;
  }

  const fmt = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

  if (isPaperMode()) {
    const lines = [
      `Capital: ${fmt(STARTING_CAPITAL_USD)}`,
      `Per Strategy: ${fmt(CAPITAL_PER_STRATEGY_USD)}`,
    ];
    const message = `<b>Balance</b> | Paper\n${lines.join("\n")}`;
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
    return;
  }

  try {
    const formatWei = (wei: bigint): string => (Number(wei) / 1e18).toFixed(4);

    // Fetch balances sequentially to avoid RPC batching issues
    const maticBalance = await getMaticBalanceFormatted().catch(() => "Error");
    const usdcBalance = await getUsdcBalanceFormatted().catch(() => "Error");
    const baseEthBalance = await getBaseEthBalance().catch(() => BigInt(0));
    const arbitrumEthBalance = await getArbitrumEthBalance().catch(() => BigInt(0));
    const avaxBalance = await getAvaxBalance().catch(() => BigInt(0));

    const lines = [
      `Polygon MATIC: ${maticBalance}`,
      `Polygon USDC: ${usdcBalance}`,
      `Base ETH: ${formatWei(baseEthBalance)}`,
      `Arbitrum ETH: ${formatWei(arbitrumEthBalance)}`,
      `Avax AVAX: ${formatWei(avaxBalance)}`,
    ];
    const message = `<b>Balance</b>\n${lines.join("\n")}`;

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
    const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
    const $fmt = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

    const status = await getRiskStatus();
    const modeTag = status.isPaperMode ? "Paper" : "Live";
    const killTag = status.killSwitchActive ? " | Kill" : "";

    let message = `<b>Status</b> | ${modeTag}${killTag} | All-Time\n`;

    // Compute unrealized P&L first (needed for total)
    const openBets = loadOpenPositions();
    let aiBetUnrealized = 0;
    for (const bet of openBets) {
      const price = await getAIBetCurrentPrice(bet.tokenId);
      if (price !== null) {
        const diff = bet.side === "YES" ? price - bet.entryPrice : bet.entryPrice - price;
        aiBetUnrealized += (bet.size / bet.entryPrice) * diff;
      }
    }

    let copyPositions: Awaited<ReturnType<typeof getOpenPositionsWithValues>> = [];
    try {
      copyPositions = await getOpenPositionsWithValues();
    } catch { /* non-fatal */ }
    let copyUnrealized = 0;
    for (const pos of copyPositions) {
      if (pos.currentValue !== null) {
        copyUnrealized += (pos.currentValue ?? 0) - pos.size;
      }
    }

    try {
      await refreshCopyTradePrices();
    } catch { /* DexScreener failure non-fatal */ }
    const openInsider = getOpenCopyTrades();
    const insiderUnrealized = openInsider.reduce((sum, t) => sum + (t.pnlPct / 100) * t.amountUsd, 0);

    const env = loadEnv();
    const quantPositions = getOpenQuantPositions();
    let quantUnrealized = 0;
    if (env.QUANT_ENABLED === "true" && !!env.HYPERLIQUID_PRIVATE_KEY && quantPositions.length > 0) {
      try {
        const sdk = getClient();
        const mids = (await sdk.info.getAllMids(true)) as Record<string, string>;
        for (const pos of quantPositions) {
          const rawMid = mids[pos.pair];
          if (rawMid) {
            const currentPrice = parseFloat(rawMid);
            if (!isNaN(currentPrice)) {
              quantUnrealized += pos.direction === "long"
                ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * pos.size * pos.leverage
                : ((pos.entryPrice - currentPrice) / pos.entryPrice) * pos.size * pos.leverage;
            }
          }
        }
      } catch { /* prices unavailable */ }
    }

    const totalUnrealized = aiBetUnrealized + copyUnrealized + insiderUnrealized + quantUnrealized;

    // Total (realized + unrealized)
    const data = getPnlForPeriod(null);
    const realizedNonRug = data.totalPnl - data.rugPnl;
    const breakdownStr = formatBreakdown(
      data.cryptoCopyPnl,
      data.polyCopyPnl,
      data.aiBettingPnl,
      data.quantPnl,
      data.insiderCopyPnl,
    );

    const rugStats = getRugStats();
    const total = data.totalPnl + totalUnrealized;
    message += `<b>Total: ${pnl(total)}</b>`;

    // Realized
    message += `\n-------------------\n`;
    message += `<b>Realized</b> ${pnl(realizedNonRug)}\n`;
    message += breakdownStr;
    const rugPnlStr = rugStats.pnlUsd !== 0
      ? ` | ${rugStats.pnlUsd >= 0 ? "+" : ""}${$fmt(rugStats.pnlUsd)}`
      : "";
    message += `\nRugs: ${rugStats.count}${rugPnlStr}`;

    // Unrealized (open positions)
    message += `\n-------------------\n`;
    const unrealizedLines: string[] = [];

    const aiInvested = openBets.reduce((sum, b) => sum + b.size, 0);
    const aiPnlStr = openBets.length > 0 ? ` ${pnl(aiBetUnrealized)}` : "";
    const schedulerStatus = getAIBettingStatus();
    const logOnly = schedulerStatus.logOnly ? " Log" : "";
    unrealizedLines.push(`AI Bets: ${openBets.length} | in:${$fmt(aiInvested)}${aiPnlStr}${logOnly}`);

    const copyInvested = copyPositions.reduce((sum, p) => sum + p.size, 0);
    const copyPnlStr = copyPositions.length > 0 ? ` ${pnl(copyUnrealized)}` : "";
    unrealizedLines.push(`Poly Copy: ${copyPositions.length} | in:${$fmt(copyInvested)}${copyPnlStr}`);

    const insiderInvested = openInsider.reduce((sum, t) => sum + t.amountUsd, 0);
    let insiderLine = `Insider: ${openInsider.length} | in:${$fmt(insiderInvested)}`;
    if (openInsider.length > 0) insiderLine += ` ${pnl(insiderUnrealized)}`;
    unrealizedLines.push(insiderLine);

    const quantInvested = quantPositions.reduce((sum, p) => sum + p.size, 0);
    const quantPnlStr = quantPositions.length > 0 ? ` ${pnl(quantUnrealized)}` : "";
    const quantKillStr = isQuantKilled() ? " HALTED" : "";
    unrealizedLines.push(`Quant: ${quantPositions.length} | in:${$fmt(quantInvested)}${quantPnlStr}${quantKillStr}`);

    message += `<b>Unrealized</b> ${pnl(totalUnrealized)}\n${unrealizedLines.join("\n")}`;

    // Hold comparison
    try {
      const holdComp = getHoldComparison();
      if (holdComp.actualPnlUsd !== 0 || holdComp.holdPnlUsd !== 0) {
        message += `\n-------------------\n`;
        message += `Gems if held: ${pnl(holdComp.holdPnlUsd)}\n`;
        message += `Gems exits: ${pnl(holdComp.actualPnlUsd)}`;
      }
    } catch { /* non-fatal */ }

    if (status.pauseReason) {
      message += `\n\n${status.pauseReason}`;
    }

    const allButtons = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, allButtons);
  } catch (err) {
    console.error("[Telegram] P&L error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to load P&L", backButton);
  }
}

function formatBreakdown(
  cryptoCopy: number,
  polyCopy: number,
  aiBetting: number,
  quantPnl: number,
  insiderCopyPnl: number,
): string {
  const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;

  const sources = [
    { name: "Crypto Copy", value: cryptoCopy },
    { name: "Poly Copy", value: polyCopy },
    { name: "AI Bets", value: aiBetting },
    { name: "Quant", value: quantPnl },
    { name: "Insider", value: insiderCopyPnl },
  ];

  const rows = sources.map(s => `${s.name}: ${pnl(s.value)}`);
  return rows.join("\n");
}

async function handleTrades(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /trades from user ${ctx.from?.id}`);
    return;
  }

  try {
    const trades = getTodayTrades();
    const cryptoCopyPositions = getCryptoCopyPositions();
    const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
    const $ = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

    let message = `<b>Trades</b>\n\n`;

    // Crypto copy positions
    if (cryptoCopyPositions.length > 0) {
      message += `<b>Crypto Copy</b> ${cryptoCopyPositions.length} open\n`;
      for (const pos of cryptoCopyPositions) {
        message += `${pos.tokenSymbol} | ${pos.chain} | ${pos.entryAmountNative.toFixed(4)} native\n`;
      }
      message += `\n`;
    }

    // Insider copy trades
    try { await refreshCopyTradePrices(); } catch { /* non-fatal */ }
    const openCopyTrades = getOpenCopyTrades();
    const closedCopyTrades = getClosedCopyTrades();
    if (openCopyTrades.length > 0 || closedCopyTrades.length > 0) {
      const copyInvested = openCopyTrades.reduce((s, t) => s + t.amountUsd, 0);
      const unrealPnl = openCopyTrades.reduce((s, t) => s + (t.pnlPct / 100) * t.amountUsd, 0);
      const realPnl = closedCopyTrades.reduce((s, t) => s + (t.pnlPct / 100) * t.amountUsd, 0);
      let header = `<b>Insider Copy</b> ${openCopyTrades.length} open`;
      if (openCopyTrades.length > 0) header += ` | ${$(copyInvested)} inv | ${pnl(unrealPnl)} unr`;
      if (closedCopyTrades.length > 0) header += ` | ${pnl(realPnl)} real`;
      message += header + `\n`;
      if (openCopyTrades.length > 0) {
        for (const t of openCopyTrades) {
          const pnlUsd = (t.pnlPct / 100) * t.amountUsd;
          const walletShort = `${t.walletAddress.slice(0, 6)}..${t.walletAddress.slice(-4)}`;
          message += `${t.tokenSymbol} | ${$(t.amountUsd)} | ${pnl(pnlUsd)} ${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(0)}%\n`;
          message += `  ${walletShort}\n`;
        }
      }
      if (closedCopyTrades.length > 0) {
        message += `\n<b>Closed</b> ${closedCopyTrades.length} | ${pnl(realPnl)}\n`;
        for (const t of closedCopyTrades.slice(0, 5)) {
          const pnlUsd = (t.pnlPct / 100) * t.amountUsd;
          const chainTag = t.chain.toUpperCase().slice(0, 3);
          message += `${t.tokenSymbol} | ${chainTag} | ${pnl(pnlUsd)} ${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(0)}%\n`;
        }
        if (closedCopyTrades.length > 5) message += `... +${closedCopyTrades.length - 5} more\n`;
      }
      message += `\n`;
    }

    // Recent trades
    if (trades.length > 0) {
      message += `<b>Today</b> ${trades.length} trades\n`;
      for (const trade of trades) {
        const time = new Date(trade.timestamp).toLocaleTimeString().slice(0, 5);
        message += `${time} | ${trade.strategy} | ${$(trade.amount)} | ${pnl(trade.pnl)}\n`;
      }
    } else if (cryptoCopyPositions.length === 0 && openCopyTrades.length === 0 && closedCopyTrades.length === 0) {
      message += "No trades or positions.";
    }

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] Trades error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to load trades", backButton);
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
    const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;

    // Only show bettors we copy (10%+ ROI)
    const copiedBettors = trackedBettors.filter(b => b.roi >= 0.10).sort((a, b) => b.roi - a.roi);

    let message = `<b>Bettors</b> | ${copyStats.openPositions} open ${copyStats.closedPositions} closed | WR ${copyStats.winRate.toFixed(0)}% | ${pnl(copyStats.totalPnl)}\n`;

    if (copiedBettors.length === 0) {
      message += "No bettors with 10%+ ROI found.";
      const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage(message, backButton);
      return;
    }

    const rows = copiedBettors.map(b => {
      const name = b.name.length > 13 ? b.name.slice(0, 12) + "..." : b.name;
      const roi = `${(b.roi * 100).toFixed(1)}%`;
      const bPnl = `${b.pnl > 0 ? "+" : ""}$${b.pnl.toFixed(0)}`;
      const vol = `$${(b.vol / 1000).toFixed(0)}k`;
      return `${name} | ${roi} | ${bPnl} | ${vol}`;
    });

    message += rows.join("\n");

    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(message, backButton);
  } catch (err) {
    console.error("[Telegram] Bettors error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch bettors", backButton);
  }
}

async function handleInsiders(ctx: Context, tab: "holding" | "wallets" = "wallets", chain?: string): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /insiders from user ${ctx.from?.id}`);
    return;
  }

  try {
    // Clean up overflow pages from previous insiders view
    if (bot && chatId) {
      for (const id of insiderExtraMessageIds) {
        await bot.api.deleteMessage(chatId, id).catch(() => {});
      }
      insiderExtraMessageIds.length = 0;
    }

    const chainButtons = [
      [
        { text: tab === "wallets" ? "* Wallets" : "Wallets", callback_data: chain ? `insiders_chain_${chain}_wallets` : "insiders_wallets" },
        { text: tab === "holding" ? "* Holding" : "Holding", callback_data: chain ? `insiders_chain_${chain}_holding` : "insiders_holding" },
      ],
      [
        { text: chain === "ethereum" ? "* Eth" : "Eth", callback_data: `insiders_chain_ethereum_${tab}` },
        { text: chain === "base" ? "* Base" : "Base", callback_data: `insiders_chain_base_${tab}` },
        { text: chain === "arbitrum" ? "* Arb" : "Arb", callback_data: `insiders_chain_arbitrum_${tab}` },
      ],
      [
        { text: chain === "polygon" ? "* Poly" : "Poly", callback_data: `insiders_chain_polygon_${tab}` },
        { text: chain === "optimism" ? "* Opt" : "Opt", callback_data: `insiders_chain_optimism_${tab}` },
        { text: chain === "avalanche" ? "* Avax" : "Avax", callback_data: `insiders_chain_avalanche_${tab}` },
      ],
      [
        { text: !chain ? "* All Chains" : "All Chains", callback_data: `insiders_chain_all_${tab}` },
      ],
    ];

    if (tab === "holding") {
      try { await refreshCopyTradePrices(); } catch { /* non-fatal */ }
      let trades = getOpenCopyTrades();
      if (chain) trades = trades.filter(t => t.chain === chain);

      const buttons = [...chainButtons, [{ text: "Back", callback_data: "main_menu" }]];

      if (trades.length === 0) {
        await sendDataMessage(`<b>Insiders - Holding</b>\n\nNo insiders currently holding tokens.`, buttons);
        return;
      }

      const invested = trades.reduce((s, t) => s + t.amountUsd, 0);
      const unrealPnl = trades.reduce((s, t) => s + (t.pnlPct / 100) * t.amountUsd, 0);
      const fmtPnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
      const fmtUsd = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

      let message = `<b>Insiders - Holding</b> ${trades.length} open | ${fmtUsd(invested)} inv | ${fmtPnl(unrealPnl)} unr\n\n`;
      for (const t of trades) {
        const pnlUsd = (t.pnlPct / 100) * t.amountUsd;
        const walletShort = `${t.walletAddress.slice(0, 6)}..${t.walletAddress.slice(-4)}`;
        const dateTs = t.tokenCreatedAt ?? t.buyTimestamp;
        const dateLabel = t.tokenCreatedAt ? "launched" : "found";
        const dateStr = new Date(dateTs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        message += `${t.tokenSymbol} | ${fmtUsd(t.amountUsd)} | ${fmtPnl(pnlUsd)} ${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(0)}%\n`;
        message += `  ${walletShort} | ${dateLabel} ${dateStr}\n`;
      }

      await sendDataMessage(message, buttons);
      return;
    }

    if (tab === "wallets") {
      try { await refreshCopyTradePrices(); } catch { /* non-fatal */ }
      const { getInsiderWalletsWithStats } = await import("../traders/storage.js");
      const walletStats = getInsiderWalletsWithStats(chain as "ethereum" | "base" | "arbitrum" | "polygon" | "optimism" | "avalanche" | undefined);

      if (walletStats.length === 0) {
        const buttons = [...chainButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(`<b>Insiders - Wallets</b>\n\nNo qualified insiders yet.`, buttons);
        return;
      }

      walletStats.sort((a, b) => b.score - a.score);

      const lines = walletStats.map((w) => {
        const addrShort = `0x${w.address.slice(2, 4)}..${w.address.slice(-4)}`;
        const gainSign = w.avgGainPct > 0 ? "+" : "";
        return `${addrShort} | ${w.score} | ${gainSign}${w.avgGainPct.toFixed(0)}%`;
      });

      const header = `<b>Insiders - Wallets</b>\n\n`;
      const footer = `\n${walletStats.length} insiders`;
      const text = header + lines.join("\n") + footer;

      const buttons = [...chainButtons, [{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage(text, buttons);

      return;
    }

  } catch (err) {
    console.error("[Telegram] Insiders error:", err);
    const errorButtons = [
      [
        { text: tab === "wallets" ? "* Wallets" : "Wallets", callback_data: chain ? `insiders_chain_${chain}_wallets` : "insiders_wallets" },
        { text: tab === "holding" ? "* Holding" : "Holding", callback_data: chain ? `insiders_chain_${chain}_holding` : "insiders_holding" },
      ],
      [
        { text: chain === "ethereum" ? "* Eth" : "Eth", callback_data: `insiders_chain_ethereum_${tab}` },
        { text: chain === "base" ? "* Base" : "Base", callback_data: `insiders_chain_base_${tab}` },
        { text: chain === "arbitrum" ? "* Arb" : "Arb", callback_data: `insiders_chain_arbitrum_${tab}` },
      ],
      [
        { text: chain === "polygon" ? "* Poly" : "Poly", callback_data: `insiders_chain_polygon_${tab}` },
        { text: chain === "optimism" ? "* Opt" : "Opt", callback_data: `insiders_chain_optimism_${tab}` },
        { text: chain === "avalanche" ? "* Avax" : "Avax", callback_data: `insiders_chain_avalanche_${tab}` },
      ],
      [
        { text: !chain ? "* All Chains" : "All Chains", callback_data: `insiders_chain_all_${tab}` },
      ],
    ];
    const backButton = [...errorButtons, [{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch insiders", backButton);
  }
}

async function handleBets(ctx: Context, tab: "open" | "closed" | "copy" | "copy_closed"): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /bets from user ${ctx.from?.id}`);
    return;
  }

  try {
    const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
    const $ = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
    const trunc = (s: string, n: number): string => s.length > n ? s.slice(0, n - 1) + "." : s;
    const c = (n: number): string => `${(n * 100).toFixed(0)}c`;
    const shortDate = (ts: number): string => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };

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
        message += `Unreal: ${pnl(0)} | Real: ${pnl(aiStats.totalPnl)}\n`;
        message += `0 open | $0 inv | ${aiStats.totalBets} closed | ${aiStats.winRate.toFixed(0)}% win\n\n`;
        message += "No open AI bets.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let totalInvested = 0;
      let totalPnlVal = 0;
      let positionLines = "";

      for (const bet of openBets) {
        const currentPrice = await getAIBetCurrentPrice(bet.tokenId);
        let betPnl = 0;
        if (currentPrice !== null) {
          const priceDiff = bet.side === "YES"
            ? currentPrice - bet.entryPrice
            : bet.entryPrice - currentPrice;
          betPnl = (bet.size / bet.entryPrice) * priceDiff;
          totalInvested += bet.size;
          totalPnlVal += betPnl;
        }

        positionLines += `${trunc(bet.marketTitle, 30)}\n`;
        const side = bet.side === "YES" ? "Y" : "N";
        positionLines += `  ${side} ${$(bet.size)} @${c(bet.entryPrice)}`;
        if (currentPrice !== null) {
          const pnlPct = (betPnl / bet.size) * 100;
          positionLines += `->${c(currentPrice)} ${pnl(betPnl)} ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(0)}%`;
        }
        positionLines += `\n`;
        const conf = (bet.confidence * 100).toFixed(0);
        const ev = (bet.expectedValue * 100).toFixed(0);
        positionLines += `  ${conf}%conf | ${ev}%ev | ${shortDate(bet.entryTimestamp)}\n\n`;
      }

      message += `Unreal: ${pnl(totalPnlVal)} | Real: ${pnl(aiStats.totalPnl)}\n`;
      message += `${openBets.length} open | ${$(totalInvested)} inv | ${aiStats.totalBets} closed | ${aiStats.winRate.toFixed(0)}% win\n\n`;
      message += positionLines;

    } else if (tab === "closed") {
      const closedBets = loadClosedPositions(1000);
      const aiStats = getBettingStats();

      if (closedBets.length === 0) {
        message += `Real: ${pnl(0)}\n`;
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
        const betPnl = bet.pnl ?? 0;
        const pnlPct = bet.size > 0 ? (betPnl / bet.size) * 100 : 0;
        const exitDate = bet.exitTimestamp ? shortDate(bet.exitTimestamp) : "?";

        closedTotalInvested += bet.size;
        closedTotalPnl += betPnl;

        closedLines += `${trunc(bet.marketTitle, 30)}\n`;
        const side = bet.side === "YES" ? "Y" : "N";
        closedLines += `  ${side} ${$(bet.size)} @${c(bet.entryPrice)}`;
        if (bet.exitPrice !== undefined) {
          closedLines += `->${c(bet.exitPrice)}`;
        }
        closedLines += ` ${pnl(betPnl)} ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(0)}%\n`;
        closedLines += `  ${bet.exitReason ? bet.exitReason + " | " : ""}${exitDate}\n\n`;
      }

      message += `Real: ${pnl(closedTotalPnl)}\n`;
      message += `${aiStats.totalBets} closed | ${$(closedTotalInvested)} inv | ${aiStats.winRate.toFixed(0)}% win\n\n`;
      message += closedLines;

    } else if (tab === "copy") {
      // Copy Open tab - Polymarket copy positions
      const positionsWithValues = await getOpenPositionsWithValues();
      const polyStats = getCopyStats();

      if (positionsWithValues.length === 0) {
        message += `Unreal: ${pnl(0)} | Real: ${pnl(polyStats.totalPnl)}\n`;
        message += `0 open | $0 inv | ${polyStats.totalCopies} closed | ${polyStats.winRate.toFixed(0)}% win\n\n`;
        message += "No open copy positions.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let totalInvested = 0;
      let totalCurrentValue = 0;
      let copyLines = "";

      for (const pos of positionsWithValues) {
        copyLines += `${trunc(pos.marketTitle, 30)}\n`;
        copyLines += `  ${$(pos.size)} @${c(pos.entryPrice)}`;

        if (pos.currentPrice !== null) {
          const currentVal = pos.currentValue ?? 0;
          const pnlPct = pos.unrealizedPnlPct ?? 0;
          const posPnl = (pos.currentValue ?? 0) - pos.size;
          copyLines += `->${c(pos.currentPrice)} ${pnl(posPnl)} ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(0)}%`;
          totalInvested += pos.size;
          totalCurrentValue += currentVal;
        }

        copyLines += `\n\n`;
      }

      const unrealizedPnl = totalCurrentValue - totalInvested;
      message += `Unreal: ${pnl(unrealizedPnl)} | Real: ${pnl(polyStats.totalPnl)}\n`;
      message += `${positionsWithValues.length} open | ${$(totalInvested)} inv | ${polyStats.totalCopies} closed | ${polyStats.winRate.toFixed(0)}% win\n\n`;
      message += copyLines;

    } else {
      // Copy Closed tab
      const closedCopies = getClosedCopiedPositions(1000);
      const polyStats = getCopyStats();

      if (closedCopies.length === 0) {
        message += `Real: ${pnl(polyStats.totalPnl)}\n`;
        message += `0 closed\n\n`;
        message += "No closed copy positions yet.";
        const allButtons = [...tabButtons, [{ text: "Back", callback_data: "main_menu" }]];
        await sendDataMessage(message, allButtons);
        return;
      }

      let copyClosedInvested = 0;
      let copyClosedPnlVal = 0;
      let copyClosedLines = "";

      for (const pos of closedCopies) {
        const posPnl = pos.pnl ?? 0;
        const pnlPct = pos.size > 0 ? (posPnl / pos.size) * 100 : 0;
        const exitDate = pos.exitTimestamp ? shortDate(pos.exitTimestamp) : "?";

        copyClosedInvested += pos.size;
        copyClosedPnlVal += posPnl;

        copyClosedLines += `${trunc(pos.marketTitle, 30)}\n`;
        copyClosedLines += `  ${$(pos.size)} @${c(pos.entryPrice)}`;
        if (pos.exitPrice !== undefined) {
          copyClosedLines += `->${c(pos.exitPrice)}`;
        }
        copyClosedLines += ` ${pnl(posPnl)} ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(0)}% | ${exitDate}\n\n`;
      }

      message += `Real: ${pnl(copyClosedPnlVal)}\n`;
      message += `${polyStats.closedPositions} closed | ${$(copyClosedInvested)} inv | ${polyStats.winRate.toFixed(0)}% win\n\n`;
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

  try {
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
  } catch (err) {
    console.error("[Telegram] Manage error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to load manage", backButton);
  }
}

async function handleCloseAllBets(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  try {
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
  } catch (err) {
    console.error("[Telegram] Close bets error:", err);
    const buttons = [[{ text: "Back", callback_data: "manage" }]];
    await sendDataMessage("Failed to close bets", buttons);
  }
}

async function handleCloseAllCopies(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  try {
    const { clearAllCopiedPositions } = await import("../polytraders/index.js");
    const deleted = clearAllCopiedPositions();

    const buttons = [[{ text: "Back", callback_data: "manage" }]];
    await sendDataMessage(`Cleared ${deleted} copy bet records.`, buttons);
  } catch (err) {
    console.error("[Telegram] Close copies error:", err);
    const buttons = [[{ text: "Back", callback_data: "manage" }]];
    await sendDataMessage("Failed to close copies", buttons);
  }
}

async function handleStop(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /stop from user ${ctx.from?.id}`);
    return;
  }

  setLogOnlyMode(true);
  setQuantKilled(true);
  console.log("[Telegram] Trading paused (log-only + quant killed) by user");
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
  await sendDataMessage("All trading paused - AI bets log-only, quant trading halted.", backButton);
}

async function handleResume(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /resume from user ${ctx.from?.id}`);
    return;
  }

  setLogOnlyMode(false);
  setQuantKilled(false);
  console.log("[Telegram] Trading resumed (log-only off + quant active) by user");
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
  await sendDataMessage("All trading resumed - bets and quant active.", backButton);
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
    const usdcBalance = await getUsdcBalanceFormatted().catch(() => "Error");

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
- Daily PnL: $${dailyPnl.toFixed(2)} (${dailyPnlPct > 0 ? "+" : ""}${dailyPnlPct.toFixed(1)}%)
- USDC balance: ${usdcBalance}

=== USER SETTINGS ===
- Auto-copy (wallets): ${settings.autoCopyEnabled ? "ON" : "OFF"}
- Min trader score: ${settings.minTraderScore}
- Max copies/day: ${settings.maxCopyPerDay}
- Today's copies: ${settings.dailyCopyCount}


=== POLYMARKET COPY BETTING ===
- Total copies: ${copyStats.totalCopies}
- Open copied positions: ${copyStats.openPositions}
- Closed: ${copyStats.closedPositions}
- Win rate: ${copyStats.winRate.toFixed(1)}%
- Total PnL: $${copyStats.totalPnl.toFixed(2)}
${openCopiedPositions.length > 0 ? `\nOpen copies:\n${openCopiedPositions.map(p => `  - ${p.marketTitle} $${p.size} @ ${(p.entryPrice * 100).toFixed(0)}c (copying ${p.traderName})`).join("\n")}` : ""}

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
  `- ${p.marketTitle}\n  ${p.side} @ ${(p.entryPrice * 100).toFixed(0)}c, $${p.size.toFixed(2)}, AI:${(p.aiProbability * 100).toFixed(0)}%`
).join("\n")}

=== RECENT BET OUTCOMES ===
${recentOutcomes.length === 0 ? "None yet" : recentOutcomes.map(o =>
  `- ${o.actualOutcome.toUpperCase()}: ${o.marketTitle} $${o.pnl.toFixed(2)}`
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

    // Send response with Back button (sendDataMessage handles splitting)
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(response, backButton);
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
  const db = (await import("../database/db.js")).getDb();
  const insiderWalletCount = (db.prepare("SELECT COUNT(*) as cnt FROM insider_wallets").get() as { cnt: number }).cnt;
  const insiderCopyCount = (db.prepare("SELECT COUNT(*) as cnt FROM insider_copy_trades").get() as { cnt: number }).cnt;
  const quantTradeCount = (db.prepare("SELECT COUNT(*) as cnt FROM quant_trades").get() as { cnt: number }).cnt;
  const quantPosCount = (db.prepare("SELECT COUNT(*) as cnt FROM quant_positions").get() as { cnt: number }).cnt;

  let message = "<b>RESET - Paper Trading Data</b>\n\n";
  message += "This will permanently delete:\n\n";
  message += `  AI Bets: ${openAIBets.length} open + ${closedStats.totalBets} closed\n`;
  message += `  Crypto Copy: ${cryptoCopy.length} positions\n`;
  message += `  Poly Copy: ${polyStats.totalCopies} copies\n`;
  message += `  Insider Copy: ${insiderCopyCount} trades\n`;
  message += `  Insiders: ${insiderWalletCount} wallets\n`;
  message += `  Quant: ${quantTradeCount} trades + ${quantPosCount} positions\n`;
  message += `  Trades + daily stats + caches: all\n\n`;
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
    const { resetAIBettingBalance } = await import("../aibetting/scheduler.js");
    resetAIBettingBalance();

    // 2. Polymarket copy trades - use existing clear function
    const { clearAllCopiedPositions } = await import("../polytraders/index.js");
    const polyCopiesDeleted = clearAllCopiedPositions();

    // 3. Crypto copy positions - DB + memory
    const cryptoResult = db.prepare("DELETE FROM crypto_copy_positions").run();
    const { clearCryptoCopyMemory } = await import("../copy/executor.js");
    clearCryptoCopyMemory();

    // 4. Insider copy trades - delete all (scoring rebuilds from new trades)
    const insiderCopyResult = db.prepare("DELETE FROM insider_copy_trades").run();

    // 5. General trades table
    const tradesResult = db.prepare("DELETE FROM trades").run();

    // 6. General positions table
    const positionsResult = db.prepare("DELETE FROM positions").run();

    // 7. Daily stats
    const dailyResult = db.prepare("DELETE FROM daily_stats").run();

    // 8. Arbitrage positions
    const arbResult = db.prepare("DELETE FROM arbitrage_positions").run();

    // 9. Copy outcomes - preserved for scoring history
    const copyOutcomesResult = { changes: 0 };

    // 12. Calibration data
    const calPredResult = db.prepare("DELETE FROM calibration_predictions").run();
    const calScoreResult = db.prepare("DELETE FROM calibration_scores").run();
    const calLogResult = db.prepare("DELETE FROM calibration_log").run();

    // 13. Whale trades
    const whaleResult = db.prepare("DELETE FROM whale_trades").run();

    // 14. Quant trades + positions + config
    const quantTradesResult = db.prepare("DELETE FROM quant_trades").run();
    const quantPosResult = db.prepare("DELETE FROM quant_positions").run();
    const quantConfigResult = db.prepare("DELETE FROM quant_config").run();

    // 16. Clear all in-memory caches
    const { clearWatcherMemory } = await import("../traders/watcher.js");
    const { clearCopyPriceFailures } = await import("../traders/gem-analyzer.js");
    const { clearPaperMemory, clearAICache: clearQuantAICache, resetDailyDrawdown } = await import("../hyperliquid/index.js");
    clearWatcherMemory();
    clearCopyPriceFailures();
    clearPaperMemory();
    clearQuantAICache();
    resetDailyDrawdown();

    const totalDeleted = aiBetsDeleted + aiAnalysesDeleted
      + polyCopiesDeleted + cryptoResult.changes + insiderCopyResult.changes
      + tradesResult.changes + positionsResult.changes + dailyResult.changes + arbResult.changes
      + copyOutcomesResult.changes + calPredResult.changes + calScoreResult.changes
      + calLogResult.changes + whaleResult.changes
      + quantTradesResult.changes + quantPosResult.changes + quantConfigResult.changes;

    console.log(`[ResetPaper] Paper trading data wiped: ${totalDeleted} total records`);

    let message = "<b>Reset Complete</b>\n\n";
    message += `AI bets: ${aiBetsDeleted} positions + ${aiAnalysesDeleted} analyses\n`;
    message += `Poly copies: ${polyCopiesDeleted} + ${copyOutcomesResult.changes} outcomes\n`;
    message += `Crypto copies: ${cryptoResult.changes} records\n`;
    message += `Insider copies: ${insiderCopyResult.changes} trades reset\n`;
    message += `Quant: ${quantTradesResult.changes} trades + ${quantPosResult.changes} positions\n`;
    message += `Calibration: ${calPredResult.changes + calScoreResult.changes + calLogResult.changes} records\n`;
    message += `Other: ${tradesResult.changes + positionsResult.changes + dailyResult.changes + arbResult.changes + whaleResult.changes} records\n\n`;
    message += `<b>Total: ${totalDeleted} records deleted</b>\n`;
    message += "Paper trading is ready to start fresh.\nAll caches cleared.";

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

  try {
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
  } catch (err) {
    console.error("[Telegram] Mode error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to load mode", backButton);
  }
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
    db.prepare("DELETE FROM insider_copy_trades WHERE status = 'open'").run();
    db.prepare("DELETE FROM trades").run();
    db.prepare("DELETE FROM positions").run();
    db.prepare("DELETE FROM daily_stats").run();
    db.prepare("DELETE FROM arbitrage_positions").run();
    // copy_outcomes preserved for scoring history
    db.prepare("DELETE FROM calibration_predictions").run();
    db.prepare("DELETE FROM calibration_scores").run();
    db.prepare("DELETE FROM calibration_log").run();
    db.prepare("DELETE FROM whale_trades").run();
    db.prepare("DELETE FROM quant_trades").run();
    db.prepare("DELETE FROM quant_positions").run();
    db.prepare("DELETE FROM quant_config").run();

    // Clear all in-memory caches
    const { clearCryptoCopyMemory } = await import("../copy/executor.js");
    const { clearWatcherMemory } = await import("../traders/watcher.js");
    const { clearCopyPriceFailures } = await import("../traders/gem-analyzer.js");
    const { clearPaperMemory, clearAICache: clearQuantAICache, resetDailyDrawdown } = await import("../hyperliquid/index.js");
    clearCryptoCopyMemory();
    clearWatcherMemory();
    clearCopyPriceFailures();
    clearPaperMemory();
    clearQuantAICache();
    resetDailyDrawdown();

    // Switch to live mode
    setTradingMode("live");
    console.log("[Telegram] Switched to LIVE mode, all paper data deleted");

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

  try {
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
      `ETH: ${settings.copyAmountEth}\n` +
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
  } catch (err) {
    console.error("[Telegram] Text input error:", err);
    await ctx.reply("Error processing input. Try again.").catch(() => {});
  }
}

// Settings state for multi-step input
let settingsInputMode: "min_score" | "max_daily" | "copy_eth" | "copy_matic" | "copy_default" | "copy_poly" | null = null;

async function handleSettings(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /settings from user ${ctx.from?.id}`);
    return;
  }

  try {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const settings = getSettings(userId);
    const env = loadEnv();

    const copyStatus = settings.autoCopyEnabled ? "ON" : "OFF";
    const aiEnabled = env.AIBETTING_ENABLED === "true";
    const bayMkt = (env.AIBETTING_BAYESIAN_WEIGHT * 100).toFixed(0);
    const bayAI = ((1 - env.AIBETTING_BAYESIAN_WEIGHT) * 100).toFixed(0);

    const settingsLines = [
      `Copy: ${copyStatus}`,
      `Score: ${settings.minTraderScore} | Max/Day: ${settings.maxCopyPerDay}`,
      `Today: ${settings.dailyCopyCount}/${settings.maxCopyPerDay}`,
      ``,
      `ETH: ${settings.copyAmountEth}`,
      `MATIC: ${settings.copyAmountMatic} | Other: ${settings.copyAmountDefault}`,
      `Poly: $${settings.polymarketCopyUsd}`,
    ];

    if (aiEnabled) {
      settingsLines.push(``);
      settingsLines.push(`AI Bets: ON`);
      settingsLines.push(`MaxBet: $${env.AIBETTING_MAX_BET} | MaxExp: $${env.AIBETTING_MAX_EXPOSURE}`);
      settingsLines.push(`Edge: ${(env.AIBETTING_MIN_EDGE * 100).toFixed(0)}% | Conf: ${(env.AIBETTING_MIN_CONFIDENCE * 100).toFixed(0)}%`);
      settingsLines.push(`Bayesian: ${bayMkt}/${bayAI}`);
      settingsLines.push(`TP: +${(env.AIBETTING_TAKE_PROFIT * 100).toFixed(0)}% | SL: -${(env.AIBETTING_STOP_LOSS * 100).toFixed(0)}%`);
      settingsLines.push(`Hold: ${env.AIBETTING_HOLD_RESOLUTION_DAYS}d`);
    } else {
      settingsLines.push(``);
      settingsLines.push(`AI Bets: OFF`);
    }

    const message = `<b>Settings</b>\n\n${settingsLines.join("\n")}`;

    const keyboard = [
      [{ text: `Auto-Copy: ${copyStatus}`, callback_data: "toggle_autocopy" }],
      [
        { text: `Min Score: ${settings.minTraderScore}`, callback_data: "set_min_score" },
        { text: `Max/Day: ${settings.maxCopyPerDay}`, callback_data: "set_max_daily" },
      ],
      [
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
  } catch (err) {
    console.error("[Telegram] Settings error:", err);
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to load settings", backButton);
  }
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

async function handleSetCopyAmount(ctx: Context, mode: "copy_eth" | "copy_matic" | "copy_default" | "copy_poly"): Promise<void> {
  if (!isAuthorized(ctx)) return;

  settingsInputMode = mode;

  const prompts: Record<typeof mode, string> = {
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

async function handleQuant(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  const env = loadEnv();
  const quantEnabled = env.QUANT_ENABLED === "true" && !!env.HYPERLIQUID_PRIVATE_KEY;

  if (!quantEnabled) {
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage(
      "<b>Quant Trading (Hyperliquid)</b>\n\nDisabled. Set QUANT_ENABLED=true and HYPERLIQUID_PRIVATE_KEY to enable.",
      backButton,
    );
    return;
  }

  const balance = getVirtualBalance();
  const openPositions = getOpenQuantPositions();
  const mode = isPaperMode() ? "PAPER" : "LIVE";

  const killed = isQuantKilled();
  const dailyLoss = getDailyLossTotal();
  const funding = getFundingIncome();
  const aiStats = getQuantStats("ai-directional");
  const ruleStats = getQuantStats("rule-directional");
  const microStats = getQuantStats("micro-directional");

  const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
  const $ = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

  let text = `<b>Quant</b> | ${mode === "PAPER" ? "Paper" : "Live"} | Kill: ${killed ? "HALTED" : "OFF"}\n`;
  text += `${$(balance)} bal | ${openPositions.length} open | ${$(dailyLoss)}/$${QUANT_DAILY_DRAWDOWN_LIMIT} daily loss\n`;

  let mids: Record<string, string> = {};
  if (openPositions.length > 0) {
    try {
      const sdk = getClient();
      mids = (await sdk.info.getAllMids(true)) as Record<string, string>;
    } catch {
      // Prices unavailable - show positions without unrealized P&L
    }
  }

  if (openPositions.length > 0) {
    const posLines: string[] = [];
    for (const pos of openPositions) {
      const dir = pos.direction === "long" ? "L" : "S";
      const typeTag =
        pos.tradeType === "funding" ? "[F]" :
        pos.tradeType === "rule-directional" ? "[R]" :
        pos.tradeType === "micro-directional" ? "[M]" : "[AI]";
      let upnlStr = "";
      const rawMid = mids[pos.pair];
      if (rawMid) {
        const currentPrice = parseFloat(rawMid);
        if (!isNaN(currentPrice)) {
          const unrealizedPnl =
            pos.direction === "long"
              ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * pos.size * pos.leverage
              : ((pos.entryPrice - currentPrice) / pos.entryPrice) * pos.size * pos.leverage;
          upnlStr = ` ${pnl(unrealizedPnl)}`;
        }
      }
      posLines.push(`${typeTag} ${dir} ${pos.pair} ${$(pos.size)} @${pos.entryPrice.toFixed(2)} ${pos.leverage}x${upnlStr}`);
    }
    text += `\n${posLines.join("\n")}\n`;
  }

  const fundingPnl = funding.totalIncome;
  const totalPnl = aiStats.totalPnl + ruleStats.totalPnl + microStats.totalPnl + fundingPnl;
  const totalTrades = aiStats.totalTrades + ruleStats.totalTrades + microStats.totalTrades + funding.tradeCount;

  text += `\nAI: ${pnl(aiStats.totalPnl)} | ${aiStats.totalTrades} trades | ${aiStats.totalTrades > 0 ? aiStats.winRate.toFixed(0) : 0}% win\n`;
  text += `Rule: ${pnl(ruleStats.totalPnl)} | ${ruleStats.totalTrades} trades | ${ruleStats.totalTrades > 0 ? ruleStats.winRate.toFixed(0) : 0}% win\n`;
  text += `Micro: ${pnl(microStats.totalPnl)} | ${microStats.totalTrades} trades | ${microStats.totalTrades > 0 ? microStats.winRate.toFixed(0) : 0}% win\n`;
  text += `Funding: ${pnl(fundingPnl)} | ${funding.tradeCount} trades\n`;
  text += `Total: ${pnl(totalPnl)} | ${totalTrades} trades\n`;

  const validation = getQuantValidationMetrics();
  const daysElapsed = Math.floor(validation.paperDaysElapsed);

  if (validation.paperDaysElapsed >= QUANT_PAPER_VALIDATION_DAYS) {
    text += `Day ${daysElapsed}/${QUANT_PAPER_VALIDATION_DAYS} — ready for live\n`;
  } else {
    text += `Day ${daysElapsed}/${QUANT_PAPER_VALIDATION_DAYS} paper validation\n`;
  }

  const buttons: { text: string; callback_data: string }[][] = [];
  if (validation.paperDaysElapsed >= QUANT_PAPER_VALIDATION_DAYS && isPaperMode()) {
    buttons.push([{ text: "Go Live", callback_data: "quant_go_live" }]);
  }
  buttons.push([{ text: "Back", callback_data: "main_menu" }]);

  await sendDataMessage(text, buttons);
}
