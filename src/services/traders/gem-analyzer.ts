import { getCachedGemAnalysis, saveGemAnalysis, insertGemPaperTrade, getGemPaperTrade, getOpenGemPaperTrades, closeGemPaperTrade, getTokenAddressForGem, updateGemPaperTradePrice, getInsiderStatsForToken, type GemAnalysis } from "./storage.js";
import { isPaperMode } from "../../config/env.js";
import { dexScreenerFetch, dexScreenerFetchBatch } from "../shared/dexscreener.js";
import { getApproxUsdValue } from "../copy/filter.js";
import { execute1inchSwap, getNativeBalance, isChainSupported, approveAndSell1inch } from "../evm/index.js";
import { executeJupiterSwap, executeJupiterSell } from "../solana/jupiter.js";
import { getSolBalance, getConnection } from "../solana/wallet.js";
import { PublicKey } from "@solana/web3.js";
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

// Check Solana SPL token freeze/mint authority on-chain
async function checkSolanaTokenAuthorities(mintAddress: string): Promise<{ freezeAuthority: boolean; mintAuthority: boolean }> {
  try {
    const conn = getConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mintAddress));
    const data = info.value?.data;
    if (data && typeof data === "object" && "parsed" in data) {
      const parsed = data.parsed as { info?: { freezeAuthority?: string | null; mintAuthority?: string | null } };
      return {
        freezeAuthority: !!parsed.info?.freezeAuthority,
        mintAuthority: !!parsed.info?.mintAuthority,
      };
    }
    return { freezeAuthority: false, mintAuthority: false };
  } catch {
    return { freezeAuthority: false, mintAuthority: false };
  }
}

export function scoreByInsiders(tokenAddress: string, chain: string): number {
  const stats = getInsiderStatsForToken(tokenAddress, chain);

  let score = 0;

  // Insider count (20pts)
  if (stats.insiderCount >= 10) score += 20;
  else if (stats.insiderCount >= 5) score += 15;
  else if (stats.insiderCount >= 2) score += 10;
  else if (stats.insiderCount >= 1) score += 5;

  // Hold rate (40pts - most important signal)
  if (stats.holdRate >= 80) score += 40;
  else if (stats.holdRate >= 60) score += 30;
  else if (stats.holdRate >= 40) score += 20;
  else if (stats.holdRate >= 20) score += 10;

  // Avg insider quality (40pts)
  if (stats.avgInsiderQuality >= 8) score += 40;
  else if (stats.avgInsiderQuality >= 5) score += 30;
  else if (stats.avgInsiderQuality >= 3) score += 20;
  else if (stats.avgInsiderQuality >= 1) score += 10;

  // Clamp to 0-100
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

  const holders = Array.isArray(data.holders) ? (data.holders as Array<{ percent?: number | string; is_locked?: number }>) : [];

  if (holders.length >= 100) pts += 4;
  else if (holders.length >= 50) pts += 3;
  else if (holders.length >= 20) pts += 2;

  if (holders.length > 0) {
    const top10 = holders.slice(0, 10);
    const concentration = top10.reduce((sum, h) => {
      const pct = typeof h.percent === "string" ? parseFloat(h.percent) : (h.percent ?? 0);
      return sum + (isNaN(pct as number) ? 0 : (pct as number));
    }, 0);
    // GoPlus returns percent as decimal (0-1) for some chains, percentage (0-100) for others
    // Normalise: if sum > 1.5 assume it's already a percentage, else multiply by 100
    const concPct = concentration > 1.5 ? concentration : concentration * 100;
    if (concPct <= 30) pts += 6;
    else if (concPct <= 50) pts += 4;
    else if (concPct <= 70) pts += 2;
  }

  const creatorPctRaw = data.creator_percent;
  if (creatorPctRaw !== undefined && creatorPctRaw !== null) {
    const cp = typeof creatorPctRaw === "string" ? parseFloat(creatorPctRaw) : (creatorPctRaw as number);
    if (!isNaN(cp)) {
      const cpPct = cp > 1.5 ? cp : cp * 100;
      if (cpPct <= 5) pts += 3;
      else if (cpPct <= 10) pts += 2;
    }
  }

  const lpHolders = Array.isArray(data.lp_holders) ? (data.lp_holders as Array<{ is_locked?: number }>) : [];
  if (lpHolders.some((lp) => lp.is_locked === 1)) pts += 2;

  return pts; // max 15
}

