import { Chain } from "./types.js";
import { getDb } from "../database/db.js";

// Etherscan API V2 - unified multichain endpoint
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Chain IDs for Etherscan V2 API
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  polygon: 137,
  base: 8453,
  arbitrum: 42161,
  bsc: 56,
  optimism: 10,
  avalanche: 43114,
  sonic: 146,
};


// Stablecoins to identify quote currency (all chains)
const STABLECOINS = new Set([
  // Ethereum
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  // Polygon
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC.e
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  // Arbitrum
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e
  // BSC
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  // Optimism
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // USDT
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC
  "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // USDC.e
  // Avalanche
  "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDT
  "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC
  // Sonic
  "0x29219dd400f2bf60e5a23d13be72b486d4038894", // USDC.e
]);

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  tokenSymbol: string;
  value: string;
  timestamp: number;
}

interface WalletProfitability {
  address: string;
  chain: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnlUsd: number;
  winRate: number;
  lastUpdated: number;
}

// Per-chain rate limiting with proper queue (each explorer has separate 5 calls/sec limit)
const MIN_REQUEST_INTERVAL_MS = 220; // ~4.5 requests/sec per chain
const fetchQueueByChain = new Map<string, Promise<void>>();

async function rateLimitedFetch(url: string, chain: string): Promise<Response> {
  // Get or create queue for this chain
  const currentQueue = fetchQueueByChain.get(chain) || Promise.resolve();

  // Chain onto the queue to ensure sequential execution per chain
  const myTurn = currentQueue.then(async () => {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
  });
  fetchQueueByChain.set(chain, myTurn);
  await myTurn;
  return fetch(url);
}

function getApiKey(): string | null {
  // Etherscan V2 uses single API key for all chains
  return process.env.ETHERSCAN_API_KEY || null;
}

// Initialize profitability cache table
export function initProfitabilityCache(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_profitability (
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      total_trades INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      total_pnl_usd REAL DEFAULT 0,
      win_rate REAL DEFAULT 0,
      last_updated INTEGER NOT NULL,
      PRIMARY KEY (address, chain)
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_profitability_chain ON wallet_profitability(chain);
  `);
  console.log("[Etherscan] Profitability cache initialized");
}

// Get cached profitability (valid for 24 hours)
export function getCachedProfitability(address: string, chain: string): WalletProfitability | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM wallet_profitability
       WHERE address = ? AND chain = ? AND last_updated > ?`
    )
    .get(address.toLowerCase(), chain, Date.now() - 24 * 60 * 60 * 1000) as WalletProfitability | undefined;

  return row || null;
}

// Save profitability to cache
function saveProfitability(prof: WalletProfitability): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO wallet_profitability
     (address, chain, total_trades, winning_trades, losing_trades, total_pnl_usd, win_rate, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    prof.address.toLowerCase(),
    prof.chain,
    prof.totalTrades,
    prof.winningTrades,
    prof.losingTrades,
    prof.totalPnlUsd,
    prof.winRate,
    prof.lastUpdated
  );
}

// Fetch ERC-20 token transfers for a wallet
async function getTokenTransfers(
  wallet: string,
  chain: string,
  startBlock: number = 0
): Promise<TokenTransfer[]> {
  const chainId = CHAIN_IDS[chain];
  const apiKey = getApiKey();

  if (!chainId) return [];

  const url = `${ETHERSCAN_V2_URL}?chainid=${chainId}&module=account&action=tokentx&address=${wallet}&startblock=${startBlock}&endblock=99999999&sort=asc${apiKey ? `&apikey=${apiKey}` : ""}`;

  try {
    const response = await rateLimitedFetch(url, chain);
    const data = (await response.json()) as { status: string; result: Record<string, string>[] };

    if (data.status !== "1" || !Array.isArray(data.result)) {
      console.log(`[Etherscan] ${chain} response: ${JSON.stringify(data).slice(0, 200)}`);
      return [];
    }

    return data.result.map((tx) => ({
      hash: tx.hash,
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      tokenAddress: tx.contractAddress.toLowerCase(),
      tokenSymbol: tx.tokenSymbol,
      value: tx.value,
      timestamp: parseInt(tx.timeStamp) * 1000,
    }));
  } catch (err) {
    console.error(`[Etherscan] Error fetching transfers for ${wallet}:`, err);
    return [];
  }
}

