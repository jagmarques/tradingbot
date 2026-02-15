import { PublicKey } from "@solana/web3.js";
import { loadEnv } from "../../config/env.js";
import { getConnection } from "./wallet.js";
import { KNOWN_EXCHANGES } from "../traders/types.js";

const HELIUS_API_BASE = "https://api.helius.xyz/v0";
const HELIUS_INTERVAL_MS = 1000;
const HELIUS_COOLDOWN_MS = 30 * 60 * 1000; // 30 min backoff on 429

let heliusQueue: Promise<void> = Promise.resolve();
let heliusCooldownUntil = 0;

function isHeliusCoolingDown(): boolean {
  return Date.now() < heliusCooldownUntil;
}

async function heliusRateLimitedFetch(url: string): Promise<Response | null> {
  if (isHeliusCoolingDown()) return null;

  const myTurn = heliusQueue.then(() => new Promise<void>((r) => setTimeout(r, HELIUS_INTERVAL_MS)));
  heliusQueue = myTurn;
  await myTurn;

  const response = await fetch(url);
  if (response.status === 429) {
    heliusCooldownUntil = Date.now() + HELIUS_COOLDOWN_MS;
    const resumeTime = new Date(heliusCooldownUntil).toISOString().slice(11, 16);
    console.log(`[HeliusInsider] Rate limited, pausing until ${resumeTime} UTC`);
    return null;
  }
  return response;
}

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

const SOLANA_STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112", // wSOL
]);

export async function findSolanaEarlyBuyers(tokenMint: string): Promise<string[]> {
  const env = loadEnv();
  const url = `${HELIUS_API_BASE}/addresses/${tokenMint}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP&sort-order=asc`;

  try {
    const response = await heliusRateLimitedFetch(url);
    if (!response || !response.ok) return [];

    const transactions = (await response.json()) as HeliusTransaction[];
    if (!Array.isArray(transactions)) return [];

    const earlyTxs = transactions.slice(0, 100);
    const buyers = new Set<string>();
    const addressCounts = new Map<string, number>();

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

    for (const tx of earlyTxs) {
      if (!tx.tokenTransfers) continue;
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint === tokenMint && transfer.toUserAccount && transfer.tokenAmount > 0) {
          const buyer = transfer.toUserAccount;
          if (buyer === tokenMint) continue;
          if (solanaExchanges.has(buyer)) continue;
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

    const env = loadEnv();
    const url = `${HELIUS_API_BASE}/addresses/${walletAddress}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP`;

    const response = await heliusRateLimitedFetch(url);
    if (!response || !response.ok) {
      // Still return balance-based status even if Helius is down
      if (currentBalance > 0) return { buyTokens: 0, sellTokens: 0, status: "holding", buyDate: 0, sellDate: 0 };
      return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
    }

    const transactions = (await response.json()) as HeliusTransaction[];
    if (!Array.isArray(transactions)) {
      return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
    }

    for (const tx of transactions) {
      if (!tx.tokenTransfers) continue;
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== tokenMint) continue;
        const amount = transfer.tokenAmount || 0;
        if (transfer.toUserAccount === walletAddress) {
          buyTokens += amount;
          if (!buyDate) buyDate = tx.timestamp * 1000;
        }
        if (transfer.fromUserAccount === walletAddress) {
          sellTokens += amount;
          sellDate = tx.timestamp * 1000;
        }
      }
    }

    let status: "holding" | "sold" | "partial" | "transferred" | "unknown";
    if (currentBalance > 0) {
      status = "holding";
    } else if (buyTokens === 0 && sellTokens === 0) {
      status = "unknown";
    } else if (sellTokens > 0.9 * buyTokens) {
      status = "sold";
    } else if (sellTokens < 0.1 * buyTokens) {
      status = "holding";
    } else {
      status = "partial";
    }

    return { buyTokens, sellTokens, status, buyDate, sellDate };
  } catch (err) {
    console.error(`[HeliusInsider] Error getting token status for ${walletAddress.slice(0, 8)}:`, err);
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }
}

export async function scanSolanaWalletHistory(
  walletAddress: string
): Promise<Array<{ tokenAddress: string; symbol: string; firstTx: number }>> {
  const env = loadEnv();
  const url = `${HELIUS_API_BASE}/addresses/${walletAddress}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP`;

  try {
    const response = await heliusRateLimitedFetch(url);
    if (!response || !response.ok) return [];

    const transactions = (await response.json()) as HeliusTransaction[];
    if (!Array.isArray(transactions)) return [];

    const tokenMap = new Map<string, { symbol: string; firstTx: number }>();

    for (const tx of transactions) {
      if (!tx.tokenTransfers) continue;
      for (const transfer of tx.tokenTransfers) {
        const mint = transfer.mint;
        if (SOLANA_STABLECOINS.has(mint)) continue;
        if (!tokenMap.has(mint)) {
          tokenMap.set(mint, { symbol: "UNKNOWN", firstTx: tx.timestamp * 1000 });
        }
      }
    }

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
