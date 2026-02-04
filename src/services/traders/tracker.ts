import { ethers } from "ethers";
import {
  Trader,
  TraderTrade,
  WalletTransfer,
  Chain,
  TRADER_THRESHOLDS,
  KNOWN_EXCHANGES,
  TRANSFER_THRESHOLDS,
} from "./types.js";
import {
  initTraderTables,
  getTopTraders,
  getTrader,
  insertTraderTrade,
  alertExists,
  insertWalletTransfer,
  getClusterWallets,
  upsertTrader,
} from "./storage.js";

// RPC endpoints for different chains
const RPC_ENDPOINTS: Record<Chain, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  base: "https://mainnet.base.org",
  bnb: "https://bsc-dataseed1.binance.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
};

// DEX Router addresses for transfer monitoring
const DEX_ROUTERS: Record<Chain, string[]> = {
  solana: [], // Handled differently
  base: [
    "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap Universal Router
    "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome
  ],
  bnb: [
    "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2
    "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", // PancakeSwap V3
  ],
  arbitrum: [
    "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", // Camelot
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap Router
  ],
  avalanche: [
    "0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106", // Pangolin
    "0x60aE616a2155Ee3d9A68541Ba4544862310933d4", // Trader Joe
  ],
};

// Polling interval (30 seconds)
const POLL_INTERVAL_MS = 30_000;

type TradeCallback = (trader: Trader, trade: TraderTrade) => void;

let isRunning = false;
let pollTimer: NodeJS.Timeout | null = null;
const tradeCallbacks: Set<TradeCallback> = new Set();
const evmProviders: Map<Chain, ethers.JsonRpcProvider> = new Map();
const lastBlockByChain: Map<Chain, number> = new Map();

// Get EVM provider for chain
function getEvmProvider(chain: Chain): ethers.JsonRpcProvider | null {
  if (chain === "solana") return null;

  let provider = evmProviders.get(chain);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS[chain]);
    evmProviders.set(chain, provider);
  }
  return provider;
}

// Initialize the tracker
export function initTracker(): void {
  initTraderTables();
  console.log("[Traders] Tracker initialized");
}

// Start tracking trader wallets
export async function startTracking(): Promise<void> {
  if (isRunning) {
    console.log("[Traders] Tracker already running");
    return;
  }

  isRunning = true;
  console.log("[Traders] Starting trader tracker...");

  // Initialize last blocks
  for (const chain of Object.keys(RPC_ENDPOINTS) as Chain[]) {
    if (chain === "solana") continue;
    const provider = getEvmProvider(chain);
    if (provider) {
      try {
        const blockNumber = await provider.getBlockNumber();
        lastBlockByChain.set(chain, blockNumber);
      } catch (err) {
        console.error(`[Traders] Failed to get block for ${chain}:`, err);
      }
    }
  }

  // Start polling loop
  poll();

  console.log("[Traders] Tracker started");
}

// Stop tracking
export function stopTracking(): void {
  isRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log("[Traders] Tracker stopped");
}

