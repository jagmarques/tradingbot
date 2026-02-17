import type { EvmChain, GemHit } from "./types.js";
import { WATCHER_CONFIG } from "./types.js";
import { getInsiderWallets, getGemHitsForWallet, upsertGemHit } from "./storage.js";
import { etherscanRateLimitedFetch, buildExplorerUrl, EXPLORER_SUPPORTED_CHAINS } from "./scanner.js";
import { analyzeGem, buyGems } from "./gem-analyzer.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";
import { notifyInsiderBuyDetected } from "../telegram/notifications.js";

// TODO: Solana support skipped in V1 - Helius rate limits are too tight and the existing
// scanSolanaWalletHistory in scanner.ts already covers historical wallet scanning.
// Add Solana support here once a higher-rate Helius plan is available.

// Tracks the most recent tx timestamp seen per wallet+chain to avoid re-processing
// Key: `${address}_${chain}`, value: unix timestamp in seconds
const lastSeenTxTimestamp = new Map<string, number>();

let watcherRunning = false;

async function watchInsiderWallets(): Promise<void> {
  // Get all insider wallets and filter by minimum score
  const allWallets = getInsiderWallets();
  const qualifiedWallets = allWallets
    .filter((w) => w.score >= WATCHER_CONFIG.MIN_WALLET_SCORE && EXPLORER_SUPPORTED_CHAINS.has(w.chain))
    .sort((a, b) => b.score - a.score)
    .slice(0, WATCHER_CONFIG.MAX_WALLETS_PER_CYCLE);

  if (qualifiedWallets.length === 0) {
    console.log("[InsiderWatcher] No qualified wallets to watch");
    return;
  }

  // Collect new token buys across all wallets, deduplicated by tokenAddress+chain
  const newTokensGlobal = new Map<string, {
    walletAddress: string;
    walletScore: number;
    tokenAddress: string;
    tokenSymbol: string;
    chain: string;
  }>();

  let newBuysTotal = 0;

  for (const wallet of qualifiedWallets) {
    const walletKey = `${wallet.address}_${wallet.chain}`;

    try {
      const url = buildExplorerUrl(
        wallet.chain as EvmChain,
        `module=account&action=tokentx&address=${wallet.address}&startblock=0&endblock=99999999&sort=desc`
      );

      const response = await etherscanRateLimitedFetch(url, wallet.chain);
      const data = (await response.json()) as {
        status: string;
        result: Array<{
          contractAddress: string;
          tokenSymbol: string;
          tokenDecimal: string;
          timeStamp: string;
          to: string;
          from: string;
        }>;
      };

      if (data.status !== "1" || !Array.isArray(data.result)) {
        continue;
      }

      const lastSeenTs = lastSeenTxTimestamp.get(walletKey);

      if (lastSeenTs === undefined) {
        // First time seeing this wallet - establish baseline and skip
        const maxTs = data.result.reduce((max, tx) => {
          const ts = parseInt(tx.timeStamp);
          return ts > max ? ts : max;
        }, Math.floor(Date.now() / 1000));
        lastSeenTxTimestamp.set(walletKey, maxTs);
        continue;
      }

      // Find max timestamp in this response to update baseline
      let maxTs = lastSeenTs;
      for (const tx of data.result) {
        const ts = parseInt(tx.timeStamp);
        if (ts > maxTs) maxTs = ts;
      }
      lastSeenTxTimestamp.set(walletKey, maxTs);

      // Filter to incoming transfers after last seen timestamp
      const recentIncoming = data.result.filter((tx) => {
        const ts = parseInt(tx.timeStamp);
        return ts > lastSeenTs && tx.to.toLowerCase() === wallet.address.toLowerCase();
      });

      if (recentIncoming.length === 0) continue;

      // Get existing gem hits for this wallet to avoid duplicates
      const existingGems = getGemHitsForWallet(wallet.address, wallet.chain);
      const existingTokens = new Set(existingGems.map((g) => g.tokenAddress.toLowerCase()));

      // Collect unique new token addresses from incoming transfers
      let walletNewCount = 0;
      for (const tx of recentIncoming) {
        if (walletNewCount >= WATCHER_CONFIG.MAX_NEW_TOKENS_PER_WALLET) break;

        const tokenAddress = tx.contractAddress.toLowerCase();
        if (existingTokens.has(tokenAddress)) continue;

        const globalKey = `${tokenAddress}_${wallet.chain}`;
        if (!newTokensGlobal.has(globalKey)) {
          newTokensGlobal.set(globalKey, {
            walletAddress: wallet.address,
            walletScore: wallet.score,
            tokenAddress,
            tokenSymbol: tx.tokenSymbol || "UNKNOWN",
            chain: wallet.chain,
          });
          walletNewCount++;
          newBuysTotal++;
        }
      }
    } catch (err) {
      console.error(`[InsiderWatcher] Error checking ${wallet.address.slice(0, 8)} (${wallet.chain}):`, err);
    }
  }

  console.log(`[InsiderWatcher] Cycle: watched ${qualifiedWallets.length} wallets, found ${newBuysTotal} new buys`);

  // Process new tokens
  for (const [, tokenInfo] of newTokensGlobal) {
    try {
      // Look up token on DexScreener
      const pair = await dexScreenerFetch(tokenInfo.chain, tokenInfo.tokenAddress);
      if (!pair) continue;

      const fdvUsd = pair.fdv || 0;
      const liquidityUsd = pair.liquidity?.usd || 0;
      const priceUsd = parseFloat(pair.priceUsd || "0");

      // Skip if FDV > 10M or liquidity < 2000
      if (fdvUsd > 10_000_000 || liquidityUsd < 2000) continue;

      // Calculate pump multiple
      let pumpMultiple = 1;
      const isPumpFun = tokenInfo.tokenAddress.endsWith("pump");
      if (isPumpFun && priceUsd > 0) {
        pumpMultiple = priceUsd / 0.000069;
      } else if (fdvUsd > 0) {
        pumpMultiple = fdvUsd / 10000; // Use HISTORY_MIN_FDV_USD as baseline
      }

      // Skip if already pumped >= 10x
      if (pumpMultiple >= 10) continue;

      const symbol = pair.baseToken?.symbol || tokenInfo.tokenSymbol;

      // Upsert gem hit
      const hit: GemHit = {
        walletAddress: tokenInfo.walletAddress,
        chain: tokenInfo.chain as import("./types.js").ScanChain,
        tokenAddress: tokenInfo.tokenAddress,
        tokenSymbol: symbol,
        buyTxHash: "",
        buyTimestamp: Date.now(),
        buyBlockNumber: 0,
        pumpMultiple,
        launchPriceUsd: isPumpFun ? 0.000069 : 0,
      };
      upsertGemHit(hit);

      // Score via analyzeGem
      const analysis = await analyzeGem(symbol, tokenInfo.chain, tokenInfo.tokenAddress);
      const gemScore = analysis.score;

      console.log(`[InsiderWatcher] Detected: ${tokenInfo.walletAddress.slice(0, 8)} bought ${symbol} on ${tokenInfo.chain} (score: ${gemScore})`);

      let action: string;
      if (gemScore >= 70) {
        await buyGems([{
          symbol,
          chain: tokenInfo.chain,
          currentPump: pumpMultiple,
          score: gemScore,
          tokenAddress: tokenInfo.tokenAddress,
        }]);
        action = `scored ${gemScore}, paper-bought`;
      } else {
        action = `scored ${gemScore}, skipped (threshold: 70)`;
      }

      // Send Telegram alert
      await notifyInsiderBuyDetected({
        walletAddress: tokenInfo.walletAddress,
        walletScore: tokenInfo.walletScore,
        tokenSymbol: symbol,
        tokenAddress: tokenInfo.tokenAddress,
        chain: tokenInfo.chain,
        gemScore,
        action,
      });
    } catch (err) {
      console.error(`[InsiderWatcher] Error processing token ${tokenInfo.tokenAddress}:`, err);
    }
  }
}

export function startInsiderWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;

  console.log(`[InsiderWatcher] Starting (every ${WATCHER_CONFIG.INTERVAL_MS / 60000} min, after 30s delay)`);

  // Delay start to let scanner populate wallets first
  setTimeout(() => {
    (async (): Promise<void> => {
      while (watcherRunning) {
        try {
          await watchInsiderWallets();
        } catch (err) {
          console.error("[InsiderWatcher] Cycle error:", err);
        }

        if (watcherRunning) {
          await new Promise((r) => setTimeout(r, WATCHER_CONFIG.INTERVAL_MS));
        }
      }
    })().catch((err) => console.error("[InsiderWatcher] Loop crashed:", err));
  }, 30_000);
}

export function stopInsiderWatcher(): void {
  if (!watcherRunning) return;
  watcherRunning = false;
  console.log("[InsiderWatcher] Stopped");
}

export function isInsiderWatcherRunning(): boolean {
  return watcherRunning;
}
