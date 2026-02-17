// Copy trade executor for all chains
import type { Chain, Trader, TraderTrade } from "../traders/types.js";
import { getSettings, incrementDailyCopyCount, canCopyTrade } from "../settings/settings.js";
import { canTrade } from "../risk/manager.js";
import { execute1inchSwap, execute1inchSell, isChainSupported } from "../evm/oneinch.js";
import { getChatId, sendMessage } from "../telegram/bot.js";
import { getDb } from "../database/db.js";
import { isPaperMode } from "../../config/env.js";
import {
  ESTIMATED_GAS_FEE_EVM,
  ESTIMATED_SLIPPAGE_DEX,
} from "../../config/constants.js";
import { filterCryptoCopy, getApproxUsdValue, type CopyFilterResult } from "./filter.js";
import { isLogOnlyMode } from "../aibetting/scheduler.js";

// Crypto copied position tracking
export interface CryptoCopyPosition {
  id: string;
  traderAddress: string;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol: string;
  entryAmountNative: number;
  tokensReceived: string;
  status: "open" | "closed";
  entryTimestamp: number;
  exitTimestamp?: number;
  pnlNative?: number;
}

// In-memory positions
const cryptoCopyPositions = new Map<string, CryptoCopyPosition>();

// Initialize table and load positions
export function initCryptoCopyTracking(): number {
  initCryptoCopyTable();
  const positions = loadOpenCryptoCopyPositions();
  for (const pos of positions) {
    cryptoCopyPositions.set(pos.id, pos);
  }
  console.log(`[CopyTrade] Loaded ${positions.length} open crypto copy positions`);
  return positions.length;
}

export function initCryptoCopyTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_copy_positions (
      id TEXT PRIMARY KEY,
      trader_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      entry_amount_native REAL NOT NULL,
      tokens_received TEXT NOT NULL,
      status TEXT NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      exit_timestamp INTEGER,
      pnl_native REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_copy_status ON crypto_copy_positions(status);
    CREATE INDEX IF NOT EXISTS idx_crypto_copy_trader ON crypto_copy_positions(trader_address, token_address);
  `);
}

function saveCryptoCopyPosition(pos: CryptoCopyPosition): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO crypto_copy_positions (
      id, trader_address, chain, token_address, token_symbol, entry_amount_native,
      tokens_received, status, entry_timestamp, exit_timestamp, pnl_native
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pos.id, pos.traderAddress, pos.chain, pos.tokenAddress, pos.tokenSymbol || "",
    pos.entryAmountNative, pos.tokensReceived, pos.status, pos.entryTimestamp,
    pos.exitTimestamp || null, pos.pnlNative || null
  );
}

export function loadOpenCryptoCopyPositions(): CryptoCopyPosition[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM crypto_copy_positions WHERE status = 'open'`).all() as Array<{
    id: string;
    trader_address: string;
    chain: string;
    token_address: string;
    token_symbol: string;
    entry_amount_native: number;
    tokens_received: string;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    pnl_native: number | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    traderAddress: r.trader_address,
    chain: r.chain as Chain,
    tokenAddress: r.token_address,
    tokenSymbol: r.token_symbol,
    entryAmountNative: r.entry_amount_native,
    tokensReceived: r.tokens_received,
    status: r.status as "open" | "closed",
    entryTimestamp: r.entry_timestamp,
    exitTimestamp: r.exit_timestamp || undefined,
    pnlNative: r.pnl_native || undefined,
  }));
}

export function getOpenCryptoCopyPositions(): CryptoCopyPosition[] {
  return Array.from(cryptoCopyPositions.values()).filter(p => p.status === "open");
}

