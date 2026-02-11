import { initInsiderTables } from "./storage.js";
import { getInsiderCount } from "./storage.js";
import { runInsiderScan } from "./scanner.js";
import type { InsiderScanResult } from "./types.js";
import { INSIDER_CONFIG } from "./types.js";

let running = false;
let scanning = false;
let lastScanAt: number | null = null;
let lastResult: InsiderScanResult | null = null;

async function scanLoop(): Promise<void> {
  while (running) {
    try {
      scanning = true;
      const result = await runInsiderScan();
      lastScanAt = Date.now();
      lastResult = result;
    } catch (err) {
      console.error("[InsiderScanner] Scan error:", err);
    } finally {
      scanning = false;
    }

    // Wait between scans to avoid API abuse
    if (running) {
      console.log(`[InsiderScanner] Next scan in ${INSIDER_CONFIG.SCAN_INTERVAL_MS / 60000} minutes`);
      await new Promise((r) => setTimeout(r, INSIDER_CONFIG.SCAN_INTERVAL_MS));
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
}

export function stopInsiderScanner(): void {
  if (!running) return;
  running = false;
  console.log("[InsiderScanner] Stopped");
}

export async function runManualInsiderScan(): Promise<InsiderScanResult | null> {
  if (scanning) {
    console.log("[InsiderScanner] Scan already in progress, skipping");
    return null;
  }

  scanning = true;
  try {
    const result = await runInsiderScan();
    lastScanAt = Date.now();
    lastResult = result;
    return result;
  } finally {
    scanning = false;
  }
}

export function isInsiderScannerRunning(): boolean {
  return running;
}

export function getInsiderScannerStatus(): {
  running: boolean;
  lastScanAt: number | null;
  insiderCount: number;
  lastResult: InsiderScanResult | null;
} {
  return {
    running,
    lastScanAt,
    insiderCount: running ? getInsiderCount() : 0,
    lastResult,
  };
}