// Poll for new transactions
async function poll(): Promise<void> {
  if (!isRunning) return;

  try {
    const traders = getTopTraders(100); // Track top 100 traders

    // Group traders by chain
    const tradersByChain: Map<Chain, Trader[]> = new Map();
    for (const trader of traders) {
      const list = tradersByChain.get(trader.chain) || [];
      list.push(trader);
      tradersByChain.set(trader.chain, list);
    }

    // Check each chain
    for (const [chain, chainTraders] of tradersByChain) {
      if (chain === "solana") {
        // TODO: Implement Solana tracking via Helius webhooks or RPC
        continue;
      }

      await checkEvmChain(chain, chainTraders);
    }
  } catch (err) {
    console.error("[Traders] Poll error:", err);
  }

  // Schedule next poll
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

// Check if address is a known exchange
function isExchangeAddress(address: string, chain: Chain): boolean {
  const exchanges = KNOWN_EXCHANGES[chain] || [];
  return exchanges.some((ex) => ex.toLowerCase() === address.toLowerCase());
}

// Check EVM chain for trader transactions and transfers
async function checkEvmChain(chain: Chain, traders: Trader[]): Promise<void> {
  const provider = getEvmProvider(chain);
  if (!provider) return;

  const lastBlock = lastBlockByChain.get(chain) || 0;

  try {
    const currentBlock = await provider.getBlockNumber();

    if (currentBlock <= lastBlock) return;

    // Get trader addresses (including linked wallets from clusters)
    const traderAddresses = new Set<string>();
    for (const trader of traders) {
      traderAddresses.add(trader.address.toLowerCase());
      // Also add linked wallets from clusters
      const clusterWallets = getClusterWallets(trader.address, chain);
      for (const linked of clusterWallets) {
        traderAddresses.add(linked.toLowerCase());
      }
    }

    // Check transactions in new blocks
    for (let blockNum = lastBlock + 1; blockNum <= currentBlock; blockNum++) {
      try {
        const block = await provider.getBlock(blockNum, true);
        if (!block || !block.prefetchedTransactions) continue;

        for (const tx of block.prefetchedTransactions) {
          if (!tx.from) continue;
          const fromLower = tx.from.toLowerCase();
          const toLower = tx.to?.toLowerCase();

          // Check if transaction is from a tracked trader
          if (traderAddresses.has(fromLower)) {
            // Check if it's a DEX interaction (trade)
            const isDexTx =
              toLower && DEX_ROUTERS[chain].some((router) => router.toLowerCase() === toLower);

            if (isDexTx) {
              const trader = traders.find((t) => t.address.toLowerCase() === fromLower);
              if (trader) {
                await processTraderTx(chain, tx, traders);
              }
            }

            // Check if it's a native token transfer to another wallet (not exchange, not contract)
            const transferValue = Number(tx.value) / 1e18;
            const transferUsd = transferValue * getChainNativePrice(chain);

            if (
              toLower &&
              !isDexTx &&
              transferUsd >= TRANSFER_THRESHOLDS.MIN_TRANSFER_USD &&
              !isExchangeAddress(toLower, chain)
            ) {
              // This is a significant transfer to a non-exchange wallet
              await processTraderTransfer(chain, tx, traders, transferUsd);
            }
          }
        }
      } catch (err) {
        console.error(`[Traders] Error processing block ${blockNum} on ${chain}:`, err);
      }
    }

    lastBlockByChain.set(chain, currentBlock);
  } catch (err) {
    console.error(`[Traders] Error checking ${chain}:`, err);
  }
}

// Process trader transfer to new wallet
async function processTraderTransfer(
  chain: Chain,
  tx: ethers.TransactionResponse,
  traders: Trader[],
  amountUsd: number
): Promise<void> {
  if (!tx.from || !tx.to) return;

  const fromLower = tx.from.toLowerCase();

  // Find the trader
  const trader = traders.find((t) => t.address.toLowerCase() === fromLower);
  if (!trader) return;

  // Create transfer record
  const transfer: WalletTransfer = {
    id: `transfer_${chain}_${tx.hash}`,
    fromAddress: tx.from,
    toAddress: tx.to,
    chain,
    amountUsd,
    txHash: tx.hash,
    timestamp: Date.now(),
  };

  // Store the transfer (this will auto-link wallets if criteria met)
  insertWalletTransfer(transfer);

  console.log(
    `[Traders] Transfer detected: ${trader.address.slice(0, 8)}... -> ${tx.to.slice(0, 8)}... ($${amountUsd.toFixed(0)})`
  );
}

// Process trader transaction
async function processTraderTx(
  chain: Chain,
  tx: ethers.TransactionResponse,
  traders: Trader[]
): Promise<void> {
  const trader = traders.find((t) => t.address.toLowerCase() === tx.from?.toLowerCase());
  if (!trader) return;

  // Create trade record
  const trade: TraderTrade = {
    id: `${chain}_${tx.hash}`,
    walletAddress: trader.address,
    chain,
    tokenAddress: tx.to || "",
    type: "BUY", // Simplified - would need to decode tx data for accuracy
    amountUsd: (Number(tx.value) / 1e18) * getChainNativePrice(chain),
    price: 0,
    txHash: tx.hash,
    timestamp: Date.now(),
  };

  // Check if we already sent an alert for this trade
  if (alertExists(trade.id)) {
    return;
  }

  // Store the trade
  insertTraderTrade(trade);

  // Notify callbacks
  notifyCallbacks(trader, trade);

  console.log(
    `[Traders] New trade from ${trader.address.slice(0, 8)}... on ${chain}: ${trade.type} $${trade.amountUsd.toFixed(2)}`
  );
}

// Get approximate native token price (simplified)
function getChainNativePrice(chain: Chain): number {
  const prices: Record<Chain, number> = {
    solana: 150,
    base: 3500,
    bnb: 600,
    arbitrum: 3500,
    avalanche: 40,
  };
  return prices[chain] || 0;
}

// Notify trade callbacks
function notifyCallbacks(trader: Trader, trade: TraderTrade): void {
  for (const callback of tradeCallbacks) {
    try {
      callback(trader, trade);
    } catch (err) {
      console.error("[Traders] Callback error:", err);
    }
  }
}

// Register callback for new trader trades
export function onTraderTrade(callback: TradeCallback): () => void {
  tradeCallbacks.add(callback);
  return () => tradeCallbacks.delete(callback);
}

// Check if tracker is running
export function isTrackerRunning(): boolean {
  return isRunning;
}

// Get tracked trader count
export function getTrackedTraderCount(): number {
  return getTopTraders(1000).length;
}

// Manual: Add trader wallet for tracking
export async function addTraderWallet(address: string, chain: Chain): Promise<boolean> {
  const existing = getTrader(address, chain);
  if (existing) {
    console.log(`[Traders] Wallet ${address} already tracked on ${chain}`);
    return false;
  }

  // For manual additions, create a placeholder trader record
  // Real stats will be populated by the discovery process
  upsertTrader({
    address,
    chain,
    score: TRADER_THRESHOLDS.MIN_SCORE,
    winRate: 0,
    profitFactor: 0,
    consistency: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnlUsd: 0,
    avgHoldTimeMs: 0,
    largestWinPct: 0,
    discoveredAt: Date.now(),
    updatedAt: Date.now(),
  });

  console.log(`[Traders] Added wallet ${address} on ${chain} for tracking`);
  return true;
}
