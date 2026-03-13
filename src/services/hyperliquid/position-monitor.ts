import { getClient, resetConnection } from "./client.js";
import { getLighterAllMids, getLighterOpenPositions, isLighterInitialized, INTER_REQUEST_DELAY_MS as LIGHTER_DELAY_MS } from "../lighter/client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, QUANT_TRAIL_FAST_POLL_MS, HYPERLIQUID_MAINTENANCE_MARGIN_RATE, QUANT_LIQUIDATION_PENALTY_PCT, STAGNATION_TIMEOUT_MS, PSAR_STAGNATION_BARS, PSAR_TRAIL_ACTIVATION, PSAR_TRAIL_DISTANCE, ZLEMA_STAGNATION_BARS, ZLEMA_TRAIL_ACTIVATION, ZLEMA_TRAIL_DISTANCE, VORTEX_STAGNATION_BARS, VORTEX_TRAIL_ACTIVATION, VORTEX_TRAIL_DISTANCE, SCHAFF_STAGNATION_BARS, SCHAFF_TRAIL_ACTIVATION, SCHAFF_TRAIL_DISTANCE, DEMA_STAGNATION_BARS, DEMA_TRAIL_ACTIVATION, DEMA_TRAIL_DISTANCE, CCI_STAGNATION_BARS, CCI_TRAIL_ACTIVATION, CCI_TRAIL_DISTANCE, AROON_STAGNATION_BARS, AROON_TRAIL_ACTIVATION, AROON_TRAIL_DISTANCE, MACD_STAGNATION_BARS, MACD_TRAIL_ACTIVATION, MACD_TRAIL_DISTANCE, ZLEMAV2_STAGNATION_BARS, ZLEMAV2_TRAIL_ACTIVATION, ZLEMAV2_TRAIL_DISTANCE, SCHAFFV2_STAGNATION_BARS, SCHAFFV2_TRAIL_ACTIVATION, SCHAFFV2_TRAIL_DISTANCE, HFT_FADE_STAGNATION_MS, HFT_FADE_TRAIL_ACTIVATION, HFT_FADE_TRAIL_DISTANCE, API_PRICE_TIMEOUT_MS, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import { withTimeout } from "../../utils/timeout.js";
import type { QuantPosition } from "./types.js";
import { accrueFundingIncome, deductLiquidationPenalty } from "./paper.js";
import { saveQuantPosition } from "../database/quant.js";
import { notifyCriticalError, notifyTrailActivation } from "../telegram/notifications.js";


// Per-engine stagnation
const H4_MS = 4 * 60 * 60 * 1000;
const STAGNATION_MS_BY_TRADE_TYPE: Record<string, number> = {
  "cci-directional": CCI_STAGNATION_BARS * H4_MS,
  "psar-directional": PSAR_STAGNATION_BARS * H4_MS,
  "zlema-directional": ZLEMA_STAGNATION_BARS * H4_MS,
  "vortex-directional": VORTEX_STAGNATION_BARS * H4_MS,
  "schaff-directional": SCHAFF_STAGNATION_BARS * H4_MS,
  "dema-directional": DEMA_STAGNATION_BARS * H4_MS,
  "aroon-directional": AROON_STAGNATION_BARS * H4_MS,
  "macd-directional": MACD_STAGNATION_BARS * H4_MS,
  "zlemav2-directional": ZLEMAV2_STAGNATION_BARS * H4_MS,
  "schaffv2-directional": SCHAFFV2_STAGNATION_BARS * H4_MS,
  "ai-directional": Infinity, // signal-flip only
  "hft-fade": HFT_FADE_STAGNATION_MS,
};

