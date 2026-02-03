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
import { start as startPriceFeeds, stop as stopPriceFeeds } from "./services/pricefeeds/manager.js";
import { startDetector as startPumpfunDetector, stopDetector as stopPumpfunDetector, onTokenLaunch } from "./services/pumpfun/detector.js";
import { analyzeToken } from "./services/pumpfun/filters.js";
import { executeSplitBuy, checkAutoSell, getPositions, getTokenPrice } from "./services/pumpfun/executor.js";
import { stopMonitoring as stopPolymarketMonitoring } from "./services/polygon/arbitrage.js";
import { loadPositionsFromDb } from "./services/polygon/positions.js";
import { getDailyPnlPercentage, setDailyStartBalance } from "./services/risk/manager.js";
import { getSolBalance } from "./services/solana/wallet.js";

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

    // Load open positions from database (recovery from crash)
    const recoveredPositions = loadPositionsFromDb();
    if (recoveredPositions > 0) {
      console.log(`[Bot] Recovered ${recoveredPositions} open positions from previous session`);
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

    // Start price feeds
    await startPriceFeeds(["BTCUSDT", "ETHUSDT", "SOLUSDT", "MATICUSDT"]);

    // Start trading strategies
    await startPumpfunDetector();

    // Subscribe to Pump.fun token launches and execute trades
    onTokenLaunch(async (launch) => {
      try {
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
    setInterval(async () => {
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

    // Polymarket monitoring disabled - no crypto price markets available
    // To enable: add real Polymarket condition IDs that correlate with spot prices
    console.log("[Bot] Polymarket arbitrage disabled - no valid crypto markets configured");

    // await startPolymarketMonitoring();

    // Polymarket opportunity handler disabled until valid markets are configured
    // onOpportunity(async (opportunity) => {
    //   const result = await executeArbitrage(opportunity, 10);
    //   if (result.success) console.log(`[Bot] Arbitrage executed: ${result.orderId}`);
    // });

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
    stopPumpfunDetector();
    stopPolymarketMonitoring();
    stopPriceFeeds();
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
