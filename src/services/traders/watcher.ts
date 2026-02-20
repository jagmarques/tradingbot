import type { EvmChain, GemHit } from "./types.js";
import { WATCHER_CONFIG, INSIDER_CONFIG, COPY_TRADE_CONFIG } from "./types.js";
import { getInsiderWallets, getGemHitsForWallet, upsertGemHit, getGemPaperTrade, insertCopyTrade, getCopyTrade, closeCopyTrade, getOpenCopyTradeByToken, increaseCopyTradeAmount } from "./storage.js";
import { etherscanRateLimitedFetch, buildExplorerUrl, EXPLORER_SUPPORTED_CHAINS } from "./scanner.js";
import { analyzeGem, buyGems, sellGemPosition, fetchGoPlusData, isGoPlusKillSwitch } from "./gem-analyzer.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";
import { notifyInsiderBuyDetected, notifyCopyTrade } from "../telegram/notifications.js";

const lastSeenTxTimestamp = new Map<string, number>();

let watcherRunning = false;

async function watchInsiderWallets(): Promise<void> {
  // Get qualified wallets
  const allWallets = getInsiderWallets();
  const qualifiedWallets = allWallets
    .filter((w) => w.score >= WATCHER_CONFIG.MIN_WALLET_SCORE && EXPLORER_SUPPORTED_CHAINS.has(w.chain))
    .sort((a, b) => b.score - a.score)
    .slice(0, WATCHER_CONFIG.MAX_WALLETS_PER_CYCLE);

  if (qualifiedWallets.length === 0) {
    console.log("[InsiderWatcher] No qualified wallets to watch");
    return;
  }

  // Gem path: one per token
  const newTokensGlobal = new Map<string, {
    walletAddress: string;
    walletScore: number;
    tokenAddress: string;
    tokenSymbol: string;
    chain: string;
  }>();

  // Copy path: all wallet+token pairs
  const allWalletBuys: Array<{
    walletAddress: string;
    walletScore: number;
    tokenAddress: string;
    tokenSymbol: string;
    chain: string;
  }> = [];

  let newBuysTotal = 0;

  for (const wallet of qualifiedWallets) {
    const walletKey = `${wallet.address}_${wallet.chain}`;

    try {
      const url = buildExplorerUrl(
        wallet.chain as EvmChain,
        `module=account&action=tokentx&address=${wallet.address}&startblock=0&endblock=99999999&sort=desc`
      );

      const response = await etherscanRateLimitedFetch(url, wallet.chain);
      if (!response.ok) {
        console.error(`[Watcher] Etherscan HTTP ${response.status} for ${wallet.address}`);
        continue;
      }
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
        // First time: establish baseline
        const maxTs = data.result.reduce((max, tx) => {
          const ts = parseInt(tx.timeStamp);
          return ts > max ? ts : max;
        }, Math.floor(Date.now() / 1000));
        lastSeenTxTimestamp.set(walletKey, maxTs);
        continue;
      }

      // Update baseline
      let maxTs = lastSeenTs;
      for (const tx of data.result) {
        const ts = parseInt(tx.timeStamp);
        if (ts > maxTs) maxTs = ts;
      }
      lastSeenTxTimestamp.set(walletKey, maxTs);

      // Recent incoming transfers
      const recentIncoming = data.result.filter((tx) => {
        const ts = parseInt(tx.timeStamp);
        return ts > lastSeenTs && tx.to.toLowerCase() === wallet.address.toLowerCase();
      });

      // Detect sells
      const recentOutgoing = data.result.filter((tx) => {
        const ts = parseInt(tx.timeStamp);
        return ts > lastSeenTs && tx.from.toLowerCase() === wallet.address.toLowerCase();
      });

      for (const tx of recentOutgoing) {
        const symbol = tx.tokenSymbol || "";
        const chain = wallet.chain;
        const paperTrade = getGemPaperTrade(symbol, chain);
        if (paperTrade && paperTrade.status === "open") {
          await sellGemPosition(symbol, chain);
          console.log(`[InsiderWatcher] Auto-sell: ${symbol} (insider ${wallet.address.slice(0, 8)} sold)`);
        }

        // Close ALL copy trade positions for this token when any insider sells
        const primaryTrade = getOpenCopyTradeByToken(tx.contractAddress, wallet.chain);
        if (primaryTrade) {
          closeCopyTrade(primaryTrade.walletAddress, primaryTrade.tokenAddress, primaryTrade.chain);
          console.log(`[CopyTrade] Insider sell: closing ${primaryTrade.tokenSymbol} (${wallet.address.slice(0, 8)} sold, P&L ${primaryTrade.pnlPct.toFixed(1)}%)`);
          notifyCopyTrade({
            walletAddress: wallet.address,
            tokenSymbol: primaryTrade.tokenSymbol,
            chain: primaryTrade.chain,
            side: "sell",
            priceUsd: primaryTrade.currentPriceUsd,
            liquidityOk: primaryTrade.liquidityOk,
            liquidityUsd: primaryTrade.liquidityUsd,
            skipReason: null,
            pnlPct: primaryTrade.pnlPct,
          }).catch(err => console.error("[CopyTrade] Notification error:", err));
        }
      }

      if (recentIncoming.length === 0) continue;

      // Avoid duplicates
      const existingGems = getGemHitsForWallet(wallet.address, wallet.chain);
      const existingTokens = new Set(existingGems.map((g) => g.tokenAddress.toLowerCase()));

      // Collect new tokens
      let walletNewCount = 0;
      for (const tx of recentIncoming) {
        if (walletNewCount >= WATCHER_CONFIG.MAX_NEW_TOKENS_PER_WALLET) break;

        const tokenAddress = tx.contractAddress.toLowerCase();
        if (existingTokens.has(tokenAddress)) continue;

        const globalKey = `${tokenAddress}_${wallet.chain}`;
        const buyInfo = {
          walletAddress: wallet.address,
          walletScore: wallet.score,
          tokenAddress,
          tokenSymbol: tx.tokenSymbol || "UNKNOWN",
          chain: wallet.chain,
        };

        if (!newTokensGlobal.has(globalKey)) {
          newTokensGlobal.set(globalKey, buyInfo);
        }

        allWalletBuys.push(buyInfo);
        walletNewCount++;
        newBuysTotal++;
      }
    } catch (err) {
      console.error(`[InsiderWatcher] Error checking ${wallet.address.slice(0, 8)} (${wallet.chain}):`, err);
    }
  }

  console.log(`[InsiderWatcher] Cycle: watched ${qualifiedWallets.length} wallets, found ${newBuysTotal} new buys`);

  // Cache pairs for copy path reuse
  const pairCache = new Map<string, import("../shared/dexscreener.js").DexPair | null>();

  // Gem scoring path (filtered)
  for (const [globalKey, tokenInfo] of newTokensGlobal) {
    try {
      const pair = await dexScreenerFetch(tokenInfo.chain, tokenInfo.tokenAddress);
      pairCache.set(globalKey, pair);
      if (!pair) continue;

      const fdvUsd = pair.fdv || 0;
      const liquidityUsd = pair.liquidity?.usd || 0;
      const priceUsd = parseFloat(pair.priceUsd || "0");

      if (fdvUsd > 10_000_000 || liquidityUsd < 2000) continue;

      let pumpMultiple = 1;
      const isPumpFun = tokenInfo.tokenAddress.endsWith("pump");
      if (isPumpFun && priceUsd > 0) {
        pumpMultiple = priceUsd / 0.000069;
      } else if (fdvUsd > 0) {
        pumpMultiple = fdvUsd / 10000;
      }

      if (pumpMultiple >= WATCHER_CONFIG.MAX_BUY_PUMP) continue;

      const symbol = pair.baseToken?.symbol || tokenInfo.tokenSymbol;

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

      const analysis = await analyzeGem(symbol, tokenInfo.chain, tokenInfo.tokenAddress);
      const gemScore = analysis.score;

      console.log(`[InsiderWatcher] Detected: ${tokenInfo.walletAddress.slice(0, 8)} bought ${symbol} on ${tokenInfo.chain} (score: ${gemScore})`);

      let action: string;
      if (gemScore >= INSIDER_CONFIG.MIN_GEM_SCORE) {
        await buyGems([{
          symbol,
          chain: tokenInfo.chain,
          currentPump: pumpMultiple,
          score: gemScore,
          tokenAddress: tokenInfo.tokenAddress,
        }]);
        action = `scored ${gemScore}, paper-bought`;
      } else {
        action = `scored ${gemScore}, skipped (threshold: ${INSIDER_CONFIG.MIN_GEM_SCORE})`;
      }

      await notifyInsiderBuyDetected({
        walletAddress: tokenInfo.walletAddress,
        walletScore: tokenInfo.walletScore,
        tokenSymbol: symbol,
        tokenAddress: tokenInfo.tokenAddress,
        chain: tokenInfo.chain,
        gemScore,
        action,
      }).catch(err => console.error("[InsiderWatcher] Notification error:", err));
    } catch (err) {
      console.error(`[InsiderWatcher] Error processing token ${tokenInfo.tokenAddress}:`, err);
    }
  }

  // Copy-trade path (deduplicate by token - one position per token, accumulate on repeat)
  for (const tokenInfo of allWalletBuys) {
    try {
      // Skip if this specific wallet already has a copy trade for this token
      const existingCopy = getCopyTrade(tokenInfo.walletAddress, tokenInfo.tokenAddress, tokenInfo.chain);
      if (existingCopy) continue;

      const globalKey = `${tokenInfo.tokenAddress}_${tokenInfo.chain}`;
      const pair = pairCache.get(globalKey) ?? null;
      const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
      const liquidityUsd = pair?.liquidity?.usd ?? 0;
      const symbol = pair?.baseToken?.symbol || tokenInfo.tokenSymbol;

      // Check if ANY wallet already has an open position for this token
      const existingTokenTrade = getOpenCopyTradeByToken(tokenInfo.tokenAddress, tokenInfo.chain);
      if (existingTokenTrade) {
        // Accumulate: add 10% of current position for each additional insider
        const addAmount = existingTokenTrade.amountUsd * 0.10;
        increaseCopyTradeAmount(existingTokenTrade.id, addAmount);
        console.log(`[CopyTrade] Accumulate: ${symbol} (${tokenInfo.chain}) +$${addAmount.toFixed(2)} (insider #${existingTokenTrade.insiderCount + 1}, total $${(existingTokenTrade.amountUsd + addAmount).toFixed(2)})`);
        notifyCopyTrade({
          walletAddress: tokenInfo.walletAddress,
          tokenSymbol: symbol,
          chain: tokenInfo.chain,
          side: "buy",
          priceUsd,
          liquidityOk: true,
          liquidityUsd,
          skipReason: null,
        }).catch(err => console.error("[CopyTrade] Notification error:", err));
        // Still record this wallet's copy trade so we don't double-count
        insertCopyTrade({
          walletAddress: tokenInfo.walletAddress,
          tokenSymbol: symbol,
          tokenAddress: tokenInfo.tokenAddress,
          chain: tokenInfo.chain,
          side: "buy",
          buyPriceUsd: priceUsd,
          currentPriceUsd: priceUsd,
          amountUsd: 0,
          pnlPct: 0,
          status: "skipped",
          liquidityOk: true,
          liquidityUsd,
          skipReason: `accumulated into ${existingTokenTrade.id}`,
          buyTimestamp: Date.now(),
          closeTimestamp: null,
          insiderCount: 0,
          peakPnlPct: 0,
        });
        continue;
      }

      if (priceUsd <= 0) {
        insertCopyTrade({
          walletAddress: tokenInfo.walletAddress,
          tokenSymbol: symbol,
          tokenAddress: tokenInfo.tokenAddress,
          chain: tokenInfo.chain,
          side: "buy",
          buyPriceUsd: 0,
          currentPriceUsd: 0,
          amountUsd: COPY_TRADE_CONFIG.AMOUNT_USD,
          pnlPct: 0,
          status: "skipped",
          liquidityOk: false,
          liquidityUsd: 0,
          skipReason: "no price",
          buyTimestamp: Date.now(),
          closeTimestamp: null,
          insiderCount: 1,
          peakPnlPct: 0,
        });
        console.log(`[CopyTrade] Skipped ${symbol} (${tokenInfo.chain}) - no price`);
        notifyCopyTrade({
          walletAddress: tokenInfo.walletAddress,
          tokenSymbol: symbol,
          chain: tokenInfo.chain,
          side: "buy",
          priceUsd: 0,
          liquidityOk: false,
          liquidityUsd: 0,
          skipReason: "no price",
        }).catch(err => console.error("[CopyTrade] Notification error:", err));
        continue;
      }

      // GoPlus safety check - reject honeypots, high-tax tokens, etc.
      const goPlusData = await fetchGoPlusData(tokenInfo.tokenAddress, tokenInfo.chain);
      if (goPlusData && isGoPlusKillSwitch(goPlusData)) {
        insertCopyTrade({
          walletAddress: tokenInfo.walletAddress,
          tokenSymbol: symbol,
          tokenAddress: tokenInfo.tokenAddress,
          chain: tokenInfo.chain,
          side: "buy",
          buyPriceUsd: priceUsd,
          currentPriceUsd: priceUsd,
          amountUsd: COPY_TRADE_CONFIG.AMOUNT_USD,
          pnlPct: 0,
          status: "skipped",
          liquidityOk: true,
          liquidityUsd,
          skipReason: "GoPlus kill-switch",
          buyTimestamp: Date.now(),
          closeTimestamp: null,
          insiderCount: 1,
          peakPnlPct: 0,
        });
        console.log(`[CopyTrade] Skipped ${symbol} (${tokenInfo.chain}) - GoPlus kill-switch (honeypot/high-tax/scam)`);
        notifyCopyTrade({
          walletAddress: tokenInfo.walletAddress,
          tokenSymbol: symbol,
          chain: tokenInfo.chain,
          side: "buy",
          priceUsd,
          liquidityOk: false,
          liquidityUsd,
          skipReason: "GoPlus kill-switch",
        }).catch(err => console.error("[CopyTrade] Notification error:", err));
        continue;
      }

      const liquidityOk = liquidityUsd >= COPY_TRADE_CONFIG.MIN_LIQUIDITY_USD;
      insertCopyTrade({
        walletAddress: tokenInfo.walletAddress,
        tokenSymbol: symbol,
        tokenAddress: tokenInfo.tokenAddress,
        chain: tokenInfo.chain,
        side: "buy",
        buyPriceUsd: priceUsd,
        currentPriceUsd: priceUsd,
        amountUsd: COPY_TRADE_CONFIG.AMOUNT_USD,
        pnlPct: 0,
        status: liquidityOk ? "open" : "skipped",
        liquidityOk,
        liquidityUsd,
        skipReason: liquidityOk ? null : `low liquidity $${liquidityUsd.toFixed(0)}`,
        buyTimestamp: Date.now(),
        closeTimestamp: null,
        insiderCount: 1,
        peakPnlPct: 0,
      });
      console.log(`[CopyTrade] ${liquidityOk ? "Paper buy" : "Skipped"}: ${symbol} (${tokenInfo.chain}) $${priceUsd.toFixed(6)}, liq $${liquidityUsd.toFixed(0)}`);
      notifyCopyTrade({
        walletAddress: tokenInfo.walletAddress,
        tokenSymbol: symbol,
        chain: tokenInfo.chain,
        side: "buy",
        priceUsd,
        liquidityOk,
        liquidityUsd,
        skipReason: liquidityOk ? null : `low liquidity $${liquidityUsd.toFixed(0)}`,
      }).catch(err => console.error("[CopyTrade] Notification error:", err));
    } catch (err) {
      console.error(`[CopyTrade] Error processing ${tokenInfo.tokenAddress}:`, err);
    }
  }
}

export function startInsiderWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;

  console.log(`[InsiderWatcher] Starting (every ${WATCHER_CONFIG.INTERVAL_MS / 60000} min, after 30s delay)`);

  // Delay start for scanner
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