// Per-engine trailing stop config
const TRAIL_CONFIG_BY_ENGINE: Record<string, { activation: number; distance: number }> = {
  "psar-directional": { activation: PSAR_TRAIL_ACTIVATION, distance: PSAR_TRAIL_DISTANCE },
  "zlema-directional": { activation: ZLEMA_TRAIL_ACTIVATION, distance: ZLEMA_TRAIL_DISTANCE },
  "vortex-directional": { activation: VORTEX_TRAIL_ACTIVATION, distance: VORTEX_TRAIL_DISTANCE },
  "schaff-directional": { activation: SCHAFF_TRAIL_ACTIVATION, distance: SCHAFF_TRAIL_DISTANCE },
  "dema-directional": { activation: DEMA_TRAIL_ACTIVATION, distance: DEMA_TRAIL_DISTANCE },
  "cci-directional": { activation: CCI_TRAIL_ACTIVATION, distance: CCI_TRAIL_DISTANCE },
  "aroon-directional": { activation: AROON_TRAIL_ACTIVATION, distance: AROON_TRAIL_DISTANCE },
  "macd-directional": { activation: MACD_TRAIL_ACTIVATION, distance: MACD_TRAIL_DISTANCE },
  "zlemav2-directional": { activation: ZLEMAV2_TRAIL_ACTIVATION, distance: ZLEMAV2_TRAIL_DISTANCE },
  "schaffv2-directional": { activation: SCHAFFV2_TRAIL_ACTIVATION, distance: SCHAFFV2_TRAIL_DISTANCE },
  "ai-directional": { activation: 20, distance: 5 },
  "hft-fade": { activation: HFT_FADE_TRAIL_ACTIVATION, distance: HFT_FADE_TRAIL_DISTANCE },
  // Inverted: activate earlier to lock in profits faster
  "inv-psar-directional": { activation: 5, distance: 3 },
  "inv-zlema-directional": { activation: 5, distance: 3 },
  "inv-vortex-directional": { activation: 5, distance: 3 },
  "inv-schaff-directional": { activation: 5, distance: 3 },
  "inv-dema-directional": { activation: 5, distance: 3 },
  "inv-cci-directional": { activation: 5, distance: 3 },
  "inv-aroon-directional": { activation: 5, distance: 3 },
  "inv-macd-directional": { activation: 5, distance: 3 },
  "inv-zlemav2-directional": { activation: 5, distance: 3 },
  "inv-schaffv2-directional": { activation: 5, distance: 3 },
};
const DEFAULT_TRAIL = { activation: 20, distance: 5 };

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

