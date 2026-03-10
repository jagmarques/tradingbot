import { getClient } from "./client.js";
import { getLighterMidPrice } from "../lighter/client.js";
import type { QuantPosition, TradeType } from "./types.js";
import {
  generateQuantId,
  saveQuantPosition,
  saveQuantTrade,
  loadOpenQuantPositions,
} from "../database/quant.js";
import { QUANT_DEFAULT_VIRTUAL_BALANCE } from "../../config/constants.js";
import { notifyQuantTradeEntry, notifyQuantTradeExit } from "../telegram/notifications.js";
import { fetchFundingRate } from "./market-data.js";
import { recordStopLossCooldown } from "./scheduler.js";

export const ISOLATED_ENGINE_TYPES: TradeType[] = [
  "ai-directional",
  "psar-directional",
  "zlema-directional",
  "vortex-directional",
  "schaff-directional",
  "dema-directional",
  "hma-directional",
  "cci-directional",
  "aroon-directional",
  "macd-directional",
  "zlemav2-directional",
  "schaffv2-directional",
];

const paperPositions = new Map<string, QuantPosition>();

// Context per position
const positionContext = new Map<string, {
  indicatorsAtEntry?: string;
}>();

// Track last funding accrual per position
const lastFundingAccrual = new Map<string, number>();

// Accumulated funding income per position
const accumulatedFunding = new Map<string, number>();

export function initPaperEngine(): void {
  paperPositions.clear();

  const allOpen = loadOpenQuantPositions();
  const paperOnly = allOpen.filter(p => p.mode !== "live");
  for (const pos of paperOnly) {
    paperPositions.set(pos.id, pos);
  }

  const skipped = allOpen.length - paperOnly.length;
  if (skipped > 0) {
    console.log(`[Quant Paper] Skipped ${skipped} live positions from DB`);
  }
  console.log(`[Quant Paper] Init: ${paperOnly.length} paper positions restored`);
}

export function getPaperBalance(tradeType?: TradeType): number {
  const perEngine = QUANT_DEFAULT_VIRTUAL_BALANCE / ISOLATED_ENGINE_TYPES.length;
  return tradeType !== undefined ? perEngine : QUANT_DEFAULT_VIRTUAL_BALANCE;
}

export function getPaperPositions(): QuantPosition[] {
  return Array.from(paperPositions.values()).filter(
    (p) => p.status === "open",
  );
}

async function fetchMidPrice(pair: string): Promise<number | null> {
  try {
    const sdk = getClient();
    const mids = await sdk.info.getAllMids(true) as Record<string, string>;
    const raw = mids[pair];
    if (!raw) return null;
    const price = parseFloat(raw);
    return isNaN(price) ? null : price;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Quant Paper] Failed to fetch mid price for ${pair}: ${msg}`);
    return null;
  }
}

async function fetchMidPriceForExchange(pair: string, exchange: "hyperliquid" | "lighter" = "hyperliquid"): Promise<number | null> {
  if (exchange === "lighter") {
    return getLighterMidPrice(pair);
  }
  return fetchMidPrice(pair);
}

// Accrue funding income for arb positions (1h settle)
export async function accrueFundingIncome(): Promise<void> {
  const openPositions = getPaperPositions();
  const fundingPositions = openPositions.filter(p => p.tradeType === "funding");

  if (fundingPositions.length === 0) return;

  const now = Date.now();
  const FUNDING_PERIOD_MS = 1 * 60 * 60 * 1000; // 1 hour

  for (const position of fundingPositions) {
    const lastAccrual = lastFundingAccrual.get(position.id) ?? new Date(position.openedAt).getTime();
    const elapsed = now - lastAccrual;

    // Skip if < 1h elapsed
    if (elapsed < 60 * 60 * 1000) continue;

    try {
      const fundingInfo = await fetchFundingRate(position.pair);
      if (!fundingInfo) continue;

      // Funding: shorts collect positive rate, longs collect negative rate
      const rate = fundingInfo.currentRate;
      let fundingPayment: number;

      if (position.direction === "short") {
        fundingPayment = rate * position.size * position.leverage; // positive rate = shorts collect
      } else {
        fundingPayment = -rate * position.size * position.leverage; // negative rate = longs collect
      }

      const periodFraction = elapsed / FUNDING_PERIOD_MS;
      const accruedPayment = fundingPayment * periodFraction;

      if (Math.abs(accruedPayment) < 0.001) {
        lastFundingAccrual.set(position.id, now);
        continue;
      }

      lastFundingAccrual.set(position.id, now);

      const prev = accumulatedFunding.get(position.id) ?? 0;
      accumulatedFunding.set(position.id, prev + accruedPayment);

      const sign = accruedPayment >= 0 ? "+" : "";
      console.log(
        `[Quant Paper] Funding accrual: ${position.pair} ${position.direction} ${sign}$${accruedPayment.toFixed(4)} (rate ${(rate * 100).toFixed(4)}%, ${(periodFraction * 100).toFixed(0)}% of period)`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Quant Paper] Funding accrual error for ${position.pair}: ${msg}`);
    }
  }
}

