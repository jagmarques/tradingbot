import { analyzeWithAI, clearAICacheForPair } from "./ai-analyzer.js";
import { fetchDailyCandles, computeDailySma } from "./daily-indicators.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { runPsarDecisionEngine } from "./psar-engine.js";
import { runZlemaDecisionEngine } from "./zlema-engine.js";
import { runVortexDecisionEngine } from "./vortex-engine.js";
import { runSchaffDecisionEngine } from "./schaff-engine.js";
import { runDEMADecisionEngine } from "./dema-engine.js";
import { runHMADecisionEngine } from "./hma-engine.js";
import { runCCIDecisionEngine } from "./cci-engine.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS } from "../../config/constants.js";
import type { QuantAIDecision, TradeType } from "./types.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

// Last signal direction per engine:pair (e.g. "zlema-directional:BTC" -> "long")
const lastSignals = new Map<string, string>();

export function getLastSignal(tradeType: string, pair: string): string | undefined {
  return lastSignals.get(`${tradeType}:${pair}`);
}

const STOP_LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const stopLossCooldowns = new Map<string, number>(); // `${pair}:${direction}` -> timestamp

export function recordStopLossCooldown(pair: string, direction: string): void {
  const key = `${pair}:${direction}`;
  stopLossCooldowns.set(key, Date.now());
  console.log(`[QuantScheduler] Stop-loss cooldown set for ${pair} ${direction} (2h)`);
}

function isInStopLossCooldown(pair: string, direction: string): boolean {
  const key = `${pair}:${direction}`;
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

    // AI engine (DeepSeek, runs on Hyperliquid)
    const aiDecisions: QuantAIDecision[] = [];
    const aiSignals = new Map<string, "long" | "short" | "flat">();
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
      const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss, false, "ai-directional");
      if (sizeUsd <= 0) continue;
      aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
    }

    // Technical engines always run (routed to paper in executor.ts)
    const psarDecisions = await runPsarDecisionEngine(analyses);
    const zlemaDecisions = await runZlemaDecisionEngine(analyses);
