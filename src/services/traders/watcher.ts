import type { EvmChain } from "./types.js";
import { WATCHER_CONFIG, COPY_TRADE_CONFIG, INSIDER_WS_CONFIG, KNOWN_DEX_ROUTERS, getPositionSize } from "./types.js";
import { getInsiderWallets, insertCopyTrade, getCopyTrade, closeCopyTrade, getOpenCopyTradeByToken, increaseCopyTradeAmount, getOpenCopyTrades, getRugCount, updateCopyTradePrice, getWalletCopyTradeStats } from "./storage.js";
import { etherscanRateLimitedFetch, buildExplorerUrl, EXPLORER_SUPPORTED_CHAINS } from "./scanner.js";
import { fetchGoPlusData, isGoPlusKillSwitch } from "./gem-analyzer.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";
import { notifyCopyTrade } from "../telegram/notifications.js";

const lastSeenTxTimestamp = new Map<string, number>();
const pausedWallets = new Map<string, number>();

// LP/wrapper token symbols to skip (not real tradeable tokens)
export const LP_TOKEN_SYMBOLS = new Set([
  "UNI-V2", "UNI-V3", "SLP", "SUSHI-LP", "CAKE-LP",
  "PGL", "JLP", "BPT", "G-UNI", "xSUSHI",
  "WETH", "WMATIC", "WBNB", "WAVAX", "WFTM",
  "aUSDC", "aWETH", "aDAI", "cUSDC", "cETH", "cDAI",
]);

// Dedup: tx hashes already processed by WebSocket (shared with insider-ws.ts)
const processedTxHashes = new Map<string, number>();

export function markTransferProcessed(txHash: string): void {
  processedTxHashes.set(txHash.toLowerCase(), Date.now());
}

export function isTransferProcessed(txHash: string): boolean {
  const ts = processedTxHashes.get(txHash.toLowerCase());
  if (!ts) return false;
  if (Date.now() - ts > INSIDER_WS_CONFIG.DEDUP_TTL_MS) {
    processedTxHashes.delete(txHash.toLowerCase());
    return false;
  }
  return true;
}

export function cleanupProcessedTxHashes(): void {
  const now = Date.now();
  for (const [hash, ts] of processedTxHashes) {
    if (now - ts > INSIDER_WS_CONFIG.DEDUP_TTL_MS) {
      processedTxHashes.delete(hash);
    }
  }
}

export function isLpToken(symbol: string): boolean {
  return LP_TOKEN_SYMBOLS.has(symbol) || symbol.includes("-LP") || symbol.startsWith("UNI-");
}

// Shared sell processing: close ALL open copy trades for token when insider sells
export async function processInsiderSell(
  walletAddress: string,
  tokenAddress: string,
  chain: string,
  fetchFreshPrice: boolean = false,
): Promise<void> {
  const openTrades = getOpenCopyTrades();
  const matchingTrades = openTrades.filter(
    t => t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() && t.chain === chain
  );
  if (matchingTrades.length === 0) return;

  let priceUsd = matchingTrades[0].currentPriceUsd;

  // Fetch fresh price once for real-time exits (WebSocket path)
  if (fetchFreshPrice) {
    const pair = await dexScreenerFetch(chain, tokenAddress);
    const freshPrice = pair ? parseFloat(pair.priceUsd || "0") : 0;
    if (freshPrice > 0) {
      priceUsd = freshPrice;
      for (const trade of matchingTrades) {
        updateCopyTradePrice(trade.walletAddress, tokenAddress, chain, freshPrice);
      }
    }
  }

  for (const trade of matchingTrades) {
    const tradePriceUsd = fetchFreshPrice && priceUsd > 0 ? priceUsd : trade.currentPriceUsd;
    const rawPnlPct = trade.buyPriceUsd > 0
      ? ((tradePriceUsd - trade.buyPriceUsd) / trade.buyPriceUsd) * 100
      : trade.pnlPct;
    const pnlPct = rawPnlPct - COPY_TRADE_CONFIG.ESTIMATED_FEE_PCT;

    const closed = closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain, "insider_sold", tradePriceUsd, pnlPct);
    if (!closed) continue; // already closed by another path
    console.log(`[CopyTrade] Insider sell: closing ${trade.tokenSymbol} (${walletAddress.slice(0, 8)} sold, P&L ${pnlPct.toFixed(1)}%)`);
    notifyCopyTrade({
      walletAddress,
      tokenSymbol: trade.tokenSymbol,
      chain: trade.chain,
      side: "sell",
      priceUsd: tradePriceUsd,
      liquidityOk: trade.liquidityOk,
      liquidityUsd: trade.liquidityUsd,
      skipReason: "insider sell",
      pnlPct,
    }).catch(err => console.error("[CopyTrade] Notification error:", err));
  }
}

