import type { AIBettingConfig, AnalysisCycleResult, AIAnalysis, EnsembleResult, PolymarketEvent } from "./types.js";
import { discoverMarkets } from "./scanner.js";
import { fetchNewsForMarket } from "./news.js";
import { analyzeMarketEnsemble } from "./ensemble.js";
import { evaluateAllOpportunities, shouldExitPosition } from "./evaluator.js";
import {
  enterPosition,
  exitPosition,
  resolvePosition,
  checkMarketResolution,
  getOpenPositions,
  getCurrentPrice,
  getTotalExposure,
  clearClosedPositions,
} from "./executor.js";
import { getUsdcBalanceFormatted } from "../polygon/wallet.js";
import { isPaperMode } from "../../config/env.js";
import { updateCalibrationScores } from "../database/calibration.js";
import cron from "node-cron";

let isRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;
let config: AIBettingConfig | null = null;
let calibrationCronJob: cron.ScheduledTask | null = null;

const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;

// Cache ensemble results for Telegram display and analysis reuse
const ensembleCache = new Map<string, { result: EnsembleResult; cachedAt: number }>();

function getCachedEnsemble(marketId: string): EnsembleResult | null {
  const cached = ensembleCache.get(marketId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_DURATION_MS) {
    ensembleCache.delete(marketId);
    return null;
  }
  return cached.result;
}

function cacheEnsemble(marketId: string, result: EnsembleResult): void {
  ensembleCache.set(marketId, { result, cachedAt: Date.now() });
}

