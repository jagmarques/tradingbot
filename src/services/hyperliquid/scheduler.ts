import { analyzeWithAI } from "./ai-analyzer.js";
import { fetchDailyCandles, computeDailySma } from "./daily-indicators.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runPsarDecisionEngine } from "./psar-engine.js";
import { runZlemaDecisionEngine } from "./zlema-engine.js";
import { runElderImpulseDecisionEngine } from "./elder-impulse-engine.js";
import { runVortexDecisionEngine } from "./vortex-engine.js";
import { runSchaffDecisionEngine } from "./schaff-engine.js";
import { runDEMADecisionEngine } from "./dema-engine.js";
import { runHMADecisionEngine } from "./hma-engine.js";
import { runCCIDecisionEngine } from "./cci-engine.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS } from "../../config/constants.js";
import type { QuantAIDecision } from "./types.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

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

    const aiDecisions: QuantAIDecision[] = [];
    for (const analysis of analyses) {
      const dailyCandles = await fetchDailyCandles(analysis.pair, 150);
      const closes = dailyCandles.map((c) => c.close);
      const sma50 = computeDailySma(closes, 50, closes.length - 1);
      const markPrice = analysis.markPrice;
      let dailyTrend: { direction: "bullish" | "bearish" | "neutral"; price: number; sma50: number } | null = null;
      if (sma50 !== null) {
        let direction: "bullish" | "bearish" | "neutral";
        if (markPrice > sma50 * 1.01) {
          direction = "bullish";
        } else if (markPrice < sma50 * 0.99) {
          direction = "bearish";
        } else {
          direction = "neutral";
        }
        dailyTrend = { direction, price: markPrice, sma50 };
        console.log(`[QuantScheduler] AI: ${analysis.pair} daily trend: ${direction} (price=${markPrice.toFixed(2)}, sma50=${sma50.toFixed(2)})`);
      }
      const decision = await analyzeWithAI(analysis, dailyTrend);
      if (!decision || decision.direction === "flat") continue;
      const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss, false, "ai-directional");
      if (sizeUsd <= 0) continue;
      aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
    }

    const psarDecisions = await runPsarDecisionEngine(analyses);
    const zlemaDecisions = await runZlemaDecisionEngine(analyses);
    const elderDecisions = await runElderImpulseDecisionEngine(analyses);
    const vortexDecisions = await runVortexDecisionEngine(analyses);
    const schaffDecisions = await runSchaffDecisionEngine(analyses);
    const demaDecisions = await runDEMADecisionEngine(analyses);
    const hmaDecisions = await runHMADecisionEngine(analyses);
    const cciDecisions = await runCCIDecisionEngine(analyses);

    const openPositions = getOpenQuantPositions();

    const aiOpenPairs = new Set(
      openPositions
        .filter(p => p.tradeType === "directional" || p.tradeType === "ai-directional" || !p.tradeType)
        .map(p => p.pair),
    );
    const psarOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "psar-directional").map(p => p.pair),
    );
    const zlemaOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "zlema-directional").map(p => p.pair),
    );
    const elderOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "elder-impulse-directional").map(p => p.pair),
    );
    const vortexOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "vortex-directional").map(p => p.pair),
    );
    const schaffOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "schaff-directional").map(p => p.pair),
    );
    const demaOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "dema-directional").map(p => p.pair),
    );
    const hmaOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "hma-directional").map(p => p.pair),
    );
    const cciOpenPairs = new Set(
      openPositions.filter(p => p.tradeType === "cci-directional").map(p => p.pair),
    );

    let aiExecuted = 0;
    for (const decision of aiDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      if (aiOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] AI: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }

      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] AI: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }

      const position = await openPosition(
        decision.pair,
        decision.direction,
        decision.suggestedSizeUsd,
        10,
        decision.stopLoss,
        decision.takeProfit,
        decision.regime,
        decision.confidence,
        decision.reasoning,
        "ai-directional",
        undefined,
        decision.entryPrice,
        null,
      );

      if (position) {
        aiExecuted++;
        aiOpenPairs.add(decision.pair);
        console.log(
          `[QuantScheduler] AI: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let psarExecuted = 0;
    for (const decision of psarDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      if (psarOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] PSAR: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }

      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] PSAR: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }

      const position = await openPosition(
        decision.pair,
        decision.direction,
        decision.suggestedSizeUsd,
        10,
        decision.stopLoss,
        decision.takeProfit,
        decision.regime,
        decision.confidence,
        decision.reasoning,
        "psar-directional",
        undefined,
        decision.entryPrice,
        null,
      );

      if (position) {
        psarExecuted++;
        psarOpenPairs.add(decision.pair);
        console.log(
          `[QuantScheduler] PSAR: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let zlemaExecuted = 0;
    for (const decision of zlemaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      if (zlemaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] ZLEMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }

      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] ZLEMA: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }

      const position = await openPosition(
        decision.pair,
        decision.direction,
        decision.suggestedSizeUsd,
        10,
        decision.stopLoss,
        decision.takeProfit,
        decision.regime,
        decision.confidence,
        decision.reasoning,
        "zlema-directional",
        undefined,
        decision.entryPrice,
        null,
      );

      if (position) {
        zlemaExecuted++;
        zlemaOpenPairs.add(decision.pair);
        console.log(
          `[QuantScheduler] ZLEMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let elderExecuted = 0;
    for (const decision of elderDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      if (elderOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Elder: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }

      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] Elder: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }

      const position = await openPosition(
        decision.pair,
        decision.direction,
        decision.suggestedSizeUsd,
        10,
        decision.stopLoss,
        decision.takeProfit,
        decision.regime,
        decision.confidence,
        decision.reasoning,
        "elder-impulse-directional",
        undefined,
        decision.entryPrice,
        null,
      );

      if (position) {
        elderExecuted++;
        elderOpenPairs.add(decision.pair);
        console.log(
          `[QuantScheduler] Elder: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let vortexExecuted = 0;
    for (const decision of vortexDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (vortexOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Vortex: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] Vortex: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "vortex-directional", undefined, decision.entryPrice, null);
      if (position) {
        vortexExecuted++;
        vortexOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] Vortex: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    let schaffExecuted = 0;
    for (const decision of schaffDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      if (schaffOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Schaff: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }

      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] Schaff: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }

      const position = await openPosition(
        decision.pair,
        decision.direction,
        decision.suggestedSizeUsd,
        10,
        decision.stopLoss,
        decision.takeProfit,
        decision.regime,
        decision.confidence,
        decision.reasoning,
        "schaff-directional",
        undefined,
        decision.entryPrice,
        null,
      );

      if (position) {
        schaffExecuted++;
        schaffOpenPairs.add(decision.pair);
        console.log(
          `[QuantScheduler] Schaff: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }


    let demaExecuted = 0;
    for (const decision of demaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (demaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] DEMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] DEMA: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "dema-directional", undefined, decision.entryPrice, null);
      if (position) {
        demaExecuted++;
        demaOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] DEMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    let hmaExecuted = 0;
    for (const decision of hmaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (hmaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] HMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] HMA: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "hma-directional", undefined, decision.entryPrice, null);
      if (position) {
        hmaExecuted++;
        hmaOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] HMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    let cciExecuted = 0;
    for (const decision of cciDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      if (cciOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] CCI: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      if (isInStopLossCooldown(decision.pair, decision.direction)) {
        console.log(`[QuantScheduler] CCI: Skip ${decision.pair} ${decision.direction}: stop-loss cooldown`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "cci-directional", undefined, decision.entryPrice, null);
      if (position) {
        cciExecuted++;
        cciOpenPairs.add(decision.pair);
        console.log(`[QuantScheduler] CCI: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, PSAR ${psarExecuted}/${psarDecisions.length}, ZLEMA ${zlemaExecuted}/${zlemaDecisions.length}, Elder ${elderExecuted}/${elderDecisions.length}, Vortex ${vortexExecuted}/${vortexDecisions.length}, Schaff ${schaffExecuted}/${schaffDecisions.length}, DEMA ${demaExecuted}/${demaDecisions.length}, HMA ${hmaExecuted}/${hmaDecisions.length}, CCI ${cciExecuted}/${cciDecisions.length}`,
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
