import { PublicKey } from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { getConnection } from "./wallet.js";
import { KNOWN_EXCHANGES } from "../traders/types.js";

// 1s between RPC calls to stay under Alchemy free tier 330 CU/s
const RPC_INTERVAL_MS = 1000;
const TX_BATCH_SIZE = 10; // Parse 10 txs at a time (50 at once exceeds CU/s limit)
let rpcQueue: Promise<void> = Promise.resolve();

async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  const myTurn = rpcQueue.then(() => new Promise<void>((r) => setTimeout(r, RPC_INTERVAL_MS)));
  rpcQueue = myTurn;
  await myTurn;
  return fn();
}

// Batch getParsedTransactions into small chunks to stay under CU limits
async function batchGetParsedTransactions(
  connection: import("@solana/web3.js").Connection,
  sigs: string[]
): Promise<(import("@solana/web3.js").ParsedTransactionWithMeta | null)[]> {
  const results: (import("@solana/web3.js").ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < sigs.length; i += TX_BATCH_SIZE) {
    const chunk = sigs.slice(i, i + TX_BATCH_SIZE);
    const parsed = await rateLimitedCall(() =>
      connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 })
    );
    results.push(...parsed);
  }
  return results;
}

const BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isValidSolanaAddress(addr: string): boolean {
  return typeof addr === "string" && addr.length >= 32 && addr.length <= 44 && BASE58_CHARS.test(addr);
}

const SOLANA_STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112", // wSOL
]);

// Extract token balance changes from a parsed transaction
function getTokenChanges(
  tx: ParsedTransactionWithMeta,
  filterMint?: string
): Array<{ owner: string; mint: string; change: number }> {
  const changes: Array<{ owner: string; mint: string; change: number }> = [];
  if (!tx.meta) return changes;

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];

  // Build pre-balance map: accountIndex -> {owner, mint, amount}
  const preMap = new Map<number, { owner: string; mint: string; amount: number }>();
  for (const b of pre) {
    if (filterMint && b.mint !== filterMint) continue;
    preMap.set(b.accountIndex, {
      owner: b.owner || "",
      mint: b.mint,
      amount: b.uiTokenAmount?.uiAmount || 0,
    });
  }

  // Compare with post-balances
  for (const b of post) {
    if (filterMint && b.mint !== filterMint) continue;
    const owner = b.owner || "";
    if (!owner) continue;
    const postAmount = b.uiTokenAmount?.uiAmount || 0;
    const preEntry = preMap.get(b.accountIndex);
    const preAmount = preEntry?.amount || 0;
    const change = postAmount - preAmount;
    if (Math.abs(change) > 0) {
      changes.push({ owner, mint: b.mint, change });
    }
    preMap.delete(b.accountIndex);
  }

  // Entries only in pre (account closed = sold everything)
  for (const [, entry] of preMap) {
    if (entry.owner && entry.amount > 0) {
      changes.push({ owner: entry.owner, mint: entry.mint, change: -entry.amount });
    }
  }

  return changes;
}

