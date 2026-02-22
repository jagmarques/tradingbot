import {
  HYPERLIQUID_MAX_LEVERAGE,
  QUANT_MAX_POSITIONS,
  QUANT_DAILY_DRAWDOWN_LIMIT,
} from "../../config/constants.js";
import type { MarketRegime } from "./types.js";
import { getOpenQuantPositions } from "./executor.js";

// ---- Module-level state ----

let quantKilled = false;
let dailyLossAccumulator = 0;
let lastLossTimestamp = 0;

// ---- Kill switch ----

export function isQuantKilled(): boolean {
  return quantKilled;
}

export function setQuantKilled(killed: boolean): void {
  quantKilled = killed;
  console.log(
    `[RiskManager] Quant kill switch: ${killed ? "ACTIVATED" : "DEACTIVATED"}`,
  );
}

// ---- Daily drawdown ----

export function recordDailyLoss(loss: number): void {
  const now = Date.now();
  // Reset accumulator if 24h have passed since last loss
  if (lastLossTimestamp > 0 && now - lastLossTimestamp > 86_400_000) {
    dailyLossAccumulator = 0;
  }
  dailyLossAccumulator += loss;
  lastLossTimestamp = now;
  console.log(
    `[RiskManager] Rolling 24h loss: $${dailyLossAccumulator.toFixed(2)} / $${QUANT_DAILY_DRAWDOWN_LIMIT}`,
  );
}

export function resetDailyDrawdown(): void {
  dailyLossAccumulator = 0;
  lastLossTimestamp = 0;
  console.log(`[RiskManager] Rolling 24h drawdown manually reset`);
}

export function getDailyLossTotal(): number {
  // Auto-reset if 24h have passed since last loss
  if (lastLossTimestamp > 0 && Date.now() - lastLossTimestamp > 86_400_000) {
    dailyLossAccumulator = 0;
    lastLossTimestamp = 0;
  }
  return dailyLossAccumulator;
}

// ---- Individual gate checks ----

export function checkLeverageCap(leverage: number): {
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

export function checkStopLossPresent(stopLoss: number): {
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

export function checkDailyDrawdown(): { allowed: boolean; reason: string } {
  if (lastLossTimestamp > 0 && Date.now() - lastLossTimestamp > 86_400_000) {
    dailyLossAccumulator = 0;
    lastLossTimestamp = 0;
  }
  if (dailyLossAccumulator >= QUANT_DAILY_DRAWDOWN_LIMIT) {
    return {
      allowed: false,
      reason: `Rolling 24h loss $${dailyLossAccumulator.toFixed(2)} exceeds limit $${QUANT_DAILY_DRAWDOWN_LIMIT}`,
    };
  }
  return { allowed: true, reason: "" };
}

export function checkMaxPositions(): { allowed: boolean; reason: string } {
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

export function checkRegimeAllowed(regime: MarketRegime): {
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
}): { allowed: boolean; reason: string } {
  const { leverage, stopLoss, regime } = params;

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

  // 3. Daily drawdown
  const drawdownCheck = checkDailyDrawdown();
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
