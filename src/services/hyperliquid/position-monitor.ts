import { getClient, resetConnection } from "./client.js";
import { getLighterAllMids, getLighterOpenPositions, isLighterInitialized } from "../lighter/client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, QUANT_TRAIL_FAST_POLL_MS, HYPERLIQUID_MAINTENANCE_MARGIN_RATE, QUANT_LIQUIDATION_PENALTY_PCT, API_PRICE_TIMEOUT_MS, QUANT_TRADING_PAIRS, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss, parseIndicatorsMeta } from "./quant-utils.js";

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
  "garch-v2": 96 * 60 * 60 * 1000,             // 96h (4d) max hold - optimized from 168h
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

const TRAIL_CONFIG_BY_ENGINE: Record<string, { activation: number; distance: number }> = {
  "donchian-trend": { activation: 999, distance: 999 }, // No trailing (backtest proven: costs 65% profit)
  "supertrend-4h": { activation: 999, distance: 999 },  // No trailing
  "garch-v2": { activation: 999, distance: 999 },       // No trailing
  "carry-momentum": { activation: 999, distance: 999 }, // No trailing
  "momentum-confirm": { activation: 999, distance: 999 },// No trailing
};
const DEFAULT_TRAIL = { activation: 20, distance: 5 };

function getTrailConfig(position: QuantPosition): { activation: number; distance: number } {
  return TRAIL_CONFIG_BY_ENGINE[position.tradeType ?? ""] ?? DEFAULT_TRAIL;
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
    const hlPositions = positions.filter(p => p.exchange !== "lighter");
    if (hlPositions.length > 0) {
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

    let lighterMids: Record<string, string> = {};
    const lighterPositions = positions.filter(p => p.exchange === "lighter");
    if (lighterPositions.length > 0 && isLighterInitialized()) {
      const lighterPairs = [...new Set(lighterPositions.map(p => p.pair))];
      try {
        lighterMids = await withTimeout(
          getLighterAllMids(lighterPairs),
          API_PRICE_TIMEOUT_MS + 5_000, "Lighter getAllMids",
        );
        const missing = lighterPairs.filter(p => !lighterMids[p]);
        if (missing.length > 0) {
          console.warn(`[PositionMonitor] Lighter missing prices for: ${missing.join(", ")}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PositionMonitor] Lighter price fetch failed: ${msg}`);
        const liveLighter = lighterPositions.filter(p => p.mode === "live").length;
        if (liveLighter > 0) {
          throttledCriticalAlert(`Lighter prices failed: ${liveLighter} live position(s) unprotected: ${msg}`, "PositionMonitor");
        }
      }
    }

    // Exchange P&L for live Lighter
    const lighterExchangePnl = new Map<string, number>(); // key: `${pair}:${direction}`
    const liveLighterPositions = lighterPositions.filter(p => p.mode === "live");
    if (liveLighterPositions.length > 0 && isLighterInitialized()) {
      try {
        const exchangePositions = await getLighterOpenPositions();
        for (const ep of exchangePositions) {
          lighterExchangePnl.set(`${ep.symbol}:${ep.side}`, ep.unrealizedPnlPct);
        }
      } catch (err) {
        console.warn(`[PositionMonitor] Exchange P&L fetch failed, falling back to mid-price: ${err instanceof Error ? err.message : String(err)}`);
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

      // Stop-loss check: use position.stopLoss (Chandelier/PSAR update it each cycle)
      const sl = position.stopLoss;
      if (sl && isFinite(sl) && sl > 0) {
        const slHit = (position.direction === "long" && currentPrice <= sl) ||
          (position.direction === "short" && currentPrice >= sl);
        if (slHit) {
          console.log(`[PositionMonitor] Stop hit: ${position.pair} ${position.direction} price=${currentPrice.toFixed(4)} sl=${sl.toFixed(4)}`);
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
      const exchangePnlPct = position.exchange === "lighter" && position.mode === "live"
        ? lighterExchangePnl.get(`${position.pair}:${position.direction}`)
        : undefined;
      const unrealizedPnlPct = exchangePnlPct !== undefined ? exchangePnlPct : pricePct * (position.leverage ?? 10) * 100;

      // No trailing for ensemble engines (backtest proven: costs 65% profit)
      const isEnsembleEngine = ENSEMBLE_TRADE_TYPES.has(position.tradeType ?? "");

      if (unrealizedPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = unrealizedPnlPct;
        saveQuantPosition(position);
      }

      // Percentage-based trailing for non-ensemble engines only
      const peak = position.maxUnrealizedPnlPct ?? 0;
      const trailCfg = getTrailConfig(position);
      if (!isEnsembleEngine && peak > trailCfg.activation) {
        // alert once per live position
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
        const trailTrigger = peak - trailCfg.distance;
        if (unrealizedPnlPct <= trailTrigger) {
          console.log(
            `[PositionMonitor] Trailing stop: ${position.pair} ${position.direction} peaked at ${peak.toFixed(2)}%, now ${unrealizedPnlPct.toFixed(2)}%`,
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

      // Skip near-SL for ensemble engines (they use ATR-based stops)
      const skipNearSl = ENSEMBLE_TRADE_TYPES.has(position.tradeType ?? "") || position.tradeType === "garch-chan";
      if (hasValidStopLoss && !skipNearSl) {
        const slDistance = Math.abs(position.entryPrice - effectiveSl);
        const priceDistanceTowardSl =
          position.direction === "long"
            ? position.entryPrice - currentPrice   // long: price falling toward SL
            : currentPrice - position.entryPrice;  // short: price rising toward SL

        const nearSlThreshold = 0.75 * slDistance;
        const recoveryThreshold = 0.20 * slDistance;

        if (priceDistanceTowardSl >= nearSlThreshold) {
          if (!nearSlIds.has(position.id)) {
            nearSlIds.set(position.id, currentPrice);
            console.log(
              `[PositionMonitor] Near-SL: ${position.pair} ${position.direction} @ ${currentPrice} (SL ${effectiveSl.toPrecision(6)}, 75% threshold)`
            );
          }
        } else if (nearSlIds.has(position.id)) {
          const priceAtEntry = nearSlIds.get(position.id) ?? currentPrice;
          const recovery =
            position.direction === "long"
              ? currentPrice - priceAtEntry   // long: price rising back up
              : priceAtEntry - currentPrice;  // short: price falling back down
          if (recovery >= recoveryThreshold) {
            console.log(
              `[PositionMonitor] Near-SL recovery exit: ${position.pair} ${position.direction} @ ${currentPrice} (recovered ${recovery.toPrecision(4)} of ${slDistance.toPrecision(4)} SL distance)`
            );
            nearSlIds.delete(position.id);
            await tryClose(position, "near-sl-recovery");
            continue;
          }
        }
      }

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

    // Trail-active or near-SL positions only
    const trailCandidates = positions.filter(p => {
      // Ensemble engines have no trailing, skip fast poll
      if (ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? "")) return false;
      if (nearSlIds.has(p.id)) return true;
      const trailCfg = getTrailConfig(p);
      return trailActivatedIds.has(p.id) || (p.maxUnrealizedPnlPct ?? 0) > trailCfg.activation;
    });

    if (trailCandidates.length === 0) return;

    // Prices for trail-active pairs only
    let mids: Record<string, string> = {};
    const hlCandidates = trailCandidates.filter(p => p.exchange !== "lighter");
    if (hlCandidates.length > 0) {
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
    }

    let lighterMids: Record<string, string> = {};
    const lighterCandidates = trailCandidates.filter(p => p.exchange === "lighter");
    if (lighterCandidates.length > 0 && isLighterInitialized()) {
      const lighterPairs = [...new Set(lighterCandidates.map(p => p.pair))];
      try {
        lighterMids = await withTimeout(
          getLighterAllMids(lighterPairs),
          API_PRICE_TIMEOUT_MS + 1_000, "Lighter getAllMids (fast-poll)",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PositionMonitor] Fast-poll Lighter price fetch failed: ${msg}`);
      }
    }

    for (const position of trailCandidates) {
      const priceSource = position.exchange === "lighter" ? lighterMids : mids;
      const rawPrice = priceSource[position.pair];
      if (rawPrice === undefined) continue;

      const currentPrice = parseFloat(rawPrice);
      if (isNaN(currentPrice)) continue;

      const pricePct =
        position.direction === "long"
          ? ((currentPrice - position.entryPrice) / position.entryPrice)
          : ((position.entryPrice - currentPrice) / position.entryPrice);
      // Lighter fees=0, mid-price is exact
      const unrealizedPnlPct = pricePct * (position.leverage ?? 10) * 100;

      if (unrealizedPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = unrealizedPnlPct;
        saveQuantPosition(position);
      }

      const peak = position.maxUnrealizedPnlPct ?? 0;
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
        const trailTrigger = peak - trailCfg.distance;
        if (unrealizedPnlPct <= trailTrigger) {
          console.log(
            `[PositionMonitor] Trailing stop (fast): ${position.pair} ${position.direction} peaked at ${peak.toFixed(2)}%, now ${unrealizedPnlPct.toFixed(2)}%`,
          );
          await tryClose(position, "trailing-stop");
          continue;
        }
      }

      // Skip near-SL for ensemble engines
      const skipNearSlFast = ENSEMBLE_TRADE_TYPES.has(position.tradeType ?? "") || position.tradeType === "garch-chan";
      const rawSlFast = position.stopLoss;
      const sl = (rawSlFast && isFinite(rawSlFast) && rawSlFast > 0)
        ? capStopLoss(position.entryPrice, rawSlFast, position.direction)
        : null;
      if (sl && !skipNearSlFast) {
        const slDistance = Math.abs(position.entryPrice - sl);
        const priceDistanceTowardSl =
          position.direction === "long"
            ? position.entryPrice - currentPrice
            : currentPrice - position.entryPrice;
        const nearSlThreshold = 0.75 * slDistance;
        if (priceDistanceTowardSl >= nearSlThreshold) {
          if (!nearSlIds.has(position.id)) {
            nearSlIds.set(position.id, currentPrice);
            console.log(`[PositionMonitor] Near-SL (fast): ${position.pair} ${position.direction} @ ${currentPrice}`);
          }
        } else if (nearSlIds.has(position.id)) {
          const priceAtNearSl = nearSlIds.get(position.id) ?? currentPrice;
          const recovery =
            position.direction === "long"
              ? currentPrice - priceAtNearSl
              : priceAtNearSl - currentPrice;
          if (recovery >= 0.20 * slDistance) {
            console.log(`[PositionMonitor] Near-SL recovery exit (fast): ${position.pair} ${position.direction} @ ${currentPrice}`);
            nearSlIds.delete(position.id);
            await tryClose(position, "near-sl-recovery");
          }
        }
      }
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

  // Pre-populate trail dedup so we don't re-fire alerts on restart
  const existing = getOpenQuantPositions();
  for (const pos of existing) {
    if (pos.mode !== "live") continue;
    const trailCfg = getTrailConfig(pos);
    if ((pos.maxUnrealizedPnlPct ?? 0) > trailCfg.activation) {
      trailActivatedIds.add(pos.id);
    }
  }
  if (trailActivatedIds.size > 0) {
    console.log(`[PositionMonitor] Pre-populated ${trailActivatedIds.size} trail-activated positions`);
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
