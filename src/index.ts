import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

import { loadEnv, isPaperMode } from "./config/env.js";
import { initDb, closeDb } from "./services/database/db.js";
import { startHealthServer, stopHealthServer } from "./services/health/server.js";
import { startBot, stopBot, sendMainMenu } from "./services/telegram/bot.js";
import { notifyBotStarted, notifyBotStopped, notifyCriticalError } from "./services/telegram/notifications.js";
import { setDailyStartBalance } from "./services/risk/manager.js";
import { startPnlCron, stopPnlCron } from "./services/pnl/snapshots.js";
import { initQuant, stopQuant } from "./services/hyperliquid/index.js";

const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 4000;

async function main(): Promise<void> {
  console.log("[Bot] Starting Trading Bot...");

  try {
    // Validate environment
    const env = loadEnv();
    console.log(`[Bot] Mode: ${isPaperMode() ? "PAPER" : "LIVE"}`);

    // Initialize database
    initDb();
    console.log("[Bot] Database initialized");

    // Set daily loss baseline
    setDailyStartBalance(0);

    // Start health server
    startHealthServer(HEALTH_PORT);

    // Start Telegram bot
    await startBot();

    // Send main menu first (before other messages for consistent sizing)
    await sendMainMenu();

    // Notify startup
    await notifyBotStarted();

    // Quant trading on Hyperliquid (opt-in)
    if (env.QUANT_ENABLED === "true" && env.HYPERLIQUID_PRIVATE_KEY) {
      const recoveredQuant = initQuant();
      if (recoveredQuant > 0) {
        console.log(`[Bot] Recovered ${recoveredQuant} quant positions`);
      }
      console.log("[Bot] Quant trading started");
    } else {
      console.log("[Bot] Quant trading disabled (set QUANT_ENABLED=true and HYPERLIQUID_PRIVATE_KEY to enable)");
    }

    // EVM insider wallet detection
    if (process.env.ETHERSCAN_API_KEY) {
      const { startInsiderScanner } = await import("./services/traders/index.js");
      startInsiderScanner();
      console.log("[Bot] Insider scanner started");
    } else {
      console.log("[Bot] Insider scanner disabled (set ETHERSCAN_API_KEY to enable)");
    }

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

  if (signal !== "SIGTERM") {
    try {
      await notifyBotStopped(signal);
    } catch {
      // Ignore notification errors during shutdown
    }
  }

  try {
    stopPnlCron();
    stopQuant();
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
process.on("SIGINT", () => { shutdown("SIGINT").catch(err => console.error("[Bot] Shutdown error:", err)); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(err => console.error("[Bot] Shutdown error:", err)); });

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