export async function findSolanaEarlyBuyers(tokenMint: string): Promise<string[]> {
  try {
    if (!isValidSolanaAddress(tokenMint)) {
      console.warn(`[SolanaInsider] Invalid token mint: ${tokenMint.slice(0, 12)}`);
      return [];
    }
    const connection = getConnection();
    const mintPubkey = new PublicKey(tokenMint);

    // Get first 30 signatures (oldest first not supported, so get recent and reverse isn't ideal)
    // Instead get signatures and parse them
    const signatures = await rateLimitedCall(() =>
      connection.getSignaturesForAddress(mintPubkey, { limit: 50 })
    );

    if (!signatures.length) return [];

    // Parse transactions in small batches to stay under CU limits
    const sigs = signatures.map((s) => s.signature);
    const parsed = await batchGetParsedTransactions(connection, sigs);

    const buyers = new Set<string>();
    const addressCounts = new Map<string, number>();
    const solanaExchanges = new Set(KNOWN_EXCHANGES.solana);

    // Count appearances to filter AMM/routers
    for (const tx of parsed) {
      if (!tx) continue;
      for (const change of getTokenChanges(tx, tokenMint)) {
        if (change.change > 0) {
          addressCounts.set(change.owner, (addressCounts.get(change.owner) || 0) + 1);
        }
      }
    }

    const totalTxs = parsed.filter(Boolean).length;

    for (const tx of parsed) {
      if (!tx) continue;
      for (const change of getTokenChanges(tx, tokenMint)) {
        if (change.change <= 0) continue;
        const buyer = change.owner;
        if (buyer === tokenMint) continue;
        if (solanaExchanges.has(buyer)) continue;
        const count = addressCounts.get(buyer) || 0;
        if (totalTxs > 10 && count / totalTxs > 0.5) continue;
        buyers.add(buyer);
      }
    }

    console.log(`[SolanaInsider] Found ${buyers.size} early buyers for ${tokenMint.slice(0, 8)}`);
    return Array.from(buyers);
  } catch (err) {
    console.error(`[SolanaInsider] Error finding buyers for ${tokenMint.slice(0, 8)}:`, err);
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
  if (!isValidSolanaAddress(walletAddress) || !isValidSolanaAddress(tokenMint)) {
    console.warn(`[SolanaInsider] Invalid address: wallet=${walletAddress.slice(0, 12)} mint=${tokenMint.slice(0, 12)}`);
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }
  let currentBalance = 0;
  let buyTokens = 0;
  let sellTokens = 0;
  let buyDate = 0;
  let sellDate = 0;

  try {
    const connection = getConnection();
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMint);

    const tokenAccounts = await rateLimitedCall(() =>
      connection.getTokenAccountsByOwner(walletPubkey, { mint: mintPubkey })
    );

    if (tokenAccounts.value.length > 0) {
      const accountInfo = await rateLimitedCall(() =>
        connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey)
      );
      currentBalance = parseFloat(accountInfo.value.uiAmount?.toString() || "0");
    }

    // Get wallet transaction history
    const signatures = await rateLimitedCall(() =>
      connection.getSignaturesForAddress(walletPubkey, { limit: 50 })
    );

    if (signatures.length > 0) {
      const sigs = signatures.map((s) => s.signature);
      const parsed = await batchGetParsedTransactions(connection, sigs);

      for (let i = 0; i < parsed.length; i++) {
        const tx = parsed[i];
        if (!tx) continue;
        const ts = (signatures[i].blockTime || 0) * 1000;

        for (const change of getTokenChanges(tx, tokenMint)) {
          if (change.owner !== walletAddress) continue;
          if (change.change > 0) {
            buyTokens += change.change;
            if (!buyDate) buyDate = ts;
          } else {
            sellTokens += Math.abs(change.change);
            sellDate = ts;
          }
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
    console.error(`[SolanaInsider] Error getting token status for ${walletAddress.slice(0, 8)}:`, err);
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }
}

export async function scanSolanaWalletHistory(
  walletAddress: string
): Promise<Array<{ tokenAddress: string; symbol: string; firstTx: number }>> {
  if (!isValidSolanaAddress(walletAddress)) {
    console.warn(`[SolanaInsider] Invalid wallet address: ${walletAddress.slice(0, 12)}`);
    return [];
  }
  try {
    const connection = getConnection();
    const walletPubkey = new PublicKey(walletAddress);

    const signatures = await rateLimitedCall(() =>
      connection.getSignaturesForAddress(walletPubkey, { limit: 50 })
    );

    if (!signatures.length) return [];

    const sigs = signatures.map((s) => s.signature);
    const parsed = await batchGetParsedTransactions(connection, sigs);

    const tokenMap = new Map<string, { symbol: string; firstTx: number }>();

    for (let i = 0; i < parsed.length; i++) {
      const tx = parsed[i];
      if (!tx) continue;
      const ts = (signatures[i].blockTime || 0) * 1000;

      for (const change of getTokenChanges(tx)) {
        if (SOLANA_STABLECOINS.has(change.mint)) continue;
        if (!tokenMap.has(change.mint)) {
          tokenMap.set(change.mint, { symbol: "UNKNOWN", firstTx: ts });
        }
      }
    }

    const result = Array.from(tokenMap.entries()).map(([tokenAddress, info]) => ({
      tokenAddress,
      symbol: info.symbol,
      firstTx: info.firstTx,
    }));

    console.log(`[SolanaInsider] Wallet ${walletAddress.slice(0, 8)} history: ${result.length} unique tokens`);
    return result;
  } catch (err) {
    console.error(`[SolanaInsider] Error scanning history for ${walletAddress.slice(0, 8)}:`, err);
    return [];
  }
}
