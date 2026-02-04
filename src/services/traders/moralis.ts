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
  // Solana requires different API endpoint
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

interface MoralisTopTrader {
  owner_address: string;
  realized_profit_usd: number;
  realized_profit_percentage: number;
  count_of_trades: number;
  avg_buy_price_usd: number;
  avg_sell_price_usd: number;
}

interface MoralisTokenProfitability {
  result: MoralisTopTrader[];
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
async function moralisRequest<T>(endpoint: string, chain?: string): Promise<T | null> {
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

  if (chain) {
    headers["chain"] = chain;
  }

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Moralis] API error ${response.status}: ${errorText}`);
      return null;
    }

    return await response.json() as T;
  } catch (err) {
    console.error("[Moralis] Request failed:", err);
    return null;
  }
}

// Get top profitable wallets for a specific token
// Endpoint: GET /erc20/{token_address}/top-gainers
// CU Cost: ~10 per call
export async function getTopTradersForToken(
  tokenAddress: string,
  chain: Chain,
  limit: number = 50
): Promise<MoralisTopTrader[]> {
  const moralisChain = MORALIS_CHAINS[chain];
  if (!moralisChain) {
    console.log(`[Moralis] Chain ${chain} not supported`);
    return [];
  }

  const endpoint = `/erc20/${tokenAddress}/top-gainers?chain=${moralisChain}&limit=${limit}`;
  const result = await moralisRequest<MoralisTokenProfitability>(endpoint);

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
    console.log(`[Moralis] Chain ${chain} not supported`);
    return null;
  }

  const endpoint = `/wallets/${walletAddress}/profitability/summary?chain=${moralisChain}`;
  const result = await moralisRequest<MoralisWalletPnl>(endpoint);

  return result;
}

// Get wallet detailed PnL breakdown by token
// Endpoint: GET /wallets/{address}/profitability
// CU Cost: ~15 per call
interface MoralisWalletTokenPnl {
  token_address: string;
  token_symbol: string;
  token_name: string;
  realized_profit_usd: number;
  realized_profit_percentage: number;
  total_tokens_bought: number;
  total_tokens_sold: number;
  avg_buy_price_usd: number;
  avg_sell_price_usd: number;
  count_of_trades: number;
}

interface MoralisWalletProfitability {
  result: MoralisWalletTokenPnl[];
  cursor?: string;
}

export async function getWalletTokenPnl(
  walletAddress: string,
  chain: Chain,
  limit: number = 100
): Promise<MoralisWalletTokenPnl[]> {
  const moralisChain = MORALIS_CHAINS[chain];
  if (!moralisChain) {
    console.log(`[Moralis] Chain ${chain} not supported`);
    return [];
  }

  const endpoint = `/wallets/${walletAddress}/profitability?chain=${moralisChain}&limit=${limit}`;
  const result = await moralisRequest<MoralisWalletProfitability>(endpoint);

  if (!result?.result) {
    return [];
  }

  return result.result;
}

// Discover profitable traders from popular tokens on a chain
// Returns wallets that consistently profit across multiple tokens
export async function discoverProfitableTraders(
  chain: Chain,
  popularTokens: string[],
  minTrades: number = 10,
  _minWinRate: number = 55 // Reserved for future filtering
): Promise<Map<string, { totalProfit: number; tradeCount: number; tokens: number }>> {
  const traderStats = new Map<string, { totalProfit: number; tradeCount: number; tokens: number }>();

  for (const token of popularTokens) {
    const topTraders = await getTopTradersForToken(token, chain, 100);

    for (const trader of topTraders) {
      if (trader.count_of_trades < 3) continue; // Skip low activity

      const existing = traderStats.get(trader.owner_address) || {
        totalProfit: 0,
        tradeCount: 0,
        tokens: 0,
      };

      existing.totalProfit += trader.realized_profit_usd;
      existing.tradeCount += trader.count_of_trades;
      existing.tokens += 1;

      traderStats.set(trader.owner_address, existing);
    }

    // Rate limiting: 100ms between requests
    await new Promise((r) => setTimeout(r, 100));
  }

  // Filter to traders meeting criteria
  const qualified = new Map<string, { totalProfit: number; tradeCount: number; tokens: number }>();

  for (const [address, stats] of traderStats) {
    if (stats.tradeCount >= minTrades && stats.tokens >= 2 && stats.totalProfit > 0) {
      qualified.set(address, stats);
    }
  }

  console.log(
    `[Moralis] Discovered ${qualified.size} profitable traders from ${popularTokens.length} tokens on ${chain}`
  );

  return qualified;
}

// Re-export dynamic token fetching from DexScreener
// Tokens are fetched in real-time based on volume and price action
export { getActiveTokens as getPopularTokens } from "./dexscreener.js";

// Export types for external use
export type { MoralisWalletPnl, MoralisTopTrader, MoralisWalletTokenPnl };