function scoreGrowthPotential(pair: import("../shared/dexscreener.js").DexPair): number {
  let pts = 0;

  const fdv = pair.fdv ?? 0;
  if (fdv >= 10_000 && fdv <= 100_000) pts += 7;
  else if (fdv > 100_000 && fdv <= 500_000) pts += 5;
  else if (fdv > 0 && fdv < 10_000) pts += 3;
  // fdv > 500_000: 0 points (large-cap, no growth potential)

  const createdAt = pair.pairCreatedAt ?? 0;
  if (createdAt > 0) {
    const ageMs = Date.now() - createdAt;
    const ageDays = ageMs / 86_400_000;
    if (ageDays >= 1 && ageDays <= 7) pts += 7;
    else if (ageDays > 7 && ageDays <= 30) pts += 5;
    else if (ageDays < 1) pts += 3;
    // > 30 days: 0 points (old token, no meme gem upside)
  }

  const change24h = pair.priceChange?.h24 ?? null;
  if (change24h !== null) {
    if (change24h >= 50) pts += 6;
    else if (change24h >= 20) pts += 4;
    else if (change24h >= 0) pts += 1;
    // negative -> 0pts
  }

  return pts; // max 20
}

export function scoreGemQuality(
  goPlusData: Record<string, unknown> | null,
  pair: import("../shared/dexscreener.js").DexPair | null,
  tokenAddress: string,
  chain: string
): number {
  // Category 1: Liquidity Health (35pts)
  const liquidity = pair ? scoreLiquidityHealth(pair) : 0;

  // Category 2: Contract Safety (20pts)
  const safety = goPlusData ? scoreContractSafety(goPlusData) : 0;

  // Category 3: Growth Potential (20pts)
  const growth = pair ? scoreGrowthPotential(pair) : 0;

  // Category 4: Holder Distribution (15pts)
  const holders = goPlusData ? scoreHolderDistribution(goPlusData) : 0;

  // Category 5: Insider Signal (10pts) - mapped from 0-100 scoreByInsiders
  const insiderRaw = scoreByInsiders(tokenAddress, chain);
  const insider = Math.round(insiderRaw / 10); // 0-10

  const total = safety + liquidity + holders + growth + insider;

  // If growth potential is 0 (old token or high FDV), cap total at 45.
  // Prevents established tokens from scoring above the buy threshold despite good liquidity/safety.
  if (growth === 0) {
    return Math.min(total, 45);
  }

  return Math.max(0, Math.min(100, total));
}

// In-memory cache so analyzeGem and buyGems share the same DexPair fetch
const gemDexCache = new Map<string, import("../shared/dexscreener.js").DexPair>();

export async function analyzeGem(symbol: string, chain: string, tokenAddress: string): Promise<GemAnalysis> {
  const cached = getCachedGemAnalysis(symbol, chain);
  if (cached) return cached;

  // GoPlus kill-switch (all chains including Solana)
  const goPlusData = await fetchGoPlusData(tokenAddress, chain);
  if (goPlusData && isGoPlusKillSwitch(goPlusData)) {
    const analysis: GemAnalysis = { tokenSymbol: symbol, chain, score: 0, analyzedAt: Date.now() };
    saveGemAnalysis(analysis);
    console.log(`[GemAnalyzer] ${symbol} (${chain}): score=0 (GoPlus kill-switch)`);
    return analysis;
  }

  // Solana: on-chain freeze/mint authority check
  if (chain === "solana") {
    const authorities = await checkSolanaTokenAuthorities(tokenAddress);
    if (authorities.freezeAuthority || authorities.mintAuthority) {
      console.log(`[GemAnalyzer] ${symbol}: blocked (freeze=${authorities.freezeAuthority}, mint=${authorities.mintAuthority})`);
      const analysis: GemAnalysis = { tokenSymbol: symbol, chain, score: 0, analyzedAt: Date.now() };
      saveGemAnalysis(analysis);
      return analysis;
    }
  }

  // Fetch DexScreener data (cached for buyGems to reuse)
  const pair = await dexScreenerFetch(chain, tokenAddress);
  if (pair) {
    gemDexCache.set(`${tokenAddress}_${chain}`, pair);
  }

  // Compute multi-category score
  const score = scoreGemQuality(goPlusData, pair, tokenAddress, chain);

  const analysis: GemAnalysis = {
    tokenSymbol: symbol,
    chain,
    score,
    analyzedAt: Date.now(),
  };

  saveGemAnalysis(analysis);
  const ageDays = pair?.pairCreatedAt ? Math.round((Date.now() - pair.pairCreatedAt) / 86_400_000) : -1;
  const fdvK = pair?.fdv ? (pair.fdv / 1000).toFixed(0) : "?";
  const liqK = pair?.liquidity?.usd ? (pair.liquidity.usd / 1000).toFixed(0) : "?";
  console.log(`[GemAnalyzer] ${symbol} (${chain}): score=${score} age=${ageDays}d fdv=$${fdvK}k liq=$${liqK}k`);

  return analysis;
}

// Track tokens that repeatedly fail price fetch - stop retrying after MAX_PRICE_FAILURES
const MAX_PRICE_FAILURES = 3;
const PRICE_FAILURE_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours
const priceFetchFailures = new Map<string, { count: number; lastFailAt: number }>();

