/**
 * Polymarket scanner - runs bonds scan on 15s interval.
 * Re-exports HF Maker stats for Telegram display.
 */

import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";
import { resetHFMakerData } from "./hf-maker.js";
import { runBondsScan, resetBondsData, initBondsFromDb } from "./high-prob-bonds.js";

export { getHFMakerStats, getHFMakerStatus, resetHFMakerData, getAllHFMakerStats } from "./hf-maker.js";
export { getBondsStats } from "./high-prob-bonds.js";

// ---- State ---------------------------------------------------------------

let scanInterval: NodeJS.Timeout | null = null;
let running = false;

// ---- Scanner -------------------------------------------------------------

async function runScan(): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return;

    const markets = await response.json() as Array<{
      conditionId: string;
      question: string;
      outcomePrices: string;
      volume24hr: number;
      closed: boolean;
      endDate: string;
    }>;

    const sharedPolyMarkets = markets.map(m => ({
      conditionId: m.conditionId,
      question: m.question,
      outcomePrices: m.outcomePrices,
      endDate: m.endDate ?? "",
      volume24hr: m.volume24hr,
      active: true,
      closed: m.closed,
    }));
    await runBondsScan(sharedPolyMarkets);
  } catch (err) {
    console.error("[Scanner] Error:", err);
  }
}

// ---- Public API ----------------------------------------------------------

export async function startHFScanner(): Promise<void> {
  if (running) return;
  running = true;

  initBondsFromDb();

  scanInterval = setInterval(() => {
    void runScan();
  }, 15_000);

  console.log("[Scanner] Running: 15s bonds scan");
}

export function stopHFScanner(): void {
  if (!running) return;
  running = false;

  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  console.log("[Scanner] Stopped");
}

export function resetHFPaperData(): void {
  resetHFMakerData();
  resetBondsData();
  console.log("[Scanner] Paper data reset");
}
