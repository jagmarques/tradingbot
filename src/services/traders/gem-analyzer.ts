import { getCachedGemAnalysis, saveGemAnalysis, insertGemPaperTrade, getGemPaperTrade, getOpenGemPaperTrades, closeGemPaperTrade, getTokenAddressForGem, updateGemPaperTradePrice, getInsiderStatsForToken, type GemAnalysis } from "./storage.js";
import { isPaperMode } from "../../config/env.js";
import { dexScreenerFetch, dexScreenerFetchBatch } from "../shared/dexscreener.js";
import { getApproxUsdValue } from "../copy/filter.js";
import { execute1inchSwap, getNativeBalance, isChainSupported, approveAndSell1inch } from "../evm/index.js";
import { executeJupiterSwap, executeJupiterSell } from "../solana/jupiter.js";
import { getSolBalance } from "../solana/wallet.js";
import type { Chain } from "./types.js";

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  base: "8453",
  arbitrum: "42161",
  polygon: "137",
  optimism: "10",
  avalanche: "43114",
  solana: "solana",
};

export async function fetchGoPlusData(tokenAddress: string, chain: string): Promise<Record<string, unknown> | null> {
  const chainId = GOPLUS_CHAIN_IDS[chain];
  if (!chainId) {
    console.warn(`[GemAnalyzer] Unsupported chain: ${chain}`);
    return null;
  }

  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    console.log(`[GemAnalyzer] GoPlus fetch for ${tokenAddress} on ${chain}`);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[GemAnalyzer] GoPlus API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      code: number;
      result: Record<string, Record<string, unknown>>;
    };

    if (data.code !== 1) {
      console.warn(`[GemAnalyzer] GoPlus error code ${data.code}`);
      return null;
    }
    if (!data.result) return null;

    // EVM chains: GoPlus returns lowercase hex keys; Solana: original base58 case
    const key = chain === "solana" ? tokenAddress : tokenAddress.toLowerCase();
    const tokenData = data.result[key];
    return tokenData || null;
  } catch (error) {
    console.warn(`[GemAnalyzer] GoPlus fetch failed for ${tokenAddress}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

export function isGoPlusKillSwitch(data: Record<string, unknown>): boolean {
  // KILL FLAGS - any of these = instant 0
  if (
    data.is_honeypot === "1" ||
    data.is_mintable === "1" ||
    data.owner_change_balance === "1" ||
    data.can_take_back_ownership === "1" ||
    data.hidden_owner === "1" ||
    data.selfdestruct === "1" ||
    data.is_blacklisted === "1" ||
    data.slippage_modifiable === "1" ||
    data.is_proxy === "1" ||
    data.transfer_pausable === "1" ||
    data.anti_whale_modifiable === "1" ||
    data.cannot_sell_all === "1" ||
    data.cannot_buy === "1" ||
    data.is_whitelisted === "1" ||
    data.is_airdrop_scam === "1" ||
    (typeof data.is_true_token === "string" && data.is_true_token === "0")
  ) {
    return true;
  }

  // Creator history kill flag
  if (typeof data.honeypot_with_same_creator === "string") {
    const count = parseInt(data.honeypot_with_same_creator, 10);
    if (!isNaN(count) && count > 0) return true;
  }

  // Tax kill flags (>10%)
  if (typeof data.buy_tax === "string" && data.buy_tax !== "") {
    const buyTaxPct = parseFloat(data.buy_tax) * 100;
    if (!isNaN(buyTaxPct) && buyTaxPct > 10) return true;
  }

  if (typeof data.sell_tax === "string" && data.sell_tax !== "") {
    const sellTaxPct = parseFloat(data.sell_tax) * 100;
    if (!isNaN(sellTaxPct) && sellTaxPct > 10) return true;
  }

  return false;
}

export function scoreByInsiders(tokenAddress: string, chain: string): number {
  const stats = getInsiderStatsForToken(tokenAddress, chain);

  let score = 0;

  // Insider count (40pts - most important signal)
  if (stats.insiderCount >= 20) score += 40;
  else if (stats.insiderCount >= 10) score += 25;
  else if (stats.insiderCount >= 5) score += 15;

  // Hold rate (30pts)
  if (stats.holdRate >= 80) score += 30;
  else if (stats.holdRate >= 60) score += 20;
  else if (stats.holdRate >= 40) score += 10;

  // Avg insider quality (30pts)
  if (stats.avgInsiderQuality >= 8) score += 30;
  else if (stats.avgInsiderQuality >= 5) score += 20;
  else if (stats.avgInsiderQuality >= 3) score += 10;

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

export async function analyzeGem(symbol: string, chain: string, tokenAddress: string): Promise<GemAnalysis> {
  const cached = getCachedGemAnalysis(symbol, chain);
  if (cached) return cached;

  // Score primarily by insider stats
  let score = scoreByInsiders(tokenAddress, chain);

  // GoPlus kill-switch (EVM only - no Solana coverage)
  if (chain !== "solana") {
    const goPlusData = await fetchGoPlusData(tokenAddress, chain);
    if (goPlusData && isGoPlusKillSwitch(goPlusData)) {
      score = 0;
    }
  }

  const analysis: GemAnalysis = {
    tokenSymbol: symbol,
    chain,
    score,
    analyzedAt: Date.now(),
  };

  saveGemAnalysis(analysis);
  console.log(`[GemAnalyzer] ${symbol} (${chain}): score=${score}`);

  return analysis;
}

// Track tokens that repeatedly fail price fetch - stop retrying after MAX_PRICE_FAILURES
const MAX_PRICE_FAILURES = 3;
const priceFetchFailures = new Map<string, number>();

export async function buyGems(
  tokens: Array<{ symbol: string; chain: string; currentPump: number; score: number; tokenAddress: string }>
): Promise<void> {
  for (const token of tokens) {
    if (token.score < 80) continue;
    if (token.currentPump >= 50) {
      console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - already pumped ${token.currentPump.toFixed(1)}x`);
      continue;
    }
    const existing = getGemPaperTrade(token.symbol, token.chain);
    if (existing) continue;

    const failKey = `${token.symbol}_${token.chain}`;
    const failures = priceFetchFailures.get(failKey) ?? 0;
    if (failures >= MAX_PRICE_FAILURES) continue;

    const pair = await dexScreenerFetch(token.chain, token.tokenAddress);
    const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
    const liquidityUsd = pair?.liquidity?.usd ?? 0;

    if (priceUsd <= 0) {
      const newFails = failures + 1;
      priceFetchFailures.set(failKey, newFails);
      if (newFails >= MAX_PRICE_FAILURES) {
        console.log(`[GemAnalyzer] Giving up on ${token.symbol} (${token.chain}) - no price after ${MAX_PRICE_FAILURES} attempts`);
      }
      continue;
    }

    if (liquidityUsd < 1000) {
      console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - liquidity $${liquidityUsd.toFixed(0)} < $1000 (likely clone)`);
      continue;
    }

    priceFetchFailures.delete(failKey);

    // Branch: paper mode vs live mode
    if (isPaperMode()) {
      // Paper mode - existing behavior
      insertGemPaperTrade({
        tokenSymbol: token.symbol,
        chain: token.chain,
        buyTimestamp: Date.now(),
        amountUsd: 10,
        pnlPct: 0,
        aiScore: token.score,
        status: "open",
        buyPriceUsd: priceUsd,
        currentPriceUsd: priceUsd,
        buyPumpMultiple: token.currentPump,
        currentPumpMultiple: token.currentPump,
      });

      console.log(`[GemAnalyzer] Paper buy: ${token.symbol} (${token.chain}) at $${priceUsd.toFixed(6)}, score: ${token.score}`);
    } else {
      // Live mode - execute on-chain buy
      if (token.chain === "solana") {
        // Solana live buy via Jupiter
        const solBalance = await getSolBalance().catch(() => 0n);
        if (solBalance < 10_000_000n) { // 0.01 SOL minimum
          console.log(`[GemTrader] LIVE: Skip ${token.symbol} - insufficient SOL`);
          continue;
        }
        const solPrice = getApproxUsdValue(1, "solana");
        const amountSol = 10 / solPrice; // $10 in SOL
        const result = await executeJupiterSwap(token.tokenAddress, amountSol, 100);
        if (result.success) {
          insertGemPaperTrade({
            tokenSymbol: token.symbol,
            chain: token.chain,
            buyTimestamp: Date.now(),
            amountUsd: 10,
            pnlPct: 0,
            aiScore: token.score,
            status: "open",
            buyPriceUsd: priceUsd,
            currentPriceUsd: priceUsd,
            txHash: result.signature,
            tokensReceived: result.tokensReceived,
            isLive: true,
            buyPumpMultiple: token.currentPump,
            currentPumpMultiple: token.currentPump,
          });
          console.log(`[GemTrader] LIVE BUY: ${token.symbol} (solana) tx=${result.signature}`);
        } else {
          console.log(`[GemTrader] LIVE BUY FAILED: ${token.symbol} (solana) - ${result.error}`);
        }
        continue;
      }

      // EVM live buy via 1inch
      if (!isChainSupported(token.chain as Chain)) {
        console.log(`[GemTrader] LIVE: Skip ${token.symbol} - chain ${token.chain} not supported by 1inch`);
        continue;
      }

      const balance = await getNativeBalance(token.chain as Chain);
      if (balance === null || balance < 1000000000000000n) { // 0.001 ETH
        console.log(`[GemTrader] LIVE: Skip ${token.symbol} - insufficient gas on ${token.chain}`);
        continue;
      }

      const nativePrice = getApproxUsdValue(1, token.chain as Chain);
      const amountNative = 10 / nativePrice; // $10 in native tokens

      const result = await execute1inchSwap(token.chain as Chain, token.tokenAddress, amountNative, 3);

      if (result.success) {
        insertGemPaperTrade({
          tokenSymbol: token.symbol,
          chain: token.chain,
          buyTimestamp: Date.now(),
          amountUsd: 10,
          pnlPct: 0,
          aiScore: token.score,
          status: "open",
          buyPriceUsd: priceUsd,
          currentPriceUsd: priceUsd,
          txHash: result.txHash,
          tokensReceived: result.tokensReceived,
          isLive: true,
          buyPumpMultiple: token.currentPump,
          currentPumpMultiple: token.currentPump,
        });

        console.log(`[GemTrader] LIVE BUY: ${token.symbol} (${token.chain}) tx=${result.txHash}`);
      } else {
        console.log(`[GemTrader] LIVE BUY FAILED: ${token.symbol} (${token.chain}) - ${result.error}`);
      }
    }
  }
}

export async function sellGemPosition(symbol: string, chain: string): Promise<void> {
  const trade = getGemPaperTrade(symbol, chain);
  if (!trade || trade.status === "closed") return;

  // Paper mode - just close the trade
  if (!trade.isLive) {
    closeGemPaperTrade(symbol, chain);
    console.log(`[GemTrader] Paper close: ${symbol} (${chain})`);
    return;
  }

  // Live mode - sell on-chain
  const tokenAddress = getTokenAddressForGem(symbol, chain);
  if (!tokenAddress) {
    console.log(`[GemTrader] LIVE SELL WARNING: ${symbol} (${chain}) - no token address, closing anyway`);
    closeGemPaperTrade(symbol, chain);
    return;
  }

  // Solana live sell via Jupiter
  if (chain === "solana" && trade.tokensReceived) {
    const result = await executeJupiterSell(tokenAddress, trade.tokensReceived);
    if (result.success) {
      closeGemPaperTrade(symbol, chain, result.signature);
      console.log(`[GemTrader] LIVE SELL: ${symbol} (solana) tx=${result.signature}`);
    } else {
      closeGemPaperTrade(symbol, chain);
      console.log(`[GemTrader] LIVE SELL FAILED: ${symbol} (solana) - ${result.error}`);
    }
    return;
  }

  // EVM live sell via 1inch
  const result = await approveAndSell1inch(chain as Chain, tokenAddress, 3);

  if (result.success) {
    console.log(`[GemTrader] LIVE SELL: ${symbol} (${chain}) tx=${result.txHash}`);
    closeGemPaperTrade(symbol, chain, result.txHash);
  } else {
    console.log(`[GemTrader] LIVE SELL FAILED: ${symbol} (${chain}) - ${result.error}. Closing trade anyway.`);
    closeGemPaperTrade(symbol, chain);
  }
}

export function analyzeGemsBackground(
  tokens: Array<{
    symbol: string;
    chain: string;
    currentPump: number;
    tokenAddress: string;
  }>
): void {
  console.log(`[GemAnalyzer] Background analysis started for ${tokens.length} tokens`);

  (async () => {
    const results: Array<{ symbol: string; chain: string; currentPump: number; score: number; tokenAddress: string }> = [];

    for (const token of tokens) {
      try {
        const analysis = await analyzeGem(token.symbol, token.chain, token.tokenAddress);
        results.push({ symbol: token.symbol, chain: token.chain, currentPump: token.currentPump, score: analysis.score, tokenAddress: token.tokenAddress });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`[GemAnalyzer] Background analysis error for ${token.symbol}:`, error);
      }
    }

    await buyGems(results);
  })();
}

export async function revalidateHeldGems(): Promise<void> {
  const openTrades = getOpenGemPaperTrades();
  if (openTrades.length === 0) return;

  console.log(`[GemAnalyzer] Revalidating ${openTrades.length} held gems`);

  // Look up token addresses
  const tokensToCheck: Array<{ chain: string; tokenAddress: string; symbol: string }> = [];
  for (const trade of openTrades) {
    const tokenAddress = getTokenAddressForGem(trade.tokenSymbol, trade.chain);
    if (tokenAddress) {
      tokensToCheck.push({ chain: trade.chain, tokenAddress, symbol: trade.tokenSymbol });
    }
  }

  if (tokensToCheck.length === 0) return;

  // Batch-fetch DexScreener prices
  const priceMap = await dexScreenerFetchBatch(tokensToCheck);

  // Auto-close trades with low liquidity
  for (const token of tokensToCheck) {
    const addrKey = token.chain === "solana" ? token.tokenAddress : token.tokenAddress.toLowerCase();
    const pair = priceMap.get(addrKey);
    if (!pair) continue;

    const liquidityUsd = pair.liquidity?.usd ?? 0;
    if (liquidityUsd < 500) {
      await sellGemPosition(token.symbol, token.chain);
      console.log(`[GemAnalyzer] Auto-close ${token.symbol}: liquidity $${liquidityUsd.toFixed(0)} < $500 (rug)`);
    }
  }
}

export async function refreshGemPaperPrices(): Promise<void> {
  const openTrades = getOpenGemPaperTrades();
  if (openTrades.length === 0) return;

  // Look up token addresses
  const tokensToFetch: Array<{ chain: string; tokenAddress: string; symbol: string }> = [];
  for (const trade of openTrades) {
    const tokenAddress = getTokenAddressForGem(trade.tokenSymbol, trade.chain);
    if (tokenAddress) {
      tokensToFetch.push({ chain: trade.chain, tokenAddress, symbol: trade.tokenSymbol });
    }
  }

  if (tokensToFetch.length === 0) return;

  // Batch-fetch prices
  const priceMap = await dexScreenerFetchBatch(tokensToFetch);

  // Update prices in database
  let updated = 0;
  for (const token of tokensToFetch) {
    const addrKey = token.chain === "solana" ? token.tokenAddress : token.tokenAddress.toLowerCase();
    const pair = priceMap.get(addrKey);
    if (!pair) continue;

    const priceUsd = parseFloat(pair.priceUsd || "0");
    if (priceUsd > 0) {
      updateGemPaperTradePrice(token.symbol, token.chain, priceUsd);
      updated++;
    }
  }

  if (updated > 0) {
    console.log(`[GemAnalyzer] Refreshed prices for ${updated} open paper trades`);
  }
}
