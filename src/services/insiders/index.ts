import cron from "node-cron";
import { initInsiderTables } from "./storage.js";
import { getInsiderCount } from "./storage.js";
import { runInsiderScan } from "./scanner.js";
import type { InsiderScanResult } from "./types.js";

let cronJob: cron.ScheduledTask | null = null;
let running = false;
let scanning = false;
let lastScanAt: number | null = null;
let lastResult: InsiderScanResult | null = null;

export function startInsiderScanner(): void {
  if (running) return;

  // Initialize database tables
  initInsiderTables();
  running = true;

  console.log("[InsiderScanner] Started (6h schedule)");

  // Run first scan after short delay to not block startup
  setTimeout(() => {
    runManualInsiderScan().catch((err) =>
      console.error("[InsiderScanner] First scan error:", err)
    );
  }, 10000);

  // Schedule cron every 6 hours
  cronJob = cron.schedule("0 */6 * * *", () => {
    runManualInsiderScan().catch((err) =>
      console.error("[InsiderScanner] Cron scan error:", err)
    );
  });
}

export function stopInsiderScanner(): void {
  if (!running) return;
  running = false;

  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

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
  nextScanAt: string | null;
  lastResult: InsiderScanResult | null;
} {
  let nextScanAt: string | null = null;
  if (running && lastScanAt) {
    const next = new Date(lastScanAt + 6 * 60 * 60 * 1000);
    nextScanAt = next.toISOString();
  }

  return {
    running,
    lastScanAt,
    insiderCount: running ? getInsiderCount() : 0,
    nextScanAt,
    lastResult,
  };
}
