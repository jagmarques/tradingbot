import { Bot, Context } from "grammy";
import { readFileSync, writeFileSync } from "fs";
import { loadEnv, isPaperMode, setTradingMode, getTradingMode } from "../../config/env.js";
import { STARTING_CAPITAL_USD, CAPITAL_PER_STRATEGY_USD, QUANT_DAILY_DRAWDOWN_LIMIT, QUANT_PAPER_VALIDATION_DAYS, QUANT_HYBRID_LIVE_ENGINES } from "../../config/constants.js";
import {
  getRiskStatus,
  getDailyPnl,
  getDailyPnlPercentage,
  getTodayTrades,
} from "../risk/manager.js";
import { getUsdcBalanceFormatted } from "../polygon/wallet.js";
import { getUserTimezone, setUserTimezone } from "../database/timezones.js";
import { getCopyStats, getOpenCopiedPositions, getClosedCopiedPositions, getOpenPositionsWithValues, getTrackedTraders } from "../polytraders/index.js";
import { getSettings } from "../settings/settings.js";
import { callDeepSeek } from "../aibetting/deepseek.js";
import { getBettingStats, loadOpenPositions, loadClosedPositions, getRecentBetOutcomes, deleteAllPositions, deleteAllAnalyses } from "../database/aibetting.js";
import { getAIBettingStatus, clearAnalysisCache } from "../aibetting/scheduler.js";
import { getCurrentPrice as getAIBetCurrentPrice, clearAllPositions } from "../aibetting/executor.js";
import { getOpenCryptoCopyPositions as getCryptoCopyPositions } from "../copy/executor.js";
import { getPnlForPeriod } from "../pnl/snapshots.js";
import { getOpenCopyTrades, getClosedCopyTrades, getRugStats, getHoldComparison } from "../traders/storage.js";
import { refreshCopyTradePrices } from "../traders/gem-analyzer.js";
import { getOpenQuantPositions, isQuantKilled, getDailyLossTotal } from "../hyperliquid/index.js";
import { getClient } from "../hyperliquid/client.js";
import { getQuantStats, getQuantValidationMetrics } from "../database/quant.js";

const MENU_MSG_ID_PATH = process.env.DB_PATH
  ? process.env.DB_PATH.replace("trades.db", "menu_msg_id.txt")
  : "/app/data/menu_msg_id.txt";

function loadPersistedMenuMsgId(): number | null {
  try {
    const raw = readFileSync(MENU_MSG_ID_PATH, "utf8").trim();
    const id = parseInt(raw, 10);
    return isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

function persistMenuMsgId(id: number | null): void {
  try {
    writeFileSync(MENU_MSG_ID_PATH, id === null ? "" : String(id), "utf8");
  } catch {
    // non-critical
  }
}

let bot: Bot | null = null;
let chatId: string | null = null;
let lastMenuMessageId: number | null = loadPersistedMenuMsgId();
const dataMessageIds: number[] = [];
let lastTimezonePromptId: number | null = null;
let lastPromptMessageId: number | null = null;
const alertMessageIds: number[] = [];
const insiderExtraMessageIds: number[] = [];
let callbackProcessing = false;
let activeOpId = 0;

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
    { text: "🗂 Manage", callback_data: "manage" },
  ],
];

