import { ensureConnected, getClient, resetConnection } from "./client.js";
import { loadEnv } from "../../config/env.js";
import type { QuantPosition, TradeType } from "./types.js";
import {
  generateQuantId,
  saveQuantPosition,
  saveQuantTrade,
  loadOpenQuantPositions,
} from "../database/quant.js";
import { notifyQuantTradeEntry, notifyQuantTradeExit, notifyCriticalError } from "../telegram/notifications.js";
import { recordStopLossCooldown } from "./scheduler.js";
import { withTimeout, TimeoutError } from "../../utils/timeout.js";
import { API_ORDER_TIMEOUT_MS, API_PRICE_TIMEOUT_MS } from "../../config/constants.js";

const MAX_SLIPPAGE = 0.005;

const livePositions = new Map<string, QuantPosition>();
const positionContext = new Map<string, {
  aiConfidence?: number;
  aiReasoning?: string;
  indicatorsAtEntry?: string;
}>();
const closingSet = new Set<string>();
const openingPairs = new Set<string>();
const exchangeStopOids = new Map<string, number>();

let szDecimalsMap: Map<string, number> | null = null;
let maxLeverageMap: Map<string, number> | null = null;
let metaFetchedAt = 0;
const META_TTL_MS = 60 * 60 * 1000;

async function fetchMeta(): Promise<void> {
  if (szDecimalsMap && maxLeverageMap && Date.now() - metaFetchedAt < META_TTL_MS) return;
  const sdk = getClient();
  const meta = await sdk.info.perpetuals.getMeta(true);
  szDecimalsMap = new Map<string, number>();
  maxLeverageMap = new Map<string, number>();
  for (const asset of meta.universe) {
    szDecimalsMap.set(asset.name, asset.szDecimals);
    maxLeverageMap.set(asset.name, asset.maxLeverage);
  }
  metaFetchedAt = Date.now();
  console.log(`[Quant Live] Loaded meta for ${szDecimalsMap.size} pairs`);
}

async function getSzDecimals(): Promise<Map<string, number>> {
  await fetchMeta();
  return szDecimalsMap!;
}

function getMaxLeverage(pair: string): number {
  return maxLeverageMap?.get(pair) ?? 100;
}

function roundSize(size: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(size * factor) / factor;
}

