import { initHyperliquid, isHyperliquidInitialized, ensureConnected, getClient } from "./client.js";
import { initLighter } from "../lighter/client.js";
import { initLighterEngine } from "../lighter/executor.js";
import { initPaperEngine } from "./paper.js";
import { initLiveEngine } from "./live-executor.js";
import { loadOpenQuantPositions, setPaperStartDate } from "../database/quant.js";
import { loadEnv, isPaperMode, getTradingMode } from "../../config/env.js";
import { startPositionMonitor, stopPositionMonitor } from "./position-monitor.js";
import { startQuantScheduler, stopQuantScheduler } from "./scheduler.js";
import { startTrumpGuard, stopTrumpGuard } from "../trump-guard/index.js";
import { seedDailyLossFromDb } from "./risk-manager.js";
import { startHlPriceWs, stopHlPriceWs } from "./ws-prices.js";

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

  // Initialize Lighter DEX if all 3 credentials are set
  if (env.LIGHTER_PRIVATE_KEY && env.LIGHTER_API_KEY_INDEX != null && env.LIGHTER_ACCOUNT_INDEX != null) {
    initLighter(env.LIGHTER_API_KEY_INDEX, env.LIGHTER_PRIVATE_KEY, env.LIGHTER_ACCOUNT_INDEX);
    initLighterEngine();
    if (!isPaperMode()) {
      void verifyLighterConnection();
    }
  }

  seedDailyLossFromDb();
  startHlPriceWs();
  startPositionMonitor();
  startQuantScheduler();
  startTrumpGuard();
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

async function verifyLighterConnection(): Promise<void> {
  try {
    const { getLighterAllMids } = await import("../lighter/client.js");
    const mids = await getLighterAllMids(["BTC", "ETH"]);
    const pairCount = Object.keys(mids).length;
    console.log(`[Quant] Lighter health check passed: ${pairCount} pairs available`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant] LIGHTER HEALTH CHECK FAILED: ${msg}`);
  }
}

export function stopQuant(): void {
  stopQuantScheduler();
  stopPositionMonitor();
  stopHlPriceWs();
  stopTrumpGuard();
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

// BTC Event Engine
export { runBtcEventCycle } from "./btc-event-engine.js";

// Lighter DEX
export { getLighterLivePositions } from "../lighter/executor.js";


