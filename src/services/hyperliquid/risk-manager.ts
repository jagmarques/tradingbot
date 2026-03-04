import {
  HYPERLIQUID_MAX_LEVERAGE,
  QUANT_MAX_POSITIONS,
  QUANT_DAILY_DRAWDOWN_LIMIT,
} from "../../config/constants.js";
import type { MarketRegime } from "./types.js";
import { getOpenQuantPositions } from "./executor.js";
import { sumRecentQuantLosses } from "../database/quant.js";

let quantKilled = false;
const dailyLossMap = new Map<string, number>();
const lastLossTimestampMap = new Map<string, number>();

export function strategyFromTradeType(tradeType: string): string {
  // "psar-directional" -> "psar", "ai-directional" -> "ai", "elder-impulse-directional" -> "elder"
  return tradeType.replace(/-directional$/, "").replace("elder-impulse", "elder");
}

function resetIfStale(strategy: string): void {
  const lastTs = lastLossTimestampMap.get(strategy) ?? 0;
  if (lastTs > 0 && Date.now() - lastTs > 86_400_000) {
    dailyLossMap.delete(strategy);
    lastLossTimestampMap.delete(strategy);
  }
}

export function isQuantKilled(): boolean {
  return quantKilled;
}

export function setQuantKilled(killed: boolean): void {
  quantKilled = killed;
  console.log(
    `[RiskManager] Quant kill switch: ${killed ? "ACTIVATED" : "DEACTIVATED"}`,
  );
}

export function recordDailyLoss(loss: number, strategy: string): void {
  resetIfStale(strategy);
  const prev = dailyLossMap.get(strategy) ?? 0;
  dailyLossMap.set(strategy, prev + loss);
  lastLossTimestampMap.set(strategy, Date.now());
  console.log(
    `[RiskManager] ${strategy} rolling 24h loss: $${(prev + loss).toFixed(2)} / $${QUANT_DAILY_DRAWDOWN_LIMIT}`,
  );
}

export function resetDailyDrawdown(): void {
  dailyLossMap.clear();
  lastLossTimestampMap.clear();
  console.log(`[RiskManager] Rolling 24h drawdown manually reset`);
}

export function seedDailyLossFromDb(): void {
  const strategies = ["ai", "psar", "zlema", "elder", "vortex", "schaff", "dema", "hma", "cci"];
  for (const strategy of strategies) {
    try {
      const { totalLoss, lastLossTs } = sumRecentQuantLosses(86_400_000, strategy);
      if (totalLoss > 0) {
        dailyLossMap.set(strategy, totalLoss);
        lastLossTimestampMap.set(strategy, lastLossTs);
        console.log(`[RiskManager] Seeded rolling 24h loss from DB: ${strategy} $${totalLoss.toFixed(2)}`);
      }
    } catch {
      console.log(`[RiskManager] No quant_trades table yet, starting with 0 loss for ${strategy}`);
    }
  }
}

export function getDailyLossTotal(strategy?: string): number {
  if (strategy !== undefined) {
    resetIfStale(strategy);
    return dailyLossMap.get(strategy) ?? 0;
  }
  // No strategy given: return global sum across all strategies
  let total = 0;
  for (const [strat, loss] of dailyLossMap) {
    resetIfStale(strat);
    total += dailyLossMap.get(strat) ?? loss;
  }
  return total;
}

function checkLeverageCap(leverage: number): {
  allowed: boolean;
  reason: string;
} {
  if (leverage > HYPERLIQUID_MAX_LEVERAGE) {
    return {
      allowed: false,
      reason: `Leverage ${leverage}x exceeds max ${HYPERLIQUID_MAX_LEVERAGE}x`,
    };
  }
  return { allowed: true, reason: "" };
}

function checkStopLossPresent(stopLoss: number): {
  allowed: boolean;
  reason: string;
} {
  if (!isFinite(stopLoss) || stopLoss <= 0) {
    return {
      allowed: false,
      reason: `Stop-loss must be a positive finite number, got ${stopLoss}`,
    };
  }
  return { allowed: true, reason: "" };
}

function checkDailyDrawdown(strategy: string): { allowed: boolean; reason: string } {
  resetIfStale(strategy);
  const loss = dailyLossMap.get(strategy) ?? 0;
  if (loss >= QUANT_DAILY_DRAWDOWN_LIMIT) {
    return {
      allowed: false,
      reason: `Rolling 24h loss for ${strategy}: $${loss.toFixed(2)} exceeds limit $${QUANT_DAILY_DRAWDOWN_LIMIT}`,
    };
  }
  return { allowed: true, reason: "" };
}

function checkMaxPositions(): { allowed: boolean; reason: string } {
  const positions = getOpenQuantPositions();
  const count = positions.length;
  if (count >= QUANT_MAX_POSITIONS) {
    return {
      allowed: false,
      reason: `Open positions ${count} at max ${QUANT_MAX_POSITIONS}`,
    };
  }
  return { allowed: true, reason: "" };
}

function checkRegimeAllowed(regime: MarketRegime): {
  allowed: boolean;
  reason: string;
} {
  if (regime === "volatile") {
    return { allowed: false, reason: "Volatile regime - no new positions" };
  }
  return { allowed: true, reason: "" };
}

// ---- Unified gate (single chokepoint) ----

export function validateRiskGates(params: {
  leverage: number;
  stopLoss: number;
  regime: MarketRegime;
  strategy: string;
}): { allowed: boolean; reason: string } {
  const { leverage, stopLoss, regime, strategy } = params;

  // 1. Kill switch
  if (isQuantKilled()) {
    const result = { allowed: false, reason: "Quant kill switch active" };
    console.log(`[RiskManager] Gate check: BLOCKED ${result.reason}`);
    return result;
  }

  // 2. Regime check
  const regimeCheck = checkRegimeAllowed(regime);
  if (!regimeCheck.allowed) {
    console.log(`[RiskManager] Gate check: BLOCKED ${regimeCheck.reason}`);
    return regimeCheck;
  }

  // 3. Daily drawdown (per-strategy)
  const drawdownCheck = checkDailyDrawdown(strategy);
  if (!drawdownCheck.allowed) {
    console.log(`[RiskManager] Gate check: BLOCKED ${drawdownCheck.reason}`);
    return drawdownCheck;
  }

  // 4. Max positions
  const positionsCheck = checkMaxPositions();
  if (!positionsCheck.allowed) {
    console.log(`[RiskManager] Gate check: BLOCKED ${positionsCheck.reason}`);
    return positionsCheck;
  }

  // 5. Leverage cap
  const leverageCheck = checkLeverageCap(leverage);
  if (!leverageCheck.allowed) {
    console.log(`[RiskManager] Gate check: BLOCKED ${leverageCheck.reason}`);
    return leverageCheck;
  }

  // 6. Stop-loss presence (directional validation handled by AI parser)
  const stopLossCheck = checkStopLossPresent(stopLoss);
  if (!stopLossCheck.allowed) {
    console.log(`[RiskManager] Gate check: BLOCKED ${stopLossCheck.reason}`);
    return stopLossCheck;
  }

  console.log(`[RiskManager] Gate check: PASS`);
  return { allowed: true, reason: "" };
}