async function placeExchangeStop(position: QuantPosition): Promise<void> {
  if (!position.stopLoss || !isFinite(position.stopLoss)) return;
  try {
    await ensureConnected();
    const sdk = getClient();
    const szMap = await getSzDecimals();
    const decimals = szMap.get(position.pair);
    if (decimals === undefined) return;
    const notional = position.size * position.leverage;
    const sizeInCoins = roundSize(notional / position.entryPrice, decimals);
    if (sizeInCoins <= 0) return;
    const result = await withTimeout(
      sdk.exchange.placeOrder({
        coin: `${position.pair}-PERP`,
        is_buy: position.direction === "short",
        sz: sizeInCoins,
        limit_px: position.stopLoss,
        order_type: { trigger: { triggerPx: position.stopLoss, isMarket: true, tpsl: "sl" } },
        reduce_only: true,
      }),
      API_ORDER_TIMEOUT_MS, "HL placeExchangeStop",
    );
    const statuses = result?.response?.data?.statuses;
    if (statuses?.[0]?.resting) {
      exchangeStopOids.set(position.id, statuses[0].resting.oid);
      console.log(`[Quant Live] Exchange stop placed for ${position.pair} @ ${position.stopLoss}`);
    } else {
      console.error(`[Quant Live] Exchange stop not resting for ${position.pair}: ${JSON.stringify(statuses)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Exchange stop failed for ${position.pair}: ${msg}`);
  }
}

async function cancelExchangeStop(positionId: string, pair: string): Promise<void> {
  const oid = exchangeStopOids.get(positionId);
  if (!oid) return;
  try {
    const sdk = getClient();
    await sdk.exchange.cancelOrder({ coin: `${pair}-PERP`, o: oid });
    console.log(`[Quant Live] Exchange stop cancelled for ${pair}`);
  } catch {
    // best effort
  }
  exchangeStopOids.delete(positionId);
}

export function initLiveEngine(): void {
  livePositions.clear();
  szDecimalsMap = null;
  const allOpen = loadOpenQuantPositions();
  const liveOnly = allOpen.filter(p => p.mode === "live" && p.exchange !== "lighter");
  for (const pos of liveOnly) {
    livePositions.set(pos.id, pos);
  }
  console.log(`[Quant Live] Init: ${liveOnly.length} live positions restored from DB`);
  setTimeout(async () => { // re-place stops
    for (const pos of getLivePositions()) {
      if (pos.stopLoss && isFinite(pos.stopLoss)) {
        await placeExchangeStop(pos);
      }
    }
  }, 15_000);
  setTimeout(() => void reconcileWithExchange(), 30_000);
  setInterval(() => void reconcileWithExchange(), 5 * 60 * 1000);
}

async function reconcileWithExchange(): Promise<void> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const env = loadEnv();
    const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
    if (!wallet) return;

    const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
    const exchangePositions = state.assetPositions
      .filter((ap: any) => parseFloat(ap.position.szi) !== 0);
    const exchangeCoins = new Set(exchangePositions.map((ap: any) => ap.position.coin as string));

    const trackedPairs = new Set(getLivePositions().map(p => p.pair));

    for (const coin of exchangeCoins) { // orphan check
      if (!trackedPairs.has(coin) && !openingPairs.has(coin)) {
        console.error(`[Quant Live] ORPHAN: ${coin} on exchange but not in DB, auto-closing`);
        try {
          await sdk.custom.marketClose(coin, undefined, undefined, MAX_SLIPPAGE);
          console.log(`[Quant Live] Orphan ${coin} closed`);
        } catch (closeErr) {
          const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
          console.error(`[Quant Live] ORPHAN CLOSE FAILED: ${coin}: ${closeMsg}`);
          void notifyCriticalError(`ORPHAN CLOSE FAILED: ${coin} still open on exchange`, "Reconciliation");
        }
      }
    }

    const trackedLive = getLivePositions(); // phantom check
    for (const pos of trackedLive) {
      if (exchangeCoins.has(pos.pair) || closingSet.has(pos.id)) continue;
      await new Promise(r => setTimeout(r, 2000));
      const recheck = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
      const recheckCoins = new Set(recheck.assetPositions.filter((ap: any) => parseFloat(ap.position.szi) !== 0).map((ap: any) => ap.position.coin as string));
      if (recheckCoins.has(pos.pair)) continue;

      console.error(`[Quant Live] PHANTOM: ${pos.pair} in DB but not on exchange, marking closed`);
      const mids = (await sdk.info.getAllMids(true)) as Record<string, string>;
      const exitPrice = parseFloat(mids[pos.pair] ?? "0") || pos.entryPrice;
      const notional = pos.size * pos.leverage;
      const rawPnl = pos.direction === "long"
        ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * notional
        : ((pos.entryPrice - exitPrice) / pos.entryPrice) * notional;
      const fees = notional * 0.00045 * 2;
      const pnl = rawPnl - fees;
      const now = new Date().toISOString();

      const closedPosition: QuantPosition = {
        ...pos,
        status: "closed",
        closedAt: now,
        exitPrice,
        realizedPnl: pnl,
        exitReason: "reconciliation",
      };
      livePositions.set(pos.id, closedPosition);
      saveQuantPosition(closedPosition);
      const ctx = positionContext.get(pos.id);
      saveQuantTrade({
        id: pos.id, pair: pos.pair, direction: pos.direction,
        entryPrice: pos.entryPrice, exitPrice, size: pos.size, leverage: pos.leverage,
        pnl, fees, mode: "live", status: "closed",
        aiConfidence: ctx?.aiConfidence, aiReasoning: ctx?.aiReasoning,
        exitReason: "reconciliation", indicatorsAtEntry: ctx?.indicatorsAtEntry,
        createdAt: pos.openedAt, updatedAt: now,
        tradeType: pos.tradeType ?? "ai-directional", aiAgreed: pos.aiAgreed,
      });
      positionContext.delete(pos.id);
      await cancelExchangeStop(pos.id, pos.pair);
      void notifyCriticalError(`PHANTOM closed: ${pos.pair} ${pos.direction} — est P&L $${pnl.toFixed(2)}`, "Reconciliation");
      void notifyQuantTradeExit({
        pair: pos.pair, direction: pos.direction,
        entryPrice: pos.entryPrice, exitPrice, size: pos.size,
        pnl, exitReason: "reconciliation", tradeType: pos.tradeType ?? "ai-directional",
        positionMode: "live",
      });
      console.log(`[Quant Live] CLOSE ${pos.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (reconciliation) @ ${exitPrice}`);
    }

    if (exchangeCoins.size > 0 || trackedPairs.size > 0) {
      console.log(`[Quant Live] Reconcile: ${exchangeCoins.size} exchange, ${trackedPairs.size} DB`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Reconciliation failed: ${msg}`);
  }
}

export function getLivePositions(): QuantPosition[] {
  return Array.from(livePositions.values()).filter(p => p.status === "open");
}

async function setLeverage(pair: string, leverage: number): Promise<boolean> {
  try {
    await ensureConnected();
    const sdk = getClient();
    await withTimeout(
      sdk.exchange.updateLeverage(`${pair}-PERP`, "isolated", leverage),
      API_ORDER_TIMEOUT_MS, "HL updateLeverage",
    );
    console.log(`[Quant Live] Set ${pair} leverage to ${leverage}x isolated`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Failed to set leverage for ${pair}: ${msg}`);
    return false;
  }
}