export function getCryptoCopyStats(): {
  totalCopies: number;
  openPositions: number;
  closedPositions: number;
  totalPnlNative: number;
} {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
      SUM(CASE WHEN status = 'closed' THEN pnl_native ELSE 0 END) as total_pnl
    FROM crypto_copy_positions
  `).get() as {
    total: number;
    open_count: number;
    closed_count: number;
    total_pnl: number;
  };

  return {
    totalCopies: stats.total || 0,
    openPositions: stats.open_count || 0,
    closedPositions: stats.closed_count || 0,
    totalPnlNative: stats.total_pnl || 0,
  };
}

// Find open position for a trader+token combination
export function findOpenPosition(traderAddress: string, tokenAddress: string): CryptoCopyPosition | undefined {
  for (const pos of cryptoCopyPositions.values()) {
    if (pos.status === "open" &&
        pos.traderAddress.toLowerCase() === traderAddress.toLowerCase() &&
        pos.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()) {
      return pos;
    }
  }
  return undefined;
}

// Close a copied position when trader sells
export async function closeCopiedPosition(
  position: CryptoCopyPosition,
  reason: string = "Trader sold"
): Promise<{ success: boolean; pnlNative?: number }> {
  console.log(`[CopyTrade] Closing position: ${position.tokenSymbol || position.tokenAddress.slice(0, 8)} (${reason})`);

  // Execute sell
  let sellResult: { success: boolean; amountReceived?: number; error?: string };

  if (isChainSupported(position.chain)) {
    sellResult = await execute1inchSell(position.chain, position.tokenAddress, position.tokensReceived);
  } else {
    console.log(`[CopyTrade] Chain ${position.chain} not supported for sell`);
    return { success: false };
  }

  if (!sellResult.success) {
    console.error(`[CopyTrade] Sell failed: ${sellResult.error}`);
    return { success: false };
  }

  // Calculate PnL with fee deductions for paper mode
  let pnlNative = (sellResult.amountReceived || 0) - position.entryAmountNative;

  // Deduct estimated fees (gas + slippage on entry and exit)
  if (isPaperMode()) {
    const gasFee = (ESTIMATED_GAS_FEE_EVM[position.chain] || 0.001) * 2;
    const slippageFee = position.entryAmountNative * ESTIMATED_SLIPPAGE_DEX * 2; // Entry + exit slippage
    pnlNative -= (gasFee + slippageFee);
    console.log(`[CopyTrade] Paper fees: gas=${gasFee.toFixed(6)}, slippage=${slippageFee.toFixed(6)}`);
  }

  // Update position
  position.status = "closed";
  position.exitTimestamp = Date.now();
  position.pnlNative = pnlNative;

  saveCryptoCopyPosition(position);
  cryptoCopyPositions.delete(position.id);

  // Send notification
  const chainLabel: Record<string, string> = {
    ethereum: "ETH", polygon: "MATIC", base: "BASE",
    arbitrum: "ARB", optimism: "OP", avalanche: "AVAX",
  };
  const chain = chainLabel[position.chain] || position.chain.toUpperCase();
  const pnlStr = pnlNative >= 0 ? `+${pnlNative.toFixed(6)}` : pnlNative.toFixed(6);

  await sendMessage(`
COPY POSITION CLOSED

Token: ${position.tokenSymbol || position.tokenAddress.slice(0, 10)}
Chain: ${chain}
Reason: ${reason}

PnL: ${pnlStr} ${chain}
  `.trim());

  return { success: true, pnlNative };
}

export interface CopyTradeResult {
  success: boolean;
  chain: Chain;
  tokenAddress: string;
  amountNative: number;
  signature?: string;
  txHash?: string;
  tokensReceived?: string;
  error?: string;
  isPaper?: boolean;
}

export async function executeCopyTrade(
  trader: Trader,
  trade: TraderTrade
): Promise<CopyTradeResult | null> {
  // Only copy BUY trades
  if (trade.type !== "BUY") {
    return null;
  }

  const chatId = getChatId();
  if (!chatId) {
    console.log("[CopyTrade] No chat ID configured");
    return null;
  }

  const settings = getSettings(chatId);

  // Check if auto-copy is enabled
  if (!settings.autoCopyEnabled) {
    return null;
  }

  // Check daily copy limit
  if (!canCopyTrade(chatId)) {
    console.log("[CopyTrade] Daily copy limit reached");
    return null;
  }

  // Check risk limits
  if (!canTrade()) {
    console.log("[CopyTrade] Trading disabled by risk manager");
    return null;
  }

  if (isLogOnlyMode()) {
    console.log("[CopyTrade] Log-only mode active, skipping trade");
    return null;
  }

  // AI pre-filter (replaces simple score check + fixed amount)
  const filterResult = await filterCryptoCopy(trader, trade, settings);

  if (!filterResult.shouldCopy) {
    console.log(`[CopyTrade] AI filter rejected: ${filterResult.reason}`);
    return null;
  }

  // Convert recommended USD size back to native amount
  const nativePrice = getApproxUsdValue(1, trade.chain);
  const copyAmount = nativePrice > 0 ? filterResult.recommendedSizeUsd / nativePrice : 0;

  if (copyAmount <= 0) {
    console.log(`[CopyTrade] Copy amount is 0 for ${trade.chain}`);
    return null;
  }

  console.log(`[CopyTrade] Copying ${trader.address.slice(0, 8)}... on ${trade.chain}`);
  console.log(`[CopyTrade] Q=${filterResult.traderQualityMultiplier.toFixed(1)}x`);
  console.log(`[CopyTrade] Token: ${trade.tokenAddress}, Amount: ${copyAmount.toFixed(6)} native ($${filterResult.recommendedSizeUsd.toFixed(2)})`);

  let result: CopyTradeResult;

  if (isChainSupported(trade.chain)) {
    result = await executeEvmCopy(trade.chain, trade.tokenAddress, copyAmount);
  } else {
    console.log(`[CopyTrade] Chain ${trade.chain} not supported for copy trading`);
    return null;
  }

  // Increment daily count on success and save position
  if (result.success && result.tokensReceived) {
    incrementDailyCopyCount(chatId);

    // Save position for auto-close tracking
    const positionId = `crypto_copy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const position: CryptoCopyPosition = {
      id: positionId,
      traderAddress: trader.address,
      chain: trade.chain,
      tokenAddress: trade.tokenAddress,
      tokenSymbol: trade.tokenSymbol || "",
      entryAmountNative: result.amountNative,
      tokensReceived: result.tokensReceived,
      status: "open",
      entryTimestamp: Date.now(),
    };

    cryptoCopyPositions.set(positionId, position);
    saveCryptoCopyPosition(position);
    console.log(`[CopyTrade] Position saved: ${positionId}`);

    await notifyCopyTrade(trader, trade, result, filterResult);
  }

  return result;
}