// Locks to prevent double-buy/sell race conditions between scanner and watcher
const buyingLock = new Set<string>();
const sellingLock = new Set<string>();

export async function buyGems(
  tokens: Array<{ symbol: string; chain: string; currentPump: number; score: number; tokenAddress: string }>
): Promise<void> {
  for (const token of tokens) {
    if (token.score < 70) continue;
    if (token.currentPump >= 10) {
      console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - already pumped ${token.currentPump.toFixed(1)}x`);
      continue;
    }
    const existing = getGemPaperTrade(token.symbol, token.chain);
    if (existing && existing.status === "open") continue;

    const lockKey = `${token.symbol}_${token.chain}`;
    if (buyingLock.has(lockKey)) continue;
    buyingLock.add(lockKey);

    const failKey = `${token.symbol}_${token.chain}`;
    const failEntry = priceFetchFailures.get(failKey);
    if (failEntry && failEntry.count >= MAX_PRICE_FAILURES) {
      if (Date.now() - failEntry.lastFailAt < PRICE_FAILURE_EXPIRY_MS) {
        buyingLock.delete(lockKey);
        continue;
      }
      priceFetchFailures.delete(failKey);
    }

    // Use cached DexPair from analyzeGem if available, otherwise fetch
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
      buyingLock.delete(lockKey);
      continue;
    }

    if (liquidityUsd < 2000) {
      console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - liquidity $${liquidityUsd.toFixed(0)} < $2000`);
      buyingLock.delete(lockKey);
      continue;
    }

    const pairFdv = pair?.fdv || 0;
    if (pairFdv > 500_000) {
      console.log(`[GemAnalyzer] Skip ${token.symbol} (${token.chain}) - FDV $${(pairFdv / 1000).toFixed(0)}k > $500k`);
      buyingLock.delete(lockKey);
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
      buyingLock.delete(lockKey);
    } else {
      if (token.chain === "solana") {
        const solBalance = await getSolBalance().catch(() => 0n);
        if (solBalance < 10_000_000n) {
          console.log(`[GemTrader] LIVE: Skip ${token.symbol} - insufficient SOL`);
          buyingLock.delete(lockKey);
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
        buyingLock.delete(lockKey);
        continue;
      }

      if (!isChainSupported(token.chain as Chain)) {
        console.log(`[GemTrader] LIVE: Skip ${token.symbol} - chain ${token.chain} not supported`);
        buyingLock.delete(lockKey);
        continue;
      }

      const balance = await getNativeBalance(token.chain as Chain);
      if (balance === null || balance < 1000000000000000n) {
        console.log(`[GemTrader] LIVE: Skip ${token.symbol} - insufficient gas on ${token.chain}`);
        buyingLock.delete(lockKey);
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
      buyingLock.delete(lockKey);
    }
  }
}

export async function sellGemPosition(symbol: string, chain: string): Promise<void> {
  const sellKey = `${symbol}_${chain}`;
  if (sellingLock.has(sellKey)) return;
  sellingLock.add(sellKey);

  const trade = getGemPaperTrade(symbol, chain);
  if (!trade || trade.status === "closed") {
    sellingLock.delete(sellKey);
    return;
  }

  // Paper mode - just close the trade
  if (!trade.isLive) {
    closeGemPaperTrade(symbol, chain);
    console.log(`[GemTrader] Paper close: ${symbol} (${chain})`);
    sellingLock.delete(sellKey);
    return;
  }

  const tokenAddress = getTokenAddressForGem(symbol, chain);
  if (!tokenAddress) {
    console.log(`[GemTrader] LIVE SELL: ${symbol} (${chain}) - no token address, closing anyway`);
    closeGemPaperTrade(symbol, chain);
    sellingLock.delete(sellKey);
    return;
  }

  if (chain === "solana" && trade.tokensReceived) {
    const result = await executeJupiterSell(tokenAddress, trade.tokensReceived);
    if (result.success) {
      closeGemPaperTrade(symbol, chain, result.signature);
      console.log(`[GemTrader] LIVE SELL: ${symbol} (solana) tx=${result.signature}`);
    } else {
      closeGemPaperTrade(symbol, chain);
      console.log(`[GemTrader] LIVE SELL FAILED: ${symbol} (solana) - ${result.error}`);
    }
    sellingLock.delete(sellKey);
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
  sellingLock.delete(sellKey);
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

  // Stop-loss at -70% (take-profit follows insider sells in scanner.ts)
  const refreshedTrades = getOpenGemPaperTrades();
  for (const trade of refreshedTrades) {
    if (trade.pnlPct <= -70) {
      console.log(`[GemAnalyzer] STOP LOSS: ${trade.tokenSymbol} (${trade.chain}) at ${trade.pnlPct.toFixed(0)}%`);
      await sellGemPosition(trade.tokenSymbol, trade.chain);
    }
  }
}
