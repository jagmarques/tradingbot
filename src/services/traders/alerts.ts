import { Trader, TraderTrade, TraderAlert } from "./types.js";
import { insertTraderAlert, alertExists } from "./storage.js";
import { sendMessage } from "../telegram/bot.js";
import { onTraderTrade } from "./tracker.js";
import { executeCopyTrade, findOpenPosition, closeCopiedPosition } from "../copy/executor.js";

let unsubscribe: (() => void) | null = null;

// Format trader alert message
function formatTraderAlert(trader: Trader, trade: TraderTrade): string {
  const chainLabel: Record<string, string> = {
    solana: "SOL",
    ethereum: "ETH",
    polygon: "MATIC",
    base: "BASE",
    arbitrum: "ARB",
    bsc: "BNB",
    optimism: "OP",
    avalanche: "AVAX",
    sonic: "S",
  };

  const shortAddress = `${trader.address.slice(0, 6)}...${trader.address.slice(-4)}`;
  const chain = chainLabel[trader.chain] || trader.chain.toUpperCase();

  return `
TRADER ALERT - ${trade.type}

Wallet: ${shortAddress} (${chain})
Stats: ${trader.winRate.toFixed(0)}% win | ${trader.profitFactor.toFixed(1)}x profit factor
Score: ${trader.score.toFixed(0)}/100

${trade.tokenSymbol ? `Token: $${trade.tokenSymbol}` : ""}
CA: ${trade.tokenAddress.slice(0, 12)}...${trade.tokenAddress.slice(-8)}

Trade:
  Amount: $${trade.amountUsd.toFixed(2)}
  ${trade.price > 0 ? `Price: $${trade.price.toFixed(8)}` : ""}

TX: ${trade.txHash.slice(0, 12)}...

Trader Stats:
  Total trades: ${trader.totalTrades}
  Total PnL: $${trader.totalPnlUsd.toFixed(2)}
  Avg hold: ${formatHoldTime(trader.avgHoldTimeMs)}
`.trim();
}

// Format hold time
function formatHoldTime(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

// Generate unique alert ID
function generateAlertId(): string {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Handle trader trade callback
async function handleTraderTrade(trader: Trader, trade: TraderTrade): Promise<void> {
  // Check if alert already sent
  if (alertExists(trade.id)) {
    return;
  }

  // Create alert
  const alert: TraderAlert = {
    id: generateAlertId(),
    walletAddress: trader.address,
    trade,
    walletScore: trader.score,
    walletWinRate: trader.winRate,
    sentAt: Date.now(),
  };

  // Store alert
  insertTraderAlert(alert);

  // Format and send Telegram alert
  const message = formatTraderAlert(trader, trade);

  try {
    await sendMessage(message);
    console.log(`[TraderAlerts] Sent alert for ${trader.address.slice(0, 8)}...`);
  } catch (err) {
    console.error("[TraderAlerts] Failed to send alert:", err);
  }

  // Execute copy trade if enabled (only for BUY trades)
  if (trade.type === "BUY") {
    try {
      const copyResult = await executeCopyTrade(trader, trade);
      if (copyResult?.success) {
        console.log(`[TraderAlerts] Copy trade executed for ${trade.tokenAddress.slice(0, 8)}...`);
      }
    } catch (err) {
      console.error("[TraderAlerts] Copy trade error:", err);
    }
  }

  // Close copied position if trader sells
  if (trade.type === "SELL") {
    try {
      const openPosition = findOpenPosition(trader.address, trade.tokenAddress);
      if (openPosition) {
        console.log(`[TraderAlerts] Trader sold, closing copied position for ${trade.tokenAddress.slice(0, 8)}...`);
        const closeResult = await closeCopiedPosition(openPosition, "Trader sold");
        if (closeResult.success) {
          console.log(`[TraderAlerts] Closed copy position, PnL: ${closeResult.pnlNative?.toFixed(6)} native`);
        }
      }
    } catch (err) {
      console.error("[TraderAlerts] Close copy error:", err);
    }
  }
}

// Start trader alerts
export function startTraderAlerts(): void {
  if (unsubscribe) {
    console.log("[TraderAlerts] Already running");
    return;
  }

  unsubscribe = onTraderTrade(handleTraderTrade);
  console.log("[TraderAlerts] Started");
}

// Stop trader alerts
export function stopTraderAlerts(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  console.log("[TraderAlerts] Stopped");
}

// Manual alert send (for testing)
export async function sendTestTraderAlert(trader: Trader, trade: TraderTrade): Promise<void> {
  const message = formatTraderAlert(trader, trade);
  await sendMessage(message);
}
