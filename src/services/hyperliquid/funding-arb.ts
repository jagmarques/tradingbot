import { scanFundingOpportunities, fetchFundingRate } from "./market-data.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import {
  FUNDING_ARB_MAX_SIZE_USD,
  FUNDING_ARB_LEVERAGE,
  FUNDING_ARB_STOP_LOSS_PCT,
  FUNDING_ARB_TAKE_PROFIT_PCT,
  FUNDING_ARB_CLOSE_APR,
  FUNDING_ARB_SCAN_INTERVAL_MS,
  FUNDING_ARB_DELTA_NEUTRAL,
} from "../../config/constants.js";
import { isQuantKilled } from "./risk-manager.js";
import { saveQuantPosition } from "../database/quant.js";

let scanInterval: ReturnType<typeof setInterval> | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let initialScanTimeout: ReturnType<typeof setTimeout> | null = null;

export async function runFundingArbCycle(): Promise<void> {
  if (isQuantKilled()) {
    console.log("[FundingArb] Kill switch active, skipping cycle");
    return;
  }

  const opportunities = await scanFundingOpportunities();

  const allPositions = getOpenQuantPositions();
  const fundingPositions = allPositions.filter((p) => p.tradeType === "funding");
  const openFundingPairs = new Set(fundingPositions.map((p) => p.pair));

  const existingCount = fundingPositions.length;
  let opened = 0;

  for (const opportunity of opportunities) {
    if (openFundingPairs.has(opportunity.pair)) {
      continue;
    }

    const { pair, direction, annualizedRate, markPrice } = opportunity;

    let stopLoss: number;
    let takeProfit: number;

    if (direction === "short") {
      stopLoss = markPrice * (1 + FUNDING_ARB_STOP_LOSS_PCT / 100);
      takeProfit = markPrice * (1 - FUNDING_ARB_TAKE_PROFIT_PCT / 100);
    } else {
      stopLoss = markPrice * (1 - FUNDING_ARB_STOP_LOSS_PCT / 100);
      takeProfit = markPrice * (1 + FUNDING_ARB_TAKE_PROFIT_PCT / 100);
    }

    const position = await openPosition(
      pair,
      direction,
      FUNDING_ARB_MAX_SIZE_USD,
      FUNDING_ARB_LEVERAGE,
      stopLoss,
      takeProfit,
      "ranging",
      undefined,
      undefined,
      "funding",
    );

    if (position) {
      opened++;
      if (FUNDING_ARB_DELTA_NEUTRAL) {
        position.spotHedgePrice = markPrice;
        saveQuantPosition(position);
        console.log(
          `[FundingArb] Opened delta-neutral ${pair}: short perp + virtual spot long @ ${markPrice} (${(annualizedRate * 100).toFixed(1)}% APR)`,
        );
      } else {
        console.log(
          `[FundingArb] Opened ${direction} ${pair} to collect funding (${(annualizedRate * 100).toFixed(1)}% APR)`,
        );
      }
    }
  }

  console.log(
    `[FundingArb] Cycle complete: ${opened} new positions, ${existingCount} already open`,
  );
}

async function checkFundingRateNormalization(): Promise<void> {
  try {
    const allPositions = getOpenQuantPositions();
    const fundingPositions = allPositions.filter((p) => p.tradeType === "funding");

    if (fundingPositions.length === 0) {
      return;
    }

    for (const position of fundingPositions) {
      const fundingInfo = await fetchFundingRate(position.pair);
      if (fundingInfo === null) {
        continue;
      }

      const { annualizedRate } = fundingInfo;

      const rateFlipped =
        (position.direction === "short" && annualizedRate < 0) ||
        (position.direction === "long" && annualizedRate > 0);

      const rateNormalized = Math.abs(annualizedRate) < FUNDING_ARB_CLOSE_APR;

      if (rateFlipped || rateNormalized) {
        await closePosition(position.id, "funding-rate-normalized");
        console.log(
          `[FundingArb] Closed ${position.pair}: rate normalized to ${(annualizedRate * 100).toFixed(1)}% APR`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FundingArb] Rate normalization check failed: ${msg}`);
  }
}

export function startFundingArbMonitor(): void {
  if (scanInterval !== null || monitorInterval !== null) {
    return;
  }

  console.log("[FundingArb] Monitor started");

  initialScanTimeout = setTimeout(() => {
    void runFundingArbCycle();
  }, 10_000);

  scanInterval = setInterval(() => {
    void runFundingArbCycle();
  }, FUNDING_ARB_SCAN_INTERVAL_MS);

  monitorInterval = setInterval(() => {
    void checkFundingRateNormalization();
  }, FUNDING_ARB_SCAN_INTERVAL_MS);
}

export function stopFundingArbMonitor(): void {
  if (scanInterval !== null) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  if (monitorInterval !== null) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  if (initialScanTimeout !== null) {
    clearTimeout(initialScanTimeout);
    initialScanTimeout = null;
  }

  console.log("[FundingArb] Monitor stopped");
}
