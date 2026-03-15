import { analyzeWithAI, clearAICacheForPair } from "./ai-analyzer.js";
import { fetchDailyCandles, computeDailySma } from "./daily-indicators.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS, QUANT_FIXED_POSITION_SIZE_USD, QUANT_HYBRID_LIVE_ENGINES, QUANT_AI_DIRECTIONAL_ENABLED, QUANT_DTF_MR_ENABLED } from "../../config/constants.js";
import type { QuantAIDecision } from "./types.js";
import { runDtfMrCycle } from "./dtf-mr.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

const STOP_LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const stopLossCooldowns = new Map<string, number>();

export function recordStopLossCooldown(pair: string, direction: string, tradeType = "directional"): void {
  const key = `${pair}:${direction}:${tradeType}`;
  stopLossCooldowns.set(key, Date.now());
  console.log(`[QuantScheduler] SL cooldown: ${pair} ${direction} (${tradeType}, 2h)`);
}

function isInStopLossCooldown(pair: string, direction: string, tradeType = "directional"): boolean {
  const key = `${pair}:${direction}:${tradeType}`;
  const ts = stopLossCooldowns.get(key);
  if (!ts) return false;
  if (Date.now() - ts > STOP_LOSS_COOLDOWN_MS) {
    stopLossCooldowns.delete(key);
    return false;
  }
  return true;
}

export async function runDirectionalCycle(): Promise<void> {
  if (cycleRunning) {
    console.log("[QuantScheduler] Previous cycle still running, skipping");
    return;
  }
  cycleRunning = true;

  try {
    if (isQuantKilled()) {
      console.log("[QuantScheduler] Kill switch active, skipping cycle");
      return;
    }

    const analyses = await runMarketDataPipeline();
    const openPositions = getOpenQuantPositions();

    // AI engine
    const aiDecisions: QuantAIDecision[] = [];
    const aiSignals = new Map<string, "long" | "short" | "flat">();
    if (QUANT_AI_DIRECTIONAL_ENABLED) {
      for (const analysis of analyses) {
        const dailyCandles = await fetchDailyCandles(analysis.pair, 150);
        const closes = dailyCandles.map((c) => c.close);
        const sma50 = computeDailySma(closes, 50, closes.length - 1);
        const markPrice = analysis.markPrice;
        let dailyTrend: { direction: "bullish" | "bearish" | "neutral"; price: number; sma50: number } | null = null;
        if (sma50 !== null) {
          const direction = markPrice > sma50 * 1.01 ? "bullish" : markPrice < sma50 * 0.99 ? "bearish" : "neutral";
          dailyTrend = { direction, price: markPrice, sma50 };
        }
        const decision = await analyzeWithAI(analysis, dailyTrend);
        if (!decision) continue;
        aiSignals.set(decision.pair, decision.direction);
        if (decision.direction === "flat") continue;
        const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss, "ai-directional");
        if (sizeUsd <= 0) continue;
        aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
      }
    }

    const aiOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType).map(p => p.pair),
    );

    // AI signal-flip exits
    if (QUANT_AI_DIRECTIONAL_ENABLED) {
      const aiPositions = openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType);
      for (const pos of aiPositions) {
        const signal = aiSignals.get(pos.pair);
        if (!signal) continue;
        if (signal !== "flat" && signal !== pos.direction) {
          console.log(`[QuantScheduler] AI signal flip: ${pos.pair} pos=${pos.direction} signal=${signal}, closing`);
          const result = await closePosition(pos.id, `ai-signal-flip (${pos.direction}->${signal})`);
          if (result.success) {
            aiOpenPairs.delete(pos.pair);
            clearAICacheForPair(pos.pair);
          }
        }
      }
    }

    // AI entries
    let aiExecuted = 0;
    if (QUANT_AI_DIRECTIONAL_ENABLED) {
      for (const decision of aiDecisions) {
        if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
        if (aiOpenPairs.has(decision.pair)) continue;
        if (isInStopLossCooldown(decision.pair, decision.direction, "ai-directional")) continue;
        const invConflict = openPositions.find(p => p.mode === "live" && p.exchange === "lighter" && QUANT_HYBRID_LIVE_ENGINES.has(p.tradeType ?? "") && p.pair === decision.pair && p.direction !== decision.direction);
        if (invConflict) continue;
        const position = await openPosition(decision.pair, decision.direction, QUANT_FIXED_POSITION_SIZE_USD, 10, decision.stopLoss, decision.takeProfit, decision.regime, "ai-directional", undefined, decision.entryPrice);
        if (position) {
          aiExecuted++;
          aiOpenPairs.add(decision.pair);
          console.log(`[QuantScheduler] AI: Opened ${decision.pair} ${decision.direction} $${QUANT_FIXED_POSITION_SIZE_USD.toFixed(2)} @ ${decision.entryPrice}`);
        }
      }
    }

    // DualTF Mean Reversion engine
    let dtfMrExecuted = 0;
    if (QUANT_DTF_MR_ENABLED) {
      try {
        dtfMrExecuted = await runDtfMrCycle();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[QuantScheduler] DtfMR cycle error: ${msg}`);
      }
    }

    const aiLog = QUANT_AI_DIRECTIONAL_ENABLED ? `AI ${aiExecuted}/${aiDecisions.length}` : "AI OFF";
    const dtfLog = QUANT_DTF_MR_ENABLED ? `DtfMR ${dtfMrExecuted}` : "DtfMR OFF";
    console.log(`[QuantScheduler] Cycle: ${aiLog}, ${dtfLog}`);
  } finally {
    cycleRunning = false;
  }
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) return;
  console.log("[QuantScheduler] Started (15m interval, 10x leverage)");
  initialRunTimeout = setTimeout(() => { void runDirectionalCycle(); }, 15_000);
  schedulerInterval = setInterval(() => { void runDirectionalCycle(); }, QUANT_SCHEDULER_INTERVAL_MS);
}

export function stopQuantScheduler(): void {
  if (schedulerInterval !== null) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (initialRunTimeout !== null) { clearTimeout(initialRunTimeout); initialRunTimeout = null; }
  console.log("[QuantScheduler] Stopped");
}
