import {
  getSignerClient,
  getMarketIndex,
  getMarketSizeDecimals,
  getMarketPriceDecimals,
  getLighterMidPrice,
  getLighterMaxLeverage,
  getNextNonce,
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

const lighterPositions = new Map<string, QuantPosition>();
const closingSet = new Set<string>();
const openingPairs = new Set<string>();
const exchangeStopPairs = new Set<string>();

const positionContext = new Map<string, {
  indicatorsAtEntry?: string;
}>();

async function placeExchangeStop(position: QuantPosition, force = false): Promise<void> {
  if (!position.stopLoss || !isFinite(position.stopLoss)) return;
  if (!force && exchangeStopPairs.has(position.pair)) return;
  try {
    const marketIndex = await getMarketIndex(position.pair);
    if (marketIndex === null) return;
    const sizeDecimals = await getMarketSizeDecimals(marketIndex);
    const priceDecimals = await getMarketPriceDecimals(marketIndex);
    const notional = position.size * position.leverage;
    const baseAmount = toBaseUnits(notional / position.entryPrice, sizeDecimals);
    if (baseAmount <= 0) return;
    const triggerPrice = toPriceUnits(position.stopLoss, priceDecimals);
    const limitPrice = toPriceUnits( // 5% slippage buffer
      position.direction === "long" ? position.stopLoss * 0.95 : position.stopLoss * 1.05,
      priceDecimals,
    );
    const isAsk = position.direction === "long";
    const nonce = await getNextNonce();
    const [, , err] = await withTimeout(
      getSignerClient().create_sl_order(
        marketIndex, Date.now() % 1_000_000_000, baseAmount,
        triggerPrice, limitPrice, isAsk, true, nonce,
      ),
      API_ORDER_TIMEOUT_MS, "Lighter placeExchangeStop",
    );
    if (err) {
      console.error(`[Lighter Executor] Exchange stop failed for ${position.pair}: ${err}`);
    } else {
      exchangeStopPairs.add(position.pair);
      console.log(`[Lighter Executor] Exchange stop placed for ${position.pair} @ ${position.stopLoss}`);
    }
  } catch (err) {
    if (err instanceof TimeoutError) resetNonce();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Exchange stop error for ${position.pair}: ${msg}`);
  }
}

async function cancelExchangeStop(pair: string): Promise<void> {
  if (!exchangeStopPairs.has(pair)) return;
  try {
    const nonce = await getNextNonce();
    await getSignerClient().cancel_all_orders(0, 0, nonce);
    console.log(`[Lighter Executor] Exchange stop cancelled for ${pair}`);
  } catch (err) {
    if (err instanceof TimeoutError) resetNonce();
  }
  exchangeStopPairs.delete(pair);
}

async function replaceOtherStops(excludePair: string): Promise<void> {
  for (const pos of getLighterLivePositions()) {
    if (pos.pair !== excludePair && exchangeStopPairs.has(pos.pair)) {
      exchangeStopPairs.delete(pos.pair);
      await placeExchangeStop(pos);
    }
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
    try {
      const nonce = await getNextNonce();
      await getSignerClient().cancel_all_orders(0, 0, nonce);
      exchangeStopPairs.clear();
      console.log("[Lighter Executor] Cleared stale stops");
    } catch { /* best effort */ }
    for (const pos of getLighterLivePositions()) {
      if (pos.stopLoss && isFinite(pos.stopLoss)) {
        await placeExchangeStop(pos, true);
      }
    }
  }, 30_000);
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
): Promise<QuantPosition | null> {
  if (openingPairs.has(pair)) {
    console.log(`[Lighter Executor] Open already in progress for ${pair}`);
    return null;
  }

  const existingLighter = getLighterLivePositions().find(p => p.pair === pair);
  if (existingLighter) {
    console.log(`[Lighter Executor] ${pair} already open on Lighter, skipping`);
    return null;
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
      const nonce = await getNextNonce();
      await withTimeout(
        client.update_leverage(marketIndex, SignerClient.ISOLATED_MARGIN_MODE, leverage, nonce),
        API_ORDER_TIMEOUT_MS, "Lighter updateLeverage",
      );
      console.log(`[Lighter Executor] ${pair} leverage ${leverage}x`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Lighter Executor] Leverage failed for ${pair}: ${msg}`);
      if (err instanceof TimeoutError) resetNonce();
      return null;
    }

    console.log(`[Lighter Executor] Placing ${direction} ${pair} $${sizeUsd}x${leverage}`);

    const nonce = await getNextNonce();
    const orderResult = await withTimeout(
      client.create_market_order(
        marketIndex,
        Date.now() % 1_000_000_000,
        baseAmount,
        priceBaseUnits,
        !isBuy, // is_ask: true for sell/short
        false,
        nonce,
      ),
      API_ORDER_TIMEOUT_MS, "Lighter marketOpen",
    );

    const orderErr = getOrderError(orderResult);
    if (orderErr) {
      console.error(`[Lighter Executor] Order failed for ${pair}: ${orderErr}`);
      if (orderErr.includes("nonce")) resetNonce();
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
        const closeNonce = await getNextNonce();
        await withTimeout(
          client.create_market_order(
            marketIndex, Date.now() % 1_000_000_000, filledBaseAmount,
            toPriceUnits(isBuy ? currentPrice * 0.95 : currentPrice * 1.05, priceDecimals),
            isBuy, true, closeNonce,
          ),
          API_ORDER_TIMEOUT_MS, "Lighter autoClose",
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
      const stopPct = (stopLoss - aiEntryPrice) / aiEntryPrice;
      const tpPct = (takeProfit - aiEntryPrice) / aiEntryPrice;
      adjStop = fillPrice * (1 + stopPct);
      adjTP = fillPrice * (1 + tpPct);
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
        const closeNonce = await getNextNonce();
        await withTimeout(
          client.create_market_order(
            marketIndex, Date.now() % 1_000_000_000, filledBaseAmount,
            toPriceUnits(isBuy ? currentPrice * 0.95 : currentPrice * 1.05, priceDecimals),
            isBuy, true, closeNonce,
          ),
          API_ORDER_TIMEOUT_MS, "Lighter autoClose",
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
    void placeExchangeStop(position);
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

    try { // verify position exists before closing
      let existsOnExchange = false;
      for (let check = 0; check < 2; check++) {
        if (check > 0) await new Promise(r => setTimeout(r, 2000));
        const preClosePositions = await getLighterOpenPositions();
        if (preClosePositions.find(p => p.symbol === position.pair)) {
          existsOnExchange = true;
          break;
        }
      }
      if (!existsOnExchange) {
        console.error(`[Lighter Executor] ${position.pair} not found on exchange (2 checks) — phantom`);
        await cancelExchangeStop(position.pair);
        const now = new Date().toISOString();
        const phantom: QuantPosition = { ...position, status: "closed", closedAt: now, realizedPnl: 0, exitReason: "phantom-not-on-exchange" };
        lighterPositions.set(positionId, phantom);
        saveQuantPosition(phantom);
        const ctx = positionContext.get(positionId);
        saveQuantTrade({
          id: position.id, pair: position.pair, direction: position.direction,
          entryPrice: position.entryPrice, exitPrice: position.entryPrice,
          size: position.size, leverage: position.leverage, pnl: 0, fees: 0,
          mode: "live", exchange: "lighter", status: "closed",
          exitReason: "phantom-not-on-exchange", indicatorsAtEntry: ctx?.indicatorsAtEntry,
          createdAt: position.openedAt, updatedAt: now,
          tradeType: position.tradeType ?? "directional",
        });
        positionContext.delete(positionId);
        void notifyCriticalError(`PHANTOM: ${position.pair} ${position.direction} not on Lighter exchange`, "LighterExecutor");
        void notifyQuantTradeExit({
          pair: position.pair, direction: position.direction,
          entryPrice: position.entryPrice, exitPrice: position.entryPrice, size: position.size,
          pnl: 0, exitReason: "phantom-not-on-exchange", tradeType: position.tradeType ?? "directional",
          positionMode: "live",
        });
        console.log(`[Lighter Executor] CLOSE ${position.pair} pnl=$0.00 (phantom-not-on-exchange) @ ${position.entryPrice}`);
        return { success: true, pnl: 0 };
      }
    } catch (checkErr) {
      console.error(`[Lighter Executor] Pre-close check failed: ${checkErr instanceof Error ? checkErr.message : checkErr}`);
    }

    console.log(`[Lighter Executor] Closing ${position.pair} ${position.direction} (${reason})`);
    await cancelExchangeStop(position.pair);

    const nonce = await getNextNonce();
    const closeResult = await withTimeout(
      client.create_market_order(
        marketIndex,
        Date.now() % 1_000_000_000,
        baseAmount,
        exitPriceBase,
        isAsk,
        true, // reduce_only
        nonce,
      ),
      API_ORDER_TIMEOUT_MS, "Lighter marketClose",
    );

    const closeErr = getOrderError(closeResult);
    if (closeErr) {
      console.error(`[Lighter Executor] Close failed for ${position.pair}: ${closeErr}`);
      if (closeErr.includes("nonce")) resetNonce();
      void notifyCriticalError(`Lighter close failed: ${position.pair} ${position.direction} — ${closeErr}`, "LighterExecutor");
      return { success: false, pnl: 0 };
    }

    let closeFilled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const postClosePositions = await getLighterOpenPositions();
        if (!postClosePositions.find(p => p.symbol === position.pair)) {
          closeFilled = true;
          break;
        }
      } catch (verifyErr) {
        console.error(`[Lighter Executor] Close verify failed: ${verifyErr instanceof Error ? verifyErr.message : verifyErr}`);
      }
    }
    if (!closeFilled) {
      console.error(`[Lighter Executor] Close not filled for ${position.pair} — still open on exchange`);
      void notifyCriticalError(`Lighter close not filled: ${position.pair} still open`, "LighterExecutor");
      return { success: false, pnl: 0 };
    }
    const rawPnl =
      position.direction === "long"
        ? ((exitPrice - position.entryPrice) / position.entryPrice) * notional
        : ((position.entryPrice - exitPrice) / position.entryPrice) * notional;
    const fees = 0;
    const pnl = rawPnl - fees;

    const now = new Date().toISOString();
    const closedPosition: QuantPosition = {
      ...position,
      status: "closed",
      closedAt: now,
      exitPrice,
      realizedPnl: pnl,
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

    if (reason === "stop-loss") {
      recordStopLossCooldown(position.pair, position.direction);
    }

    void notifyQuantTradeExit({
      pair: position.pair, direction: position.direction,
      entryPrice: position.entryPrice, exitPrice, size: position.size,
      pnl, exitReason: reason, tradeType: position.tradeType ?? "directional",
      positionMode: "live",
    });

    console.log(`[Lighter Executor] CLOSE ${position.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${reason}) @ ${exitPrice}`);
    void replaceOtherStops(position.pair);
    return { success: true, pnl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter Executor] Close failed for ${position.pair}: ${msg}`);

    if (err instanceof TimeoutError) {
      resetNonce();
      try {
        const exchangePositions = await getLighterOpenPositions();
        const stillOpen = exchangePositions.find(p => p.symbol === position.pair);
        if (!stillOpen) {
          console.log(`[Lighter Executor] ${position.pair} closed on exchange despite timeout`);
          const now = new Date().toISOString();
          const exitReason = `${reason} (timeout-reconciled)`;
          const reconPrice = await getLighterMidPrice(position.pair).catch(() => null) ?? position.entryPrice;
          const notional = position.size * position.leverage;
          const estPnl = position.direction === "long"
            ? ((reconPrice - position.entryPrice) / position.entryPrice) * notional
            : ((position.entryPrice - reconPrice) / position.entryPrice) * notional;
          const reconciled: QuantPosition = {
            ...position,
            status: "closed",
            closedAt: now,
            exitPrice: reconPrice,
            realizedPnl: estPnl,
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
            fees: 0,
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
          if (reason === "stop-loss") {
            recordStopLossCooldown(position.pair, position.direction);
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

    return { success: false, pnl: 0 };
  } finally {
    closingSet.delete(positionId);
  }
}
