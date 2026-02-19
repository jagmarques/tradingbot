import { isPaperMode } from "../../config/env.js";
import {
  paperOpenPosition,
  paperClosePosition,
  getPaperBalance,
  getPaperPositions,
} from "./paper.js";
import type { QuantPosition } from "./types.js";

export async function openPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  aiConfidence?: number,
  aiReasoning?: string,
): Promise<QuantPosition | null> {
  if (isPaperMode()) {
    return paperOpenPosition(pair, direction, sizeUsd, leverage);
  }

  // Live mode: not yet implemented (Phase 26+)
  console.warn(`[Quant Executor] Live trading not yet implemented. Use paper mode.`);
  void aiConfidence;
  void aiReasoning;
  return null;
}

export async function closePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  if (isPaperMode()) {
    return paperClosePosition(positionId, reason);
  }

  // Live mode: not yet implemented (Phase 26+)
  console.warn(`[Quant Executor] Live trading not yet implemented. Use paper mode.`);
  return { success: false, pnl: 0 };
}

export function getOpenQuantPositions(): QuantPosition[] {
  if (isPaperMode()) {
    return getPaperPositions();
  }
  // Live positions returned from paper engine until live executor is built
  return getPaperPositions();
}

export function getVirtualBalance(): number {
  return getPaperBalance();
}
