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

const RPC_ENDPOINTS: Record<Chain, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  ethereum: "https://eth.llamarpc.com",
  polygon: "https://polygon-rpc.com",
  base: "https://mainnet.base.org",
};

const DEX_ROUTERS: Record<Chain, string[]> = {
  solana: [],
  ethereum: [
    "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap V3
  ],
  polygon: [
    "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap V3
  ],
  base: [
    "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap Universal Router
    "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome
  ],
};

const POLL_INTERVAL_MS = 30_000;

type TradeCallback = (trader: Trader, trade: TraderTrade) => void;

let isRunning = false;
let pollTimer: NodeJS.Timeout | null = null;
const tradeCallbacks: Set<TradeCallback> = new Set();
const evmProviders: Map<Chain, ethers.JsonRpcProvider> = new Map();
const lastBlockByChain: Map<Chain, number> = new Map();

function getEvmProvider(chain: Chain): ethers.JsonRpcProvider | null {
  if (chain === "solana") return null;

  let provider = evmProviders.get(chain);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS[chain]);
    evmProviders.set(chain, provider);
  }
  return provider;
}

export function initTracker(): void {
  initTraderTables();
  console.log("[Traders] Tracker initialized");
}

export async function startTracking(): Promise<void> {
  if (isRunning) {
    console.log("[Traders] Tracker already running");
    return;
  }

  isRunning = true;
  console.log("[Traders] Starting trader tracker...");

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

  poll();
  console.log("[Traders] Tracker started");
}

export function stopTracking(): void {
  isRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log("[Traders] Tracker stopped");
}

async function poll(): Promise<void> {
  if (!isRunning) return;

  try {
    const traders = getTopTraders(100);

    const tradersByChain: Map<Chain, Trader[]> = new Map();
    for (const trader of traders) {
      const list = tradersByChain.get(trader.chain) || [];
      list.push(trader);
      tradersByChain.set(trader.chain, list);
    }

    for (const [chain, chainTraders] of tradersByChain) {
      if (chain === "solana") continue;
      await checkEvmChain(chain, chainTraders);
    }
  } catch (err) {
    console.error("[Traders] Poll error:", err);
  }

  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

function isExchangeAddress(address: string, chain: Chain): boolean {
  const exchanges = KNOWN_EXCHANGES[chain] || [];
  return exchanges.some((ex) => ex.toLowerCase() === address.toLowerCase());
}

async function checkEvmChain(chain: Chain, traders: Trader[]): Promise<void> {
  const provider = getEvmProvider(chain);
  if (!provider) return;

  const lastBlock = lastBlockByChain.get(chain) || 0;

  try {
    const currentBlock = await provider.getBlockNumber();
    if (currentBlock <= lastBlock) return;

    const traderAddresses = new Set<string>();
    for (const trader of traders) {
      traderAddresses.add(trader.address.toLowerCase());
      const clusterWallets = getClusterWallets(trader.address, chain);
      for (const linked of clusterWallets) {
        traderAddresses.add(linked.toLowerCase());
      }
    }

    for (let blockNum = lastBlock + 1; blockNum <= currentBlock; blockNum++) {
      try {
        const block = await provider.getBlock(blockNum, true);
        if (!block || !block.prefetchedTransactions) continue;

        for (const tx of block.prefetchedTransactions) {
          if (!tx.from) continue;
          const fromLower = tx.from.toLowerCase();
          const toLower = tx.to?.toLowerCase();

          if (traderAddresses.has(fromLower)) {
            const isDexTx =
              toLower && DEX_ROUTERS[chain].some((router) => router.toLowerCase() === toLower);

            if (isDexTx) {
              const trader = traders.find((t) => t.address.toLowerCase() === fromLower);
              if (trader) {
                await processTraderTx(chain, tx, traders);
              }
            }

            const transferValue = Number(tx.value) / 1e18;
            const transferUsd = transferValue * getChainNativePrice(chain);

            if (
              toLower &&
              !isDexTx &&
              transferUsd >= TRANSFER_THRESHOLDS.MIN_TRANSFER_USD &&
              !isExchangeAddress(toLower, chain)
            ) {
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

async function processTraderTransfer(
  chain: Chain,
  tx: ethers.TransactionResponse,
  traders: Trader[],
  amountUsd: number
): Promise<void> {
  if (!tx.from || !tx.to) return;

  const fromLower = tx.from.toLowerCase();
  const trader = traders.find((t) => t.address.toLowerCase() === fromLower);
  if (!trader) return;

  const transfer: WalletTransfer = {
    id: `transfer_${chain}_${tx.hash}`,
    fromAddress: tx.from,
    toAddress: tx.to,
    chain,
    amountUsd,
    txHash: tx.hash,
    timestamp: Date.now(),
  };

  insertWalletTransfer(transfer);

  console.log(
    `[Traders] Transfer detected: ${trader.address.slice(0, 8)}... -> ${tx.to.slice(0, 8)}... ($${amountUsd.toFixed(0)})`
  );
}

async function processTraderTx(
  chain: Chain,
  tx: ethers.TransactionResponse,
  traders: Trader[]
): Promise<void> {
  const trader = traders.find((t) => t.address.toLowerCase() === tx.from?.toLowerCase());
  if (!trader) return;

  const trade: TraderTrade = {
    id: `${chain}_${tx.hash}`,
    walletAddress: trader.address,
    chain,
    tokenAddress: tx.to || "",
    type: "BUY",
    amountUsd: (Number(tx.value) / 1e18) * getChainNativePrice(chain),
    price: 0,
    txHash: tx.hash,
    timestamp: Date.now(),
  };

  if (alertExists(trade.id)) return;

  insertTraderTrade(trade);
  notifyCallbacks(trader, trade);

  console.log(
    `[Traders] New trade from ${trader.address.slice(0, 8)}... on ${chain}: ${trade.type} $${trade.amountUsd.toFixed(2)}`
  );
}

function getChainNativePrice(chain: Chain): number {
  const prices: Record<Chain, number> = {
    solana: 150,
    ethereum: 3500,
    polygon: 1,
    base: 3500,
  };
  return prices[chain] || 0;
}

function notifyCallbacks(trader: Trader, trade: TraderTrade): void {
  for (const callback of tradeCallbacks) {
    try {
      callback(trader, trade);
    } catch (err) {
      console.error("[Traders] Callback error:", err);
    }
  }
}

export function onTraderTrade(callback: TradeCallback): () => void {
  tradeCallbacks.add(callback);
  return () => tradeCallbacks.delete(callback);
}

export function isTrackerRunning(): boolean {
  return isRunning;
}

export function getTrackedTraderCount(): number {
  return getTopTraders(1000).length;
}

export async function addTraderWallet(address: string, chain: Chain): Promise<boolean> {
  const existing = getTrader(address, chain);
  if (existing) {
    console.log(`[Traders] Wallet ${address} already tracked on ${chain}`);
    return false;
  }

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
