import { getClient, resetConnection } from "./client.js";
import { getLighterAllMids, isLighterInitialized, INTER_REQUEST_DELAY_MS as LIGHTER_DELAY_MS } from "../lighter/client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, HYPERLIQUID_MAINTENANCE_MARGIN_RATE, QUANT_LIQUIDATION_PENALTY_PCT, STAGNATION_TIMEOUT_MS, PSAR_STAGNATION_BARS, ZLEMA_STAGNATION_BARS, ELDER_STAGNATION_BARS, VORTEX_STAGNATION_BARS, SCHAFF_STAGNATION_BARS, DEMA_STAGNATION_BARS, HMA_STAGNATION_BARS, CCI_STAGNATION_BARS, API_PRICE_TIMEOUT_MS } from "../../config/constants.js";
import { withTimeout } from "../../utils/timeout.js";
import type { QuantPosition } from "./types.js";
import { accrueFundingIncome, deductLiquidationPenalty } from "./paper.js";
import { saveQuantPosition } from "../database/quant.js";
import { notifyCriticalError } from "../telegram/notifications.js";

// Per-engine stagnation: bar count x 4h
const H4_MS = 4 * 60 * 60 * 1000;
const STAGNATION_MS_BY_TRADE_TYPE: Record<string, number> = {
  "cci-directional": CCI_STAGNATION_BARS * H4_MS,
  "psar-directional": PSAR_STAGNATION_BARS * H4_MS,
  "zlema-directional": ZLEMA_STAGNATION_BARS * H4_MS,
  "elder-impulse-directional": ELDER_STAGNATION_BARS * H4_MS,
  "vortex-directional": VORTEX_STAGNATION_BARS * H4_MS,
  "schaff-directional": SCHAFF_STAGNATION_BARS * H4_MS,
  "dema-directional": DEMA_STAGNATION_BARS * H4_MS,
  "hma-directional": HMA_STAGNATION_BARS * H4_MS,
};

// Trailing stop: hardcoded 5% activation, 2% trail (backtest-validated)
const TRAIL_ACTIVATION = 5;
const TRAIL_DISTANCE = 2;

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let monitorRunning = false;

const closeFailCounts = new Map<string, number>();
let lastCriticalAlertMs = 0;
const CRITICAL_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function throttledCriticalAlert(msg: string, context: string): void {
  const now = Date.now();
  if (now - lastCriticalAlertMs < CRITICAL_ALERT_COOLDOWN_MS) return;
  lastCriticalAlertMs = now;
  void notifyCriticalError(msg, context);
}

async function tryClose(position: QuantPosition, reason: string): Promise<void> {
  const result = await closePosition(position.id, reason);
  if (result.success) {
    closeFailCounts.delete(position.id);
    return;
  }
  if (position.mode !== "live") return;
  const fails = (closeFailCounts.get(position.id) ?? 0) + 1;
  closeFailCounts.set(position.id, fails);
  if (fails >= 3) {
    throttledCriticalAlert(
      `CLOSE FAILED ${fails}x: ${position.pair} ${position.direction} (${reason})`,
      "PositionMonitor",
    );
  }
}

