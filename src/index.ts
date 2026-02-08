import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

import { loadEnv, isPaperMode } from "./config/env.js";
import { initDb, closeDb } from "./services/database/db.js";
import { startHealthServer, stopHealthServer } from "./services/health/server.js";
import { startBot, stopBot, sendMainMenu } from "./services/telegram/bot.js";
import { notifyBotStarted, notifyBotStopped, notifyCriticalError, startStatusReporter, stopStatusReporter } from "./services/telegram/notifications.js";
import { stopMonitoring as stopPolymarketMonitoring } from "./services/polygon/arbitrage.js";
import { loadPositionsFromDb as loadPolymarketPositions } from "./services/polygon/positions.js";
import { setDailyStartBalance } from "./services/risk/manager.js";
import { getSolBalance } from "./services/solana/wallet.js";
import { initTracker, startTracking, stopTracking, getTrackedTraderCount } from "./services/traders/tracker.js";
import { startDiscovery, stopDiscovery } from "./services/traders/discovery.js";
import { startTraderAlerts, stopTraderAlerts } from "./services/traders/alerts.js";
import { validateCopyChains } from "./services/evm/index.js";
import { startAIBetting, stopAIBetting, initPositions as initAIBettingPositions } from "./services/aibetting/index.js";
import { startPolyTraderTracking, stopPolyTraderTracking } from "./services/polytraders/index.js";
import { initCryptoCopyTracking } from "./services/copy/executor.js";
import { startPnlCron, stopPnlCron } from "./services/pnl/snapshots.js";

const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 4000;

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
    const recoveredPolymarket = loadPolymarketPositions();
    const totalRecovered = recoveredPolymarket + recoveredCryptocopies;
    if (totalRecovered > 0) {
      console.log(`[Bot] Recovered ${totalRecovered} open positions (${recoveredPolymarket} Polymarket, ${recoveredCryptocopies} Crypto copies)`);
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

    // Start trader tracker and auto-discovery
    await startTracking();
    startDiscovery();
    startTraderAlerts();
    console.log(`[Bot] Trader tracker started (${getTrackedTraderCount()} wallets tracked)`);

    // Validate EVM copy-trading chains
    await validateCopyChains();

    // AI-powered Polymarket betting
    if (env.AIBETTING_ENABLED === "true" && env.DEEPSEEK_API_KEY) {
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

    // Start Polymarket top trader tracking
    startPolyTraderTracking(5000);
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
    stopStatusReporter();
    stopPolymarketMonitoring();
    stopPnlCron();
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
