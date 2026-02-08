// Helius API client for Solana trader discovery
import { loadEnv } from "../../config/env.js";

const HELIUS_BASE_URL = "https://api.helius.xyz/v0";

// Rate limiting for Helius API with queue (10 req/sec = 100ms intervals, using 120ms for safety)
const MIN_HELIUS_INTERVAL_MS = 120;
let heliusFetchQueue: Promise<void> = Promise.resolve();

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const myTurn = heliusFetchQueue.then(async () => {
    await new Promise((r) => setTimeout(r, MIN_HELIUS_INTERVAL_MS));
  });
  heliusFetchQueue = myTurn;
  await myTurn;
  return fetch(url, options);
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  tokenTransfers: {
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    amount: number;
  }[];
  nativeTransfers: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
}

interface HeliusEnrichedTransaction {
  signature: string;
  timestamp: number;
  type: string;
  description: string;
  accountData: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: {
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
      userAccount: string;
    }[];
  }[];
}

// Get API key
function getApiKey(): string {
  const env = loadEnv();
  return env.HELIUS_API_KEY;
}

// Check if Helius is configured
export function isHeliusConfigured(): boolean {
  try {
    const key = getApiKey();
    return key.length > 0;
  } catch {
    return false;
  }
}

// Get wallet transaction history
export async function getWalletTransactions(
  walletAddress: string,
  limit: number = 100
): Promise<HeliusEnrichedTransaction[]> {
  const apiKey = getApiKey();
  const url = `${HELIUS_BASE_URL}/addresses/${walletAddress}/transactions?api-key=${apiKey}&limit=${limit}`;

  try {
    const response = await rateLimitedFetch(url);
    if (!response.ok) {
      console.error(`[Helius] API error ${response.status}`);
      return [];
    }
    return (await response.json()) as HeliusEnrichedTransaction[];
  } catch (err) {
    console.error("[Helius] Request failed:", err);
    return [];
  }
}

// Get token holders (to find active traders)
export async function getTokenHolders(
  mintAddress: string,
  limit: number = 100
): Promise<string[]> {
  const apiKey = getApiKey();
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  try {
    const response = await rateLimitedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [mintAddress],
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      result?: { value?: { address: string; amount: string }[] };
    };
    return data.result?.value?.map((v) => v.address).slice(0, limit) || [];
  } catch (err) {
    console.error("[Helius] Token holders error:", err);
    return [];
  }
}

// Analyze wallet profitability from transaction history
export interface WalletPnlAnalysis {
  address: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnlSol: number;
  winRate: number;
  avgTradeSize: number;
}

export async function analyzeWalletPnl(walletAddress: string): Promise<WalletPnlAnalysis | null> {
  const transactions = await getWalletTransactions(walletAddress, 200);

  if (transactions.length === 0) {
    return null;
  }

  // Analyze SOL balance changes per transaction
  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalPnlSol = 0;
  let totalVolume = 0;

  // Group transactions by token to calculate trade outcomes
  const tokenTrades = new Map<string, { buys: number[]; sells: number[] }>();

  for (const tx of transactions) {
    // Skip if no account data
    if (!tx.accountData) continue;

    // Find wallet's balance change
    const walletData = tx.accountData.find(
      (a) => a.account.toLowerCase() === walletAddress.toLowerCase()
    );

    if (!walletData) continue;

    const solChange = walletData.nativeBalanceChange / 1e9; // lamports to SOL

    // Track token swaps
    if (tx.type === "SWAP" || tx.description?.includes("swap")) {
      totalTrades++;
      totalVolume += Math.abs(solChange);

      if (solChange > 0.001) {
        // Gained SOL = profitable trade
        winningTrades++;
        totalPnlSol += solChange;
      } else if (solChange < -0.001) {
        // Lost SOL = losing trade (or buy, need to track)
        // For buys, we spend SOL but get tokens
        // For sells at loss, we get less SOL back

        // Track token changes to determine if buy or sell
        for (const tokenChange of walletData.tokenBalanceChanges || []) {
          const mint = tokenChange.mint;
          const amount = parseFloat(tokenChange.rawTokenAmount.tokenAmount);

          if (!tokenTrades.has(mint)) {
            tokenTrades.set(mint, { buys: [], sells: [] });
          }

          const trades = tokenTrades.get(mint);
          if (!trades) continue;
          if (amount > 0) {
            // Received tokens = buy
            trades.buys.push(Math.abs(solChange));
          } else {
            // Sent tokens = sell
            trades.sells.push(Math.abs(solChange));
          }
        }
      }
    }
  }

  // Calculate PnL from matched trades
  for (const trades of tokenTrades.values()) {
    // Simple FIFO matching
    const buys = [...trades.buys];
    const sells = [...trades.sells];

    while (buys.length > 0 && sells.length > 0) {
      const buyPrice = buys.shift();
      const sellPrice = sells.shift();
      if (buyPrice === undefined || sellPrice === undefined) break;
      const pnl = sellPrice - buyPrice;

      if (pnl > 0) {
        winningTrades++;
        totalPnlSol += pnl;
      } else {
        losingTrades++;
        totalPnlSol += pnl; // negative
      }
    }
  }

  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  return {
    address: walletAddress,
    totalTrades,
    winningTrades,
    losingTrades,
    totalPnlSol,
    winRate,
    avgTradeSize: totalTrades > 0 ? totalVolume / totalTrades : 0,
  };
}

// Get recent Solana token launches to find early buyers
export async function getRecentSolanaTokens(limit: number = 20): Promise<string[]> {
  // Pump.fun program ID (used to find new token launches)
  const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const apiKey = getApiKey();

  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  try {
    // Get recent signatures for token launches
    const response = await rateLimitedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [PUMPFUN_PROGRAM, { limit }],
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      result?: { signature: string }[];
    };

    // Extract unique token mints from these transactions
    const signatures = data.result?.map((r) => r.signature) || [];
    const mints = new Set<string>();

    for (const sig of signatures.slice(0, 10)) {
      // Parse first 10 for tokens
      const txResponse = await rateLimitedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });

      if (txResponse.ok) {
        const txData = (await txResponse.json()) as {
          result?: {
            meta?: {
              postTokenBalances?: { mint: string }[];
            };
          };
        };
        const balances = txData.result?.meta?.postTokenBalances || [];
        for (const bal of balances) {
          if (bal.mint && bal.mint !== "So11111111111111111111111111111111111111112") {
            mints.add(bal.mint);
          }
        }
      }
    }

    return Array.from(mints);
  } catch (err) {
    console.error("[Helius] Token discovery error:", err);
    return [];
  }
}

// Find early buyers of a token (potential good traders)
export async function findEarlyBuyers(mintAddress: string, limit: number = 50): Promise<string[]> {
  const apiKey = getApiKey();
  const url = `${HELIUS_BASE_URL}/tokens/${mintAddress}/transactions?api-key=${apiKey}&limit=${limit}&type=SWAP`;

  try {
    const response = await rateLimitedFetch(url);
    if (!response.ok) {
      return [];
    }

    const transactions = (await response.json()) as HeliusTransaction[];

    // Get unique buyer addresses (earliest first)
    const buyers = new Set<string>();
    for (const tx of transactions) {
      for (const transfer of tx.tokenTransfers || []) {
        if (transfer.toUserAccount && transfer.amount > 0) {
          buyers.add(transfer.toUserAccount);
        }
      }
      if (buyers.size >= limit) break;
    }

    return Array.from(buyers);
  } catch (err) {
    console.error("[Helius] Early buyers error:", err);
    return [];
  }
}
