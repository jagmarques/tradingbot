import { sendMessage, sendStatusMessage } from "./bot.js";
import { getDailyPnl, getDailyPnlPercentage, getTodayTrades, type Trade, getRiskStatus } from "../risk/manager.js";
import { isPaperMode, loadEnv } from "../../config/env.js";
import { getUserTimezone } from "../database/timezones.js";

let statusReporterInterval: NodeJS.Timeout | null = null;

// Format date with user's timezone
function formatDate(date: Date = new Date(), userId?: string): string {
  // Try user-specific timezone first, fall back to env default
  let timezone = loadEnv().TIMEZONE;
  if (userId) {
    const userTz = getUserTimezone(userId);
    if (userTz) {
      timezone = userTz;
    }
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(date);
  } catch {
    // Fallback if timezone is invalid
    return date.toLocaleString();
  }
}

// Trade alert
export async function notifyTrade(trade: Omit<Trade, "id" | "timestamp">): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "";
  const emoji = trade.pnl >= 0 ? "🟢" : "🔴";
  const strategyEmoji = trade.strategy === "pumpfun" ? "🚀" : "📊";

  const message =
    `${mode}${strategyEmoji} <b>${trade.type} ${trade.strategy.toUpperCase()}</b>\n\n` +
    `Amount: $${trade.amount.toFixed(2)}\n` +
    `Price: ${trade.price.toFixed(8)}\n` +
    `${emoji} P&L: $${trade.pnl.toFixed(2)}`;

  await sendMessage(message);
}

