import { loadEnv } from "../../config/env.js";
import { Chain } from "./types.js";

const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";

// Moralis profitability supports: Ethereum, Polygon, Base
const SUPPORTED_CHAINS: Record<string, string> = {
  ethereum: "eth",
  polygon: "polygon",
  base: "base",
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

function getApiKey(): string | null {
  try {
    const env = loadEnv();
    return env.MORALIS_API_KEY || null;
  } catch {
    return null;
  }
}

export function isMoralisConfigured(): boolean {
  return getApiKey() !== null;
}

export function isMoralisChainSupported(chain: Chain): boolean {
  return chain in SUPPORTED_CHAINS;
}

async function moralisRequest<T>(endpoint: string): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const url = `${MORALIS_BASE_URL}${endpoint}`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });

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

export async function getTokenTransfers(
  tokenAddress: string,
  chain: Chain,
  limit: number = 100
): Promise<MoralisTransfer[]> {
  const chainId = SUPPORTED_CHAINS[chain];
  if (!chainId) return [];

  const endpoint = `/erc20/${tokenAddress}/transfers?chain=${chainId}&limit=${limit}`;
  const result = await moralisRequest<MoralisTransferResponse>(endpoint);

  return result?.result || [];
}

export async function getWalletPnlSummary(
  walletAddress: string,
  chain: Chain
): Promise<MoralisWalletPnl | null> {
  const chainId = SUPPORTED_CHAINS[chain];
  if (!chainId) return null;

  const endpoint = `/wallets/${walletAddress}/profitability/summary?chain=${chainId}&days=90`;
  return moralisRequest<MoralisWalletPnl>(endpoint);
}

export async function discoverTradersFromTokens(
  chain: Chain,
  tokenAddresses: string[]
): Promise<Map<string, MoralisWalletPnl>> {
  const profitableTraders = new Map<string, MoralisWalletPnl>();

  if (!isMoralisChainSupported(chain)) {
    console.log(`[Moralis] Chain ${chain} not supported`);
    return profitableTraders;
  }

  const walletActivity = new Map<string, number>();

  for (const token of tokenAddresses) {
    const transfers = await getTokenTransfers(token, chain, 200);

    for (const transfer of transfers) {
      if (transfer.to_address) {
        const addr = transfer.to_address.toLowerCase();
        walletActivity.set(addr, (walletActivity.get(addr) || 0) + 1);
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`[Moralis] Found ${walletActivity.size} active wallets on ${chain}`);

  const sortedWallets = Array.from(walletActivity.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([addr]) => addr);

  for (const wallet of sortedWallets) {
    const pnl = await getWalletPnlSummary(wallet, chain);

    if (pnl && pnl.total_trades >= 10 && pnl.win_rate >= 80 && pnl.total_pnl_usd > 500) {
      profitableTraders.set(wallet, pnl);
      console.log(
        `[Moralis] +${chain.toUpperCase()} ${wallet.slice(0, 8)}... (${pnl.win_rate.toFixed(0)}% win, $${pnl.total_pnl_usd.toFixed(0)})`
      );
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`[Moralis] Discovered ${profitableTraders.size} profitable traders on ${chain}`);

  return profitableTraders;
}

export { getActiveTokens as getPopularTokens } from "./dexscreener.js";

export type { MoralisWalletPnl, MoralisTransfer };
