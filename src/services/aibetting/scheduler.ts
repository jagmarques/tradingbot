import type { AIBettingConfig, AnalysisCycleResult, AIAnalysis } from "./types.js";
import { discoverMarkets } from "./scanner.js";
import { fetchNewsForMarket } from "./news.js";
import { analyzeMarket } from "./analyzer.js";
import { evaluateAllOpportunities, shouldExitPosition } from "./evaluator.js";
import {
  enterPosition,
  exitPosition,
  getOpenPositions,
  getCurrentPrice,
  getTotalExposure,
} from "./executor.js";
import { getUsdcBalanceFormatted } from "../polygon/wallet.js";

let isRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;
let config: AIBettingConfig | null = null;

// Cache AI analyses to avoid redundant API calls (4 hours)
const analysisCache = new Map<string, { analysis: AIAnalysis; cachedAt: number }>();
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;

function getCachedAnalysis(marketId: string): AIAnalysis | null {
  const cached = analysisCache.get(marketId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_DURATION_MS) {
    analysisCache.delete(marketId);
    return null;
  }
  return cached.analysis;
}

function cacheAnalysis(marketId: string, analysis: AIAnalysis): void {
  analysisCache.set(marketId, { analysis, cachedAt: Date.now() });
}

async function runAnalysisCycle(): Promise<AnalysisCycleResult> {
  const result: AnalysisCycleResult = {
    marketsAnalyzed: 0,
    opportunitiesFound: 0,
    betsPlaced: 0,
    errors: [],
  };

  if (!config) {
    result.errors.push("Config not set");
    return result;
  }

  try {
    console.log("[AIBetting] Starting cycle...");

    const openPositions = getOpenPositions();
    const positionMarketIds = new Set(openPositions.map((p) => p.marketId));

    // 1. Discover markets (automated, no AI)
    const markets = await discoverMarkets(config, positionMarketIds, 15);
    if (markets.length === 0) {
      console.log("[AIBetting] No candidate markets");
      return result;
    }

    // 2. Smart filtering - only call AI when needed
    const analyses = new Map<string, AIAnalysis>();
    let cached = 0;
    let skippedNoNews = 0;
    let skippedPrice = 0;

    for (const market of markets) {
      // Check cache first
      const cachedAnalysis = getCachedAnalysis(market.conditionId);
      if (cachedAnalysis) {
        analyses.set(market.conditionId, cachedAnalysis);
        cached++;
        continue;
      }

      // Pre-filter: skip extreme prices (no edge opportunity)
      const yesPrice = market.outcomes.find((o) => o.name === "Yes")?.price || 0.5;
      if (yesPrice < 0.15 || yesPrice > 0.85) {
        skippedPrice++;
        continue;
      }

      // Fetch news only for promising markets
      const news = await fetchNewsForMarket(market);

      // No news = no information edge, skip AI
      if (news.length === 0) {
        skippedNoNews++;
        continue;
      }

      // NOW call AI - we have potential
      const analysis = await analyzeMarket(market, news);
      if (analysis) {
        analyses.set(market.conditionId, analysis);
        cacheAnalysis(market.conditionId, analysis);
        result.marketsAnalyzed++;
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(
      `[AIBetting] ${result.marketsAnalyzed} AI calls, ${cached} cached, ${skippedNoNews} no news, ${skippedPrice} extreme price`
    );

    // 3. Get bankroll
    const usdcBalance = parseFloat(await getUsdcBalanceFormatted());
    if (usdcBalance < 1) {
      result.errors.push("Insufficient balance");
      return result;
    }

    // 4. Evaluate opportunities
    const decisions = evaluateAllOpportunities(
      markets,
      analyses,
      config,
      openPositions,
      usdcBalance
    );
    result.opportunitiesFound = decisions.length;

    // 5. Execute bets
    const maxNewBets = config.maxPositions - openPositions.length;
    for (const decision of decisions.slice(0, maxNewBets)) {
      const market = markets.find((m) => m.conditionId === decision.marketId);
      if (!market) continue;

      const position = await enterPosition(decision, market);
      if (position) {
        result.betsPlaced++;
        console.log(`[AIBetting] BET: ${decision.side} ${market.title} @ $${decision.recommendedSize.toFixed(2)}`);
      }
    }

    // 6. Check exits
    await checkExits(analyses);

    if (result.betsPlaced > 0 || result.opportunitiesFound > 0) {
      console.log(`[AIBetting] ${result.opportunitiesFound} opportunities, ${result.betsPlaced} bets placed`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AIBetting] Error:", msg);
    result.errors.push(msg);
  }

  return result;
}

async function checkExits(analyses: Map<string, AIAnalysis>): Promise<void> {
  for (const position of getOpenPositions()) {
    const currentPrice = await getCurrentPrice(position.tokenId);
    if (currentPrice === null) continue;

    const analysis = analyses.get(position.marketId) || null;
    const { shouldExit, reason } = shouldExitPosition(position, currentPrice, analysis);

    if (shouldExit) {
      const { success, pnl } = await exitPosition(position, currentPrice, reason);
      if (success) {
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        console.log(`[AIBetting] EXIT: ${position.marketTitle} ${pnlStr} (${reason})`);
      }
    }
  }
}

export function startAIBetting(cfg: AIBettingConfig): void {
  if (isRunning) return;

  config = cfg;
  isRunning = true;

  console.log("[AIBetting] Started");
  console.log(`[AIBetting] Max bet $${cfg.maxBetSize}, exposure $${cfg.maxTotalExposure}, edge ${(cfg.minEdge * 100).toFixed(0)}%`);

  // Run first cycle in background (don't block startup)
  runAnalysisCycle().catch((err) => console.error("[AIBetting] First cycle error:", err));

  intervalHandle = setInterval(async () => {
    if (isRunning) await runAnalysisCycle();
  }, cfg.scanIntervalMs);

  console.log(`[AIBetting] Running every ${cfg.scanIntervalMs / 60000} min`);
}

export function stopAIBetting(): void {
  if (!isRunning) return;
  isRunning = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  console.log("[AIBetting] Stopped");
}

export function isAIBettingActive(): boolean {
  return isRunning;
}

export function getAIBettingStatus(): {
  running: boolean;
  openPositions: number;
  totalExposure: number;
  cacheSize: number;
} {
  return {
    running: isRunning,
    openPositions: getOpenPositions().length,
    totalExposure: getTotalExposure(),
    cacheSize: analysisCache.size,
  };
}

export async function runManualCycle(): Promise<AnalysisCycleResult> {
  if (!config) {
    return { marketsAnalyzed: 0, opportunitiesFound: 0, betsPlaced: 0, errors: ["Not started"] };
  }
  return runAnalysisCycle();
}