// Analyze wallet trades and calculate PnL
export async function analyzeWalletPnl(
  wallet: string,
  chain: Chain
): Promise<WalletProfitability | null> {
  const walletLower = wallet.toLowerCase();

  // Check cache first
  const cached = getCachedProfitability(walletLower, chain);
  if (cached) {
    return cached;
  }

  // Fetch token transfers
  const transfers = await getTokenTransfers(walletLower, chain);

  if (transfers.length === 0) {
    return null;
  }

  // Group by token to track buys/sells
  const tokenTrades = new Map<
    string,
    { buys: TokenTransfer[]; sells: TokenTransfer[] }
  >();

  for (const tx of transfers) {
    // Skip stablecoins - we use them as quote currency
    if (STABLECOINS.has(tx.tokenAddress)) continue;

    if (!tokenTrades.has(tx.tokenAddress)) {
      tokenTrades.set(tx.tokenAddress, { buys: [], sells: [] });
    }

    const trades = tokenTrades.get(tx.tokenAddress)!;

    // Incoming = buy, outgoing = sell
    if (tx.to === walletLower) {
      trades.buys.push(tx);
    } else if (tx.from === walletLower) {
      trades.sells.push(tx);
    }
  }

  // Calculate P&L per token
  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalPnlUsd = 0;

  for (const [, { buys, sells }] of tokenTrades) {
    if (buys.length === 0 || sells.length === 0) continue;

    // Simple PnL: compare total buy value vs total sell value
    // Note: This is approximate - real calculation would need USD prices at time of trade
    const totalBought = buys.reduce((sum, b) => sum + parseFloat(b.value), 0);
    const totalSold = sells.reduce((sum, s) => sum + parseFloat(s.value), 0);

    // If sold more than bought (in token terms), it's likely profitable
    // This is a heuristic - selling at higher price means more tokens per USD
    if (totalSold > 0 && totalBought > 0) {
      totalTrades++;

      // Rough heuristic: if sold amount > 80% of bought, consider it a completed trade
      const ratio = totalSold / totalBought;
      if (ratio > 0.8) {
        if (ratio > 1.05) {
          // Sold more tokens than bought = likely bought low, sold high
          winningTrades++;
          totalPnlUsd += 10; // Placeholder - real calc needs price data
        } else if (ratio < 0.95) {
          losingTrades++;
          totalPnlUsd -= 5;
        }
      }
    }
  }

  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const profitability: WalletProfitability = {
    address: walletLower,
    chain,
    totalTrades,
    winningTrades,
    losingTrades,
    totalPnlUsd,
    winRate,
    lastUpdated: Date.now(),
  };

  // Cache result
  saveProfitability(profitability);

  return profitability;
}

// Discover profitable traders from token transfers
export async function discoverTradersFromTokens(
  chain: Chain,
  tokenAddresses: string[]
): Promise<Map<string, WalletProfitability>> {
  const profitableTraders = new Map<string, WalletProfitability>();

  console.log(`[Etherscan] Analyzing ${tokenAddresses.length} tokens on ${chain}`);

  // Collect active wallets from token transfers
  const walletActivity = new Map<string, number>();

  for (const token of tokenAddresses) {
    const transfers = await getTokenTransfers(token, chain);

    for (const tx of transfers) {
      // Track both sender and receiver
      walletActivity.set(tx.from, (walletActivity.get(tx.from) || 0) + 1);
      walletActivity.set(tx.to, (walletActivity.get(tx.to) || 0) + 1);
    }
  }

  console.log(`[Etherscan] Found ${walletActivity.size} active wallets on ${chain}`);

  // Sort by activity and analyze top wallets
  const sortedWallets = Array.from(walletActivity.entries())
    .filter(([addr]) => !STABLECOINS.has(addr)) // Skip stablecoin contracts
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100) // Analyze top 100 most active
    .map(([addr]) => addr);

  let checked = 0;
  for (const wallet of sortedWallets) {
    const profitability = await analyzeWalletPnl(wallet, chain);
    checked++;

    if (
      profitability &&
      profitability.totalTrades >= 5 &&
      profitability.winRate >= 80
    ) {
      profitableTraders.set(wallet, profitability);
      console.log(
        `[Etherscan] +${chain.toUpperCase()} ${wallet.slice(0, 8)}... (${profitability.winRate.toFixed(0)}% win, ${profitability.totalTrades} trades)`
      );
    }
  }

  console.log(`[Etherscan] Checked ${checked} wallets, found ${profitableTraders.size} profitable on ${chain}`);
  return profitableTraders;
}

// Check if Etherscan is configured (works without API key, just slower)
export function isEtherscanConfigured(): boolean {
  return true; // Always available, API key just increases rate limit
}

// Cleanup old cache entries (run periodically)
export function cleanupCache(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;

  const result = db
    .prepare("DELETE FROM wallet_profitability WHERE last_updated < ?")
    .run(cutoff);

  if (result.changes > 0) {
    console.log(`[Etherscan] Cleaned ${result.changes} old cache entries`);
  }

  return result.changes;
}

// Re-export for compatibility
export { getActiveTokens as getPopularTokens } from "./dexscreener.js";

export type { WalletProfitability };
