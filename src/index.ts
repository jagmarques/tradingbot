import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

import { loadEnv, isPaperMode } from "./config/env.js";
import { initDb, closeDb } from "./services/database/db.js";
import { startHealthServer, stopHealthServer } from "./services/health/server.js";
import { startBot, stopBot, sendMainMenu, getChatId } from "./services/telegram/bot.js";
import { getSettings } from "./services/settings/settings.js";
import { notifyBotStarted, notifyBotStopped, notifyCriticalError, startStatusReporter, stopStatusReporter } from "./services/telegram/notifications.js";
import { startDetector as startPumpfunDetector, stopDetector as stopPumpfunDetector, onTokenLaunch } from "./services/pumpfun/detector.js";
import { analyzeToken } from "./services/pumpfun/filters.js";
import { executeSplitBuy, checkAutoSell, getPositions, getTokenPrice, loadPositionsFromDb as loadPumpfunPositions } from "./services/pumpfun/executor.js";
import { stopMonitoring as stopPolymarketMonitoring } from "./services/polygon/arbitrage.js";
import { loadPositionsFromDb as loadPolymarketPositions } from "./services/polygon/positions.js";
import { getDailyPnlPercentage, setDailyStartBalance } from "./services/risk/manager.js";
import { getSolBalance } from "./services/solana/wallet.js";
import { initTracker, startTracking, stopTracking, getTrackedTraderCount } from "./services/traders/tracker.js";
import { startDiscovery, stopDiscovery } from "./services/traders/discovery.js";
import { startTraderAlerts, stopTraderAlerts } from "./services/traders/alerts.js";
import { validateCopyChains } from "./services/evm/index.js";
import { startAIBetting, stopAIBetting, initPositions as initAIBettingPositions } from "./services/aibetting/index.js";
import { startPolyTraderTracking, stopPolyTraderTracking } from "./services/polytraders/index.js";
import { initCryptoCopyTracking } from "./services/copy/executor.js";
import { startTokenAIScheduler, stopTokenAIScheduler } from "./services/tokenai/scheduler.js";
import { startTokenExitLoop, stopTokenExitLoop } from "./services/tokenai/exit-loop.js";
import { startPnlCron, stopPnlCron } from "./services/pnl/snapshots.js";