// Buy executed alert
export async function notifyBuy(params: {
  strategy: "pumpfun" | "polymarket";
  symbol?: string;
  amount: number;
  price: number;
  txHash?: string;
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "";
  const emoji = params.strategy === "pumpfun" ? "🚀" : "📊";

  let message =
    `${mode}${emoji} <b>BUY ${params.strategy.toUpperCase()}</b>\n\n` +
    (params.symbol ? `Token: ${params.symbol}\n` : "") +
    `Amount: $${params.amount.toFixed(2)}\n` +
    `Price: ${params.price.toFixed(8)}`;

  if (params.txHash) {
    message += `\n\n<a href="https://solscan.io/tx/${params.txHash}">View TX</a>`;
  }

  await sendMessage(message);
}

// Sell executed alert
export async function notifySell(params: {
  strategy: "pumpfun" | "polymarket";
  symbol?: string;
  amount: number;
  price: number;
  pnl: number;
  pnlPercentage: number;
  reason?: string;
  txHash?: string;
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "";
  const emoji = params.pnl >= 0 ? "🟢" : "🔴";

  let message =
    `${mode}${emoji} <b>SELL ${params.strategy.toUpperCase()}</b>\n\n` +
    (params.symbol ? `Token: ${params.symbol}\n` : "") +
    `Amount: $${params.amount.toFixed(2)}\n` +
    `Price: ${params.price.toFixed(8)}\n` +
    `P&L: $${params.pnl.toFixed(2)} (${params.pnlPercentage >= 0 ? "+" : ""}${params.pnlPercentage.toFixed(1)}%)` +
    (params.reason ? `\nReason: ${params.reason}` : "");

  if (params.txHash) {
    const explorer =
      params.strategy === "pumpfun"
        ? `https://solscan.io/tx/${params.txHash}`
        : `https://polygonscan.com/tx/${params.txHash}`;
    message += `\n\n<a href="${explorer}">View TX</a>`;
  }

  await sendMessage(message);
}

// Error alert
export async function notifyError(error: string, context?: string): Promise<void> {
  const message =
    `⚠️ <b>ERROR</b>\n\n` + (context ? `Context: ${context}\n\n` : "") + `<code>${escapeHtml(error)}</code>`;

  await sendMessage(message);
}

// Critical error alert
export async function notifyCriticalError(error: string, context?: string): Promise<void> {
  const message =
    `🚨 <b>CRITICAL ERROR</b>\n\n` +
    (context ? `Context: ${context}\n\n` : "") +
    `<code>${escapeHtml(error)}</code>\n\n` +
    `Trading may be affected. Check immediately!`;

  await sendMessage(message);
}

// Bot started notification
export async function notifyBotStarted(): Promise<void> {
  const mode = isPaperMode() ? "Paper" : "Live";
  const timezone = loadEnv().TIMEZONE;
  const message = `✅ <b>Bot Started</b>\n\nMode: ${mode}\nTimezone: ${timezone}\nTime: ${formatDate()}`;
  await sendMessage(message);
}

// Bot stopped notification
export async function notifyBotStopped(reason?: string): Promise<void> {
  const message =
    `🛑 <b>Bot Stopped</b>\n\n` +
    `Time: ${formatDate()}` +
    (reason ? `\nReason: ${reason}` : "");
  await sendMessage(message);
}

// Kill switch notification
export async function notifyKillSwitch(activated: boolean, reason?: string): Promise<void> {
  if (activated) {
    const message =
      `⛔ <b>KILL SWITCH ACTIVATED</b>\n\n` +
      `All trading has been stopped.\n` +
      (reason ? `Reason: ${reason}\n` : "") +
      `Use /unkill to resume.`;
    await sendMessage(message);
  } else {
    await sendMessage(`✅ Kill switch deactivated. Trading can resume.`);
  }
}

// Daily P&L summary
export async function notifyDailySummary(): Promise<void> {
  const pnl = getDailyPnl();
  const pnlPct = getDailyPnlPercentage();
  const trades = getTodayTrades();

  const pumpfunTrades = trades.filter((t) => t.strategy === "pumpfun");
  const polymarketTrades = trades.filter((t) => t.strategy === "polymarket");

  const pumpfunPnl = pumpfunTrades.reduce((sum, t) => sum + t.pnl, 0);
  const polymarketPnl = polymarketTrades.reduce((sum, t) => sum + t.pnl, 0);

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  const emoji = pnl >= 0 ? "📈" : "📉";

  const message =
    `${emoji} <b>Daily Summary</b>\n` +
    `${new Date().toLocaleDateString()}\n\n` +
    `<b>Total P&L</b>\n` +
    `$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n\n` +
    `<b>Breakdown</b>\n` +
    `🚀 Pump.fun: $${pumpfunPnl.toFixed(2)} (${pumpfunTrades.length} trades)\n` +
    `📊 Polymarket: $${polymarketPnl.toFixed(2)} (${polymarketTrades.length} trades)\n\n` +
    `<b>Stats</b>\n` +
    `Total Trades: ${trades.length}\n` +
    `Wins: ${wins} | Losses: ${losses}\n` +
    `Win Rate: ${winRate.toFixed(1)}%`;

  await sendMessage(message);
}

// Low balance warning
export async function notifyLowBalance(currency: string, balance: number, minimum: number): Promise<void> {
  const message =
    `⚠️ <b>Low Balance Warning</b>\n\n` +
    `${currency}: ${balance.toFixed(4)}\n` +
    `Minimum: ${minimum.toFixed(4)}\n\n` +
    `Please top up to continue trading.`;
  await sendMessage(message);
}

// Opportunity detected (for monitoring)
export async function notifyOpportunity(params: {
  strategy: "pumpfun" | "polymarket";
  confidence: number;
  details: string;
}): Promise<void> {
  const emoji = params.strategy === "pumpfun" ? "🚀" : "📊";
  const message =
    `${emoji} <b>Opportunity Detected</b>\n\n` +
    `Strategy: ${params.strategy}\n` +
    `Confidence: ${params.confidence.toFixed(1)}%\n\n` +
    `${params.details}`;
  await sendMessage(message);
}

// Helper to escape HTML
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Start periodic status reporter (hourly)
export function startStatusReporter(): void {
  // Send status every hour (first one after 1 hour)
  statusReporterInterval = setInterval(() => {
    sendStatusUpdate();
  }, 60 * 60 * 1000);

  console.log("[Telegram] Status reporter started (hourly)");
}

// Stop periodic status reporter
export function stopStatusReporter(): void {
  if (statusReporterInterval) {
    clearInterval(statusReporterInterval);
    statusReporterInterval = null;
    console.log("[Telegram] Status reporter stopped");
  }
}

// Send current status
async function sendStatusUpdate(): Promise<void> {
  try {
    const status = await getRiskStatus();
    const pnl = getDailyPnl();
    const pnlPct = getDailyPnlPercentage();
    const trades = getTodayTrades();

    const statusEmoji = status.tradingEnabled ? "🟢" : "🔴";
    const modeEmoji = status.isPaperMode ? "📝" : "💰";
    const pnlEmoji = pnl >= 0 ? "📈" : "📉";

    const message =
      `${statusEmoji} ${modeEmoji} <b>Status</b>\n\n` +
      `<b>Trading</b>\n` +
      `Status: ${status.tradingEnabled ? "Active" : "Paused"}\n` +
      `SOL: ${status.solBalance.toFixed(4)}\n` +
      `MATIC: ${status.maticBalance.toFixed(4)}\n\n` +
      `<b>Today</b>\n` +
      `${pnlEmoji} $${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n` +
      `Trades: ${trades.length}`;

    await sendStatusMessage(message);
  } catch (err) {
    console.error("[Telegram] Status update error:", err);
  }
}
