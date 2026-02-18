import type { AIBettingConfig, AnalysisCycleResult, AIAnalysis, PolymarketEvent } from "./types.js";
import { discoverMarkets } from "./scanner.js";
import { fetchNewsForMarket } from "./news.js";
import { analyzeMarket, parseAnalysisResponse } from "./analyzer.js";
import { evaluateAllOpportunities, shouldExitPosition } from "./evaluator.js";
import { callDeepSeek } from "./deepseek.js";
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
import { logCalibrationEntry } from "../database/aibetting.js";
import { getUsdcBalanceFormatted } from "../polygon/wallet.js";
import { isPaperMode } from "../../config/env.js";
import { updateCalibrationScores } from "../database/calibration.js";
import { canTrade } from "../risk/manager.js";
import cron from "node-cron";

function detectSiblingMarkets(markets: PolymarketEvent[]): string[][] {
  const byEndDate = new Map<string, PolymarketEvent[]>();

  for (const market of markets) {
    const existing = byEndDate.get(market.endDate) || [];
    existing.push(market);
    byEndDate.set(market.endDate, existing);
  }

  const allClusters: string[][] = [];

  for (const group of byEndDate.values()) {
    if (group.length < 2) continue;

    // Build adjacency list for transitive closure
    const adjacency = new Map<string, Set<string>>();
    for (const market of group) {
      adjacency.set(market.conditionId, new Set());
    }

    // Detect overlaps
    for (let i = 0; i < group.length; i++) {
      const wordsA = group[i].title.toLowerCase().split(/\s+/).filter(w => w.length > 3);

      for (let j = i + 1; j < group.length; j++) {
        const wordsB = group[j].title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const shared = wordsA.filter(w => wordsB.includes(w)).length;
        const minLen = Math.min(wordsA.length, wordsB.length);

        if (minLen > 0 && shared / minLen > 0.3) {
          adjacency.get(group[i].conditionId)?.add(group[j].conditionId);
          adjacency.get(group[j].conditionId)?.add(group[i].conditionId);
        }
      }
    }

    // Find connected components via DFS
    const visited = new Set<string>();
    for (const startId of adjacency.keys()) {
      if (visited.has(startId)) continue;

      const cluster: string[] = [];
      const stack = [startId];
      while (stack.length > 0) {
        const id = stack.pop();
        if (!id) break;
        if (visited.has(id)) continue;
        visited.add(id);
        cluster.push(id);

        for (const neighbor of adjacency.get(id) || []) {
          if (!visited.has(neighbor)) stack.push(neighbor);
        }
      }

      if (cluster.length >= 2) allClusters.push(cluster);
    }
  }

  return allClusters;
}

let isRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;
let config: AIBettingConfig | null = null;
let calibrationCronJob: cron.ScheduledTask | null = null;
let logOnlyMode = false; // Shadow mode: analyze but don't place bets
let lastCalibrationLogAt = 0;

const CACHE_DURATION_MS = 8 * 60 * 60 * 1000;

