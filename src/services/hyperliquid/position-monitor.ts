import { getClient, resetConnection } from "./client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, QUANT_TRAIL_FAST_POLL_MS, HYPERLIQUID_MAINTENANCE_MARGIN_RATE, QUANT_LIQUIDATION_PENALTY_PCT, API_PRICE_TIMEOUT_MS, QUANT_TRADING_PAIRS, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";

import { recordStopLossCooldown } from "./scheduler.js";
import { withTimeout } from "../../utils/timeout.js";
import { getWsMids, isWsConnected } from "./ws-prices.js";
import type { QuantPosition } from "./types.js";
import { accrueFundingIncome, deductLiquidationPenalty } from "./paper.js";
import { saveQuantPosition } from "../database/quant.js";
import { notifyCriticalError, notifyTrailActivation } from "../telegram/notifications.js";



// Per-engine stagnation
const STAGNATION_MS_BY_TRADE_TYPE: Record<string, number> = {
  "donchian-trend": 60 * 24 * 60 * 60 * 1000, // 60d max hold
  "supertrend-4h": 60 * 24 * 60 * 60 * 1000,  // 60d max hold
  "garch-v2": 72 * 60 * 60 * 1000,             // 72h (3d) max hold - optimized for faster capital recycling
  "carry-momentum": 8 * 24 * 60 * 60 * 1000,   // 8d max hold (7d + 1d buffer)
  "momentum-confirm": 48 * 60 * 60 * 1000,     // 48h max hold
  "alt-rotation": 4 * 24 * 60 * 60 * 1000,     // 4d max hold (3d rebalance + 1d buffer)
  "range-expansion": 30 * 24 * 60 * 60 * 1000,  // 30d max hold
  // Legacy engines (for existing DB positions until they close)
  "garch-chan": 48 * 60 * 60 * 1000,
  "btc-mr": 24 * 60 * 60 * 1000,
  "btc-event": 24 * 60 * 60 * 1000,
  "news-trade": 24 * 60 * 60 * 1000,
};

// Breakeven stop: after peak reaches +2% leveraged PnL, close at entry price
const BREAKEVEN_ACTIVATION_PCT = 2; // lowered from 3% (catches more reversions, +$0.03/day)

// Single-stage trail: 9/0.5 (trail fires immediately, SL at 1h boundary)
const TRAIL_STEPS = [
  { activation: 9, distance: 0.5 },   // activate at +9% lev PnL, exit on 0.5% pullback
];
const DEAD_TRAIL = { activation: 999, distance: 999 };
const TRAIL_ENGINES = new Set(["garch-v2"]);

function getSteppedTrailDistance(peak: number, tradeType: string): { activation: number; distance: number } {
  if (!TRAIL_ENGINES.has(tradeType ?? "")) return DEAD_TRAIL;
  // Find the highest stage the peak qualifies for (steps sorted high to low)
  for (const step of TRAIL_STEPS) {
    if (peak >= step.activation) return step;
  }
  return DEAD_TRAIL; // peak below lowest activation
}

// Legacy wrapper for non-stepped code paths
function getTrailConfig(position: QuantPosition): { activation: number; distance: number } {
  return getSteppedTrailDistance(position.maxUnrealizedPnlPct ?? 0, position.tradeType ?? "");
}

// Intraday hard-stop counter: track recent stops, half size when 3+ in 2h
const recentHardStops: number[] = []; // timestamps of hard stop exits
const HARDSTOP_WINDOW_MS = 2 * 60 * 60 * 1000;
const HARDSTOP_THRESHOLD = 3;
export function isInDangerMode(): boolean {
  const now = Date.now();
  while (recentHardStops.length > 0 && now - recentHardStops[0] > HARDSTOP_WINDOW_MS) recentHardStops.shift();
  return recentHardStops.length >= HARDSTOP_THRESHOLD;
}

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let monitorRunning = false;
let fastPollInterval: ReturnType<typeof setInterval> | null = null;
let fastPollRunning = false;

const trailActivatedIds = new Set<string>(); // trail alert dedup
const closingInProgress = new Set<string>(); // prevent double-close across loops
const nearSlIds = new Map<string, number>(); // positionId -> price at which near-SL was first detected

// Trail checks only at 1h bar boundaries (matches backtest resolution)
// Peak tracking still happens every tick, but trail EXIT decision waits for bar close
let lastTrailCheckHour = -1;
function isNewHourBar(): boolean {
  const currentHour = Math.floor(Date.now() / 3_600_000);
  if (currentHour !== lastTrailCheckHour) {
    lastTrailCheckHour = currentHour;
    return true;
  }
  return false;
}
// Track per-position: should we evaluate trail this tick?
// We always update peak, but only trigger exit at 1h boundary
let trailExitAllowed = false;