const vortexDecisions = await runVortexDecisionEngine(analyses);
    const schaffDecisions = await runSchaffDecisionEngine(analyses);
    const demaDecisions = await runDEMADecisionEngine(analyses);
    const hmaDecisions = await runHMADecisionEngine(analyses);
    const cciDecisions = await runCCIDecisionEngine(analyses);

    // Record latest signals for smart trailing
    const allDecisions: Array<{ tradeType: string; decisions: typeof psarDecisions }> = [
      { tradeType: "psar-directional", decisions: psarDecisions },
      { tradeType: "zlema-directional", decisions: zlemaDecisions },
      { tradeType: "vortex-directional", decisions: vortexDecisions },
      { tradeType: "schaff-directional", decisions: schaffDecisions },
      { tradeType: "dema-directional", decisions: demaDecisions },
      { tradeType: "hma-directional", decisions: hmaDecisions },
      { tradeType: "cci-directional", decisions: cciDecisions },
    ];
    for (const { tradeType, decisions } of allDecisions) {
      for (const d of decisions) {
        const key = `${tradeType}:${d.pair}`;
        if (d.direction === "flat") {
          lastSignals.delete(key);
        } else {
          lastSignals.set(key, d.direction);
        }
      }
    }

    // Record AI signals for smart trailing
    for (const d of aiDecisions) {
      const key = `ai-directional:${d.pair}`;
      if (d.direction === "flat") {
        lastSignals.delete(key);
      } else {
        lastSignals.set(key, d.direction);
      }
    }

    const openPositions = getOpenQuantPositions();

    const aiOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType).map(p => p.pair),
    );
    const openPairsByEngine = new Map<string, Set<string>>();
    for (const tt of ["psar-directional", "zlema-directional", "vortex-directional", "schaff-directional", "dema-directional", "hma-directional", "cci-directional"]) {
      openPairsByEngine.set(tt, new Set(openPositions.filter(p => p.tradeType === tt).map(p => p.pair)));
    }

    // Close AI positions if signal flips
    const aiPositions = openPositions.filter(p => p.tradeType === "ai-directional" || p.tradeType === "directional" || !p.tradeType);
    for (const pos of aiPositions) {
      const signal = aiSignals.get(pos.pair);
      if (!signal) continue;
      const flipped = signal !== "flat" && signal !== pos.direction;
      if (flipped) {
        console.log(`[QuantScheduler] AI signal flip: ${pos.pair} position=${pos.direction} signal=${signal}, closing`);
        const result = await closePosition(pos.id, `ai-signal-flip (${pos.direction}->${signal})`);
        if (result.success) {
          aiOpenPairs.delete(pos.pair);
          clearAICacheForPair(pos.pair);
        }
      }
    }

    let aiExecuted = 0;
    for (const decision of aiDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (aiOpenPairs.has(decision.pair)) continue;
      if (isInStopLossCooldown(decision.pair, decision.direction)) continue;
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, "ai-directional", undefined, decision.entryPrice);
      if (position) {
        aiExecuted++;
        aiOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] AI: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    // Live engines: DEMA -> HMA -> Schaff (order matters for pair priority)
    const liveEngines: Array<{ label: string; tradeType: string; decisions: typeof demaDecisions }> = [
      { label: "DEMA", tradeType: "dema-directional", decisions: demaDecisions },
      { label: "HMA", tradeType: "hma-directional", decisions: hmaDecisions },
      { label: "Schaff", tradeType: "schaff-directional", decisions: schaffDecisions },
    ];

    const executed = new Map<string, number>();
    for (const { label, tradeType, decisions } of liveEngines) {
      let count = 0;
      const openPairs = openPairsByEngine.get(tradeType)!;
      for (const decision of decisions) {
        if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
        if (openPairs.has(decision.pair)) continue;
        if (isInStopLossCooldown(decision.pair, decision.direction)) continue;
        const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, tradeType as TradeType, undefined, decision.entryPrice);
        if (position) {
          count++;
          openPairs.add(decision.pair);
          console.log(`[QuantScheduler] ${label}: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
        }
      }
      executed.set(tradeType, count);
    }

    // Paper engines: independent, no ordering
    const paperEngines: Array<{ label: string; tradeType: string; decisions: typeof psarDecisions }> = [
      { label: "PSAR", tradeType: "psar-directional", decisions: psarDecisions },
      { label: "ZLEMA", tradeType: "zlema-directional", decisions: zlemaDecisions },
      { label: "Vortex", tradeType: "vortex-directional", decisions: vortexDecisions },
      { label: "CCI", tradeType: "cci-directional", decisions: cciDecisions },
    ];

    for (const { label, tradeType, decisions } of paperEngines) {
      let count = 0;
      const openPairs = openPairsByEngine.get(tradeType)!;
      for (const decision of decisions) {
        if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
        if (openPairs.has(decision.pair)) continue;
        if (isInStopLossCooldown(decision.pair, decision.direction)) continue;
        const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, tradeType as TradeType, undefined, decision.entryPrice);
        if (position) {
          count++;
          openPairs.add(decision.pair);
          console.log(`[QuantScheduler] ${label}: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
        }
      }
      executed.set(tradeType, count);
    }

    const e = (tt: string, d: { length: number }) => `${executed.get(tt) ?? 0}/${d.length}`;
    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, DEMA ${e("dema-directional", demaDecisions)}, HMA ${e("hma-directional", hmaDecisions)}, Schaff ${e("schaff-directional", schaffDecisions)}, PSAR ${e("psar-directional", psarDecisions)}, ZLEMA ${e("zlema-directional", zlemaDecisions)}, Vortex ${e("vortex-directional", vortexDecisions)}, CCI ${e("cci-directional", cciDecisions)}`,
    );
  } finally {
    cycleRunning = false;
  }
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) {
    return;
  }

  console.log("[QuantScheduler] Started (15m interval, 10x leverage)");

  initialRunTimeout = setTimeout(() => {
    void runDirectionalCycle();
  }, 15_000);

  schedulerInterval = setInterval(() => {
    void runDirectionalCycle();
  }, QUANT_SCHEDULER_INTERVAL_MS);
}

export function stopQuantScheduler(): void {
  if (schedulerInterval !== null) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  if (initialRunTimeout !== null) {
    clearTimeout(initialRunTimeout);
    initialRunTimeout = null;
  }

  console.log("[QuantScheduler] Stopped");
}
