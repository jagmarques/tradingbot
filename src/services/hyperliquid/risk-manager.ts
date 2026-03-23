import {
  HYPERLIQUID_MAX_LEVERAGE,
  QUANT_DAILY_DRAWDOWN_LIMIT,
} from "../../config/constants.js";
import type { MarketRegime } from "./types.js";
import { sumRecentQuantLosses } from "../database/quant.js";

let quantKilled = false;
const dailyLossMap = new Map<string, number>();
const lastLossTimestampMap = new Map<string, number>();

export function strategyFromTradeType(tradeType: string): string {
  return tradeType.replace(/-directional$/, "");
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

export function recordDailyLoss(loss: number, strategy: string, mode: "live" | "paper" = "live"): void {
  const key = `${mode}:${strategy}`;
  resetIfStale(key);
  const prev = dailyLossMap.get(key) ?? 0;
  dailyLossMap.set(key, prev + loss);
  lastLossTimestampMap.set(key, Date.now());
  console.log(
    `[RiskManager] ${strategy}(${mode}) rolling 24h loss: $${(prev + loss).toFixed(2)}`,
  );
}

export function resetDailyDrawdown(): void {
  dailyLossMap.clear();
  lastLossTimestampMap.clear();
  console.log(`[RiskManager] Rolling 24h drawdown manually reset`);
}

export function seedDailyLossFromDb(): void {
  const strategies = ["garch-chan", "btc-event", "news-trade", "btc-mr"];
  const modes: Array<"live" | "paper"> = ["live", "paper"];
  for (const mode of modes) {
    for (const strategy of strategies) {
      try {
        const { totalLoss, lastLossTs } = sumRecentQuantLosses(86_400_000, strategy, mode);
        if (totalLoss > 0) {
          const key = `${mode}:${strategy}`;
          dailyLossMap.set(key, totalLoss);
          lastLossTimestampMap.set(key, lastLossTs);
          console.log(`[RiskManager] Seeded rolling 24h loss from DB: ${strategy}(${mode}) $${totalLoss.toFixed(2)}`);
        }
      } catch {
        // No quant_trades table yet
      }
    }
  }
}

export function getDailyLossTotal(strategy?: string, mode?: "live" | "paper"): number {
  if (strategy !== undefined && mode !== undefined) {
    const key = `${mode}:${strategy}`;
    resetIfStale(key);
    return dailyLossMap.get(key) ?? 0;
  }
  // Sum across all matching keys
  let total = 0;
  for (const [key] of dailyLossMap) {
    if (strategy !== undefined && !key.endsWith(`:${strategy}`)) continue;
    if (mode !== undefined && !key.startsWith(`${mode}:`)) continue;
    resetIfStale(key);
    total += dailyLossMap.get(key) ?? 0;
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

function checkDailyDrawdown(strategy: string, mode: "live" | "paper" = "live", limit: number = QUANT_DAILY_DRAWDOWN_LIMIT): { allowed: boolean; reason: string } {
  // Paper: no daily loss limit
  if (mode === "paper") return { allowed: true, reason: "" };
  const key = `${mode}:${strategy}`;
  resetIfStale(key);
  const loss = dailyLossMap.get(key) ?? 0;
  if (loss >= limit) {
    return {
      allowed: false,
      reason: `Rolling 24h loss for ${strategy}(${mode}): $${loss.toFixed(2)} exceeds limit $${limit}`,
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
  mode?: "live" | "paper";
  dailyLossLimit?: number;
}): { allowed: boolean; reason: string } {
  const { leverage, stopLoss, regime, strategy, mode = "live", dailyLossLimit } = params;

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

  // 3. Daily drawdown (per-strategy, per-mode)
  const drawdownCheck = checkDailyDrawdown(strategy, mode, dailyLossLimit);
  if (!drawdownCheck.allowed) {
    console.log(`[RiskManager] Gate check: BLOCKED ${drawdownCheck.reason}`);
    return drawdownCheck;
  }

  // 4. Leverage cap
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
