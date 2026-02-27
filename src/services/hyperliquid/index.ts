import { initHyperliquid, isHyperliquidInitialized } from "./client.js";
import { initPaperEngine } from "./paper.js";
import { loadOpenQuantPositions, setPaperStartDate } from "../database/quant.js";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { QUANT_DEFAULT_VIRTUAL_BALANCE } from "../../config/constants.js";
import { startPositionMonitor, stopPositionMonitor } from "./position-monitor.js";
import { startFundingArbMonitor, stopFundingArbMonitor } from "./funding-arb.js";
import { startQuantScheduler, stopQuantScheduler } from "./scheduler.js";
import { seedDailyLossFromDb } from "./risk-manager.js";
import { runBacktestBackground } from "./backtest.js";

export function initQuant(): number {
  const env = loadEnv();

  if (env.QUANT_ENABLED !== "true") {
    return 0;
  }

  if (!env.HYPERLIQUID_PRIVATE_KEY) {
    console.log("[Quant] HYPERLIQUID_PRIVATE_KEY not set, skipping init");
    return 0;
  }

  if (!isHyperliquidInitialized()) {
    initHyperliquid(
      env.HYPERLIQUID_PRIVATE_KEY,
      env.HYPERLIQUID_WALLET_ADDRESS,
    );
  }

  const startBalance = env.QUANT_VIRTUAL_BALANCE ?? QUANT_DEFAULT_VIRTUAL_BALANCE;

  if (isPaperMode()) {
    initPaperEngine(startBalance);
    setPaperStartDate(new Date().toISOString());
  }

  seedDailyLossFromDb();
  startPositionMonitor();
  startFundingArbMonitor();
  startQuantScheduler();
  runBacktestBackground();

  const openPositions = loadOpenQuantPositions();
  const count = openPositions.length;
  console.log(`[Quant] Initialized (${isPaperMode() ? "paper" : "live"} mode), ${count} open positions`);
  return count;
}

export function stopQuant(): void {
  stopQuantScheduler();
  stopFundingArbMonitor();
  stopPositionMonitor();
  console.log("[Quant] Stopped");
}

// Re-export key functions for consumers
export { openPosition, closePosition, getOpenQuantPositions, getVirtualBalance } from "./executor.js";
export { getPaperBalance, getPaperPositions, clearPaperMemory } from "./paper.js";
export { getAccountState, getRecentFills } from "./account.js";

// Market data pipeline
export { fetchCandles, fetchAllCandles } from "./candles.js";
export { fetchFundingRate, fetchOpenInterest, fetchMarketContext } from "./market-data.js";
export { computeIndicators } from "./indicators.js";
export { classifyRegime } from "./regime.js";
export { analyzePair, runMarketDataPipeline } from "./pipeline.js";

// AI Decision Engine
export { buildQuantPrompt } from "./prompt.js";
export { analyzeWithAI, runAIDecisionEngine, clearAICache } from "./ai-analyzer.js";
export { calculateQuantPositionSize } from "./kelly.js";

// Risk Management
export {
  validateRiskGates,
  isQuantKilled,
  setQuantKilled,
  recordDailyLoss,
  resetDailyDrawdown,
  getDailyLossTotal,
  seedDailyLossFromDb,
} from "./risk-manager.js";

// Position Monitor
export { startPositionMonitor, stopPositionMonitor } from "./position-monitor.js";

// Funding Rate Arbitrage
export { runFundingArbCycle, startFundingArbMonitor, stopFundingArbMonitor } from "./funding-arb.js";

// Rule-Based Decision Engine
export { runRuleDecisionEngine } from "./rule-engine.js";

// Microstructure Decision Engine
export { runMicroDecisionEngine } from "./micro-engine.js";

// Directional Trading Scheduler
export { runDirectionalCycle, startQuantScheduler, stopQuantScheduler } from "./scheduler.js";

// Backtest
export { runBacktest, getCachedBacktest, runBacktestBackground } from "./backtest.js";
