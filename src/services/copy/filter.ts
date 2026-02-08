// AI copy filter - evaluates copy trade opportunities before execution
import type { Chain, Trader, TraderTrade } from "../traders/types.js";
import type { BotSettings } from "../settings/settings.js";
import type { SupportedChain } from "../tokenai/types.js";
import { analyzeToken } from "../tokenai/analyzer.js";

export interface CopyFilterResult {
  shouldCopy: boolean;
  recommendedSizeUsd: number;
  reason: string;
  aiConfidence?: "low" | "medium" | "high";
  aiProbability?: number;
  traderQualityMultiplier: number; // 0.0-1.5 based on trader score
}

// Map Chain (traders/types) to SupportedChain (tokenai/types)
const CHAIN_MAP: Partial<Record<Chain, SupportedChain>> = {
  solana: "solana",
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  bsc: "bnb",
  avalanche: "avalanche",
};

// Approximate native token prices in USD (for copy amount estimation)
const APPROX_NATIVE_PRICES: Record<string, number> = {
  solana: 150,
  ethereum: 3000,
  polygon: 0.75,
  base: 3000, // ETH
  arbitrum: 3000, // ETH
  bsc: 600,
  optimism: 3000, // ETH
  avalanche: 35,
  sonic: 0.50,
};

// Confidence scaling for position sizing
const CONFIDENCE_SCALE: Record<string, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.4,
};

export function mapChainToSupported(chain: Chain): SupportedChain | null {
  return CHAIN_MAP[chain] ?? null;
}

export function getApproxUsdValue(amountNative: number, chain: Chain): number {
  const price = APPROX_NATIVE_PRICES[chain] ?? 1;
  return amountNative * price;
}

function getCopyAmountUsd(chain: Chain, settings: BotSettings): number {
  const copyAmounts: Record<string, number> = {
    solana: settings.copyAmountSol,
    ethereum: settings.copyAmountEth,
    polygon: settings.copyAmountMatic,
  };
  const nativeAmount = copyAmounts[chain] ?? settings.copyAmountDefault;
  return getApproxUsdValue(nativeAmount, chain);
}

function getTraderQualityMultiplier(score: number): number {
  if (score >= 90) return 1.5;
  if (score >= 80) return 1.2;
  if (score >= 70) return 1.0;
  if (score >= 60) return 0.7;
  return 0; // reject
}

function getRoiQualityMultiplier(roi: number): number {
  if (roi >= 0.30) return 1.5;
  if (roi >= 0.20) return 1.2;
  if (roi >= 0.10) return 1.0;
  if (roi >= 0.05) return 0.7;
  return 0; // reject
}

function clampSize(size: number, baseUsd: number): number {
  const cap = baseUsd * 3;
  const floor = baseUsd * 0.3;
  return Math.max(floor, Math.min(cap, size));
}

