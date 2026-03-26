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
import { withTimeout } from "../../utils/timeout.js";
import { API_ORDER_TIMEOUT_MS, API_PRICE_TIMEOUT_MS } from "../../config/constants.js";
import { capStopLoss, calcPnl, inferExitReason, rebaseStops, parseIndicatorsMeta } from "../hyperliquid/quant-utils.js";

const MAX_SLIPPAGE = 0.005;

const livePositions = new Map<string, QuantPosition>();
const positionContext = new Map<string, {
  indicatorsAtEntry?: string;
}>();
const closingSet = new Set<string>();
const openingPairs = new Set<string>();
const exchangeStopOids = new Map<string, number>();
const exchangeTpOids = new Map<string, number>();

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
  return szDecimalsMap ?? new Map<string, number>();
}

function getMaxLeverage(pair: string): number {
  return maxLeverageMap?.get(pair) ?? 100;
}

function roundSize(size: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(size * factor) / factor;
}

function roundPrice(price: number): number {
  if (price === 0 || !isFinite(price)) return 0;
  // Hyperliquid: 5 significant figures, conservative rounding
  const abs = Math.abs(price);
  let decimals: number;
  if (abs < 0.001) decimals = 7;
  else if (abs < 0.01) decimals = 6;
  else if (abs < 0.1) decimals = 5;
  else if (abs < 1) decimals = 4;
  else if (abs < 10) decimals = 3;
  else if (abs < 100) decimals = 2;
  else if (abs < 1000) decimals = 1;
  else decimals = 0;
  const factor = 10 ** decimals;
  return Math.round(price * factor) / factor;
}

async function placeExchangeStop(position: QuantPosition): Promise<void> {
  if (!position.stopLoss || !isFinite(position.stopLoss)) return;
  if (exchangeStopOids.has(position.id)) return;
  try {
    const sl = capStopLoss(position.entryPrice, position.stopLoss, position.direction);
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
        limit_px: roundPrice(sl),
        order_type: { trigger: { triggerPx: roundPrice(sl), isMarket: true, tpsl: "sl" } },
        reduce_only: true,
      }),
      API_ORDER_TIMEOUT_MS, "HL placeExchangeStop",
    );
    const statuses = result?.response?.data?.statuses;
    if (statuses?.[0]?.resting) {
      exchangeStopOids.set(position.id, statuses[0].resting.oid);
      console.log(`[Quant Live] Exchange stop placed for ${position.pair} @ ${sl}`);
    } else {
      console.error(`[Quant Live] Exchange stop not resting for ${position.pair}: ${JSON.stringify(statuses)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Exchange stop failed for ${position.pair}: ${msg}`);
  }
}

