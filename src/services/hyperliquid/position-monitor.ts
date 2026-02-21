import { getClient } from "./client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, QUANT_MAINTENANCE_MARGIN_PCT, QUANT_LIQUIDATION_PENALTY_PCT } from "../../config/constants.js";
import { isQuantKilled } from "./risk-manager.js";
import type { QuantPosition } from "./types.js";
import { accrueFundingIncome, deductLiquidationPenalty } from "./paper.js";
import { isPaperMode } from "../../config/env.js";

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

    // Accrue funding income for paper funding arb positions
    if (isPaperMode()) {
      await accrueFundingIncome();
    }

    const sdk = getClient();
    const mids = (await sdk.info.getAllMids(true)) as Record<string, string>;

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

      // Liquidation check: if unrealized loss exceeds maintenance margin, force-close
      if (isPaperMode()) {
        const priceDiff = position.direction === "long"
          ? currentPrice - position.entryPrice
          : position.entryPrice - currentPrice;
        const unrealizedPnl = (priceDiff / position.entryPrice) * position.size * position.leverage;
        const initialMargin = position.size; // margin = size (notional / leverage, but size IS the margin for us)
        const maintenanceMargin = initialMargin * (QUANT_MAINTENANCE_MARGIN_PCT / 100);

        if (unrealizedPnl < 0 && Math.abs(unrealizedPnl) >= maintenanceMargin) {
          console.log(
            `[PositionMonitor] LIQUIDATION: ${position.pair} ${position.direction} unrealized $${unrealizedPnl.toFixed(2)} exceeds maintenance margin $${maintenanceMargin.toFixed(2)}`
          );
          const penaltyUsd = position.size * (QUANT_LIQUIDATION_PENALTY_PCT / 100);
          deductLiquidationPenalty(position.id, penaltyUsd);
          await closePosition(position.id, `liquidation (loss $${Math.abs(unrealizedPnl).toFixed(2)} >= margin $${maintenanceMargin.toFixed(2)})`);
          continue; // skip further checks for this position
        }
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