const analysisCache = new Map<string, { analysis: AIAnalysis; cachedAt: number }>();

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

  if (!canTrade()) {
    console.log("[AIBetting] Kill switch active, skipping cycle");
    return result;
  }

  try {
    console.log("[AIBetting] Starting cycle...");

    await checkExits(new Map());
    clearClosedPositions();
    await invalidateCacheOnNews();

    const openPositions = getOpenPositions();
    const positionMarketIds = new Set(openPositions.map((p) => p.marketId));

    const markets = await discoverMarkets(config, positionMarketIds, 15);
    if (markets.length === 0) {
      console.log("[AIBetting] No candidate markets");
      return result;
    }

    const analyses = new Map<string, AIAnalysis>();
    let cached = 0;

    // Detect sibling markets for multi-candidate context
    const siblingClusters = detectSiblingMarkets(markets);

    for (const market of markets) {
      const cachedAnalysis = getCachedAnalysis(market.conditionId);
      if (cachedAnalysis) {
        analyses.set(market.conditionId, cachedAnalysis);
        cached++;
        continue;
      }

      const yesPrice = market.outcomes.find(o => o.name === "Yes")?.price ?? 0.5;
      const maxYesEdge = 0.99 - yesPrice;
      const maxNoEdge = yesPrice - 0.01;
      if (maxYesEdge < config.minEdge && maxNoEdge < config.minEdge) {
        console.log(`[AIBetting] SKIP (edge impossible @ ${(yesPrice * 100).toFixed(0)}%): ${market.title}`);
        continue;
      }

      const news = await fetchNewsForMarket(market);
      await new Promise((r) => setTimeout(r, 2000)); // GDELT rate limit spacing
      if (news.length < 1) {
        console.log(`[AIBetting] SKIP (0 news articles): ${market.title}`);
        continue;
      }

      const siblingTitles = siblingClusters
        .find(c => c.includes(market.conditionId))
        ?.filter(id => id !== market.conditionId)
        .map(id => markets.find(m => m.conditionId === id)?.title)
        .filter((t): t is string => !!t);

      if (siblingTitles?.length) {
        console.log(`[AIBetting] Sibling context for ${market.title}: ${siblingTitles.length} related markets`);
      }

      // Ensemble: 2 R1 calls, take mean probability
      const ENSEMBLE_SIZE = 2;
      const ensembleResults: AIAnalysis[] = [];

      for (let i = 0; i < ENSEMBLE_SIZE; i++) {
        const singleAnalysis = await analyzeMarket(market, news, "deepseek-reasoner", siblingTitles);
        if (singleAnalysis) {
          ensembleResults.push(singleAnalysis);
          console.log(`[AIBetting] Ensemble ${i + 1}/${ENSEMBLE_SIZE}: R1=${(singleAnalysis.probability * 100).toFixed(1)}%`);
        }
        if (i < ENSEMBLE_SIZE - 1) {
          await new Promise((r) => setTimeout(r, 1000)); // Rate limit between calls
        }
      }

      if (ensembleResults.length === 0) {
        console.warn(`[AIBetting] All ensemble calls failed for: ${market.title}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      // Take mean of RAW R1 probabilities (no weighting applied yet)
      const sortedProbs = ensembleResults.map(a => a.probability).sort((a, b) => a - b);
      const meanRawProb = sortedProbs.reduce((a, b) => a + b, 0) / sortedProbs.length;

      // Check spread for supervisor trigger
      const spread = sortedProbs[sortedProbs.length - 1] - sortedProbs[0];

      // Use the analysis closest to mean as base
      const closestToMean = ensembleResults.reduce((best, curr) =>
        Math.abs(curr.probability - meanRawProb) < Math.abs(best.probability - meanRawProb) ? curr : best
      );
      let r1FinalRaw = meanRawProb;
      let analysis = { ...closestToMean, probability: meanRawProb };

      // Supervisor agent: if spread > 15pp, make extra R1 call with all RAW reasoning
      if (spread > 0.15) {
        console.log(`[AIBetting] Supervisor triggered (spread ${(spread * 100).toFixed(0)}pp): ${market.title}`);
        const allReasoning = ensembleResults.map((a, i) =>
          `Analyst ${i + 1}: P=${(a.probability * 100).toFixed(1)}% - ${a.reasoning}`
        ).join("\n\n");

        const supervisorPrompt = `You are a senior prediction market analyst reviewing junior analysts' estimates.

MARKET: ${market.title}

ANALYST ESTIMATES (spread: ${(spread * 100).toFixed(0)} percentage points):
${allReasoning}

The analysts disagree significantly. Review their reasoning, identify which analyst(s) have the strongest evidence, and provide your own probability estimate.

OUTPUT JSON ONLY:
{
  "probability": 0.XX,
  "confidence": 0.XX,
  "reasoning": "your synthesis",
  "keyFactors": ["factor1", "factor2"],
  "evidenceCited": [],
  "consistencyNote": "supervisor synthesis",
  "changeReason": null,
  "timeline": null
}`;

        try {
          const supervisorResponse = await callDeepSeek(supervisorPrompt, "deepseek-reasoner", undefined, undefined, "supervisor");
          const supervisorAnalysis = parseAnalysisResponse(supervisorResponse, market.conditionId);
          if (supervisorAnalysis) {
            r1FinalRaw = supervisorAnalysis.probability;
            analysis.reasoning = `[Supervisor] ${supervisorAnalysis.reasoning}`;
            analysis.confidence = supervisorAnalysis.confidence;
            console.log(`[AIBetting] Supervisor: ${(r1FinalRaw * 100).toFixed(1)}% (was mean ${(meanRawProb * 100).toFixed(1)}%)`);
          }
        } catch (error) {
          console.warn(`[AIBetting] Supervisor call failed, using mean:`, error);
        }
      }

      // Apply Bayesian prior ONCE: 50% market price + 50% R1
      analysis.r1RawProbability = r1FinalRaw;
      const bw = config!.bayesianWeight;
      analysis.probability = bw * yesPrice + (1 - bw) * r1FinalRaw;
      analysis.probability = Math.max(0.01, Math.min(0.99, analysis.probability));

      console.log(`[AIBetting] Ensemble (${ensembleResults.length}/${ENSEMBLE_SIZE}): R1mean=${(meanRawProb * 100).toFixed(1)}% spread=${(spread * 100).toFixed(0)}pp | Bayesian: ${bw.toFixed(2)}*${(yesPrice * 100).toFixed(0)}% + ${(1-bw).toFixed(2)}*${(r1FinalRaw * 100).toFixed(1)}% = ${(analysis.probability * 100).toFixed(1)}%`);

      if (analysis) {
        cacheAnalysis(market.conditionId, analysis);
        analyses.set(market.conditionId, analysis);
        result.marketsAnalyzed++;

        // Log to calibration table
        if (analysis.r1RawProbability !== undefined) {
          logCalibrationEntry(
            market.conditionId,
            market.title,
            analysis.r1RawProbability,
            analysis.probability,
            yesPrice
          );
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`[AIBetting] ${result.marketsAnalyzed} AI calls, ${cached} cached`);

    // Normalize sibling probabilities so they sum to ~100%
    for (const cluster of siblingClusters) {
      const clusterAnalyses = cluster
        .map(id => ({ id, analysis: analyses.get(id) }))
        .filter((s): s is { id: string; analysis: AIAnalysis } => !!s.analysis);

      if (clusterAnalyses.length < 2) continue;
      const sum = clusterAnalyses.reduce((s, a) => s + a.analysis.probability, 0);
      if (sum > 1.05) {
        for (const s of clusterAnalyses) {
          const old = s.analysis.probability;
          s.analysis.probability = old / sum;
          cacheAnalysis(s.id, s.analysis);
        }
        const normalized = clusterAnalyses.map(s =>
          `${(s.analysis.probability * 100).toFixed(0)}%`).join("+");
        console.log(`[AIBetting] Normalized ${clusterAnalyses.length} siblings (was ${(sum * 100).toFixed(0)}%): ${normalized}`);
      }
    }

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

    const decisions = evaluateAllOpportunities(
      markets,
      analyses,
      config,
      openPositions,
      usdcBalance,
      isPaperMode()
    );
    result.opportunitiesFound = decisions.length;

    if (logOnlyMode) {
      for (const decision of decisions) {
        const market = markets.find((m) => m.conditionId === decision.marketId);
        console.log(`[AIBetting] LOG-ONLY: ${decision.side} ${market?.title} $${decision.recommendedSize.toFixed(2)} (edge=${(Math.abs(decision.edge) * 100).toFixed(1)}%)`);
      }
    } else {
      const maxNewBets = isPaperMode() ? decisions.length : config.maxPositions - openPositions.length;
      for (const decision of decisions.slice(0, maxNewBets)) {
        try {
          const market = markets.find((m) => m.conditionId === decision.marketId);
          if (!market) continue;

          const position = await enterPosition(decision, market);
          if (position) {
            result.betsPlaced++;
            console.log(`[AIBetting] BET: ${decision.side} ${market.title} @ $${decision.recommendedSize.toFixed(2)}`);
          }
        } catch (err) {
          console.error(`[AIBetting] Error placing bet on ${decision.marketId}:`, err);
        }
      }
    }

    await checkExits(analyses);

    const modeTag = logOnlyMode ? " [LOG-ONLY]" : "";
    console.log(`[AIBetting] Cycle done${modeTag}: ${result.opportunitiesFound} opportunities, ${result.betsPlaced} bets placed`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[AIBetting] Error:", msg);
    result.errors.push(msg);
  }

  return result;
}

async function invalidateCacheOnNews(): Promise<void> {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  for (const position of openPositions) {
    try {
      const cached = analysisCache.get(position.marketId);
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
        analysisCache.delete(position.marketId);
        console.log(`[Scheduler] Cache busted for "${position.marketTitle}" (new articles found)`);
      }
    } catch (err) {
      console.error(`[Scheduler] Cache invalidation error for "${position.marketTitle}":`, err);
    }
  }
}

async function checkExits(analyses: Map<string, AIAnalysis>): Promise<void> {
  for (const position of getOpenPositions()) {
    try {
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
      const { shouldExit, reason } = await shouldExitPosition(position, currentPrice, analysis, config ?? undefined);

      if (shouldExit) {
        const { success, pnl } = await exitPosition(position, currentPrice, reason);
        if (success) {
          const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
          console.log(`[AIBetting] EXIT: ${position.marketTitle} ${pnlStr} (${reason})`);
        }
      }
    } catch (err) {
      console.error(`[Scheduler] Exit check failed for "${position.marketTitle}":`, err);
    }
  }
}

async function updateCalibrationScoresJob(): Promise<void> {
  try {
    const updated = updateCalibrationScores();
    const now = Date.now();
    if (updated > 0 || now - lastCalibrationLogAt >= 3600000) {
      console.log(`[Calibration] Updated ${updated} category scores`);
      lastCalibrationLogAt = now;
    }
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

  updateCalibrationScoresJob().catch((err) =>
    console.error("[Calibration] Startup update error:", err)
  );

  calibrationCronJob = cron.schedule("*/10 * * * *", () => {
    updateCalibrationScoresJob().catch((err) =>
      console.error("[Calibration] Update error:", err)
    );
  });

  runAnalysisCycle().catch((err) => console.error("[AIBetting] First cycle error:", err));

  intervalHandle = setInterval(() => {
    if (isRunning) runAnalysisCycle().catch(err => console.error("[AIBetting] Cycle error:", err));
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

export function setLogOnlyMode(enabled: boolean): void {
  logOnlyMode = enabled;
  console.log(`[AIBetting] Log-only mode: ${enabled ? "ON" : "OFF"}`);
}

export function isLogOnlyMode(): boolean {
  return logOnlyMode;
}

export function getAIBettingStatus(): {
  running: boolean;
  logOnly: boolean;
  openPositions: number;
  totalExposure: number;
  analysisCacheSize: number;
} {
  return {
    running: isRunning,
    logOnly: logOnlyMode,
    openPositions: getOpenPositions().length,
    totalExposure: getTotalExposure(),
    analysisCacheSize: analysisCache.size,
  };
}

export async function runManualCycle(): Promise<AnalysisCycleResult> {
  if (!config) {
    return { marketsAnalyzed: 0, opportunitiesFound: 0, betsPlaced: 0, errors: ["Not started"] };
  }
  return runAnalysisCycle();
}

export function clearAnalysisCache(): void {
  analysisCache.clear();
  console.log("[Scheduler] Cleared analysis cache");
}

export function getCachedMarketAnalysis(marketId: string): AIAnalysis | null {
  return getCachedAnalysis(marketId);
}
