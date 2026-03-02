import { analyzeWithAI } from "./ai-analyzer.js";
import { runMarketDataPipeline } from "./pipeline.js";
import { calculateQuantPositionSize } from "./kelly.js";
import { runPsarDecisionEngine } from "./psar-engine.js";
import { runZlemaDecisionEngine } from "./zlema-engine.js";
import { runMacdCrossDecisionEngine } from "./macd-cross-engine.js";
import { runTrixDecisionEngine } from "./trix-engine.js";
import { runElderImpulseDecisionEngine } from "./elder-impulse-engine.js";
import { runVortexDecisionEngine } from "./vortex-engine.js";
import { runSchaffDecisionEngine } from "./schaff-engine.js";
import { runTEMADecisionEngine } from "./tema-engine.js";
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
      const sizeUsd = calculateQuantPositionSize(decision.confidence, decision.entryPrice, decision.stopLoss, false, "ai-directional");
      if (sizeUsd <= 0) continue;
      aiDecisions.push({ ...decision, suggestedSizeUsd: sizeUsd });
    }

    const psarDecisions = await runPsarDecisionEngine(analyses);
    const zlemaDecisions = await runZlemaDecisionEngine(analyses);
    const macdCrossDecisions = await runMacdCrossDecisionEngine(analyses);
    const trixDecisions = await runTrixDecisionEngine(analyses);
    const elderDecisions = await runElderImpulseDecisionEngine(analyses);
    const vortexDecisions = await runVortexDecisionEngine(analyses);
    const schaffDecisions = await runSchaffDecisionEngine(analyses);
    const temaDecisions = await runTEMADecisionEngine(analyses);
    const demaDecisions = await runDEMADecisionEngine(analyses);
    const hmaDecisions = await runHMADecisionEngine(analyses);
    const cciDecisions = await runCCIDecisionEngine(analyses);

    const aiOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "directional" || p.tradeType === "ai-directional" || !p.tradeType)
        .map(p => p.pair),
    );
    const psarOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "psar-directional")
        .map(p => p.pair),
    );
    const zlemaOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "zlema-directional")
        .map(p => p.pair),
    );
    const macdCrossOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "macd-cross-directional")
        .map(p => p.pair),
    );
    const trixOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "trix-directional")
        .map(p => p.pair),
    );
    const elderOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "elder-impulse-directional")
        .map(p => p.pair),
    );
    const vortexOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "vortex-directional")
        .map(p => p.pair),
    );
    const schaffOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "schaff-directional")
        .map(p => p.pair),
    );
    const temaOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "tema-directional")
        .map(p => p.pair),
    );
    const demaOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "dema-directional")
        .map(p => p.pair),
    );
    const hmaOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "hma-directional")
        .map(p => p.pair),
    );
    const cciOpenPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "cci-directional")
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

    let psarExecuted = 0;
    for (const decision of psarDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] PSAR: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (psarOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] PSAR: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
      );

      if (position) {
        psarExecuted++;
        psarOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] PSAR: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let zlemaExecuted = 0;
    for (const decision of zlemaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] ZLEMA: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (zlemaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] ZLEMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
      );

      if (position) {
        zlemaExecuted++;
        zlemaOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] ZLEMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let macdCrossExecuted = 0;
    for (const decision of macdCrossDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] MACDCross: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (macdCrossOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] MACDCross: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "macd-cross-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        macdCrossExecuted++;
        macdCrossOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] MACDCross: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let trixExecuted = 0;
    for (const decision of trixDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] TRIX: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (trixOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] TRIX: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "trix-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        trixExecuted++;
        trixOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] TRIX: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let elderExecuted = 0;
    for (const decision of elderDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] Elder: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (elderOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Elder: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
      );

      if (position) {
        elderExecuted++;
        elderOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] Elder: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let vortexExecuted = 0;
    for (const decision of vortexDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] Vortex: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (vortexOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Vortex: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
        "vortex-directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        vortexExecuted++;
        vortexOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] Vortex: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    let schaffExecuted = 0;
    for (const decision of schaffDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;

      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] Schaff: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }

      if (schaffOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Schaff: Skipping ${decision.pair} ${decision.direction}: pair already open`);
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
      );

      if (position) {
        schaffExecuted++;
        schaffOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(
          `[QuantScheduler] Schaff: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }


    let temaExecuted = 0;
    for (const decision of temaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] TEMA: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }
      if (temaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] TEMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "tema-directional", undefined, decision.entryPrice);
      if (position) {
        temaExecuted++;
        temaOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(`[QuantScheduler] TEMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    let demaExecuted = 0;
    for (const decision of demaDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] DEMA: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }
      if (demaOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] DEMA: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "dema-directional", undefined, decision.entryPrice);
      if (position) {
        demaExecuted++;
        demaOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(`[QuantScheduler] DEMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
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
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "hma-directional", undefined, decision.entryPrice);
      if (position) {
        hmaExecuted++;
        hmaOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(`[QuantScheduler] HMA: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    let cciExecuted = 0;
    for (const decision of cciDecisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") continue;
      const existingDir = globalPairDirections.get(decision.pair);
      if (existingDir && existingDir !== decision.direction) {
        console.log(`[QuantScheduler] CCI: Skipping ${decision.pair} ${decision.direction}: cross-engine conflict (${existingDir} open)`);
        continue;
      }
      if (cciOpenPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] CCI: Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }
      const position = await openPosition(decision.pair, decision.direction, decision.suggestedSizeUsd, 10, decision.stopLoss, decision.takeProfit, decision.regime, decision.confidence, decision.reasoning, "cci-directional", undefined, decision.entryPrice);
      if (position) {
        cciExecuted++;
        cciOpenPairs.add(decision.pair);
        globalPairDirections.set(decision.pair, decision.direction);
        console.log(`[QuantScheduler] CCI: Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`);
      }
    }

    console.log(
      `[QuantScheduler] Cycle complete: AI ${aiExecuted}/${aiDecisions.length}, PSAR ${psarExecuted}/${psarDecisions.length}, ZLEMA ${zlemaExecuted}/${zlemaDecisions.length}, MACDCross ${macdCrossExecuted}/${macdCrossDecisions.length}, TRIX ${trixExecuted}/${trixDecisions.length}, Elder ${elderExecuted}/${elderDecisions.length}, Vortex ${vortexExecuted}/${vortexDecisions.length}, Schaff ${schaffExecuted}/${schaffDecisions.length}, TEMA ${temaExecuted}/${temaDecisions.length}, DEMA ${demaExecuted}/${demaDecisions.length}, HMA ${hmaExecuted}/${hmaDecisions.length}, CCI ${cciExecuted}/${cciDecisions.length}`,
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
