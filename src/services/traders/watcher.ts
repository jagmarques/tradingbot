import type { EvmChain } from "./types.js";
import { WATCHER_CONFIG, COPY_TRADE_CONFIG, INSIDER_WS_CONFIG, INSIDER_CONFIG, KNOWN_DEX_ROUTERS, getPositionSize, checkCircuitBreaker } from "./types.js";
import type { Chain } from "./types.js";
import { getInsiderWallets, insertCopyTrade, getCopyTrade, getOpenCopyTradeByToken, increaseCopyTradeAmount, getOpenCopyTrades, getRugCount, updateCopyTradePrice, getWalletCopyTradeStats, updateCopyTradeTokenCreatedAt } from "./storage.js";
import { etherscanRateLimitedFetch, buildExplorerUrl, EXPLORER_SUPPORTED_CHAINS } from "./scanner.js";
import { fetchGoPlusData, isGoPlusKillSwitch, exitCopyTrade } from "./gem-analyzer.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";
import { notifyCopyTrade } from "../telegram/notifications.js";
import { formatPrice } from "../../utils/format.js";
import { isPaperMode } from "../../config/env.js";
import { execute1inchSwap, getNativeBalance, isChainSupported } from "../evm/index.js";
import { getApproxUsdValue } from "../copy/filter.js";

const lastSeenTxTimestamp = new Map<string, number>();
const pausedWallets = new Map<string, number>();

// AMM price impact: amountUsd / (2 * liquidityUsd) * 100, capped at 50%
export function estimatePriceImpactPct(amountUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0 || amountUsd <= 0) return 0;
  return Math.min(50, (amountUsd / (2 * liquidityUsd)) * 100);
}

