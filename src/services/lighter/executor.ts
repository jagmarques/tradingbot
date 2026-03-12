import {
  getSignerClient,
  getMarketIndex,
  getMarketSizeDecimals,
  getMarketPriceDecimals,
  getLighterMidPrice,
  getLighterMaxLeverage,
  withNonce,
  resetNonce,
  toBaseUnits,
  toPriceUnits,
  getLighterOpenPositions,
  getLighterAccountInfo,
} from "./client.js";
import type { QuantPosition, TradeType } from "../hyperliquid/types.js";
import {
  generateQuantId,
  saveQuantPosition,
  saveQuantTrade,
  loadOpenQuantPositions,
} from "../database/quant.js";
import { notifyQuantTradeEntry, notifyQuantTradeExit, notifyCriticalError } from "../telegram/notifications.js";
import { recordStopLossCooldown } from "../hyperliquid/scheduler.js";
import { SignerClient } from "zklighter-sdk";
import { withTimeout, TimeoutError } from "../../utils/timeout.js";
import { API_ORDER_TIMEOUT_MS, API_PRICE_TIMEOUT_MS } from "../../config/constants.js";
import { capStopLoss, calcPnl, inferExitReason, shouldRecordSlCooldown, rebaseStops } from "../hyperliquid/quant-utils.js";

const lighterPositions = new Map<string, QuantPosition>();
const closingSet = new Set<string>();
const openingPairs = new Set<string>();
const exchangeStops = new Set<string>();
const exchangeTPs = new Set<string>();

const positionContext = new Map<string, {
  indicatorsAtEntry?: string;
}>();

async function placeExchangeStop(position: QuantPosition, force = false): Promise<void> {
  if (!position.stopLoss || !isFinite(position.stopLoss)) return;
  if (!force && exchangeStops.has(position.pair)) return;
  exchangeStops.delete(position.pair);
  try {
    const isInverted = (position.tradeType ?? "").startsWith("inv-");
    const sl = capStopLoss(position.entryPrice, position.stopLoss, position.direction, isInverted);
    const marketIndex = await getMarketIndex(position.pair);
    if (marketIndex === null) return;
    const sizeDecimals = await getMarketSizeDecimals(marketIndex);
    const priceDecimals = await getMarketPriceDecimals(marketIndex);
    const notional = position.size * position.leverage;
    const baseAmount = toBaseUnits(notional / position.entryPrice, sizeDecimals);
    if (baseAmount <= 0) return;
    const triggerPrice = toPriceUnits(sl, priceDecimals);
    const limitPrice = toPriceUnits(
      position.direction === "long" ? sl * 0.95 : sl * 1.05,
      priceDecimals,
    );
    const isAsk = position.direction === "long";
    // Lighter SL triggers above (for shorts), TP triggers below (for longs)
    const [, , err] = await withNonce(async (nonce) => {
      const createOrder = position.direction === "long"
        ? getSignerClient().create_tp_order(
            marketIndex, Date.now() % 1_000_000_000, baseAmount,
            triggerPrice, limitPrice, isAsk, true, nonce,
          )
        : getSignerClient().create_sl_order(
            marketIndex, Date.now() % 1_000_000_000, baseAmount,
            triggerPrice, limitPrice, isAsk, true, nonce,
          );
      return withTimeout(createOrder, API_ORDER_TIMEOUT_MS, "Lighter placeExchangeStop");
    });
    if (err) {
      console.error(`[Lighter Executor] Exchange stop failed for ${position.pair}: ${err}`);
    } else {
      exchangeStops.add(position.pair);
      console.log(`[Lighter Executor] Exchange stop placed for ${position.pair} @ ${sl}`);
    }
  } catch (err) {
    if (err instanceof TimeoutError) resetNonce();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Exchange stop error for ${position.pair}: ${msg}`);
  }
}

async function placeExchangeTP(position: QuantPosition, force = false): Promise<void> {
  if (!position.takeProfit || !isFinite(position.takeProfit) || position.takeProfit <= 0) return;
  if (!force && exchangeTPs.has(position.pair)) return;
  exchangeTPs.delete(position.pair);
  try {
    const marketIndex = await getMarketIndex(position.pair);
    if (marketIndex === null) return;
    const sizeDecimals = await getMarketSizeDecimals(marketIndex);
    const priceDecimals = await getMarketPriceDecimals(marketIndex);
    const notional = position.size * position.leverage;
    const baseAmount = toBaseUnits(notional / position.entryPrice, sizeDecimals);
    if (baseAmount <= 0) return;
    const tp = position.takeProfit;
    const triggerPrice = toPriceUnits(tp, priceDecimals);
    const limitPrice = toPriceUnits(
      position.direction === "long" ? tp * 0.95 : tp * 1.05,
      priceDecimals,
    );
    const isAsk = position.direction === "long";
    // TP: longs trigger above (SL order), shorts trigger below (TP order) - opposite of SL
    const [, , err] = await withNonce(async (nonce) => {
      const createOrder = position.direction === "long"
        ? getSignerClient().create_sl_order(
            marketIndex, Date.now() % 1_000_000_000, baseAmount,
            triggerPrice, limitPrice, isAsk, true, nonce,
          )
        : getSignerClient().create_tp_order(
            marketIndex, Date.now() % 1_000_000_000, baseAmount,
            triggerPrice, limitPrice, isAsk, true, nonce,
          );
      return withTimeout(createOrder, API_ORDER_TIMEOUT_MS, "Lighter placeExchangeTP");
    });
    if (err) {
      console.error(`[Lighter Executor] Exchange TP failed for ${position.pair}: ${err}`);
    } else {
      exchangeTPs.add(position.pair);
      console.log(`[Lighter Executor] Exchange TP placed for ${position.pair} @ ${tp}`);
    }
  } catch (err) {
    if (err instanceof TimeoutError) resetNonce();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Exchange TP error for ${position.pair}: ${msg}`);
  }
}

