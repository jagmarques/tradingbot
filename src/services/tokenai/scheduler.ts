import type { TokenAnalysisResult } from "./types.js";
import type { TokenPosition } from "../database/tokenai.js";
import type { TokenAIConfig, TokenTradeRecommendation } from "./evaluator.js";
import { loadOpenTokenPositions, saveTokenPosition } from "../database/tokenai.js";
import { getAllActiveTokens, getTokenPairs } from "../traders/dexscreener.js";
import type { Chain } from "../traders/types.js";
import { analyzeToken } from "./analyzer.js";
import { evaluateToken } from "./evaluator.js";
import { limitCorrelatedTokenBets } from "./position-manager.js";
import { notifyTokenAIEntry } from "../telegram/notifications.js";

export interface TokenAISchedulerConfig extends TokenAIConfig {
  scanIntervalMs: number;
}

let isRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;
let config: TokenAISchedulerConfig | null = null;

const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;

const analysisCache = new Map<
  string,
  { result: TokenAnalysisResult; cachedAt: number }
>();

function getCachedAnalysis(tokenAddress: string): TokenAnalysisResult | null {
  const cached = analysisCache.get(tokenAddress);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_DURATION_MS) {
    analysisCache.delete(tokenAddress);
    return null;
  }
  return cached.result;
}

function cacheAnalysis(tokenAddress: string, result: TokenAnalysisResult): void {
  analysisCache.set(tokenAddress, { result, cachedAt: Date.now() });
}

