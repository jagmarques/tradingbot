import { Bot, Context } from "grammy";
import { readFileSync, writeFileSync } from "fs";
import { loadEnv, isPaperMode, setTradingMode, getTradingMode } from "../../config/env.js";
import { STARTING_CAPITAL_USD, CAPITAL_PER_STRATEGY_USD, QUANT_DAILY_DRAWDOWN_LIMIT, QUANT_PAPER_VALIDATION_DAYS, QUANT_HYBRID_LIVE_ENGINES } from "../../config/constants.js";
import {
  getRiskStatus,
  getDailyPnl,
  getDailyPnlPercentage,
  getTodayTrades,
  activateKillSwitch,
  deactivateKillSwitch,
} from "../risk/manager.js";
import { getUserTimezone, setUserTimezone } from "../database/timezones.js";
import { getSettings } from "../settings/settings.js";
import { callLLM } from "../shared/llm.js";
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
    { text: "⚛️ Quant", callback_data: "quant" },
  ],
  [
    { text: "🕵 Insiders", callback_data: "insiders" },
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
  bot.command("stop", handleStop);
  bot.command("resume", handleResume);
  bot.command("mode", handleMode);
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
  bot.callbackQuery("manage_stop", async (ctx) => {
    try {
      await handleStop(ctx);
      await ctx.answerCallbackQuery("Kill switch activated");
    } catch (err) {
      console.error("[Telegram] Callback error (manage_stop):", err);
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery("manage_resume", async (ctx) => {
    try {
      await handleResume(ctx);
      await ctx.answerCallbackQuery("Trading resumed");
    } catch (err) {
      console.error("[Telegram] Callback error (manage_resume):", err);
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
  bot.callbackQuery(/^mode_/, async (ctx) => {
    if (!isAuthorized(ctx)) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    try {
      const mode = ctx.callbackQuery.data.replace("mode_", "") as "paper" | "hybrid" | "live";
      setTradingMode(mode);
      await handleMode(ctx);
      await ctx.answerCallbackQuery(`Mode: ${mode}`);
    } catch (err) {
      console.error("[Telegram] Callback error (mode):", err);
      await ctx.answerCallbackQuery().catch(() => {});
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

let firstMenuSent = false;

export async function sendMainMenu(): Promise<void> {
  if (!bot || !chatId) {
    console.warn("[Telegram] Bot not initialized, cannot send menu");
    return;
  }

  try {
    // On first call after deploy, clear all recent bot messages
    if (!firstMenuSent) {
      firstMenuSent = true;
      if (lastMenuMessageId) {
        // Delete from old menu to ~200 messages ahead (covers all bot messages since last deploy)
        const deletePromises = [];
        for (let i = lastMenuMessageId; i <= lastMenuMessageId + 200; i++) {
          deletePromises.push(bot.api.deleteMessage(chatId, i).catch(() => {}));
        }
        await Promise.all(deletePromises);
        lastMenuMessageId = null;
      }
    }

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
        firstMenuSent = true;
        return;
      } catch (editErr) {
        if (editErr instanceof Error && editErr.message.includes("message is not modified")) {
          firstMenuSent = true;
          return;
        }
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
    firstMenuSent = true;
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
    const env = loadEnv();

    const hlAccount = env.HYPERLIQUID_WALLET_ADDRESS
      ? await getAccountBalance(env.HYPERLIQUID_WALLET_ADDRESS).catch(() => ({ equity: 0, balance: 0, unrealizedPnl: 0 }))
      : { equity: 0, balance: 0, unrealizedPnl: 0 };

    if (activeOpId !== myOpId) return;

    const msg = `<b>Portfolio</b>\nHL: ${fmt(hlAccount.equity)}\n<b>Total: ${fmt(hlAccount.equity)}</b>`;
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
        // Exchange unrealized P&L
        const hlExUpnl: Record<string, number> = {};
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
            const exVal = hlExUpnl[pos.pair];
            const totalSize = livePairSize.get(k) ?? 0;
            if (exVal !== undefined && totalSize > 0) {
              posUnr = exVal * (pos.size / totalSize);
            }
          } else {
            // Paper: mid-price calc (no exchange data)
            const rawMid = mids[pos.pair];
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
          }
        }
      } catch { /* prices unavailable */ }
    }

    const totalUnrealized = insiderUnrealized + quantUnrealized;

    // Total (realized + unrealized)
    const data = getPnlForPeriod(null);
    const realizedNonRug = data.totalPnl - data.rugPnl;
    const breakdownStr = formatBreakdown(
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

    // Unrealized (open positions) - grouped by platform
    message += `\n-------------------\n`;
    message += `<b>Unrealized</b> ${pnl(totalUnrealized)}\n`;

    const insiderInvested = openInsider.reduce((sum, t) => sum + t.amountUsd, 0);
    message += `<b>Insider</b> ${openInsider.length}${insiderInvested > 0 ? ` ($${insiderInvested.toFixed(0)})` : ""}${openInsider.length > 0 ? ` ${pnl(insiderUnrealized)}` : ""}\n`;

    const quantKillStr = isQuantKilled() ? " HALTED" : "";
    const quantInvested = quantPositions.reduce((sum, p) => sum + p.size, 0);
    message += `<b>Quant</b> ${quantPositions.length}${quantInvested > 0 ? ` ($${quantInvested.toFixed(0)})` : ""}${quantPositions.length > 0 ? ` ${pnl(quantUnrealized)}` : ""}${quantKillStr}`;

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
  quantPnl: number,
  insiderCopyPnl: number,
): string {
  const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;

  const sources = [
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
    const pnl = (n: number): string => `${n > 0 ? "+" : ""}$${n.toFixed(2)}`;
    const $ = (n: number): string => n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

    let message = `<b>Trades</b>\n\n`;

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
        for (const t of closedCopyTrades) {
          const pnlUsd = (t.pnlPct / 100) * t.amountUsd;
          const chainTag = t.chain.toUpperCase().slice(0, 3);
          message += `${t.tokenSymbol} | ${chainTag} | ${pnl(pnlUsd)} ${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(0)}%\n`;
        }
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
    } else if (openCopyTrades.length === 0 && closedCopyTrades.length === 0) {
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

async function handleStop(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;
  activateKillSwitch();
  const { setQuantKilled } = await import("../hyperliquid/risk-manager.js");
  setQuantKilled(true);
  await sendDataMessage("<b>KILL SWITCH ACTIVATED</b>\nAll trading stopped. Use /resume to restart.");
}

async function handleResume(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;
  deactivateKillSwitch();
  const { setQuantKilled } = await import("../hyperliquid/risk-manager.js");
  setQuantKilled(false);
  await sendDataMessage("<b>Trading resumed</b>\nAll engines restarted.");
}

async function handleMode(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;
  const currentMode = getTradingMode();
  const buttons = [
    [
      { text: currentMode === "paper" ? "* Paper" : "Paper", callback_data: "mode_paper" },
      { text: currentMode === "hybrid" ? "* Hybrid" : "Hybrid", callback_data: "mode_hybrid" },
      { text: currentMode === "live" ? "* Live" : "Live", callback_data: "mode_live" },
    ],
    [{ text: "Back", callback_data: "main_menu" }],
  ];
  await sendDataMessage(`<b>Trading Mode:</b> ${currentMode.toUpperCase()}`, buttons);
}

async function handleManage(ctx: Context): Promise<void> {
  if (!isAuthorized(ctx)) return;

  try {
    const status = await getRiskStatus();
    let message = `<b>Manage</b>\n\n`;
    message += `Kill switch: ${status.killSwitchActive ? "ACTIVE" : "Off"}\n`;
    message += `Mode: ${getTradingMode().toUpperCase()}\n\n`;
    message += `Choose an action:`;

    const buttons = [
      [
        { text: "Stop All", callback_data: "manage_stop" },
        { text: "Resume", callback_data: "manage_resume" },
      ],
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
      "- /ai what's my total PnL?\n" +
      "- /ai how are quant positions doing?\n" +
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
    const riskStatus = await getRiskStatus();
    const dailyPnl = getDailyPnl();
    const dailyPnlPct = getDailyPnlPercentage();
    const todayTrades = getTodayTrades();
    const userId = ctx.from?.id?.toString() || "";
    const settings = getSettings(userId);

    // Build comprehensive context for AI
    const context = `
You are a helpful trading bot assistant. Answer questions about ANY bot data below.

=== RISK & STATUS ===
- Kill switch: ${riskStatus.killSwitchActive ? "ACTIVE" : "Off"}
- Trading enabled: ${riskStatus.tradingEnabled}
- Paper mode: ${riskStatus.isPaperMode}
- Daily PnL: $${dailyPnl.toFixed(2)} (${dailyPnlPct > 0 ? "+" : ""}${dailyPnlPct.toFixed(1)}%)

=== USER SETTINGS ===
- Auto-copy (wallets): ${settings.autoCopyEnabled ? "ON" : "OFF"}
- Min trader score: ${settings.minTraderScore}
- Max copies/day: ${settings.maxCopyPerDay}
- Today's copies: ${settings.dailyCopyCount}

=== TODAY'S TRADES ===
- Count: ${todayTrades.length}
- Wins: ${todayTrades.filter(t => t.pnl > 0).length}
- Losses: ${todayTrades.filter(t => t.pnl < 0).length}

IMPORTANT: Respond in plain text only. NO JSON, NO code blocks, NO markdown formatting. Just natural language sentences.
Be concise. Answer based on the data above. If asked about something not in the data, say so.`;

    const response = await callLLM(
      `${context}\n\nUSER QUESTION: ${question}`,
      undefined,
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
  const db = (await import("../database/db.js")).getDb();
  const insiderWalletCount = (() => { try { return (db.prepare("SELECT COUNT(*) as cnt FROM insider_wallets").get() as { cnt: number }).cnt; } catch { return 0; } })();
  const insiderCopyCount = (() => { try { return (db.prepare("SELECT COUNT(*) as cnt FROM insider_copy_trades").get() as { cnt: number }).cnt; } catch { return 0; } })();
  const quantTradeCount = (db.prepare("SELECT COUNT(*) as cnt FROM quant_trades WHERE mode != 'live'").get() as { cnt: number }).cnt;
  const quantPosCount = (db.prepare("SELECT COUNT(*) as cnt FROM quant_positions WHERE mode != 'live'").get() as { cnt: number }).cnt;

  let message = "<b>RESET - Paper Trading Data</b>\n\n";
  message += "This will permanently delete:\n\n";
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

    // 1. Insider copy trades - delete all (scoring rebuilds from new trades)
    const insiderCopyResult = (() => { try { return db.prepare("DELETE FROM insider_copy_trades").run(); } catch { return { changes: 0 }; } })();

    // 2. General trades table
    const tradesResult = db.prepare("DELETE FROM trades").run();

    // 3. General positions table
    const positionsResult = db.prepare("DELETE FROM positions").run();

    // 4. Daily stats
    const dailyResult = db.prepare("DELETE FROM daily_stats").run();

    // 5. Quant trades + positions - only paper, preserve live
    const quantTradesResult = db.prepare("DELETE FROM quant_trades WHERE mode != 'live'").run();
    const quantPosResult = db.prepare("DELETE FROM quant_positions WHERE mode != 'live'").run();
    const quantConfigResult = db.prepare("DELETE FROM quant_config").run();

    // 9. Clear all in-memory caches
    const { clearWatcherMemory } = await import("../traders/watcher.js");
    const { clearCopyPriceFailures } = await import("../traders/gem-analyzer.js");
    const { clearPaperMemory, resetDailyDrawdown } = await import("../hyperliquid/index.js");
    clearWatcherMemory();
    clearCopyPriceFailures();
    clearPaperMemory();
    resetDailyDrawdown();

    const totalDeleted = insiderCopyResult.changes
      + tradesResult.changes + positionsResult.changes + dailyResult.changes
      + quantTradesResult.changes + quantPosResult.changes + quantConfigResult.changes;

    console.log(`[ResetPaper] Paper trading data wiped: ${totalDeleted} total records`);

    let message = "<b>Reset Complete</b>\n\n";
    message += `Insider copies: ${insiderCopyResult.changes} trades reset\n`;
    message += `Quant: ${quantTradesResult.changes} trades + ${quantPosResult.changes} positions\n`;
    message += `Other: ${tradesResult.changes + positionsResult.changes + dailyResult.changes} records\n\n`;
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
  const engineStatus = [...QUANT_HYBRID_LIVE_ENGINES].map(e => {
    const label = e === "donchian-trend" ? "Donchian" : e === "supertrend-4h" ? "Supertrend" : e === "garch-v2" ? "GARCH-v2" : e;
    return `${label}: LIVE`;
  }).join(" | ");
  text += `${engineStatus}\n`;

  let mids: Record<string, string> = {};
  // Exchange unrealized P&L
  const hlExchangeUpnl: Record<string, number> = {};
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
    const exVal = hlExchangeUpnl[pos.pair];
    if (exVal === undefined) return undefined;
    const totalSize = livePairSize.get(k) ?? 0;
    if (totalSize === 0) return undefined;
    return exVal * (pos.size / totalSize);
  };

  const formatPosLine = (pos: typeof openPositions[0]): string => {
    const dir = pos.direction === "long" ? "L" : "S";
    const typeTag =
      pos.tradeType === "donchian-trend" ? "[DT]" :
      pos.tradeType === "supertrend-4h" ? "[ST]" :
      pos.tradeType === "garch-v2" ? "[GV]" :
      pos.tradeType === "carry-momentum" ? "[CM]" :
      pos.tradeType === "trump-event" ? "[TE]" :
      "[??]";
    const exchTag = pos.exchange === "hyperliquid" ? "/HL" : "";
    let upnlStr = "";
    const exchangeUpnl = getExchangeUpnl(pos);
    if (exchangeUpnl !== undefined) {
      upnlStr = ` ${pnl(exchangeUpnl)}`;
    } else {
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
    }
    return `${typeTag}${exchTag} ${dir} ${pos.pair} ${$(pos.size)} @${pos.entryPrice.toFixed(2)} ${pos.leverage}x${upnlStr}`;
  };

  if (openPositions.length > 0) {
    const isHybridOrLive = tradingMode === "hybrid" || tradingMode === "live";
    const livePositions = openPositions.filter(p => p.mode === "live");
    const paperPositions = openPositions.filter(p => p.mode !== "live");

    if (paperPositions.length > 0) {
      if (isHybridOrLive) {
        text += `\n<b>Paper (${paperPositions.length})</b>\n`;
      } else {
        text += `\n`;
      }
      text += paperPositions.map(formatPosLine).join("\n") + "\n";
    }

    if (isHybridOrLive && livePositions.length > 0) {
      text += `\n<b>LIVE HL (${livePositions.length})</b>\n`;
      text += livePositions.map(formatPosLine).join("\n") + "\n";
    }
  }

  // Aggregate stats per strategy+mode
  const makeKey = (type: string, mode: string): string => `${type}:${mode}`;
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
      const rawMid = mids[pos.pair];
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
    ["GV", "garch-v2"],
  ];

  const hasLive = openPositions.some(p => p.mode === "live");
  const hasPaper = openPositions.some(p => p.mode !== "live");
  const isHybrid = tradingMode === "hybrid" || (hasLive && hasPaper);

  const renderEngineBlock = (list: [string, string][], mode: "live" | "paper"): { block: string; pnlTotal: number; trades: number; unrTotal: number; depTotal: number; openTotal: number } => {
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
    // Live engines (AI + any live technical)
    let liveBlock = "", livePnlTotal = 0, liveTrades = 0, liveUnrTotal = 0, liveDepTotal = 0, liveOpenTotal = 0;
    for (const [label, typeKey] of engines) {
      const isLiveEngine = QUANT_HYBRID_LIVE_ENGINES.has(typeKey);
      const hasOpenPos = (openCountByKey.get(makeKey(typeKey, "live")) ?? 0) > 0;
      const hasHistory = getQuantStats(typeKey, "live").totalTrades > 0;
      if (!isLiveEngine && !hasOpenPos && !hasHistory) continue;
      const stats = getQuantStats(typeKey, "live");
      liveBlock += sl(label, stats, typeKey, "live");
      livePnlTotal += stats.totalPnl;
      liveTrades += stats.totalTrades;
      const lk = makeKey(typeKey, "live");
      liveUnrTotal += unrealizedByKey.get(lk) ?? 0;
      liveDepTotal += deployedByKey.get(lk) ?? 0;
      liveOpenTotal += openCountByKey.get(lk) ?? 0;
    }

    const paper = renderEngineBlock(engines.filter(([, t]) => !QUANT_HYBRID_LIVE_ENGINES.has(t)), "paper");

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
  } else {
    text += `\n`;
    const allEngines = engines;
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