export async function filterCryptoCopy(
  trader: Trader,
  trade: TraderTrade,
  settings: BotSettings,
): Promise<CopyFilterResult> {
  // Check trader score threshold
  if (trader.score < settings.minTraderScore) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Trader score ${trader.score} below threshold ${settings.minTraderScore}`,
      traderQualityMultiplier: 0,
    };
  }

  const traderQualityMultiplier = getTraderQualityMultiplier(trader.score);

  // Reject low-quality traders
  if (traderQualityMultiplier === 0) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Trader score ${trader.score} too low (below 60)`,
      traderQualityMultiplier: 0,
    };
  }

  const baseUsd = getCopyAmountUsd(trade.chain, settings);
  const supportedChain = mapChainToSupported(trade.chain);

  // If chain not supported for AI analysis, use trader-quality-only sizing
  if (!supportedChain) {
    const size = clampSize(baseUsd * traderQualityMultiplier, baseUsd);
    return {
      shouldCopy: true,
      recommendedSizeUsd: Math.round(size * 100) / 100,
      reason: `Chain ${trade.chain} not supported for AI analysis, trader-quality sizing only`,
      traderQualityMultiplier,
    };
  }

  // Run AI analysis
  let analysis;
  try {
    analysis = await analyzeToken(trade.tokenAddress, supportedChain, trade.tokenSymbol);
  } catch (error) {
    console.warn(`[CopyFilter] AI analysis failed for ${trade.tokenAddress}: ${error}`);
    analysis = null;
  }

  // AI analysis failure: fall back to trader-quality-only sizing
  if (!analysis) {
    console.warn(`[CopyFilter] AI analysis unavailable, using trader-quality sizing for ${trade.tokenAddress}`);
    const size = clampSize(baseUsd * traderQualityMultiplier, baseUsd);
    return {
      shouldCopy: true,
      recommendedSizeUsd: Math.round(size * 100) / 100,
      reason: "AI analysis unavailable, trader-quality sizing only",
      traderQualityMultiplier,
    };
  }

  // AI rejection: high security risk
  if (analysis.securityScore !== undefined && analysis.securityScore >= 70) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `AI rejected: security score ${analysis.securityScore}/100 too high`,
      aiConfidence: analysis.confidence,
      aiProbability: analysis.successProbability,
      traderQualityMultiplier,
    };
  }

  // AI rejection: low probability
  if (analysis.successProbability < 0.15) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `AI rejected: success probability ${(analysis.successProbability * 100).toFixed(1)}% too low`,
      aiConfidence: analysis.confidence,
      aiProbability: analysis.successProbability,
      traderQualityMultiplier,
    };
  }

  // AI rejection: low confidence
  if (analysis.confidence === "low") {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: "AI rejected: low confidence",
      aiConfidence: analysis.confidence,
      aiProbability: analysis.successProbability,
      traderQualityMultiplier,
    };
  }

  // Calculate size: base * traderQuality * confidenceScale
  const confScale = CONFIDENCE_SCALE[analysis.confidence] ?? 0.4;
  const rawSize = baseUsd * traderQualityMultiplier * confScale;
  const size = clampSize(rawSize, baseUsd);

  return {
    shouldCopy: true,
    recommendedSizeUsd: Math.round(size * 100) / 100,
    reason: `AI approved: P=${(analysis.successProbability * 100).toFixed(1)}% C=${analysis.confidence}`,
    aiConfidence: analysis.confidence,
    aiProbability: analysis.successProbability,
    traderQualityMultiplier,
  };
}

// Conviction-based copy sizing
const COPY_RATIO = 0.005; // 0.5% of trader's bet size
const MAX_COPY_BET = 10; // $10 cap
const MIN_COPY_SIZE = 2; // skip below $2

export function filterPolyCopy(
  traderRoi: number,
  tradeUsdcSize: number,
  tradePrice: number,
): CopyFilterResult {
  if (tradePrice > 0.95 || tradePrice < 0.05) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Price ${(tradePrice * 100).toFixed(0)}c too extreme (5-95c range)`,
      traderQualityMultiplier: 0,
    };
  }

  const traderQualityMultiplier = getRoiQualityMultiplier(traderRoi);

  if (traderQualityMultiplier === 0) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Trader ROI ${(traderRoi * 100).toFixed(1)}% too low (below 5%)`,
      traderQualityMultiplier: 0,
    };
  }

  const rawSize = Math.min(MAX_COPY_BET, tradeUsdcSize * COPY_RATIO * traderQualityMultiplier);

  if (rawSize < MIN_COPY_SIZE) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Conviction too low: $${tradeUsdcSize.toFixed(0)} trade -> $${rawSize.toFixed(2)} copy (min $${MIN_COPY_SIZE})`,
      traderQualityMultiplier,
    };
  }

  return {
    shouldCopy: true,
    recommendedSizeUsd: Math.round(rawSize * 100) / 100,
    reason: `ROI ${(traderRoi * 100).toFixed(1)}%, $${tradeUsdcSize.toFixed(0)} conviction, ${traderQualityMultiplier}x quality`,
    traderQualityMultiplier,
  };
}
