import { loadEnv, isPaperMode } from "./config/env.js";

async function main(): Promise<void> {
  try {
    const env = loadEnv();
    const mode = isPaperMode() ? "PAPER" : "LIVE";

    console.log(`[TradingBot] Starting in ${mode} mode`);
    console.log(`[TradingBot] Daily loss limit: $${env.DAILY_LOSS_LIMIT_USD}`);

    // TODO: Initialize services
    // - SQLite database
    // - Telegram bot
    // - Google Sheets
    // - Health endpoint

    // TODO: Start strategies in parallel
    // - Pump.fun sniper (Solana)
    // - Polymarket latency arbitrage (Polygon)

    console.log("[TradingBot] All systems initialized");

    // Graceful shutdown
    const shutdown = (): void => {
      console.log("[TradingBot] Shutting down gracefully...");
      // TODO: Close WebSocket connections
      // TODO: Cancel pending orders
      // TODO: Final P&L report to Telegram
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("[TradingBot] Fatal error:", error);
    // TODO: Send crash alert to Telegram
    process.exit(1);
  }
}

main();