// Cancel all exchange orders, then re-place stops/TPs for remaining open positions
async function cancelAndReplaceOrders(closingPositionId: string): Promise<void> {
  try {
    await withNonce(async (nonce) =>
      withTimeout(getSignerClient().cancel_all_orders(0, 0, nonce), API_ORDER_TIMEOUT_MS, "Lighter cancelAllOrders"),
    );
    exchangeStops.clear();
    exchangeTPs.clear();
    console.log(`[Lighter Executor] All orders cancelled`);
  } catch (err) {
    if (err instanceof TimeoutError) resetNonce();
    console.error(`[Lighter Executor] Cancel all orders error: ${err instanceof Error ? err.message : err}`);
    return;
  }
  // Re-place stops/TPs for all remaining positions except the one being closed
  for (const pos of getLighterLivePositions()) {
    if (pos.id === closingPositionId) continue;
    if (pos.tradeType === "hft-fade") continue;
    if (pos.stopLoss && isFinite(pos.stopLoss)) await placeExchangeStop(pos, true);
    if (pos.takeProfit && isFinite(pos.takeProfit) && pos.takeProfit > 0) await placeExchangeTP(pos, true);
  }
}

export function initLighterEngine(): void {
  lighterPositions.clear();
  const allOpen = loadOpenQuantPositions();
  const lighterLive = allOpen.filter(p => p.exchange === "lighter" && p.mode === "live");
  for (const pos of lighterLive) {
    lighterPositions.set(pos.id, pos);
  }
  console.log(`[Lighter Executor] Init: ${lighterLive.length} live positions restored`);
  setTimeout(async () => {
    await reconcileLighter();
    try {
      await withNonce(async (nonce) => getSignerClient().cancel_all_orders(0, 0, nonce));
      exchangeStops.clear();
      exchangeTPs.clear();
      console.log("[Lighter Executor] Cleared stale orders");
    } catch { /* best effort */ }
    for (const pos of getLighterLivePositions()) {
      if (pos.tradeType === "hft-fade") continue;
      if (pos.stopLoss && isFinite(pos.stopLoss)) await placeExchangeStop(pos, true);
      if (pos.takeProfit && isFinite(pos.takeProfit) && pos.takeProfit > 0) await placeExchangeTP(pos, true);
    }
  }, 30_000);
  setInterval(() => void reconcileLighter(), 5 * 60 * 1000);
}

