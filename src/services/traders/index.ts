import { initInsiderTables } from "./storage.js";
import { runInsiderScan } from "./scanner.js";
import { INSIDER_CONFIG, COPY_TRADE_CONFIG } from "./types.js";
import { startInsiderWatcher, stopInsiderWatcher, backfillTokenCreatedAt } from "./watcher.js";
import { startRugMonitor, stopRugMonitor } from "./rug-monitor.js";
import { startInsiderWebSocket, stopInsiderWebSocket } from "./insider-ws.js";

let running = false;

async function scanLoop(): Promise<void> {
  while (running) {
    try {
      await runInsiderScan();
    } catch (err) {
      console.error("[InsiderScanner] Scan error:", err);
    }

    // Wait between scans to avoid API abuse
    if (running) {
      console.log(`[InsiderScanner] Next scan in ${INSIDER_CONFIG.SCAN_INTERVAL_MS / 60000} minutes`);
      await new Promise((r) => setTimeout(r, INSIDER_CONFIG.SCAN_INTERVAL_MS));
    }
  }
}

async function goplusCheckLoop(): Promise<void> {
  while (running) {
    try {
      const { checkGoPlusForOpenTrades } = await import("./gem-analyzer.js");
      await checkGoPlusForOpenTrades();
    } catch (err) {
      console.error("[GoPlusCheck] Error:", err);
    }
    if (running) {
      await new Promise((r) => setTimeout(r, COPY_TRADE_CONFIG.GOPLUS_CHECK_INTERVAL_MS));
    }
  }
}

async function priceRefreshLoop(): Promise<void> {
  while (running) {
    try {
      const { refreshCopyTradePrices } = await import("./gem-analyzer.js");
      await refreshCopyTradePrices();
    } catch (err) {
      console.error("[PriceRefresh] Error:", err);
    }
    if (running) {
      await new Promise((r) => setTimeout(r, COPY_TRADE_CONFIG.PRICE_REFRESH_INTERVAL_MS));
    }
  }
}

export function startInsiderScanner(): void {
  if (running) return;

  initInsiderTables();
  running = true;

  console.log(`[InsiderScanner] Started (every ${INSIDER_CONFIG.SCAN_INTERVAL_MS / 60000} min)`);

  // Start loop after short delay to not block startup
  setTimeout(() => {
    scanLoop().catch((err) =>
      console.error("[InsiderScanner] Loop crashed:", err)
    );
  }, 10000);

  setTimeout(() => {
    console.log(`[PriceRefresh] Started (every ${COPY_TRADE_CONFIG.PRICE_REFRESH_INTERVAL_MS / 60000} min)`);
    priceRefreshLoop().catch((err) =>
      console.error("[PriceRefresh] Loop crashed:", err)
    );
  }, 30000);

  // GoPlus periodic re-check every 5 min
  setTimeout(() => {
    console.log(`[GoPlusCheck] Started (every ${COPY_TRADE_CONFIG.GOPLUS_CHECK_INTERVAL_MS / 60000} min)`);
    goplusCheckLoop().catch((err) =>
      console.error("[GoPlusCheck] Loop crashed:", err)
    );
  }, 60000);

  startInsiderWatcher();

  setTimeout(() => backfillTokenCreatedAt().catch(err => console.error("[CopyTrade] Backfill error:", err)), 15000);

  setTimeout(() => startRugMonitor(), 5000);

  // Real-time insider buy/sell detection via Alchemy WebSocket
  setTimeout(() => startInsiderWebSocket(), 8000);
}

export function stopInsiderScanner(): void {
  if (!running) return;
  running = false;
  stopInsiderWatcher();
  stopRugMonitor();
  stopInsiderWebSocket();
  console.log("[InsiderScanner] Stopped");
}

