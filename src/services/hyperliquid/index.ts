import { initHyperliquid, isHyperliquidInitialized } from "./client.js";
import { initPaperEngine } from "./paper.js";
import { loadOpenQuantPositions } from "../database/quant.js";
import { loadEnv, isPaperMode } from "../../config/env.js";
import { QUANT_DEFAULT_VIRTUAL_BALANCE } from "../../config/constants.js";

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
  }

  const openPositions = loadOpenQuantPositions();
  const count = openPositions.length;
  console.log(`[Quant] Initialized (${isPaperMode() ? "paper" : "live"} mode), ${count} open positions`);
  return count;
}

export function stopQuant(): void {
  // Cleanup placeholder - no persistent timers in this phase
  console.log("[Quant] Stopped");
}

// Re-export key functions for consumers
export { openPosition, closePosition, getOpenQuantPositions, getVirtualBalance } from "./executor.js";
export { getPaperBalance, getPaperPositions } from "./paper.js";