async function checkPositionStops(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const positions: QuantPosition[] = getOpenQuantPositions();

    if (positions.length === 0) {
      return;
    }

    // Kill switch blocks new opens (via risk gates), but we keep monitoring
    // stops to protect existing positions.

    // Accrue funding for paper positions (even in live mode, technical engines are paper)
    const hasPaperPositions = positions.some(p => p.mode === "paper");
    if (hasPaperPositions) {
      await accrueFundingIncome();
    }

    let mids: Record<string, string> = {};
    try {
      const sdk = getClient();
      mids = await withTimeout(
        sdk.info.getAllMids(true) as Promise<Record<string, string>>,
        API_PRICE_TIMEOUT_MS, "HL getAllMids",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PositionMonitor] Hyperliquid price fetch failed: ${msg}`);
    }

    let lighterMids: Record<string, string> = {};
    const lighterPositions = positions.filter(p => p.exchange === "lighter");
    if (lighterPositions.length > 0 && isLighterInitialized()) {
      const lighterPairs = [...new Set(lighterPositions.map(p => p.pair))];
      try {
        // Each individual call inside getLighterAllMids already has its own timeout.
        // Outer timeout must account for N sequential calls + 200ms inter-request delays.
        const outerTimeoutMs = lighterPairs.length * (API_PRICE_TIMEOUT_MS + LIGHTER_DELAY_MS);
        lighterMids = await withTimeout(
          getLighterAllMids(lighterPairs),
          outerTimeoutMs, "Lighter getAllMids",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PositionMonitor] Lighter price fetch failed: ${msg}`);
        const liveLighter = lighterPositions.filter(p => p.mode === "live").length;
        if (liveLighter > 0) {
          throttledCriticalAlert(`Lighter prices failed: ${liveLighter} live position(s) unprotected: ${msg}`, "PositionMonitor");
        }
      }
    }

    for (const position of positions) {
      const priceSource = position.exchange === "lighter" ? lighterMids : mids;
      const rawPrice = priceSource[position.pair];

      if (rawPrice === undefined) {
        console.log(`[PositionMonitor] No price data for ${position.pair}, skipping`);
        continue;
      }

      const currentPrice = parseFloat(rawPrice);

      if (isNaN(currentPrice)) {
        console.log(`[PositionMonitor] Invalid price for ${position.pair}: ${rawPrice}, skipping`);
        continue;
      }

      // Paper liquidation check (live positions are liquidated by exchange)
      if (position.mode === "paper") {
        const priceDiff = position.direction === "long"
          ? currentPrice - position.entryPrice
          : position.entryPrice - currentPrice;
        const unrealizedPnl = (priceDiff / position.entryPrice) * position.size * position.leverage;
        // TODO: Use Lighter-specific maintenance margin rates when available
        const maintRate = HYPERLIQUID_MAINTENANCE_MARGIN_RATE[position.pair] ?? 0.02;
        const notional = position.size * position.leverage;
        const maintenanceMargin = maintRate * notional;
        const equity = position.size + unrealizedPnl;

        if (unrealizedPnl < 0 && equity <= maintenanceMargin) {
          console.log(
            `[PositionMonitor] LIQUIDATION: ${position.pair} ${position.direction} equity $${equity.toFixed(2)} <= maintenance margin $${maintenanceMargin.toFixed(2)} (${(maintRate * 100).toFixed(2)}% of $${notional.toFixed(0)} notional)`
          );
          await tryClose(position, `liquidation (equity $${equity.toFixed(2)} <= margin $${maintenanceMargin.toFixed(2)})`);
          const penaltyUsd = position.size * (QUANT_LIQUIDATION_PENALTY_PCT / 100);
          deductLiquidationPenalty(position.id, penaltyUsd);
          continue;
        }
      }

      // Trailing stop (leveraged P&L to match backtest)
      const pricePct =
        position.direction === "long"
          ? ((currentPrice - position.entryPrice) / position.entryPrice)
          : ((position.entryPrice - currentPrice) / position.entryPrice);
      const unrealizedPnlPct = pricePct * (position.leverage ?? 10) * 100;

      if (unrealizedPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = unrealizedPnlPct;
        saveQuantPosition(position);
      }

      const peak = position.maxUnrealizedPnlPct ?? 0;
      if (peak > TRAIL_ACTIVATION) {
        const trailTrigger = peak - TRAIL_DISTANCE;
        if (unrealizedPnlPct <= trailTrigger) {
          console.log(
            `[PositionMonitor] Trailing stop: ${position.pair} ${position.direction} peaked at ${peak.toFixed(2)}%, now ${unrealizedPnlPct.toFixed(2)}% (trail trigger: ${trailTrigger.toFixed(2)}%)`,
          );
          await tryClose(position, "trailing-stop");
          continue;
        }
      }

      // Stagnation exit for directional positions (funding positions hold indefinitely)
      if (position.tradeType !== "funding") {
        const holdMs = Date.now() - new Date(position.openedAt).getTime();
        const stagnationMs = STAGNATION_MS_BY_TRADE_TYPE[position.tradeType ?? ""] ?? STAGNATION_TIMEOUT_MS;
        if (holdMs >= stagnationMs) {
          console.log(
            `[PositionMonitor] Stagnation exit: ${position.pair} ${position.direction} held ${(holdMs / 3_600_000).toFixed(0)}h (limit ${(stagnationMs / 3_600_000).toFixed(0)}h), P&L ${unrealizedPnlPct.toFixed(2)}%`,
          );
          await tryClose(position, "stagnation");
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
          `[PositionMonitor] Stop-loss triggered for ${position.pair} ${position.direction} @ ${currentPrice} (stop: ${(position.stopLoss ?? 0).toPrecision(6)})`,
        );
        await tryClose(position, "stop-loss");
      } else if (takeProfitBreached) {
        console.log(
          `[PositionMonitor] Take-profit triggered for ${position.pair} ${position.direction} @ ${currentPrice} (target: ${position.takeProfit})`,
        );
        await tryClose(position, "take-profit");
      }
    }

    // Prune stale entries for closed positions
    const openIds = new Set(positions.map(p => p.id));
    for (const id of closeFailCounts.keys()) {
      if (!openIds.has(id)) closeFailCounts.delete(id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PositionMonitor] Error checking positions: ${msg}`);
    if (msg.includes("timed out") || msg.includes("ECONNR") || msg.includes("fetch failed")) {
      resetConnection();
    }
    // Alert if live positions exist but monitor can't check them
    const liveCount = getOpenQuantPositions().filter(p => p.mode === "live").length;
    if (liveCount > 0) {
      throttledCriticalAlert(`Monitor failed: ${liveCount} live position(s) unprotected: ${msg}`, "PositionMonitor");
    }
  } finally {
    monitorRunning = false;
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
