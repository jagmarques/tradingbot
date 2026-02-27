import { analyzeWithAI } from "./ai-analyzer.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runMicroDecisionEngine } from "./micro-engine.js";
import { runVwapDecisionEngine } from "./vwap-engine.js";
import { runBreakoutDecisionEngine } from "./breakout-engine.js";
import { runMtfDecisionEngine } from "./mtf-engine.js";
import { runMacdTrendDecisionEngine } from "./macd-engine.js";
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

    const microDecisions = runMicroDecisionEngine(analyses);
    const vwapDecisions = runVwapDecisionEngine(analyses);
    const breakoutDecisions = runBreakoutDecisionEngine(analyses);
    const mtfDecisions = await runMtfDecisionEngine(analyses);
    const macdDecisions = await runMacdTrendDecisionEngine(analyses);

    const aiOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "directional" || p.tradeType === "ai-directional" || !p.tradeType)
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
    const breakoutOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "breakout-directional")
        .map(p => p.pair),
    );
    const mtfOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "mtf-directional")
        .map(p => p.pair),
    );
    const macdOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "macd-directional")
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

    let breakoutExecuted = 0;
    for (const decision of breakoutDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] Breakout: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (breakoutOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Breakout: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "breakout-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        breakoutExecuted++;
        breakoutOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] Breakout: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let mtfExecuted = 0;
    for (const decision of mtfDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] MTF: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (mtfOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] MTF: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "mtf-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        mtfExecuted++;
        mtfOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] MTF: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let macdExecuted = 0;
    for (const decision of macdDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] MACD: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (macdOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] MACD: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "macd-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        macdExecuted++;
        macdOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] MACD: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, Micro ${microExecuted}/${microDecisions.length}, VWAP ${vwapExecuted}/${vwapDecisions.length}, Breakout ${breakoutExecuted}/${breakoutDecisions.length}, MTF ${mtfExecuted}/${mtfDecisions.length}, MACD ${macdExecuted}/${macdDecisions.length}`,
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