// LP/wrapper token symbols to skip (not real tradeable tokens)
const LP_TOKEN_SYMBOLS = new Set([
  "UNI-V2", "UNI-V3", "SLP", "SUSHI-LP", "CAKE-LP",
  "PGL", "JLP", "BPT", "G-UNI", "xSUSHI",
  "WETH", "WMATIC", "WBNB", "WAVAX", "WFTM",
  "aUSDC", "aWETH", "aDAI", "cUSDC", "cETH", "cDAI",
  "USDC", "USDT", "DAI", "WBTC", "stETH", "USDbC", "BUSD", "TUSD", "FRAX",
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

function isLpToken(symbol: string): boolean {
  return LP_TOKEN_SYMBOLS.has(symbol) || symbol.includes("-LP") || symbol.startsWith("UNI-");
}

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
  let freshLiquidityUsd = 0;

  if (fetchFreshPrice) {
    const pair = await dexScreenerFetch(chain, tokenAddress);
    const freshPrice = pair ? parseFloat(pair.priceUsd || "0") : 0;
    freshLiquidityUsd = pair?.liquidity?.usd ?? 0;
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

    const effectiveLiquidity = (fetchFreshPrice && freshLiquidityUsd > 0) ? freshLiquidityUsd : trade.liquidityUsd;
    let feePct = COPY_TRADE_CONFIG.ESTIMATED_FEE_PCT; // default 3%
    if (effectiveLiquidity > 0 && effectiveLiquidity < COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD) {
      const t = Math.max(0, Math.min(1, effectiveLiquidity / COPY_TRADE_CONFIG.LIQUIDITY_RUG_FLOOR_USD));
      feePct = COPY_TRADE_CONFIG.ESTIMATED_RUG_FEE_PCT + t * (COPY_TRADE_CONFIG.ESTIMATED_FEE_PCT - COPY_TRADE_CONFIG.ESTIMATED_RUG_FEE_PCT);
    }

    const priceImpactPct = estimatePriceImpactPct(trade.amountUsd, effectiveLiquidity);
    feePct += priceImpactPct;

    const pnlPct = rawPnlPct - feePct;

    trade.currentPriceUsd = tradePriceUsd;
    const closed = await exitCopyTrade(trade, "insider_sold", pnlPct, "insider_sold");
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

const tokenBuyLock = new Set<string>();
const tokenRetryDone = new Set<string>();

export async function processInsiderBuy(tokenInfo: {
  walletAddress: string;
  walletScore: number;
  tokenAddress: string;
  tokenSymbol: string;
  chain: string;
  hasTradeHistory?: boolean;
}): Promise<void> {
  const tokenLockKey = `${tokenInfo.tokenAddress}_${tokenInfo.chain}`;
  if (tokenBuyLock.has(tokenLockKey)) {
    if (!tokenRetryDone.has(tokenLockKey)) {
      tokenRetryDone.add(tokenLockKey);
      setTimeout(() => processInsiderBuy(tokenInfo), 5_000);
    }
    return;
  }
  tokenBuyLock.add(tokenLockKey);
  tokenRetryDone.delete(tokenLockKey);

  try {
  // Dedup: same wallet + token
  const existingCopy = getCopyTrade(tokenInfo.walletAddress, tokenInfo.tokenAddress, tokenInfo.chain);
  if (existingCopy) return;

  // Rug dedup
  const rugCount = getRugCount(tokenInfo.tokenAddress, tokenInfo.chain);
  if (rugCount > 0) {
    console.log(`[CopyTrade] Skip ${tokenInfo.tokenSymbol} (${tokenInfo.chain}) - rugged ${rugCount}x before`);
    return;
  }

  // Score-based position sizing; halve for legacy wallets (no proven copy-trade P&L)
  const baseAmount = getPositionSize(tokenInfo.walletScore);
  const positionAmount = tokenInfo.hasTradeHistory ? baseAmount : Math.floor(baseAmount / 2);
  const legacyNote = tokenInfo.hasTradeHistory ? "" : " (legacy, halved)";
  console.log(`[CopyTrade] Position size: ${tokenInfo.tokenSymbol} (${tokenInfo.chain}) score=${tokenInfo.walletScore} -> $${positionAmount}${legacyNote}`);

  // Exposure check (accumulation bypasses)
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

  // Max pump guard
  const h24Change = pair?.priceChange?.h24 ?? 0;
  if (h24Change > INSIDER_CONFIG.MAX_BUY_PUMP * 100) {
    console.log(`[CopyTrade] Skip ${symbol} (${tokenInfo.chain}) - already pumped ${(h24Change / 100).toFixed(0)}x > ${INSIDER_CONFIG.MAX_BUY_PUMP}x limit`);
    return;
  }

  if (isLpToken(symbol)) {
    console.log(`[CopyTrade] Skip ${symbol} (${tokenInfo.chain}) - LP/wrapper token`);
    return;
  }

  // Accumulation path
  if (existingTokenTrade) {
    const addAmount = existingTokenTrade.amountUsd * 0.50;
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
        tokenCreatedAt: pair?.pairCreatedAt ?? null,
        closeTimestamp: null,
        exitReason: null,
        insiderCount: 0,
        peakPnlPct: 0,
        walletScoreAtBuy: tokenInfo.walletScore,
        exitDetail: null,
      });
      return;
    }
    // Live accumulation swap
    if (!isPaperMode()) {
      if (!isChainSupported(tokenInfo.chain as Chain)) {
        console.log(`[CopyTrade] LIVE ACCUMULATE: Skip ${symbol} - chain not supported`);
        return;
      }
      const balance = await getNativeBalance(tokenInfo.chain as Chain);
      if (balance === null || balance < 1000000000000000n) {
        console.log(`[CopyTrade] LIVE ACCUMULATE: Skip ${symbol} - insufficient gas on ${tokenInfo.chain}`);
        return;
      }
      const nativePrice = getApproxUsdValue(1, tokenInfo.chain as Chain);
      const amountNative = addAmount / nativePrice;
      const result = await execute1inchSwap(tokenInfo.chain as Chain, tokenInfo.tokenAddress, amountNative, 3);
      if (!result.success) {
        console.log(`[CopyTrade] LIVE ACCUMULATE FAILED: ${symbol} (${tokenInfo.chain}) - ${result.error}`);
        return;
      }
      console.log(`[CopyTrade] LIVE ACCUMULATE: ${symbol} (${tokenInfo.chain}) tx=${result.txHash}`);
    }
    increaseCopyTradeAmount(existingTokenTrade.id, addAmount, priceUsd);
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
      tokenCreatedAt: pair?.pairCreatedAt ?? null,
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
    // No price yet, skip
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
      tokenCreatedAt: pair?.pairCreatedAt ?? null,
      closeTimestamp: null,
      exitReason: null,
      insiderCount: 1,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
    });
    console.log(`[CopyTrade] Skipped ${symbol} (${tokenInfo.chain}) - no price`);
    return;
  }

  // GoPlus safety check
  const goPlusData = await fetchGoPlusData(tokenInfo.tokenAddress, tokenInfo.chain);
  if (!goPlusData) {
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
      liquidityOk: liquidityUsd >= COPY_TRADE_CONFIG.MIN_LIQUIDITY_USD,
      liquidityUsd,
      skipReason: "GoPlus unavailable",
      buyTimestamp: Date.now(),
      tokenCreatedAt: pair?.pairCreatedAt ?? null,
      closeTimestamp: null,
      exitReason: null,
      insiderCount: 1,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
    });
    console.log(`[CopyTrade] Skipped ${symbol} (${tokenInfo.chain}) - GoPlus API unavailable`);
    return;
  }
  if (isGoPlusKillSwitch(goPlusData)) {
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
      tokenCreatedAt: pair?.pairCreatedAt ?? null,
      closeTimestamp: null,
      exitReason: null,
      insiderCount: 1,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
    });
    console.log(`[CopyTrade] Skipped ${symbol} (${tokenInfo.chain}) - GoPlus kill-switch (honeypot/high-tax/scam)`);
    return;
  }

  const liquidityOk = liquidityUsd >= COPY_TRADE_CONFIG.MIN_LIQUIDITY_USD;

  if (isPaperMode()) {
    // Paper buy
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
      tokenCreatedAt: pair?.pairCreatedAt ?? null,
      closeTimestamp: null,
      exitReason: null,
      insiderCount: 1,
      peakPnlPct: 0,
      walletScoreAtBuy: tokenInfo.walletScore,
      exitDetail: null,
    });
    console.log(`[CopyTrade] ${liquidityOk ? "Paper buy" : "Skipped"}: ${symbol} (${tokenInfo.chain}) ${formatPrice(priceUsd)}, liq $${liquidityUsd.toFixed(0)}`);
    if (liquidityOk) {
      notifyCopyTrade({
        walletAddress: tokenInfo.walletAddress,
        tokenSymbol: symbol,
        chain: tokenInfo.chain,
        side: "buy",
        priceUsd,
        liquidityOk,
        liquidityUsd,
        skipReason: null,
      }).catch(err => console.error("[CopyTrade] Notification error:", err));
    }
  } else {
    // Live buy
    if (!liquidityOk) {
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
        liquidityOk: false,
        liquidityUsd,
        skipReason: `low liquidity $${liquidityUsd.toFixed(0)}`,
        buyTimestamp: Date.now(),
        tokenCreatedAt: pair?.pairCreatedAt ?? null,
        closeTimestamp: null,
        exitReason: null,
        insiderCount: 1,
        peakPnlPct: 0,
        walletScoreAtBuy: tokenInfo.walletScore,
        exitDetail: null,
      });
      console.log(`[CopyTrade] LIVE: Skip ${symbol} (${tokenInfo.chain}) - low liquidity $${liquidityUsd.toFixed(0)}`);
      return;
    }
    if (!isChainSupported(tokenInfo.chain as Chain)) {
      console.log(`[CopyTrade] LIVE: Skip ${symbol} - chain ${tokenInfo.chain} not supported`);
      return;
    }
    const balance = await getNativeBalance(tokenInfo.chain as Chain);
    if (balance === null || balance < 1000000000000000n) {
      console.log(`[CopyTrade] LIVE: Skip ${symbol} - insufficient gas on ${tokenInfo.chain}`);
      return;
    }
    const nativePrice = getApproxUsdValue(1, tokenInfo.chain as Chain);
    const amountNative = positionAmount / nativePrice;
    const result = await execute1inchSwap(tokenInfo.chain as Chain, tokenInfo.tokenAddress, amountNative, 3);
    if (result.success) {
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
        status: "open",
        liquidityOk,
        liquidityUsd,
        skipReason: null,
        buyTimestamp: Date.now(),
        tokenCreatedAt: pair?.pairCreatedAt ?? null,
        closeTimestamp: null,
        exitReason: null,
        insiderCount: 1,
        peakPnlPct: 0,
        walletScoreAtBuy: tokenInfo.walletScore,
        exitDetail: null,
        txHash: result.txHash,
        tokensReceived: result.tokensReceived,
        isLive: true,
      });
      console.log(`[CopyTrade] LIVE BUY: ${symbol} (${tokenInfo.chain}) tx=${result.txHash}`);
      notifyCopyTrade({
        walletAddress: tokenInfo.walletAddress,
        tokenSymbol: symbol,
        chain: tokenInfo.chain,
        side: "buy",
        priceUsd,
        liquidityOk,
        liquidityUsd,
        skipReason: null,
      }).catch(err => console.error("[CopyTrade] Notification error:", err));
    } else {
      console.log(`[CopyTrade] LIVE BUY FAILED: ${symbol} (${tokenInfo.chain}) - ${result.error}`);
    }
  }
  } finally {
    tokenBuyLock.delete(tokenLockKey);
  }
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

  // Clean stale entries from lastSeenTxTimestamp
  const activeKeys = new Set(qualifiedWallets.map((w) => `${w.address}_${w.chain}`));
  for (const key of lastSeenTxTimestamp.keys()) {
    if (!activeKeys.has(key)) {
      lastSeenTxTimestamp.delete(key);
    }
  }

  let newBuysTotal = 0;

  for (const wallet of qualifiedWallets) {
    const walletKey = `${wallet.address}_${wallet.chain}`;

    try {
      // Circuit breaker
      const pausedUntil = pausedWallets.get(wallet.address);
      if (pausedUntil) {
        if (Date.now() < pausedUntil) {
          continue; // still paused
        }
        pausedWallets.delete(wallet.address); // pause expired
      }

      // Circuit breaker
      const copyStats = getWalletCopyTradeStats(wallet.address);
      const cb = checkCircuitBreaker(copyStats);
      if (cb.blocked) {
        if (copyStats.consecutiveLosses >= 3) {
          pausedWallets.set(wallet.address, Date.now() + 24 * 60 * 60 * 1000);
          console.log(`[Watcher] Pausing ${wallet.address.slice(0, 8)} for 24h: ${cb.reason}`);
        } else {
          console.log(`[Watcher] Rejecting ${wallet.address.slice(0, 8)}: ${cb.reason}`);
        }
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

      const recentOutgoing = data.result.filter((tx) => {
        const ts = parseInt(tx.timeStamp);
        if (ts <= lastSeenTs) return false;
        if (tx.from.toLowerCase() !== wallet.address.toLowerCase()) return false;
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

      // Recent incoming transfers
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
            hasTradeHistory: copyStats.totalTrades > 0,
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

export function clearWatcherMemory(): void {
  lastSeenTxTimestamp.clear();
  pausedWallets.clear();
  processedTxHashes.clear();
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

export async function backfillTokenCreatedAt(): Promise<void> {
  const trades = getOpenCopyTrades().filter(t => !t.tokenCreatedAt);
  if (trades.length === 0) return;

  const unique = [...new Map(trades.map(t => [`${t.tokenAddress}:${t.chain}`, t])).values()];
  console.log(`[CopyTrade] Backfilling launch dates for ${unique.length} tokens`);

  for (const trade of unique) {
    try {
      const pair = await dexScreenerFetch(trade.chain, trade.tokenAddress);
      if (pair?.pairCreatedAt) {
        updateCopyTradeTokenCreatedAt(trade.tokenAddress, trade.chain, pair.pairCreatedAt);
        console.log(`[CopyTrade] Backfilled launch date for ${trade.tokenSymbol}: ${new Date(pair.pairCreatedAt).toLocaleDateString()}`);
      }
    } catch {
      // Non-fatal - will show "found" date as fallback
    }
  }
}
