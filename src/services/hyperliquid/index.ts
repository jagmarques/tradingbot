import { initHyperliquid, isHyperliquidInitialized, ensureConnected, getClient } from "./client.js";
import { initPaperEngine } from "./paper.js";
import { initLiveEngine } from "./live-executor.js";
import { loadOpenQuantPositions, setPaperStartDate } from "../database/quant.js";
import { loadEnv, isPaperMode, getTradingMode } from "../../config/env.js";
import { startPositionMonitor, stopPositionMonitor } from "./position-monitor.js";
import { startQuantScheduler, stopQuantScheduler } from "./scheduler.js";
import { seedDailyLossFromDb } from "./risk-manager.js";

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

  // Always init paper engine (technical engines use it in both modes)
  initPaperEngine();
  setPaperStartDate(new Date().toISOString());

  // Always init live engine so crash recovery loads live positions from DB
  initLiveEngine();
  if (!isPaperMode()) {
    void verifyLiveConnection();
  }

  seedDailyLossFromDb();
  startPositionMonitor();
  startQuantScheduler();
  const openPositions = loadOpenQuantPositions();
  const count = openPositions.length;
  console.log(`[Quant] Initialized (${getTradingMode()} mode), ${count} open positions`);
  return count;
}

async function verifyLiveConnection(): Promise<void> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const mids = await sdk.info.getAllMids(true) as Record<string, string>;
    const pairCount = Object.keys(mids).length;
    console.log(`[Quant] Health check passed: ${pairCount} pairs available`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant] HEALTH CHECK FAILED: ${msg}`);
    console.error("[Quant] Live trading may not work - check API key and wallet address");
  }
}

export function stopQuant(): void {
  stopQuantScheduler();
  stopPositionMonitor();
  console.log("[Quant] Stopped");
}

// Re-export key functions for consumers
export { openPosition, closePosition, getOpenQuantPositions, getVirtualBalance } from "./executor.js";
export { getPaperBalance, getPaperPositions, clearPaperMemory, ISOLATED_ENGINE_TYPES } from "./paper.js";
export { getAccountState, getRecentFills } from "./account.js";

// Market data pipeline
export { fetchCandles, fetchAllCandles } from "./candles.js";
export { fetchFundingRate, fetchOpenInterest, fetchMarketContext } from "./market-data.js";
export { computeIndicators } from "./indicators.js";
export { classifyRegime } from "./regime.js";
export { analyzePair, runMarketDataPipeline } from "./pipeline.js";

// AI Decision Engine
export { buildQuantPrompt } from "./prompt.js";
export { analyzeWithAI, clearAICache } from "./ai-analyzer.js";
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
  strategyFromTradeType,
} from "./risk-manager.js";

// Position Monitor
export { startPositionMonitor, stopPositionMonitor } from "./position-monitor.js";

// Directional Trading Scheduler
export { runDirectionalCycle, startQuantScheduler, stopQuantScheduler } from "./scheduler.js";

// Directional Engines
export { runPsarDecisionEngine } from "./psar-engine.js";
export { runZlemaDecisionEngine } from "./zlema-engine.js";
export { runElderImpulseDecisionEngine } from "./elder-impulse-engine.js";
export { runVortexDecisionEngine } from "./vortex-engine.js";
export { runSchaffDecisionEngine } from "./schaff-engine.js";
export { runDEMADecisionEngine } from "./dema-engine.js";
export { runHMADecisionEngine } from "./hma-engine.js";
export { runCCIDecisionEngine } from "./cci-engine.js";

