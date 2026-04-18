import { getClient, resetConnection } from "./client.js";
import { getOpenQuantPositions, closePosition } from "./executor.js";
import { QUANT_POSITION_MONITOR_INTERVAL_MS, QUANT_TRAIL_FAST_POLL_MS, HYPERLIQUID_MAINTENANCE_MARGIN_RATE, QUANT_LIQUIDATION_PENALTY_PCT, API_PRICE_TIMEOUT_MS, QUANT_TRADING_PAIRS, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";

import { recordStopLossCooldown } from "./scheduler.js";
import { withTimeout } from "../../utils/timeout.js";
import { getWsMids, isWsConnected } from "./ws-prices.js";
import { fetchCandles } from "./candles.js";
import type { QuantPosition } from "./types.js";
import { accrueFundingIncome, deductLiquidationPenalty } from "./paper.js";
import { saveQuantPosition } from "../database/quant.js";
import { notifyCriticalError, notifyTrailActivation } from "../telegram/notifications.js";



// Max hold: 120h matches bt-1m-mega MAX_HOLD_H = 120
const STAGNATION_MS_BY_TRADE_TYPE: Record<string, number> = {
  "garch-v2": 120 * 60 * 60 * 1000,
};

// Single-stage T25/3 — activate at peak +25% leveraged, exit on 3% drop. B+ winner.
const TRAIL_STEPS = [
  { activation: 25, distance: 3 },
];
const BREAKEVEN_PCT = 5;
// Second breakeven: when peak hits BE2_PCT leveraged, lock in BE2_LOCK_PCT of profit (leveraged).
// B+ uses 20->lock10: after peak +20% leveraged, SL moves to entry + 1% price (= +10% leveraged).
const BE2_PCT = 20;
const BE2_LOCK_PCT = 10;
const DEAD_TRAIL = { activation: 999, distance: 999 };
const TRAIL_ENGINES = new Set(["garch-v2"]);

function getSteppedTrailDistance(peak: number, tradeType: string): { activation: number; distance: number } {
  if (!TRAIL_ENGINES.has(tradeType ?? "")) return DEAD_TRAIL;
  for (const step of TRAIL_STEPS) {
    if (peak >= step.activation) return step;
  }
  return DEAD_TRAIL;
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

// 1h-boundary SL/trail gate REMOVED — exchange SL handles stops, fast-poll handles trail.
// Legacy gating caused gap losses (bot SL fired late at worse price than exchange SL).

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

    // Accrue funding for paper positions
    const hasPaperPositions = positions.some(p => p.mode === "paper");
    if (hasPaperPositions) {
      await accrueFundingIncome();
    }

    // Fetch mid prices (paper liquidation check, fallback when 1m fetch fails)
    let mids: Record<string, string> = {};
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

    // Fetch 1m candles for each open position in parallel.
    // Backtest uses bar.high for peak and bar.low for SL trigger; the in-progress 1m bar
    // on HL updates tick-by-tick so high/low expand continuously - same semantics as bt.
    const candleFetches = await Promise.all(
      positions.map(async pos => {
        try {
          const c = await fetchCandles(pos.pair, "1m", 3);
          return { id: pos.id, candles: c };
        } catch {
          return { id: pos.id, candles: [] };
        }
      }),
    );
    const candlesByPosId = new Map(candleFetches.map(f => [f.id, f.candles]));

    const activePairs = new Set(QUANT_TRADING_PAIRS);

    let orphanClosed = false;
    for (const position of positions) {
      // Orphan pair removed from universe
      const hasOwnPairList = ENSEMBLE_TRADE_TYPES.has(position.tradeType ?? "") || position.tradeType === "news-trade" || position.tradeType === "btc-event";
      if (!hasOwnPairList && position.mode === "live" && !activePairs.has(position.pair)) {
        if (orphanClosed) await new Promise(r => setTimeout(r, 5000));
        console.log(`[PositionMonitor] Orphan close: ${position.pair}`);
        await tryClose(position, "orphan-pair-removed", true);
        orphanClosed = true;
        continue;
      }

      const candles = candlesByPosId.get(position.id) ?? [];
      const latestBar = candles.length > 0 ? candles[candles.length - 1] : null;
      const midRaw = mids[position.pair];
      const midPrice = midRaw !== undefined ? parseFloat(midRaw) : NaN;

      // Bar extremes with mid fallback if 1m fetch failed.
      const barHigh = latestBar ? latestBar.high : midPrice;
      const barLow = latestBar ? latestBar.low : midPrice;
      const barClose = latestBar ? latestBar.close : midPrice;

      if (!isFinite(barClose) || barClose <= 0) {
        console.log(`[PositionMonitor] No price/candle data for ${position.pair}, skipping`);
        continue;
      }

      // Paper liquidation check
      if (position.mode === "paper" && isFinite(midPrice)) {
        const priceDiff = position.direction === "long"
          ? midPrice - position.entryPrice
          : position.entryPrice - midPrice;
        const unrealizedPnl = (priceDiff / position.entryPrice) * position.size * position.leverage;
        const maintRate = HYPERLIQUID_MAINTENANCE_MARGIN_RATE[position.pair] ?? 0.02;
        const notional = position.size * position.leverage;
        const maintenanceMargin = maintRate * notional;
        const equity = position.size + unrealizedPnl;

        if (unrealizedPnl < 0 && equity <= maintenanceMargin) {
          console.log(`[PositionMonitor] LIQUIDATION: ${position.pair} ${position.direction} equity $${equity.toFixed(2)} <= margin $${maintenanceMargin.toFixed(2)}`);
          await tryClose(position, `liquidation (equity $${equity.toFixed(2)} <= margin $${maintenanceMargin.toFixed(2)})`);
          const penaltyUsd = position.size * (QUANT_LIQUIDATION_PENALTY_PCT / 100);
          deductLiquidationPenalty(position.id, penaltyUsd);
          recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
          continue;
        }
      }

      // === Backtest-parity block (bt-1m-mega.ts semantics) ===
      // Order: SL check -> peak update -> BE check -> trail check -> stagnation

      // 1. SL check using bar extremes (matches bt: bar.l <= stopLoss for longs, bar.h >= stopLoss for shorts)
      if (position.stopLoss && position.stopLoss > 0) {
        const slHit = position.direction === "long"
          ? barLow <= position.stopLoss
          : barHigh >= position.stopLoss;
        if (slHit) {
          const hitPrice = position.direction === "long" ? barLow : barHigh;
          console.log(`[PositionMonitor] SL hit: ${position.pair} ${position.direction} 1m.${position.direction === "long" ? "low" : "high"}=${hitPrice.toFixed(6)} vs SL=${position.stopLoss.toFixed(6)}`);
          await tryClose(position, "SL hit");
          recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
          continue;
        }
      }

      // 2. Peak update using bar extremes (bt: bestLevPnl = (bar.h/entry - 1)*lev*100 for longs)
      const favorableExtreme = position.direction === "long" ? barHigh : barLow;
      const peakPriceMove = position.direction === "long"
        ? (favorableExtreme - position.entryPrice) / position.entryPrice
        : (position.entryPrice - favorableExtreme) / position.entryPrice;
      const peakLevPnlPct = peakPriceMove * (position.leverage ?? 10) * 100;

      if (peakLevPnlPct > (position.maxUnrealizedPnlPct ?? 0)) {
        position.maxUnrealizedPnlPct = peakLevPnlPct;
        saveQuantPosition(position);
      }
      const peak = position.maxUnrealizedPnlPct ?? 0;

      // 3a. Breakeven stage 1: move SL to entry when peak hits BREAKEVEN_PCT leveraged
      const curSl = position.stopLoss ?? 0;
      if (TRAIL_ENGINES.has(position.tradeType ?? "") && peak >= BREAKEVEN_PCT && curSl < position.entryPrice) {
        position.stopLoss = position.entryPrice;
        saveQuantPosition(position);
        console.log(`[PositionMonitor] Breakeven: ${position.pair} SL -> entry ${position.entryPrice} (peak +${peak.toFixed(1)}%)`);
      }
      // 3b. Breakeven stage 2: lock profit above entry when peak hits BE2_PCT leveraged.
      // Leveraged-lock -> price-pct via leverage: lock_price_pct = BE2_LOCK_PCT / leverage / 100
      if (TRAIL_ENGINES.has(position.tradeType ?? "") && peak >= BE2_PCT) {
        const lockPricePct = BE2_LOCK_PCT / (position.leverage ?? 10) / 100;
        const be2Sl = position.direction === "long"
          ? position.entryPrice * (1 + lockPricePct)
          : position.entryPrice * (1 - lockPricePct);
        const sl = position.stopLoss ?? 0;
        const shouldMove = position.direction === "long" ? sl < be2Sl : sl > be2Sl;
        if (shouldMove) {
          position.stopLoss = be2Sl;
          saveQuantPosition(position);
          console.log(`[PositionMonitor] BE2 lock: ${position.pair} SL -> ${be2Sl.toFixed(6)} (+${BE2_LOCK_PCT}% lev profit, peak +${peak.toFixed(1)}%)`);
        }
      }

      // 4. Trail check using bar close (bt: currentLevPnl from bar.c)
      const currentPriceMove = position.direction === "long"
        ? (barClose - position.entryPrice) / position.entryPrice
        : (position.entryPrice - barClose) / position.entryPrice;
      const currentLevPnlPct = currentPriceMove * (position.leverage ?? 10) * 100;

      const trailCfg = getSteppedTrailDistance(peak, position.tradeType ?? "");
      if (peak >= trailCfg.activation && trailCfg.activation < 999) {
        if (position.mode === "live" && !trailActivatedIds.has(position.id)) {
          trailActivatedIds.add(position.id);
          void notifyTrailActivation({
            pair: position.pair, direction: position.direction,
            entryPrice: position.entryPrice, currentPrice: barClose,
            unrealizedPnlPct: peak, trailActivation: trailCfg.activation,
            trailDistance: trailCfg.distance, tradeType: position.tradeType ?? "directional",
          });
        }
        if (currentLevPnlPct <= peak - trailCfg.distance) {
          console.log(`[PositionMonitor] Trail hit: ${position.pair} peak=${peak.toFixed(1)}% now=${currentLevPnlPct.toFixed(1)}% dist=${trailCfg.distance}%`);
          await tryClose(position, "trailing-stop");
          continue;
        }
      }

      // 5. Stagnation exit (funding holds indefinitely)
      if (position.tradeType !== "funding") {
        const holdMs = Date.now() - new Date(position.openedAt).getTime();
        const stagnationMs = STAGNATION_MS_BY_TRADE_TYPE[position.tradeType ?? ""]
          ?? (4 * 60 * 60 * 1000 * 20);
        if (holdMs >= stagnationMs) {
          console.log(`[PositionMonitor] Stagnation exit: ${position.pair} held ${(holdMs / 3_600_000).toFixed(1)}h, P&L ${currentLevPnlPct.toFixed(2)}%`);
          await tryClose(position, "stagnation");
          continue;
        }
      }
    }

    // Prune stale entries for closed positions
    const openIds = new Set(positions.map(p => p.id));
    for (const id of trailActivatedIds) if (!openIds.has(id)) trailActivatedIds.delete(id);
    for (const id of closeFailCounts.keys()) if (!openIds.has(id)) closeFailCounts.delete(id);
    for (const id of nearSlIds.keys()) if (!openIds.has(id)) nearSlIds.delete(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PositionMonitor] Error checking positions: ${msg}`);
    if (msg.includes("timed out") || msg.includes("ECONNR") || msg.includes("fetch failed")) {
      resetConnection();
    }
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

    // Trail-active positions only
    const trailCandidates = positions.filter(p => {
      const peak = p.maxUnrealizedPnlPct ?? 0;
      const trailCfg = getTrailConfig(p);
      return trailActivatedIds.has(p.id) || peak >= trailCfg.activation;
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

      // Breakeven: move SL to entry when peak hits BREAKEVEN_PCT
      if (peak >= BREAKEVEN_PCT && position.stopLoss !== position.entryPrice) {
        position.stopLoss = position.entryPrice;
        saveQuantPosition(position);
        console.log(`[PositionMonitor] Breakeven (fast): ${position.pair} SL -> entry ${position.entryPrice}`);
      }

      const trailCfg = getTrailConfig(position);

      if (peak >= trailCfg.activation) {
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

  // Keep persisted peak PnL - trail state survives restart
  const existing = getOpenQuantPositions();
  if (existing.length > 0) {
    console.log(`[PositionMonitor] Loaded ${existing.length} positions with persisted peak PnL`);
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
