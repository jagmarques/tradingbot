import { sendMessage } from "./bot.js";
import { getDailyPnl, getDailyPnlPercentage, getTodayTrades } from "../risk/manager.js";
import { isPaperMode, loadEnv } from "../../config/env.js";
import { getUserTimezone } from "../database/timezones.js";
import { formatPrice } from "../../utils/format.js";

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

export async function notifyCriticalError(error: string, context?: string): Promise<void> {
  const message =
    `🚨 <b>CRITICAL ERROR</b>\n\n` +
    (context ? `Context: ${context}\n\n` : "") +
    `${escapeHtml(error)}\n\n` +
    `Trading may be affected. Check immediately!`;

  await sendMessage(message);
}

export async function notifyBotStarted(): Promise<void> {
  const mode = isPaperMode() ? "Paper" : "Live";
  const timezone = loadEnv().TIMEZONE;
  const message = `✅ <b>Bot Started</b>\n\nMode: ${mode}\nTimezone: ${timezone}\nTime: ${formatDate()}`;
  await sendMessage(message);
}

export async function notifyBotStopped(reason?: string): Promise<void> {
  const message =
    `🛑 <b>Bot Stopped</b>\n\n` +
    `Time: ${formatDate()}` +
    (reason ? `\nReason: ${reason}` : "");
  await sendMessage(message);
}

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
    `$${pnl.toFixed(2)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n\n` +
    `<b>Stats</b>\n` +
    `Total Trades: ${trades.length}\n` +
    `Wins: ${wins} | Losses: ${losses}\n` +
    `Win Rate: ${winRate.toFixed(1)}%`;

  await sendMessage(message);
}

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
    `P&L: $${params.pnl.toFixed(2)} (${params.pnlPercentage > 0 ? "+" : ""}${params.pnlPercentage.toFixed(1)}%)\n` +
    `Reason: ${params.exitReason}`;
  await sendMessage(message);
}

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

export async function notifyTopTraderCopyClose(params: {
  traderName: string;
  marketTitle: string;
  pnl: number;
  pnlPct: number;
  isPaper: boolean;
}): Promise<void> {
  const modeTag = params.isPaper ? "[PAPER]" : "[LIVE]";
  const pnlEmoji = params.pnl > 0 ? "+" : "";
  const message =
    `${modeTag} <b>COPY BET CLOSED</b>\n\n` +
    `Trader: ${escapeHtml(params.traderName)}\n\n` +
    `<b>${escapeHtml(params.marketTitle)}</b>\n` +
    `PnL: ${pnlEmoji}$${params.pnl.toFixed(2)} (${pnlEmoji}${params.pnlPct.toFixed(1)}%)`;
  await sendMessage(message);
}

export async function notifyInsiderBuyDetected(params: {
  walletAddress: string;
  walletScore: number;
  tokenSymbol: string;
  tokenAddress: string;
  chain: string;
  action: string;
}): Promise<void> {
  const message =
    `👀 <b>INSIDER BUY DETECTED</b>\n\n` +
    `Wallet: ${escapeHtml(params.walletAddress.slice(0, 8))}...\n` +
    `Wallet score: ${params.walletScore}\n` +
    `Chain: ${escapeHtml(params.chain)}\n\n` +
    `Token: <b>${escapeHtml(params.tokenSymbol)}</b>\n` +
    `Address: ${escapeHtml(params.tokenAddress.slice(0, 10))}...\n\n` +
    `Action: ${escapeHtml(params.action)}`;
  await sendMessage(message);
}


export async function notifyCopyTrade(params: {
  walletAddress: string;
  tokenSymbol: string;
  chain: string;
  side: "buy" | "sell";
  priceUsd: number;
  liquidityOk: boolean;
  liquidityUsd: number;
  skipReason: string | null;
  pnlPct?: number;
}): Promise<void> {
  const isBuy = params.side === "buy";
  const header = isBuy ? "COPY BUY" : "COPY SELL";

  let message: string;
  if (isBuy) {
    const statusStr = params.liquidityOk
      ? "Paper traded"
      : `Skipped: ${escapeHtml(params.skipReason || "unknown")}`;
    message =
      `<b>${header}</b>\n\n` +
      `Wallet: ${escapeHtml(params.walletAddress.slice(0, 8))}...\n` +
      `Chain: ${escapeHtml(params.chain)}\n` +
      `Token: <b>${escapeHtml(params.tokenSymbol)}</b>\n` +
      `Price: ${formatPrice(params.priceUsd)}\n` +
      `Liquidity: $${params.liquidityUsd.toFixed(0)}\n` +
      `Status: ${statusStr}`;
  } else {
    const pnlStr = params.pnlPct !== undefined
      ? `${params.pnlPct > 0 ? "+" : ""}${params.pnlPct.toFixed(1)}%`
      : "N/A";
    message =
      `<b>${header}</b>\n\n` +
      `Token: <b>${escapeHtml(params.tokenSymbol)}</b>\n` +
      `Chain: ${escapeHtml(params.chain)}\n` +
      `Price: ${formatPrice(params.priceUsd)}\n` +
      `P&L: ${pnlStr}\n` +
      `Reason: ${escapeHtml(params.skipReason || "closed")}`;
  }

  await sendMessage(message);
}

export async function notifyQuantTradeEntry(params: {
  pair: string;
  direction: "long" | "short";
  size: number;
  entryPrice: number;
  leverage: number;
  tradeType: "directional" | "funding";
  stopLoss: number;
  takeProfit: number;
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "[LIVE] ";
  const dirLabel = params.direction === "long" ? "LONG" : "SHORT";
  const typeLabel = params.tradeType === "funding" ? "Funding" : "Directional";
  const message =
    `${mode}<b>QUANT ENTRY</b>\n\n` +
    `Pair: <b>${escapeHtml(params.pair)}</b>\n` +
    `Direction: ${dirLabel}\n` +
    `Size: $${params.size.toFixed(2)}\n` +
    `Entry: ${params.entryPrice}\n` +
    `Leverage: ${params.leverage}x\n` +
    `Type: ${typeLabel}\n` +
    `Stop-Loss: ${params.stopLoss}\n` +
    `Take-Profit: ${params.takeProfit}`;
  await sendMessage(message);
}

export async function notifyQuantTradeExit(params: {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  exitReason: string;
  tradeType: "directional" | "funding";
}): Promise<void> {
  const mode = isPaperMode() ? "[PAPER] " : "[LIVE] ";
  const indicator = params.pnl > 0 ? "+" : params.pnl < 0 ? "-" : "";
  const dirLabel = params.direction === "long" ? "LONG" : "SHORT";
  const pnlPct = (params.pnl / params.size) * 100;
  const message =
    `${mode}<b>QUANT EXIT</b>\n\n` +
    `Pair: <b>${escapeHtml(params.pair)}</b>\n` +
    `Direction: ${dirLabel}\n` +
    `Entry: ${params.entryPrice}\n` +
    `Exit: ${params.exitPrice}\n` +
    `Size: $${params.size.toFixed(2)}\n` +
    `P&L: ${indicator}$${Math.abs(params.pnl).toFixed(2)} (${indicator}${Math.abs(pnlPct).toFixed(1)}%)\n` +
    `Reason: ${escapeHtml(params.exitReason)}`;
  await sendMessage(message);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

