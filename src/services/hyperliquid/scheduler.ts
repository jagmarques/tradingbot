import { analyzeWithAI } from "./ai-analyzer.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runRuleDecisionEngine } from "./rule-engine.js";
import { runMicroDecisionEngine } from "./micro-engine.js";
import { runVwapDecisionEngine } from "./vwap-engine.js";
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

    const ruleDecisions = runRuleDecisionEngine(analyses);
    const microDecisions = runMicroDecisionEngine(analyses);
    const vwapDecisions = runVwapDecisionEngine(analyses);


    const aiOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "directional" || p.tradeType === "ai-directional" || !p.tradeType)
        .map(p => p.pair),
    );
    const ruleOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "rule-directional")
        .map(p => p.pair),
    );
    const microOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "micro-directional")
        .map(p => p.pair),
    );
    const vwapOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "vwap-directional")
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

    let ruleExecuted = 0;
    for (const decision of ruleDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] Rule: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (ruleOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Rule: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "rule-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        ruleExecuted++;
        ruleOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] Rule: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let microExecuted = 0;
    for (const decision of microDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] Micro: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (microOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Micro: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "micro-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        microExecuted++;
        microOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] Micro: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let vwapExecuted = 0;
    for (const decision of vwapDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] VWAP: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (vwapOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] VWAP: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "vwap-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        vwapExecuted++;
        vwapOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] VWAP: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, Rule ${ruleExecuted}/${ruleDecisions.length}, Micro ${microExecuted}/${microDecisions.length}, VWAP ${vwapExecuted}/${vwapDecisions.length}`,
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