export async function startBot(): Promise<void> {
  const env = loadEnv();
  chatId = env.TELEGRAM_CHAT_ID;

  bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command("start", handleStart);
  bot.command("balance", handleBalance);
  bot.command("pnl", handlePnl);
  bot.command("trades", handleTrades);
  bot.command("timezone", handleTimezone);
  bot.command("ai", handleAI);
  bot.command("clearcopies", handleClearCopies);
  bot.command("resetpaper", handleReset);
  bot.command("insiders", async (ctx) => {
    try {
      await handleInsiders(ctx, "wallets");
    } catch (err) {
      console.error("[Telegram] Command error (insiders):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
    }
  });

  bot.callbackQuery("balance", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBalance(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (balance):", err);
      await ctx.reply("Failed to load balance. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("pnl", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handlePnl(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (pnl):", err);
      await ctx.reply("Failed to load P&L. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("pnl_all", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handlePnl(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (pnl_all):", err);
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("trades", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleTrades(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (trades):", err);
      await ctx.reply("Failed to load trades. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("timezone", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleTimezone(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (timezone):", err);
      await ctx.reply("Failed to update timezone. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("bettors", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBettors(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bettors):", err);
      await ctx.reply("Failed to load bettors. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("insiders", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleInsiders(ctx, "wallets");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("insiders_holding", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleInsiders(ctx, "holding");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders_holding):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
bot.callbackQuery("insiders_wallets", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleInsiders(ctx, "wallets");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (insiders_wallets):", err);
      await ctx.reply("Failed to load insiders. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });

  bot.callbackQuery("bets", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBets(ctx, "open");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("bets_open", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBets(ctx, "open");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_open):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("bets_closed", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBets(ctx, "closed");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_closed):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("bets_copy", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBets(ctx, "copy");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_copy):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("bets_copy_closed", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleBets(ctx, "copy_closed");
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (bets_copy_closed):", err);
      await ctx.reply("Failed to load bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });

  bot.callbackQuery("clear_chat", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
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
    } finally {
      callbackProcessing = false;
    }
  });

  bot.callbackQuery("main_menu", async (ctx) => {
    activeOpId++;
    callbackProcessing = false;
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
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleManage(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage):", err);
      await ctx.reply("Failed to load management panel. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("manage_close_bets", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleCloseAllBets(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage_close_bets):", err);
      await ctx.reply("Failed to close bets. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("manage_close_copies", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleCloseAllCopies(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage_close_copies):", err);
      await ctx.reply("Failed to close copies. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("manage_resetpaper", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleReset(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (manage_resetpaper):", err);
      await ctx.reply("Failed to reset paper trading. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("confirm_resetpaper", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleResetConfirm(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (confirm_resetpaper):", err);
      await ctx.reply("Failed to confirm reset. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("cancel_resetpaper", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
      await sendDataMessage("Reset cancelled.", backButton);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (cancel_resetpaper):", err);
      await ctx.reply("Failed to cancel reset. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });
  bot.callbackQuery("quant", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      await handleQuant(ctx);
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.error("[Telegram] Callback error (quant):", err);
      await ctx.reply("Failed to load quant panel. Try again.").catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      callbackProcessing = false;
    }
  });

  bot.callbackQuery("quant_go_live", async (ctx) => {
    if (callbackProcessing) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    callbackProcessing = true;
    try {
      if (!isAuthorized(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const validation = getQuantValidationMetrics();
      if (validation.paperDaysElapsed >= QUANT_PAPER_VALIDATION_DAYS) {
        setTradingMode("hybrid");
        const { initLiveEngine } = await import("../hyperliquid/live-executor.js");
        initLiveEngine();
        await sendDataMessage(
          "Quant trading switched to HYBRID mode (AI live, technical paper). Use /stop to halt if needed.",
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
    } finally {
      callbackProcessing = false;
    }
  });

  bot.on("message:text", handleTextInput);

  bot.catch((err) => {
    console.error("[Telegram] Bot error:", err);
  });

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
    toDelete.push(...dataMessageIds);
    if (lastPromptMessageId) toDelete.push(lastPromptMessageId);
    if (lastTimezonePromptId) toDelete.push(lastTimezonePromptId);
    toDelete.push(...alertMessageIds);
    toDelete.push(...insiderExtraMessageIds);

    const currentChatId = chatId;
    const currentBot = bot;
    await Promise.all(toDelete.map(id => currentBot.api.deleteMessage(currentChatId, id).catch(() => {})));

    dataMessageIds.length = 0;
    lastPromptMessageId = null;
    lastTimezonePromptId = null;
    alertMessageIds.length = 0;
    insiderExtraMessageIds.length = 0;
    lastAlertWithButtonId = null;

    if (lastMenuMessageId) {
      try {
        await bot.api.editMessageText(chatId, lastMenuMessageId, "🤖", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS },
        });
        return;
      } catch (editErr) {
        if (editErr instanceof Error && editErr.message.includes("message is not modified")) {
          return; // Already showing correct content
        }
        // Edit failed for other reason - delete old to avoid duplicate
        await bot.api.deleteMessage(chatId, lastMenuMessageId).catch(() => {});
        lastMenuMessageId = null;
        persistMenuMsgId(null);
      }
    }

    const msg = await bot.api.sendMessage(chatId, "🤖", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: MAIN_MENU_BUTTONS },
    });
    lastMenuMessageId = msg.message_id;
    persistMenuMsgId(lastMenuMessageId);
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

    if (dataMessageIds.length === 1 && chunks.length === 1) {
      try {
        await bot.api.editMessageText(chatId, dataMessageIds[0], chunks[0], {
          parse_mode: "HTML",
          reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
        });
        return;
      } catch (editErr) {
        if (editErr instanceof Error && editErr.message.includes("message is not modified")) {
          return; // Already showing correct content
        }
        // fall through to delete+send
      }
    }

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

  const myOpId = activeOpId;
  const fmt = (n: number): string => `$${n.toFixed(2)}`;
  const backButton = [[{ text: "Back", callback_data: "main_menu" }]];

  if (isPaperMode()) {
    const lines = [
      `Capital: ${fmt(STARTING_CAPITAL_USD)}`,
      `Per Strategy: ${fmt(CAPITAL_PER_STRATEGY_USD)}`,
    ];
    await sendDataMessage(`<b>Balance</b> | Paper\n${lines.join("\n")}`, backButton);
    return;
  }

  try {
    const { getAccountBalance } = await import("../hyperliquid/account.js");
    const { getLighterAccountInfo, isLighterInitialized } = await import("../lighter/client.js");
    const env = loadEnv();

    const [hlAccount, ltAccount] = await Promise.all([
      env.HYPERLIQUID_WALLET_ADDRESS
        ? getAccountBalance(env.HYPERLIQUID_WALLET_ADDRESS).catch(() => ({ equity: 0, balance: 0, unrealizedPnl: 0 }))
        : Promise.resolve({ equity: 0, balance: 0, unrealizedPnl: 0 }),
      isLighterInitialized()
        ? getLighterAccountInfo().catch(() => ({ equity: 0, marginUsed: 0 }))
        : Promise.resolve({ equity: 0, marginUsed: 0 }),
    ]);

    if (activeOpId !== myOpId) return;

    const total = hlAccount.equity + ltAccount.equity;
    const msg = `<b>Portfolio</b>\nHL: ${fmt(hlAccount.equity)} | LT: ${fmt(ltAccount.equity)}\n<b>Total: ${fmt(total)}</b>`;
    await sendDataMessage(msg, backButton);
  } catch (err) {
    console.error("[Telegram] Balance error:", err);
    if (activeOpId !== myOpId) return;
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Failed to fetch balances", backButton);
  }
}

async function handlePnl(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /pnl from user ${ctx.from?.id}`);
    return;
  }

  const myOpId = activeOpId;

  try {
    const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
    const $fmt = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

    const status = await getRiskStatus();
    const tm = getTradingMode();
    const modeTag = tm === "paper" ? "Paper" : tm === "hybrid" ? "Hybrid" : "Live";
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
    let quantLiveUnrealized = 0;
    let hlUnrealized = 0;
    let ltUnrealized = 0;
    if (env.QUANT_ENABLED === "true" && !!env.HYPERLIQUID_PRIVATE_KEY && quantPositions.length > 0) {
      try {
        const sdk = getClient();
        const mids = (await sdk.info.getAllMids(true)) as Record<string, string>;
        let ltMids: Record<string, string> = {};
        // Exchange unrealized P&L
        let hlExUpnl: Record<string, number> = {};
        let ltExUpnl: Record<string, number> = {};
        const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
        if (wallet) {
          try {
            const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
            for (const ap of state.assetPositions) {
              if (parseFloat(ap.position.szi) !== 0) {
                hlExUpnl[ap.position.coin] = parseFloat(ap.position.unrealizedPnl ?? "0");
              }
            }
          } catch { /* HL state unavailable */ }
        }
        const ltPositions = quantPositions.filter(p => p.exchange === "lighter");
        if (ltPositions.length > 0) {
          try {
            const { getLighterAllMids, isLighterInitialized, getLighterUnrealizedPnl } = await import("../lighter/client.js");
            if (isLighterInitialized()) {
              ltExUpnl = await getLighterUnrealizedPnl();
              // Mid-prices only needed for paper positions
              const paperPairs = [...new Set(ltPositions.filter(p => p.mode !== "live").map(p => p.pair))];
              if (paperPairs.length > 0) {
                ltMids = await getLighterAllMids(paperPairs);
              }
            }
          } catch { /* Lighter unavailable */ }
        }
        // Proportional exchange unrealized split
        const livePairSize = new Map<string, number>();
        for (const pos of quantPositions) {
          if (pos.mode === "live") {
            const k = `${pos.exchange ?? "hl"}:${pos.pair}`;
            livePairSize.set(k, (livePairSize.get(k) ?? 0) + pos.size);
          }
        }
        for (const pos of quantPositions) {
          let posUnr: number | undefined;
          if (pos.mode === "live") {
            const k = `${pos.exchange ?? "hl"}:${pos.pair}`;
            const exVal = pos.exchange === "lighter" ? ltExUpnl[pos.pair] : hlExUpnl[pos.pair];
            const totalSize = livePairSize.get(k) ?? 0;
            if (exVal !== undefined && totalSize > 0) {
              posUnr = exVal * (pos.size / totalSize);
            }
          } else {
            // Paper: mid-price calc (no exchange data)
            const priceSource = pos.exchange === "lighter" ? ltMids : mids;
            const rawMid = priceSource[pos.pair];
            if (rawMid) {
              const cp = parseFloat(rawMid);
              if (!isNaN(cp)) {
                posUnr = pos.direction === "long"
                  ? ((cp - pos.entryPrice) / pos.entryPrice) * pos.size * pos.leverage
                  : ((pos.entryPrice - cp) / pos.entryPrice) * pos.size * pos.leverage;
              }
            }
          }
          if (posUnr !== undefined) {
            quantUnrealized += posUnr;
            if (pos.mode === "live") {
              quantLiveUnrealized += posUnr;
              if (pos.exchange === "lighter") ltUnrealized += posUnr;
              else hlUnrealized += posUnr;
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

    if (tm === "hybrid") {
      const db = (await import("../database/db.js")).getDb();
      const hlClosedQ = db.prepare(`SELECT COALESCE(SUM(pnl), 0) as total, COUNT(*) as cnt FROM quant_trades WHERE status = 'closed' AND mode = 'live' AND exchange != 'lighter'`).get() as { total: number; cnt: number };
      const ltClosedQ = db.prepare(`SELECT COALESCE(SUM(pnl), 0) as total, COUNT(*) as cnt FROM quant_trades WHERE status = 'closed' AND mode = 'live' AND exchange = 'lighter'`).get() as { total: number; cnt: number };
      const hlRealizedQ = hlClosedQ.total;
      const ltRealizedQ = ltClosedQ.total;
      const paperRealizedQ = (db.prepare(`SELECT COALESCE(SUM(pnl), 0) as total FROM quant_trades WHERE status = 'closed' AND mode != 'live'`).get() as { total: number }).total;
      const { getOpenQuantPositions: getQPos } = await import("../hyperliquid/executor.js");
      const qOpen = getQPos();
      const hlOpen = qOpen.filter((p: any) => p.mode === "live" && p.exchange !== "lighter");
      const ltOpen = qOpen.filter((p: any) => p.mode === "live" && p.exchange === "lighter");
      const hlDep = hlOpen.reduce((s: number, p: any) => s + p.size, 0);
      const ltDep = ltOpen.reduce((s: number, p: any) => s + p.size, 0);
      // Fetch margin info from exchanges
      let hlMarginLine = "";
      let ltMarginLine = "";
      try {
        const sdk = getClient();
        const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
        if (wallet) {
          const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
          const hlUsed = parseFloat(state.marginSummary.totalMarginUsed) || 0;
          let hlEq = parseFloat(state.marginSummary.accountValue) || 0;
          if (hlEq <= hlUsed) {
            try {
              const spotState = await sdk.info.spot.getSpotClearinghouseState(wallet, true);
              const usdcBal = spotState.balances?.find((b: any) => b.coin === "USDC");
              if (usdcBal) hlEq = parseFloat(usdcBal.total) || 0;
            } catch { /* ignore */ }
          }
          const hlFree = Math.max(0, hlEq - hlUsed);
          hlMarginLine = `HL: $${hlUsed.toFixed(0)} locked | $${hlFree.toFixed(0)} free`;
        }
      } catch { /* non-fatal */ }
      try {
        const { getLighterAccountInfo, isLighterInitialized: ltInit } = await import("../lighter/client.js");
        if (ltInit()) {
          const ltAcc = await getLighterAccountInfo();
          const ltFree = Math.max(0, ltAcc.equity - ltAcc.marginUsed);
          ltMarginLine = `LT: $${Math.max(0, ltAcc.marginUsed).toFixed(0)} locked | $${ltFree.toFixed(0)} free`;
        }
      } catch { /* non-fatal */ }

      message += `Paper: ${pnl(paperRealizedQ + (data.totalPnl - data.quantPnl))} | unr ${pnl(totalUnrealized - quantLiveUnrealized)}`;
      message += `\n<b>Live HL: ${pnl(hlRealizedQ)} ${hlOpen.length}/${hlClosedQ.cnt + hlOpen.length}T ($${hlDep.toFixed(0)}) | unr ${pnl(hlUnrealized)}</b>`;
      message += `\n<b>Live LT: ${pnl(ltRealizedQ)} ${ltOpen.length}/${ltClosedQ.cnt + ltOpen.length}T ($${ltDep.toFixed(0)}) | unr ${pnl(ltUnrealized)}</b>`;
      const lastHl = hlOpen.sort((a: any, b: any) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())[0];
      const lastLt = ltOpen.sort((a: any, b: any) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())[0];
      if (hlMarginLine || ltMarginLine) message += "\n";
      if (hlMarginLine) message += hlMarginLine;
      if (ltMarginLine) message += (hlMarginLine ? "\n" : "") + ltMarginLine;
      if (lastHl || lastLt) {
        const parts: string[] = [];
        if (lastHl) parts.push(`HL: $${lastHl.size.toFixed(2)} ${lastHl.pair}`);
        if (lastLt) parts.push(`LT: $${lastLt.size.toFixed(2)} ${lastLt.pair}`);
        message += `\nLast trade: ${parts.join(" | ")}`;
      }
    } else {
      message += `<b>Total: ${pnl(total)}</b>`;
    }

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
    const aiDepStr = aiInvested > 0 ? ` ($${aiInvested.toFixed(0)})` : "";
    unrealizedLines.push(`AI Bets: ${openBets.length}${aiDepStr}${aiPnlStr}${logOnly}`);

    const copyInvested = copyPositions.reduce((sum, p) => sum + p.size, 0);
    const copyPnlStr = copyPositions.length > 0 ? ` ${pnl(copyUnrealized)}` : "";
    const copyDepStr = copyInvested > 0 ? ` ($${copyInvested.toFixed(0)})` : "";
    unrealizedLines.push(`Poly Copy: ${copyPositions.length}${copyDepStr}${copyPnlStr}`);

    const insiderInvested = openInsider.reduce((sum, t) => sum + t.amountUsd, 0);
    const insiderDepStr = insiderInvested > 0 ? ` ($${insiderInvested.toFixed(0)})` : "";
    let insiderLine = `Insider: ${openInsider.length}${insiderDepStr}`;
    if (openInsider.length > 0) insiderLine += ` ${pnl(insiderUnrealized)}`;
    unrealizedLines.push(insiderLine);

    const quantKillStr = isQuantKilled() ? " HALTED" : "";
    const quantInvested = quantPositions.reduce((sum, p) => sum + p.size, 0);
    const quantPnlStr = quantPositions.length > 0 ? ` ${pnl(quantUnrealized)}` : "";
    const quantDepStr = quantInvested > 0 ? ` ($${quantInvested.toFixed(0)})` : "";
    unrealizedLines.push(`Quant: ${quantPositions.length}${quantDepStr}${quantPnlStr}${quantKillStr}`);

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
    if (activeOpId !== myOpId) return;
    await sendDataMessage(message, allButtons);
  } catch (err) {
    console.error("[Telegram] P&L error:", err);
    if (activeOpId !== myOpId) return;
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

async function handleInsiders(ctx: Context, tab: "holding" | "wallets" = "wallets"): Promise<void> {
  if (!isAuthorized(ctx)) {
    console.warn(`[Telegram] Unauthorized /insiders from user ${ctx.from?.id}`);
    return;
  }

  const myOpId = activeOpId;

  try {
    if (bot && chatId) {
      for (const id of insiderExtraMessageIds) {
        await bot.api.deleteMessage(chatId, id).catch(() => {});
      }
      insiderExtraMessageIds.length = 0;
    }

    const chainButtons = [
      [
        { text: tab === "wallets" ? "* Wallets" : "Wallets", callback_data: "insiders_wallets" },
        { text: tab === "holding" ? "* Holding" : "Holding", callback_data: "insiders_holding" },
      ],
    ];

    if (tab === "holding") {
      try { await refreshCopyTradePrices(); } catch { /* non-fatal */ }
      if (activeOpId !== myOpId) return;
      const trades = getOpenCopyTrades();

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
      if (activeOpId !== myOpId) return;
      const { getInsiderWalletsWithStats } = await import("../traders/storage.js");
      const walletStats = getInsiderWalletsWithStats();

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
    if (activeOpId !== myOpId) return;
    const errorButtons = [
      [
        { text: tab === "wallets" ? "* Wallets" : "Wallets", callback_data: "insiders_wallets" },
        { text: tab === "holding" ? "* Holding" : "Holding", callback_data: "insiders_holding" },
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

  const myOpId = activeOpId;

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

      if (activeOpId !== myOpId) return;

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
      if (activeOpId !== myOpId) return;
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
    if (activeOpId !== myOpId) return;
    await sendDataMessage(message, allButtons);
  } catch (err) {
    console.error("[Telegram] Bets error:", err);
    if (activeOpId !== myOpId) return;
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

  const tradingMode = getTradingMode();
  if (tradingMode === "live") {
    const backButton = [[{ text: "Back", callback_data: "main_menu" }]];
    await sendDataMessage("Reset is not available in full live mode.", backButton);
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
  const quantTradeCount = (db.prepare("SELECT COUNT(*) as cnt FROM quant_trades WHERE mode != 'live'").get() as { cnt: number }).cnt;
  const quantPosCount = (db.prepare("SELECT COUNT(*) as cnt FROM quant_positions WHERE mode != 'live'").get() as { cnt: number }).cnt;

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

    // 14. Quant trades + positions - only paper, preserve live
    const quantTradesResult = db.prepare("DELETE FROM quant_trades WHERE mode != 'live'").run();
    const quantPosResult = db.prepare("DELETE FROM quant_positions WHERE mode != 'live'").run();
    const quantConfigResult = db.prepare("DELETE FROM quant_config").run();

    // 16. Clear all in-memory caches
    const { clearWatcherMemory } = await import("../traders/watcher.js");
    const { clearCopyPriceFailures } = await import("../traders/gem-analyzer.js");
    const { clearPaperMemory, resetDailyDrawdown } = await import("../hyperliquid/index.js");
    clearWatcherMemory();
    clearCopyPriceFailures();
    clearPaperMemory();
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

  const myOpId = activeOpId;
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

  const openPositions = getOpenQuantPositions();
  const tradingMode = getTradingMode();
  const mode = tradingMode === "paper" ? "PAPER" : tradingMode === "hybrid" ? "HYBRID" : "LIVE";

  const killed = isQuantKilled();
  const liveLoss = getDailyLossTotal(undefined, "live");
  const paperLoss = getDailyLossTotal(undefined, "paper");
  // Stats fetched per engine inline below

  const pnl = (n: number): string => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
  const $ = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

  let text = `<b>Quant</b> | ${mode} | Kill: ${killed ? "HALTED" : "OFF"}\n`;
  text += `${openPositions.length} open | Live ${$(liveLoss)} Paper ${$(paperLoss)} / $${QUANT_DAILY_DRAWDOWN_LIMIT} daily loss\n`;

  let mids: Record<string, string> = {};
  let lighterMids: Record<string, string> = {};
  // Exchange unrealized P&L
  let hlExchangeUpnl: Record<string, number> = {};
  let ltExchangeUpnl: Record<string, number> = {};
  if (openPositions.length > 0) {
    try {
      const sdk = getClient();
      mids = (await sdk.info.getAllMids(true)) as Record<string, string>;
      const env = (await import("../../config/env.js")).loadEnv();
      const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
      if (wallet) {
        const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
        for (const ap of state.assetPositions) {
          if (parseFloat(ap.position.szi) !== 0) {
            hlExchangeUpnl[ap.position.coin] = parseFloat(ap.position.unrealizedPnl ?? "0");
          }
        }
      }
    } catch {
      // Prices unavailable
    }

    // Lighter unrealized + prices
    const lighterPositions = openPositions.filter(p => p.exchange === "lighter");
    if (lighterPositions.length > 0) {
      try {
        const { getLighterAllMids, isLighterInitialized, getLighterUnrealizedPnl } = await import("../lighter/client.js");
        if (isLighterInitialized()) {
          ltExchangeUpnl = await getLighterUnrealizedPnl();
          const paperPairs = [...new Set(lighterPositions.filter(p => p.mode !== "live").map(p => p.pair))];
          if (paperPairs.length > 0) {
            lighterMids = await getLighterAllMids(paperPairs);
          }
        }
      } catch { /* Lighter unavailable */ }
    }
  }

  if (activeOpId !== myOpId) return;

  // Proportional exchange unrealized split
  const livePairSize = new Map<string, number>();
  for (const pos of openPositions) {
    if (pos.mode === "live") {
      const k = `${pos.exchange ?? "hl"}:${pos.pair}`;
      livePairSize.set(k, (livePairSize.get(k) ?? 0) + pos.size);
    }
  }
  const getExchangeUpnl = (pos: typeof openPositions[0]): number | undefined => {
    if (pos.mode !== "live") return undefined;
    const k = `${pos.exchange ?? "hl"}:${pos.pair}`;
    const exVal = pos.exchange === "lighter" ? ltExchangeUpnl[pos.pair] : hlExchangeUpnl[pos.pair];
    if (exVal === undefined) return undefined;
    const totalSize = livePairSize.get(k) ?? 0;
    if (totalSize === 0) return undefined;
    return exVal * (pos.size / totalSize);
  };

  const formatPosLine = (pos: typeof openPositions[0]): string => {
    const dir = pos.direction === "long" ? "L" : "S";
    const typeTag =
      pos.tradeType === "psar-directional" ? "[PS]" :
      pos.tradeType === "zlema-directional" ? "[ZL]" :
      pos.tradeType === "vortex-directional" ? "[VO]" :
      pos.tradeType === "schaff-directional" ? "[SC]" :
      pos.tradeType === "dema-directional" ? "[DE]" :
      pos.tradeType === "cci-directional" ? "[CC]" :
      pos.tradeType === "aroon-directional" ? "[AR]" :
      pos.tradeType === "macd-directional" ? "[MA]" :
      pos.tradeType === "zlemav2-directional" ? "[Z2]" :
      pos.tradeType === "schaffv2-directional" ? "[S2]" :
      pos.tradeType === "inv-psar-directional" ? "[iPS]" :
      pos.tradeType === "inv-zlema-directional" ? "[iZL]" :
      pos.tradeType === "inv-vortex-directional" ? "[iVO]" :
      pos.tradeType === "inv-schaff-directional" ? "[iSC]" :
      pos.tradeType === "inv-dema-directional" ? "[iDE]" :
      pos.tradeType === "inv-cci-directional" ? "[iCC]" :
      pos.tradeType === "inv-aroon-directional" ? "[iAR]" :
      pos.tradeType === "inv-macd-directional" ? "[iMA]" :
      pos.tradeType === "inv-zlemav2-directional" ? "[iZ2]" :
      pos.tradeType === "inv-schaffv2-directional" ? "[iS2]" :
      pos.tradeType === "hft-fade" ? "[HFT]" :
      pos.tradeType === "hft-fade-b" ? "[HFT-B]" :
      pos.tradeType === "hft-fade-c" ? "[HFT-C]" :
      pos.tradeType === "hft-fade-d" ? "[HFT-D]" :
      pos.tradeType === "hft-fade-e" ? "[HFT-E]" :
      pos.tradeType === "hft-fade-f" ? "[HFT-F]" :
      "[AI]";
    const exchTag = pos.exchange === "lighter" ? "/LT" : "";
    let upnlStr = "";
    const exchangeUpnl = getExchangeUpnl(pos);
    if (exchangeUpnl !== undefined) {
      upnlStr = ` ${pnl(exchangeUpnl)}`;
    } else {
      const priceSource = pos.exchange === "lighter" ? lighterMids : mids;
      const rawMid = priceSource[pos.pair];
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
    }
    return `${typeTag}${exchTag} ${dir} ${pos.pair} ${$(pos.size)} @${pos.entryPrice.toFixed(2)} ${pos.leverage}x${upnlStr}`;
  };

  if (openPositions.length > 0) {
    const isHybridOrLive = tradingMode === "hybrid" || tradingMode === "live";
    const livePositions = openPositions.filter(p => p.mode === "live");
    const paperPositions = openPositions.filter(p => p.mode !== "live" && !p.tradeType?.startsWith("inv-") && !p.tradeType?.startsWith("hft-"));
    const hftPositions = openPositions.filter(p => p.mode !== "live" && p.tradeType?.startsWith("hft-"));
    const invertedPositions = openPositions.filter(p => p.mode !== "live" && p.tradeType?.startsWith("inv-"));

    if (paperPositions.length > 0) {
      if (isHybridOrLive) {
        text += `\n<b>Paper (${paperPositions.length})</b>\n`;
      } else {
        text += `\n`;
      }
      text += paperPositions.map(formatPosLine).join("\n") + "\n";
    }

    if (invertedPositions.length > 0) {
      text += `\n<b>Inverted (${invertedPositions.length})</b>\n`;
      text += invertedPositions.map(formatPosLine).join("\n") + "\n";
    }

    if (hftPositions.length > 0) {
      text += `\n<b>HFT (${hftPositions.length} open — see stats below)</b>\n`;
    }

    if (isHybridOrLive && livePositions.length > 0) {
      const liveHL = livePositions.filter(p => p.exchange !== "lighter");
      const liveLT = livePositions.filter(p => p.exchange === "lighter");
      if (liveHL.length > 0) {
        text += `\n<b>LIVE HL (${liveHL.length})</b>\n`;
        text += liveHL.map(formatPosLine).join("\n") + "\n";
      }
      if (liveLT.length > 0) {
        text += `\n<b>LIVE LT (${liveLT.length})</b>\n`;
        text += liveLT.map(formatPosLine).join("\n") + "\n";
      }
    }
  }

  // Aggregate stats per strategy+mode
  const makeKey = (type: string, mode: string) => `${type}:${mode}`;
  const unrealizedByKey = new Map<string, number>();
  const openCountByKey = new Map<string, number>();
  const deployedByKey = new Map<string, number>();
  for (const pos of openPositions) {
    const type = pos.tradeType ?? "directional";
    const m = pos.mode === "live" ? "live" : "paper";
    const key = makeKey(type, m);
    openCountByKey.set(key, (openCountByKey.get(key) ?? 0) + 1);
    deployedByKey.set(key, (deployedByKey.get(key) ?? 0) + pos.size);
    let upnl: number | undefined;
    const exUpnl = getExchangeUpnl(pos);
    if (exUpnl !== undefined) upnl = exUpnl;
    if (upnl === undefined) {
      const priceSource = pos.exchange === "lighter" ? lighterMids : mids;
      const rawMid = priceSource[pos.pair];
      if (!rawMid) continue;
      const currentPrice = parseFloat(rawMid);
      if (isNaN(currentPrice)) continue;
      upnl = pos.direction === "long"
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * pos.size * pos.leverage
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * pos.size * pos.leverage;
    }
    unrealizedByKey.set(key, (unrealizedByKey.get(key) ?? 0) + upnl);
  }

  const fmtSign = (v: number, dp: number): string => {
    const abs = Math.abs(v);
    const str = abs.toFixed(dp);
    if (parseFloat(str) === 0) return `$${str}`;
    return `${v > 0 ? "+" : "-"}$${str}`;
  };
  const fmtUnr = (v: number): string => fmtSign(v, 2);

  const sl = (label: string, s: { totalPnl: number; totalTrades: number; winRate: number }, typeKey: string, mode: string): string => {
    const ret = fmtSign(s.totalPnl, 1);
    const wr = s.totalTrades > 0 ? ` ${s.winRate.toFixed(0)}%w` : "";
    const k = makeKey(typeKey, mode);
    const openCnt = openCountByKey.get(k) ?? 0;
    const ops = s.totalTrades + openCnt;
    if (ops === 0) return "";
    const deployed = deployedByKey.get(k) ?? 0;
    const deployedStr = deployed > 0 ? ` ($${deployed.toFixed(0)})` : "";
    const unr = unrealizedByKey.get(k) ?? 0;
    const unrStr = ` | unr ${fmtUnr(unr)}`;
    return `${label}: ${ret}${wr} ${openCnt}/${ops}T${deployedStr}${unrStr}\n`;
  };

  const engines: [string, string][] = [
    ["AI", "ai-directional"],
    ["PSAR", "psar-directional"], ["ZLEMA", "zlema-directional"],
    ["Vortex", "vortex-directional"], ["Schaff", "schaff-directional"],
    ["DEMA", "dema-directional"], ["CCI", "cci-directional"],
    ["Aroon", "aroon-directional"], ["MACD", "macd-directional"],
    ["ZLEMAv2", "zlemav2-directional"], ["SchaffV2", "schaffv2-directional"],
    ["HFT", "hft-fade"],
    ["HFT-B", "hft-fade-b"],
    ["HFT-C", "hft-fade-c"],
    ["HFT-D", "hft-fade-d"],
    ["HFT-E", "hft-fade-e"],
    ["HFT-F", "hft-fade-f"],
  ];
  const invertedEngines: [string, string][] = [
    ["iPSAR", "inv-psar-directional"], ["iZLEMA", "inv-zlema-directional"],
    ["iVortex", "inv-vortex-directional"], ["iSchaff", "inv-schaff-directional"],
    ["iDEMA", "inv-dema-directional"], ["iCCI", "inv-cci-directional"],
    ["iAroon", "inv-aroon-directional"], ["iMACD", "inv-macd-directional"],
    ["iZLEMAv2", "inv-zlemav2-directional"], ["iSchaffV2", "inv-schaffv2-directional"],
  ];

  const hasLive = openPositions.some(p => p.mode === "live");
  const hasPaper = openPositions.some(p => p.mode !== "live");
  const isHybrid = tradingMode === "hybrid" || (hasLive && hasPaper);

  const renderEngineBlock = (list: [string, string][], mode: "live" | "paper") => {
    let block = "", pnlTotal = 0, trades = 0, unrTotal = 0, depTotal = 0, openTotal = 0;
    for (const [label, typeKey] of list) {
      const stats = getQuantStats(typeKey, mode);
      block += sl(label, stats, typeKey, mode);
      pnlTotal += stats.totalPnl;
      trades += stats.totalTrades;
      const k = makeKey(typeKey, mode);
      unrTotal += unrealizedByKey.get(k) ?? 0;
      depTotal += deployedByKey.get(k) ?? 0;
      openTotal += openCountByKey.get(k) ?? 0;
    }
    return { block, pnlTotal, trades, unrTotal, depTotal, openTotal };
  };

  if (isHybrid) {
    // Live engines (AI + any live technical + any live inverted)
    let liveBlock = "", livePnlTotal = 0, liveTrades = 0, liveUnrTotal = 0, liveDepTotal = 0, liveOpenTotal = 0;
    for (const [label, typeKey] of [...engines, ...invertedEngines]) {
      const isLiveEngine = typeKey === "ai-directional" || QUANT_HYBRID_LIVE_ENGINES.has(typeKey);
      if (!isLiveEngine) continue;
      const stats = getQuantStats(typeKey, "live");
      liveBlock += sl(label, stats, typeKey, "live");
      livePnlTotal += stats.totalPnl;
      liveTrades += stats.totalTrades;
      const lk = makeKey(typeKey, "live");
      liveUnrTotal += unrealizedByKey.get(lk) ?? 0;
      liveDepTotal += deployedByKey.get(lk) ?? 0;
      liveOpenTotal += openCountByKey.get(lk) ?? 0;
    }

    // Paper normal engines (exclude AI and HFT which get own blocks)
    const paper = renderEngineBlock(engines.filter(([, t]) => t !== "ai-directional" && !t.startsWith("hft-") && !QUANT_HYBRID_LIVE_ENGINES.has(t)), "paper");
    // Paper inverted engines
    const inverted = renderEngineBlock(invertedEngines, "paper");
    // HFT separate block (all hft-* variants)
    const hft = renderEngineBlock(engines.filter(([, t]) => t.startsWith("hft-")), "paper");

    if (liveBlock) {
      text += `\n<b>-- Live --</b>\n`;
      text += liveBlock;
      const dep = liveDepTotal > 0 ? ` | $${liveDepTotal.toFixed(0)}` : "";
      text += `Total: ${fmtSign(livePnlTotal, 1)} ${liveTrades + liveOpenTotal}T${dep} | unr ${fmtUnr(liveUnrTotal)}\n`;
    }
    if (paper.block) {
      text += `\n<b>-- Paper --</b>\n`;
      text += paper.block;
      const dep = paper.depTotal > 0 ? ` | $${paper.depTotal.toFixed(0)}` : "";
      text += `Total: ${fmtSign(paper.pnlTotal, 1)} ${paper.trades + paper.openTotal}T${dep} | unr ${fmtUnr(paper.unrTotal)}\n`;
    }
    if (inverted.block) {
      text += `\n<b>-- Inverted --</b>\n`;
      text += inverted.block;
      const dep = inverted.depTotal > 0 ? ` | $${inverted.depTotal.toFixed(0)}` : "";
      text += `Total: ${fmtSign(inverted.pnlTotal, 1)} ${inverted.trades + inverted.openTotal}T${dep} | unr ${fmtUnr(inverted.unrTotal)}\n`;
    }
    if (hft.openTotal > 0 || hft.trades > 0) {
      text += `\n<b>-- HFT --</b>\n`;
      text += hft.block || `HFT: $0.0 ${hft.openTotal}/${hft.trades + hft.openTotal}T | unr ${fmtUnr(hft.unrTotal)}\n`;
    }
  } else {
    text += `\n`;
    const allEngines = [...engines, ...invertedEngines];
    for (const [label, typeKey] of allEngines) {
      const stats = getQuantStats(typeKey);
      text += sl(label, stats, typeKey, tradingMode === "paper" ? "paper" : "live");
    }
    const totalPnl = allEngines.reduce((s, [, t]) => s + getQuantStats(t).totalPnl, 0);
    let totalUnr = 0, totalDeployed = 0;
    for (const v of unrealizedByKey.values()) totalUnr += v;
    for (const v of deployedByKey.values()) totalDeployed += v;
    const totalOps = allEngines.reduce((s, [, t]) => s + getQuantStats(t).totalTrades, 0) + openPositions.length;
    const deployedTotal = totalDeployed > 0 ? ` | $${totalDeployed.toFixed(0)}` : "";
    text += `\nTotal: ${fmtSign(totalPnl, 1)} ${totalOps}T${deployedTotal} | unr ${fmtUnr(totalUnr)}\n`;
  }

  const buttons: { text: string; callback_data: string }[][] = [];
  buttons.push([{ text: "Back", callback_data: "main_menu" }]);

  if (activeOpId !== myOpId) return;
  await sendDataMessage(text, buttons);
}