export function getEnsembleResult(marketId: string): EnsembleResult | null {
  return getCachedEnsemble(marketId);
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

    // Check resolutions/exits before new bets
    await checkExits(new Map());
    clearClosedPositions();

    // Bust cache for open positions with fresh news
    await invalidateCacheOnNews();

    const openPositions = getOpenPositions();
    const positionMarketIds = new Set(openPositions.map((p) => p.marketId));

    // 1. Discover markets (automated, no AI)
    const markets = await discoverMarkets(config, positionMarketIds, 15);
    if (markets.length === 0) {
      console.log("[AIBetting] No candidate markets");
      return result;
    }

    // 2. Analyze markets with AI (use cache when available)
    const analyses = new Map<string, AIAnalysis>();
    let cached = 0;

    for (const market of markets) {
      // Check ensemble cache first
      const cachedEnsemble = getCachedEnsemble(market.conditionId);
      if (cachedEnsemble) {
        if (cachedEnsemble.highDisagreement) {
          console.log(`[AIBetting] SKIP (cached high disagreement): ${market.title}`);
          continue;
        }
        analyses.set(market.conditionId, cachedEnsemble.consensus);
        cached++;
        continue;
      }

      const news = await fetchNewsForMarket(market);
      const ensembleResult = await analyzeMarketEnsemble(market, news);
      if (ensembleResult) {
        cacheEnsemble(market.conditionId, ensembleResult);

        if (ensembleResult.highDisagreement) {
          console.log(
            `[AIBetting] SKIP (high disagreement ${ensembleResult.disagreement.toFixed(3)}): ${market.title} ` +
            `estimates=[${ensembleResult.individualEstimates.map(e => (e * 100).toFixed(0) + '%').join(', ')}]`
          );
          continue;
        }

        analyses.set(market.conditionId, ensembleResult.consensus);
        result.marketsAnalyzed++;
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`[AIBetting] ${result.marketsAnalyzed} AI calls, ${cached} cached`);

    // 3. Get bankroll (unlimited in paper mode)
    let usdcBalance: number;
    if (isPaperMode()) {
      const currentExposure = getTotalExposure();
      usdcBalance = 10000; // Unlimited paper bankroll
      console.log(`[AIBetting] PAPER mode (exposure: $${currentExposure.toFixed(2)}, ${openPositions.length} positions)`);
    } else {
      usdcBalance = parseFloat(await getUsdcBalanceFormatted());
      console.log(`[AIBetting] USDC balance: $${usdcBalance.toFixed(2)}`);
      if (usdcBalance < 1) {
        console.log("[AIBetting] Insufficient USDC balance (<$1), skipping bets");
        result.errors.push("Insufficient balance");
        return result;
      }
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
    const maxNewBets = isPaperMode() ? decisions.length : config.maxPositions - openPositions.length;
    for (const decision of decisions.slice(0, maxNewBets)) {
      const market = markets.find((m) => m.conditionId === decision.marketId);
      if (!market) continue;

      const position = await enterPosition(decision, market);
      if (position) {
        result.betsPlaced++;
        console.log(`[AIBetting] BET: ${decision.side} ${market.title} @ $${decision.recommendedSize.toFixed(2)}`);
      }
    }

    // 6. Check exits with fresh AI analyses
    await checkExits(analyses);

    console.log(`[AIBetting] Cycle done: ${result.opportunitiesFound} opportunities, ${result.betsPlaced} bets placed`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AIBetting] Error:", msg);
    result.errors.push(msg);
  }

  return result;
}

// Bust cache for open positions with fresh news
async function invalidateCacheOnNews(): Promise<void> {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  for (const position of openPositions) {
    const cached = ensembleCache.get(position.marketId);
    if (!cached) continue;

    const market: PolymarketEvent = {
      conditionId: position.marketId,
      questionId: "",
      slug: "",
      title: position.marketTitle,
      description: "",
      category: "other",
      endDate: position.marketEndDate,
      volume24h: 0,
      liquidity: 0,
      outcomes: [],
    };

    const news = await fetchNewsForMarket(market);
    const hasNewArticles = news.some((n) => {
      const pubTime = new Date(n.publishedAt).getTime();
      return pubTime > cached.cachedAt;
    });

    if (hasNewArticles) {
      ensembleCache.delete(position.marketId);
      console.log(`[Scheduler] Cache busted for "${position.marketTitle}" (new articles found)`);
    }
  }
}

async function checkExits(analyses: Map<string, AIAnalysis>): Promise<void> {
  for (const position of getOpenPositions()) {
    // Check if market resolved
    const resolution = await checkMarketResolution(position.tokenId);
    if (resolution.resolved && resolution.finalPrice !== null) {
      const { success, pnl } = await resolvePosition(position, resolution.finalPrice);
      if (success) {
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        console.log(`[AIBetting] RESOLVED: ${position.marketTitle} ${pnlStr}`);
      }
      continue;
    }

    const currentPrice = await getCurrentPrice(position.tokenId);
    if (currentPrice === null) continue;

    const analysis = analyses.get(position.marketId) || null;
    const { shouldExit, reason } = await shouldExitPosition(position, currentPrice, analysis);

    if (shouldExit) {
      const { success, pnl } = await exitPosition(position, currentPrice, reason);
      if (success) {
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        console.log(`[AIBetting] EXIT: ${position.marketTitle} ${pnlStr} (${reason})`);
      }
    }
  }
}

// Update calibration scores (runs daily at 3 AM)
async function updateCalibrationScoresJob(): Promise<void> {
  try {
    const updated = updateCalibrationScores();
    console.log(`[Calibration] Updated ${updated} category scores`);
  } catch (error) {
    console.error("[Calibration] Error updating scores:", error);
  }
}

export function startAIBetting(cfg: AIBettingConfig): void {
  if (isRunning) return;

  config = cfg;
  isRunning = true;

  console.log("[AIBetting] Started");
  console.log(`[AIBetting] Max bet $${cfg.maxBetSize}, exposure $${cfg.maxTotalExposure}, edge ${(cfg.minEdge * 100).toFixed(0)}%`);

  // Run calibration update on startup
  updateCalibrationScoresJob().catch((err) =>
    console.error("[Calibration] Startup update error:", err)
  );

  // Schedule calibration update every 10 minutes
  calibrationCronJob = cron.schedule("*/10 * * * *", () => {
    updateCalibrationScoresJob().catch((err) =>
      console.error("[Calibration] Update error:", err)
    );
  });

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
  if (calibrationCronJob) {
    calibrationCronJob.stop();
    calibrationCronJob = null;
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
  ensembleCacheSize: number;
} {
  return {
    running: isRunning,
    openPositions: getOpenPositions().length,
    totalExposure: getTotalExposure(),
    cacheSize: ensembleCache.size,
    ensembleCacheSize: ensembleCache.size,
  };
}

export async function runManualCycle(): Promise<AnalysisCycleResult> {
  if (!config) {
    return { marketsAnalyzed: 0, opportunitiesFound: 0, betsPlaced: 0, errors: ["Not started"] };
  }
  return runAnalysisCycle();
}

export function clearAnalysisCache(): void {
  ensembleCache.clear();
  console.log("[Scheduler] Cleared ensemble cache");
}
