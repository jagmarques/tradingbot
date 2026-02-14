import { getCachedGemAnalysis, saveGemAnalysis, insertGemPaperTrade, getGemPaperTrade, type GemAnalysis } from "./storage.js";
import { isPaperMode } from "../../config/env.js";
import { dexScreenerFetch } from "../shared/dexscreener.js";

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  base: "8453",
  arbitrum: "42161",
  polygon: "137",
  optimism: "10",
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
      console.warn(`[GemAnalyzer] GoPlus returned code ${data.code}`);
      return null;
    }

    const tokenData = data.result[tokenAddress.toLowerCase()];
    return tokenData || null;
  } catch (error) {
    console.warn(`[GemAnalyzer] GoPlus fetch failed for ${tokenAddress}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

export function scoreToken(data: Record<string, unknown>): number {
  let score = 70;

  // KILL FLAGS - any of these = instant 0
  if (
    data.is_honeypot === "1" ||
    data.is_mintable === "1" ||
    data.owner_change_balance === "1" ||
    data.can_take_back_ownership === "1" ||
    data.hidden_owner === "1" ||
    data.selfdestruct === "1" ||
    data.is_blacklisted === "1"
  ) {
    return 0;
  }

  // PENALTIES
  if (data.is_open_source !== "1") {
    score -= 20;
  }

  // Tax penalties
  if (typeof data.buy_tax === "string" && data.buy_tax !== "") {
    const buyTaxPct = parseFloat(data.buy_tax) * 100;
    if (!isNaN(buyTaxPct)) score -= Math.floor(buyTaxPct / 5) * 10;
  }

  if (typeof data.sell_tax === "string" && data.sell_tax !== "") {
    const sellTaxPct = parseFloat(data.sell_tax) * 100;
    if (!isNaN(sellTaxPct)) score -= Math.floor(sellTaxPct / 5) * 10;
  }

  // BONUSES
  // LP lock bonus
  if (Array.isArray(data.lp_holders)) {
    const lockedPercent = (data.lp_holders as Array<{ is_locked?: number; percent?: string }>).reduce((sum, holder) => {
      if (holder.is_locked === 1 && typeof holder.percent === "string") {
        return sum + parseFloat(holder.percent);
      }
      return sum;
    }, 0);

    if (lockedPercent > 0.9) {
      score += 10;
    } else if (lockedPercent > 0.5) {
      score += 5;
    }
  }

  // Holder count bonus
  if (typeof data.holder_count === "string") {
    const holderCount = parseInt(data.holder_count, 10);
    if (holderCount > 200) {
      score += 10;
    } else if (holderCount > 50) {
      score += 5;
    }
  }

  // CONCENTRATION PENALTY
  if (Array.isArray(data.holders)) {
    const maxNonContractPercent = (data.holders as Array<{ is_contract?: number; percent?: string }>).reduce(
      (max, holder) => {
        if (holder.is_contract === 0 && typeof holder.percent === "string") {
          return Math.max(max, parseFloat(holder.percent));
        }
        return max;
      },
      0
    );

    if (maxNonContractPercent > 0.2) {
      score -= 15;
    } else if (maxNonContractPercent > 0.1) {
      score -= 10;
    }
  }

  // Clamp to 0-100 range
  return Math.max(0, Math.min(100, score));
}

export async function analyzeGem(symbol: string, chain: string, tokenAddress: string): Promise<GemAnalysis> {
  const cached = getCachedGemAnalysis(symbol, chain);
  if (cached) return cached;

  const goPlusData = await fetchGoPlusData(tokenAddress, chain);
  const rawScore = goPlusData ? scoreToken(goPlusData) : 50;
  const score = Number.isFinite(rawScore) ? rawScore : 50;

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

export async function paperBuyGems(
  tokens: Array<{ symbol: string; chain: string; currentPump: number; score: number; tokenAddress: string }>
): Promise<void> {
  if (!isPaperMode()) return;

  for (const token of tokens) {
    if (token.score < 80) continue;
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
    });

    console.log(`[GemAnalyzer] Paper buy: ${token.symbol} (${token.chain}) at $${priceUsd.toFixed(6)}, score: ${token.score}`);
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

    await paperBuyGems(results);
  })();
}
