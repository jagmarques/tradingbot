// Moralis API client for trader discovery
// Free tier: 40,000 Compute Units/day

import { loadEnv } from "../../config/env.js";
import { Chain } from "./types.js";

const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";

// Moralis chain identifiers
const MORALIS_CHAINS: Partial<Record<Chain, string>> = {
  base: "base",
  bnb: "bsc",
  arbitrum: "arbitrum",
  avalanche: "avalanche",
  // Solana requires different API endpoint (use Helius instead)
};

interface MoralisWalletPnl {
  address: string;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  total_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  total_losses: number;
  win_rate: number;
  avg_trade_size_usd: number;
  total_volume_usd: number;
}

interface MoralisTransfer {
  from_address: string;
  to_address: string;
  value: string;
  transaction_hash: string;
  block_timestamp: string;
}

interface MoralisTransferResponse {
  result: MoralisTransfer[];
  cursor?: string;
}

// Get API key from env
function getApiKey(): string | null {
  try {
    const env = loadEnv();
    return env.MORALIS_API_KEY || null;
  } catch {
    return null;
  }
}

// Check if Moralis is configured
export function isMoralisConfigured(): boolean {
  return getApiKey() !== null;
}

// Make Moralis API request
async function moralisRequest<T>(endpoint: string): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("[Moralis] API key not configured");
    return null;
  }

  const url = `${MORALIS_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Moralis] API error ${response.status}: ${errorText}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (err) {
    console.error("[Moralis] Request failed:", err);
    return null;
  }
}

// Get recent token transfers to find active traders
// Endpoint: GET /erc20/{token}/transfers
// CU Cost: ~5 per call
export async function getTokenTransfers(
  tokenAddress: string,
  chain: Chain,
  limit: number = 100
): Promise<MoralisTransfer[]> {
  const moralisChain = MORALIS_CHAINS[chain];
  if (!moralisChain) {
    return [];
  }

  const endpoint = `/erc20/${tokenAddress}/transfers?chain=${moralisChain}&limit=${limit}`;
  const result = await moralisRequest<MoralisTransferResponse>(endpoint);

  if (!result?.result) {
    return [];
  }

  return result.result;
}

// Get wallet PnL summary
// Endpoint: GET /wallets/{address}/profitability/summary
// CU Cost: ~10 per call
export async function getWalletPnlSummary(
  walletAddress: string,
  chain: Chain
): Promise<MoralisWalletPnl | null> {
  const moralisChain = MORALIS_CHAINS[chain];
  if (!moralisChain) {
    return null;
  }

  const endpoint = `/wallets/${walletAddress}/profitability/summary?chain=${moralisChain}&days=90`;
  const result = await moralisRequest<MoralisWalletPnl>(endpoint);

  return result;
}

// Discover traders by analyzing token transfer activity
// Strategy: Find wallets that actively trade trending tokens, then check their profitability
export async function discoverTradersFromTokens(
  chain: Chain,
  tokenAddresses: string[],
  maxWalletsToCheck: number = 30
): Promise<Map<string, MoralisWalletPnl>> {
  const walletActivity = new Map<string, number>();

  // Step 1: Collect wallet addresses from token transfers
  for (const token of tokenAddresses.slice(0, 10)) {
    // Check first 10 tokens
    const transfers = await getTokenTransfers(token, chain, 50);

    for (const transfer of transfers) {
      // Track wallets that are buying (receiving tokens)
      if (transfer.to_address) {
        const addr = transfer.to_address.toLowerCase();
        walletActivity.set(addr, (walletActivity.get(addr) || 0) + 1);
      }
    }

    // Rate limit: 100ms between requests
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`[Moralis] Found ${walletActivity.size} active wallets on ${chain}`);

  // Step 2: Sort by activity and check top wallets' profitability
  const sortedWallets = Array.from(walletActivity.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWalletsToCheck)
    .map(([addr]) => addr);

  const profitableTraders = new Map<string, MoralisWalletPnl>();

  for (const wallet of sortedWallets) {
    const pnl = await getWalletPnlSummary(wallet, chain);

    if (pnl && pnl.total_trades >= 10 && pnl.win_rate >= 80 && pnl.total_pnl_usd > 500) {
      profitableTraders.set(wallet, pnl);
      console.log(
        `[Moralis] +${chain.toUpperCase()} ${wallet.slice(0, 8)}... (${pnl.win_rate.toFixed(0)}% win, $${pnl.total_pnl_usd.toFixed(0)})`
      );
    }

    // Rate limit: 150ms between requests
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`[Moralis] Discovered ${profitableTraders.size} profitable traders on ${chain}`);

  return profitableTraders;
}

// Re-export dynamic token fetching from DexScreener
// Tokens are fetched in real-time based on volume and price action
export { getActiveTokens as getPopularTokens } from "./dexscreener.js";

// Export types for external use
export type { MoralisWalletPnl, MoralisTransfer };