async function executeEvmCopy(
  chain: Chain,
  tokenAddress: string,
  amountNative: number
): Promise<CopyTradeResult> {
  const result = await execute1inchSwap(chain, tokenAddress, amountNative);

  return {
    success: result.success,
    chain,
    tokenAddress,
    amountNative,
    txHash: result.txHash,
    tokensReceived: result.tokensReceived,
    error: result.error,
    isPaper: result.isPaper,
  };
}

async function notifyCopyTrade(
  trader: Trader,
  trade: TraderTrade,
  result: CopyTradeResult,
  filter: CopyFilterResult,
): Promise<void> {
  const chainLabel: Record<string, string> = {
    ethereum: "ETH",
    polygon: "MATIC",
    base: "BASE",
    arbitrum: "ARB",
    optimism: "OP",
    avalanche: "AVAX",
  };

  const chain = chainLabel[trade.chain] || trade.chain.toUpperCase();
  const paperTag = result.isPaper ? " [PAPER]" : "";
  const shortTrader = `${trader.address.slice(0, 6)}...${trader.address.slice(-4)}`;
  const shortToken = trade.tokenAddress.slice(0, 10);
  const aiInfo = `Q: ${filter.traderQualityMultiplier.toFixed(1)}x`;

  const message = `
COPY TRADE EXECUTED${paperTag}

Copied: ${shortTrader} (${chain})
Token: ${trade.tokenSymbol || shortToken}
Amount: ${result.amountNative.toFixed(6)} ${chain}

${result.signature ? `TX: ${result.signature.slice(0, 16)}...` : ""}
${result.txHash ? `TX: ${result.txHash.slice(0, 16)}...` : ""}

Trader Score: ${trader.score.toFixed(0)}/100
Quality: ${filter.traderQualityMultiplier.toFixed(1)}x
${aiInfo}
  `.trim();

  try {
    await sendMessage(message);
  } catch (err) {
    console.error("[CopyTrade] Failed to send notification:", err);
  }
}