// Shared buy processing: open or accumulate copy trade
export async function processInsiderBuy(tokenInfo: {
  walletAddress: string;
  walletScore: number;
  tokenAddress: string;
  tokenSymbol: string;
  chain: string;
}): Promise<void> {
  // Skip if this specific wallet already has a copy trade for this token
  const existingCopy = getCopyTrade(tokenInfo.walletAddress, tokenInfo.tokenAddress, tokenInfo.chain);
  if (existingCopy) return;

  // Skip tokens that have rugged us before
  const rugCount = getRugCount(tokenInfo.tokenAddress, tokenInfo.chain);
  if (rugCount > 0) {
    console.log(`[CopyTrade] Skip ${tokenInfo.tokenSymbol} (${tokenInfo.chain}) - rugged ${rugCount}x before`);
    return;
  }

  // Score-based position sizing
  const positionAmount = getPositionSize(tokenInfo.walletScore);

  // Check exposure budget before opening new positions (accumulation still allowed)
  const existingTokenTrade = getOpenCopyTradeByToken(tokenInfo.tokenAddress, tokenInfo.chain);
  if (!existingTokenTrade) {
    const openTrades = getOpenCopyTrades();
    const currentExposure = openTrades.reduce((sum, t) => sum + t.amountUsd, 0);
    if (currentExposure + positionAmount > COPY_TRADE_CONFIG.MAX_EXPOSURE_USD) {
      console.log(`[CopyTrade] Skip ${tokenInfo.tokenSymbol} (${tokenInfo.chain}) - exposure $${currentExposure.toFixed(0)} + $${positionAmount} >= $${COPY_TRADE_CONFIG.MAX_EXPOSURE_USD} limit`);
      return;
    }
  }

  const pair = (await dexScreenerFetch(tokenInfo.chain, tokenInfo.tokenAddress)) ?? null;
  const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
  const liquidityUsd = pair?.liquidity?.usd ?? 0;
  const symbol = pair?.baseToken?.symbol || tokenInfo.tokenSymbol;

  if (isLpToken(symbol)) {
    console.log(`[CopyTrade] Skip ${symbol} (${tokenInfo.chain}) - LP/wrapper token`);
    return;
  }

  // Accumulate if another wallet already has an open position for this token
  if (existingTokenTrade) {
    const addAmount = existingTokenTrade.amountUsd * 0.10;
    const openTrades = getOpenCopyTrades();
    const currentExposure = openTrades.reduce((sum, t) => sum + t.amountUsd, 0);
    if (currentExposure + addAmount > COPY_TRADE_CONFIG.MAX_EXPOSURE_USD) {
      console.log(`[CopyTrade] Skip accumulation ${symbol} (${tokenInfo.chain}) - exposure $${currentExposure.toFixed(0)} + $${addAmount.toFixed(2)} > $${COPY_TRADE_CONFIG.MAX_EXPOSURE_USD} limit`);
      return;
    }
    if (liquidityUsd < COPY_TRADE_CONFIG.MIN_LIQUIDITY_USD) {
      console.log(`[CopyTrade] Skip accumulation ${symbol} (${tokenInfo.chain}) - low liquidity $${liquidityUsd.toFixed(0)} < $${COPY_TRADE_CONFIG.MIN_LIQUIDITY_USD}`);
      insertCopyTrade({
        walletAddress: tokenInfo.walletAddress,
        tokenSymbol: symbol,
        tokenAddress: tokenInfo.tokenAddress,
        chain: tokenInfo.chain,
        pairAddress: pair?.pairAddress ?? null,
        side: "buy",
        buyPriceUsd: priceUsd,
        currentPriceUsd: priceUsd,
        amountUsd: 0,
        pnlPct: 0,
        status: "skipped",
        liquidityOk: false,
        liquidityUsd,
        skipReason: `accumulated skipped - low liquidity $${liquidityUsd.toFixed(0)}`,
        buyTimestamp: Date.now(),
        closeTimestamp: null,
        exitReason: null,
        insiderCount: 0,
        peakPnlPct: 0,
        walletScoreAtBuy: tokenInfo.walletScore,
        exitDetail: null,
      });
      return;
    }
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
    insertCopyTrade({
      walletAddress: tokenInfo.walletAddress,
      tokenSymbol: symbol,
      tokenAddress: tokenInfo.tokenAddress,
      chain: tokenInfo.chain,
      pairAddress: pair?.pairAddress ?? null,
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
      exitReason: null,
      insiderCount: 0,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
    });
    return;
  }

  if (priceUsd <= 0) {
    insertCopyTrade({
      walletAddress: tokenInfo.walletAddress,
      tokenSymbol: symbol,
      tokenAddress: tokenInfo.tokenAddress,
      chain: tokenInfo.chain,
      pairAddress: pair?.pairAddress ?? null,
      side: "buy",
      buyPriceUsd: 0,
      currentPriceUsd: 0,
      amountUsd: positionAmount,
      pnlPct: 0,
      status: "skipped",
      liquidityOk: false,
      liquidityUsd: 0,
      skipReason: "no price",
      buyTimestamp: Date.now(),
      closeTimestamp: null,
      exitReason: null,
      insiderCount: 1,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
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
    return;
  }

  // GoPlus safety check
  const goPlusData = await fetchGoPlusData(tokenInfo.tokenAddress, tokenInfo.chain);
  if (goPlusData && isGoPlusKillSwitch(goPlusData)) {
    insertCopyTrade({
      walletAddress: tokenInfo.walletAddress,
      tokenSymbol: symbol,
      tokenAddress: tokenInfo.tokenAddress,
      chain: tokenInfo.chain,
      pairAddress: pair?.pairAddress ?? null,
      side: "buy",
      buyPriceUsd: priceUsd,
      currentPriceUsd: priceUsd,
      amountUsd: positionAmount,
      pnlPct: 0,
      status: "skipped",
      liquidityOk: true,
      liquidityUsd,
      skipReason: "GoPlus kill-switch",
      buyTimestamp: Date.now(),
      closeTimestamp: null,
      exitReason: null,
      insiderCount: 1,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
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
    return;
  }

  const liquidityOk = liquidityUsd >= COPY_TRADE_CONFIG.MIN_LIQUIDITY_USD;
  insertCopyTrade({
    walletAddress: tokenInfo.walletAddress,
    tokenSymbol: symbol,
    tokenAddress: tokenInfo.tokenAddress,
    chain: tokenInfo.chain,
    pairAddress: pair?.pairAddress ?? null,
    side: "buy",
    buyPriceUsd: priceUsd,
    currentPriceUsd: priceUsd,
    amountUsd: positionAmount,
    pnlPct: 0,
    status: liquidityOk ? "open" : "skipped",
    liquidityOk,
    liquidityUsd,
    skipReason: liquidityOk ? null : `low liquidity $${liquidityUsd.toFixed(0)}`,
    buyTimestamp: Date.now(),
    closeTimestamp: null,
    exitReason: null,
    insiderCount: 1,
    peakPnlPct: 0,
    walletScoreAtBuy: tokenInfo.walletScore,
    exitDetail: null,
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
}

let watcherRunning = false;
let wsActive = false;

export function setWebSocketActive(active: boolean): void {
  wsActive = active;
}

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

  let newBuysTotal = 0;

  for (const wallet of qualifiedWallets) {
    const walletKey = `${wallet.address}_${wallet.chain}`;

    try {
      // Circuit breaker: check if wallet is paused
      const pausedUntil = pausedWallets.get(wallet.address);
      if (pausedUntil) {
        if (Date.now() < pausedUntil) {
          continue; // still paused
        }
        pausedWallets.delete(wallet.address); // pause expired
      }

      // Hard floor + circuit breaker from copy trade stats
      const copyStats = getWalletCopyTradeStats(wallet.address);
      if (copyStats.totalTrades >= 5) {
        const winRate = copyStats.wins / copyStats.totalTrades;
        if (winRate < 0.30) {
          console.log(`[Watcher] Rejecting ${wallet.address.slice(0, 8)}: ${(winRate * 100).toFixed(0)}% WR after ${copyStats.totalTrades} trades`);
          continue;
        }
      }
      if (copyStats.consecutiveLosses >= 3) {
        pausedWallets.set(wallet.address, Date.now() + 24 * 60 * 60 * 1000);
        console.log(`[Watcher] Pausing ${wallet.address.slice(0, 8)} for 24h: ${copyStats.consecutiveLosses} consecutive losses`);
        continue;
      }

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
          hash: string;
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
        const maxTs = data.result.reduce((max, tx) => {
          const ts = parseInt(tx.timeStamp);
          return ts > max ? ts : max;
        }, Math.floor(Date.now() / 1000));
        lastSeenTxTimestamp.set(walletKey, maxTs);
        continue;
      }

      let maxTs = lastSeenTs;
      for (const tx of data.result) {
        const ts = parseInt(tx.timeStamp);
        if (ts > maxTs) maxTs = ts;
      }
      lastSeenTxTimestamp.set(walletKey, maxTs);

      // Detect sells (only outgoing transfers to known DEX routers are sells)
      const recentOutgoing = data.result.filter((tx) => {
        const ts = parseInt(tx.timeStamp);
        if (ts <= lastSeenTs) return false;
        if (tx.from.toLowerCase() !== wallet.address.toLowerCase()) return false;
        // Only treat as sell if destination is a known DEX router
        const toAddr = tx.to.toLowerCase();
        const routers = KNOWN_DEX_ROUTERS[wallet.chain];
        if (!routers || !routers.some(r => r.toLowerCase() === toAddr)) return false;
        return true;
      });

      for (const tx of recentOutgoing) {
        if (tx.hash && isTransferProcessed(tx.hash)) continue;
        try {
          await processInsiderSell(wallet.address, tx.contractAddress, wallet.chain);
          if (tx.hash) markTransferProcessed(tx.hash);
        } catch (err) {
          console.error(`[CopyTrade] Sell error ${tx.contractAddress.slice(0, 10)}:`, err);
        }
      }

      // Recent incoming transfers (skip LP tokens and wrappers)
      const recentIncoming = data.result.filter((tx) => {
        const ts = parseInt(tx.timeStamp);
        if (ts <= lastSeenTs) return false;
        if (tx.to.toLowerCase() !== wallet.address.toLowerCase()) return false;
        if (isLpToken(tx.tokenSymbol)) return false;
        return true;
      });

      if (recentIncoming.length === 0) continue;

      let walletNewCount = 0;
      for (const tx of recentIncoming) {
        if (walletNewCount >= WATCHER_CONFIG.MAX_NEW_TOKENS_PER_WALLET) break;
        if (tx.hash && isTransferProcessed(tx.hash)) continue;

        try {
          await processInsiderBuy({
            walletAddress: wallet.address,
            walletScore: wallet.score,
            tokenAddress: tx.contractAddress.toLowerCase(),
            tokenSymbol: tx.tokenSymbol || "UNKNOWN",
            chain: wallet.chain,
          });
          if (tx.hash) markTransferProcessed(tx.hash);
          walletNewCount++;
          newBuysTotal++;
        } catch (err) {
          console.error(`[CopyTrade] Buy error ${tx.contractAddress.slice(0, 10)}:`, err);
        }
      }
    } catch (err) {
      console.error(`[InsiderWatcher] Error checking ${wallet.address.slice(0, 8)} (${wallet.chain}):`, err);
    }
  }

  console.log(`[InsiderWatcher] Cycle: watched ${qualifiedWallets.length} wallets, found ${newBuysTotal} new buys`);

  // Periodic dedup cleanup
  cleanupProcessedTxHashes();
}

export function startInsiderWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;

  const intervalMs = wsActive ? INSIDER_WS_CONFIG.FALLBACK_POLL_INTERVAL_MS : WATCHER_CONFIG.INTERVAL_MS;
  console.log(`[InsiderWatcher] Starting (every ${intervalMs / 60000} min, after 30s delay${wsActive ? ", WS fallback mode" : ""})`);

  setTimeout(() => {
    (async (): Promise<void> => {
      while (watcherRunning) {
        try {
          await watchInsiderWallets();
        } catch (err) {
          console.error("[InsiderWatcher] Cycle error:", err);
        }

        if (watcherRunning) {
          const interval = wsActive ? INSIDER_WS_CONFIG.FALLBACK_POLL_INTERVAL_MS : WATCHER_CONFIG.INTERVAL_MS;
          await new Promise((r) => setTimeout(r, interval));
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

export function clearWatcherMemory(): void {
  lastSeenTxTimestamp.clear();
  pausedWallets.clear();
}

export function pauseWallet(address: string): void {
  pausedWallets.set(address, Date.now() + 24 * 60 * 60 * 1000);
}

export function isWalletPaused(address: string): boolean {
  const pausedUntil = pausedWallets.get(address);
  if (!pausedUntil) return false;
  if (Date.now() < pausedUntil) return true;
  pausedWallets.delete(address);
  return false;
}