async function closePhantom(pos: QuantPosition): Promise<void> {
  const exitPrice = await getLighterMidPrice(pos.pair).catch(() => null) ?? pos.entryPrice;
  const fees = 0; // Lighter: zero fees
  const pnl = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.leverage, fees);
  const now = new Date().toISOString();
  const reason = inferExitReason(pos, exitPrice);

  const closed: QuantPosition = { ...pos, status: "closed", closedAt: now, exitPrice, realizedPnl: pnl, unrealizedPnl: pnl, exitReason: reason };
  lighterPositions.set(pos.id, closed);
  saveQuantPosition(closed);
  const ctx = positionContext.get(pos.id);
  saveQuantTrade({
    id: pos.id, pair: pos.pair, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice, size: pos.size, leverage: pos.leverage,
    pnl, fees, mode: "live", exchange: "lighter", status: "closed",
    exitReason: reason, indicatorsAtEntry: ctx?.indicatorsAtEntry,
    createdAt: pos.openedAt, updatedAt: now,
    tradeType: pos.tradeType ?? "directional",
  });
  positionContext.delete(pos.id);
  void notifyQuantTradeExit({
    pair: pos.pair, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice, size: pos.size,
    pnl, exitReason: reason, tradeType: pos.tradeType ?? "directional",
    positionMode: "live",
  });
  console.log(`[Lighter Executor] CLOSE ${pos.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${reason}) @ ${exitPrice}`);
}

