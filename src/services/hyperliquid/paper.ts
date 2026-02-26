import { getClient } from "./client.js";
import type { QuantPosition, TradeType } from "./types.js";
import {
  generateQuantId,
  saveQuantPosition,
  saveQuantTrade,
  loadOpenQuantPositions,
  getTotalRealizedPnl,
} from "../database/quant.js";
import { QUANT_DEFAULT_VIRTUAL_BALANCE } from "../../config/constants.js";
import { notifyQuantTradeEntry, notifyQuantTradeExit } from "../telegram/notifications.js";
import { fetchFundingRate } from "./market-data.js";

let virtualBalance: number = QUANT_DEFAULT_VIRTUAL_BALANCE;
const paperPositions = new Map<string, QuantPosition>();

// Stores AI context and indicator snapshot per position, keyed by position ID
const positionContext = new Map<string, {
  aiConfidence?: number;
  aiReasoning?: string;
  indicatorsAtEntry?: string;
}>();

// Track last funding accrual per position
const lastFundingAccrual = new Map<string, number>();

// Track accumulated funding income per position (for inclusion in close P&L record)
const accumulatedFunding = new Map<string, number>();

export function initPaperEngine(startingBalance: number): void {
  paperPositions.clear();

  const openPositions = loadOpenQuantPositions();
  for (const pos of openPositions) {
    paperPositions.set(pos.id, pos);
  }

  const lockedCapital = openPositions.reduce((sum, p) => sum + p.size, 0);
  const realizedPnl = getTotalRealizedPnl();
  virtualBalance = startingBalance + realizedPnl - lockedCapital;

  console.log(
    `[Quant Paper] Init: $${virtualBalance.toFixed(2)} balance (start=$${startingBalance}, pnl=$${realizedPnl.toFixed(2)}, locked=$${lockedCapital.toFixed(2)}), ${openPositions.length} open`,
  );
}

export function getPaperBalance(): number {
  return virtualBalance;
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

// Accrue funding income for open funding arb positions (settles every 1h on Hyperliquid)
export async function accrueFundingIncome(): Promise<void> {
  const openPositions = getPaperPositions();
  const fundingPositions = openPositions.filter(p => p.tradeType === "funding");

  if (fundingPositions.length === 0) return;

  const now = Date.now();
  const FUNDING_PERIOD_MS = 1 * 60 * 60 * 1000; // 1 hour

  for (const position of fundingPositions) {
    const lastAccrual = lastFundingAccrual.get(position.id) ?? new Date(position.openedAt).getTime();
    const elapsed = now - lastAccrual;

    // Only accrue if at least 1 hour has passed (avoid micro-accruals)
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

      virtualBalance += accruedPayment;
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
  tradeType: TradeType = "ai-directional",
  aiConfidence?: number,
  aiReasoning?: string,
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
): Promise<QuantPosition | null> {
  if (virtualBalance < sizeUsd) {
    console.log(
      `[Quant Paper] Insufficient balance: $${virtualBalance.toFixed(2)} < $${sizeUsd}`,
    );
    return null;
  }

  const price = await fetchMidPrice(pair);
  if (!price) {
    console.error(`[Quant Paper] Could not fetch price for ${pair}`);
    return null;
  }

  // Rebase stop/TP from AI's entry price to actual fill price
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
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: undefined,
    exitPrice: undefined,
    realizedPnl: undefined,
    exitReason: undefined,
    tradeType,
  };

  virtualBalance -= sizeUsd;
  paperPositions.set(position.id, position);
  saveQuantPosition(position);
  positionContext.set(position.id, { aiConfidence, aiReasoning, indicatorsAtEntry });
  void notifyQuantTradeEntry({
    pair,
    direction,
    size: sizeUsd,
    entryPrice: price,
    leverage,
    tradeType,
    stopLoss: adjStop,
    takeProfit: adjTP,
  });

  console.log(
    `[Quant Paper] OPEN ${direction} ${pair} $${sizeUsd} @ ${price} (${leverage}x)`,
  );
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

  const currentPrice = await fetchMidPrice(position.pair);
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

  // Tier 0 taker 0.045% on entry + exit (notional = size * leverage)
  const fees = position.size * position.leverage * 0.00045 * 2;
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

  virtualBalance += position.size + (rawPnl - fees) + spotPnl;

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
    aiConfidence: ctx?.aiConfidence,
    aiReasoning: ctx?.aiReasoning,
    exitReason: reason,
    indicatorsAtEntry: ctx?.indicatorsAtEntry,
    createdAt: position.openedAt,
    updatedAt: now,
    tradeType: position.tradeType ?? "directional",
  });
  positionContext.delete(positionId);
  lastFundingAccrual.delete(positionId);
  accumulatedFunding.delete(positionId);
  void notifyQuantTradeExit({
    pair: position.pair,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    size: position.size,
    pnl,
    exitReason: reason,
    tradeType: position.tradeType ?? "directional",
  });

  const pnlStr =
    pnl >= 0 ? `+$${pnl.toFixed(4)}` : `-$${Math.abs(pnl).toFixed(4)}`;
  const fundingStr = fundingPnl !== 0
    ? ` (incl funding ${fundingPnl >= 0 ? "+" : ""}$${fundingPnl.toFixed(4)})`
    : "";
  console.log(
    `[Quant Paper] CLOSE ${position.direction} ${position.pair} @ ${currentPrice} ${pnlStr}${fundingStr} (${reason})`,
  );

  return { success: true, pnl };
}

export function deductLiquidationPenalty(positionId: string, penaltyUsd: number): void {
  virtualBalance -= penaltyUsd;
  console.log(`[Quant Paper] Liquidation penalty for ${positionId}: -$${penaltyUsd.toFixed(4)}`);
}

export function clearPaperMemory(): void {
  paperPositions.clear();
  positionContext.clear();
  lastFundingAccrual.clear();
  accumulatedFunding.clear();
  virtualBalance = QUANT_DEFAULT_VIRTUAL_BALANCE;
}
