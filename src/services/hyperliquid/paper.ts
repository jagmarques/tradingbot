import { getClient } from "./client.js";
import type { QuantPosition } from "./types.js";
import {
  generateQuantId,
  saveQuantPosition,
  saveQuantTrade,
  loadOpenQuantPositions,
} from "../database/quant.js";
import { QUANT_DEFAULT_VIRTUAL_BALANCE } from "../../config/constants.js";
import { notifyQuantTradeEntry, notifyQuantTradeExit } from "../telegram/notifications.js";

let virtualBalance: number = QUANT_DEFAULT_VIRTUAL_BALANCE;
const paperPositions = new Map<string, QuantPosition>();

// Stores AI context and indicator snapshot per position, keyed by position ID
const positionContext = new Map<string, {
  aiConfidence?: number;
  aiReasoning?: string;
  indicatorsAtEntry?: string;
}>();

export function initPaperEngine(startingBalance: number): void {
  virtualBalance = startingBalance;
  paperPositions.clear();

  const openPositions = loadOpenQuantPositions();
  for (const pos of openPositions) {
    paperPositions.set(pos.id, pos);
  }

  // Restore virtual balance by subtracting capital locked in open positions
  const lockedCapital = openPositions.reduce((sum, p) => sum + p.size, 0);
  virtualBalance = startingBalance - lockedCapital;

  console.log(
    `[Quant Paper] Initialized with $${virtualBalance.toFixed(2)} balance, ${openPositions.length} open positions`,
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
    const mids = await sdk.info.getAllMids() as Record<string, string>;
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

export async function paperOpenPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  stopLoss: number,
  takeProfit: number,
  tradeType: "directional" | "funding" = "directional",
  aiConfidence?: number,
  aiReasoning?: string,
  indicatorsAtEntry?: string,
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

  const position: QuantPosition = {
    id: generateQuantId(),
    pair,
    direction,
    entryPrice: price,
    size: sizeUsd,
    leverage,
    stopLoss,
    takeProfit,
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
    stopLoss,
    takeProfit,
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

  // Estimate fees: 0.035% taker fee on entry + exit notional
  const fees = position.size * 0.00035 * 2;
  const pnl = rawPnl - fees;

  // Return size + pnl to virtual balance
  virtualBalance += position.size + pnl;

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
  console.log(
    `[Quant Paper] CLOSE ${position.direction} ${position.pair} @ ${currentPrice} ${pnlStr} (${reason})`,
  );

  return { success: true, pnl };
}
