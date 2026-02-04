import { Chain, TRADER_THRESHOLDS, BIG_HITTER_THRESHOLDS } from "./types.js";
import { getDb } from "../database/db.js";

// Etherscan API V2 - unified multichain endpoint
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Chain IDs for Etherscan V2 API (free tier only)
// Paid chains removed: base (8453), bsc (56), optimism (10), avalanche (43114)
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  sonic: 146,
};


// Quote tokens (stables + WETH) with decimals
const QUOTE_TOKEN_DECIMALS: Record<string, number> = {
  // Ethereum
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6,  // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6,  // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f": 18, // DAI
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": 18, // WETH
  // Polygon
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": 6,  // USDT
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": 6,  // USDC.e
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6,  // USDC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": 18, // WETH
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": 18, // WMATIC
  // Arbitrum
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6,  // USDT
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6,  // USDC
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": 6,  // USDC.e
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18, // WETH
  // Sonic
  "0x29219dd400f2bf60e5a23d13be72b486d4038894": 6,  // USDC.e
  "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38": 18, // wS (wrapped Sonic)
};

const QUOTE_TOKENS = new Set(Object.keys(QUOTE_TOKEN_DECIMALS));

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

// Analyze wallet trades and calculate PnL using stablecoin flows
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

  // Group transfers by transaction hash to find token<->stablecoin swaps
  const txGroups = new Map<string, TokenTransfer[]>();
  for (const tx of transfers) {
    if (!txGroups.has(tx.hash)) {
      txGroups.set(tx.hash, []);
    }
    txGroups.get(tx.hash)!.push(tx);
  }

  // Track USD spent/received per token
  const tokenPnl = new Map<string, { spent: number; received: number }>();

  for (const [, txTransfers] of txGroups) {
    const quoteTransfers = txTransfers.filter((t) => QUOTE_TOKENS.has(t.tokenAddress));
    const tokenTransfers = txTransfers.filter((t) => !QUOTE_TOKENS.has(t.tokenAddress));

    if (quoteTransfers.length === 0 || tokenTransfers.length === 0) continue;

    for (const quoteTx of quoteTransfers) {
      const decimals = QUOTE_TOKEN_DECIMALS[quoteTx.tokenAddress] || 18;
      const usdAmount = parseFloat(quoteTx.value) / Math.pow(10, decimals);
      if (usdAmount < 1) continue;

      for (const tokenTx of tokenTransfers) {
        if (!tokenPnl.has(tokenTx.tokenAddress)) {
          tokenPnl.set(tokenTx.tokenAddress, { spent: 0, received: 0 });
        }
        const pnl = tokenPnl.get(tokenTx.tokenAddress)!;

        // BUY: quote OUT, token IN
        if (quoteTx.from === walletLower && tokenTx.to === walletLower) {
          pnl.spent += usdAmount;
        }
        // SELL: token OUT, quote IN
        else if (quoteTx.to === walletLower && tokenTx.from === walletLower) {
          pnl.received += usdAmount;
        }
      }
    }
  }

  // Calculate P&L per token
  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalPnlUsd = 0;

  for (const [, { spent, received }] of tokenPnl) {
    // Only count as trade if both bought and sold
    if (spent < 10 || received < 10) continue;

    totalTrades++;
    const pnl = received - spent;
    totalPnlUsd += pnl;

    if (pnl > 0) {
      winningTrades++;
    } else {
      losingTrades++;
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

  const sortedWallets = Array.from(walletActivity.entries())
    .filter(([addr]) => !QUOTE_TOKENS.has(addr))
    .sort((a, b) => b[1] - a[1])
    .map(([addr]) => addr);

  let checked = 0;
  for (const wallet of sortedWallets) {
    const profitability = await analyzeWalletPnl(wallet, chain);
    checked++;

    if (!profitability) continue;

    // Check if meets standard trader thresholds (20+ trades, 80%+ win rate)
    const isStandardTrader =
      profitability.totalTrades >= TRADER_THRESHOLDS.MIN_TRADES &&
      profitability.winRate >= TRADER_THRESHOLDS.MIN_WIN_RATE * 100;

    // Check if meets big hitter thresholds (3-19 trades, 80%+ win, $5000+ PnL)
    const isBigHitter =
      profitability.totalTrades >= BIG_HITTER_THRESHOLDS.MIN_TRADES &&
      profitability.totalTrades < TRADER_THRESHOLDS.MIN_TRADES &&
      profitability.winRate >= BIG_HITTER_THRESHOLDS.MIN_WIN_RATE * 100 &&
      profitability.totalPnlUsd >= BIG_HITTER_THRESHOLDS.MIN_TOTAL_PNL_USD;

    if (isStandardTrader || isBigHitter) {
      profitableTraders.set(wallet, profitability);
      const type = isStandardTrader ? "TRADER" : "BIG_HIT";
      console.log(
        `[Etherscan] +${chain.toUpperCase()} [${type}] ${wallet.slice(0, 8)}... (${profitability.winRate.toFixed(0)}% win, ${profitability.totalTrades} trades, $${profitability.totalPnlUsd.toFixed(0)})`
      );
    }
  }

  console.log(`[Etherscan] Checked ${checked} wallets, found ${profitableTraders.size} profitable on ${chain}`);
  return profitableTraders;
}

// Check if Etherscan is configured (V2 requires API key)
export function isEtherscanConfigured(): boolean {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[Etherscan] ETHERSCAN_API_KEY not set - EVM discovery disabled");
    return false;
  }
  return true;
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