async function tryClose(position: QuantPosition, reason: string, skipCancelReplace = true): Promise<void> {
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

    let lighterMids: Record<string, string> = {};
    const lighterPositions = positions.filter(p => p.exchange === "lighter");
    if (lighterPositions.length > 0 && isLighterInitialized()) {
      // HFT has its own 2s monitor, skip here
      const lighterPairs = [...new Set(lighterPositions.filter(p => !p.tradeType?.startsWith("hft-")).map(p => p.pair))];
      try {
        // outer = N * (per-call timeout + inter-request delay)
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

    // Exchange P&L for live Lighter
    const lighterExchangePnl = new Map<string, number>(); // key: `${pair}:${direction}`
    const liveLighterNonHft = lighterPositions.filter(p => p.mode === "live" && !p.tradeType?.startsWith("hft-"));
    if (liveLighterNonHft.length > 0 && isLighterInitialized()) {
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
      // HFT has its own 2s monitor
      if (position.tradeType?.startsWith("hft-")) continue;

      if (position.mode === "live" && !activePairs.has(position.pair)) {
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

      // Paper liquidation check (skip hft-*)
      if (position.mode === "paper" && !position.tradeType?.startsWith("hft-")) {
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

      // Trailing stop
      const pricePct =
        position.direction === "long"
          ? ((currentPrice - position.entryPrice) / position.entryPrice)
          : ((position.entryPrice - currentPrice) / position.entryPrice);
      const exchangePnlPct = position.exchange === "lighter" && position.mode === "live"
        ? lighterExchangePnl.get(`${position.pair}:${position.direction}`)
        : undefined;
      const unrealizedPnlPct = exchangePnlPct !== undefined ? exchangePnlPct : pricePct * (position.leverage ?? 10) * 100;

      if (unrealizedPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = unrealizedPnlPct;
        saveQuantPosition(position);
      }

      const peak = position.maxUnrealizedPnlPct ?? 0;
      const trailBaseType = (position.tradeType ?? "").replace(/^inv-/, "");
      const trailCfg = TRAIL_CONFIG_BY_ENGINE[position.tradeType ?? ""]
        ?? TRAIL_CONFIG_BY_ENGINE[trailBaseType]
        ?? DEFAULT_TRAIL;
      if (peak > trailCfg.activation) {
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
        const baseType = (position.tradeType ?? "").replace(/^inv-/, "");
        const stagnationMs = STAGNATION_MS_BY_TRADE_TYPE[position.tradeType ?? ""]
          ?? STAGNATION_MS_BY_TRADE_TYPE[baseType]
          ?? ((position.tradeType ?? "").startsWith("hft-") ? HFT_FADE_STAGNATION_MS : STAGNATION_TIMEOUT_MS);
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

      // Cap SL; skip inverted (SL = normal's TP)
      const isInvertedPos = (position.tradeType ?? "").startsWith("inv-");
      const rawSl = position.stopLoss ?? 0;
      const cappedSl = hasValidStopLoss
        ? capStopLoss(position.entryPrice, rawSl, position.direction, isInvertedPos)
        : 0;
      const effectiveSl = hasValidStopLoss ? cappedSl : 0;

      // Near-SL recovery exit
      if (hasValidStopLoss && !position.tradeType?.startsWith("hft-")) {
        const slDistance = Math.abs(position.entryPrice - effectiveSl);
        const priceDistanceTowardSl =
          position.direction === "long"
            ? position.entryPrice - currentPrice   // long: price falling toward SL
            : currentPrice - position.entryPrice;  // short: price rising toward SL

        const nearSlThreshold = 0.70 * slDistance;
        const recoveryThreshold = 0.20 * slDistance;

        if (priceDistanceTowardSl >= nearSlThreshold) {
          if (!nearSlIds.has(position.id)) {
            nearSlIds.set(position.id, currentPrice);
            console.log(
              `[PositionMonitor] Near-SL: ${position.pair} ${position.direction} @ ${currentPrice} (SL ${effectiveSl.toPrecision(6)}, 70% threshold)`
            );
          }
        } else if (nearSlIds.has(position.id)) {
          const priceAtEntry = nearSlIds.get(position.id)!;
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

      if (position.tradeType?.startsWith("hft-")) continue; // handled by 2s HFT monitor

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

    // Non-HFT trail-active or near-SL positions only
    const trailCandidates = positions.filter(p => {
      if (p.tradeType?.startsWith("hft-")) return false;
      if (nearSlIds.has(p.id)) return true;
      const trailBaseType = (p.tradeType ?? "").replace(/^inv-/, "");
      const trailCfg = TRAIL_CONFIG_BY_ENGINE[p.tradeType ?? ""]
        ?? TRAIL_CONFIG_BY_ENGINE[trailBaseType]
        ?? DEFAULT_TRAIL;
      return trailActivatedIds.has(p.id) || (p.maxUnrealizedPnlPct ?? 0) > trailCfg.activation;
    });

    if (trailCandidates.length === 0) return;

    // Prices for trail-active pairs only
    let mids: Record<string, string> = {};
    const hlCandidates = trailCandidates.filter(p => p.exchange !== "lighter");
    if (hlCandidates.length > 0) {
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

    let lighterMids: Record<string, string> = {};
    const lighterCandidates = trailCandidates.filter(p => p.exchange === "lighter");
    if (lighterCandidates.length > 0 && isLighterInitialized()) {
      const lighterPairs = [...new Set(lighterCandidates.map(p => p.pair))];
      try {
        const outerTimeoutMs = lighterPairs.length * (API_PRICE_TIMEOUT_MS + LIGHTER_DELAY_MS);
        lighterMids = await withTimeout(
          getLighterAllMids(lighterPairs),
          outerTimeoutMs, "Lighter getAllMids (fast-poll)",
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
      const trailBaseType = (position.tradeType ?? "").replace(/^inv-/, "");
      const trailCfg = TRAIL_CONFIG_BY_ENGINE[position.tradeType ?? ""]
        ?? TRAIL_CONFIG_BY_ENGINE[trailBaseType]
        ?? DEFAULT_TRAIL;

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

      // Near-SL recovery
      const sl = position.stopLoss;
      if (sl && isFinite(sl) && sl > 0) {
        const slDistance = Math.abs(position.entryPrice - sl);
        const priceDistanceTowardSl =
          position.direction === "long"
            ? position.entryPrice - currentPrice
            : currentPrice - position.entryPrice;
        const nearSlThreshold = 0.70 * slDistance;
        if (priceDistanceTowardSl >= nearSlThreshold) {
          if (!nearSlIds.has(position.id)) {
            nearSlIds.set(position.id, currentPrice);
            console.log(`[PositionMonitor] Near-SL (fast): ${position.pair} ${position.direction} @ ${currentPrice}`);
          }
        } else if (nearSlIds.has(position.id)) {
          const priceAtNearSl = nearSlIds.get(position.id)!;
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