export async function liveOpenPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  stopLoss: number,
  takeProfit: number,
  tradeType: TradeType = "ai-directional",
  aiConfidence?: number,
  aiReasoning?: string,
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
  aiAgreed?: boolean | null,
): Promise<QuantPosition | null> {
  if (openingPairs.has(pair)) {
    console.log(`[Quant Live] Open already in progress for ${pair}, skipping`);
    return null;
  }
  openingPairs.add(pair);
  try {
    await ensureConnected();
    const sdk = getClient();

    try { // margin check
      const env = loadEnv();
      const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
      if (wallet) {
        const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
        const equity = parseFloat(state.marginSummary.accountValue);
        const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
        const availableMargin = equity - marginUsed;
        if (availableMargin < sizeUsd) {
          console.log(`[Quant Live] ${pair} skipped: insufficient margin ($${availableMargin.toFixed(2)} available, need $${sizeUsd})`);
          return null;
        }
      }
    } catch (marginErr) {
      console.error(`[Quant Live] Margin check failed for ${pair}: ${marginErr instanceof Error ? marginErr.message : marginErr}`);
      return null;
    }

    await fetchMeta();
    const maxLev = getMaxLeverage(pair);
    if (leverage > maxLev) {
      console.log(`[Quant Live] ${pair} leverage clamped ${leverage}x -> ${maxLev}x (exchange max)`);
      leverage = maxLev;
    }

    const levOk = await setLeverage(pair, leverage);
    if (!levOk) {
      console.error(`[Quant Live] Aborting ${pair}: leverage set failed`);
      return null;
    }

    const mids = await withTimeout(
      sdk.info.getAllMids(true) as Promise<Record<string, string>>,
      API_PRICE_TIMEOUT_MS, "HL getAllMids",
    );
    const rawPrice = mids[pair];
    if (!rawPrice) {
      console.error(`[Quant Live] No price for ${pair}`);
      return null;
    }
    const currentPrice = parseFloat(rawPrice);
    if (!isFinite(currentPrice) || currentPrice <= 0) {
      console.error(`[Quant Live] Invalid price for ${pair}: ${rawPrice}`);
      return null;
    }

    const notional = sizeUsd * leverage;
    let sizeInCoins = notional / currentPrice;
    const szMap = await getSzDecimals();
    const decimals = szMap.get(pair);
    if (decimals === undefined) {
      console.error(`[Quant Live] No szDecimals for ${pair}`);
      return null;
    }
    sizeInCoins = roundSize(sizeInCoins, decimals);
    if (sizeInCoins <= 0) {
      console.error(`[Quant Live] Size rounds to 0 for ${pair}`);
      return null;
    }

    const isBuy = direction === "long";
    console.log(`[Quant Live] Placing ${direction} ${pair}: ${sizeInCoins} coins ($${sizeUsd}x${leverage})`);

    const result = await withTimeout(
      sdk.custom.marketOpen(pair, isBuy, sizeInCoins, undefined, MAX_SLIPPAGE),
      API_ORDER_TIMEOUT_MS, "HL marketOpen",
    );

    const statuses = result?.response?.data?.statuses;
    if (!statuses || statuses.length === 0) {
      console.error(`[Quant Live] Order failed for ${pair}: no statuses`);
      console.error(`[Quant Live] Response: ${JSON.stringify(result)}`);
      void notifyCriticalError(`HL order failed: ${pair} ${direction} $${sizeUsd} — no statuses`, "liveOpenPosition");
      return null;
    }

    const status = statuses[0];

    if (status.resting) {
      console.error(`[Quant Live] Order resting for ${pair}, cancelling`);
      try {
        await sdk.exchange.cancelOrder({ coin: `${pair}-PERP`, o: status.resting.oid });
      } catch (e) {
        console.error(`[Quant Live] Cancel failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return null;
    }

    if (!status.filled) {
      const statusStr = JSON.stringify(status);
      const isMarginError = statusStr.includes("Insufficient margin");
      console.error(`[Quant Live] Order rejected for ${pair}: ${statusStr}`);
      if (!isMarginError) {
        void notifyCriticalError(`HL order rejected: ${pair} ${direction} $${sizeUsd} — ${statusStr}`, "liveOpenPosition");
      }
      return null;
    }

    const fillPrice = parseFloat(status.filled.avgPx);
    const fillSize = parseFloat(status.filled.totalSz);

    if (!isFinite(fillPrice) || fillPrice <= 0) {
      console.error(`[Quant Live] Invalid fill price for ${pair}: ${status.filled.avgPx}, closing orphan`);
      try {
        await sdk.custom.marketClose(pair, undefined, undefined, MAX_SLIPPAGE);
        console.log(`[Quant Live] Orphan closed for ${pair} after invalid fill price`);
      } catch (closeErr) {
        const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        console.error(`[Quant Live] ORPHAN CLOSE FAILED after invalid fill: ${pair}: ${closeMsg}`);
        void notifyCriticalError(`ORPHAN after invalid fill price: ${pair} still open on exchange`, "liveOpenPosition");
      }
      return null;
    }

    const actualNotional = fillSize * fillPrice;

    if (actualNotional < 5) { // dust fill, auto-close
      console.error(`[Quant Live] ${pair} partial fill too small: $${actualNotional.toFixed(2)} notional, closing`);
      try {
        await sdk.custom.marketClose(pair, undefined, undefined, MAX_SLIPPAGE);
        console.log(`[Quant Live] Tiny partial fill closed for ${pair}`);
      } catch (closeErr) {
        const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        console.error(`[Quant Live] CLOSE FAILED for tiny fill: ${pair}: ${closeMsg}`);
        void notifyCriticalError(`Tiny partial fill ${pair} ($${actualNotional.toFixed(2)}) — close failed`, "liveOpenPosition");
      }
      return null;
    }

    const actualSizeUsd = actualNotional / leverage;

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
      status: "open",
      openedAt: new Date().toISOString(),
      closedAt: undefined,
      exitPrice: undefined,
      realizedPnl: undefined,
      exitReason: undefined,
      tradeType,
      aiAgreed: aiAgreed !== undefined ? aiAgreed : null,
    };

    if (Math.abs(actualSizeUsd - sizeUsd) > 0.5) {
      console.log(`[Quant Live] ${pair} partial fill: requested $${sizeUsd} got $${actualSizeUsd.toFixed(2)}`);
    }

    try {
      saveQuantPosition(position);
    } catch (dbErr) {
      const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error(`[Quant Live] DB WRITE FAILED for ${pair}: ${dbMsg}`);
      try {
        await sdk.custom.marketClose(pair, undefined, undefined, MAX_SLIPPAGE);
        console.log(`[Quant Live] Auto-closed orphan ${pair} after DB failure`);
      } catch (closeErr) {
        void notifyCriticalError(`DB write failed + auto-close failed: ${pair} — ORPHAN on exchange`, "liveOpenPosition");
      }
      return null;
    }
    livePositions.set(position.id, position);
    positionContext.set(position.id, { aiConfidence, aiReasoning, indicatorsAtEntry });

    void notifyQuantTradeEntry({
      pair, direction, size: actualSizeUsd, entryPrice: fillPrice,
      leverage, tradeType, stopLoss: adjStop, takeProfit: adjTP,
      positionMode: "live",
    });

    console.log(`[Quant Live] OPEN ${direction.toUpperCase()} ${pair} $${actualSizeUsd.toFixed(2)}x${leverage} @ ${fillPrice} (${fillSize} coins)`);
    void placeExchangeStop(position);
    return position;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Open failed for ${pair}: ${msg}`);
    resetConnection();

    const hadTrackedPosition = getLivePositions().some(p => p.pair === pair);
    if (!hadTrackedPosition) {
      try {
        const env = loadEnv();
        const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
        if (wallet) {
          const sdk = getClient();
          await ensureConnected();
          const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
          const orphan = state.assetPositions.find(
            (ap: any) => ap.position.coin === pair && parseFloat(ap.position.szi) !== 0,
          );
          if (orphan) {
            console.error(`[Quant Live] ORPHAN DETECTED: ${pair}, attempting auto-close`);
            try {
              await sdk.custom.marketClose(pair, undefined, undefined, MAX_SLIPPAGE);
              console.log(`[Quant Live] Orphan ${pair} closed successfully`);
            } catch (closeErr) {
              const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
              console.error(`[Quant Live] ORPHAN CLOSE FAILED: ${pair}: ${closeMsg}`);
              void notifyCriticalError(`ORPHAN CLOSE FAILED: ${pair} still open on exchange`, "liveOpenPosition");
            }
          }
        }
      } catch (orphanErr) {
        const orphanMsg = orphanErr instanceof Error ? orphanErr.message : String(orphanErr);
        console.error(`[Quant Live] Orphan check failed for ${pair}: ${orphanMsg}`);
        void notifyCriticalError(`ORPHAN CHECK FAILED: ${pair} may be open on exchange`, "liveOpenPosition");
      }
    }

    return null;
  } finally {
    openingPairs.delete(pair);
  }
}

export async function liveClosePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  if (closingSet.has(positionId)) {
    console.log(`[Quant Live] Close already in progress for ${positionId}`);
    return { success: false, pnl: 0 };
  }

  const position = livePositions.get(positionId);
  if (!position || position.status !== "open") {
    console.error(`[Quant Live] Position ${positionId} not found or closed`);
    return { success: false, pnl: 0 };
  }

  closingSet.add(positionId);

  try {
    await ensureConnected();
    const sdk = getClient();

    console.log(`[Quant Live] Closing ${position.pair} ${position.direction} (${reason})`);
    await cancelExchangeStop(positionId, position.pair);

    const result = await withTimeout(
      sdk.custom.marketClose(position.pair, undefined, undefined, MAX_SLIPPAGE),
      API_ORDER_TIMEOUT_MS, "HL marketClose",
    );

    const statuses = result?.response?.data?.statuses;
    if (!statuses || statuses.length === 0) {
      console.error(`[Quant Live] Close failed for ${position.pair}: no statuses`);
      console.error(`[Quant Live] Response: ${JSON.stringify(result)}`);
      return { success: false, pnl: 0 };
    }

    const status = statuses[0];

    if (status.resting) {
      console.error(`[Quant Live] Close resting for ${position.pair}`);
      try {
        await sdk.exchange.cancelOrder({ coin: `${position.pair}-PERP`, o: status.resting.oid });
      } catch { /* best effort */ }
      return { success: false, pnl: 0 };
    }

    if (!status.filled) {
      console.error(`[Quant Live] Close rejected for ${position.pair}: ${JSON.stringify(status)}`);
      return { success: false, pnl: 0 };
    }

    const exitPrice = parseFloat(status.filled.avgPx);

    if (!isFinite(exitPrice) || exitPrice <= 0) {
      console.error(`[Quant Live] Invalid exit price for ${position.pair}`);
      return { success: false, pnl: 0 };
    }

    const notional = position.size * position.leverage;
    const rawPnl =
      position.direction === "long"
        ? ((exitPrice - position.entryPrice) / position.entryPrice) * notional
        : ((position.entryPrice - exitPrice) / position.entryPrice) * notional;

    const fees = notional * 0.00045 * 2;
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

    livePositions.set(positionId, closedPosition);
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
      status: "closed",
      aiConfidence: ctx?.aiConfidence,
      aiReasoning: ctx?.aiReasoning,
      exitReason: reason,
      indicatorsAtEntry: ctx?.indicatorsAtEntry,
      createdAt: position.openedAt,
      updatedAt: now,
      tradeType: position.tradeType ?? "ai-directional",
      aiAgreed: position.aiAgreed,
    });
    positionContext.delete(positionId);

    if (reason === "stop-loss") {
      recordStopLossCooldown(position.pair, position.direction);
    }

    void notifyQuantTradeExit({
      pair: position.pair, direction: position.direction,
      entryPrice: position.entryPrice, exitPrice, size: position.size,
      pnl, exitReason: reason, tradeType: position.tradeType ?? "ai-directional",
      positionMode: "live",
    });

    console.log(`[Quant Live] CLOSE ${position.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${reason}) @ ${exitPrice}`);
    return { success: true, pnl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Close failed for ${position.pair}: ${msg}`);
    resetConnection();

    if (err instanceof TimeoutError) { // check if close succeeded despite timeout
      try {
        await ensureConnected();
        const sdk2 = getClient();
        const env2 = loadEnv();
        const wallet2 = env2.HYPERLIQUID_WALLET_ADDRESS;
        if (wallet2) {
          const state2 = await sdk2.info.perpetuals.getClearinghouseState(wallet2, true);
          const stillOpen = state2.assetPositions.find(
            (ap: any) => ap.position.coin === position.pair && parseFloat(ap.position.szi) !== 0,
          );
          if (!stillOpen) {
            console.log(`[Quant Live] ${position.pair} closed on exchange despite timeout`);
            const mids = (await sdk2.info.getAllMids(true)) as Record<string, string>;
            const reconPrice = parseFloat(mids[position.pair] ?? "0") || position.entryPrice;
            const notional = position.size * position.leverage;
            const rawPnl = position.direction === "long"
              ? ((reconPrice - position.entryPrice) / position.entryPrice) * notional
              : ((position.entryPrice - reconPrice) / position.entryPrice) * notional;
            const fees = notional * 0.00045 * 2;
            const estPnl = rawPnl - fees;
            const now = new Date().toISOString();
            const exitReason = `${reason} (timeout-reconciled)`;
            const reconciled: QuantPosition = {
              ...position, status: "closed", closedAt: now,
              exitPrice: reconPrice, realizedPnl: estPnl, exitReason,
            };
            livePositions.set(positionId, reconciled);
            saveQuantPosition(reconciled);
            const ctx = positionContext.get(positionId);
            saveQuantTrade({
              id: position.id, pair: position.pair, direction: position.direction,
              entryPrice: position.entryPrice, exitPrice: reconPrice,
              size: position.size, leverage: position.leverage,
              pnl: estPnl, fees, mode: "live", status: "closed",
              aiConfidence: ctx?.aiConfidence, aiReasoning: ctx?.aiReasoning,
              exitReason, indicatorsAtEntry: ctx?.indicatorsAtEntry,
              createdAt: position.openedAt, updatedAt: now,
              tradeType: position.tradeType ?? "ai-directional", aiAgreed: position.aiAgreed,
            });
            positionContext.delete(positionId);
            if (reason === "stop-loss") {
              recordStopLossCooldown(position.pair, position.direction);
            }
            void notifyQuantTradeExit({
              pair: position.pair, direction: position.direction,
              entryPrice: position.entryPrice, exitPrice: reconPrice, size: position.size,
              pnl: estPnl, exitReason, tradeType: position.tradeType ?? "ai-directional",
              positionMode: "live",
            });
            console.log(`[Quant Live] CLOSE ${position.pair} pnl=${estPnl >= 0 ? "+" : ""}$${estPnl.toFixed(2)} (${exitReason}) @ ${reconPrice}`);
            return { success: true, pnl: estPnl };
          }
        }
      } catch (reconErr) {
        console.error(`[Quant Live] Timeout reconciliation failed: ${reconErr instanceof Error ? reconErr.message : reconErr}`);
      }
    }

    return { success: false, pnl: 0 };
  } finally {
    closingSet.delete(positionId);
  }
}

export async function getLiveBalance(): Promise<number> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const env = loadEnv();
    const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
    if (!wallet) return 0;

    const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
    return parseFloat(state.marginSummary.accountValue);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Failed to fetch balance: ${msg}`);
    return 0;
  }
}