async function placeExchangeTP(position: QuantPosition): Promise<void> {
  if (!position.takeProfit || !isFinite(position.takeProfit) || position.takeProfit <= 0) return;
  if (exchangeTpOids.has(position.id)) return;
  try {
    await ensureConnected();
    const sdk = getClient();
    const szMap = await getSzDecimals();
    const decimals = szMap.get(position.pair);
    if (decimals === undefined) return;
    const notional = position.size * position.leverage;
    const sizeInCoins = roundSize(notional / position.entryPrice, decimals);
    if (sizeInCoins <= 0) return;
    const tp = position.takeProfit;
    const result = await withTimeout(
      sdk.exchange.placeOrder({
        coin: `${position.pair}-PERP`,
        is_buy: position.direction === "short",
        sz: sizeInCoins,
        limit_px: roundPrice(tp),
        order_type: { trigger: { triggerPx: roundPrice(tp), isMarket: true, tpsl: "tp" } },
        reduce_only: true,
      }),
      API_ORDER_TIMEOUT_MS, "HL placeExchangeTP",
    );
    const statuses = result?.response?.data?.statuses;
    if (statuses?.[0]?.resting) {
      exchangeTpOids.set(position.id, statuses[0].resting.oid);
      console.log(`[Quant Live] Exchange TP placed for ${position.pair} @ ${tp}`);
    } else {
      console.error(`[Quant Live] Exchange TP not resting for ${position.pair}: ${JSON.stringify(statuses)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Exchange TP failed for ${position.pair}: ${msg}`);
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

async function cancelExchangeTP(positionId: string, pair: string): Promise<void> {
  const oid = exchangeTpOids.get(positionId);
  if (!oid) return;
  try {
    const sdk = getClient();
    await sdk.exchange.cancelOrder({ coin: `${pair}-PERP`, o: oid });
    console.log(`[Quant Live] Exchange TP cancelled for ${pair}`);
  } catch {
    // best effort
  }
  exchangeTpOids.delete(positionId);
}

async function cancelAllExistingStops(): Promise<void> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const wallet = loadEnv().HYPERLIQUID_WALLET_ADDRESS;
    if (!wallet) return;
    const orders: Array<{ coin: string; oid: number; reduceOnly?: boolean }> =
      await sdk.info.getUserOpenOrders(wallet);
    const stops = orders.filter(o => o.reduceOnly);
    if (stops.length === 0) return;
    console.log(`[Quant Live] Cancelling ${stops.length} stale stops/TPs`);
    for (const o of stops) {
      try { await sdk.exchange.cancelOrder({ coin: o.coin, o: o.oid }); } catch { /* best effort */ }
    }
    exchangeStopOids.clear();
    exchangeTpOids.clear();
  } catch (err) {
    console.error(`[Quant Live] Failed to cancel stops: ${err instanceof Error ? err.message : err}`);
  }
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
  setTimeout(async () => {
    await reconcileWithExchange();
    await cancelAllExistingStops();
    for (const pos of getLivePositions()) {
      if (pos.stopLoss && isFinite(pos.stopLoss)) await placeExchangeStop(pos);
      if (pos.takeProfit && isFinite(pos.takeProfit) && pos.takeProfit > 0) await placeExchangeTP(pos);
    }
  }, 15_000);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((ap: any) => parseFloat(ap.position.szi) !== 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exchangeCoins = new Set(exchangePositions.map((ap: any) => ap.position.coin as string));

    const trackedPairs = new Set(getLivePositions().map(p => p.pair));

    for (const coin of exchangeCoins) { // orphan check
      if (!trackedPairs.has(coin) && !openingPairs.has(coin)) {
        // Restore orphan to DB instead of closing (survives redeploys)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ap = exchangePositions.find((p: any) => p.position.coin === coin);
        if (ap) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pos = ap.position as any;
          const szi = parseFloat(pos.szi);
          const entryPx = parseFloat(pos.entryPx);
          const direction = szi > 0 ? "long" as const : "short" as const;
          const size = Math.abs(szi) * entryPx / 10; // approximate $size at 10x
          const restored: QuantPosition = {
            id: generateQuantId(),
            pair: coin,
            direction,
            entryPrice: entryPx,
            size: Math.round(size * 100) / 100,
            leverage: 10,
            stopLoss: direction === "long" ? entryPx * (1 - 0.035) : entryPx * (1 + 0.035),
            takeProfit: direction === "long" ? entryPx * (1 + 0.018) : entryPx * (1 - 0.018),
            mode: "live",
            status: "open",
            openedAt: new Date().toISOString(),
            tradeType: "supertrend-4h",  // Default for orphan restoration (most common live engine)
            unrealizedPnl: 0,
            closedAt: null as any,
            exitPrice: 0,
            realizedPnl: 0,
            exitReason: "",
          };
          livePositions.set(restored.id, restored);
          saveQuantPosition(restored);
          console.log(`[Quant Live] RESTORED orphan ${coin} ${direction} @ ${entryPx}`);
        }
      }
    }

    const trackedLive = getLivePositions(); // phantom check
    for (const pos of trackedLive) {
      if (exchangeCoins.has(pos.pair) || closingSet.has(pos.id)) continue;
      await new Promise(r => setTimeout(r, 2000));
      const recheck = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recheckCoins = new Set(recheck.assetPositions.filter((ap: any) => parseFloat(ap.position.szi) !== 0).map((ap: any) => ap.position.coin as string));
      if (recheckCoins.has(pos.pair)) continue;

      console.log(`[Quant Live] ${pos.pair} in DB but not on exchange, marking closed`);
      // Get actual fill price from recent fills instead of mid-price
      let exitPrice = 0;
      try {
        const fills = await sdk.info.getUserFills(wallet, true);
        const openedMs = new Date(pos.openedAt).getTime();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recentFill = (fills as any[])
          .filter((f: any) => f.coin === pos.pair && f.dir === (pos.direction === "long" ? "Close Long" : "Close Short") && f.time > openedMs)
          .sort((a: any, b: any) => b.time - a.time)[0];
        if (recentFill) exitPrice = parseFloat(recentFill.px);
      } catch { /* fallback to mid-price */ }
      if (!exitPrice || !isFinite(exitPrice)) {
        const mids = (await sdk.info.getAllMids(true)) as Record<string, string>;
        exitPrice = parseFloat(mids[pos.pair] ?? "0") || pos.entryPrice;
      }
      const fees = pos.size * pos.leverage * 0.00045 * 2;
      const pnl = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.leverage, fees);
      const now = new Date().toISOString();

      // Infer whether SL or TP fired based on exit price (0.5% tolerance for slippage)
      const reason = inferExitReason(pos, exitPrice);

      const closedPosition: QuantPosition = {
        ...pos,
        status: "closed",
        closedAt: now,
        exitPrice,
        realizedPnl: pnl,
        unrealizedPnl: pnl,
        exitReason: reason,
      };
      livePositions.set(pos.id, closedPosition);
      saveQuantPosition(closedPosition);
      const ctx = positionContext.get(pos.id);
      const reconIndMeta = parseIndicatorsMeta(ctx?.indicatorsAtEntry ?? pos.indicatorsAtEntry);
      const reconHoldMs = Date.now() - new Date(pos.openedAt).getTime();
      saveQuantTrade({
        id: pos.id, pair: pos.pair, direction: pos.direction,
        entryPrice: pos.entryPrice, exitPrice, size: pos.size, leverage: pos.leverage,
        pnl, fees, mode: "live", status: "closed", exchange: "hyperliquid",
        exitReason: reason, indicatorsAtEntry: ctx?.indicatorsAtEntry,
        createdAt: pos.openedAt, updatedAt: now,
        tradeType: pos.tradeType ?? "directional",
        maxUnrealizedPnlPct: pos.maxUnrealizedPnlPct,
        btcPriceAtEntry: pos.btcPriceAtEntry ?? reconIndMeta.btcPrice,
        equityAtEntry: pos.equityAtEntry ?? reconIndMeta.equity,
        newsSource: reconIndMeta.source,
        eventTimestamp: reconIndMeta.eventTs,
        holdDurationMs: reconHoldMs,
      });
      positionContext.delete(pos.id);
      await cancelExchangeStop(pos.id, pos.pair);
      await cancelExchangeTP(pos.id, pos.pair);
      void notifyQuantTradeExit({
        pair: pos.pair, direction: pos.direction,
        entryPrice: pos.entryPrice, exitPrice, size: pos.size,
        pnl, exitReason: reason, tradeType: pos.tradeType ?? "directional",
        positionMode: "live",
      });
      console.log(`[Quant Live] CLOSE ${pos.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${reason}) @ ${exitPrice}`);
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
  tradeType: TradeType = "directional",
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
): Promise<QuantPosition | null> {
  if (openingPairs.has(pair)) {
    console.log(`[Quant Live] Open already in progress for ${pair}, skipping`);
    return null;
  }
  openingPairs.add(pair);
  try {
    await ensureConnected();
    const sdk = getClient();

    try {
      const env = loadEnv();
      const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
      if (wallet) {
        const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
        let equity = parseFloat(state.marginSummary.accountValue) || 0;
        const marginUsed = parseFloat(state.marginSummary.totalMarginUsed) || 0;

        if (equity <= marginUsed) {
          try {
            const spotState = await sdk.info.spot.getSpotClearinghouseState(wallet, true);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const usdcBal = spotState.balances?.find((b: any) => b.coin === "USDC");
            if (usdcBal) equity = parseFloat(usdcBal.total) || 0;
          } catch { /* spot check optional */ }
        }

        const available = equity - marginUsed;
        if (available < sizeUsd) {
          console.log(`[Quant Live] ${pair} skipped: insufficient margin ($${available.toFixed(2)} available, need $${sizeUsd})`);
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
      const isLiquidityError = statusStr.includes("could not immediately match");
      console.error(`[Quant Live] Order rejected for ${pair}: ${statusStr}`);
      if (!isMarginError && !isLiquidityError) {
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
      exchange: "hyperliquid",
      status: "open",
      openedAt: new Date().toISOString(),
      closedAt: undefined,
      exitPrice: undefined,
      realizedPnl: undefined,
      exitReason: undefined,
      tradeType,
      indicatorsAtEntry,
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
      } catch {
        void notifyCriticalError(`DB write failed + auto-close failed: ${pair} — ORPHAN on exchange`, "liveOpenPosition");
      }
      return null;
    }
    livePositions.set(position.id, position);
    positionContext.set(position.id, { indicatorsAtEntry });

    // Extract clean news context from indicatorsAtEntry for telegram notification
    let newsCtx: string | undefined;
    if (tradeType === "news-trade" && indicatorsAtEntry) {
      const parts = indicatorsAtEntry.split("|");
      const impact = parts[0]?.replace("impact:", "")?.toUpperCase() ?? "";
      const source = parts[1]?.replace("src:", "") ?? "";
      // Content is everything after the ets:...|
      const etsIdx = indicatorsAtEntry.indexOf("|", indicatorsAtEntry.indexOf("ets:"));
      const content = etsIdx > 0 ? indicatorsAtEntry.slice(etsIdx + 1).trim() : "";
      newsCtx = `${impact} | ${source}\n${content}`;
    }
    void notifyQuantTradeEntry({
      pair, direction, size: actualSizeUsd, entryPrice: fillPrice,
      leverage, tradeType, stopLoss: adjStop, takeProfit: adjTP,
      positionMode: "live",
      newsContext: newsCtx,
    });

    console.log(`[Quant Live] OPEN ${direction.toUpperCase()} ${pair} $${actualSizeUsd.toFixed(2)}x${leverage} @ ${fillPrice} (${fillSize} coins)`);
    void placeExchangeStop(position);
    void placeExchangeTP(position);
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    await cancelExchangeTP(positionId, position.pair);

    const result = await withTimeout(
      sdk.custom.marketClose(position.pair, undefined, undefined, MAX_SLIPPAGE),
      API_ORDER_TIMEOUT_MS, "HL marketClose",
    );

    const statuses = result?.response?.data?.statuses;
    const status = statuses?.[0];
    const closeFailed = !statuses || statuses.length === 0 || status?.resting || !status?.filled;

    if (closeFailed) {
      // Position may already be closed by exchange SL/TP
      const env = loadEnv();
      const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
      if (wallet) {
        try {
          const state = await sdk.info.perpetuals.getClearinghouseState(wallet, true);
          const stillOpen = state.assetPositions.some(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (ap: any) => ap.position.coin === position.pair && parseFloat(ap.position.szi) !== 0,
          );
          if (!stillOpen) {
            console.log(`[Quant Live] ${position.pair} already closed on exchange, deferring to reconciliation`);
            closingSet.delete(positionId);
            void reconcileWithExchange();
            return { success: true, pnl: 0 };
          }
        } catch { /* fall through to normal failure handling */ }
      }

      if (status?.resting) {
        console.error(`[Quant Live] Close resting for ${position.pair}`);
        try {
          await sdk.exchange.cancelOrder({ coin: `${position.pair}-PERP`, o: status.resting.oid });
        } catch { /* best effort */ }
      } else {
        console.error(`[Quant Live] Close failed for ${position.pair}: ${JSON.stringify(statuses)}`);
      }
      void placeExchangeStop(position);
      void placeExchangeTP(position);
      return { success: false, pnl: 0 };
    }

    const exitPrice = parseFloat(status?.filled?.avgPx ?? "0");

    if (!isFinite(exitPrice) || exitPrice <= 0) {
      console.error(`[Quant Live] Invalid exit price for ${position.pair}`);
      return { success: false, pnl: 0 };
    }

    const fees = position.size * position.leverage * 0.00045 * 2;
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

    livePositions.set(positionId, closedPosition);
    saveQuantPosition(closedPosition);

    const ctx = positionContext.get(positionId);
    const indMeta = parseIndicatorsMeta(ctx?.indicatorsAtEntry ?? position.indicatorsAtEntry);
    const holdDurationMs = Date.now() - new Date(position.openedAt).getTime();
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
      exitReason: reason,
      exchange: "hyperliquid",
      indicatorsAtEntry: ctx?.indicatorsAtEntry,
      createdAt: position.openedAt,
      updatedAt: now,
      tradeType: position.tradeType ?? "directional",
      maxUnrealizedPnlPct: position.maxUnrealizedPnlPct,
      btcPriceAtEntry: position.btcPriceAtEntry ?? indMeta.btcPrice,
      equityAtEntry: position.equityAtEntry ?? indMeta.equity,
      newsSource: indMeta.source,
      eventTimestamp: indMeta.eventTs,
      holdDurationMs,
    });
    positionContext.delete(positionId);

    if (reason === "stop-loss") {
      recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
    }

    void notifyQuantTradeExit({
      pair: position.pair, direction: position.direction,
      entryPrice: position.entryPrice, exitPrice, size: position.size,
      pnl, exitReason: reason, tradeType: position.tradeType ?? "directional",
      positionMode: "live",
    });

    console.log(`[Quant Live] CLOSE ${position.pair} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${reason}) @ ${exitPrice}`);
    return { success: true, pnl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Close failed for ${position.pair}: ${msg}`);
    resetConnection();

    // Check if position was already closed by exchange SL/TP (handles both timeout and SDK errors)
    {
      try {
        await ensureConnected();
        const sdk2 = getClient();
        const env2 = loadEnv();
        const wallet2 = env2.HYPERLIQUID_WALLET_ADDRESS;
        if (wallet2) {
          const state2 = await sdk2.info.perpetuals.getClearinghouseState(wallet2, true);
          const stillOpen = state2.assetPositions.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (ap: any) => ap.position.coin === position.pair && parseFloat(ap.position.szi) !== 0,
          );
          if (!stillOpen) {
            console.log(`[Quant Live] ${position.pair} already closed on exchange, reconciling`);
            // Get actual fill price from recent fills instead of mid-price
            let reconPrice = 0;
            try {
              const fills = await sdk2.info.getUserFills(wallet2, true);
              const openedMs = new Date(position.openedAt).getTime();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const recentFill = (fills as any[])
                .filter((f: any) => f.coin === position.pair && f.dir === (position.direction === "long" ? "Close Long" : "Close Short") && f.time > openedMs)
                .sort((a: any, b: any) => b.time - a.time)[0];
              if (recentFill) reconPrice = parseFloat(recentFill.px);
            } catch { /* fallback to mid-price */ }
            if (!reconPrice || !isFinite(reconPrice)) {
              const mids = (await sdk2.info.getAllMids(true)) as Record<string, string>;
              reconPrice = parseFloat(mids[position.pair] ?? "0") || position.entryPrice;
            }
            const fees = position.size * position.leverage * 0.00045 * 2;
            const estPnl = calcPnl(position.direction, position.entryPrice, reconPrice, position.size, position.leverage, fees);
            const now = new Date().toISOString();
            const exitReason = `${reason} (timeout-reconciled)`;
            const reconciled: QuantPosition = {
              ...position, status: "closed", closedAt: now,
              exitPrice: reconPrice, realizedPnl: estPnl, unrealizedPnl: estPnl, exitReason,
            };
            livePositions.set(positionId, reconciled);
            saveQuantPosition(reconciled);
            const ctx = positionContext.get(positionId);
            const trIndMeta = parseIndicatorsMeta(ctx?.indicatorsAtEntry ?? position.indicatorsAtEntry);
            const trHoldMs = Date.now() - new Date(position.openedAt).getTime();
            saveQuantTrade({
              id: position.id, pair: position.pair, direction: position.direction,
              entryPrice: position.entryPrice, exitPrice: reconPrice,
              size: position.size, leverage: position.leverage,
              pnl: estPnl, fees, mode: "live", status: "closed", exchange: "hyperliquid",
              exitReason, indicatorsAtEntry: ctx?.indicatorsAtEntry,
              createdAt: position.openedAt, updatedAt: now,
              tradeType: position.tradeType ?? "directional",
              maxUnrealizedPnlPct: position.maxUnrealizedPnlPct,
              btcPriceAtEntry: position.btcPriceAtEntry ?? trIndMeta.btcPrice,
              equityAtEntry: position.equityAtEntry ?? trIndMeta.equity,
              newsSource: trIndMeta.source,
              eventTimestamp: trIndMeta.eventTs,
              holdDurationMs: trHoldMs,
            });
            positionContext.delete(positionId);
            if (reason === "stop-loss") {
              recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
            }
            void notifyQuantTradeExit({
              pair: position.pair, direction: position.direction,
              entryPrice: position.entryPrice, exitPrice: reconPrice, size: position.size,
              pnl: estPnl, exitReason, tradeType: position.tradeType ?? "directional",
              positionMode: "live",
            });
            console.log(`[Quant Live] CLOSE ${position.pair} pnl=${estPnl >= 0 ? "+" : ""}$${estPnl.toFixed(2)} (${exitReason}) @ ${reconPrice}`);
            return { success: true, pnl: estPnl };
          }
        }
      } catch (reconErr) {
        console.error(`[Quant Live] Reconciliation failed: ${reconErr instanceof Error ? reconErr.message : reconErr}`);
      }
    }

    void placeExchangeStop(position);
    void placeExchangeTP(position);
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
    const perpsValue = parseFloat(state.marginSummary.accountValue);
    if (perpsValue > 0) return perpsValue;

    // Unified account fallback
    const spotState = await sdk.info.spot.getSpotClearinghouseState(wallet, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usdcBalance = spotState.balances?.find((b: any) => b.coin === "USDC");
    return usdcBalance ? parseFloat(usdcBalance.total) : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Live] Failed to fetch balance: ${msg}`);
    return 0;
  }
}