const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 4000;
let positionMonitorInterval: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  console.log("[Bot] Starting Trading Bot...");

  try {
    // Validate environment
    const env = loadEnv();
    console.log(`[Bot] Mode: ${isPaperMode() ? "PAPER" : "LIVE"}`);
    console.log(`[Bot] Daily loss limit: $${env.DAILY_LOSS_LIMIT_USD}`);

    // Initialize database
    initDb();
    console.log("[Bot] Database initialized");

    // Initialize trader tracker
    initTracker();

    // Initialize crypto copy tracking
    const recoveredCryptocopies = initCryptoCopyTracking();

    // Load open positions from database (recovery from crash)
    const recoveredPumpfun = loadPumpfunPositions();
    const recoveredPolymarket = loadPolymarketPositions();
    const totalRecovered = recoveredPumpfun + recoveredPolymarket + recoveredCryptocopies;
    if (totalRecovered > 0) {
      console.log(`[Bot] Recovered ${totalRecovered} open positions (${recoveredPumpfun} Pump.fun, ${recoveredPolymarket} Polymarket, ${recoveredCryptocopies} Crypto copies)`);
    }

    // Set daily loss baseline to actual wallet balance
    const balanceLamports = await getSolBalance();
    const balanceSol = Number(balanceLamports) / 1_000_000_000;
    setDailyStartBalance(balanceSol);

    // Start health server
    startHealthServer(HEALTH_PORT);

    // Start Telegram bot
    await startBot();

    // Send main menu first (before other messages for consistent sizing)
    await sendMainMenu();

    // Notify startup
    await notifyBotStarted();

    // Start periodic status reporter
    startStatusReporter();

    // Start trading strategies
    await startPumpfunDetector();

    // Subscribe to Pump.fun token launches and execute trades
    onTokenLaunch(async (launch) => {
      try {
        // Check if auto-snipe is enabled
        const userId = getChatId();
        if (userId) {
          const settings = getSettings(userId);
          if (!settings.autoSnipeEnabled) {
            console.log(`[Bot] Auto-snipe disabled, skipping ${launch.symbol}`);
            return;
          }
        }

        console.log(`[Bot] Analyzing token: ${launch.symbol} (${launch.mint})`);
        const analysis = await analyzeToken(launch);

        if (analysis.recommendation === "BUY") {
          console.log(`[Bot] Executing buy for ${launch.symbol}`);
          const CAPITAL_PER_TRADE = 0.5; // SOL

          // Validate trade before execution
          const dailyLoss = getDailyPnlPercentage();
          if (dailyLoss >= 100) {
            console.error("[Bot] Daily loss limit reached");
            return;
          }

          await executeSplitBuy(launch, CAPITAL_PER_TRADE);
        }
      } catch (err) {
        console.error(`[Bot] Error processing token ${launch.symbol}:`, err);
      }
    });

    // Start position monitoring loop for auto-sells
    const POSITION_CHECK_INTERVAL_MS = 10_000; // Check every 10 seconds
    positionMonitorInterval = setInterval(async () => {
      const positions = getPositions();
      for (const [mint, position] of positions) {
        try {
          let currentPrice: number | null = null;

          if (isPaperMode()) {
            // Paper mode: simulate realistic price movement
            // Random walk with occasional pumps to test auto-sell targets
            const ageMinutes = (Date.now() - position.createdAt) / 60000;
            const baseMultiplier = 1 + (Math.random() - 0.3) * 0.5; // -15% to +35% per check
            const timeFactor = 1 + ageMinutes * 0.1; // Gradually increase over time
            const pumpChance = Math.random();

            if (pumpChance > 0.95) {
              // 5% chance of 10x+ pump
              currentPrice = position.entryPrice * (10 + Math.random() * 90);
            } else if (pumpChance > 0.85) {
              // 10% chance of 2-5x pump
              currentPrice = position.entryPrice * (2 + Math.random() * 3);
            } else {
              currentPrice = position.entryPrice * baseMultiplier * timeFactor;
            }
          } else {
            // Live mode: get actual token price from bonding curve
            currentPrice = await getTokenPrice(mint);
          }

          if (currentPrice && currentPrice > 0) {
            await checkAutoSell(mint, currentPrice);
          }
        } catch (err) {
          console.error(`[Bot] Error checking position ${position.symbol}:`, err);
        }
      }
    }, POSITION_CHECK_INTERVAL_MS);
    console.log("[Bot] Position monitoring started (10s interval)");

    // Start trader tracker and auto-discovery
    await startTracking();
    startDiscovery();
    startTraderAlerts();
    console.log(`[Bot] Trader tracker started (${getTrackedTraderCount()} wallets tracked)`);

    // Validate EVM copy-trading chains
    await validateCopyChains();

    // AI-powered Polymarket betting
    if (env.AIBETTING_ENABLED === "true" && env.DEEPSEEK_API_KEY) {
      // Recover open positions from database
      const recoveredAIBets = initAIBettingPositions();
      if (recoveredAIBets > 0) {
        console.log(`[Bot] Recovered ${recoveredAIBets} AI betting positions`);
      }

      startAIBetting({
        maxBetSize: env.AIBETTING_MAX_BET,
        maxTotalExposure: env.AIBETTING_MAX_EXPOSURE,
        maxPositions: env.AIBETTING_MAX_POSITIONS,
        minEdge: env.AIBETTING_MIN_EDGE,
        minConfidence: env.AIBETTING_MIN_CONFIDENCE,
        scanIntervalMs: env.AIBETTING_SCAN_INTERVAL,
        categoriesEnabled: ["politics", "crypto", "sports", "business", "entertainment", "other"],
      });
      console.log("[Bot] AI Betting started");
    } else {
      console.log("[Bot] AI Betting disabled (set AIBETTING_ENABLED=true and DEEPSEEK_API_KEY to enable)");
    }

    // Token AI trading
    if (env.TOKENAI_ENABLED === "true" && env.DEEPSEEK_API_KEY) {
      startTokenAIScheduler({
        maxBetUsd: env.TOKENAI_MAX_BET,
        minBetUsd: 5,
        maxExposureUsd: env.TOKENAI_MAX_EXPOSURE,
        maxPositions: env.TOKENAI_MAX_POSITIONS,
        dailyLossLimitUsd: env.TOKENAI_DAILY_LOSS_LIMIT,
        kellyMultiplier: env.TOKENAI_KELLY_MULTIPLIER,
        minConfidence: env.TOKENAI_MIN_CONFIDENCE as "low" | "medium" | "high",
        minSuccessProbability: env.TOKENAI_MIN_PROBABILITY,
        scanIntervalMs: env.TOKENAI_SCAN_INTERVAL,
      });
      startTokenExitLoop();
      console.log("[Bot] Token AI started");
    } else {
      console.log("[Bot] Token AI disabled (set TOKENAI_ENABLED=true and DEEPSEEK_API_KEY to enable)");
    }

    // Start Polymarket top trader tracking
    startPolyTraderTracking(5000); // Check every 5 seconds
    console.log("[Bot] Polymarket trader tracking started");

    // Start P&L daily snapshot cron
    startPnlCron();

    console.log("[Bot] All services started successfully");
    console.log("[Bot] Waiting for trading opportunities...");

    // Keep process running
    await new Promise(() => {});
  } catch (err) {
    console.error("[Bot] Fatal error:", err);
    await notifyCriticalError(String(err), "Startup");
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`[Bot] Received ${signal}, shutting down...`);

  try {
    await notifyBotStopped(signal);
  } catch {
    // Ignore notification errors during shutdown
  }

  try {
    if (positionMonitorInterval) {
      clearInterval(positionMonitorInterval);
      positionMonitorInterval = null;
    }
    stopStatusReporter();
    stopPumpfunDetector();
    stopPolymarketMonitoring();
    stopTokenAIScheduler();
    stopPnlCron();
    stopTokenExitLoop();
    stopAIBetting();
    stopPolyTraderTracking();
    stopTraderAlerts();
    stopDiscovery();
    stopTracking();
    stopBot();
    stopHealthServer();
    closeDb();
  } catch (err) {
    console.error("[Bot] Error during shutdown:", err);
  }

  console.log("[Bot] Shutdown complete");
  process.exit(0);
}

// Handle shutdown signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Handle uncaught errors
process.on("uncaughtException", async (err) => {
  console.error("[Bot] Uncaught exception:", err);
  try {
    await notifyCriticalError(String(err), "Uncaught Exception");
  } catch {
    // Ignore
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("[Bot] Unhandled rejection:", reason);
  console.error("[Bot] Promise:", promise);
  try {
    await notifyCriticalError(String(reason), "Unhandled Rejection");
  } catch {
    // Ignore
  }
  // Don't exit - keep bot running
});

// Start
main();
