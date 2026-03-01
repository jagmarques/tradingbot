import { analyzeWithAI } from "./ai-analyzer.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runBbSqueezeDecisionEngine } from "./bb-squeeze-engine.js";
import { runDemaCrossDecisionEngine } from "./dema-cross-engine.js";
import { runHmaDecisionEngine } from "./hma-engine.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS } from "../../config/constants.js";
import type { QuantAIDecision } from "./types.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

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
      const decision = await analyzeWithAI(analysis);
      if (!decision || decision.direction === "flat") continue;
      const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss);
      if (sizeUsd <= 0) continue;
      aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
    }

    const bbSqueezeDecisions = await runBbSqueezeDecisionEngine(analyses);
    const demaCrossDecisions = await runDemaCrossDecisionEngine(analyses);
    const hmaDecisions = await runHmaDecisionEngine(analyses);

    const aiOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "directional" || p.tradeType === "ai-directional" || !p.tradeType)
        .map(p => p.pair),
    );
    const bbSqueezeOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "bb-squeeze-directional")
        .map(p => p.pair),
    );
    const demaCrossOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "dema-cross-directional")
        .map(p => p.pair),
    );
    const hmaOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "hma-directional")
        .map(p => p.pair),
    );

    const globalPairDirections = new Map<string, "long" | "short">();
    for (const p of getOpenQuantPositions()) {
      globalPairDirections.set(p.pair, p.direction);
    }

    let aiExecuted = 0;
    for (const decision of aiDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] AI: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (aiOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] AI: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
      );

      if (position) {
        aiExecuted++;
        aiOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] AI: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let bbSqueezeExecuted = 0;
    for (const decision of bbSqueezeDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] BBSqueeze: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (bbSqueezeOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] BBSqueeze: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "bb-squeeze-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        bbSqueezeExecuted++;
        bbSqueezeOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] BBSqueeze: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let demaCrossExecuted = 0;
    for (const decision of demaCrossDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] DemaCross: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (demaCrossOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] DemaCross: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "dema-cross-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        demaCrossExecuted++;
        demaCrossOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] DemaCross: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let hmaExecuted = 0;
    for (const decision of hmaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] HMA: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (hmaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] HMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "hma-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        hmaExecuted++;
        hmaOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] HMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, BBSqueeze ${bbSqueezeExecuted}/${bbSqueezeDecisions.length}, DemaCross ${demaCrossExecuted}/${demaCrossDecisions.length}, HMA ${hmaExecuted}/${hmaDecisions.length}`,
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
