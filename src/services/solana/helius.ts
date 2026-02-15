import { PublicKey } from "@solana/web3.js";
import { loadEnv } from "../../config/env.js";
import { getConnection } from "./wallet.js";
import { KNOWN_EXCHANGES } from "../traders/types.js";

// Helius enhanced transactions API base
const HELIUS_API_BASE = "https://api.helius.xyz/v0";

// Rate limiting: Helius free tier = 10 RPS, use 120ms interval for safety
const HELIUS_INTERVAL_MS = 120;
let heliusQueue: Promise<void> = Promise.resolve();

async function heliusRateLimitedFetch(url: string): Promise<Response> {
  const myTurn = heliusQueue.then(() => new Promise<void>((r) => setTimeout(r, HELIUS_INTERVAL_MS)));
  heliusQueue = myTurn;
  await myTurn;
  return fetch(url);
}

// Helius enhanced transaction response types
interface HeliusTokenTransfer {
  mint: string;
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount: number;
  tokenStandard?: string;
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  tokenTransfers?: HeliusTokenTransfer[];
  description?: string;
  fee?: number;
  feePayer?: string;
  source?: string;
}

// Known stablecoin mints to skip in history scanning
const SOLANA_STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112", // wSOL
]);

/**
 * Find early buyers of a Solana token using Helius enhanced transactions API.
 * Returns array of wallet addresses that received the token in early SWAP transactions.
 */
export async function findSolanaEarlyBuyers(tokenMint: string): Promise<string[]> {
  const env = loadEnv();
  const url = `${HELIUS_API_BASE}/addresses/${tokenMint}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP`;

  try {
    const response = await heliusRateLimitedFetch(url);
    if (!response.ok) {
      console.error(`[HeliusInsider] API error ${response.status} for ${tokenMint.slice(0, 8)}`);
      return [];
    }

    const transactions = (await response.json()) as HeliusTransaction[];
    if (!Array.isArray(transactions)) {
      return [];
    }

    // Take first 100 transactions (earliest buyers)
    const earlyTxs = transactions.slice(0, 100);
    const buyers = new Set<string>();
    const addressCounts = new Map<string, number>();

    // Count all appearances to filter out AMM pools/routers
    for (const tx of transactions) {
      if (!tx.tokenTransfers) continue;
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint === tokenMint && transfer.toUserAccount) {
          const addr = transfer.toUserAccount;
          addressCounts.set(addr, (addressCounts.get(addr) || 0) + 1);
        }
      }
    }

    const totalTransfers = transactions.length;
    const solanaExchanges = new Set(KNOWN_EXCHANGES.solana);

    // Extract unique buyers from early transactions
    for (const tx of earlyTxs) {
      if (!tx.tokenTransfers) continue;

      for (const transfer of tx.tokenTransfers) {
        // Look for transfers where wallet received this token
        if (transfer.mint === tokenMint && transfer.toUserAccount && transfer.tokenAmount > 0) {
          const buyer = transfer.toUserAccount;

          // Skip token mint itself
          if (buyer === tokenMint) continue;

          // Skip known exchanges
          if (solanaExchanges.has(buyer)) continue;

          // Skip addresses appearing in >50% of transfers (likely AMM/router)
          const count = addressCounts.get(buyer) || 0;
          if (totalTransfers > 10 && count / totalTransfers > 0.5) continue;

          buyers.add(buyer);
        }
      }
    }

    console.log(`[HeliusInsider] Found ${buyers.size} early buyers for ${tokenMint.slice(0, 8)}`);
    return Array.from(buyers);
  } catch (err) {
    console.error(`[HeliusInsider] Error finding buyers for ${tokenMint.slice(0, 8)}:`, err);
    return [];
  }
}

/**
 * Get wallet's buy/sell status for a specific Solana token.
 * Checks current balance via RPC and transaction history via Helius.
 */