const closeFailCounts = new Map<string, number>();
let lastCriticalAlertMs = 0;
const CRITICAL_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function throttledCriticalAlert(msg: string, context: string): void {
  const now = Date.now();
  if (now - lastCriticalAlertMs < CRITICAL_ALERT_COOLDOWN_MS) return;
  lastCriticalAlertMs = now;
  void notifyCriticalError(msg, context);
}

async function tryClose(position: QuantPosition, reason: string, skipCancelReplace = false): Promise<void> {
  if (closingInProgress.has(position.id)) return;
  closingInProgress.add(position.id);
  try {
    const result = await closePosition(position.id, reason, skipCancelReplace);
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
  } finally {
    closingInProgress.delete(position.id);
  }
}

async function checkPositionStops(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    // Check if new 1h bar: trail exits only allowed at bar boundary
    if (isNewHourBar()) {
      trailExitAllowed = true;
    }

    const positions: QuantPosition[] = getOpenQuantPositions();

    if (positions.length === 0) {
      return;
    }

    // Kill switch blocks opens, not monitoring.

    // Accrue funding for paper positions
    const hasPaperPositions = positions.some(p => p.mode === "paper");
    if (hasPaperPositions) {
      await accrueFundingIncome();
    }

    let mids: Record<string, string> = {};
    if (positions.length > 0) {
      if (isWsConnected()) {
        mids = getWsMids();
      } else {
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
      }
    }

    const activePairs = new Set(QUANT_TRADING_PAIRS);

    let orphanClosed = false;
    for (const position of positions) {
      // Skip orphan check for engines with their own pair lists
      const hasOwnPairList = ENSEMBLE_TRADE_TYPES.has(position.tradeType ?? "") || position.tradeType === "news-trade" || position.tradeType === "btc-event";
      if (!hasOwnPairList && position.mode === "live" && !activePairs.has(position.pair)) {
        if (orphanClosed) await new Promise(r => setTimeout(r, 5000));
        console.log(`[PositionMonitor] Orphan close: ${position.pair}`);
        await tryClose(position, "orphan-pair-removed", true);
        orphanClosed = true;
        continue;
      }

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

      // Paper liquidation check
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
          recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
          continue;
        }
      }

      // ATR trailing DISABLED: system-level backtest showed no trailing (+$2.39/day)
      // beats all trailing variants (+$1.90-2.00/day). Engine exit signals (Donchian channel,
      // Supertrend flip, stagnation) already manage winners. Trailing cuts them short.

      // Stop-loss check: only at 1h bar boundary for GARCH (no exchange stop, bot-monitored)
      // This matches the backtest which checks SL on 1h bar close, not intra-bar wicks
      const sl = position.stopLoss;
      if (sl && isFinite(sl) && sl > 0 && trailExitAllowed) {
        const slHit = (position.direction === "long" && currentPrice <= sl) ||
          (position.direction === "short" && currentPrice >= sl);
        if (slHit) {
          console.log(`[PositionMonitor] Stop hit (1h): ${position.pair} ${position.direction} price=${currentPrice.toFixed(4)} sl=${sl.toFixed(4)}`);
          recentHardStops.push(Date.now());
          await tryClose(position, `stop-loss (price=${currentPrice.toPrecision(5)})`);
          recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
          continue;
        }
      }

      // Trailing stop
      const pricePct =
        position.direction === "long"
          ? ((currentPrice - position.entryPrice) / position.entryPrice)
          : ((position.entryPrice - currentPrice) / position.entryPrice);
      const unrealizedPnlPct = pricePct * (position.leverage ?? 10) * 100;

      // Trail 40/3 with re-entry for all engines (+16% profit, -17% MaxDD validated)

      if (unrealizedPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = unrealizedPnlPct;
        saveQuantPosition(position);
      }

      // Stepped trailing: peak always updated, but exit only at 1h bar boundary
      const peak = position.maxUnrealizedPnlPct ?? 0;
      const trailCfg = getSteppedTrailDistance(peak, position.tradeType ?? "");
      if (peak >= trailCfg.activation) {
        if (position.mode === "live" && !trailActivatedIds.has(position.id)) {
          trailActivatedIds.add(position.id);
          console.log(
            `[PositionMonitor] Trail activated: ${position.pair} ${position.direction} at +${peak.toFixed(1)}% (stage ${trailCfg.activation}%, dist ${trailCfg.distance}%)`,
          );
          void notifyTrailActivation({
            pair: position.pair,
            direction: position.direction,
            entryPrice: position.entryPrice,
            currentPrice: currentPrice,
            unrealizedPnlPct: peak,
            trailActivation: trailCfg.activation,
            trailDistance: trailCfg.distance,
            tradeType: position.tradeType ?? "directional",
          });
        }
        // Trail EXIT fires immediately when triggered (protects profits)
        const trailTrigger = peak - trailCfg.distance;
        if (unrealizedPnlPct <= trailTrigger) {
          console.log(
            `[PositionMonitor] Trailing stop: ${position.pair} ${position.direction} peaked at ${peak.toFixed(2)}%, now ${unrealizedPnlPct.toFixed(2)}% (stage ${trailCfg.activation}/${trailCfg.distance})`,
          );
          await tryClose(position, "trailing-stop");
          continue;
        }
      }

      // Stagnation exit (funding holds indefinitely)
      if (position.tradeType !== "funding") {
        const holdMs = Date.now() - new Date(position.openedAt).getTime();
        const stagnationMs = STAGNATION_MS_BY_TRADE_TYPE[position.tradeType ?? ""]
          ?? (4 * 60 * 60 * 1000 * 20);
        if (holdMs >= stagnationMs) {
          console.log(
            `[PositionMonitor] Stagnation exit: ${position.pair} ${position.direction} held ${stagnationMs < 3_600_000 ? `${Math.round(holdMs / 60_000)}m` : `${(holdMs / 3_600_000).toFixed(0)}h`} (limit ${stagnationMs < 3_600_000 ? `${Math.round(stagnationMs / 60_000)}m` : `${(stagnationMs / 3_600_000).toFixed(0)}h`}), P&L ${unrealizedPnlPct.toFixed(2)}%`,
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

      const rawSl = position.stopLoss ?? 0;
      const cappedSl = hasValidStopLoss
        ? capStopLoss(position.entryPrice, rawSl, position.direction)
        : 0;
      const effectiveSl = hasValidStopLoss ? cappedSl : 0;

      // Near-SL recovery disabled: all exits at 1h boundary only (matches backtest)

      const stopLossBreached =
        hasValidStopLoss &&
        (position.direction === "long"
          ? currentPrice <= effectiveSl
          : currentPrice >= effectiveSl);

      const takeProfitBreached =
        hasValidTakeProfit &&
        (position.direction === "long"
          ? currentPrice >= (position.takeProfit ?? 0)
          : currentPrice <= (position.takeProfit ?? 0));

      // Stop-loss and take-profit: only at 1h bar boundary (matches backtest)
      if (trailExitAllowed) {
        if (stopLossBreached) {
          console.log(
            `[PositionMonitor] Stop-loss triggered (1h): ${position.pair} ${position.direction} @ ${currentPrice} (stop: ${(position.stopLoss ?? 0).toPrecision(6)})`,
          );
          await tryClose(position, "stop-loss");
        } else if (takeProfitBreached) {
          console.log(
            `[PositionMonitor] Take-profit triggered for ${position.pair} ${position.direction} @ ${currentPrice} (target: ${position.takeProfit})`,
          );
          await tryClose(position, "take-profit");
        }
      }
    }

    // Reset trail gate after all positions checked this tick
    trailExitAllowed = false;

    // Prune stale entries for closed positions
    const openIds = new Set(positions.map(p => p.id));
    for (const id of trailActivatedIds) {
      if (!openIds.has(id)) trailActivatedIds.delete(id);
    }
    for (const id of closeFailCounts.keys()) {
      if (!openIds.has(id)) closeFailCounts.delete(id);
    }
    for (const id of nearSlIds.keys()) {
      if (!openIds.has(id)) nearSlIds.delete(id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PositionMonitor] Error checking positions: ${msg}`);
    if (msg.includes("timed out") || msg.includes("ECONNR") || msg.includes("fetch failed")) {
      resetConnection();
    }
    // Alert if live positions are unprotected
    const liveCount = getOpenQuantPositions().filter(p => p.mode === "live").length;
    if (liveCount > 0) {
      throttledCriticalAlert(`Monitor failed: ${liveCount} live position(s) unprotected: ${msg}`, "PositionMonitor");
    }
  } finally {
    monitorRunning = false;
  }
}

async function checkTrailActivePositions(): Promise<void> {
  if (fastPollRunning) return;
  fastPollRunning = true;
  try {
    const positions: QuantPosition[] = getOpenQuantPositions();

    // Trail-active, breakeven-eligible, or near-SL positions
    const trailCandidates = positions.filter(p => {
      if (nearSlIds.has(p.id)) return true;
      const peak = p.maxUnrealizedPnlPct ?? 0;
      if (peak >= BREAKEVEN_ACTIVATION_PCT && TRAIL_ENGINES.has(p.tradeType ?? "")) return true;
      const trailCfg = getTrailConfig(p);
      return trailActivatedIds.has(p.id) || peak > trailCfg.activation;
    });

    if (trailCandidates.length === 0) return;

    // Prices for trail-active pairs only
    let mids: Record<string, string> = {};
    if (isWsConnected()) {
      mids = getWsMids();
    } else {
      try {
        const sdk = getClient();
        mids = await withTimeout(
          sdk.info.getAllMids(true) as Promise<Record<string, string>>,
          API_PRICE_TIMEOUT_MS, "HL getAllMids (fast-poll)",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PositionMonitor] Fast-poll HL price fetch failed: ${msg}`);
      }
    }

    for (const position of trailCandidates) {
      const rawPrice = mids[position.pair];
      if (rawPrice === undefined) continue;

      const currentPrice = parseFloat(rawPrice);
      if (isNaN(currentPrice)) continue;

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

      // Breakeven removed: tight trail at 3% replaces it (no fee drain)

      const trailCfg = getTrailConfig(position);

      if (peak > trailCfg.activation) {
        if (position.mode === "live" && !trailActivatedIds.has(position.id)) {
          trailActivatedIds.add(position.id);
          console.log(
            `[PositionMonitor] Trail activated: ${position.pair} ${position.direction} at +${peak.toFixed(1)}% (threshold ${trailCfg.activation}%, trail ${trailCfg.distance}%)`,
          );
          void notifyTrailActivation({
            pair: position.pair,
            direction: position.direction,
            entryPrice: position.entryPrice,
            currentPrice: currentPrice,
            unrealizedPnlPct: peak,
            trailActivation: trailCfg.activation,
            trailDistance: trailCfg.distance,
            tradeType: position.tradeType ?? "directional",
          });
        }
        // Trail EXIT fires immediately (fast poll, every 3s)
        const trailTrigger = peak - trailCfg.distance;
        if (unrealizedPnlPct <= trailTrigger) {
          console.log(
            `[PositionMonitor] Trailing stop (fast): ${position.pair} ${position.direction} peaked at ${peak.toFixed(2)}%, now ${unrealizedPnlPct.toFixed(2)}%`,
          );
          await tryClose(position, "trailing-stop");
          continue;
        }
      }

      // Near-SL fast-poll disabled: all SL exits at 1h boundary only
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PositionMonitor] Fast-poll error: ${msg}`);
  } finally {
    fastPollRunning = false;
  }
}

export function startPositionMonitor(): void {
  if (monitorInterval !== null) {
    return;
  }

  // On startup: reset peak to 0 so trail builds from current price (prevents stale peaks from instantly triggering trail)
  const existing = getOpenQuantPositions();
  for (const pos of existing) {
    if ((pos.maxUnrealizedPnlPct ?? 0) > 0) {
      pos.maxUnrealizedPnlPct = 0;
      saveQuantPosition(pos);
    }
  }
  if (existing.length > 0) {
    console.log(`[PositionMonitor] Reset peak PnL for ${existing.length} positions (trail starts fresh)`);
  }

  console.log(`[PositionMonitor] Started (interval: ${QUANT_POSITION_MONITOR_INTERVAL_MS}ms)`);
  monitorInterval = setInterval(() => {
    void checkPositionStops();
  }, QUANT_POSITION_MONITOR_INTERVAL_MS);
  console.log(`[PositionMonitor] Fast-poll started (${QUANT_TRAIL_FAST_POLL_MS}ms)`);
  fastPollInterval = setInterval(() => {
    void checkTrailActivePositions();
  }, QUANT_TRAIL_FAST_POLL_MS);
}

export function stopPositionMonitor(): void {
  if (monitorInterval === null) {
    return;
  }
  clearInterval(monitorInterval);
  monitorInterval = null;
  if (fastPollInterval !== null) {
    clearInterval(fastPollInterval);
    fastPollInterval = null;
  }
  console.log("[PositionMonitor] Stopped");
}
