import { getClient } from "./client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS } from "../../config/constants.js";
import { isQuantKilled } from "./risk-manager.js";
import type { QuantPosition } from "./types.js";

let monitorInterval: ReturnType<typeof setInterval> | null = null;

async function checkPositionStops(): Promise<void> {
  try {
    const positions: QuantPosition[] = getOpenQuantPositions();

    if (positions.length === 0) {
      return;
    }

    if (isQuantKilled()) {
      // Positions frozen when killed - do not auto-close, let user decide
      return;
    }

    const sdk = getClient();
    const mids = (await sdk.info.getAllMids()) as Record<string, string>;

    for (const position of positions) {
      const rawPrice = mids[position.pair];

      if (rawPrice === undefined) {
        console.log(`[PositionMonitor] No price data for ${position.pair}, skipping`);
        continue;
      }

      const currentPrice = parseFloat(rawPrice);

      if (isNaN(currentPrice)) {
        console.log(`[PositionMonitor] Invalid price for ${position.pair}: ${rawPrice}, skipping`);
        continue;
      }

      const hasValidStopLoss =
        position.stopLoss !== undefined &&
        isFinite(position.stopLoss) &&
        position.stopLoss > 0;

      const hasValidTakeProfit =
        position.takeProfit !== undefined &&
        isFinite(position.takeProfit) &&
        position.takeProfit > 0;

      const stopLossBreached =
        hasValidStopLoss &&
        (position.direction === "long"
          ? currentPrice <= position.stopLoss!
          : currentPrice >= position.stopLoss!);

      const takeProfitBreached =
        hasValidTakeProfit &&
        (position.direction === "long"
          ? currentPrice >= position.takeProfit!
          : currentPrice <= position.takeProfit!);

      // Stop-loss takes priority over take-profit
      if (stopLossBreached) {
        console.log(
          `[PositionMonitor] Stop-loss triggered for ${position.pair} ${position.direction} @ ${currentPrice} (stop: ${position.stopLoss})`,
        );
        await closePosition(position.id, "stop-loss");
      } else if (takeProfitBreached) {
        console.log(
          `[PositionMonitor] Take-profit triggered for ${position.pair} ${position.direction} @ ${currentPrice} (target: ${position.takeProfit})`,
        );
        await closePosition(position.id, "take-profit");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[PositionMonitor] Error checking positions: ${msg}`);
  }
}

export function startPositionMonitor(): void {
  if (monitorInterval !== null) {
    return;
  }
  console.log(`[PositionMonitor] Started (interval: ${QUANT_POSITION_MONITOR_INTERVAL_MS}ms)`);
  monitorInterval = setInterval(() => {
    void checkPositionStops();
  }, QUANT_POSITION_MONITOR_INTERVAL_MS);
}

export function stopPositionMonitor(): void {
  if (monitorInterval === null) {
    return;
  }
  clearInterval(monitorInterval);
  monitorInterval = null;
  console.log("[PositionMonitor] Stopped");
}