export async function getSolanaWalletTokenStatus(
  walletAddress: string,
  tokenMint: string
): Promise<{
  buyTokens: number;
  sellTokens: number;
  status: "holding" | "sold" | "partial" | "transferred" | "unknown";
  buyDate: number;
  sellDate: number;
}> {
  let currentBalance = 0;
  let buyTokens = 0;
  let sellTokens = 0;
  let buyDate = 0;
  let sellDate = 0;

  try {
    // Step A: Check current balance via RPC
    const connection = getConnection();
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMint);

    const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, {
      mint: mintPubkey,
    });

    if (tokenAccounts.value.length > 0) {
      const accountInfo = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
      currentBalance = parseFloat(accountInfo.value.uiAmount?.toString() || "0");
    }

    // Step B: Get transaction history via Helius
    const env = loadEnv();
    const url = `${HELIUS_API_BASE}/addresses/${walletAddress}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP`;

    const response = await heliusRateLimitedFetch(url);
    if (!response.ok) {
      return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
    }

    const transactions = (await response.json()) as HeliusTransaction[];
    if (!Array.isArray(transactions)) {
      return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
    }

    // Analyze buys vs sells from transaction history
    for (const tx of transactions) {
      if (!tx.tokenTransfers) continue;

      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== tokenMint) continue;

        const amount = transfer.tokenAmount || 0;

        // Buy: wallet received tokens
        if (transfer.toUserAccount === walletAddress) {
          buyTokens += amount;
          if (!buyDate) buyDate = tx.timestamp * 1000;
        }

        // Sell: wallet sent tokens
        if (transfer.fromUserAccount === walletAddress) {
          sellTokens += amount;
          sellDate = tx.timestamp * 1000;
        }
      }
    }

    // Determine status
    let status: "holding" | "sold" | "partial" | "transferred" | "unknown";

    if (currentBalance > 0) {
      status = "holding";
    } else if (buyTokens === 0 && sellTokens === 0) {
      status = "unknown";
    } else if (sellTokens > 0.9 * buyTokens) {
      status = "sold";
    } else if (sellTokens < 0.1 * buyTokens) {
      status = "holding"; // Fallback if RPC failed but history shows mostly holding
    } else {
      status = "partial";
    }

    return { buyTokens, sellTokens, status, buyDate, sellDate };
  } catch (err) {
    console.error(`[HeliusInsider] Error getting token status for ${walletAddress.slice(0, 8)}:`, err);
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }
}

/**
 * Scan Solana wallet's full transaction history to discover all tokens traded.
 * Returns array of unique tokens with their first transaction timestamp.
 */
export async function scanSolanaWalletHistory(
  walletAddress: string
): Promise<Array<{ tokenAddress: string; symbol: string; firstTx: number }>> {
  const env = loadEnv();
  const url = `${HELIUS_API_BASE}/addresses/${walletAddress}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP`;

  try {
    const response = await heliusRateLimitedFetch(url);
    if (!response.ok) {
      console.error(`[HeliusInsider] API error ${response.status} for wallet ${walletAddress.slice(0, 8)}`);
      return [];
    }

    const transactions = (await response.json()) as HeliusTransaction[];
    if (!Array.isArray(transactions)) {
      return [];
    }

    // Build map of unique token mints
    const tokenMap = new Map<string, { symbol: string; firstTx: number }>();

    for (const tx of transactions) {
      if (!tx.tokenTransfers) continue;

      for (const transfer of tx.tokenTransfers) {
        const mint = transfer.mint;

        // Skip stablecoins and native SOL
        if (SOLANA_STABLECOINS.has(mint)) continue;

        // Track unique mints with earliest timestamp
        if (!tokenMap.has(mint)) {
          tokenMap.set(mint, {
            symbol: "UNKNOWN", // Helius doesn't provide symbol in tokenTransfers
            firstTx: tx.timestamp * 1000,
          });
        }
      }
    }

    // Convert to array (capped at MAX_HISTORY_TOKENS in scanner.ts)
    const result = Array.from(tokenMap.entries()).map(([tokenAddress, info]) => ({
      tokenAddress,
      symbol: info.symbol,
      firstTx: info.firstTx,
    }));

    console.log(`[HeliusInsider] Wallet ${walletAddress.slice(0, 8)} history: ${result.length} unique tokens`);
    return result;
  } catch (err) {
    console.error(`[HeliusInsider] Error scanning history for ${walletAddress.slice(0, 8)}:`, err);
    return [];
  }
}
