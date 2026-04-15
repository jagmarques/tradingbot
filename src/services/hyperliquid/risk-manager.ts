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
  const strategies = ["donchian-trend", "supertrend-4h", "garch-v2", "carry-momentum", "momentum-confirm", "alt-rotation", "range-expansion", "trump-event", "garch-chan", "btc-event", "news-trade", "btc-mr"];
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


const MR_STRATEGIES = new Set(["btc-mr"]);
const REGIME_EXEMPT_STRATEGIES = new Set(["news-trade", "funding"]);

function checkConcurrentPositions(count: number, max: number): {
  allowed: boolean;
  reason: string;
} {
  if (count >= max) {
    return {
      allowed: false,
      reason: `Concurrent position limit reached: ${count}/${max}`,
    };
  }
  return { allowed: true, reason: "" };
}

function checkRegimeForStrategy(regime: MarketRegime, strategy: string): {
  allowed: boolean;
  reason: string;
} {
  if (regime === "volatile") {
    return { allowed: false, reason: "Volatile regime - no new positions" };
  }
  if (REGIME_EXEMPT_STRATEGIES.has(strategy)) {
    return { allowed: true, reason: "" };
  }
  if (regime === "trending" && MR_STRATEGIES.has(strategy)) {
    return {
      allowed: false,
      reason: `Trending regime - ${strategy} sits out (MR only in ranging)`,
    };
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
  openPositionCount?: number;
  maxConcurrentPositions?: number;
  indicators?: string;
}): { allowed: boolean; reason: string } {
  const { leverage, stopLoss, regime, strategy, mode = "live", dailyLossLimit, openPositionCount, maxConcurrentPositions, indicators } = params;

  // 1. Kill switch
  if (isQuantKilled()) {
    const result = { allowed: false, reason: "Quant kill switch active" };
    console.log(`[RiskManager] Gate check: BLOCKED ${result.reason}`);
    return result;
  }

  // 1.5. Concurrent positions check (only when caller provides count)
  if (openPositionCount !== undefined) {
    const concurrentCheck = checkConcurrentPositions(openPositionCount, maxConcurrentPositions ?? 5);
    if (!concurrentCheck.allowed) {
      console.log(`[RiskManager] Gate check: BLOCKED ${concurrentCheck.reason}`);
      return concurrentCheck;
    }
  }

  // 2. Regime check (strategy-aware)
  const regimeCheck = checkRegimeForStrategy(regime, strategy);
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

  // 6. Stop-loss presence -- skip if slPct is in indicators (SL computed from fill price)
  if (!indicators?.includes("slPct:")) {
    const stopLossCheck = checkStopLossPresent(stopLoss);
    if (!stopLossCheck.allowed) {
      console.log(`[RiskManager] Gate check: BLOCKED ${stopLossCheck.reason}`);
      return stopLossCheck;
    }
  }

  console.log(`[RiskManager] Gate check: PASS`);
  return { allowed: true, reason: "" };
}