async function runTokenAICycle(): Promise<void> {
  if (!config) return;

  try {
    console.log("[TokenAI] Starting cycle...");

    // Load open positions and build held-token set
    const openPositions = loadOpenTokenPositions();
    const heldAddresses = new Set(openPositions.map((p) => p.tokenAddress));

    // Discover tokens from DexScreener
    const discovered = await getAllActiveTokens("solana" as Chain, 20);
    const candidates = discovered.filter((addr) => !heldAddresses.has(addr));
    console.log(
      `[TokenAI] Discovered ${discovered.length} tokens, ${candidates.length} new candidates`,
    );

    if (candidates.length === 0) {
      console.log("[TokenAI] No new candidates, cycle done");
      return;
    }

    // Analyze up to 5 per cycle (cost control)
    const toAnalyze = candidates.slice(0, 5);
    const analyses: TokenAnalysisResult[] = [];

    for (const tokenAddress of toAnalyze) {
      // Check cache
      const cached = getCachedAnalysis(tokenAddress);
      if (cached) {
        analyses.push(cached);
        continue;
      }

      // Get symbol from DexScreener
      let symbol = tokenAddress.slice(0, 8);
      try {
        const pairs = await getTokenPairs(tokenAddress);
        if (pairs.length > 0) {
          symbol = pairs[0].baseToken.symbol;
        }
      } catch {
        // Use truncated address as fallback
      }

      const analysis = await analyzeToken(tokenAddress, "solana", symbol);
      if (analysis) {
        cacheAnalysis(tokenAddress, analysis);
        analyses.push(analysis);
      }

      // Rate limit between analyses
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`[TokenAI] Analyzed ${analyses.length} tokens`);

    // Evaluate each analysis
    const recommendations: TokenTradeRecommendation[] = [];
    for (const analysis of analyses) {
      const rec = evaluateToken(analysis, config, openPositions);
      if (rec.shouldTrade) {
        recommendations.push(rec);
      }
    }

    if (recommendations.length === 0) {
      console.log("[TokenAI] No trade recommendations, cycle done");
      return;
    }

    // Build narrative map from key factors for correlation guard
    const narrativeMap = new Map<string, string[]>();
    for (const analysis of analyses) {
      narrativeMap.set(analysis.tokenAddress, analysis.keyFactors);
    }

    // Apply correlation guard
    const approved = limitCorrelatedTokenBets(
      recommendations,
      openPositions,
      config.maxExposureUsd,
      narrativeMap,
    );

    console.log(
      `[TokenAI] ${recommendations.length} recommendations, ${approved.length} approved after correlation guard`,
    );

    // Open positions for approved recommendations
    let opened = 0;
    for (const rec of approved) {
      try {
        // Get entry price from DexScreener
        const pairs = await getTokenPairs(rec.tokenAddress);
        if (pairs.length === 0) {
          console.log(
            `[TokenAI] No pairs found for ${rec.tokenAddress.slice(0, 8)}, skipping`,
          );
          continue;
        }

        const entryPrice = parseFloat(pairs[0].priceUsd);
        if (!entryPrice || entryPrice <= 0) {
          console.log(
            `[TokenAI] Invalid price for ${rec.tokenAddress.slice(0, 8)}, skipping`,
          );
          continue;
        }

        const positionId = `tokenai_${rec.tokenAddress.slice(0, 8)}_${Date.now()}`;
        const symbol = pairs[0].baseToken.symbol;
        const amountTokens = rec.sizeUsd / entryPrice;

        const position: TokenPosition = {
          id: positionId,
          tokenAddress: rec.tokenAddress,
          chain: rec.chain,
          tokenSymbol: symbol,
          side: "long",
          entryPrice,
          sizeUsd: rec.sizeUsd,
          amountTokens,
          aiProbability: rec.successProbability,
          confidence: rec.confidenceScore,
          kellyFraction: rec.kellyFraction,
          status: "open",
          entryTimestamp: Date.now(),
        };

        saveTokenPosition(position);

        void notifyTokenAIEntry({
          tokenSymbol: symbol,
          chain: rec.chain,
          sizeUsd: rec.sizeUsd,
          entryPrice,
          confidence: rec.confidenceScore,
          aiProbability: rec.successProbability,
          kellyFraction: rec.kellyFraction,
        });

        console.log(
          `[TokenAI] ENTRY ${symbol} on ${rec.chain}: $${rec.sizeUsd.toFixed(2)} @ $${entryPrice.toFixed(8)}`,
        );
        opened++;
      } catch (error) {
        console.error(
          `[TokenAI] Error opening position for ${rec.tokenAddress.slice(0, 8)}:`,
          error,
        );
      }
    }

    console.log(
      `[TokenAI] Cycle done: ${analyses.length} analyzed, ${recommendations.length} recommended, ${opened} opened`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[TokenAI] Cycle error:", msg);
  }
}

export function startTokenAIScheduler(cfg: TokenAISchedulerConfig): void {
  if (isRunning) return;

  config = cfg;
  isRunning = true;

  console.log("[TokenAI] Started");
  console.log(
    `[TokenAI] Max bet $${cfg.maxBetUsd}, exposure $${cfg.maxExposureUsd}, positions ${cfg.maxPositions}`,
  );

  // Run first cycle in background
  runTokenAICycle().catch((err) =>
    console.error("[TokenAI] First cycle error:", err),
  );

  intervalHandle = setInterval(() => {
    if (isRunning) {
      runTokenAICycle().catch((err) =>
        console.error("[TokenAI] Cycle error:", err),
      );
    }
  }, cfg.scanIntervalMs);

  console.log(`[TokenAI] Running every ${cfg.scanIntervalMs / 60000} min`);
}

export function stopTokenAIScheduler(): void {
  if (!isRunning) return;
  isRunning = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  console.log("[TokenAI] Stopped");
}

export function isTokenAIActive(): boolean {
  return isRunning;
}

export function getTokenAIStatus(): {
  running: boolean;
  openPositions: number;
  totalExposure: number;
  cacheSize: number;
} {
  const openPositions = isRunning ? loadOpenTokenPositions() : [];
  return {
    running: isRunning,
    openPositions: openPositions.length,
    totalExposure: openPositions.reduce((sum, p) => sum + p.sizeUsd, 0),
    cacheSize: analysisCache.size,
  };
}

export function clearTokenAICache(): void {
  analysisCache.clear();
  console.log("[TokenAI] Cleared analysis cache");
}