async function reconcileLighter(): Promise<void> {
  try {
    const exchangePositions = await getLighterOpenPositions();
    const exchangeByPair = new Map<string, number>();
    for (const ep of exchangePositions) {
      exchangeByPair.set(ep.symbol, (exchangeByPair.get(ep.symbol) ?? 0) + ep.size);
    }
    const tracked = getLighterLivePositions();

    // DB size per pair (sum of all engines)
    const dbByPair = new Map<string, { totalSize: number; positions: QuantPosition[] }>();
    for (const pos of tracked) {
      const entry = dbByPair.get(pos.pair) ?? { totalSize: 0, positions: [] };
      entry.totalSize += pos.size * pos.leverage / pos.entryPrice;
      entry.positions.push(pos);
      dbByPair.set(pos.pair, entry);
    }

    // Phantom check: pair gone from exchange entirely
    for (const pos of tracked) {
      if (closingSet.has(pos.id)) continue;
      if (exchangeByPair.has(pos.pair)) continue;
      await new Promise(r => setTimeout(r, 2000));
      const recheck = await getLighterOpenPositions();
      if (recheck.find(p => p.symbol === pos.pair)) continue;

      console.error(`[Lighter Executor] PHANTOM: ${pos.pair} gone from exchange`);
      await closePhantom(pos);
    }

    // Partial phantom: pair exists but exchange size < DB size (some engines' positions were closed)
    for (const [pair, db] of dbByPair) {
      const exchSize = exchangeByPair.get(pair) ?? 0;
      if (exchSize <= 0 || db.positions.length <= 1) continue;
      // If exchange size is significantly less than DB size, close excess DB positions (oldest first)
      const tolerance = exchSize * 0.1;
      if (db.totalSize <= exchSize + tolerance) continue;

      const recheck = await getLighterOpenPositions();
      const recheckMatch = recheck.find(p => p.symbol === pair);
      if (!recheckMatch) continue;
      const recheckSize = recheckMatch.size;

      let remainingExchSize = recheckSize;
      const sorted = [...db.positions].sort((a, b) => (a.openedAt ?? "").localeCompare(b.openedAt ?? ""));
      for (const pos of sorted) {
        const posSizeCoins = pos.size * pos.leverage / pos.entryPrice;
        if (remainingExchSize >= posSizeCoins * 0.9) {
          remainingExchSize -= posSizeCoins;
        } else {
          if (closingSet.has(pos.id)) continue;
          console.error(`[Lighter Executor] PARTIAL PHANTOM: ${pos.pair} ${pos.tradeType} — exchange size reduced`);
          await closePhantom(pos);
        }
      }
    }

    // Orphan check: on exchange but not in DB
    const trackedPairs = new Set(tracked.map(p => p.pair));
    for (const ep of exchangePositions) {
      if (trackedPairs.has(ep.symbol) || openingPairs.has(ep.symbol)) continue;
      console.error(`[Lighter Executor] ORPHAN: ${ep.symbol} on exchange but not in DB`);
      void notifyCriticalError(`ORPHAN: ${ep.symbol} on Lighter exchange but not in DB — manual close needed`, "LighterReconciliation");
    }

    if (exchangePositions.length > 0 || tracked.length > 0) {
      console.log(`[Lighter Executor] Reconcile: ${exchangePositions.length} exchange, ${tracked.length} DB`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Reconciliation failed: ${msg}`);
  }
}

export function getLighterLivePositions(): QuantPosition[] {
  return Array.from(lighterPositions.values()).filter(p => p.status === "open");
}

function getOrderError(result: [any, any, string | null]): string | null {
  if (result[2]) return result[2];
  const resp = result[1];
  if (resp && resp.code !== 0 && resp.code !== 200) {
    return resp.message ?? `code ${resp.code}`;
  }
  return null;
}

export async function lighterOpenPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  stopLoss: number,
  takeProfit: number,
  tradeType: TradeType = "directional",
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
  allowMultiple = false,
  skipExchangeOrders = false,
): Promise<QuantPosition | null> {
  if (openingPairs.has(pair)) {
    console.log(`[Lighter Executor] Open already in progress for ${pair}`);
    return null;
  }

  if (!allowMultiple) {
    const existingLighter = getLighterLivePositions().find(p => p.pair === pair && p.tradeType === tradeType);
    if (existingLighter) {
      console.log(`[Lighter Executor] ${pair} already open for ${tradeType}, skipping`);
      return null;
    }
  }

  openingPairs.add(pair);

  try {
    try { // margin check
      const acctInfo = await getLighterAccountInfo();
      const availableMargin = acctInfo.equity - acctInfo.marginUsed;
      if (availableMargin < sizeUsd) {
        console.log(`[Lighter Executor] ${pair} skipped: insufficient margin ($${availableMargin.toFixed(2)} available, need $${sizeUsd})`);
        return null;
      }
    } catch (marginErr) {
      console.error(`[Lighter Executor] Margin check failed: ${marginErr instanceof Error ? marginErr.message : marginErr}`);
      return null;
    }

    const currentPrice = await withTimeout(getLighterMidPrice(pair), API_PRICE_TIMEOUT_MS, "Lighter midPrice");
    if (!currentPrice) {
      console.error(`[Lighter Executor] No price for ${pair}`);
      return null;
    }

    const marketIndex = await withTimeout(getMarketIndex(pair), API_PRICE_TIMEOUT_MS, "Lighter marketIndex");
    if (marketIndex === null) {
      console.error(`[Lighter Executor] No market index for ${pair}`);
      return null;
    }

    const sizeDecimals = await getMarketSizeDecimals(marketIndex);
    const priceDecimals = await getMarketPriceDecimals(marketIndex);
    const notional = sizeUsd * leverage;
    const sizeInCoins = notional / currentPrice;
    const baseAmount = toBaseUnits(sizeInCoins, sizeDecimals);

    const isBuy = direction === "long";
    const slippagePrice = isBuy ? currentPrice * 1.05 : currentPrice * 0.95;
    const priceBaseUnits = toPriceUnits(slippagePrice, priceDecimals);

    if (baseAmount <= 0) {
      console.error(`[Lighter Executor] Size rounds to 0 for ${pair}`);
      return null;
    }

    const client = getSignerClient();

    const maxLev = await getLighterMaxLeverage(pair);
    if (leverage > maxLev) {
      console.log(`[Lighter Executor] ${pair} leverage clamped ${leverage}x -> ${maxLev}x (exchange max)`);
      leverage = maxLev;
    }

    try { // set leverage
      await withNonce(async (nonce) =>
        withTimeout(client.update_leverage(marketIndex, SignerClient.ISOLATED_MARGIN_MODE, leverage, nonce), API_ORDER_TIMEOUT_MS, "Lighter updateLeverage"),
      );
      console.log(`[Lighter Executor] ${pair} leverage ${leverage}x`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Lighter Executor] Leverage failed for ${pair}: ${msg}`);
      if (err instanceof TimeoutError) resetNonce();
      return null;
    }

    console.log(`[Lighter Executor] Placing ${direction} ${pair} $${sizeUsd}x${leverage}`);

    const orderResult = await withNonce(async (nonce) =>
      withTimeout(
        client.create_market_order(
          marketIndex, Date.now() % 1_000_000_000, baseAmount,
          priceBaseUnits, !isBuy, false, nonce,
        ),
        API_ORDER_TIMEOUT_MS, "Lighter marketOpen",
      ),
    );

    const orderErr = getOrderError(orderResult);
    if (orderErr) {
      console.error(`[Lighter Executor] Order failed for ${pair}: ${orderErr}`);
      if (orderErr.includes("nonce") || orderErr.includes("ratelimit") || orderErr.includes("Too Many")) resetNonce();
      const isMarginErr = orderErr.toLowerCase().includes("margin") || orderErr.toLowerCase().includes("insufficient");
      if (!isMarginErr) {
        void notifyCriticalError(`Lighter order failed: ${pair} ${direction} $${sizeUsd} — ${orderErr}`, "LighterExecutor");
      }
      return null;
    }

    let filledPos: { size: number; entryPrice: number } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const exchangePositions = await getLighterOpenPositions();
        const match = exchangePositions.find(p => p.symbol === pair);
        if (match) {
          filledPos = match;
          break;
        }
      } catch (checkErr) {
        console.error(`[Lighter Executor] Fill check failed for ${pair}: ${checkErr instanceof Error ? checkErr.message : checkErr}`);
      }
    }
    if (!filledPos) {
      console.error(`[Lighter Executor] Order not filled for ${pair} — cancelled by exchange`);
      void notifyCriticalError(`Lighter fill unverified: ${pair} ${direction} — check exchange for orphan`, "LighterExecutor");
      return null;
    }

    const fillPrice = filledPos.entryPrice > 0 ? filledPos.entryPrice : currentPrice;
    const actualNotional = filledPos.size * fillPrice;

    const filledBaseAmount = toBaseUnits(filledPos.size, sizeDecimals);
    if (actualNotional < 5) {
      console.error(`[Lighter Executor] ${pair} partial fill too small: $${actualNotional.toFixed(2)} notional, closing`);
      try {
        await withNonce(async (nonce) =>
          withTimeout(
            client.create_market_order(
              marketIndex, Date.now() % 1_000_000_000, filledBaseAmount,
              toPriceUnits(isBuy ? currentPrice * 0.95 : currentPrice * 1.05, priceDecimals),
              isBuy, true, nonce,
            ),
            API_ORDER_TIMEOUT_MS, "Lighter autoClose",
          ),
        );
        console.log(`[Lighter Executor] Tiny partial fill closed for ${pair}`);
      } catch (closeErr) {
        if (closeErr instanceof TimeoutError) resetNonce();
        void notifyCriticalError(`Tiny partial fill ${pair} ($${actualNotional.toFixed(2)}) — close failed`, "LighterExecutor");
      }
      return null;
    }

    const actualSizeUsd = actualNotional / leverage;
    if (Math.abs(actualSizeUsd - sizeUsd) > 0.5) {
      console.log(`[Lighter Executor] ${pair} partial fill: requested $${sizeUsd} got $${actualSizeUsd.toFixed(2)}`);
    }

    let adjStop = stopLoss;
    let adjTP = takeProfit;
    if (aiEntryPrice && aiEntryPrice > 0) {
      const rebased = rebaseStops(stopLoss, takeProfit, aiEntryPrice, fillPrice);
      adjStop = rebased.stopLoss;
      adjTP = rebased.takeProfit;
    }

    const position: QuantPosition = {
      id: generateQuantId(),
      pair,
      direction,
      entryPrice: fillPrice,
      size: actualSizeUsd,
      leverage,
      stopLoss: adjStop,
      takeProfit: adjTP,
      unrealizedPnl: 0,
      mode: "live",
      exchange: "lighter",
      status: "open",
      openedAt: new Date().toISOString(),
      closedAt: undefined,
      exitPrice: undefined,
      realizedPnl: undefined,
      exitReason: undefined,
      tradeType,
    };

    try {
      saveQuantPosition(position);
    } catch (dbErr) {
      const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error(`[Lighter Executor] DB WRITE FAILED for ${pair}: ${dbMsg}`);
      try { // close orphan
        await withNonce(async (nonce) =>
          withTimeout(
            client.create_market_order(
              marketIndex, Date.now() % 1_000_000_000, filledBaseAmount,
              toPriceUnits(isBuy ? currentPrice * 0.95 : currentPrice * 1.05, priceDecimals),
              isBuy, true, nonce,
            ),
            API_ORDER_TIMEOUT_MS, "Lighter autoClose",
          ),
        );
        console.log(`[Lighter Executor] Auto-closed orphan ${pair} after DB failure`);
      } catch (closeErr) {
        if (closeErr instanceof TimeoutError) resetNonce();
        void notifyCriticalError(`Lighter DB write failed + auto-close failed: ${pair} — ORPHAN on exchange. Manual close required.`, "LighterExecutor");
      }
      return null;
    }
    lighterPositions.set(position.id, position);
    positionContext.set(position.id, { indicatorsAtEntry });

    void notifyQuantTradeEntry({
      pair, direction, size: actualSizeUsd, entryPrice: fillPrice,
      leverage, tradeType, stopLoss: adjStop, takeProfit: adjTP,
      positionMode: "live",
    });

    console.log(`[Lighter Executor] OPEN ${direction.toUpperCase()} ${pair} $${actualSizeUsd.toFixed(2)}x${leverage} @ ${fillPrice}`);
    if (!skipExchangeOrders) {
      await placeExchangeStop(position);
      await placeExchangeTP(position);
    }
    return position;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Open failed for ${pair}: ${msg}`);
    void notifyCriticalError(`Lighter open error: ${pair} ${direction} $${sizeUsd} — ${msg}`, "LighterExecutor");

    if (err instanceof TimeoutError) resetNonce();

    try { // orphan check
      const exchangePositions = await getLighterOpenPositions();
      const orphan = exchangePositions.find(p => p.symbol === pair);
      if (orphan) {
        console.error(`[Lighter Executor] ORPHAN DETECTED: ${pair} ${orphan.side} on exchange after failed open`);
        void notifyCriticalError(`LIGHTER ORPHAN: ${pair} ${orphan.side} exists on exchange but not tracked. Manual close required.`, "LighterExecutor");
      }
    } catch (checkErr) {
      const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
      console.error(`[Lighter Executor] Orphan check failed: ${checkMsg}`);
    }

    return null;
  } finally {
    openingPairs.delete(pair);
  }
}

export async function lighterClosePosition(
  positionId: string,
  reason: string,
  skipCancelReplace = false,
): Promise<{ success: boolean; pnl: number }> {
  if (closingSet.has(positionId)) {
    console.log(`[Lighter Executor] Close already in progress for ${positionId}`);
    return { success: false, pnl: 0 };
  }

  const position = lighterPositions.get(positionId);
  if (!position || position.status !== "open") {
    console.error(`[Lighter Executor] Position ${positionId} not found or closed`);
    return { success: false, pnl: 0 };
  }

  closingSet.add(positionId);

  try {
    const exitPrice = await withTimeout(getLighterMidPrice(position.pair), API_PRICE_TIMEOUT_MS, "Lighter midPrice");
    if (!exitPrice) {
      console.error(`[Lighter Executor] No price for ${position.pair}`);
      return { success: false, pnl: 0 };
    }

    const marketIndex = await withTimeout(getMarketIndex(position.pair), API_PRICE_TIMEOUT_MS, "Lighter marketIndex");
    if (marketIndex === null) {
      console.error(`[Lighter Executor] No market index for ${position.pair}`);
      return { success: false, pnl: 0 };
    }

    const sizeDecimals = await getMarketSizeDecimals(marketIndex);
    const priceDecimals = await getMarketPriceDecimals(marketIndex);
    const notional = position.size * position.leverage;
    const sizeInCoins = notional / position.entryPrice;
    const baseAmount = toBaseUnits(sizeInCoins, sizeDecimals);

    const isAsk = position.direction === "long";
    const slippageExitPrice = isAsk ? exitPrice * 0.95 : exitPrice * 1.05;
    const exitPriceBase = toPriceUnits(slippageExitPrice, priceDecimals);

    const client = getSignerClient();

    // Other engines' open positions on same pair (exclude this one and any concurrently closing)
    const otherSamePair = getLighterLivePositions().filter(p => p.pair === position.pair && p.id !== positionId && !closingSet.has(p.id));
    const expectedRemainingCoins = otherSamePair.reduce((sum, p) => sum + (p.size * p.leverage) / p.entryPrice, 0);

    console.log(`[Lighter Executor] Closing ${position.pair} ${position.direction} (${reason})`);
    if (!skipCancelReplace) {
      await cancelAndReplaceOrders(positionId);
    }

    const closeResult = await withNonce(async (nonce) =>
      withTimeout(
        client.create_market_order(
          marketIndex, Date.now() % 1_000_000_000, baseAmount,
          exitPriceBase, isAsk, true, nonce,
        ),
        API_ORDER_TIMEOUT_MS, "Lighter marketClose",
      ),
    );

    const closeErr = getOrderError(closeResult);
    if (closeErr) {
      console.error(`[Lighter Executor] Close failed for ${position.pair}: ${closeErr}`);
      if (closeErr.includes("nonce") || closeErr.includes("ratelimit") || closeErr.includes("Too Many")) resetNonce();
      void notifyCriticalError(`Lighter close failed: ${position.pair} ${position.direction} — ${closeErr}`, "LighterExecutor");
      void placeExchangeStop(position);
      void placeExchangeTP(position);
      return { success: false, pnl: 0 };
    }

    let closeFilled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const postClosePositions = await getLighterOpenPositions();
        const postCloseEntry = postClosePositions.find(p => p.symbol === position.pair);
        if (!postCloseEntry) {
          // Pair completely gone from exchange
          closeFilled = true;
          break;
        }
        // Pair still exists — success if remaining size matches other engines' expected size (multi-engine same-pair)
        if (otherSamePair.length > 0) {
          const remainingSize = postCloseEntry.size;
          const tolerance = 0.2;
          if (Math.abs(remainingSize - expectedRemainingCoins) / Math.max(expectedRemainingCoins, 0.001) < tolerance) {
            closeFilled = true;
            break;
          }
        }
      } catch (verifyErr) {
        console.error(`[Lighter Executor] Close verify failed: ${verifyErr instanceof Error ? verifyErr.message : verifyErr}`);
      }
    }
    if (!closeFilled) {
      console.error(`[Lighter Executor] Close not filled for ${position.pair} — still open on exchange`);
      void notifyCriticalError(`Lighter close not filled: ${position.pair} still open`, "LighterExecutor");
      void placeExchangeStop(position);
      void placeExchangeTP(position);
      return { success: false, pnl: 0 };
    }
    const fees = 0; // Lighter: zero fees
    const pnl = calcPnl(position.direction, position.entryPrice, exitPrice, position.size, position.leverage, fees);

    const now = new Date().toISOString();
    const closedPosition: QuantPosition = {
      ...position,
      status: "closed",
      closedAt: now,
      exitPrice,
      realizedPnl: pnl,
      unrealizedPnl: pnl,
      exitReason: reason,
    };

    lighterPositions.set(positionId, closedPosition);
    saveQuantPosition(closedPosition);

    const ctx = positionContext.get(positionId);
    saveQuantTrade({
      id: position.id,
      pair: position.pair,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      leverage: position.leverage,
      pnl,
      fees,
      mode: "live",
      exchange: "lighter",
      status: "closed",
      exitReason: reason,
      indicatorsAtEntry: ctx?.indicatorsAtEntry,
      createdAt: position.openedAt,
      updatedAt: now,
      tradeType: position.tradeType ?? "directional",
    });
    positionContext.delete(positionId);

    if (reason === "stop-loss" && shouldRecordSlCooldown(position.tradeType ?? "directional")) {
      recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
    }

    void notifyQuantTradeExit({
      pair: position.pair, direction: position.direction,
      entryPrice: position.entryPrice, exitPrice, size: position.size,
      pnl, exitReason: reason, tradeType: position.tradeType ?? "directional",
      positionMode: "live",
    });

    console.log(`[Lighter Executor] CLOSE ${position.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${reason}) @ ${exitPrice}`);
    return { success: true, pnl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Close failed for ${position.pair}: ${msg}`);

    if (err instanceof TimeoutError) {
      resetNonce();
      try {
        const exchangePositions = await getLighterOpenPositions();
        const postEntry = exchangePositions.find(p => p.symbol === position.pair);
        const otherSamePairTimeout = getLighterLivePositions().filter(p => p.pair === position.pair && p.id !== positionId && !closingSet.has(p.id));
        const expectedRemainingTimeout = otherSamePairTimeout.reduce((sum, p) => sum + (p.size * p.leverage) / p.entryPrice, 0);
        const timeoutClosed = !postEntry || (otherSamePairTimeout.length > 0 && Math.abs((postEntry.size) - expectedRemainingTimeout) / Math.max(expectedRemainingTimeout, 0.001) < 0.2);
        if (timeoutClosed) {
          console.log(`[Lighter Executor] ${position.pair} closed on exchange despite timeout`);
          const now = new Date().toISOString();
          const exitReason = `${reason} (timeout-reconciled)`;
          const reconPrice = await getLighterMidPrice(position.pair).catch(() => null) ?? position.entryPrice;
          const fees = 0; // Lighter: zero fees
          const estPnl = calcPnl(position.direction, position.entryPrice, reconPrice, position.size, position.leverage, fees);
          const reconciled: QuantPosition = {
            ...position,
            status: "closed",
            closedAt: now,
            exitPrice: reconPrice,
            realizedPnl: estPnl,
            unrealizedPnl: estPnl,
            exitReason,
          };
          lighterPositions.set(positionId, reconciled);
          saveQuantPosition(reconciled);
          const ctx = positionContext.get(positionId);
          saveQuantTrade({
            id: position.id,
            pair: position.pair,
            direction: position.direction,
            entryPrice: position.entryPrice,
            exitPrice: reconPrice,
            size: position.size,
            leverage: position.leverage,
            pnl: estPnl,
            fees,
            mode: "live",
            exchange: "lighter",
            status: "closed",
            exitReason,
            indicatorsAtEntry: ctx?.indicatorsAtEntry,
            createdAt: position.openedAt,
            updatedAt: now,
            tradeType: position.tradeType ?? "directional",
          });
          positionContext.delete(positionId);
          if (reason === "stop-loss" && shouldRecordSlCooldown(position.tradeType ?? "directional")) {
            recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
          }
          void notifyQuantTradeExit({
            pair: position.pair, direction: position.direction,
            entryPrice: position.entryPrice, exitPrice: reconPrice, size: position.size,
            pnl: estPnl, exitReason, tradeType: position.tradeType ?? "directional",
            positionMode: "live",
          });
          console.log(`[Lighter Executor] CLOSE ${position.pair} pnl=${estPnl >= 0 ? "+" : ""}$${estPnl.toFixed(2)} (${exitReason}) @ ${reconPrice}`);
                return { success: true, pnl: estPnl };
        }
      } catch (checkErr) {
        const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
        console.error(`[Lighter Executor] Post-close check failed: ${checkMsg}`);
      }
    }

    void placeExchangeStop(position);
    void placeExchangeTP(position);
    return { success: false, pnl: 0 };
  } finally {
    closingSet.delete(positionId);
  }
}
