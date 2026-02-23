import { getClient } from "./client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, HYPERLIQUID_MAINTENANCE_MARGIN_RATE, QUANT_LIQUIDATION_PENALTY_PCT, STAGNATION_TIMEOUT_MS } from "../../config/constants.js";
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

      if (isPaperMode()) {
        const priceDiff = position.direction === "long"
          ? currentPrice - position.entryPrice
          : position.entryPrice - currentPrice;
        const unrealizedPnl = (priceDiff / position.entryPrice) * position.size * position.leverage;
        const maintRate = HYPERLIQUID_MAINTENANCE_MARGIN_RATE[position.pair] ?? 0.02;
        const notional = position.size * position.leverage;
        const maintenanceMargin = maintRate * notional;

        if (unrealizedPnl < 0 && Math.abs(unrealizedPnl) >= maintenanceMargin) {
          console.log(
            `[PositionMonitor] LIQUIDATION: ${position.pair} ${position.direction} unrealized $${unrealizedPnl.toFixed(2)} exceeds maintenance margin $${maintenanceMargin.toFixed(2)} (${(maintRate * 100).toFixed(2)}% of $${notional.toFixed(0)} notional)`
          );
          await closePosition(position.id, `liquidation (loss $${Math.abs(unrealizedPnl).toFixed(2)} >= margin $${maintenanceMargin.toFixed(2)})`);
          const penaltyUsd = position.size * (QUANT_LIQUIDATION_PENALTY_PCT / 100);
          deductLiquidationPenalty(position.id, penaltyUsd);
          continue;
        }
      }

      // Trailing stop
      const unrealizedPnlPct =
        position.direction === "long"
          ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

      if (unrealizedPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = unrealizedPnlPct;
      }

      if ((position.maxUnrealizedPnlPct ?? 0) > 0.5) {
        const trailTrigger = (position.maxUnrealizedPnlPct ?? 0) * 0.5;
        if (unrealizedPnlPct <= trailTrigger) {
          console.log(
            `[PositionMonitor] Trailing stop: ${position.pair} ${position.direction} peaked at ${(position.maxUnrealizedPnlPct ?? 0).toFixed(2)}%, now ${unrealizedPnlPct.toFixed(2)}% (trail trigger: ${trailTrigger.toFixed(2)}%)`,
          );
          await closePosition(position.id, "trailing-stop");
          continue;
        }
      }

      // Stagnation exit for directional positions (funding positions hold indefinitely)
      if (position.tradeType !== "funding") {
        const holdMs = Date.now() - new Date(position.openedAt).getTime();
        if (holdMs >= STAGNATION_TIMEOUT_MS) {
          console.log(
            `[PositionMonitor] Stagnation exit: ${position.pair} ${position.direction} held ${(holdMs / 3_600_000).toFixed(0)}h, P&L ${unrealizedPnlPct.toFixed(2)}%`,
          );
          await closePosition(position.id, "stagnation");
          continue;
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
          ? currentPrice <= (position.stopLoss ?? 0)
          : currentPrice >= (position.stopLoss ?? 0));

      const takeProfitBreached =
        hasValidTakeProfit &&
        (position.direction === "long"
          ? currentPrice >= (position.takeProfit ?? 0)
          : currentPrice <= (position.takeProfit ?? 0));

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
    console.error(`[PositionMonitor] Error checking positions: ${msg}`);
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
