import { sendMessage } from "./bot.js";
import { getDailyPnl, getDailyPnlPercentage, getTodayTrades, type Trade } from "../risk/manager.js";
import { isPaperMode, loadEnv } from "../../config/env.js";
import { getUserTimezone } from "../database/timezones.js";

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

  const message =
    `${mode}${emoji} <b>${trade.type} ${trade.strategy.toUpperCase()}</b>\n\n` +
    `Amount: $${trade.amount.toFixed(2)}\n` +
    `Price: ${trade.price.toFixed(8)}\n` +
    `${emoji} P&L: $${trade.pnl.toFixed(2)}`;

  await sendMessage(message);
}

// Buy executed alert
export async function notifyBuy(params: {
  strategy: "polymarket";
  symbol?: string;
  amount: number;
  price: number;
  txHash?: string;
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "";

  let message =
    `${mode}📊 <b>BUY ${params.strategy.toUpperCase()}</b>\n\n` +
    (params.symbol ? `Token: ${params.symbol}\n` : "") +
    `Amount: $${params.amount.toFixed(2)}\n` +
    `Price: ${params.price.toFixed(8)}`;

  if (params.txHash) {
    message += `\n\n<a href="https://polygonscan.com/tx/${params.txHash}">View TX</a>`;
  }

  await sendMessage(message);
}

// Sell executed alert
export async function notifySell(params: {
  strategy: "polymarket";
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
    message += `\n\n<a href="https://polygonscan.com/tx/${params.txHash}">View TX</a>`;
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

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  const emoji = pnl >= 0 ? "📈" : "📉";

  const message =
    `${emoji} <b>Daily Summary</b>\n` +
    `${new Date().toLocaleDateString()}\n\n` +
    `<b>Total P&L</b>\n` +
    `$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n\n` +
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
  strategy: "polymarket";
  confidence: number;
  details: string;
}): Promise<void> {
  const emoji = "📊";
  const message =
    `${emoji} <b>Opportunity Detected</b>\n\n` +
    `Strategy: ${params.strategy}\n` +
    `Confidence: ${params.confidence.toFixed(1)}%\n\n` +
    `${params.details}`;
  await sendMessage(message);
}

// AI Betting: Bet placed notification
export async function notifyAIBetPlaced(params: {
  marketTitle: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  aiProbability: number;
  edge: number;
  reasoning: string;
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "";
  const message =
    `${mode}🤖 <b>AI BET PLACED</b>\n\n` +
    `<b>${params.marketTitle}</b>\n\n` +
    `Side: ${params.side}\n` +
    `Size: $${params.size.toFixed(2)}\n` +
    `Entry: ${(params.entryPrice * 100).toFixed(1)}c\n` +
    `AI Prob: ${(params.aiProbability * 100).toFixed(1)}%\n` +
    `Edge: ${(params.edge * 100).toFixed(1)}%\n\n` +
    `<i>${params.reasoning}</i>`;
  await sendMessage(message);
}

// AI Betting: Bet closed notification
export async function notifyAIBetClosed(params: {
  marketTitle: string;
  side: "YES" | "NO";
  pnl: number;
  pnlPercentage: number;
  exitReason: string;
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "";
  const emoji = params.pnl >= 0 ? "🟢" : "🔴";
  const message =
    `${mode}${emoji} <b>AI BET CLOSED</b>\n\n` +
    `<b>${params.marketTitle}</b>\n\n` +
    `Side: ${params.side}\n` +
    `P&L: $${params.pnl.toFixed(2)} (${params.pnlPercentage >= 0 ? "+" : ""}${params.pnlPercentage.toFixed(1)}%)\n` +
    `Reason: ${params.exitReason}`;
  await sendMessage(message);
}

// AI Betting: Cycle summary
export async function notifyAIBettingCycle(params: {
  marketsAnalyzed: number;
  opportunitiesFound: number;
  betsPlaced: number;
  openPositions: number;
  totalExposure: number;
}): Promise<void> {
  if (params.betsPlaced === 0 && params.opportunitiesFound === 0) {
    return; // Don't spam if nothing happened
  }
  const message =
    `🤖 <b>AI Betting Cycle</b>\n\n` +
    `Analyzed: ${params.marketsAnalyzed} markets\n` +
    `Found: ${params.opportunitiesFound} opportunities\n` +
    `Placed: ${params.betsPlaced} bets\n\n` +
    `Open: ${params.openPositions} positions\n` +
    `Exposure: $${params.totalExposure.toFixed(2)}`;
  await sendMessage(message);
}

// Polymarket Top Trader Alert
export async function notifyTopTraderBet(params: {
  traderName: string;
  traderPnl: number;
  marketTitle: string;
  size: number;
  price: number;
}): Promise<void> {
  const pnlStr = params.traderPnl >= 0
    ? `+$${(params.traderPnl / 1e6).toFixed(1)}M`
    : `-$${(Math.abs(params.traderPnl) / 1e6).toFixed(1)}M`;

  const message =
    `👀 <b>TOP TRADER BET</b>\n\n` +
    `Trader: ${escapeHtml(params.traderName)}\n` +
    `Monthly PnL: ${pnlStr}\n\n` +
    `<b>${escapeHtml(params.marketTitle)}</b>\n` +
    `Size: $${params.size.toFixed(0)}\n` +
    `Price: ${(params.price * 100).toFixed(1)}c`;
  await sendMessage(message);
}

// Polymarket Copy Trade Notification
export async function notifyTopTraderCopy(params: {
  traderName: string;
  marketTitle: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  isPaper: boolean;
}): Promise<void> {
  const modeTag = params.isPaper ? "[PAPER]" : "[LIVE]";
  const message =
    `${modeTag} <b>COPIED BET</b>\n\n` +
    `Copying: ${escapeHtml(params.traderName)}\n\n` +
    `<b>${escapeHtml(params.marketTitle)}</b>\n` +
    `Side: ${params.side}\n` +
    `Size: $${params.size.toFixed(2)}\n` +
    `Entry: ${(params.entryPrice * 100).toFixed(1)}c`;
  await sendMessage(message);
}

// Polymarket Copy Trade Close Notification
export async function notifyTopTraderCopyClose(params: {
  traderName: string;
  marketTitle: string;
  pnl: number;
  pnlPct: number;
  isPaper: boolean;
}): Promise<void> {
  const modeTag = params.isPaper ? "[PAPER]" : "[LIVE]";
  const pnlEmoji = params.pnl >= 0 ? "+" : "";
  const message =
    `${modeTag} <b>COPY BET CLOSED</b>\n\n` +
    `Trader: ${escapeHtml(params.traderName)}\n\n` +
    `<b>${escapeHtml(params.marketTitle)}</b>\n` +
    `PnL: ${pnlEmoji}$${params.pnl.toFixed(2)} (${pnlEmoji}${params.pnlPct.toFixed(1)}%)`;
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

