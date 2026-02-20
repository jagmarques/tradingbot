import { getCachedGemAnalysis, saveGemAnalysis, insertGemPaperTrade, getGemPaperTrade, getOpenGemPaperTrades, closeGemPaperTrade, getTokenAddressForGem, updateGemPaperTradePrice, getInsiderStatsForToken, getOpenCopyTrades, updateCopyTradePrice, closeCopyTrade, updateCopyTradePeakPnl, type GemAnalysis } from "./storage.js";
import { INSIDER_CONFIG, COPY_TRADE_CONFIG } from "./types.js";
import { isPaperMode } from "../../config/env.js";
import { dexScreenerFetch, dexScreenerFetchBatch } from "../shared/dexscreener.js";
import { getApproxUsdValue } from "../copy/filter.js";
import { execute1inchSwap, getNativeBalance, isChainSupported, approveAndSell1inch } from "../evm/index.js";
import { notifyCopyTrade } from "../telegram/notifications.js";
import type { Chain } from "./types.js";

// Price failure tracking for copy trades (auto-close after repeated failures)
const copyPriceFailures = new Map<string, { count: number; lastFailAt: number }>();
const COPY_MAX_PRICE_FAILURES = 3;
const COPY_PRICE_FAILURE_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  base: "8453",
  arbitrum: "42161",
  polygon: "137",
  optimism: "10",
  avalanche: "43114",
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

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

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

    const key = tokenAddress.toLowerCase();
    const tokenData = data.result[key];
    return tokenData || null;
  } catch (error) {
    console.warn(`[GemAnalyzer] GoPlus fetch failed for ${tokenAddress}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

export function isGoPlusKillSwitch(data: Record<string, unknown>): boolean {
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

  if (typeof data.honeypot_with_same_creator === "string") {
    const count = parseInt(data.honeypot_with_same_creator, 10);
    if (!isNaN(count) && count > 0) return true;
  }

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

  // Insider count (20pts)
  if (stats.insiderCount >= 10) score += 20;
  else if (stats.insiderCount >= 5) score += 15;
  else if (stats.insiderCount >= 2) score += 10;
  else if (stats.insiderCount >= 1) score += 5;

  // Hold rate (40pts)
  if (stats.holdRate >= 80) score += 40;
  else if (stats.holdRate >= 60) score += 30;
  else if (stats.holdRate >= 40) score += 20;
  else if (stats.holdRate >= 20) score += 10;

  // Avg insider quality (40pts)
  if (stats.avgInsiderQuality >= 8) score += 40;
  else if (stats.avgInsiderQuality >= 5) score += 30;
  else if (stats.avgInsiderQuality >= 3) score += 20;
  else if (stats.avgInsiderQuality >= 1) score += 10;

  return Math.max(0, Math.min(100, score));
}

function scoreContractSafety(data: Record<string, unknown>): number {
  let pts = 0;

  const owner = data.owner_address;
  if (owner === "" || owner === null || owner === "0x0000000000000000000000000000000000000000") pts += 8;

  if (typeof data.buy_tax === "string" && data.buy_tax !== "") {
    const bt = parseFloat(data.buy_tax);
    if (!isNaN(bt)) {
      if (bt <= 0.01) pts += 4;
      else if (bt <= 0.05) pts += 2;
    }
  }

  if (typeof data.sell_tax === "string" && data.sell_tax !== "") {
    const st = parseFloat(data.sell_tax);
    if (!isNaN(st)) {
      if (st <= 0.01) pts += 4;
      else if (st <= 0.05) pts += 2;
    }
  }

  if (data.external_call === "0") pts += 4;

  return pts; // max 20
}

function scoreLiquidityHealth(pair: import("../shared/dexscreener.js").DexPair): number {
  let pts = 0;

  const liqUsd = pair.liquidity?.usd ?? 0;
  if (liqUsd >= 50_000) pts += 15;
  else if (liqUsd >= 20_000) pts += 10;
  else if (liqUsd >= 5_000) pts += 6;
  else if (liqUsd >= 2_000) pts += 3;

  const fdv = pair.fdv ?? 0;
  if (fdv > 0 && liqUsd > 0) {
    const ratio = liqUsd / fdv;
    if (ratio >= 0.10) pts += 12;
    else if (ratio >= 0.05) pts += 8;
    else if (ratio >= 0.02) pts += 4;
  }

  const vol24h = pair.volume?.h24 ?? 0;
  if (liqUsd > 0 && vol24h > 0) {
    const volRatio = vol24h / liqUsd;
    if (volRatio >= 1.0) pts += 8;
    else if (volRatio >= 0.5) pts += 5;
    else if (volRatio >= 0.1) pts += 3;
  }

  return pts; // max 35
}

function scoreHolderDistribution(data: Record<string, unknown>): number {
  let pts = 0;

  const holders = Array.isArray(data.holders) ? (data.holders as Array<{ percent?: number | string; is_locked?: number | string }>) : [];

  if (holders.length >= 100) pts += 4;
  else if (holders.length >= 50) pts += 3;
  else if (holders.length >= 20) pts += 2;

  if (holders.length > 0) {
    const top10 = holders.slice(0, 10);
    const concentration = top10.reduce((sum, h) => {
      const pct = typeof h.percent === "string" ? parseFloat(h.percent) : (h.percent ?? 0);
      return sum + (isNaN(pct as number) ? 0 : (pct as number));
    }, 0);
    const concPct = concentration >= 1.5 ? concentration : concentration * 100;
    if (concPct <= 30) pts += 6;
    else if (concPct <= 50) pts += 4;
    else if (concPct <= 70) pts += 2;
  }

  const creatorPctRaw = data.creator_percent;
  if (creatorPctRaw !== undefined && creatorPctRaw !== null) {
    const cp = typeof creatorPctRaw === "string" ? parseFloat(creatorPctRaw) : (creatorPctRaw as number);
    if (!isNaN(cp)) {
      const cpPct = cp >= 1.5 ? cp : cp * 100;
      if (cpPct <= 5) pts += 3;
      else if (cpPct <= 10) pts += 2;
    }
  }

  const lpHolders = Array.isArray(data.lp_holders) ? (data.lp_holders as Array<{ is_locked?: number | string }>) : [];
  if (lpHolders.some((lp) => String(lp.is_locked) === "1")) pts += 2;

  return pts; // max 15
}

function scoreGrowthPotential(pair: import("../shared/dexscreener.js").DexPair): number {
  let pts = 0;

  const fdv = pair.fdv ?? 0;
  if (fdv >= 10_000 && fdv <= 100_000) pts += 7;
  else if (fdv > 100_000 && fdv <= 500_000) pts += 5;
  else if (fdv > 0 && fdv < 10_000) pts += 3;

  const createdAt = pair.pairCreatedAt ?? 0;
  if (createdAt > 0) {
    const ageMs = Date.now() - createdAt;
    if (ageMs > 0) {
      const ageDays = ageMs / 86_400_000;
      if (ageDays >= 1 && ageDays <= 7) pts += 7;
      else if (ageDays > 7 && ageDays <= 30) pts += 5;
      else if (ageDays < 1) pts += 3;
    }
  }

  const change24h = pair.priceChange?.h24 ?? null;
  if (change24h !== null) {
    if (change24h >= 50) pts += 6;
    else if (change24h >= 20) pts += 4;
    else if (change24h > 0) pts += 1;
  }

  return pts; // max 20
}

export function scoreGemQuality(
  goPlusData: Record<string, unknown> | null,
  pair: import("../shared/dexscreener.js").DexPair | null,
  tokenAddress: string,
  chain: string
): number {
  const liquidity = pair ? scoreLiquidityHealth(pair) : 0;
  const safety = goPlusData ? scoreContractSafety(goPlusData) : 0;
  const growth = pair ? scoreGrowthPotential(pair) : 0;
  const holders = goPlusData ? scoreHolderDistribution(goPlusData) : 0;
  const insiderRaw = scoreByInsiders(tokenAddress, chain);
  const insider = Math.round(insiderRaw / 10);

  const total = safety + liquidity + holders + growth + insider;

  if (growth === 0) {
    return Math.min(total, 45);
  }

  return Math.max(0, Math.min(100, total));
}

// Cache so analyzeGem and buyGems share the same DexPair fetch
const gemDexCache = new Map<string, import("../shared/dexscreener.js").DexPair>();

export async function analyzeGem(symbol: string, chain: string, tokenAddress: string): Promise<GemAnalysis> {
  const cached = getCachedGemAnalysis(symbol, chain);
  if (cached) return cached;

  const goPlusData = await fetchGoPlusData(tokenAddress, chain);
  if (goPlusData && isGoPlusKillSwitch(goPlusData)) {
    const analysis: GemAnalysis = { tokenSymbol: symbol, chain, score: 0, analyzedAt: Date.now() };
    saveGemAnalysis(analysis);
    console.log(`[GemAnalyzer] ${symbol} (${chain}): score=0 (GoPlus kill-switch)`);
    return analysis;
  }

  const pair = await dexScreenerFetch(chain, tokenAddress);
  if (pair) {
    gemDexCache.set(`${tokenAddress}_${chain}`, pair);
  }

  let score = scoreGemQuality(goPlusData, pair, tokenAddress, chain);

  const pairAgeDays = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86_400_000 : 0;
  if (pairAgeDays > INSIDER_CONFIG.MAX_GEM_AGE_DAYS) {
    score = Math.min(score, INSIDER_CONFIG.MIN_GEM_SCORE - 1);
  }

  const analysis: GemAnalysis = { tokenSymbol: symbol, chain, score, analyzedAt: Date.now() };
  saveGemAnalysis(analysis);

  const ageDays = pair?.pairCreatedAt ? Math.round((Date.now() - pair.pairCreatedAt) / 86_400_000) : -1;
  const fdvK = pair?.fdv ? (pair.fdv / 1000).toFixed(0) : "?";
  const liqK = pair?.liquidity?.usd ? (pair.liquidity.usd / 1000).toFixed(0) : "?";
  console.log(`[GemAnalyzer] ${symbol} (${chain}): score=${score} age=${ageDays}d fdv=$${fdvK}k liq=$${liqK}k`);

  return analysis;
}

const MAX_PRICE_FAILURES = 3;
const PRICE_FAILURE_EXPIRY_MS = 4 * 60 * 60 * 1000;
const priceFetchFailures = new Map<string, { count: number; lastFailAt: number }>();

const buyingLock = new Set<string>();
const sellingLock = new Set<string>();

export async function buyGems(
  tokens: Array<{ symbol: string; chain: string; currentPump: number; score: number; tokenAddress: string }>
): Promise<void> {
  for (const token of tokens) {
    if (token.score < INSIDER_CONFIG.MIN_GEM_SCORE) continue;
    if (token.currentPump >= INSIDER_CONFIG.MAX_BUY_PUMP) {
      console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - already pumped ${token.currentPump.toFixed(1)}x`);
      continue;
    }
    const existing = getGemPaperTrade(token.symbol, token.chain);
    if (existing && existing.status === "open") continue;

    const lockKey = `${token.symbol}_${token.chain}`;
    if (buyingLock.has(lockKey)) continue;
    buyingLock.add(lockKey);

    try {
      const failKey = `${token.symbol}_${token.chain}`;
      const failEntry = priceFetchFailures.get(failKey);
      if (failEntry && failEntry.count >= MAX_PRICE_FAILURES) {
        if (Date.now() - failEntry.lastFailAt < PRICE_FAILURE_EXPIRY_MS) continue;
        priceFetchFailures.delete(failKey);
      }

      const cacheKey = `${token.tokenAddress}_${token.chain}`;
      const cachedPair = gemDexCache.get(cacheKey);
      gemDexCache.delete(cacheKey);
      const pair = cachedPair ?? (await dexScreenerFetch(token.chain, token.tokenAddress));
      const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
      const liquidityUsd = pair?.liquidity?.usd ?? 0;

      if (priceUsd <= 0) {
        const prev = priceFetchFailures.get(failKey);
        const newCount = (prev?.count ?? 0) + 1;
        priceFetchFailures.set(failKey, { count: newCount, lastFailAt: Date.now() });
        if (newCount >= MAX_PRICE_FAILURES) {
          console.log(`[GemAnalyzer] Giving up on ${token.symbol} (${token.chain}) - no price after ${MAX_PRICE_FAILURES} attempts`);
        }
        continue;
      }

      if (liquidityUsd < 2000) {
        console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - liquidity $${liquidityUsd.toFixed(0)} < $2000`);
        continue;
      }

      const pairFdv = pair?.fdv || 0;
      if (pairFdv > 500_000) {
        console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - FDV $${(pairFdv / 1000).toFixed(0)}k > $500k`);
        continue;
      }

      const ageDays = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 86_400_000 : 0;
      if (ageDays > INSIDER_CONFIG.MAX_GEM_AGE_DAYS) {
        console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - token age ${Math.round(ageDays)}d > ${INSIDER_CONFIG.MAX_GEM_AGE_DAYS}d`);
        continue;
      }

      priceFetchFailures.delete(failKey);

      if (isPaperMode()) {
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
        if (!isChainSupported(token.chain as Chain)) {
          console.log(`[GemTrader] LIVE: Skip ${token.symbol} - chain ${token.chain} not supported`);
          continue;
        }

        const balance = await getNativeBalance(token.chain as Chain);
        if (balance === null || balance < 1000000000000000n) {
          console.log(`[GemTrader] LIVE: Skip ${token.symbol} - insufficient gas on ${token.chain}`);
          continue;
        }

        const nativePrice = getApproxUsdValue(1, token.chain as Chain);
        const amountNative = 10 / nativePrice;
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
    } finally {
      buyingLock.delete(lockKey);
    }
  }
}

export async function sellGemPosition(symbol: string, chain: string): Promise<void> {
  const sellKey = `${symbol}_${chain}`;
  if (sellingLock.has(sellKey)) return;
  sellingLock.add(sellKey);

  try {
    const trade = getGemPaperTrade(symbol, chain);
    if (!trade || trade.status === "closed") return;

    if (!trade.isLive) {
      closeGemPaperTrade(symbol, chain);
      console.log(`[GemTrader] Paper close: ${symbol} (${chain})`);
      return;
    }

    const tokenAddress = getTokenAddressForGem(symbol, chain);
    if (!tokenAddress) {
      console.log(`[GemTrader] LIVE SELL: ${symbol} (${chain}) - no token address, closing anyway`);
      closeGemPaperTrade(symbol, chain);
      return;
    }

    const result = await approveAndSell1inch(chain as Chain, tokenAddress, 3);
    if (result.success) {
      console.log(`[GemTrader] LIVE SELL: ${symbol} (${chain}) tx=${result.txHash}`);
      closeGemPaperTrade(symbol, chain, result.txHash);
    } else {
      console.log(`[GemTrader] LIVE SELL FAILED: ${symbol} (${chain}) - ${result.error}. Closing anyway.`);
      closeGemPaperTrade(symbol, chain);
    }
  } finally {
    sellingLock.delete(sellKey);
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

  void (async (): Promise<void> => {
    const results: Array<{ symbol: string; chain: string; currentPump: number; score: number; tokenAddress: string }> = [];

    for (const token of tokens) {
      try {
        const analysis = await analyzeGem(token.symbol, token.chain, token.tokenAddress);
        results.push({ symbol: token.symbol, chain: token.chain, currentPump: token.currentPump, score: analysis.score, tokenAddress: token.tokenAddress });
      } catch (error) {
        console.error(`[GemAnalyzer] Background analysis error for ${token.symbol}:`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await buyGems(results);
    gemDexCache.clear();
  })().catch((err) => console.error("[GemAnalyzer] Background batch error:", err));
}

export async function revalidateHeldGems(): Promise<void> {
  const openTrades = getOpenGemPaperTrades();
  if (openTrades.length === 0) return;

  console.log(`[GemAnalyzer] Revalidating ${openTrades.length} held gems`);

  const tokensToCheck: Array<{ chain: string; tokenAddress: string; symbol: string }> = [];
  for (const trade of openTrades) {
    const tokenAddress = getTokenAddressForGem(trade.tokenSymbol, trade.chain);
    if (tokenAddress) {
      tokensToCheck.push({ chain: trade.chain, tokenAddress, symbol: trade.tokenSymbol });
    }
  }

  if (tokensToCheck.length === 0) return;

  const priceMap = await dexScreenerFetchBatch(tokensToCheck);

  for (const token of tokensToCheck) {
    const addrKey = token.tokenAddress.toLowerCase();
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

  const tokensToFetch: Array<{ chain: string; tokenAddress: string; symbol: string }> = [];
  for (const trade of openTrades) {
    const tokenAddress = getTokenAddressForGem(trade.tokenSymbol, trade.chain);
    if (tokenAddress) {
      tokensToFetch.push({ chain: trade.chain, tokenAddress, symbol: trade.tokenSymbol });
    }
  }

  if (tokensToFetch.length === 0) return;

  const priceMap = await dexScreenerFetchBatch(tokensToFetch);

  let updated = 0;
  for (const token of tokensToFetch) {
    const addrKey = token.tokenAddress.toLowerCase();
    let pair = priceMap.get(addrKey);

    // Single fetch fallback (includes Gecko)
    if (!pair || parseFloat(pair.priceUsd || "0") <= 0) {
      pair = (await dexScreenerFetch(token.chain, token.tokenAddress)) ?? undefined;
    }

    const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
    if (priceUsd > 0) {
      updateGemPaperTradePrice(token.symbol, token.chain, priceUsd);
      updated++;
    }
  }

  if (updated > 0) {
    console.log(`[GemAnalyzer] Refreshed prices for ${updated} open paper trades`);
  }

  const refreshedTrades = getOpenGemPaperTrades();
  for (const trade of refreshedTrades) {
    if (trade.pnlPct <= -70) {
      console.log(`[GemAnalyzer] STOP LOSS: ${trade.tokenSymbol} (${trade.chain}) at ${trade.pnlPct.toFixed(0)}%`);
      await sellGemPosition(trade.tokenSymbol, trade.chain);
    }
  }
}

export async function refreshCopyTradePrices(): Promise<void> {
  const openTrades = getOpenCopyTrades();
  if (openTrades.length === 0) return;

  // Build list of tokens to fetch prices for
  const tokensToFetch: Array<{ chain: string; tokenAddress: string; walletAddress: string }> = [];
  for (const trade of openTrades) {
    tokensToFetch.push({ chain: trade.chain, tokenAddress: trade.tokenAddress, walletAddress: trade.walletAddress });
  }

  if (tokensToFetch.length === 0) return;

  // Batch fetch prices
  const priceMap = await dexScreenerFetchBatch(
    tokensToFetch.map(t => ({ chain: t.chain, tokenAddress: t.tokenAddress }))
  );

  let updated = 0;
  for (const token of tokensToFetch) {
    const addrKey = token.tokenAddress.toLowerCase();
    let pair = priceMap.get(addrKey);

    // Single fetch fallback (includes Gecko)
    if (!pair || parseFloat(pair.priceUsd || "0") <= 0) {
      pair = (await dexScreenerFetch(token.chain, token.tokenAddress)) ?? undefined;
    }

    const priceUsd = pair ? parseFloat(pair.priceUsd || "0") : 0;
    const failKey = `${token.tokenAddress}_${token.chain}`;

    if (priceUsd > 0) {
      updateCopyTradePrice(token.walletAddress, token.tokenAddress, token.chain, priceUsd);
      copyPriceFailures.delete(failKey);
      updated++;
    } else {
      // Track price fetch failures - auto-close after repeated failures
      const prev = copyPriceFailures.get(failKey);
      if (prev && Date.now() - prev.lastFailAt > COPY_PRICE_FAILURE_EXPIRY_MS) {
        copyPriceFailures.delete(failKey);
      }
      const entry = copyPriceFailures.get(failKey);
      const newCount = (entry?.count ?? 0) + 1;
      copyPriceFailures.set(failKey, { count: newCount, lastFailAt: Date.now() });
      if (newCount >= COPY_MAX_PRICE_FAILURES) {
        const trade = openTrades.find(t => t.tokenAddress.toLowerCase() === addrKey);
        if (trade) {
          console.log(`[CopyTrade] AUTO CLOSE: ${trade.tokenSymbol} (${trade.chain}) - no price after ${COPY_MAX_PRICE_FAILURES} attempts`);
          closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain);
          notifyCopyTrade({
            walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
            side: "sell", priceUsd: 0, liquidityOk: false, liquidityUsd: 0,
            skipReason: "stale price", pnlPct: trade.pnlPct,
          }).catch(() => {});
        }
        copyPriceFailures.delete(failKey);
      }
    }

    // Liquidity revalidation - auto-close if pool drained (rug)
    const liquidityUsd = pair?.liquidity?.usd ?? 0;
    if (priceUsd > 0 && liquidityUsd < 500) {
      const trade = openTrades.find(t => t.tokenAddress.toLowerCase() === addrKey);
      if (trade) {
        console.log(`[CopyTrade] RUG DETECTED: ${trade.tokenSymbol} (${trade.chain}) - liquidity $${liquidityUsd.toFixed(0)} < $500`);
        closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain);
        notifyCopyTrade({
          walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
          side: "sell", priceUsd, liquidityOk: false, liquidityUsd,
          skipReason: "liquidity rug", pnlPct: trade.pnlPct,
        }).catch(() => {});
      }
    }
  }

  if (updated > 0) {
    console.log(`[CopyTrade] Refreshed prices for ${updated} open copy trades`);
  }

  // Trailing stop-loss check
  const refreshedTrades = getOpenCopyTrades();
  for (const trade of refreshedTrades) {
    // Track peak P&L for trailing stop
    if (trade.pnlPct > trade.peakPnlPct) {
      updateCopyTradePeakPnl(trade.id, trade.pnlPct);
    }
    const peak = Math.max(trade.peakPnlPct, trade.pnlPct);

    // Auto-close at +500%
    if (trade.pnlPct >= 500) {
      console.log(`[CopyTrade] AUTO CLOSE: ${trade.tokenSymbol} (${trade.chain}) at +${trade.pnlPct.toFixed(0)}% (target reached)`);
      closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain);
      notifyCopyTrade({
        walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
        side: "sell", priceUsd: trade.currentPriceUsd, liquidityOk: true, liquidityUsd: 0,
        skipReason: null, pnlPct: trade.pnlPct,
      }).catch(() => {});
      continue;
    }

    // Trailing stop ladder based on peak profit (aggressive for micro-caps)
    let stopLevel = COPY_TRADE_CONFIG.STOP_LOSS_PCT; // -80% floor
    if (peak >= 200) {
      stopLevel = 100; // lock in +100% if we hit +200%
    } else if (peak >= 100) {
      stopLevel = 50; // lock in +50% if we hit +100%
    } else if (peak >= 50) {
      stopLevel = 0; // breakeven if we hit +50%
    }

    if (trade.pnlPct <= stopLevel) {
      const reason = stopLevel >= 0 ? `trailing stop at +${stopLevel}% (peak +${peak.toFixed(0)}%)` : `stop loss at ${stopLevel}%`;
      console.log(`[CopyTrade] STOP: ${trade.tokenSymbol} (${trade.chain}) at ${trade.pnlPct.toFixed(0)}% - ${reason}`);
      closeCopyTrade(trade.walletAddress, trade.tokenAddress, trade.chain);
      notifyCopyTrade({
        walletAddress: trade.walletAddress, tokenSymbol: trade.tokenSymbol, chain: trade.chain,
        side: "sell", priceUsd: trade.currentPriceUsd, liquidityOk: true, liquidityUsd: 0,
        skipReason: null, pnlPct: trade.pnlPct,
      }).catch(() => {});
    }
  }
}