export async function paperOpenPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  stopLoss: number,
  takeProfit: number,
  tradeType: TradeType = "directional",
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
  exchange?: "hyperliquid" | "lighter",
): Promise<QuantPosition | null> {
  const price = await fetchMidPriceForExchange(pair, exchange);
  if (!price) {
    console.error(`[Quant Paper] Could not fetch price for ${pair}`);
    return null;
  }

  // Rebase stop/TP to actual fill
  let adjStop = stopLoss;
  let adjTP = takeProfit;
  if (aiEntryPrice && aiEntryPrice > 0) {
    const stopPct = (stopLoss - aiEntryPrice) / aiEntryPrice;
    const tpPct = (takeProfit - aiEntryPrice) / aiEntryPrice;
    adjStop = price * (1 + stopPct);
    adjTP = price * (1 + tpPct);
    if (Math.abs(price - aiEntryPrice) / aiEntryPrice > 0.001) {
      console.log(
        `[Quant Paper] Rebased stops for ${pair}: entry ${aiEntryPrice}->${price}, stop ${stopLoss.toPrecision(5)}->${adjStop.toPrecision(5)}`,
      );
    }
  }

  const position: QuantPosition = {
    id: generateQuantId(),
    pair,
    direction,
    entryPrice: price,
    size: sizeUsd,
    leverage,
    stopLoss: adjStop,
    takeProfit: adjTP,
    unrealizedPnl: 0,
    mode: "paper",
    exchange: exchange ?? "hyperliquid",
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: undefined,
    exitPrice: undefined,
    realizedPnl: undefined,
    exitReason: undefined,
    tradeType,
  };

  paperPositions.set(position.id, position);
  saveQuantPosition(position);
  positionContext.set(position.id, { indicatorsAtEntry });
  void notifyQuantTradeEntry({
    pair,
    direction,
    size: sizeUsd,
    entryPrice: price,
    leverage,
    tradeType,
    stopLoss: adjStop,
    takeProfit: adjTP,
    positionMode: "paper",
  });

  const openCount = Array.from(paperPositions.values()).filter(p => p.status === "open" && p.tradeType === tradeType).length;
  console.log(`[Quant Paper] ${tradeType}: OPEN ${direction.toUpperCase()} ${pair} $${sizeUsd}x${leverage} — ${openCount} concurrent open`);
  return position;
}

export async function paperClosePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  const position = paperPositions.get(positionId);
  if (!position || position.status !== "open") {
    return { success: false, pnl: 0 };
  }

  const posExchange = position.exchange ?? "hyperliquid";
  const currentPrice = await fetchMidPriceForExchange(position.pair, posExchange);
  if (!currentPrice) {
    console.error(`[Quant Paper] Could not fetch price for ${position.pair}`);
    return { success: false, pnl: 0 };
  }

  const rawPnl =
    position.direction === "long"
      ? ((currentPrice - position.entryPrice) / position.entryPrice) *
        position.size *
        position.leverage
      : ((position.entryPrice - currentPrice) / position.entryPrice) *
        position.size *
        position.leverage;

  // Lighter has zero fees; Hyperliquid Tier 0 taker 0.045% on entry + exit
  const fees = posExchange === "lighter" ? 0 : position.size * position.leverage * 0.00045 * 2;
  const fundingPnl = accumulatedFunding.get(positionId) ?? 0;

  let spotPnl = 0;
  if (position.spotHedgePrice && position.spotHedgePrice > 0) {
    if (position.direction === "short") {
      spotPnl = ((currentPrice - position.spotHedgePrice) / position.spotHedgePrice) * position.size * position.leverage;
    } else {
      spotPnl = ((position.spotHedgePrice - currentPrice) / position.spotHedgePrice) * position.size * position.leverage;
    }
    console.log(
      `[Quant Paper] Spot hedge P&L: entry ${position.spotHedgePrice} -> exit ${currentPrice} = $${spotPnl.toFixed(4)}`
    );
  }

  const pnl = rawPnl - fees + fundingPnl + spotPnl;

  const now = new Date().toISOString();
  const closedPosition: QuantPosition = {
    ...position,
    status: "closed",
    closedAt: now,
    exitPrice: currentPrice,
    realizedPnl: pnl,
    exitReason: reason,
  };

  paperPositions.set(positionId, closedPosition);
  saveQuantPosition(closedPosition);

  const ctx = positionContext.get(positionId);
  saveQuantTrade({
    id: position.id,
    pair: position.pair,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    size: position.size,
    leverage: position.leverage,
    pnl,
    fees,
    mode: "paper",
    status: "closed",
    exitReason: reason,
    indicatorsAtEntry: ctx?.indicatorsAtEntry,
    createdAt: position.openedAt,
    updatedAt: now,
    tradeType: position.tradeType ?? "directional",
    exchange: position.exchange,
  });
  positionContext.delete(positionId);
  lastFundingAccrual.delete(positionId);
  accumulatedFunding.delete(positionId);

  if (reason === "stop-loss") {
    recordStopLossCooldown(position.pair, position.direction);
  }

  void notifyQuantTradeExit({
    pair: position.pair,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    size: position.size,
    pnl,
    exitReason: reason,
    tradeType: position.tradeType ?? "directional",
    positionMode: "paper",
  });

  const realizedPnl = pnl;
  const fundingStr = fundingPnl !== 0
    ? ` (incl funding ${fundingPnl >= 0 ? "+" : ""}$${fundingPnl.toFixed(4)})`
    : "";
  console.log(
    `[Quant Paper] ${position.tradeType ?? "directional"}: CLOSE ${position.pair} pnl=${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)} (${reason})${fundingStr}`,
  );

  return { success: true, pnl };
}

export function deductLiquidationPenalty(positionId: string, penaltyUsd: number): void {
  console.log(`[Quant Paper] Liquidation penalty for ${positionId}: -$${penaltyUsd.toFixed(4)}`);
}

export function clearPaperMemory(): void {
  paperPositions.clear();
  positionContext.clear();
  lastFundingAccrual.clear();
  accumulatedFunding.clear();
}
