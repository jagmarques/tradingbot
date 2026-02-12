// Copy filter - evaluates copy trade opportunities before execution
import type { Chain, Trader, TraderTrade } from "../traders/types.js";
import type { BotSettings } from "../settings/settings.js";

export interface CopyFilterResult {
  shouldCopy: boolean;
  recommendedSizeUsd: number;
  reason: string;
  traderQualityMultiplier: number; // 0.0-1.5 based on trader score
}

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

export function filterCryptoCopy(
  trader: Trader,
  trade: TraderTrade,
  settings: BotSettings,
): CopyFilterResult {
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
  const size = clampSize(baseUsd * traderQualityMultiplier, baseUsd);

  return {
    shouldCopy: true,
    recommendedSizeUsd: Math.round(size * 100) / 100,
    reason: `Trader quality ${traderQualityMultiplier}x, score ${trader.score}`,
    traderQualityMultiplier,
  };
}

// Conviction-based copy sizing
const COPY_RATIO = 0.005; // 0.5% of trader's bet size
const COPY_RATIO_PAPER = 0.01; // 1% in paper mode (more data)
const MAX_COPY_BET = 10; // $10 cap
const MIN_COPY_SIZE = 5; // skip below $5
const MIN_COPY_SIZE_PAPER = 3; // $3 in paper mode

export function filterPolyCopy(
  traderRoi: number,
  tradeUsdcSize: number,
  tradePrice: number,
  paperMode = false,
): CopyFilterResult {
  if (tradePrice > 0.95 || tradePrice < 0.05) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Price ${(tradePrice * 100).toFixed(0)}c too extreme (5-95c range)`,
      traderQualityMultiplier: 0,
    };
  }

  if (tradePrice >= 0.48 && tradePrice <= 0.52) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Price ${(tradePrice * 100).toFixed(0)}c is coin-flip territory (48-52c)`,
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

  const ratio = paperMode ? COPY_RATIO_PAPER : COPY_RATIO;
  const minSize = paperMode ? MIN_COPY_SIZE_PAPER : MIN_COPY_SIZE;
  const rawSize = Math.min(MAX_COPY_BET, tradeUsdcSize * ratio * traderQualityMultiplier);

  if (rawSize < minSize) {
    return {
      shouldCopy: false,
      recommendedSizeUsd: 0,
      reason: `Conviction too low: $${tradeUsdcSize.toFixed(0)} trade -> $${rawSize.toFixed(2)} copy (min $${minSize})`,
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
